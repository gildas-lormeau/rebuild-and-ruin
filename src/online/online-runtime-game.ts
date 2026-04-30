import {
  type InitMessage,
  MESSAGE,
  type ServerMessage,
} from "../protocol/protocol.ts";
import {
  createBrowserRuntimeBindings,
  createGameRuntime,
} from "../runtime/runtime-composition.ts";
import { setMode } from "../runtime/runtime-state.ts";
import {
  isHostInContext,
  tickPersistentAnnouncement,
} from "../runtime/runtime-tick-context.ts";
import type { GameRuntime, NetworkApi } from "../runtime/runtime-types.ts";
import { DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS } from "../shared/core/action-schedule.ts";
import {
  DIFFICULTY_NORMAL,
  DIFFICULTY_PARAMS,
  SELECT_TIMER,
} from "../shared/core/game-constants.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { isHuman } from "../shared/core/system-interfaces.ts";
import type { UpgradeId } from "../shared/core/upgrade-defs.ts";
import type { ResolvedChoice } from "../shared/ui/interaction-types.ts";
import { MAX_PLAYERS, PLAYER_NAMES } from "../shared/ui/player-config.ts";
import { canvas, worldCanvas } from "./online-dom.ts";
import {
  broadcastLocalCrosshair as broadcastLocalCrosshairImpl,
  extendWithRemoteCrosshairs,
} from "./online-host-crosshairs.ts";
import { GAME_EXIT_EVENT } from "./online-router.ts";
import { handleServerMessage, initDeps } from "./online-runtime-deps.ts";
import { initPromote } from "./online-runtime-promote.ts";
import { createOnlineRuntimeSessionHelpers } from "./online-runtime-session.ts";
import { initWs } from "./online-runtime-ws.ts";
import { createOnlineSendActions } from "./online-send-actions.ts";
import {
  createBattleStartMessage,
  createBuildStartMessage,
  createCannonStartMessage,
  createGameOverPayload,
} from "./online-serialize.ts";
import { defaultClient, RESET_SCOPE_NEW_GAME } from "./online-stores.ts";

// ── Client shorthand ───────────────────────────────────────────────
// Destructured from defaultClient singleton for brevity. All five names
// reference the same client instance — used throughout this module.
const { ctx, send, devLog, devLogThrottled, maybeSendAimUpdate } =
  defaultClient;
// ── DOM singletons (from centralized boundary) ─────────────────────
const { renderer, timing, keyboardEventSource } = createBrowserRuntimeBindings(
  canvas,
  worldCanvas,
);
// ── Incoming message bus ────────────────────────────────────────────
// Subscribers register via `network.onMessage(handler)`. The WebSocket
// handler delivers via `deliverIncomingMessage`. The seam is what lets
// loopback tests substitute their own delivery without touching the
// dispatcher (handleServerMessage).
const incomingMessageSubscribers = new Set<
  (msg: ServerMessage) => void | Promise<void>
>();
const network: NetworkApi = {
  send,
  onMessage: (handler) => {
    incomingMessageSubscribers.add(handler);
    return () => {
      incomingMessageSubscribers.delete(handler);
    };
  },
  // eslint-disable-next-line no-restricted-syntax -- bridge to runtime layer
  amHost: () => ctx.session.isHost,
  myPlayerId: () => ctx.session.myPlayerId,
  remotePlayerSlots: () => ctx.session.remotePlayerSlots,
};
const sessionHelpers = createOnlineRuntimeSessionHelpers({
  getRuntime: () => runtime,
  session: ctx.session,
  timing,
  resetNetworkingForNewGame: () => {
    defaultClient.resetNetworking(RESET_SCOPE_NEW_GAME);
  },
  destroyClient: () => {
    defaultClient.destroy();
  },
  log: devLog,
  container: renderer.container,
});
// ── Send-on-success action wrappers ────────────────────────────────
// `send` and `getState` are bound once here so individual call sites
// (input dispatch, AI tick) don't have to plumb them through. The
// `runtime` reference is captured by closure — `runtime` itself is
// declared a few lines below; only the closures invoked after
// initialization actually deref it.
const sendActions = createOnlineSendActions({
  send,
  getState: () => runtime.runtimeState.state,
  schedule: (action) => runtime.runtimeState.actionSchedule.schedule(action),
  safetyTicks: DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS,
});
// ── Runtime creation ────────────────────────────────────────────────
const runtime: GameRuntime = createGameRuntime({
  renderer,
  timing,
  keyboardEventSource,
  network,
  log: devLog,
  logThrottled: devLogThrottled,
  // -1 grace: server fires setTimeout(waitSec * 1000) exactly at waitSec.
  // Subtracting 1 ensures the client shows 0 one second early, so the UI
  // never displays "1" while the server is already starting the game.
  getLobbyRemaining: () =>
    Math.max(
      0,
      ctx.session.roomWaitTimerSec -
        1 -
        (performance.now() - ctx.session.lobbyStartTime) / 1000,
    ),
  getUrlRoundsOverride: () => {
    const param = new URL(location.href).searchParams.get("rounds");
    return param ? Number(param) : 0;
  },
  showLobby: sessionHelpers.showLobby,
  onLobbySlotJoined: (pid: ValidPlayerSlot) => {
    send({ type: MESSAGE.SELECT_SLOT, playerId: pid });
  },
  onCloseOptions: () => {
    if (runtime.runtimeState.optionsUI.returnMode === null) {
      ctx.session.lobbyStartTime = performance.now();
    }
  },
  onTickLobbyExpired: async () => {
    if (!isHostInContext(ctx.session)) return;
    const diffParams =
      DIFFICULTY_PARAMS[runtime.runtimeState.settings.difficulty] ??
      DIFFICULTY_PARAMS[DIFFICULTY_NORMAL]!;
    const initMsg: InitMessage = {
      type: MESSAGE.INIT,
      seed: ctx.session.roomSeed,
      playerCount: MAX_PLAYERS,
      settings: {
        maxRounds: ctx.session.roomMaxRounds,
        cannonMaxHp: ctx.session.roomCannonMaxHp,
        buildTimer: diffParams.buildTimer,
        cannonPlaceTimer: diffParams.cannonPlaceTimer,
        firstRoundCannons: diffParams.firstRoundCannons,
        gameMode: ctx.session.roomGameMode,
      },
    };
    send(initMsg);
    await sessionHelpers.initFromServer(initMsg);
    send({ type: MESSAGE.SELECT_START, timer: SELECT_TIMER });
  },

  onlinePhaseTicks: {
    // ── Host: phase-transition checkpoint broadcasts ──────────────────
    // Direct imports — these are pure (state) → message factories with
    // no captured state, so they need no closure dance.
    broadcastCannonStart: () => send(createCannonStartMessage()),
    broadcastBattleStart: () => send(createBattleStartMessage()),
    broadcastBuildStart: () => send(createBuildStartMessage()),
    broadcastBuildEnd: () => send({ type: MESSAGE.BUILD_END }),

    // ── Per-controller crosshair fan-out ──────────────────────────────
    // Self-gates by ownership: only the local human's crosshair hits the
    // wire. AI crosshairs are deterministic from strategy.rng + state, so
    // every peer derives them locally — broadcasting would be redundant.
    broadcastLocalCrosshair: (ctrl, crosshair) => {
      if (!isHuman(ctrl) || ctrl.playerId !== ctx.session.myPlayerId) return;
      broadcastLocalCrosshairImpl(ctrl, crosshair, {
        lastSentAimTarget: ctx.dedup.aimTarget,
        send,
      });
    },

    // ── Per-frame phantom dedup ───────────────────────────────────────
    // Self-gates by ownership before consulting the dedup channel.
    shouldSendCannonPhantom: (playerId, key) => {
      if (playerId !== ctx.session.myPlayerId) return false;
      return ctx.dedup.cannonPhantom.shouldSend(playerId, key);
    },
    shouldSendPiecePhantom: (playerId, key) => {
      if (playerId !== ctx.session.myPlayerId) return false;
      return ctx.dedup.piecePhantom.shouldSend(playerId, key);
    },

    // ── Cross-machine merging ─────────────────────────────────────────
    extendCrosshairs: (crosshairs, dt) =>
      extendWithRemoteCrosshairs(crosshairs, runtime.runtimeState.state, dt, {
        remoteCrosshairs: ctx.presence.remoteCrosshairs,
        smoothedCrosshairPos: ctx.presence.smoothedCrosshairPos,
        remotePlayerSlots: ctx.session.remotePlayerSlots,
        logThrottled: devLogThrottled,
      }),
    tickMigrationAnnouncement: (dt) =>
      tickPersistentAnnouncement(
        ctx.presence.migrationBanner,
        runtime.runtimeState.frame,
        dt,
      ),
  },
  onlineActions: {
    maybeSendAimUpdate,
    tryPlaceCannon: sendActions.tryPlaceCannon,
    tryPlacePiece: sendActions.tryPlacePiece,
    fire: sendActions.fire,
  },
  onlineDialogDrains: {
    drainLifeLost: (apply) => {
      const queue = ctx.session.earlyLifeLostChoices;
      if (queue.size === 0) return;
      for (const [pid, choice] of queue) {
        const applied = apply(pid as ValidPlayerSlot, choice as ResolvedChoice);
        devLog(
          `drain life_lost queued P${pid}=${choice} -> ${applied ? "applied" : "stale"}`,
        );
      }
      queue.clear();
    },
    drainUpgradePick: (apply) => {
      const queue = ctx.session.earlyUpgradePickChoices;
      if (queue.size === 0) return;
      for (const [pid, choice] of queue) {
        const applied = apply(pid as ValidPlayerSlot, choice as UpgradeId);
        devLog(
          `drain upgrade_pick queued P${pid}=${choice} -> ${applied ? "applied" : "stale"}`,
        );
      }
      queue.clear();
    },
  },
  onEndGame: (winner, gameState) => {
    const payloads = createGameOverPayload(winner, gameState, PLAYER_NAMES);
    devLog(
      `endGame winner=${payloads.winnerName} round=${gameState.round} maxRounds=${gameState.maxRounds}`,
    );
    if (isHostInContext(ctx.session)) send(payloads.serverPayload);
  },
});

/** Pre-warm both audio sub-systems (music WASM + SFX AudioContext) inside a
 *  user-gesture handler. Mirrors main.ts's activateMusic() for the online
 *  flow — called from entry.ts on btn-online / btn-create-confirm /
 *  btn-join-confirm clicks so online games start with a running context.
 *  No-op if the player hasn't dropped their Rampart files into IDB. */
export async function activateAudio(): Promise<void> {
  await Promise.all([runtime.music.activate(), runtime.sfx.activate()]);
}

// ── Initialize dependent modules and register handlers ─────────────
/** Wire runtime into ws/promote/deps modules and register input + exit
 *  handlers. Called once from online-client.ts after module evaluation.
 *
 *  ORDERING INVARIANT — the three init calls must execute in this order:
 *    1. initWs   — sets up WebSocket lifecycle (reconnect, mode reset)
 *    2. initPromote — sets up host promotion (requires runtime)
 *    3. initDeps — sets up server message dispatch (requires all of the above)
 *  Calling out of order will cause "called before init()" runtime errors. */
export function initOnlineRuntime(): void {
  // Step 1: WebSocket lifecycle
  initWs(
    {
      getMode: () => runtime.runtimeState.mode,
      setMode: (mode) => {
        setMode(runtime.runtimeState, mode);
      },
      setAnnouncement: (text) => {
        runtime.runtimeState.frame.announcement = text;
      },
      render: () => runtime.render(),
      // WebSocket fans out incoming messages through the same bus that
      // backs network.onMessage. The dispatcher (handleServerMessage) is
      // registered as a subscriber in step 4 below.
      deliverIncoming: deliverIncomingMessage,
    },
    defaultClient,
  );

  // Step 2: Host promotion
  initPromote(runtime, defaultClient);

  // Step 3: Server message dispatch
  initDeps({
    runtime,
    initFromServer: sessionHelpers.initFromServer,
    restoreFullState: sessionHelpers.restoreFullState,
    showWaitingRoom: sessionHelpers.showWaitingRoom,
    client: defaultClient,
  });

  // Step 4: Subscribe the dispatcher to NetworkApi.onMessage. The WS layer
  // calls deliverIncomingMessage on every received message; this is what
  // routes those calls into handleServerMessage. A loopback test would
  // register the same dispatcher against a different NetworkApi instance.
  network.onMessage(handleServerMessage);

  document.addEventListener(GAME_EXIT_EVENT, () => {
    runtime.shutdown();
    defaultClient.destroy();
    runtime.runtimeState.lobby.roomSeedDisplay = null;
  });
}

async function deliverIncomingMessage(msg: ServerMessage): Promise<void> {
  for (const handler of incomingMessageSubscribers) {
    await handler(msg);
  }
}
