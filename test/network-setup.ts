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
  createMessageHandler,
  handleServerMessage,
  initDeps,
} from "../src/online/online-runtime-deps.ts";
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
  createOnlinePresenceState,
  type OnlinePresenceState,
} from "../src/online/online-presence-state.ts";
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

/** Two-peer pair where BOTH peers drive a local assisted-human slot and
 *  broadcast its actions to the other peer through the wire. Models the
 *  real "2 humans on different machines" online setup, in contrast to
 *  `createNetworkedPair` (one-way: only the host has assisted slots).
 *
 *  Each peer's `remotePlayerSlots` is the OTHER peer's assisted slots, so
 *  neither peer ticks the other's local controllers — the wire is the only
 *  mutation path for those slots.
 *
 *  The pump can simulate network latency by delaying message delivery for
 *  `wireDelayFrames` simulation ticks. With delay = 0, this is equivalent
 *  to a zero-RTT loopback. With delay > 0, fires from one peer arrive on
 *  the other peer N frames later than they originated — the timing
 *  asymmetry that exposes cross-peer fire-frame races. */
export interface BidirectionalNetworkedPair {
  readonly host: Scenario;
  readonly watcher: Scenario;
  /** Drain pending messages between peers, respecting `wireDelayFrames`.
   *  Increments the internal frame counter on each call — call EXACTLY
   *  once per pair of host/watcher ticks. */
  readonly pump: () => Promise<void>;
}

export interface BidirectionalNetworkedPairOptions extends ScenarioOptions {
  /** Slots driven by an assisted-human controller on the HOST runtime.
   *  Their actions broadcast to the watcher via wire. */
  readonly assistedSlotsHost: readonly ValidPlayerSlot[];
  /** Slots driven by an assisted-human controller on the WATCHER runtime.
   *  Their actions broadcast to the host via wire. */
  readonly assistedSlotsWatcher: readonly ValidPlayerSlot[];
  /** Number of simulation ticks each wire message is held before being
   *  delivered. 0 = zero-RTT loopback. Defaults to 0. */
  readonly wireDelayFrames?: number;
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

export async function createBidirectionalNetworkedPair(
  opts: BidirectionalNetworkedPairOptions,
): Promise<BidirectionalNetworkedPair> {
  const hostAssisted = opts.assistedSlotsHost;
  const watcherAssisted = opts.assistedSlotsWatcher;
  const hostRemote = new Set<ValidPlayerSlot>(watcherAssisted);
  const watcherRemote = new Set<ValidPlayerSlot>(hostAssisted);
  const wireDelay = opts.wireDelayFrames ?? 0;

  const hostBuild = await buildBidirectionalHost(opts, hostAssisted, hostRemote);
  const watcherBuild = await buildBidirectionalWatcher(
    opts,
    watcherAssisted,
    watcherRemote,
  );

  // Per-direction queue: each entry holds a pending message and the frame
  // it became eligible for delivery (= origin frame + wireDelay).
  interface Pending {
    readonly msg: GameMessage;
    readonly deliverAt: number;
  }
  const hostToWatcher: Pending[] = [];
  const watcherToHost: Pending[] = [];
  let hostForwarded = 0;
  let watcherForwarded = 0;
  let frame = 0;

  const pump = async () => {
    // Drain new outbound messages into the per-direction queues, stamped
    // with their eligible-for-delivery frame.
    const hostPending = hostBuild.sentMessages.slice(hostForwarded);
    hostForwarded = hostBuild.sentMessages.length;
    for (const msg of hostPending) {
      hostToWatcher.push({ msg, deliverAt: frame + wireDelay });
    }
    const watcherPending = watcherBuild.sentMessages.slice(watcherForwarded);
    watcherForwarded = watcherBuild.sentMessages.length;
    for (const msg of watcherPending) {
      watcherToHost.push({ msg, deliverAt: frame + wireDelay });
    }

    // Deliver everything that has come due. FIFO within each direction.
    while (hostToWatcher.length > 0 && hostToWatcher[0]!.deliverAt <= frame) {
      const pending = hostToWatcher.shift()!;
      await watcherBuild.scenario.deliverMessage(pending.msg as ServerMessage);
    }
    while (watcherToHost.length > 0 && watcherToHost[0]!.deliverAt <= frame) {
      const pending = watcherToHost.shift()!;
      await hostBuild.scenario.deliverMessage(pending.msg as ServerMessage);
    }

    frame++;
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
  // Strip `assistedSlots` so the watcher installs the default (regular AI)
  // controller for every slot. The watcher never *ticks* the assisted slot
  // anyway (it sits in `remotePlayerSlots` below), but using a regular AI
  // controller ensures no accidental broadcasts if the local-tick filter
  // ever regresses.
  const watcherOpts: ScenarioOptions = { ...opts, assistedSlots: undefined };
  const base = buildHeadlessOptions(watcherOpts, sentMessages);

  // `remotePlayerSlots` mirrors production: every slot driven by a remote
  // human (or assisted-human in this test) sits here. `localControllers`
  // skips these slots in the tick loop, so the wire is the only mutation
  // path for them. For pure-AI tests this is empty — no remote humans,
  // every slot ticks locally as deterministic AI.
  const remoteHumans = new Set<ValidPlayerSlot>(opts.assistedSlots ?? []);

  const client = buildWatcherClient(remoteHumans);
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
  headless.runtime.runtimeState.state.debugTag = "WATCHER";

  initDeps({
    runtime: headless.runtime,
    initFromServer: () => Promise.resolve(),
    restoreFullState: () => {},
    showWaitingRoom: () => {},
    client,
  });
  headless.subscribeNetworkMessage(handleServerMessage);

  const scenario = wrapHeadless(headless, sentMessages);
  return { scenario, headless, sentMessages };
}

/** Minimal `OnlineClient` for a watcher. The dispatcher reads
 *  `ctx.session`, `ctx.dedup`, `ctx.presence`, and `devLog`; everything
 *  else is a no-op stub. `session.isHost` stays `false` — this is a
 *  pure watcher, never promoted. */
function buildWatcherClient(
  remotePlayerSlots: ReadonlySet<ValidPlayerSlot>,
): OnlineClient {
  return buildPeerClient(remotePlayerSlots, false);
}

async function buildBidirectionalHost(
  opts: ScenarioOptions,
  assistedSlots: readonly ValidPlayerSlot[],
  remotePlayerSlots: ReadonlySet<ValidPlayerSlot>,
): Promise<RuntimeBuild> {
  const sentMessages: GameMessage[] = [];
  const peerOpts: ScenarioOptions = { ...opts, assistedSlots };
  const base = buildHeadlessOptions(peerOpts, sentMessages);
  const headless = await createHeadlessRuntime({
    ...base,
    hostMode: true,
    remotePlayerSlots,
    onlinePhaseTicks: buildHostPhaseTicks((msg) => sentMessages.push(msg)),
  });
  headless.runtime.runtimeState.state.debugTag = "HOST";

  // Host needs to receive the watcher's assisted-slot broadcasts.
  // `createMessageHandler` returns a per-instance closure (not the
  // singleton `handleServerMessage`) so two peers in the same process
  // each dispatch into their OWN runtime — no module-state collision.
  const client = buildPeerClient(remotePlayerSlots, true);
  const handler = createMessageHandler({
    runtime: headless.runtime,
    initFromServer: () => Promise.resolve(),
    restoreFullState: () => {},
    showWaitingRoom: () => {},
    client,
  });
  headless.subscribeNetworkMessage(handler);

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
    broadcastBattleStart: () => send(createBattleStartMessage()),
    broadcastBuildStart: () => send(createBuildStartMessage()),
    broadcastBuildEnd: () => send({ type: MESSAGE.BUILD_END }),
    extendCrosshairs: (crosshairs) => [...crosshairs],
    tickMigrationAnnouncement: () => {},
  };
}

async function buildBidirectionalWatcher(
  opts: ScenarioOptions,
  assistedSlots: readonly ValidPlayerSlot[],
  remotePlayerSlots: ReadonlySet<ValidPlayerSlot>,
): Promise<RuntimeBuild> {
  const sentMessages: GameMessage[] = [];
  const peerOpts: ScenarioOptions = { ...opts, assistedSlots };
  const base = buildHeadlessOptions(peerOpts, sentMessages);
  const headless = await createHeadlessRuntime({
    ...base,
    hostMode: false,
    remotePlayerSlots,
    onlinePhaseTicks: buildWatcherPhaseTicks(),
    amHost: () => false,
  });
  headless.runtime.runtimeState.state.debugTag = "WATCHER";

  const client = buildPeerClient(remotePlayerSlots, false);
  const handler = createMessageHandler({
    runtime: headless.runtime,
    initFromServer: () => Promise.resolve(),
    restoreFullState: () => {},
    showWaitingRoom: () => {},
    client,
  });
  headless.subscribeNetworkMessage(handler);

  const scenario = wrapHeadless(headless, sentMessages);
  return { scenario, headless, sentMessages };
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

/** Shared client builder for both host and watcher peers in a
 *  bidirectional pair. `isHost` controls `session.isHost` so the
 *  dispatcher's `isRemoteHumanAction` validation (host accepts only
 *  remote-human-slot actions; watcher accepts everything) routes
 *  correctly on each peer. */
function buildPeerClient(
  remotePlayerSlots: ReadonlySet<ValidPlayerSlot>,
  isHost: boolean,
): OnlineClient {
  const session: OnlineSession = createSession();
  if (isHost) {
    // eslint-disable-next-line no-restricted-syntax -- test session bootstrap
    session.isHost = true;
  }
  for (const slot of remotePlayerSlots) {
    session.remotePlayerSlots.add(slot);
  }
  const dedup: DedupMaps = createDedupMaps();
  const presence: OnlinePresenceState = createOnlinePresenceState();
  return {
    ctx: { session, dedup, presence, reconnect: { count: 0, timer: null } },
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
