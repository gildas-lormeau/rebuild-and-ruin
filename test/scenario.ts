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
 *     import { Phase } from "../src/shared/core/game-phase.ts";
 *     import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
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
import { createCanvasRenderer } from "../src/render/render-canvas.ts";
import type { RenderObserver } from "../src/shared/ui/overlay-types.ts";
import type {
  HapticsObserver,
  SoundObserver,
} from "../src/shared/core/system-interfaces.ts";
import {
  createHeadlessRuntime,
  type HeadlessRuntime,
} from "./runtime-headless.ts";
import {
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
  type ModifierId,
} from "../src/shared/core/game-constants.ts";
import {
  GAME_EVENT,
  type GameEventBus,
  type GameEventMap,
} from "../src/shared/core/game-event-bus.ts";
import type { Phase } from "../src/shared/core/game-phase.ts";
import type { GameMessage, ServerMessage } from "../src/protocol/protocol.ts";
import type { ValidPlayerSlot } from "../src/shared/core/player-slot.ts";
import type { BannerState } from "../src/runtime/runtime-contracts.ts";
import type { DialogRuntimeState } from "../src/runtime/runtime-state.ts";
import type { GameState } from "../src/shared/core/types.ts";
import type { Mode } from "../src/shared/ui/ui-mode.ts";
import {
  createAsciiRenderer,
  type AsciiRenderer,
  type AsciiRendererInternal,
} from "./ascii-renderer.ts";
import type { CanvasRecorder } from "./recording-canvas.ts";
import SEED_FIXTURES from "./seed-fixtures.json" with { type: "json" };
import { SEED_CONDITIONS } from "./seed-conditions.ts";

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
  /** Test observer for sound intents. Receives every `played(reason)` call
   *  BEFORE the platform/level gate. Threaded through to
   *  `createSoundSystem({ observer })` via the runtime's `observers` bag. */
  soundObserver?: SoundObserver;
  /** Renderer override. Omit for the default no-op stub.
   *  - `"ascii"` — text-based renderer via `buildGrid`; access the handle
   *    on the returned `Scenario.renderer`.
   *  - `{ canvas: CanvasRecorder, observer? }` — real canvas renderer wired
   *    to the recorder's mock canvases. */
  renderer?:
    | "ascii"
    | { canvas: CanvasRecorder; observer?: RenderObserver };
  /** When `"host"`, wires the production `handleServerMessage` dispatcher
   *  so `deliverMessage()` routes through the real receive path. Forces
   *  `hostMode: true`. Replaces the separate `createOnlineHarness` API. */
  online?: "host";
  /** Slots to treat as remote-controlled when `online: "host"` is set.
   *  Ignored when `online` is not set. Defaults to `{1}`. */
  remotePlayerSlots?: ReadonlySet<ValidPlayerSlot>;
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
  /** Current phase-transition banner state. Lives on `runtimeState`, not
   *  `state`, so tests that need to observe banner progress frame-by-frame
   *  (e.g. progressive reveal tests) reach it through this accessor. The
   *  returned object is the live banner — read fields inside a `runUntil`
   *  predicate or right after a `runUntil` call, never hold a reference
   *  across frames. Never mutate. */
  readonly banner: () => Readonly<BannerState>;
  /** Current dialog runtime state (life-lost, upgrade-pick, etc.). Lives
   *  on `runtimeState`, same caveats as `banner()` — live reference, never
   *  mutate. Tests use this to observe whether the upgrade-pick overlay is
   *  still active during a phase transition. */
  readonly dialogs: () => Readonly<DialogRuntimeState>;
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
  /** ASCII renderer handle — only present when `renderer: true` was passed
   *  to `createScenario`. Provides `frames`, `lastFrame`, and `snapshot()`. */
  readonly renderer?: AsciiRenderer;
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

export interface RecordedEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

const DEFAULT_MAX_TICKS = 5000;

/** Boot a scenario for a registered seed condition. Looks up the cached
 *  seed in `test/seed-fixtures.json` and uses the condition's declared
 *  `mode` + `rounds`. Throws if the condition isn't registered or the
 *  fixture is missing — run `npm run record-seeds` to regenerate.
 *
 *  Tests use this instead of hardcoding seeds so that RNG-drift recovery
 *  is a single command (`record-seeds`) instead of per-test rehunting. */
export function loadSeed(
  name: string,
  overrides?: Partial<
    Pick<
      ScenarioOptions,
      | "rounds"
      | "renderer"
      | "hapticsObserver"
      | "soundObserver"
    >
  >,
): Promise<Scenario> {
  const condition = SEED_CONDITIONS[name];
  if (!condition) {
    throw new Error(
      `loadSeed: unknown condition "${name}". Add it to test/seed-conditions.ts.`,
    );
  }
  const seed = (SEED_FIXTURES as Record<string, number>)[name];
  if (seed === undefined) {
    throw new Error(
      `loadSeed: no fixture entry for "${name}". Run \`npm run record-seeds\` to populate test/seed-fixtures.json.`,
    );
  }
  return createScenario({
    seed,
    mode: condition.mode,
    rounds: overrides?.rounds ?? condition.rounds,
    renderer: overrides?.renderer,
    hapticsObserver: overrides?.hapticsObserver,
    soundObserver: overrides?.soundObserver,
  });
}

export async function createScenario(
  opts: ScenarioOptions = {},
): Promise<Scenario> {
  // Online host mode — delegate to createOnlineHarness (lazy-imported to
  // avoid pulling the DOM shim into every test that doesn't need it).
  if (opts.online === "host") {
    const { createOnlineHarness } = await import("./online-headless.ts");
    const harness = await createOnlineHarness({
      ...opts,
      remotePlayerSlots: opts.remotePlayerSlots,
    });
    return harness.scenario;
  }

  const sentMessages: GameMessage[] = [];
  const ascii =
    opts.renderer === "ascii" ? createAsciiRenderer() : undefined;
  const headless = await createHeadlessRuntime(
    buildHeadlessOptions(opts, sentMessages, ascii),
  );
  if (ascii) {
    ascii.bind(() => headless.runtime.runtimeState.state);
  }
  const scenario = wrapHeadless(headless, sentMessages);
  if (ascii) {
    (scenario as { renderer: AsciiRenderer }).renderer = ascii;
  }
  return scenario;
}

/** Translate `ScenarioOptions` into the matching `createHeadlessRuntime`
 *  options bag. Exported so the online-loopback wrapper
 *  (`test/online-headless.ts`) can apply the exact same wiring rules
 *  before forcing its host-mode-specific overrides. */
export function buildHeadlessOptions(
  opts: ScenarioOptions,
  sentMessages: GameMessage[],
  asciiRenderer?: AsciiRendererInternal,
): Parameters<typeof createHeadlessRuntime>[0] {
  let renderer: Parameters<typeof createHeadlessRuntime>[0]["renderer"];
  if (asciiRenderer) {
    renderer = asciiRenderer;
  } else if (typeof opts.renderer === "object") {
    const rec = opts.renderer;
    renderer = createCanvasRenderer(rec.canvas.displayCanvas, {
      canvasFactory: rec.canvas.factory,
      observer: rec.observer,
    });
  }
  return {
    seed: opts.seed ?? 42,
    gameMode: opts.mode === "modern" ? GAME_MODE_MODERN : GAME_MODE_CLASSIC,
    rounds: opts.rounds ?? 3,
    hostMode: opts.hostMode ?? false,
    renderer,
    speedMultiplier: opts.speedMultiplier,
    autoStartGame: opts.autoStartGame ?? true,
    networkObserver: { sent: (msg) => sentMessages.push(msg) },
    hapticsObserver: opts.hapticsObserver,
    soundObserver: opts.soundObserver,
  };
}

/** Build a `Scenario` over an existing `HeadlessRuntime`. Exported so the
 *  online-loopback wrapper (`test/online-headless.ts`) can construct its own
 *  headless first, plug the production `handleServerMessage` dispatcher into
 *  the receive seam, then hand the result back to tests with the same shape
 *  `createScenario` returns. */
export function wrapHeadless(
  headless: HeadlessRuntime,
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
    banner: () => headless.runtime.runtimeState.banner,
    dialogs: () => headless.runtime.runtimeState.dialogs,
    now: headless.now,
    runUntil: headless.runUntil,
    runGame: headless.runGame,
    input,
    [Symbol.dispose]: () => {
      // No cleanup is performed for the *observers* this Scenario installed:
      // every haptics / sound / render observer is closure-scoped to the
      // sub-system constructed for this runtime, so a follow-on test
      // naturally starts with a fresh slate. Same for the canvas factory and
      // terrain cache (per `createRenderMap` instance).
      //
      // Module state we DO NOT clean up — and intentionally so:
      //   - `lastTouchTime` in `src/input/input-dispatch.ts` (a single number,
      //     seeded to -Infinity, no cross-test interference).
      //   - `online-runtime-deps.ts:initDeps` reassigns module-level
      //     dispatcher state on every call. Sequential
      //     `createOnlineHarness` calls overwrite each other's wiring
      //     cleanly, but parallel test execution would race — see
      //     test/online-headless.ts header for the details.
      //   - The duplicate-literals baseline + jscpd state is also module-
      //     level but only relevant to lint, not runtime tests.
    },
  };
}

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

/** Subscribe to every bus event and accumulate them in order.
 *  Call BEFORE driving the runtime so no events are missed. */
export function recordEvents(sc: Scenario): RecordedEvent[] {
  const events: RecordedEvent[] = [];
  sc.bus.onAny((type, ev) => {
    events.push(normalizeEvent(type as string, ev));
  });
  return events;
}

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
