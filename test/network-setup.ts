/**
 * Online scenario factories — real `OnlinePhaseTicks` wiring for tests
 * that need host-side broadcasts or a receive-side watcher.
 *
 * Used by `createScenario({ online: "host" | "watcher" })` (which
 * delegates here) and by the top-level `createNetworkedPair` helper that
 * builds both together for two-runtime loopback tests.
 *
 * Purpose: validate the network layer end-to-end by running the same game
 * as a single local runtime vs as a host + watcher pair, and asserting
 * state convergence. See `test/network-vs-local.test.ts`.
 *
 * The watcher uses production infrastructure (no fake
 * hostMode-on-receiver hacks): `session.isHost = false`,
 * `remotePlayerSlots` covers every slot so zero local AI runs, lifecycle
 * messages drive phase transitions via `handleServerLifecycleMessage`,
 * incremental messages drive state via `handleServerIncrementalMessage`,
 * `tickWatcher` handles per-frame visual state (cannonball flight,
 * crosshair smoothing).
 *
 * The host side gets real broadcast emitters (CANNON_START / BATTLE_START
 * / BUILD_START / BUILD_END + per-action) via the existing
 * `networkObserver` seam — the runtime's `network.send` forwards to
 * `sentMessages`, which `createNetworkedPair` pipes into the watcher's
 * `deliverMessage` between ticks.
 */

// MUST be first — installs `document` global before online-runtime-deps.ts
// transitively evaluates online-dom.ts.

import "./online-dom-shim.ts";
import { type GameMessage, MESSAGE, type ServerMessage } from "../src/protocol/protocol.ts";
import {
  handleServerMessage,
  initDeps,
} from "../src/online/online-runtime-deps.ts";
import type { WatcherDeps } from "../src/online/online-phase-transitions.ts";
import {
  createBattleStartMessage,
  createBuildStartMessage,
  createCannonStartMessage,
  serializePlayersCheckpoint,
} from "../src/online/online-serialize.ts";
import {
  createDedupMaps,
  createSession,
  type DedupMaps,
  type OnlineSession,
} from "../src/online/online-session.ts";
import type { OnlineClient } from "../src/online/online-stores.ts";
import {
  createWatcherState,
  tickWatcher,
  type WatcherState,
  type WatcherTickContext,
} from "../src/online/online-watcher-tick.ts";
import { BATTLE_COUNTDOWN } from "../src/shared/core/game-constants.ts";
import type { ValidPlayerSlot } from "../src/shared/core/player-slot.ts";
import type { OnlinePhaseTicks } from "../src/runtime/runtime-types.ts";
import { MAX_PLAYERS } from "../src/shared/ui/player-config.ts";
import {
  createHeadlessRuntime,
  type HeadlessRuntime,
} from "./runtime-headless.ts";
import {
  buildHeadlessOptions,
  type Scenario,
  type ScenarioOptions,
  wrapHeadless,
} from "./scenario.ts";
import type { TimingApi } from "../src/runtime/runtime-contracts.ts";

export interface NetworkedPair {
  /** Host runtime — real game, real broadcasts. */
  readonly host: Scenario;
  /** Watcher runtime — receives host's broadcasts, no local AI. */
  readonly watcher: Scenario;
  /** Forward every pending host message to the watcher's dispatcher.
   *  Call between ticks to keep the pair in lockstep. */
  readonly pump: () => Promise<void>;
}

interface RuntimeBuild {
  readonly scenario: Scenario;
  readonly headless: HeadlessRuntime;
  readonly sentMessages: GameMessage[];
}

/** Dispatch target for `createScenario({ online: "host" | "watcher" })`.
 *  Delegates to the role-specific builder. */
export async function createOnlineScenario(
  opts: ScenarioOptions,
): Promise<Scenario> {
  if (opts.online === "host") {
    return (await buildHostRuntime(opts)).scenario;
  }
  if (opts.online === "watcher") {
    return (await buildWatcherRuntime(opts)).scenario;
  }
  throw new Error(
    `createOnlineScenario: unsupported online mode '${String(opts.online)}'`,
  );
}

/** Build a host + watcher pair wired together for two-runtime network
 *  tests. Both runtimes boot from the same seed/mode/rounds so their
 *  initial state is identical — the wire carries only state *changes*
 *  from there. The returned `pump()` forwards host→watcher messages
 *  between ticks. */
export async function createNetworkedPair(
  opts: ScenarioOptions = {},
): Promise<NetworkedPair> {
  const hostBuild = await buildHostRuntime(opts);
  const watcherBuild = await buildWatcherRuntime(opts);

  let forwarded = 0;
  const pump = async () => {
    const pending = hostBuild.sentMessages.slice(forwarded);
    forwarded = hostBuild.sentMessages.length;
    for (const msg of pending) {
      await watcherBuild.scenario.deliverMessage(msg as ServerMessage);
    }
  };

  return {
    host: hostBuild.scenario,
    watcher: watcherBuild.scenario,
    pump,
  };
}

async function buildHostRuntime(opts: ScenarioOptions): Promise<RuntimeBuild> {
  const sentMessages: GameMessage[] = [];
  const base = buildHeadlessOptions(opts, sentMessages);
  const headless = await createHeadlessRuntime({
    ...base,
    hostMode: true,
    onlinePhaseTicks: buildHostPhaseTicks((msg) => sentMessages.push(msg)),
  });
  const scenario = wrapHeadless(headless, sentMessages);
  return { scenario, headless, sentMessages };
}

async function buildWatcherRuntime(
  opts: ScenarioOptions,
): Promise<RuntimeBuild> {
  const sentMessages: GameMessage[] = [];
  const base = buildHeadlessOptions(opts, sentMessages);

  // Watchers observe every slot — no local AI runs.
  const allRemote = new Set<ValidPlayerSlot>();
  for (let slot = 0; slot < MAX_PLAYERS; slot++) {
    allRemote.add(slot as ValidPlayerSlot);
  }

  // Build the client + transition + watcher-tick contexts BEFORE
  // constructing the runtime so `tickWatcher` can close over them via
  // the `onlinePhaseTicks` we pass in.
  const client = buildWatcherClient(allRemote);
  const headlessHolder: { current?: HeadlessRuntime } = {};
  const requireHeadless = (): HeadlessRuntime => {
    const headless = headlessHolder.current;
    if (!headless) throw new Error("watcher runtime not yet constructed");
    return headless;
  };
  const lazyTiming: TimingApi = {
    now: () => requireHeadless().timing.now(),
    setTimeout: (callback, ms) =>
      requireHeadless().timing.setTimeout(callback, ms),
    clearTimeout: (handle) => requireHeadless().timing.clearTimeout(handle),
    requestFrame: (callback) => requireHeadless().timing.requestFrame(callback),
  };
  const watcherDeps: WatcherDeps = {
    getRuntime: () => requireHeadless().runtime,
    session: client.ctx.session,
    watcher: client.ctx.watcher,
    timing: lazyTiming,
  };
  const tickCtx: WatcherTickContext = {
    getState: () => headlessHolder.current!.runtime.runtimeState.state,
    getFrame: () => headlessHolder.current!.runtime.runtimeState.frame,
    getAccum: () => headlessHolder.current!.runtime.runtimeState.accum,
    getBattleAnim: () =>
      headlessHolder.current!.runtime.runtimeState.battleAnim,
    getControllers: () =>
      headlessHolder.current!.runtime.runtimeState.controllers,
    session: client.ctx.session,
    dedup: client.ctx.dedup,
    send: () => {},
    logThrottled: () => {},
    maybeSendAimUpdate: () => {},
    render: () => headlessHolder.current!.runtime.render(),
    setRemotePiecePhantoms: (phantoms) => {
      headlessHolder.current!.runtime.runtimeState.remotePhantoms = {
        piecePhantoms: phantoms,
        cannonPhantoms:
          headlessHolder.current!.runtime.runtimeState.remotePhantoms
            .cannonPhantoms,
      };
    },
    setRemoteCannonPhantoms: (phantoms) => {
      headlessHolder.current!.runtime.runtimeState.remotePhantoms = {
        piecePhantoms:
          headlessHolder.current!.runtime.runtimeState.remotePhantoms
            .piecePhantoms,
        cannonPhantoms: phantoms,
      };
    },
    onModifierRevealExpired: () => {
      // Test harness doesn't need the watcher's local enter-battle
      // dispatch — no existing test drives the MODIFIER_REVEAL timer
      // expiry through this fake. If one starts to, wire through the
      // real `dispatchWatcherLocal` here.
    },
    now: () => headlessHolder.current!.now(),
  };

  const headless = await createHeadlessRuntime({
    ...base,
    hostMode: false,
    remotePlayerSlots: allRemote,
    onlinePhaseTicks: buildWatcherPhaseTicks(tickCtx, client.ctx.watcher),
    // True watcher: amHost=false routes `tickGame` to `tickWatcher`,
    // matching production. Without this the watcher would also run host
    // phase ticks on top of incoming wire checkpoints.
    amHost: () => false,
  });
  headlessHolder.current = headless;

  initDeps({
    runtime: headless.runtime,
    initFromServer: () => Promise.resolve(),
    restoreFullState: () => {},
    showWaitingRoom: () => {},
    watcherDeps,
    client,
  });
  headless.subscribeNetworkMessage(handleServerMessage);

  const scenario = wrapHeadless(headless, sentMessages);
  return { scenario, headless, sentMessages };
}

/** Host-side `OnlinePhaseTicks` with real broadcast emitters. Checkpoint
 *  messages (CANNON_START / BATTLE_START / BUILD_START / BUILD_END) fire
 *  through `send` (which the caller wires to `sentMessages.push`).
 *  Phantom dedup channels are NOOP — this test shape doesn't re-emit
 *  watcher-originated phantoms back to the host. */
function buildHostPhaseTicks(send: (msg: GameMessage) => void): OnlinePhaseTicks {
  return {
    broadcastCannonStart: (state) => send(createCannonStartMessage(state)),
    broadcastBattleStart: (rngState) =>
      send(createBattleStartMessage(rngState)),
    broadcastBuildStart: () => send(createBuildStartMessage()),
    broadcastBuildEnd: (state, summary) =>
      send({
        type: MESSAGE.BUILD_END,
        needsReselect: [...summary.needsReselect],
        eliminated: [...summary.eliminated],
        scores: [...summary.scores],
        players: serializePlayersCheckpoint(state),
      }),
    remoteCannonPhantoms: () => [],
    remotePiecePhantoms: () => [],
    extendCrosshairs: (crosshairs) => [...crosshairs],
    tickMigrationAnnouncement: () => {},
  };
}

/** Watcher-side `OnlinePhaseTicks` with real `tickWatcher` wired plus the
 *  `watcherBeginBattle` hook the runtime calls to sync the battle countdown. */
function buildWatcherPhaseTicks(
  ctx: WatcherTickContext,
  watcherState: WatcherState,
): OnlinePhaseTicks {
  return {
    tickWatcher: (dt) => tickWatcher(watcherState, dt, ctx),
    watcherBeginBattle: (nowMs) => {
      watcherState.timing.countdownStartTime = nowMs;
      watcherState.timing.countdownDuration = BATTLE_COUNTDOWN;
    },
    extendCrosshairs: (crosshairs) => [...crosshairs],
    tickMigrationAnnouncement: () => {},
  };
}

/** Minimal `OnlineClient` for a watcher. The dispatcher reads
 *  `ctx.session`, `ctx.dedup`, `ctx.watcher`, and `devLog`; everything
 *  else is a no-op stub. `session.isHost` stays `false` — this is a
 *  pure watcher, never promoted. */
function buildWatcherClient(
  remotePlayerSlots: ReadonlySet<ValidPlayerSlot>,
): OnlineClient {
  const session: OnlineSession = createSession();
  for (const slot of remotePlayerSlots) {
    session.remotePlayerSlots.add(slot);
  }
  const dedup: DedupMaps = createDedupMaps();
  const watcher: WatcherState = createWatcherState();
  return {
    ctx: { session, dedup, watcher, reconnect: { count: 0, timer: null } },
    send: () => {},
    maybeSendAimUpdate: () => {},
    resetNetworking: () => {},
    clearReconnect: () => {},
    devLog: () => {},
    devLogThrottled: () => {},
    isReconnecting: () => false,
    destroy: () => {},
  };
}
