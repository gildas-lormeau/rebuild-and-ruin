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
 * The watcher uses production infrastructure: `session.isHost = false`,
 * `remotePlayerSlots` carries only remote-human slots (empty for pure-AI
 * tests since AIs are recomputed locally on every peer per the
 * wire-only-uncomputable rule). Lifecycle messages drive phase
 * transitions via `handleServerLifecycleMessage`; incremental messages
 * drive state via `handleServerIncrementalMessage`. The watcher runs the
 * same `tickGame` as the host — there is no separate watcher tick path
 * in the clone-everywhere architecture.
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
import { type WatcherDeps } from "../src/online/online-phase-transitions.ts";
import {
  createBattleStartMessage,
  createBuildStartMessage,
  createCannonStartMessage,
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
  type WatcherState,
} from "../src/online/online-watcher-state.ts";
import type { ValidPlayerSlot } from "../src/shared/core/player-slot.ts";
import type { OnlinePhaseTicks } from "../src/runtime/runtime-types.ts";
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
  headless.runtime.runtimeState.state.debugTag = "HOST";
  const scenario = wrapHeadless(headless, sentMessages);
  return { scenario, headless, sentMessages };
}

async function buildWatcherRuntime(
  opts: ScenarioOptions,
): Promise<RuntimeBuild> {
  const sentMessages: GameMessage[] = [];
  // Watcher must run regular AI for every slot — same strategy seed as the
  // host advances RNG identically across peers, keeping selections in
  // lockstep. `assertWireExercised` is the test's separate proof that
  // the host's broadcasts actually reach the wire (the watcher would
  // converge "trivially" via its own AI otherwise).
  const watcherOpts: ScenarioOptions = { ...opts, assistedSlots: undefined };
  const base = buildHeadlessOptions(watcherOpts, sentMessages);

  // `remotePlayerSlots` carries only remote-human slots — AI controllers
  // are recomputed locally on every peer (project rule: wire =
  // uncomputable inputs only). For pure-AI tests, no humans means empty.
  const remoteHumans = new Set<ValidPlayerSlot>();

  // Build the client + transition contexts BEFORE constructing the
  // runtime so `onlinePhaseTicks` and `WatcherDeps` can close over them.
  const client = buildWatcherClient(remoteHumans);
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

  const headless = await createHeadlessRuntime({
    ...base,
    hostMode: false,
    remotePlayerSlots: remoteHumans,
    onlinePhaseTicks: buildWatcherPhaseTicks(),
    // amHost=false flips the broadcast gate in `buildHostPhaseCtx`
    // (no `ctx.broadcast` on watcher), so watcher transitions don't emit
    // wire messages even though they run the same code as host.
    amHost: () => false,
  });
  headlessHolder.current = headless;
  headless.runtime.runtimeState.state.debugTag = "WATCHER";

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
    broadcastCannonStart: () => send(createCannonStartMessage()),
    broadcastBattleStart: (rngState) =>
      send(createBattleStartMessage(rngState)),
    broadcastBuildStart: () => send(createBuildStartMessage()),
    broadcastBuildEnd: () => send({ type: MESSAGE.BUILD_END }),
    extendCrosshairs: (crosshairs) => [...crosshairs],
    tickMigrationAnnouncement: () => {},
  };
}

/** Watcher-side `OnlinePhaseTicks` — clone-everywhere model means no
 *  separate watcher tick path, so this is just the cross-machine merging
 *  hooks. Broadcasts are unset because the watcher's `ctx.broadcast`
 *  is undefined (gated by `amHost=false`). */
function buildWatcherPhaseTicks(): OnlinePhaseTicks {
  return {
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
