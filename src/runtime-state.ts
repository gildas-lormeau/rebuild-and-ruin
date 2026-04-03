/**
 * Mutable runtime state bag — replaces the loose closure variables
 * that used to live inside createGameRuntime().
 *
 * Exposing state as a plain object lets inner functions be extracted
 * to separate modules (they just take runtimeState: RuntimeState) and eliminates
 * the getter/setter boilerplate on the GameRuntime interface.
 */

import type { CastleBuildState } from "./castle-build.ts";
import { type PlayerController } from "./controller-interfaces.ts";
import type { ValidPlayerSlot } from "./game-constants.ts";
import { loadSettings } from "./game-ui-settings.ts";
import { type BannerState, createBannerState } from "./phase-banner.ts";
import { type GameSettings, MAX_PLAYERS } from "./player-config.ts";
import type { FrameData, PlayerStats, RenderOverlay } from "./render-types.ts";
import { createTimerAccums, type TimerAccums } from "./tick-context.ts";
import {
  type BattleAnimState,
  type ControlsState,
  createBattleAnimState,
  createControlsState,
  type FrameContext,
  type GameState,
  isGameplayMode,
  type LifeLostDialogState,
  type LobbyState,
  Mode,
  type SelectionState,
  type UpgradePickDialogState,
} from "./types.ts";

/**
 * Runtime state access patterns:
 *
 * - Safe path (render, input): `safeState(runtimeState)` → GameState | undefined
 * - Tick path (game logic):    `assertStateReady(runtimeState)` → throws if uninitialized
 * - Guard check:               `isStateReady(runtimeState)` before direct .state access
 *
 * Both `state` and `frameCtx` are guarded by Proxy sentinels that throw on any
 * property access before startGame() runs. Once one is ready, both are ready.
 */
/** Mutable runtime state bag for the game loop.
 *
 *  SENTINEL GUARD: `state` and `frameCtx` are initialized via Proxy sentinels
 *  that throw on ANY property access before startGame() runs. This means:
 *    - Always check `isStateReady(runtimeState)` before accessing `.state` or `.frameCtx`
 *    - Use `safeState(runtimeState)` in code paths that may run before init (render, input)
 *    - Both fields are initialized together — if one is ready, both are ready
 *  All other fields are safe to access immediately after createRuntimeState(). */
export interface RuntimeState {
  // Core game
  /** Guarded by sentinel — throws on access before startGame(). See RuntimeState docs. */
  state: GameState;
  overlay: RenderOverlay;
  controllers: PlayerController[];

  // Phase / selection
  /** Players awaiting reselection UI (queued by life-lost resolution).
   *  Drained one-by-one as each player's selection dialog completes.
   *  Set in runtime-life-lost, consumed in runtime-selection. */
  reselectQueue: ValidPlayerSlot[];
  /** Snapshot of player IDs currently in the reselection flow (copied from
   *  reselectQueue at reselection start). Used by camera/render to know which
   *  players are reselecting. Cleared when reselection completes. */
  reselectionPids: ValidPlayerSlot[];
  selectionStates: Map<number, SelectionState>;
  castleBuilds: CastleBuildState[];
  castleBuildOnDone: (() => void) | null;
  lifeLostDialog: LifeLostDialogState | null;
  upgradePickDialog: UpgradePickDialogState | null;

  // Timers / accumulators
  accum: TimerAccums;
  lastTime: number;
  frameDt: number;

  // Grouped sub-state
  battleAnim: BattleAnimState;
  banner: BannerState;
  /** Per-frame context (dt, mode, etc.). IMPORTANT: guarded by an uninitialized
   *  sentinel before the first mainLoop tick. Same rules as `state` — check
   *  `isStateReady(runtimeState)` before accessing. */
  frameMeta: FrameContext;
  frame: FrameData;
  lobby: LobbyState;

  // UI / mode
  mode: Mode;
  paused: boolean;
  quitPending: boolean;
  quitTimer: number;
  quitMessage: string;
  /** If non-null, options screen is open during gameplay and settings are read-only.
   *  Value is the Mode to return to when options close.
   *  null = options opened from lobby (settings are editable). */
  optionsReturnMode: Mode | null;
  optionsCursor: number;

  // Settings (mutable object, never reassigned after init)
  settings: GameSettings;
  controlsState: ControlsState;

  // Score display
  scoreDeltas: {
    playerId: ValidPlayerSlot;
    delta: number;
    total: number;
    cx: number;
    cy: number;
  }[];
  scoreDeltaTimer: number;
  scoreDeltaOnDone: (() => void) | null;
  preScores: readonly number[];
  gameStats: PlayerStats[];

  // Input tracking
  /** Player slot joined by mouse/trackpad, or null if none joined yet. */
  mouseJoinedSlot: number | null;
  /** True when the player is using direct touch on the canvas (not d-pad). */
  directTouchActive: boolean;
}

/** Modes that have tick handlers. STOPPED is handled by early-return. */
type TickableMode = Exclude<Mode, Mode.STOPPED>;

/** Tick dispatch table — mapped type forces every tickable Mode to have
 *  a handler.  Adding a new Mode without a handler is a compile error. */
type TickDispatch = { readonly [M in TickableMode]: (dt: number) => void };

/** Default frame delta time (assumes 60fps). */
const DEFAULT_FRAME_DT = 1 / 60;
/**
 * Create a typed sentinel that throws a descriptive error on any property
 * access.  Replaces `null! as T` — same zero-cost for valid code paths,
 * but produces a clear "not yet initialized" error instead of a cryptic
 * "Cannot read properties of null" when accessed before assignment.
 */
const SENTINEL = Symbol("uninitialized");

/** Create initial runtime state. `state` and `ctx` are sentinel-guarded:
 * they throw on any property access until startGame() assigns real values.
 * All other fields are safe to access immediately. */
export function createRuntimeState(): RuntimeState {
  return {
    state: uninitializedSentinel<GameState>("state"),
    overlay: { selection: { highlighted: null, selected: null } },
    controllers: [],

    reselectQueue: [],
    reselectionPids: [],
    selectionStates: new Map(),
    castleBuilds: [],
    castleBuildOnDone: null,
    lifeLostDialog: null,
    upgradePickDialog: null,

    accum: createTimerAccums(),
    lastTime: 0,
    frameDt: DEFAULT_FRAME_DT,

    battleAnim: createBattleAnimState(),
    banner: createBannerState(),
    frameMeta: uninitializedSentinel<FrameContext>("ctx"),
    frame: { crosshairs: [], phantoms: {} },
    lobby: {
      joined: new Array(MAX_PLAYERS).fill(false),
      active: false,
      timerAccum: 0,
      seed: 0,
      map: null,
    },

    mode: Mode.STOPPED,
    paused: false,
    quitPending: false,
    quitTimer: 0,
    quitMessage: "",
    optionsReturnMode: null,
    optionsCursor: 0,

    settings: loadSettings(),
    controlsState: createControlsState(),

    scoreDeltas: [],
    scoreDeltaTimer: 0,
    scoreDeltaOnDone: null,
    preScores: [],
    gameStats: [],

    mouseJoinedSlot: null,
    directTouchActive: false,
  };
}

/** Return game state or a safe empty fallback. Use in code paths that run during
 *  lobby or transitions (render, input) where state may not exist yet.
 *  Contrast with assertStateReady() which throws if state is missing. */
export function safeState(runtimeState: RuntimeState): GameState | undefined {
  return isStateReady(runtimeState) ? runtimeState.state : undefined;
}

/** Assert that game state exists and return it. Use in tick/game-logic code paths
 *  that must not run before startGame(). Throws if state is missing.
 *  Contrast with safeState() which returns a fallback instead of throwing. */
export function assertStateReady(runtimeState: RuntimeState): GameState {
  if (!isStateReady(runtimeState)) {
    throw new Error("runtimeState.state accessed before initialization");
  }
  return runtimeState.state;
}

/** Returns true when `runtimeState.state` has been assigned a real GameState.
 *  Note: `runtimeState.ctx` is also sentinel-guarded and initialized at the same time
 *  (first mainLoop tick after startGame). Both are safe to access when this
 *  returns true. */
export function isStateReady(runtimeState: RuntimeState): boolean {
  return !(runtimeState.state as unknown as Record<symbol, unknown>)[SENTINEL];
}

/** Run the main loop tick: quit countdown, pause check, mode dispatch.
 *  Returns false if the loop should NOT reschedule (Mode.STOPPED). */
export function tickMainLoop(params: {
  readonly dt: number;
  readonly mode: Mode;
  readonly paused: boolean;
  readonly quitPending: boolean;
  readonly quitTimer: number;
  readonly quitMessage?: string;
  readonly frame: { announcement?: string };
  readonly setQuitPending: (quitPending: boolean) => void;
  readonly setQuitTimer: (quitTimer: number) => void;
  readonly render: () => void;
  readonly ticks: TickDispatch;
}): boolean {
  const { dt, mode, frame, ticks } = params;

  // Tick ESC-to-quit countdown
  if (params.quitPending) {
    const next = params.quitTimer - dt;
    if (next <= 0) {
      params.setQuitPending(false);
    } else {
      params.setQuitTimer(next);
      if (params.quitMessage) frame.announcement = params.quitMessage;
    }
  }

  // Pause: keep rendering but skip all game ticks
  if (params.paused && isGameplayMode(mode)) {
    if (!frame.announcement) frame.announcement = "PAUSED";
    params.render();
    return true;
  }

  if (mode === Mode.STOPPED) return false;

  ticks[mode](dt);

  return true;
}

function uninitializedSentinel<T extends object>(name: string): T {
  const proxy = new Proxy<T>(Object.create(null), {
    get(_, prop) {
      if (prop === SENTINEL) return true;
      throw new Error(
        `runtimeState.${name} accessed before initialization (property: ${String(prop)})`,
      );
    },
  });
  return proxy;
}
