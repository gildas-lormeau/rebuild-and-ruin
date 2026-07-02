/**
 * Headless runtime variant — boots `createGameRuntime` with stub DOM/timing
 * deps and a manually-driven main loop. Used by the test scenario API
 * (`test/scenario.ts`) and reusable by future dev tools (preview mode,
 * AI showcase, demo recording).
 *
 * The runtime sub-systems are unchanged — same composition root the browser
 * uses. Only the *injected* dependencies are stubbed:
 *   - Renderer: no-op `drawFrame`, dummy HTMLElement-shaped container
 *   - Timing: mock clock advanced by `tick(dtMs)`, deterministic setTimeout
 *   - Keyboard event source: no-op add/removeEventListener
 *
 * Tests observe state changes via the typed `GameEventBus` on
 * `runtime.runtimeState.state.bus` rather than reaching into runtime internals.
 */

import { createDefaultAiDeps } from "../src/ai/ai-defaults.ts";
import {
  ensureAiModulesLoaded,
  rollAiPersonality,
} from "../src/controllers/controller-factory.ts";
import { generateMap } from "../src/game/index.ts";
import { rebuildControllersForPhase } from "../src/online/online-host-promotion.ts";
import { createAiController } from "../src/runtime/bootstrap.ts";
import { Rng } from "../src/shared/platform/rng.ts";
import {
  type GameMessage,
  MESSAGE,
  type ServerMessage,
} from "../src/protocol/protocol.ts";
import {
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
  type GameMode,
  LOBBY_TIMER,
  SIM_TICK_DT,
} from "../src/shared/core/game-constants.ts";
import type { GameMap, Viewport } from "../src/shared/core/geometry-types.ts";
import type {
  RendererInterface,
  RenderOverlay,
} from "../src/shared/ui/overlay-types.ts";
import type {
  PlayerId,
  ValidPlayerId,
} from "../src/shared/core/player-slot.ts";
import type {
  ControllerFactory,
  HapticsObserver,
  PlayerController,
} from "../src/shared/core/system-interfaces.ts";
import type { GameState } from "../src/shared/core/types.ts";
import { SEED_CUSTOM } from "../src/shared/ui/player-config.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";
import {
  createGameRuntime,
  createLocalNetworkApi,
} from "../src/runtime/composition.ts";
import {
  DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS,
  LOCKSTEP_QUARANTINE_DEBT_TICKS,
  type ScheduledAction,
} from "../src/shared/core/action-schedule.ts";
import { lockstepDebtTicks, setMode } from "../src/runtime/state.ts";
import { createStubElement } from "./stub-dom.ts";
import type { GameRuntime } from "../src/runtime/handle.ts";
import type {
  OnlinePhaseTicks,
  RuntimeConfig,
} from "../src/runtime/types.ts";
import type { TimingApi } from "../src/runtime/timing-api.ts";

/** Test observer for the headless `network.send` seam. Receives every
 *  outbound message the runtime would broadcast through the production
 *  fan-out path, regardless of host vs. local mode (the headless
 *  `network.send` impl is otherwise a no-op). One of four parallel test
 *  seams — see also the haptics / sound / render observer types. */
export interface NetworkObserver {
  sent?(msg: GameMessage): void;
}

interface HeadlessRuntimeOptions {
  /** Map seed — controls map, AI, and modifier rolls. */
  seed: number;
  /** Game mode. Defaults to `"classic"`. Use `"modern"` to enable
   *  modifiers, upgrades, and combo scoring. */
  gameMode?: GameMode;
  /** Number of rounds before the game ends. Defaults to 3. */
  rounds?: number;
  /** When true, runtime log lines are forwarded to console. Defaults to false. */
  log?: boolean;
  /** When true, the runtime is wired in "online host" mode: it constructs a
   *  no-op `OnlinePhaseTicks` so every host fan-out hook fires (broadcasts
   *  go to /dev/null, dedup channels are NOOP, watcher hooks unset). Tests
   *  that need real broadcasts pass an explicit `onlinePhaseTicks` instead;
   *  see `test/network-setup.ts`. */
  hostMode?: boolean;
  /** Override `amHost` on the runtime's network api. Defaults to `true`
   *  (the production "no peers" shape). Network-pair tests pass
   *  `() => false` for the watcher half — this flips the broadcast gate
   *  in `buildPhaseCtx` so the watcher's transitions don't emit
   *  wire messages even though it runs the same `tickGame` as the host. */
  amHost?: () => boolean;
  /** Optional renderer override. When provided, replaces the default no-op
   *  stub renderer — used by tests that need the real draw pipeline to fire
   *  (e.g. for `RenderObserver` assertions). The caller is responsible for
   *  installing the canvas factory before constructing the renderer. */
  renderer?: RendererInterface;
  /** Initial speed multiplier (1..16, integer). Drives the sub-step loop
   *  in `mainLoop`. Tests use this to verify the dev speed mechanism. */
  speedMultiplier?: number;
  /** When false, skips the automatic `startGame()` call and leaves the
   *  runtime in lobby mode with `lobby.active = true`. Used by input tests
   *  that need to drive the lobby UI (slot joining, options menu) before
   *  the match begins. Defaults to true. */
  autoStartGame?: boolean;
  /** Test observer for the network seam. Receives every message the
   *  runtime would broadcast via `network.send`, regardless of whether
   *  the runtime is in host mode (the headless `network.send` is
   *  otherwise a no-op). Used by tests that assert on host fan-out
   *  payloads (checkpoints, action commands, watcher ticks) without
   *  spinning up a real WebSocket. */
  networkObserver?: NetworkObserver;
  /** Slots the runtime should treat as remote-controlled (i.e. driven by a
   *  peer machine, not by local AI). The headless network adapter exposes
   *  this set via `network.remotePlayerSlots()`, which gates AI controllers,
   *  selection ticks, life-lost prompts, and phase ticks throughout the
   *  runtime. Used by `test/online-headless.ts` so the dispatcher's writes
   *  to a "remote" player's selection state aren't immediately overwritten
   *  by that slot's local AI. Defaults to the empty set (every slot is
   *  local AI), preserving existing test behavior. */
  remotePlayerSlots?: ReadonlySet<ValidPlayerId>;
  /** Test observer for haptics intents. Receives every `vibrate(reason, ms,
   *  minLevel)` call BEFORE the platform/level gate, so tests can assert on
   *  game-event → haptic mappings without a real `navigator.vibrate`. */
  hapticsObserver?: HapticsObserver;
  /** Explicit `OnlinePhaseTicks` override. Takes precedence over the
   *  `hostMode` default. Used by network tests that need real broadcast
   *  emitters wired to a sink. When undefined, falls back to a hostMode-
   *  driven default (broadcasts forwarded to `networkObserver`) or an
   *  empty bag for non-host. */
  onlinePhaseTicks?: OnlinePhaseTicks;
  /** Production-shaped dialog drains over a peer session's early-choice
   *  queues (life-lost / upgrade-pick). Presence flips the dialog
   *  subsystems onto their online lockstep branch (broadcast + applyAt
   *  schedule instead of immediate apply), so network tests exercise the
   *  same path as production online play. Undefined = local
   *  immediate-apply (all non-network tests). */
  onlineEarlyChoices?: RuntimeConfig["onlineEarlyChoices"];
  /** Forwarded to `RuntimeConfig.onEndGame` — fires when this runtime's
   *  local game-over detection ends the game. Network tests use it to
   *  emit the production GAME_OVER payload into the wire sink, mirroring
   *  the `onEndGame` wiring in `src/online/runtime/game.ts`. */
  onEndGame?: RuntimeConfig["onEndGame"];
  /** Forwarded to `RuntimeConfig.onlineHostAfterFrame` — host per-frame
   *  poll. The bidirectional reclaim parity test wires it to
   *  `pollDeferredResyncs` so the deferred targeted resync fires. */
  onlineHostAfterFrame?: RuntimeConfig["onlineHostAfterFrame"];
  /** When true, the headless runtime calls `enableMobileZoom()` on the
   *  camera so per-phase memory, edge-pan, follow-crosshair, and the
   *  CAMERA_TARGET event emitter all run during tests. Defaults to false
   *  (matches the existing determinism fixtures, which were recorded
   *  without mobile zoom). Camera-determinism tests opt in. */
  mobileZoomEnabled?: boolean;
  /** Slots that should be driven by `AiAssistedHumanController` instead of
   *  the regular `AiController`. AI logic still picks placements, but every
   *  outcome flows through `network.send` so per-action wire formats are
   *  exercised. Used by the network-vs-local parity test to prove host →
   *  watcher convergence under the assisted-human code path. The factory
   *  is wired at bootstrap so the assisted controller is the SLOT 1
   *  controller from the first `selectTower` call onward — no
   *  mid-game swap, no asymmetric RNG advance. */
  assistedSlots?: readonly ValidPlayerId[];
  /** Explicit per-slot controller factory override. When provided, takes
   *  precedence over the `assistedSlots`-derived factory and rides the same
   *  bootstrap `RuntimeConfig.controllerFactory` seam. Lets a dev tool install
   *  a custom controller (e.g. an external-agent brain) on a slot without the
   *  assisted-human path. Omitted on every real test + production, so the
   *  default `createController` is used. */
  controllerFactory?: ControllerFactory;
}

export interface RunOpts {
  /** Wall-clock budget in sim-milliseconds. Applied to the mock clock
   *  — NOT wall time. Defaults: 30_000 for `runUntil` / wait helpers,
   *  120_000 for `runGame`. The runtime converts this to sim ticks
   *  internally (`Math.ceil(timeoutMs / SIM_TICK_MS)`). */
  timeoutMs?: number;
  /** Per-frame dt for predicate cadence. Defaults to 16ms (≈60fps).
   *  Doesn't affect the total budget — only how often `predicate` is
   *  checked between sim ticks. */
  dtMs?: number;
}

export interface HeadlessRuntime {
  readonly runtime: GameRuntime;
  /** Mock-clock TimingApi. Exposed so network-test setup can thread the
   *  same deterministic timing into watcher-side transition deps (the
   *  watcher runtime is constructed lazily, so deps need a stable handle
   *  before the runtime exists). */
  readonly timing: TimingApi;
  /** Current mock clock (ms). */
  now(): number;
  /** Drive the simulation until `predicate` returns true. Throws
   *  `ScenarioTimeoutError` if the predicate never fires within
   *  `opts.timeoutMs` (sim-ms, not wall-clock). Use `tick()` for the
   *  "just run N frames" case — unit is deliberately different. */
  runUntil(predicate: () => boolean, opts?: RunOpts): void;
  /** Advance the simulation by a fixed number of frames without
   *  checking any predicate. The frame-denominated precision tool —
   *  `runUntil` / `runGame` are the budget-denominated counterparts.
   *  `Scenario.tick()` is a thin wrapper over this. */
  tick(frames?: number, dtMs?: number): void;
  /** Simulate a frozen tab: advance the mock clock by `gapMs` with NO
   *  frames in between, then run the single catch-up frame the browser
   *  fires on tab return — ONE mainLoop whose measured dt is the whole
   *  gap. `tick()` can't model this: it quantizes any dtMs into
   *  1-sim-tick frames, so the frame clamp (`clampedFrameDt`) never sees
   *  a large delta. Online runtimes bank the gap as lockstep debt and
   *  replay it over the following `tick()`s; offline runtimes drop it
   *  (MAX_FRAME_DT clamp) and resume where they left off. */
  stall(gapMs: number): void;
  /** Drive the simulation until `mode === STOPPED` (game over).
   *  Throws `ScenarioTimeoutError` on timeout. */
  runGame(opts?: RunOpts): void;
  /** Real `EventTarget` the keyboard handler is bound to. Tests dispatch
   *  `KeyboardEvent` instances here to drive the same code path the browser
   *  uses (`document.addEventListener("keydown", ...)`). */
  readonly keyboardEventSource: EventTarget;
  /** Real `EventTarget` the mouse + touch handlers are bound to (the
   *  renderer's canvas in production). Tests dispatch `MouseEvent` /
   *  `TouchEvent` instances here. */
  readonly pointerEventTarget: EventTarget;
  /** Deliver a fake peer message to every handler the runtime registered
   *  via `network.onMessage`. This is the in-memory loopback equivalent
   *  of a WebSocket frame arriving from a peer — handlers run through
   *  the same dispatch path the production code uses. Returns the
   *  combined promise of all handler invocations so tests can `await`
   *  the receive side before asserting on game state. */
  deliverNetworkMessage(msg: ServerMessage): Promise<void>;
  /** Register an additional receive-side handler outside the runtime's
   *  own `network.onMessage` subscriptions. Used by the network test setup
   *  (`test/network-setup.ts`) to plug the production `handleServerMessage`
   *  dispatcher (which lives in `online/`, a layer the runtime cannot
   *  import) into the same delivery loop `deliverNetworkMessage` walks.
   *  Returns an unsubscribe function. */
  subscribeNetworkMessage(
    handler: (msg: ServerMessage) => void | Promise<void>,
  ): () => void;
}

/** Default budget for `runUntil` and wait helpers (`waitFor*`). Sim-ms.
 *  Budgets are in MOCK-CLOCK milliseconds (virtual time) — the headless
 *  simulation advances the mock clock by ~17ms per sim tick, so a 60_000ms
 *  budget gets you ~60 seconds of in-game time. Full matches take several
 *  build/battle cycles (~5–10 virtual minutes), so `runGame` has its own
 *  larger default. */
export const DEFAULT_RUNUNTIL_TIMEOUT_MS = 60_000;
/** Default budget for `runGame` — a full 3-round match is several
 *  virtual minutes because phase timers, banner sweeps, and battle
 *  rounds all consume sim time. */
export const DEFAULT_RUNGAME_TIMEOUT_MS = 600_000;

/** Thrown by `runUntil` / `runGame` / `waitFor*` when the predicate /
 *  target state doesn't materialize within the sim-ms budget.
 *  TODO: collapse with `E2ETimeoutError` into a shared base class —
 *  they currently duplicate the same `{ timeoutMs }` shape. */
export class ScenarioTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = "ScenarioTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export async function createHeadlessRuntime(
  opts: HeadlessRuntimeOptions,
): Promise<HeadlessRuntime> {
  const {
    seed,
    gameMode = GAME_MODE_CLASSIC,
    rounds = 3,
    log = false,
    hostMode = false,
    renderer: rendererOverride,
    speedMultiplier,
    autoStartGame = true,
    networkObserver,
    remotePlayerSlots,
    hapticsObserver,
    onlinePhaseTicks: onlinePhaseTicksOverride,
    onlineEarlyChoices,
    assistedSlots,
    controllerFactory: controllerFactoryOverride,
  } = opts;

  // Forward-declared so the lobby callbacks (defined below the
  // `createGameRuntime` call) and the assisted-controller factory's
  // schedule closure can reach into the constructed runtime. The closures
  // only fire after construction completes, so the holder is always
  // populated by the time they're invoked.
  const runtimeHolder: { current?: GameRuntime } = {};

  const controllerFactory = controllerFactoryOverride ??
    (assistedSlots && assistedSlots.length > 0
      ? buildAssistedControllerFactory(
        assistedSlots,
        (msg) => networkObserver?.sent?.(msg),
        () => (action) =>
          runtimeHolder.current!.runtimeState.actionSchedule.schedule(action),
        DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS,
        () => runtimeHolder.current!.runtimeState.state.round,
        () => lockstepDebtTicks(runtimeHolder.current!.runtimeState),
      )
      : undefined);

  // ── Mock clock + deterministic timer scheduling ───────────────────
  // All timing flows through this closure. `mainLoop` is driven manually
  // by `tick()`, so `requestFrame` is a no-op (no auto-rescheduling).
  let clock = 0;
  let nextHandle = 1;
  const pendingTimeouts = new Map<
    number,
    { callback: () => void; fireAt: number }
  >();

  const timing: TimingApi = {
    now: () => clock,
    setTimeout: (callback, ms) => {
      const handle = nextHandle++;
      pendingTimeouts.set(handle, { callback, fireAt: clock + ms });
      return handle;
    },
    clearTimeout: (handle) => {
      pendingTimeouts.delete(handle);
    },
    requestFrame: () => {},
  };

  const renderer = rendererOverride ?? createStubRenderer();
  // Real EventTarget so tests can dispatch keyboard events at the same source
  // the production browser path uses (`document` in main.ts). The cast widens
  // EventTarget to the Document subset the runtime injects — every method we
  // surface lives on EventTarget itself.
  const keyboardEventSource = new EventTarget() as unknown as
    & Pick<
      Document,
      "addEventListener" | "removeEventListener"
    >
    & { dispatchEvent(event: Event): boolean };

  // ── Runtime construction ──────────────────────────────────────────
  // Tracks every handler the runtime registers via `network.onMessage`.
  // Tests use `deliverNetworkMessage` (exposed on the HeadlessRuntime
  // return value) to deliver a fake peer message — same code path the
  // production WebSocket fan-out would hit.
  const messageHandlers = new Set<
    (msg: ServerMessage) => void | Promise<void>
  >();

  const runtime = createGameRuntime({
    renderer,
    timing,
    keyboardEventSource,
    // Headless network adapter reuses the production "no peers" factory from
    // runtime-composition.ts (same one main.ts uses) and layers test-only
    // observability on top:
    //   - `send` forwards to the optional `networkObserver` so tests can
    //     assert on host fan-out payloads without a real WebSocket.
    //   - `onMessage` tracks handlers so tests can inject peer messages
    //     via `deliverNetworkMessage(msg)` — the in-memory loopback that
    //     the future "machines" abstraction will generalize.
    //   - `remotePlayerSlots` lets tests mark slots as peer-controlled
    //     (gates AI/selection/life-lost/phase ticks).
    network: createLocalNetworkApi({
      send: (msg) => networkObserver?.sent?.(msg),
      onMessage: (handler) => {
        messageHandlers.add(handler);
        return () => messageHandlers.delete(handler);
      },
      remotePlayerSlots,
      amHost: opts.amHost,
    }),
    // No ai wiring here (nor in main.ts / online/runtime/game.ts) — the
    // composition root `src/runtime/composition.ts` imports the ai functions
    // directly and wires them into the dialog subsystems. Headless plays
    // the real game and observes picks via bus events, same as production.
    log: log ? (msg: string) => console.log(`[headless] ${msg}`) : () => {},
    logThrottled: () => {},
    // Real countdown so the lobby tick can detect expiry. Production main.ts
    // computes the same value (Math.max(0, LOBBY_TIMER - timerAccum)). When
    // `autoStartGame: true` the lobby phase is bypassed before the first
    // tick, so the value is unobservable in that path.
    getLobbyRemaining: () =>
      Math.max(
        0,
        LOBBY_TIMER -
          (runtimeHolder.current?.runtimeState.lobby.timerAccum ?? 0),
      ),
    getUrlRoundsOverride: () => rounds,
    getUrlModeOverride: () =>
      gameMode === GAME_MODE_MODERN ? GAME_MODE_MODERN : GAME_MODE_CLASSIC,
    showLobby: () => runtimeHolder.current?.lobby.show(),
    onLobbySlotJoined: (pid) => runtimeHolder.current?.lobby.markJoined(pid),
    onTickLobbyExpired: async () => {
      const built = runtimeHolder.current;
      if (!built) return;
      await built.lifecycle.startGame();
      setMode(built.runtimeState, Mode.SELECTION);
    },
    onlinePhaseTicks: onlinePhaseTicksOverride ??
      (hostMode
        ? buildHeadlessHostPhaseTicks((msg) => networkObserver?.sent?.(msg))
        : undefined),
    onlineEarlyChoices,
    onEndGame: opts.onEndGame,
    onlineHostAfterFrame: opts.onlineHostAfterFrame,
    observers: hapticsObserver ? { haptics: hapticsObserver } : undefined,
    // IS_DEV is false under Deno, so headless must opt in explicitly to keep
    // the per-frame TICK event flowing to test subscribers (reveal/fade tests).
    emitTickEvent: true,
    controllerFactory,
  });
  runtimeHolder.current = runtime;

  // Opt-in mobile auto-zoom for camera-determinism tests. Default is OFF
  // so the existing fixtures (recorded without mobile zoom) stay valid.
  if (opts.mobileZoomEnabled) {
    runtime.camera.enableMobileZoom();
  }

  // ── Seed injection ────────────────────────────────────────────────
  // bootstrapNewGameFromSettings reads runtimeState.lobby.seed and
  // runtimeState.lobby.joined, so we wire them up directly — no need
  // to go through the lobby UI flow. All slots stay un-joined → all AI.
  // Hydrate lobby.map immediately so the warm-up tick (which dispatches to
  // the LOBBY tick → renderLobby) has a real map to render. In production
  // main.ts goes through showLobby() → refreshLobbySeed() to get this; we
  // short-circuit by calling generateMap directly. Skipping
  // this is invisible to the no-op stub renderer but crashes drawTerrain
  // when a real renderer is wired in via `opts.renderer`.
  runtime.runtimeState.settings.seed = String(seed);
  runtime.runtimeState.settings.seedMode = SEED_CUSTOM;
  // `settings.gameMode` is deliberately NOT written: the scenario's mode
  // rides the same `getUrlModeOverride` hook production uses, and the
  // stored-settings default must stay untouched by it (the ?mode= leak
  // test pins this).
  runtime.runtimeState.lobby.seed = seed;
  runtime.runtimeState.lobby.map = generateMap(new Rng(seed));

  // ── Sentinel warm-up ──────────────────────────────────────────────
  // `frameMeta` is initialized by `computeFrameContext` inside `mainLoop`.
  // startGame() indirectly touches frameMeta via resetUIState → render,
  // so we need one mainLoop tick (mode=LOBBY, state=sentinel but gated
  // by `isStateInstalled`) to hydrate frameMeta before calling startGame.
  setMode(runtime.runtimeState, Mode.LOBBY);
  runtime.runtimeState.lastTime = clock;
  // Advance clock by one full simulation tick (≈17ms at 60fps) so the
  // fixed-step accumulator produces at least 1 step, hydrating frameMeta
  // before startGame() touches it.
  clock += 17;
  runtime.mainLoop(clock);

  if (autoStartGame) {
    await runtime.lifecycle.startGame();
  } else {
    // Stay in lobby mode for tests that need to drive the lobby UI through
    // real input handlers. `lobby.active = true` is what `lobbyClick` and
    // `lobbyKeyJoin` gate on; the production browser path sets it via
    // `bootstrapNewGame` (runtime-bootstrap.ts:109). The joined array is
    // already initialized to all-false in `createRuntimeState`.
    runtime.runtimeState.lobby.active = true;
  }

  // Apply optional speed multiplier — must happen AFTER startGame because
  // startGame() calls resetAll() which resets speedMultiplier back to 1.
  if (speedMultiplier !== undefined) {
    runtime.runtimeState.speedMultiplier = speedMultiplier;
  }

  // ── Driver API ────────────────────────────────────────────────────
  function fireTimeouts(): void {
    for (const [handle, entry] of pendingTimeouts) {
      if (clock >= entry.fireAt) {
        pendingTimeouts.delete(handle);
        entry.callback();
      }
    }
  }

  /** Advance the mock clock and run one mainLoop frame. */
  function tick(dtMs = 16): void {
    clock += dtMs;
    fireTimeouts();
    runtime.mainLoop(clock);
  }

  /** Tick size for per-sim-tick stepping (ms). The accumulator converts
   *  this to exactly 1 sim tick per mainLoop call, so predicates are
   *  checked at sim-tick granularity regardless of the caller's dtMs. */
  const SIM_TICK_MS = Math.round(SIM_TICK_DT * 1000);

  function runUntil(predicate: () => boolean, opts?: RunOpts): void {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_RUNUNTIL_TIMEOUT_MS;
    const dtMs = opts?.dtMs ?? 16;
    const simTicksPerFrame = Math.max(1, Math.round(dtMs / SIM_TICK_MS));
    const frameCount = Math.ceil(timeoutMs / (simTicksPerFrame * SIM_TICK_MS));
    for (let frame = 0; frame < frameCount; frame++) {
      if (predicate()) return;
      for (let sub = 0; sub < simTicksPerFrame; sub++) {
        tick(SIM_TICK_MS);
        if (predicate()) return;
      }
    }
    throw new ScenarioTimeoutError(
      `runUntil predicate never fired within ${timeoutMs}ms ` +
        `(${frameCount * simTicksPerFrame} sim ticks)`,
      timeoutMs,
    );
  }

  function tickFrames(frames = 1, dtMs = 16): void {
    const simTicksPerFrame = Math.max(1, Math.round(dtMs / SIM_TICK_MS));
    for (let frame = 0; frame < frames; frame++) {
      for (let sub = 0; sub < simTicksPerFrame; sub++) {
        tick(SIM_TICK_MS);
      }
    }
  }

  function isStopped(): boolean {
    return (runtime.runtimeState.mode as Mode) === Mode.STOPPED;
  }

  function runGame(opts?: RunOpts): void {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_RUNGAME_TIMEOUT_MS;
    const dtMs = opts?.dtMs ?? 16;
    const simTicksPerFrame = Math.max(1, Math.round(dtMs / SIM_TICK_MS));
    const frameCount = Math.ceil(timeoutMs / (simTicksPerFrame * SIM_TICK_MS));
    for (let frame = 0; frame < frameCount; frame++) {
      if (isStopped()) return;
      for (let sub = 0; sub < simTicksPerFrame; sub++) {
        tick(SIM_TICK_MS);
        if (isStopped()) return;
      }
    }
    throw new ScenarioTimeoutError(
      `runGame: mode did not reach STOPPED within ${timeoutMs}ms ` +
        `(${frameCount * simTicksPerFrame} sim ticks)`,
      timeoutMs,
    );
  }

  async function deliverNetworkMessage(msg: ServerMessage): Promise<void> {
    // Snapshot the handler set so a handler that unsubscribes mid-delivery
    // doesn't perturb the iteration. Handlers run sequentially in
    // registration order to match the production WebSocket fan-out.
    const handlers = [...messageHandlers];
    for (const handler of handlers) {
      await handler(msg);
    }
  }

  function subscribeNetworkMessage(
    handler: (msg: ServerMessage) => void | Promise<void>,
  ): () => void {
    messageHandlers.add(handler);
    return () => {
      messageHandlers.delete(handler);
    };
  }

  return {
    runtime,
    timing,
    now: () => clock,
    runUntil,
    tick: tickFrames,
    // The inner `tick` IS the catch-up frame: one clock jump, one mainLoop.
    stall: (gapMs) => tick(gapMs),
    runGame,
    keyboardEventSource: keyboardEventSource as unknown as EventTarget,
    pointerEventTarget: renderer.eventTarget as unknown as EventTarget,
    deliverNetworkMessage,
    subscribeNetworkMessage,
  };
}

/** Re-install assisted-human controllers for `assistedSlots` after a
 *  checkpoint apply. `applyMidGameCheckpoint` rebuilds EVERY slot as pure-AI
 *  (the production watcher / host-migration contract), so the checkpoint
 *  phase-test path needs this second pass to put the assisted controller back
 *  — primed for the restored phase exactly as the pure-AI rebuild was. Reuses
 *  `rebuildControllersForPhase` so the priming (startBuildPhase / placeCannons
 *  / initBattleState) stays identical to the rehydrate path. */
export async function reinstallAssistedControllers(
  runtime: GameRuntime,
  assistedSlots: readonly ValidPlayerId[],
  send: (msg: GameMessage) => void,
): Promise<void> {
  const assistedSet = new Set<ValidPlayerId>(assistedSlots);
  const schedule = (action: ScheduledAction<GameState>) =>
    runtime.runtimeState.actionSchedule.schedule(action);
  runtime.runtimeState.controllers = await rebuildControllersForPhase(
    runtime.runtimeState.state,
    runtime.runtimeState.controllers,
    -1 as PlayerId, // sentinel: no "my" slot, so every slot is rebuilt
    {
      ensureLoaded: ensureAiModulesLoaded,
      rollPersonality: rollAiPersonality,
      create: (pid, strategyRng, personality) =>
        assistedSet.has(pid)
          ? constructAssistedController(
            pid,
            createDefaultAiDeps(strategyRng, personality),
            send,
            schedule,
            DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS,
            () => runtime.runtimeState.state.round,
            () => lockstepDebtTicks(runtime.runtimeState),
          )
          : createAiController(pid, strategyRng, personality),
    },
  );
}

/** Build a `ControllerFactory` that substitutes `AiAssistedHumanController`
 *  for the slots in `assistedSlots`, falling back to the default
 *  `createController` for everyone else. The senders bag wraps `send` (the
 *  same closure the runtime uses for `network.send`) with the appropriate
 *  protocol message types. Used at bootstrap so the assisted controller is
 *  the slot's controller from the very first phase init — no mid-game swap. */
function buildAssistedControllerFactory(
  assistedSlots: readonly ValidPlayerId[],
  send: (msg: GameMessage) => void,
  getSchedule: () => (action: ScheduledAction<GameState>) => void,
  safetyTicks: number,
  getRound: () => number,
  getDebtTicks: () => number,
): ControllerFactory {
  const assistedSet = new Set<ValidPlayerId>(assistedSlots);
  return async (
    slot,
    isAi,
    keys,
    sharedRng,
    privateSeed,
    personality,
    humanAimResolver,
  ) => {
    if (!isAi || !assistedSet.has(slot)) {
      const { createController } = await import(
        "../src/controllers/controller-factory.ts"
      );
      return createController(
        slot,
        isAi,
        keys,
        sharedRng,
        privateSeed,
        personality,
        humanAimResolver,
      );
    }
    if (privateSeed === undefined) {
      throw new Error("privateSeed required for assisted-human controller");
    }
    if (!personality) {
      throw new Error("personality required for assisted-human controller");
    }
    // Assisted-human animation runs only on the slot-owning peer, so we
    // construct a private RNG from the bootstrap-supplied per-slot seed.
    // Reusing the shared `state.rng` here would drift across peers — the
    // watcher installs a plain pure-AI factory for the same slot, so its
    // strategy.rng-side draws would land on state.rng while the host's
    // assisted-human draws would land on this private RNG.
    const privateRng = new Rng(privateSeed);
    return constructAssistedController(
      slot,
      createDefaultAiDeps(privateRng, personality),
      send,
      (action) => getSchedule()(action),
      safetyTicks,
      getRound,
      getDebtTicks,
    );
  };
}

/** Construct an `AiAssistedHumanController` from pre-built AI deps. Shared by
 *  the bootstrap factory (`buildAssistedControllerFactory`) and the post-
 *  checkpoint re-install (`reinstallAssistedControllers`). */
async function constructAssistedController(
  slot: ValidPlayerId,
  deps: ReturnType<typeof createDefaultAiDeps>,
  send: (msg: GameMessage) => void,
  schedule: (action: ScheduledAction<GameState>) => void,
  safetyTicks: number,
  getRound: () => number,
  getDebtTicks: () => number,
): Promise<PlayerController> {
  const { AiAssistedHumanController } = await import(
    "../src/controllers/controller-ai-assisted-human.ts"
  );
  return new AiAssistedHumanController(slot, {
    strategy: deps.strategy,
    brain: deps.brain,
    senders: {
      sendPiecePlaced: (payload) =>
        send({ type: MESSAGE.OPPONENT_PIECE_PLACED, ...payload }),
      sendCannonPlaced: (payload) =>
        send({ type: MESSAGE.OPPONENT_CANNON_PLACED, ...payload }),
      sendCannonFired: (msg) => send(msg),
      // `round` is stamped here at the wire boundary, mirroring the
      // production wrappers in src/runtime/composition.ts.
      sendUpgradePick: (choice, applyAt) =>
        send({
          type: MESSAGE.UPGRADE_PICK,
          playerId: slot,
          choice,
          applyAt,
          round: getRound(),
        }),
      sendLifeLostChoice: (choice, applyAt) =>
        send({
          type: MESSAGE.LIFE_LOST_CHOICE,
          playerId: slot,
          choice,
          applyAt,
          round: getRound(),
        }),
    },
    schedule,
    safetyTicks,
    // Mirrors the production wiring in src/online/runtime/game.ts: board
    // commits are quarantined while the peer replays banked lockstep debt;
    // dialog commits ride out with a debt-corrected stamp.
    isQuarantined: () => getDebtTicks() >= LOCKSTEP_QUARANTINE_DEBT_TICKS,
    stampDelayTicks: getDebtTicks,
  });
}

/** Build an `OnlinePhaseTicks` for headless host mode. Phase-checkpoint
 *  broadcasts are forwarded to `send` (matching production wiring in
 *  `online/runtime/game.ts`); other hooks are no-ops. No watcher fields
 *  are set — this is host-only. */
function buildHeadlessHostPhaseTicks(
  send: (msg: GameMessage) => void,
): OnlinePhaseTicks {
  return {
    broadcastCannonStart: () => send({ type: MESSAGE.CANNON_START }),
    broadcastBattleStart: () => send({ type: MESSAGE.BATTLE_START }),
    broadcastBuildStart: () => send({ type: MESSAGE.BUILD_START }),
    broadcastBuildEnd: () => send({ type: MESSAGE.BUILD_END }),
    broadcastLocalCrosshair: () => {},
    extendCrosshairs: (crosshairs) => [...crosshairs],
    tickMigrationAnnouncement: () => {},
  };
}

/** No-op renderer satisfying `RendererInterface` without canvas/DOM access.
 *
 *  The `eventTarget` is a real `EventTarget` so tests can drive the runtime
 *  through the production input handlers (`registerMouseHandlers`,
 *  `registerTouchHandlers`) by dispatching `MouseEvent` / `TouchEvent`
 *  instances at it. The default `clientToSurface` is the identity, so a test
 *  that dispatches a click at `(canvasX, canvasY)` lands on that exact tile
 *  — no letterbox/DPR math needed in headless. */
function createStubRenderer(): RendererInterface {
  const container = createStubElement();
  const eventTarget = createStubElement();
  return {
    drawFrame: (
      _map: GameMap,
      _overlay: RenderOverlay | undefined,
      _viewport: Viewport | null | undefined,
      _now: number,
    ) => {},
    warmMapCache: (_map: GameMap) => {},
    captureScene: () => undefined,
    captureSceneOffscreen: () => undefined,
    clientToSurface: (clientX: number, clientY: number) => ({
      x: clientX,
      y: clientY,
    }),
    screenToContainerCSS: (sx: number, sy: number) => ({ x: sx, y: sy }),
    eventTarget,
    container,
  };
}
