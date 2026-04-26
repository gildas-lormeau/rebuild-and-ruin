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
import { SCALE, TILE_SIZE } from "../src/shared/core/grid.ts";
import type { RenderObserver } from "../src/shared/ui/overlay-types.ts";
import type {
  HapticsObserver,
} from "../src/shared/core/system-interfaces.ts";
import {
  createHeadlessRuntime,
  DEFAULT_RUNUNTIL_TIMEOUT_MS,
  type HeadlessRuntime,
  type RunOpts,
  ScenarioTimeoutError,
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
import type { GameState } from "../src/shared/core/types.ts";
import type { Mode } from "../src/shared/ui/ui-mode.ts";
import {
  createAsciiRenderer,
  type AsciiRenderer,
  type AsciiRendererInternal,
} from "./ascii-renderer.ts";
import {
  inspectTile,
  type TileInspection,
} from "../src/runtime/dev-console-grid.ts";
import type { CanvasRecorder } from "./recording-canvas.ts";
import SEED_FIXTURES from "./seed-fixtures.json" with { type: "json" };
import { SEED_CONDITIONS } from "./seed-conditions.ts";

export {
  DEFAULT_RUNGAME_TIMEOUT_MS,
  DEFAULT_RUNUNTIL_TIMEOUT_MS,
  type RunOpts,
  ScenarioTimeoutError,
} from "./runtime-headless.ts";

export interface ScenarioOptions {
  /** Map seed — controls map, AI, and modifier rolls. Defaults to 42. */
  seed?: number;
  /** Game mode. Defaults to "classic". */
  mode?: "classic" | "modern";
  /** Number of rounds before the game ends. Defaults to 3. */
  rounds?: number;
  /** When true, runs the runtime in "online host" mode with no-op
   *  network broadcasts. The runtime takes the online code path (wires
   *  OnlinePhaseTicks) but all broadcasts go to `sc.sentMessages` with
   *  no peer on the other end. Tests use this to assert on outbound
   *  wire messages without a second runtime. Mutually exclusive with
   *  `online`. */
  hostMode?: boolean;
  /** Online role — mirrors the E2E API's `online: "host" | "join"`.
   *  - `"host"` — full host with real broadcast emitters (CANNON_START /
   *    BATTLE_START / BUILD_START / BUILD_END + per-action). Outbound
   *    messages land in `sc.sentMessages`.
   *  - `"watcher"` — pure watcher. `session.isHost = false`, every slot
   *    remote (no local AI), `tickWatcher` wired, production
   *    `handleServerMessage` dispatcher subscribed to the receive channel.
   *    Messages arrive via `sc.deliverMessage(msg)`.
   *  Pair them via `createNetworkedPair({ ... })` in `network-setup.ts`
   *  when you need a full two-runtime loopback. */
  online?: "host" | "watcher";
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
   *  `createHapticsSubsystem({ observer })` via the runtime's `observers` bag. */
  hapticsObserver?: HapticsObserver;
  /** Test observer for sound intents. Receives every `played(reason)` call
   *  BEFORE the platform/level gate. */
  renderer?:
    | "ascii"
    | { canvas: CanvasRecorder; observer?: RenderObserver };
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
  /** Current simulated time (ms). */
  readonly now: () => number;
  /** Drive the game until `predicate` returns true. Throws
   *  `ScenarioTimeoutError` if the predicate never fires within
   *  `opts.timeoutMs` (sim-ms, matching the E2E mirror's unit).
   *  Use `tick(N)` for the "just run N frames" case — that's the
   *  frame-denominated tool; this one is budget-denominated. */
  runUntil(predicate: () => boolean, opts?: RunOpts): void;
  /** Advance the simulation by a fixed number of frames without checking
   *  any predicate. Use this instead of `runUntil(() => false, N)` —
   *  frame-precision tool, unaffected by the `runUntil` budget shape. */
  tick(frames?: number, dtMs?: number): void;
  /** Drive the game until it ends (mode reaches STOPPED). Throws
   *  `ScenarioTimeoutError` on timeout. Default budget is 120_000ms. */
  runGame(opts?: RunOpts): void;
  /** Synthetic input — dispatches events at the same `EventTarget`s the
   *  production browser path uses (`document` for keys, the canvas element
   *  for mouse/touch). Tests use these to drive the runtime through the
   *  real input handlers, instead of mutating state or calling controller
   *  methods directly. */
  readonly input: ScenarioInput;
  /** ASCII renderer handle — only present when `renderer: true` was passed
   *  to `createScenario`. Provides `frames`, `lastFrame`, and `snapshot()`. */
  readonly renderer?: AsciiRenderer;
  /** Structured read of everything at a single tile — terrain, wall,
   *  tower, cannon, grunt, burning pit, interior ownership, zone.
   *  On-demand debug primitive: cheaper than rendering the whole ASCII
   *  grid and counting characters to assert on a specific tile. */
  tileAt(row: number, col: number): TileInspection;
  /** Read-only camera handle. Exposes just the observational methods
   *  tests need (zoom target, pitch, viewport, auto-zoom flag) —
   *  mutation would break the "tests play the game" contract. Mainly
   *  useful for reset/quit tests that verify auto-zoom state and for
   *  multi-phase tests that check zoom lerping.
   *  Also exposes `enableMobileZoom` so tests can simulate the
   *  touch-controls-setup path without wiring the full DOM; everything
   *  else here is read-only. */
  readonly camera: {
    getCameraZone: () => number | undefined;
    getPitch: () => number;
    getPitchState: () => "flat" | "tilting" | "tilted" | "untilting";
    getViewport: () => import("../src/shared/core/geometry-types.ts").Viewport | undefined;
    isMobileAutoZoom: () => boolean;
    /** Mobile/touch wiring would normally call this from
     *  `setupTouchControls`. Tests that want to exercise auto-zoom
     *  behaviour call it directly after `createScenario`. */
    enableMobileZoom: () => void;
  };
  /** Replace the controller at `playerId` with an `AiAssistedHumanController`
   *  — AI drives gameplay but every placement/fire flows through the same
   *  `network.send` pathway humans use, producing wire messages on
   *  `sentMessages`. Useful for protocol fuzzing tests.
   *
   *  Call AFTER `createScenario` returns (controllers must exist). The helper
   *  re-invokes the phase-init hook for the new controller so mid-phase
   *  installs don't lose state. Currently supports install during
   *  `CASTLE_SELECT`; throws otherwise (keeps scope tight for v1). */
  installAssistedController(
    playerId: ValidPlayerSlot,
    opts?: { strategySeed?: number },
  ): Promise<void>;
  /** Start a fresh game on the same runtime — production-equivalent to the
   *  rematch button on the game-over screen. Installs a new `state` (with
   *  a new `state.bus`) via `bootstrapGame`, which in turn re-runs the
   *  `onStateReady` hook (e.g. rebinds sound / haptics / stats observers
   *  to the new bus). Use for multi-game tests. Calling this throws away
   *  `sc.state` identity — re-read `sc.state` after `await sc.rematch()`. */
  rematch(): Promise<void>;
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
  /** Move the mouse to the centre of a game tile (row, col). Preferred
   *  over `mouseMove` for gameplay assertions — tile coords are stable
   *  across headless/E2E and don't depend on camera/letterbox math. */
  hoverTile(row: number, col: number): void;
  /** Left-click at the centre of a tile. */
  clickTile(row: number, col: number): void;
  /** Single-finger tap at the centre of a tile. */
  tapTile(row: number, col: number): void;
}

export interface RecordedEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

/** Default budget for wait helpers — matches the E2E mirror's default
 *  so agents don't mix up units when copying test code between APIs. */
const DEFAULT_WAIT_TIMEOUT_MS = DEFAULT_RUNUNTIL_TIMEOUT_MS;
/** Bus events that are purely cosmetic (sound, animation cues) and must
 *  be excluded from determinism replay. The picks driving them use
 *  `Math.random()` (e.g. whistle variant), not `state.rng`, so the
 *  game-logic event log stays reproducible. */
const COSMETIC_EVENT_TYPES = new Set<string>(["cannonballDescending"]);

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
    hapticsObserver: overrides?.hapticsObserver
  });
}

export async function createScenario(
  opts: ScenarioOptions = {},
): Promise<Scenario> {
  // Online modes delegate to the network setup module so this core factory
  // stays free of the online/ import (and its DOM shim) when tests don't
  // need it.
  if (opts.online === "host" || opts.online === "watcher") {
    const { createOnlineScenario } = await import("./network-setup.ts");
    return createOnlineScenario(opts);
  }
  const sentMessages: GameMessage[] = [];
  const ascii =
    opts.renderer === "ascii" ? createAsciiRenderer() : undefined;
  const headless = await createHeadlessRuntime(
    buildHeadlessOptions(opts, sentMessages, ascii),
  );
  // Lobby-only scenarios start before bootstrap, so `state` is still null
  // until a slot joins. Tag once it exists; safe to skip when it doesn't.
  if (headless.runtime.runtimeState.state) {
    headless.runtime.runtimeState.state.debugTag = "LOCAL";
  }
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
 *  options bag. */
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
  };
}

/** Build a `Scenario` over an existing `HeadlessRuntime`. */
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
    now: headless.now,
    runUntil: headless.runUntil,
    tick: headless.tick,
    runGame: headless.runGame,
    input,
    tileAt: (row, col) =>
      inspectTile(headless.runtime.runtimeState.state, row, col),
    camera: {
      getCameraZone: headless.runtime.camera.getCameraZone,
      getPitch: headless.runtime.camera.getPitch,
      getPitchState: headless.runtime.camera.getPitchState,
      getViewport: headless.runtime.camera.getViewport,
      isMobileAutoZoom: headless.runtime.camera.isMobileAutoZoom,
      enableMobileZoom: headless.runtime.camera.enableMobileZoom,
    },
    rematch: async () => {
      await headless.runtime.lifecycle.rematch();
    },
    installAssistedController: async (playerId, opts) => {
      const { AiAssistedHumanController } = await import(
        "../src/controllers/controller-ai-assisted-human.ts"
      );
      const { AiController } = await import(
        "../src/controllers/controller-ai.ts"
      );
      const { DefaultStrategy } = await import("../src/ai/ai-strategy.ts");
      const { Phase } = await import("../src/shared/core/game-phase.ts");
      const { MESSAGE } = await import("../src/protocol/protocol.ts");
      const { createCannonFiredMsg } = await import(
        "../src/shared/core/battle-events.ts"
      );
      const { runtimeState } = headless.runtime;
      const state = runtimeState.state;
      const send = headless.runtime.networkSend;
      // Inherit the existing AI controller's strategy so the swap is
      // deterministic across runs — it was seeded from state.rng during
      // bootstrap and has already consumed RNG for the initial selection
      // tick. An explicit `strategySeed` override wins for tests that want
      // a different strategy.
      const existing = runtimeState.controllers[playerId];
      const strategy =
        opts?.strategySeed !== undefined
          ? new DefaultStrategy(undefined, opts.strategySeed)
          : existing instanceof AiController
            ? existing.strategy
            : new DefaultStrategy();
      const ctrl = new AiAssistedHumanController(playerId, {
        strategy,
        senders: {
          sendPiecePlaced: (payload) =>
            send({ type: MESSAGE.OPPONENT_PIECE_PLACED, ...payload }),
          sendCannonPlaced: (payload) =>
            send({ type: MESSAGE.OPPONENT_CANNON_PLACED, ...payload }),
          sendCannonFired: (ball) => send(createCannonFiredMsg(ball)),
          sendUpgradePick: (choice) =>
            send({ type: MESSAGE.UPGRADE_PICK, playerId, choice }),
          sendLifeLostChoice: (choice) =>
            send({ type: MESSAGE.LIFE_LOST_CHOICE, playerId, choice }),
        },
      });
      runtimeState.controllers[playerId] = ctrl;
      // Re-run phase init so the swapped-in controller picks up where the
      // replaced one left off. v1 only supports CASTLE_SELECT to keep the
      // contract narrow; expand as real tests need other phases.
      if (state.phase === Phase.CASTLE_SELECT) {
        const zone = state.playerZones[playerId] ?? 0;
        ctrl.selectInitialTower(state, zone);
      } else {
        throw new Error(
          `installAssistedController: install during phase ${state.phase} is not supported yet`,
        );
      }
    },
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
      //   - The duplicate-literals baseline + jscpd state is also module-
      //     level but only relevant to lint, not runtime tests.
    },
  };
}

/** Tick until a `phaseStart` event for `phase` fires. */
export function waitForPhase(
  sc: Scenario,
  phase: Phase,
  opts?: { timeoutMs?: number },
): GameEventMap["phaseStart"] {
  return waitForEvent(sc, GAME_EVENT.PHASE_START, (ev) => ev.phase === phase, {
    ...opts,
    label: `waitForPhase(${phase})`,
  });
}

/** Tick until a `roundStart` event for `round` fires. Useful for skipping
 *  through opening rounds when a test needs a condition that only appears
 *  in later rounds (e.g. environmental modifiers from round 3 onwards). */
export function waitUntilRound(
  sc: Scenario,
  round: number,
  opts?: { timeoutMs?: number },
): GameEventMap["roundStart"] {
  return waitForEvent(sc, GAME_EVENT.ROUND_START, (ev) => ev.round >= round, {
    ...opts,
    label: `waitUntilRound(${round})`,
  });
}

/** Tick until a modifier is applied. Filter by `modifierId` if provided.
 *  Listens to the domain event (`MODIFIER_APPLIED`), not the UI banner — a
 *  modifier is a gameplay concept; its reveal banner is a downstream UI
 *  concern that tests shouldn't couple to. */
export function waitForModifier(
  sc: Scenario,
  modifierId?: ModifierId,
  opts?: { timeoutMs?: number },
): GameEventMap["modifierApplied"] {
  return waitForEvent(
    sc,
    GAME_EVENT.MODIFIER_APPLIED,
    (ev) => modifierId === undefined || ev.modifierId === modifierId,
    { ...opts, label: "waitForModifier" },
  );
}

/** Tick until a `bannerStart` event matching `predicate` fires. */
export function waitForBanner(
  sc: Scenario,
  predicate: (ev: GameEventMap["bannerStart"]) => boolean,
  opts?: { timeoutMs?: number },
): GameEventMap["bannerStart"] {
  return waitForEvent(sc, GAME_EVENT.BANNER_START, predicate, {
    ...opts,
    label: "waitForBanner",
  });
}

/** Generic "drive the game until an event matching `predicate` fires"
 *  helper. All three specific `waitFor*` functions are one-line wrappers
 *  over this. Throws `ScenarioTimeoutError` (re-thrown from `runUntil`
 *  with a nicer `label`) if the target event never fires. */
export function waitForEvent<K extends keyof GameEventMap>(
  sc: Scenario,
  eventType: K,
  predicate: (ev: GameEventMap[K]) => boolean,
  opts?: { timeoutMs?: number; label?: string },
): GameEventMap[K] {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const label = opts?.label ?? `waitForEvent(${String(eventType)})`;
  let captured: GameEventMap[K] | null = null;
  const handler = (ev: GameEventMap[K]) => {
    if (captured === null && predicate(ev)) captured = ev;
  };
  sc.bus.on(eventType, handler);
  try {
    sc.runUntil(() => captured !== null, { timeoutMs });
  } catch (err) {
    if (err instanceof ScenarioTimeoutError) {
      throw new ScenarioTimeoutError(
        `${label} timed out after ${timeoutMs}ms`,
        timeoutMs,
      );
    }
    throw err;
  } finally {
    sc.bus.off(eventType, handler);
  }
  // runUntil either succeeded (captured is non-null) or threw above.
  return captured as NonNullable<typeof captured>;
}

/** Label a narrative beat of a test. If `fn` throws, re-throws with the
 *  label prepended so failure messages point at the beat that failed.
 *  No-op overhead on success. Sync or async `fn` both work. */
export async function step<T>(
  label: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`step "${label}" failed: ${message}`, {
      cause: err instanceof Error ? err : undefined,
    });
  }
}

/** Subscribe to every bus event and accumulate them in order.
 *  Call BEFORE driving the runtime so no events are missed.
 *  Filters out cosmetic SFX events — see `COSMETIC_EVENT_TYPES`. */
export function recordEvents(sc: Scenario): RecordedEvent[] {
  const events: RecordedEvent[] = [];
  sc.bus.onAny((type, ev) => {
    if (COSMETIC_EVENT_TYPES.has(type as string)) return;
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
    hoverTile: (row, col) => {
      const { x, y } = tileCenterCanvasPx(row, col);
      dispatchMouse("mousemove", x, y);
    },
    clickTile: (row, col) => {
      const { x, y } = tileCenterCanvasPx(row, col);
      dispatchMouse("click", x, y);
    },
    tapTile: (row, col) => {
      const { x, y } = tileCenterCanvasPx(row, col);
      dispatchTouch("touchstart", [{ x, y }]);
      dispatchTouch("touchend", [], [{ x, y }]);
    },
  };
}

/** Headless tile → canvas-space centre pixel. Headless canvas uses
 *  `SCALE`-multiplied coordinates (world pixels × 2) because the
 *  stub renderer's `clientToSurface` is the identity — the camera
 *  then divides by `SCALE` to recover world pixels. */
function tileCenterCanvasPx(
  row: number,
  col: number,
): { x: number; y: number } {
  return {
    x: (col + 0.5) * TILE_SIZE * SCALE,
    y: (row + 0.5) * TILE_SIZE * SCALE,
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
