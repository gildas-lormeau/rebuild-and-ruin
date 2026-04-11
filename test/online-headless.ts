/**
 * Online receive-side test wrapper.
 *
 * Builds a `Scenario` whose `deliverMessage(...)` actually fans out through
 * the production server-message dispatcher (`handleServerMessage` in
 * `src/online/online-runtime-deps.ts`). Used by tests that exercise the
 * receive seam — verifying how the runtime applies an incoming peer
 * message — without spinning up a real WebSocket or a second machine.
 *
 * ## What this wires
 *
 * 1. A normal `HeadlessRuntime` in host mode (no-op `OnlinePhaseTicks`,
 *    no peers).
 * 2. A minimal `OnlineClient`-shaped object backed by the real
 *    `createSession` / `createDedupMaps` / `createWatcherState` factories
 *    plus `session.isHost = true` and a configurable `remotePlayerSlots`.
 * 3. A real `TransitionContext` via `createOnlineTransitionContext` (used
 *    by lifecycle messages — incremental tests rarely trigger it).
 * 4. The production `initDeps(...)` against (1)+(2)+(3), then subscribes
 *    `handleServerMessage` to the headless `subscribeNetworkMessage` seam.
 *
 * After setup, calling `sc.deliverMessage(msg)` runs `msg` through the
 * exact same dispatcher the WebSocket onmessage path uses in production.
 *
 * ## Constraints
 *
 * - The test's session is **not** the runtime's network adapter. The
 *   runtime continues to see `remotePlayerSlots = ∅` (from
 *   `runtime-headless.ts`), which means the AI controller still drives
 *   every slot. The dispatcher's `isRemoteHumanAction` check reads from
 *   the test's *own* session, so it accepts messages for the slots
 *   passed in `remotePlayerSlots`. After delivering, tests should assert
 *   immediately — subsequent ticks let the AI run again.
 *
 * - `defaultClient` is a module-level singleton in `online-stores.ts`.
 *   This wrapper does NOT use it — it builds a fresh `OnlineClient`-shaped
 *   object so multiple `createOnlineScenario()` calls in the same process
 *   stay isolated. `initDeps` itself reassigns module-level `let _depsInit`
 *   each call, so re-entry between tests is safe but you must call
 *   `createOnlineScenario` for each test (don't try to reuse one).
 *
 * - The DOM shim (`./online-dom-shim.ts`) MUST be the first import — it
 *   installs a stub `document` on `globalThis` before any module that
 *   transitively imports `online-dom.ts` evaluates.
 */

// MUST be first — installs `document` global before online-runtime-deps.ts
// transitively evaluates online-dom.ts.
import "./online-dom-shim.ts";

import {
  handleServerMessage,
  initDeps,
} from "../src/online/online-runtime-deps.ts";
import { createOnlineTransitionContext } from "../src/online/online-runtime-transition.ts";
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
} from "../src/online/online-watcher-tick.ts";
import { createHeadlessRuntime } from "./runtime-headless.ts";
import {
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
} from "../src/shared/game-constants.ts";
import type { GameMessage } from "../src/shared/protocol.ts";
import { type Scenario, type ScenarioOptions, wrapHeadless } from "./scenario.ts";

export interface OnlineScenarioOptions extends ScenarioOptions {
  /** Slots the test treats as remote-controlled. Threaded into BOTH
   *  - the headless network adapter (so the runtime stops running local AI
   *    for these slots — `frameMeta.remotePlayerSlots` gates selection,
   *    phase ticks, and life-lost handling), AND
   *  - the dispatcher's session (so `isRemoteHumanAction` accepts incoming
   *    messages for these slots).
   *  Defaults to `{1}`. */
  readonly remotePlayerSlots?: ReadonlySet<number>;
}

/** Receive-side test harness — `scenario` is the same `Scenario` that
 *  `createScenario` returns (so existing helpers like `waitForPhase` work),
 *  and `client` is the underlying `OnlineClient`-shaped object whose session
 *  and watcher state the dispatcher mutates. Tests assert on `client.ctx.*`
 *  to verify watcher writes (`remoteCrosshairs`, phantoms, etc.). */
export interface OnlineHarness {
  readonly scenario: Scenario;
  readonly client: OnlineClient;
}

/** Build a `Scenario` whose `deliverMessage(...)` routes through the
 *  production `handleServerMessage` dispatcher, and return it together
 *  with the underlying `OnlineClient` so tests can inspect watcher state.
 *  See file header for the full setup story.
 *
 *  Forces `hostMode: true` — receive-side tests are inherently online and
 *  exercise the host code path on the receiving machine. */
export async function createOnlineHarness(
  opts: OnlineScenarioOptions = {},
): Promise<OnlineHarness> {
  const remotePlayerSlots = opts.remotePlayerSlots ?? new Set([1]);
  const sentMessages: GameMessage[] = [];
  const headless = await createHeadlessRuntime({
    seed: opts.seed ?? 42,
    gameMode: opts.mode === "modern" ? GAME_MODE_MODERN : GAME_MODE_CLASSIC,
    rounds: opts.rounds ?? 3,
    hostMode: true,
    speedMultiplier: opts.speedMultiplier,
    autoStartGame: opts.autoStartGame ?? true,
    networkSendObserver: (msg) => sentMessages.push(msg),
    remotePlayerSlots,
  });

  const client = buildTestOnlineClient(remotePlayerSlots);
  const transitionCtx = createOnlineTransitionContext({
    getRuntime: () => headless.runtime,
    session: client.ctx.session,
    watcher: client.ctx.watcher,
  });

  initDeps({
    runtime: headless.runtime,
    initFromServer: () => Promise.resolve(),
    restoreFullState: () => {},
    showWaitingRoom: () => {},
    transitionCtx,
    client,
  });

  headless.subscribeNetworkMessage(handleServerMessage);

  const scenario = wrapHeadless(headless, sentMessages);
  return { scenario, client };
}

/** Convenience wrapper that returns just the `Scenario`. Use
 *  `createOnlineHarness` if you need to read `client.ctx.*` for assertions. */
export async function createOnlineScenario(
  opts: OnlineScenarioOptions = {},
): Promise<Scenario> {
  const harness = await createOnlineHarness(opts);
  return harness.scenario;
}

/** Build a minimal `OnlineClient`-shaped object using the real session /
 *  dedup / watcher factories. The dispatcher only reads `ctx` and
 *  `devLog` — every other method on `OnlineClient` is a no-op stub. */
function buildTestOnlineClient(
  remotePlayerSlots: ReadonlySet<number>,
): OnlineClient {
  const session: OnlineSession = createSession();
  // Non-volatile mutation: this client is host-only for the test lifetime,
  // never goes through promotion. Direct write is intentional — the
  // `isHostInContext` rule's late-binding concern doesn't apply here.
  // eslint-disable-next-line no-restricted-syntax -- test setup, never re-promoted
  session.isHost = true;
  for (const slot of remotePlayerSlots) {
    session.remotePlayerSlots.add(slot);
  }
  const dedup: DedupMaps = createDedupMaps();
  const watcher: WatcherState = createWatcherState();
  return {
    ctx: {
      session,
      dedup,
      watcher,
      reconnect: { count: 0, timer: null },
    },
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
