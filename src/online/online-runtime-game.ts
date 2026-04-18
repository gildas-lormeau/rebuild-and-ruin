import {
  type GameMessage,
  type InitMessage,
  MESSAGE,
  type ServerMessage,
} from "../protocol/protocol.ts";
import {
  createBrowserRuntimeBindings,
  createGameRuntime,
} from "../runtime/runtime-composition.ts";
import { setMode } from "../runtime/runtime-state.ts";
import { isHostInContext } from "../runtime/runtime-tick-context.ts";
import type { GameRuntime, NetworkApi } from "../runtime/runtime-types.ts";
import {
  BATTLE_COUNTDOWN,
  DIFFICULTY_NORMAL,
  DIFFICULTY_PARAMS,
  SELECT_TIMER,
} from "../shared/core/game-constants.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { MAX_PLAYERS, PLAYER_NAMES } from "../shared/ui/player-config.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import { canvas } from "./online-dom.ts";
import {
  broadcastLocalCrosshair as broadcastLocalCrosshairImpl,
  extendWithRemoteCrosshairs,
} from "./online-host-crosshairs.ts";
import type { WatcherDeps } from "./online-phase-transitions.ts";
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
  serializePlayersCheckpoint,
} from "./online-serialize.ts";
import { defaultClient, RESET_SCOPE_NEW_GAME } from "./online-stores.ts";
import {
  tickMigrationAnnouncement,
  tickWatcher,
  type WatcherTickContext,
} from "./online-watcher-tick.ts";

// ── Client shorthand ───────────────────────────────────────────────
// Destructured from defaultClient singleton for brevity. All five names
// reference the same client instance — used throughout this module.
const { ctx, send, devLog, devLogThrottled, maybeSendAimUpdate } =
  defaultClient;
// ── DOM singletons (from centralized boundary) ─────────────────────
const { renderer, timing, keyboardEventSource } =
  createBrowserRuntimeBindings(canvas);
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
  watcher: ctx.watcher,
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
const watcherDeps: WatcherDeps = {
  getRuntime: () => runtime,
  session: ctx.session,
  watcher: ctx.watcher,
};
// ── Send-on-success action wrappers ────────────────────────────────
// `send` and `getState` are bound once here so individual call sites
// (input dispatch, AI tick) don't have to plumb them through.
const sendActions = createOnlineSendActions({
  send,
  getState: () => runtime.runtimeState.state,
});
// ── Watcher tick context ────────────────────────────────────────────
const watcherTickCtx: WatcherTickContext = {
  getState: () => runtime.runtimeState.state,
  getFrame: () => runtime.runtimeState.frame,
  getAccum: () => runtime.runtimeState.accum,
  getBattleAnim: () => runtime.runtimeState.battleAnim,
  getControllers: () => runtime.runtimeState.controllers,
  session: ctx.session,
  dedup: ctx.dedup,
  send: (msg) => send(msg as GameMessage),
  logThrottled: devLogThrottled,
  maybeSendAimUpdate,
  render: () => runtime.render(),
  now: () => performance.now(),
};
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
    broadcastCannonStart: (state) => send(createCannonStartMessage(state)),
    broadcastBattleStart: (state, flights, modifierDiff) =>
      send(createBattleStartMessage(state, flights, modifierDiff)),
    broadcastBuildStart: (state) => send(createBuildStartMessage(state)),
    broadcastBuildEnd: (state, summary) =>
      send({
        type: MESSAGE.BUILD_END,
        needsReselect: [...summary.needsReselect],
        eliminated: [...summary.eliminated],
        scores: [...summary.scores],
        players: serializePlayersCheckpoint(state),
      }),

    // ── Host: per-controller crosshair fan-out ────────────────────────
    // No internal isHost gate — the runtime calls this only from the host
    // path inside `syncCrosshairs`.
    broadcastLocalCrosshair: (ctrl, crosshair) =>
      broadcastLocalCrosshairImpl(ctrl, crosshair, {
        lastSentAimTarget: ctx.dedup.aimTarget,
        send,
      }),

    // ── Host: per-frame phantom dedup ─────────────────────────────────
    remoteCannonPhantoms: () => ctx.watcher.remoteCannonPhantoms,
    remotePiecePhantoms: () => ctx.watcher.remotePiecePhantoms,
    shouldSendCannonPhantom: (playerId, key) =>
      ctx.dedup.cannonPhantom.shouldSend(playerId, key),
    shouldSendPiecePhantom: (playerId, key) =>
      ctx.dedup.piecePhantom.shouldSend(playerId, key),

    // ── Watcher: per-frame state apply ────────────────────────────────
    tickWatcher: (dt) => tickWatcher(ctx.watcher, dt, watcherTickCtx),
    watcherBeginBattle: (nowMs) => {
      ctx.watcher.timing.countdownStartTime = nowMs;
      ctx.watcher.timing.countdownDuration = BATTLE_COUNTDOWN;
    },

    // ── Both roles: cross-machine merging ─────────────────────────────
    extendCrosshairs: (crosshairs, dt) =>
      extendWithRemoteCrosshairs(crosshairs, runtime.runtimeState.state, dt, {
        remoteCrosshairs: ctx.watcher.remoteCrosshairs,
        watcherCrosshairPos: ctx.watcher.watcherCrosshairPos,
        remotePlayerSlots: ctx.session.remotePlayerSlots,
        logThrottled: devLogThrottled,
      }),
    tickMigrationAnnouncement: (dt) =>
      tickMigrationAnnouncement(ctx.watcher, runtime.runtimeState.frame, dt),
  },
  onlineActions: {
    maybeSendAimUpdate,
    tryPlaceCannonAndSend: sendActions.tryPlaceCannonAndSend,
    tryPlacePieceAndSend: sendActions.tryPlacePieceAndSend,
    fireAndSend: sendActions.fireAndSend,
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
export function activateAudio(): Promise<void> {
  return Promise.all([runtime.music.activate(), runtime.sfx.activate()]).then(
    () => {},
  );
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
    watcherDeps,
    client: defaultClient,
  });

  // Step 4: Subscribe the dispatcher to NetworkApi.onMessage. The WS layer
  // calls deliverIncomingMessage on every received message; this is what
  // routes those calls into handleServerMessage. A loopback test would
  // register the same dispatcher against a different NetworkApi instance.
  network.onMessage(handleServerMessage);

  document.addEventListener(GAME_EXIT_EVENT, () => {
    setMode(runtime.runtimeState, Mode.STOPPED);
    runtime.runtimeState.lobby.active = false;
    sessionHelpers.resetSession();
  });
}

async function deliverIncomingMessage(msg: ServerMessage): Promise<void> {
  for (const handler of incomingMessageSubscribers) {
    await handler(msg);
  }
}
