import {
  type ActionSchedule,
  createActionSchedule,
} from "../shared/core/action-schedule.ts";
import {
  type BattleAnimState,
  createBattleAnimState,
} from "../shared/core/battle-types.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
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
import { isGameplayMode, Mode } from "../shared/ui/ui-mode.ts";
import { type BannerState, createBannerState } from "./runtime-banner-state.ts";
import { createTimerAccums, type TimerAccums } from "./runtime-tick-context.ts";

/** Discriminant for pause source. See `RuntimeState.pausedBy`. */
export type PauseReason = "none" | "user" | "visibility";

export interface ScoreDisplayState {
  deltas: {
    playerId: ValidPlayerId;
    delta: number;
    total: number;
    cx: number;
    cy: number;
  }[];
  deltaTimer: number;
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
}

export interface DialogRuntimeState {
  lifeLost: LifeLostDialogState | null;
  upgradePick: UpgradePickDialogState | null;
}

export interface SelectionRuntimeState {
  states: Map<number, SelectionState>;
  castleBuilds: CastleBuildState[];
}

/** Mutable runtime state bag for the game loop.
 *
 *  READINESS GUARDS: `state` and `frameMeta` are typed as their real types but
 *  hold placeholder values until `startGame()` / the first mainLoop tick runs.
 *  Two predicates carve up the lifecycle:
 *
 *  - `isStateInstalled(runtimeState)` — sticky-once-true. The bootstrap-only
 *    guard for paths that legitimately read frozen state outside an active
 *    session (game-over render, dev console, E2E bridge).
 *  - `isSessionLive(runtimeState)` — true only while a game session is in
 *    progress (any gameplay mode AND state installed). The right guard for
 *    every per-tick presentational signal, animator, or state-derived
 *    computation that should stop when the player returns to the lobby
 *    (state lingers as a frozen object after `returnToLobby`, but no longer
 *    represents a live game — reading it as if it did is the class of bug
 *    that produced the snare-loop-restart and lobby-map-shadowing issues).
 *
 *  All other fields are safe to access immediately after createRuntimeState(). */
export interface RuntimeState {
  // Core game
  /** Guarded by `stateInstalled` — only read after `isStateInstalled(...)` or
   *  (preferably, for live-session paths) `isSessionLive(...)`. */
  state: GameState;
  /** True once `state` has been assigned a real GameState (startGame or online
   *  init). Flipped once, never reset: `returnToLobby` leaves the prior
   *  GameState in place until the next bootstrap overwrites it. This is the
   *  bootstrap predicate, NOT a session predicate — see `isSessionLive`. */
  stateInstalled: boolean;
  overlay: RenderOverlay;
  controllers: PlayerController[];

  // Phase / selection
  selection: SelectionRuntimeState;
  dialogs: DialogRuntimeState;

  /** Lockstep scheduled-actions queue — every wire-broadcast input that
   *  mutates GameState is enqueued (on both originator and receiver) and
   *  drained once per sim tick at the top of `runOneSubStep`. See
   *  `runtime-action-schedule.ts`. */
  actionSchedule: ActionSchedule;

  // Timers / accumulators
  accum: TimerAccums;
  lastTime: number;
  frameDt: number;

  /** Set by tick handlers via `requestRender`; drained once per browser
   *  frame at the end of `mainLoop`. Coalescing N substep renders into 1
   *  prevents the spiral-of-death where heavy frames render multiple times
   *  but only the last image is ever painted. The few sites that need a
   *  synchronous render (game-over terminal frame, in-STOPPED-mode focus
   *  toggles) bypass this flag via `forceRender`. */
  renderDirty: boolean;

  // Grouped sub-state
  battleAnim: BattleAnimState;
  banner: BannerState;
  /** When the active modifier-reveal entered its post-sweep window, in
   *  `now()`-units, or undefined while the banner is mid-sweep / no reveal
   *  is active. Owned by `tickModifierRevealClock`; consumed by
   *  `revealTimeFor` so per-modifier effects receive a `revealTimeMs`
   *  number without seeing banner state directly. One field for all
   *  modifiers because only one modifier is ever revealing at a time. */
  modifierRevealPlayStartMs: number | undefined;
  /** Per-frame context (dt, mode, etc.). Populated by `computeFrameContext`
   *  on every mainLoop tick. Holds a placeholder until the first tick — same
   *  rules as `state`: check `isStateInstalled(runtimeState)` before accessing. */
  frameMeta: FrameContext;
  frame: FrameData;
  lobby: LobbyState;

  // UI / mode
  mode: Mode;
  /** Reason the game loop is paused — single source of truth.
   *  - `"none"` — running.
   *  - `"user"` — pause initiated by the player (options menu toggle, dev
   *    console). Persists across tab hide/show so a manually-paused game
   *    stays paused on return.
   *  - `"visibility"` — tab was backgrounded. Auto-clears on tab return,
   *    but only when the current reason is `"visibility"` (never overrides
   *    a user pause). */
  pausedBy: PauseReason;
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
  /** Fixed frame step in ms (dev-only). When set, clampedFrameDt returns this
   *  constant instead of computing from wall-clock timestamps — makes the
   *  browser simulation deterministic so seeds reproduce across environments. */
  fixedStepMs: number | undefined;
}

/** Default frame delta time (assumes 60fps). */
const DEFAULT_FRAME_DT = 1 / 60;

/** Centralized mode transition — all mode changes MUST go through this function.
 * Single mutation point makes the state machine traceable and validatable. */
export function setMode(runtimeState: RuntimeState, mode: Mode): void {
  runtimeState.mode = mode;
}

/** Derived pause flag — true when any reason holds the loop paused. */
export function isPaused(runtimeState: RuntimeState): boolean {
  return runtimeState.pausedBy !== "none";
}

/** React to a tab-visibility change. Sets `pausedBy = "visibility"` when the
 *  tab hides AND nothing else holds the pause; clears it on return only if
 *  the current reason is still `"visibility"` (never overrides a user pause).
 *  Audio mute is a separate concern — the caller re-applies it after this. */
export function setVisibilityHidden(
  runtimeState: RuntimeState,
  hidden: boolean,
): void {
  if (hidden && runtimeState.pausedBy === "none") {
    runtimeState.pausedBy = "visibility";
  } else if (!hidden && runtimeState.pausedBy === "visibility") {
    runtimeState.pausedBy = "none";
  }
}

/** Reset transient RuntimeState fields between games (restart / rematch).
 * Does NOT reset subsystem-owned state (selection, camera, sound, etc.)
 * or settings — those are the caller's responsibility. */
export function resetTransientState(runtimeState: RuntimeState): void {
  runtimeState.battleAnim = createBattleAnimState();
  runtimeState.accum = createTimerAccums();
  runtimeState.pausedBy = "none";
  runtimeState.speedMultiplier = 1;
  runtimeState.quit.pending = false;
  runtimeState.quit.timer = 0;
  runtimeState.quit.message = "";
  runtimeState.optionsUI.returnMode = null;
  runtimeState.actionSchedule.reset();
  runtimeState.modifierRevealPlayStartMs = undefined;
}

/** Create initial runtime state. `state` and `frameMeta` are not yet valid:
 *  read them only when `isStateInstalled(runtimeState)` returns true.
 *  All other fields are safe to access immediately. */
export function createRuntimeState(): RuntimeState {
  return {
    // Placeholder until startGame() assigns a real GameState (see
    // `setRuntimeGameState`). Guarded by `stateInstalled`.
    state: null as unknown as GameState,
    stateInstalled: false,
    overlay: { selection: { highlighted: null, selected: null } },
    controllers: [],

    selection: {
      states: new Map(),
      castleBuilds: [],
    },
    dialogs: { lifeLost: null, upgradePick: null },
    actionSchedule: createActionSchedule(),

    accum: createTimerAccums(),
    lastTime: 0,
    frameDt: DEFAULT_FRAME_DT,
    renderDirty: false,

    battleAnim: createBattleAnimState(),
    banner: createBannerState(),
    modifierRevealPlayStartMs: undefined,
    // Placeholder until the first mainLoop tick populates frame context.
    // Guarded by `stateInstalled` (same lifecycle as `state`).
    frameMeta: null as unknown as FrameContext,
    frame: { crosshairs: [] },
    lobby: {
      joined: new Array(MAX_PLAYERS).fill(false),
      active: false,
      timerAccum: 0,
      seed: 0,
      map: null,
      roomSeedDisplay: null,
    },

    mode: Mode.STOPPED,
    pausedBy: "none",
    quit: { pending: false, timer: 0, message: "" },
    optionsUI: { returnMode: null, cursor: 0 },

    settings: loadSettings(),
    controlsState: {
      playerIdx: 0 as ValidPlayerId,
      actionIdx: 0,
      rebinding: false,
    },

    scoreDisplay: {
      deltas: [],
      deltaTimer: 0,
      preScores: [],
      gameStats: [],
    },

    inputTracking: { mouseJoinedSlot: null },

    demoReturnTimer: undefined,
    speedMultiplier: 1,
    fixedStepMs: undefined,
  };
}

/** Return game state or a safe empty fallback. Use in code paths that run during
 *  lobby or transitions (render, input) where state may not exist yet.
 *  Contrast with assertStateInstalled() which throws if state is missing. */
export function safeState(runtimeState: RuntimeState): GameState | undefined {
  return isStateInstalled(runtimeState) ? runtimeState.state : undefined;
}

/** Assert that game state exists and return it. Use in tick/game-logic code paths
 *  that must not run before startGame(). Throws if state is missing.
 *  Contrast with safeState() which returns a fallback instead of throwing. */
export function assertStateInstalled(runtimeState: RuntimeState): GameState {
  if (!isStateInstalled(runtimeState)) {
    throw new Error("runtimeState.state accessed before initialization");
  }
  return runtimeState.state;
}

/** Sticky-once-true bootstrap predicate — true when `state` has been assigned
 *  a real GameState at any point. Stays true after `returnToLobby` (the prior
 *  GameState lingers as a frozen object). `frameMeta` is populated on the
 *  first mainLoop tick after install, so tick-path code under this guard can
 *  also read it. Use ONLY for paths that legitimately read frozen state
 *  outside an active session — game-over render, dev console, E2E bridge.
 *  For per-tick gameplay-derived work, use `isSessionLive`. */
export function isStateInstalled(runtimeState: RuntimeState): boolean {
  return runtimeState.stateInstalled;
}

/** True when a game session is currently in progress: state is installed AND
 *  the runtime is in a gameplay mode. The right guard for every per-tick
 *  presentational signal, animator, or state-derived computation that should
 *  stop when the player returns to the lobby. After `returnToLobby` the
 *  `state` object lingers (frozen mid-game), but `mode` flips to `LOBBY` so
 *  this predicate goes false — preventing the class of bug that produced the
 *  snare-loop-restart and lobby-map-shadowing issues. */
export function isSessionLive(runtimeState: RuntimeState): boolean {
  return runtimeState.stateInstalled && isGameplayMode(runtimeState.mode);
}

/** Install the live GameState on the runtime. Single mutation point for the
 *  `state` field — keeps the install flag in sync. Call from `startGame`
 *  (local bootstrap) and the online InitMessage handler. */
export function setRuntimeGameState(
  runtimeState: RuntimeState,
  state: GameState,
): void {
  runtimeState.state = state;
  runtimeState.stateInstalled = true;
}
