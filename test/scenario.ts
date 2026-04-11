/**
 * Scenario test API — the ONE primitive for writing tests.
 *
 * Three rules:
 *   1. Pick a seed.
 *   2. Run the game.
 *   3. Listen on the bus.
 *
 * That's it. There are no methods to mutate game state, no methods to
 * scripted-place pieces, no methods to skip phases. The AI plays the game
 * end-to-end, exactly as it would in a browser. Tests observe what happens
 * via `sc.bus.on(GAME_EVENT.X, …)` and assert on `sc.state` reads.
 *
 * If you find yourself wanting to mutate state to "set up a condition", the
 * answer is: search for a seed that produces that condition naturally
 * (`scripts/find-seed.ts`) and use it.
 *
 * Usage:
 *
 *     import { createScenario, waitForPhase } from "./scenario.ts";
 *     import { Phase } from "../src/shared/game-phase.ts";
 *     import { GAME_EVENT } from "../src/shared/game-event-bus.ts";
 *
 *     Deno.test("first battle reaches BATTLE phase", async () => {
 *       const sc = await createScenario({ seed: 42 });
 *       waitForPhase(sc, Phase.BATTLE);
 *     });
 *
 *     Deno.test("modifier banner carries tile diff", async () => {
 *       const sc = await createScenario({ seed: 7, mode: "modern" });
 *       const banner = waitForModifier(sc);
 *       assert(banner.changedTiles !== undefined);
 *     });
 */

// Side-effect import — installs DOM polyfills (KeyboardEvent, MouseEvent,
// HTMLInputElement, HTMLSelectElement) on globalThis before any input handler
// runs. Required so `registerKeyboardHandlers` can do `e.target instanceof
// HTMLInputElement` without throwing in Deno.
import "./test-globals.ts";
import { setSoundObserver } from "../src/input/sound-system.ts";
import { createCanvasRenderer } from "../src/render/render-canvas.ts";
import {
  setCanvasFactory,
  setRenderObserver,
} from "../src/render/render-map.ts";
import type { HapticsObserver } from "../src/shared/system-interfaces.ts";
import {
  createHeadlessRuntime,
  type HeadlessRuntime,
} from "./runtime-headless.ts";
import {
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
  type ModifierId,
} from "../src/shared/game-constants.ts";
import {
  GAME_EVENT,
  type GameEventBus,
  type GameEventMap,
} from "../src/shared/game-event-bus.ts";
import type { Phase } from "../src/shared/game-phase.ts";
import type { GameMessage, ServerMessage } from "../src/shared/protocol.ts";
import type { GameState } from "../src/shared/types.ts";
import type { Mode } from "../src/shared/ui-mode.ts";
import type { CanvasRecorder } from "./recording-canvas.ts";

export interface ScenarioOptions {
  /** Map seed — controls map, AI, and modifier rolls. Defaults to 42. */
  seed?: number;
  /** Game mode. Defaults to "classic". */
  mode?: "classic" | "modern";
  /** Number of rounds before the game ends. Defaults to 3. */
  rounds?: number;
  /** When true, runs the runtime in "online host" mode with no-op
   *  network broadcasts. Used by host-vs-local sync tests to verify that
   *  the online code path produces the same state as the local one. The
   *  runtime never receives any messages because there are no peers. */
  hostMode?: boolean;
  /** Initial dev speed multiplier (1..16, integer). Drives the sub-step
   *  loop in `mainLoop` — at speed=N, each tick advances the game by N
   *  normal-sized sub-steps instead of one inflated dt. Used by tests
   *  that exercise the speed mechanism. */
  speedMultiplier?: number;
  /** Canvas recorder. When provided, the scenario runs the *real* canvas
   *  renderer (instead of the no-op stub) wired to the recorder's mock
   *  canvases — every frame fires the full draw pipeline, and tests can
   *  observe via `setRenderObserver` (or inspect the recorder log directly).
   *  Use this when you need to assert on render-side invariants. */
  recorder?: CanvasRecorder;
  /** When false, leaves the runtime in lobby mode with `lobby.active = true`
   *  instead of auto-starting the game. Tests use this to drive the lobby
   *  through real input handlers (clicking a slot, joining via key). The
   *  game starts naturally once a slot is joined and the lobby timer
   *  expires. Defaults to true. */
  autoStartGame?: boolean;
  /** Test observer for haptics intents. Receives every `vibrate(reason, ms,
   *  minLevel)` call BEFORE the platform/level gate. Threaded through to
   *  `createHapticsSystem({ observer })` via the runtime's `observers` bag. */
  hapticsObserver?: HapticsObserver;
}

export interface Scenario extends Disposable {
  /** Game state — read for assertions, NEVER mutate. */
  readonly state: GameState;
  /** Typed event bus — `sc.bus.on(GAME_EVENT.X, handler)`. */
  readonly bus: GameEventBus;
  /** Outbound network messages this runtime would broadcast as host.
   *  Captures every `network.send` call in arrival order. Even local
   *  play hits the send wrappers — the underlying impl just no-ops on
   *  delivery. Tests assert on this to verify host fan-out payloads
   *  (checkpoints, action commands, watcher ticks) without spinning up
   *  a real WebSocket. */
  readonly sentMessages: readonly GameMessage[];
  /** Deliver a fake peer message to every handler the runtime
   *  registered via `network.onMessage`. Same dispatch path the
   *  production WebSocket fan-out uses — handlers run sequentially in
   *  registration order. Returns a promise that resolves once every
   *  handler has finished processing the message; tests should `await`
   *  it before asserting on game state.
   *
   *  Tests use this to drive the *receive* side of the network seam
   *  without spinning up a real peer: hand-craft a `CASTLE_WALLS` /
   *  `OPPONENT_CANNON_PLACED` / checkpoint message, deliver it, then
   *  observe how the runtime applies it. */
  deliverMessage(msg: ServerMessage): Promise<void>;
  /** Top-level UI mode (LOBBY, GAME, OPTIONS, STOPPED, ...). Lives on
   *  `runtimeState` rather than `state` because it gates which subsystems
   *  receive ticks. Tests use this to wait for lobby→game transitions. */
  readonly mode: () => Mode;
  /** Whether the lobby UI is currently active. False after the game has
   *  started or after returning to the menu. Convenience over `mode` for
   *  the common "have we left the lobby?" check. */
  readonly lobbyActive: () => boolean;
  /** Current simulated time (ms). */
  readonly now: () => number;
  /** Drive the game until `predicate` returns true. Returns the frame count
   *  taken, or -1 if the predicate never fired before `maxFrames`. Tests
   *  observe via the bus and assert on `state` reads — never advance the
   *  simulation manually frame-by-frame. */
  runUntil(
    predicate: () => boolean,
    maxFrames?: number,
    dtMs?: number,
  ): number;
  /** Drive the game until it ends (mode reaches STOPPED). */
  runGame(maxFrames?: number, dtMs?: number): void;
  /** Synthetic input — dispatches events at the same `EventTarget`s the
   *  production browser path uses (`document` for keys, the canvas element
   *  for mouse/touch). Tests use these to drive the runtime through the
   *  real input handlers, instead of mutating state or calling controller
   *  methods directly. */
  readonly input: ScenarioInput;
}

/** Synthetic input dispatcher backed by real `EventTarget`s. Each call
 *  constructs a fresh `KeyboardEvent` / `MouseEvent` and dispatches it at
 *  the same source the runtime registered listeners on. */
export interface ScenarioInput {
  /** Press a key. `key` matches `KeyboardEvent.key` ("Enter", "ArrowUp",
   *  "a", " ", etc.). Pair with `keyUp` if the handler tracks key state. */
  keyDown(
    key: string,
    init?: { code?: string; ctrlKey?: boolean; shiftKey?: boolean },
  ): void;
  /** Release a key. */
  keyUp(
    key: string,
    init?: { code?: string; ctrlKey?: boolean; shiftKey?: boolean },
  ): void;
  /** Press + release in one call. Use this for the common "tap a key" case;
   *  drop down to `keyDown`/`keyUp` only when timing matters. */
  pressKey(
    key: string,
    init?: { code?: string; ctrlKey?: boolean; shiftKey?: boolean },
  ): void;
  /** Move the mouse to a canvas-space coordinate. The headless renderer's
   *  `clientToSurface` is the identity, so `(x, y)` lands at exactly that
   *  surface coordinate — no letterbox/DPR math required. */
  mouseMove(x: number, y: number): void;
  /** Left-click at a canvas-space coordinate. */
  click(x: number, y: number, init?: { button?: number }): void;
  /** Right-click (context menu) at a canvas-space coordinate. */
  rightClick(x: number, y: number): void;
  /** Fire a `touchstart` event with the given finger positions. Each
   *  finger is `{x, y}` in canvas-space; the helper assigns sequential
   *  identifiers so multi-touch flows can be replayed deterministically. */
  touchStart(touches: readonly { x: number; y: number }[]): void;
  /** Fire a `touchmove` event with the current finger positions. */
  touchMove(touches: readonly { x: number; y: number }[]): void;
  /** Fire a `touchend` event. `touches` is the set of fingers still on
   *  screen (empty for the common single-finger lift case);
   *  `changedTouches` defaults to a single finger at the last position
   *  if omitted. */
  touchEnd(
    touches?: readonly { x: number; y: number }[],
    changedTouches?: readonly { x: number; y: number }[],
  ): void;
  /** Sugar for the common "single-finger tap at (x, y)" sequence —
   *  fires `touchstart` then `touchend` with the same coordinates. */
  tap(x: number, y: number): void;
}

export async function createScenario(
  opts: ScenarioOptions = {},
): Promise<Scenario> {
  // When a recorder is provided, install the canvas factory and build the
  // real renderer over the recorder's display canvas. Both module-level
  // setters reset on re-call, so multiple recorder-backed scenarios in the
  // same test file remain isolated.
  let renderer: ReturnType<typeof createCanvasRenderer> | undefined;
  const usedRecorder = opts.recorder !== undefined;
  if (opts.recorder) {
    setCanvasFactory(opts.recorder.factory);
    renderer = createCanvasRenderer(opts.recorder.displayCanvas);
  }
  // Capture every outbound `network.send` so the test can read it via
  // `sc.sentMessages`. The array is owned by `wrap` and exposed read-only.
  const sentMessages: GameMessage[] = [];
  const headless = await createHeadlessRuntime({
    seed: opts.seed ?? 42,
    gameMode: opts.mode === "modern" ? GAME_MODE_MODERN : GAME_MODE_CLASSIC,
    rounds: opts.rounds ?? 3,
    hostMode: opts.hostMode ?? false,
    renderer,
    speedMultiplier: opts.speedMultiplier,
    autoStartGame: opts.autoStartGame ?? true,
    networkSendObserver: (msg) => sentMessages.push(msg),
    hapticsObserver: opts.hapticsObserver,
  });
  return wrapHeadless(headless, usedRecorder, sentMessages);
}

/** Build a `Scenario` over an existing `HeadlessRuntime`. Exported so the
 *  online-loopback wrapper (`test/online-headless.ts`) can construct its own
 *  headless first, plug the production `handleServerMessage` dispatcher into
 *  the receive seam, then hand the result back to tests with the same shape
 *  `createScenario` returns. */
export function wrapHeadless(
  headless: HeadlessRuntime,
  usedRecorder: boolean,
  sentMessages: readonly GameMessage[],
): Scenario {
  const input = createScenarioInput(headless);
  return {
    get state() {
      return headless.runtime.runtimeState.state;
    },
    get bus() {
      return headless.runtime.runtimeState.state.bus;
    },
    sentMessages,
    deliverMessage: headless.deliverNetworkMessage,
    mode: () => headless.runtime.runtimeState.mode,
    lobbyActive: () => headless.runtime.runtimeState.lobby.active,
    now: headless.now,
    runUntil: headless.runUntil,
    runGame: headless.runGame,
    input,
    [Symbol.dispose]: () => {
      // When the test installed a recorder, restore module-level render
      // state so a follow-on test in the same file isn't poisoned by stale
      // canvases or a leftover observer. The default factory's body only
      // dereferences `document` when invoked, so it stays safe to install
      // even from deno — non-recorder scenarios use the no-op stub renderer
      // and never call the factory at all.
      if (usedRecorder) {
        setCanvasFactory(() => document.createElement("canvas"));
        setRenderObserver(undefined);
      }
      // Always clear the sound observer on dispose, even when no test
      // installed one — module-level state must not leak between scenarios.
      setSoundObserver(undefined);
    },
  };
}

// ─── Synthetic input ───────────────────────────────────────────────
// Constructs DOM-shaped events (using the polyfilled `KeyboardEvent` /
// `MouseEvent` from `test-globals.ts`) and dispatches them at the same
// `EventTarget` instances the runtime registered listeners on. This is
// the production code path — `registerKeyboardHandlers`,
// `registerMouseHandlers`, and `registerTouchHandlers` from `src/input/`
// run unmodified.

function createScenarioInput(headless: HeadlessRuntime): ScenarioInput {
  const { keyboardEventSource, pointerEventTarget } = headless;

  function dispatchKey(
    type: "keydown" | "keyup",
    key: string,
    init?: { code?: string; ctrlKey?: boolean; shiftKey?: boolean },
  ): void {
    const event = new KeyboardEvent(type, {
      key,
      code: init?.code,
      ctrlKey: init?.ctrlKey,
      shiftKey: init?.shiftKey,
    });
    keyboardEventSource.dispatchEvent(event);
  }

  function dispatchMouse(
    type: "mousemove" | "click" | "contextmenu",
    x: number,
    y: number,
    init?: { button?: number },
  ): void {
    const event = new MouseEvent(type, {
      clientX: x,
      clientY: y,
      button: init?.button ?? 0,
    });
    pointerEventTarget.dispatchEvent(event);
  }

  function makeTouchList(
    points: readonly { x: number; y: number }[],
  ): Touch[] {
    return points.map(
      (point, i) =>
        new Touch({
          identifier: i,
          clientX: point.x,
          clientY: point.y,
          target: pointerEventTarget,
        }),
    );
  }

  function dispatchTouch(
    type: "touchstart" | "touchmove" | "touchend",
    touches: readonly { x: number; y: number }[],
    changedTouches?: readonly { x: number; y: number }[],
  ): void {
    const event = new TouchEvent(type, {
      touches: makeTouchList(touches),
      changedTouches: changedTouches
        ? makeTouchList(changedTouches)
        : makeTouchList(touches),
    });
    pointerEventTarget.dispatchEvent(event);
  }

  return {
    keyDown: (key, init) => dispatchKey("keydown", key, init),
    keyUp: (key, init) => dispatchKey("keyup", key, init),
    pressKey: (key, init) => {
      dispatchKey("keydown", key, init);
      dispatchKey("keyup", key, init);
    },
    mouseMove: (x, y) => dispatchMouse("mousemove", x, y),
    click: (x, y, init) => dispatchMouse("click", x, y, init),
    rightClick: (x, y) => dispatchMouse("contextmenu", x, y),
    touchStart: (touches) => dispatchTouch("touchstart", touches),
    touchMove: (touches) => dispatchTouch("touchmove", touches),
    touchEnd: (touches = [], changedTouches) =>
      // Default `changedTouches` to a single finger at (0,0) when both
      // arrays are empty — covers the "all fingers lifted" case where
      // production touchend events still carry the lifted finger in
      // `changedTouches`. Tests that lift from a specific position can
      // pass `changedTouches: [{x, y}]` explicitly.
      dispatchTouch(
        "touchend",
        touches,
        changedTouches ?? (touches.length === 0 ? [{ x: 0, y: 0 }] : touches),
      ),
    tap: (x, y) => {
      dispatchTouch("touchstart", [{ x, y }]);
      dispatchTouch("touchend", [], [{ x, y }]);
    },
  };
}

// ─── Wait helpers ──────────────────────────────────────────────────
// Sync wrappers around `runUntil` that capture an event payload along
// the way. Throw on timeout so test failures point at the missing event,
// not at a downstream assertion.

const DEFAULT_MAX_TICKS = 5000;

/** Tick until a `phaseStart` event for `phase` fires. Returns the event. */
export function waitForPhase(
  sc: Scenario,
  phase: Phase,
  maxTicks = DEFAULT_MAX_TICKS,
): GameEventMap["phaseStart"] {
  let captured: GameEventMap["phaseStart"] | null = null;
  const handler = (ev: GameEventMap["phaseStart"]) => {
    if (ev.phase === phase && captured === null) captured = ev;
  };
  sc.bus.on(GAME_EVENT.PHASE_START, handler);
  try {
    sc.runUntil(() => captured !== null, maxTicks);
  } finally {
    sc.bus.off(GAME_EVENT.PHASE_START, handler);
  }
  if (captured === null) {
    throw new Error(
      `waitForPhase(${phase}) timed out after ${maxTicks} ticks`,
    );
  }
  return captured;
}

/** Tick until a `bannerStart` event matching `predicate` fires. */
export function waitForBanner(
  sc: Scenario,
  predicate: (ev: GameEventMap["bannerStart"]) => boolean,
  maxTicks = DEFAULT_MAX_TICKS,
): GameEventMap["bannerStart"] {
  let captured: GameEventMap["bannerStart"] | null = null;
  const handler = (ev: GameEventMap["bannerStart"]) => {
    if (captured === null && predicate(ev)) captured = ev;
  };
  sc.bus.on(GAME_EVENT.BANNER_START, handler);
  try {
    sc.runUntil(() => captured !== null, maxTicks);
  } finally {
    sc.bus.off(GAME_EVENT.BANNER_START, handler);
  }
  if (captured === null) {
    throw new Error(`waitForBanner timed out after ${maxTicks} ticks`);
  }
  return captured;
}

/** Tick until a `roundStart` event for `round` fires. Useful for skipping
 *  through opening rounds when a test needs a condition that only appears
 *  in later rounds (e.g. environmental modifiers from round 3 onwards). */
export function waitUntilRound(
  sc: Scenario,
  round: number,
  maxTicks = DEFAULT_MAX_TICKS,
): GameEventMap["roundStart"] {
  let captured: GameEventMap["roundStart"] | null = null;
  const handler = (ev: GameEventMap["roundStart"]) => {
    if (ev.round >= round && captured === null) captured = ev;
  };
  sc.bus.on(GAME_EVENT.ROUND_START, handler);
  try {
    sc.runUntil(() => captured !== null, maxTicks);
  } finally {
    sc.bus.off(GAME_EVENT.ROUND_START, handler);
  }
  if (captured === null) {
    throw new Error(
      `waitUntilRound(${round}) timed out after ${maxTicks} ticks`,
    );
  }
  return captured;
}

/** Tick until a modifier banner fires. Filter by `modifierId` if provided. */
export function waitForModifier(
  sc: Scenario,
  modifierId?: ModifierId,
  maxTicks = DEFAULT_MAX_TICKS,
): GameEventMap["bannerStart"] {
  return waitForBanner(
    sc,
    (ev) =>
      ev.modifierId !== undefined &&
      (modifierId === undefined || ev.modifierId === modifierId),
    maxTicks,
  );
}

// ─── Determinism recording ─────────────────────────────────────────
// `recordEvents` subscribes to ALL bus events and returns an append-only
// log. The log is a deterministic projection of "what happened in this run":
// if the runtime is deterministic, replaying the same scenario with the
// same seed must produce a byte-identical log.
//
// Used by:
//   - scripts/record-determinism.ts to write fixtures to disk
//   - test/determinism.test.ts to verify replay matches the saved fixture

export interface RecordedEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

/** Subscribe to every bus event and accumulate them in order.
 *  Call BEFORE driving the runtime so no events are missed. */
export function recordEvents(sc: Scenario): RecordedEvent[] {
  const events: RecordedEvent[] = [];
  sc.bus.onAny((type, ev) => {
    events.push(normalizeEvent(type as string, ev));
  });
  return events;
}

function normalizeEvent(type: string, ev: unknown): RecordedEvent {
  const record = ev as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  // Sort keys for stable JSON output. Drop `type` (it's the parent key)
  // and `undefined` values (JSON.stringify drops them, so the saved fixture
  // wouldn't match a live replay otherwise).
  for (const key of Object.keys(record).sort()) {
    if (key === "type") continue;
    if (record[key] === undefined) continue;
    payload[key] = record[key];
  }
  return { type, payload };
}
