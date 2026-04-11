import {
  type BattleAnimState,
  createBattleAnimState,
} from "../shared/core/battle-types.ts";
import { PHASE_ENDING_THRESHOLD } from "../shared/core/game-constants.ts";
import { isTimedPhase, Phase } from "../shared/core/game-phase.ts";
import {
  isActivePlayer,
  type PlayerSlotId,
  type ValidPlayerSlot,
} from "../shared/core/player-slot.ts";
import { type PlayerController } from "../shared/core/system-interfaces.ts";
import {
  type FrameContext,
  type GameState,
  type LobbyState,
  type SelectionState,
} from "../shared/core/types.ts";
import {
  type CastleBuildState,
  type ControlsState,
  createControlsState,
  type LifeLostDialogState,
  type UpgradePickDialogState,
} from "../shared/ui/interaction-types.ts";
import type {
  FrameData,
  PlayerStats,
  RenderOverlay,
} from "../shared/ui/overlay-types.ts";
import {
  type GameSettings,
  loadSettings,
  MAX_PLAYERS,
} from "../shared/ui/player-config.ts";
import {
  isGameplayMode,
  isTransitionMode,
  Mode,
} from "../shared/ui/ui-mode.ts";
import { type BannerState, createBannerState } from "./runtime-contracts.ts";
import { createTimerAccums, type TimerAccums } from "./runtime-tick-context.ts";

export interface ScoreDisplayState {
  deltas: {
    playerId: ValidPlayerSlot;
    delta: number;
    total: number;
    cx: number;
    cy: number;
  }[];
  deltaTimer: number;
  deltaOnDone: (() => void) | null;
  preScores: readonly number[];
  gameStats: PlayerStats[];
}

export interface QuitState {
  pending: boolean;
  timer: number;
  message: string;
}

export interface OptionsUIState {
  /** If non-null, options screen is open during gameplay and settings are read-only.
   *  Value is the Mode to return to when options close.
   *  null = options opened from lobby (settings are editable). */
  returnMode: Mode | null;
  cursor: number;
}

export interface InputTrackingState {
  /** Player slot joined by mouse/trackpad, or null if none joined yet. */
  mouseJoinedSlot: number | null;
  /** True when the player is using direct touch on the canvas (not d-pad). */
  directTouchActive: boolean;
}

export interface DialogRuntimeState {
  lifeLost: LifeLostDialogState | null;
  upgradePick: UpgradePickDialogState | null;
}

export interface SelectionRuntimeState {
  /** Players awaiting reselection UI (queued by life-lost resolution).
   *  Drained one-by-one as each player's selection dialog completes.
   *  Set in runtime-life-lost, consumed in runtime-selection. */
  reselectQueue: ValidPlayerSlot[];
  /** Snapshot of player IDs currently in the reselection flow (copied from
   *  reselectQueue at reselection start). Used by camera/render to know which
   *  players are reselecting. Cleared when reselection completes. */
  reselectionPids: ValidPlayerSlot[];
  states: Map<number, SelectionState>;
  castleBuilds: CastleBuildState[];
  castleBuildOnDone: (() => void) | null;
}

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
  selection: SelectionRuntimeState;
  dialogs: DialogRuntimeState;

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
  quit: QuitState;
  optionsUI: OptionsUIState;

  // Settings (mutable object, never reassigned after init)
  settings: GameSettings;
  controlsState: ControlsState;

  // Score display
  scoreDisplay: ScoreDisplayState;

  // Input tracking
  inputTracking: InputTrackingState;

  // Lifecycle
  /** setTimeout handle for demo auto-return to lobby. undefined = not pending. */
  demoReturnTimer: number | undefined;

  // Dev tools
  /** Game speed multiplier (dev-only). 1 = normal, 2 = double, 0.5 = half. */
  speedMultiplier: number;
}

/** Modes that have tick handlers. STOPPED is handled by early-return. */
type TickableMode = Exclude<Mode, Mode.STOPPED>;

/** Tick dispatch table — mapped type forces every tickable Mode to have
 *  a handler.  Adding a new Mode without a handler is a compile error. */
type TickDispatch = { readonly [M in TickableMode]: (dt: number) => void };

interface FrameContextInputs {
  mode: Mode;
  phase: Phase;
  timer: number;
  paused: boolean;
  quitPending: boolean;
  hasLifeLostDialog: boolean;
  isSelectionReady: boolean;
  humanIsReselecting: boolean;
  hasPointerPlayer: boolean;
  myPlayerId: PlayerSlotId;
  hostAtFrameStart: boolean;
  remotePlayerSlots: ReadonlySet<ValidPlayerSlot>;
  mobileAutoZoom: boolean;
}

/** Default frame delta time (assumes 60fps). */
const DEFAULT_FRAME_DT = 1 / 60;
/**
 * Create a typed sentinel that throws a descriptive error on any property
 * access.  Replaces `null! as T` — same zero-cost for valid code paths,
 * but produces a clear "not yet initialized" error instead of a cryptic
 * "Cannot read properties of null" when accessed before assignment.
 */
const SENTINEL = Symbol("uninitialized");

/** Create zeroed per-player game stats array for a new match. */
export function createEmptyGameStats(): PlayerStats[] {
  return Array.from({ length: MAX_PLAYERS }, () => ({
    wallsDestroyed: 0,
    cannonsKilled: 0,
  }));
}

/** Centralized mode transition — all mode changes MUST go through this function.
 * Single mutation point makes the state machine traceable and validatable. */
export function setMode(runtimeState: RuntimeState, mode: Mode): void {
  runtimeState.mode = mode;
}

/** Reset frame timing to avoid a large dt spike on the next tick.
 *  Call when resuming the loop after a gap (mode transition, options screen).
 *  `now` is the current frame timestamp from the injected `TimingApi.now()`. */
export function resetFrameTiming(
  runtimeState: RuntimeState,
  now: number,
): void {
  runtimeState.lastTime = now;
}

/** Reset transient RuntimeState fields between games (restart / rematch).
 * Does NOT reset subsystem-owned state (selection, camera, sound, etc.)
 * or settings — those are the caller's responsibility. */
export function resetTransientState(runtimeState: RuntimeState): void {
  runtimeState.battleAnim = createBattleAnimState();
  runtimeState.accum = createTimerAccums();
  runtimeState.paused = false;
  runtimeState.speedMultiplier = 1;
  runtimeState.quit.pending = false;
  runtimeState.quit.timer = 0;
  runtimeState.quit.message = "";
  runtimeState.optionsUI.returnMode = null;
  runtimeState.inputTracking.directTouchActive = false;
}

/** Create initial runtime state. `state` and `ctx` are sentinel-guarded:
 * they throw on any property access until startGame() assigns real values.
 * All other fields are safe to access immediately. */
export function createRuntimeState(): RuntimeState {
  return {
    state: uninitializedSentinel<GameState>("state"),
    overlay: { selection: { highlighted: null, selected: null } },
    controllers: [],

    selection: {
      reselectQueue: [],
      reselectionPids: [],
      states: new Map(),
      castleBuilds: [],
      castleBuildOnDone: null,
    },
    dialogs: { lifeLost: null, upgradePick: null },

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
    quit: { pending: false, timer: 0, message: "" },
    optionsUI: { returnMode: null, cursor: 0 },

    settings: loadSettings(),
    controlsState: createControlsState(),

    scoreDisplay: {
      deltas: [],
      deltaTimer: 0,
      deltaOnDone: null,
      preScores: [],
      gameStats: [],
    },

    inputTracking: { mouseJoinedSlot: null, directTouchActive: false },

    demoReturnTimer: undefined,
    speedMultiplier: 1,
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

export function computeFrameContext(inputs: FrameContextInputs): FrameContext {
  const {
    mode,
    phase,
    timer,
    paused,
    quitPending,
    hasLifeLostDialog,
    isSelectionReady,
    humanIsReselecting,
    hasPointerPlayer,
    myPlayerId,
    hostAtFrameStart,
    remotePlayerSlots,
    mobileAutoZoom,
  } = inputs;

  const uiBlocking = paused || quitPending || hasLifeLostDialog;

  const phaseEnding =
    !mobileAutoZoom &&
    timer > 0 &&
    timer <= PHASE_ENDING_THRESHOLD &&
    isTimedPhase(phase);

  const inBattle = phase === Phase.BATTLE;
  const shouldUnzoom = uiBlocking || phaseEnding;
  const isTransition = isTransitionMode(mode);

  const povPlayerId: ValidPlayerSlot = isActivePlayer(myPlayerId)
    ? myPlayerId
    : (0 as ValidPlayerSlot);

  return {
    myPlayerId,
    povPlayerId,
    hostAtFrameStart,
    remotePlayerSlots,
    mode,
    phase,
    inBattle,
    paused,
    quitPending,
    hasLifeLostDialog,
    isSelectionReady,
    humanIsReselecting,
    hasPointerPlayer,
    uiBlocking,
    phaseEnding,
    shouldUnzoom,
    isTransition,
  };
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
