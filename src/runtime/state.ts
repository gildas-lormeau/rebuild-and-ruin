import {
  type ActionSchedule,
  createActionSchedule,
  DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS,
} from "../shared/core/action-schedule.ts";
import {
  type BattleAnimState,
  createBattleAnimState,
} from "../shared/core/battle-types.ts";
import type {
  LifeLostDialogState,
  UpgradePickDialogState,
} from "../shared/core/dialog-state.ts";
import { SIM_TICK_US } from "../shared/core/game-constants.ts";
import type { PlayerId, ValidPlayerId } from "../shared/core/player-slot.ts";
import { type PlayerController } from "../shared/core/system-interfaces.ts";
import {
  type GameState,
  type LobbyState,
  type SelectionState,
} from "../shared/core/types.ts";
import {
  type CastleBuildState,
  type ControlsState,
  type OptionsContext,
  type QuitState,
} from "../shared/ui/interaction-types.ts";
import type { FrameData, RenderOverlay } from "../shared/ui/overlay-types.ts";
import {
  type GameSettings,
  loadSettings,
  MAX_PLAYERS,
} from "../shared/ui/player-config.ts";
import { isGameplayMode, Mode } from "../shared/ui/ui-mode.ts";
import { type BannerState, createBannerState } from "./banner-state.ts";
import { createTimerAccums, type TimerAccums } from "./timer-accums.ts";

/** Per-frame derived context, recomputed each frame by `computeFrameContext`
 *  in `main-loop.ts` and stored on `RuntimeState.frameMeta`. Pure runtime
 *  presentation/camera gating — it is NOT game state, never serialized, and
 *  consumed only by the runtime (main loop + camera subsystem). */
export interface FrameContext {
  // Identity
  readonly myPlayerId: PlayerId;
  /** Point-of-view player for camera, sound, and haptics.
   *  Online: myPlayerId. Local: pointer player slot. Demo: 0. */
  readonly povPlayerId: ValidPlayerId;
  readonly hostAtFrameStart: boolean;
  /** Non-local player slots. See OnlineSession.remotePlayerSlots for full docs. */
  readonly remotePlayerSlots: ReadonlySet<ValidPlayerId>;

  // Mode / Phase
  readonly mode: Mode;

  /** True when the current game phase is BATTLE. */
  readonly inBattle: boolean;

  // Overlay flags
  readonly isSelectionReady: boolean;

  // Player presence
  /** True when a local human player exists and is not eliminated.
   *  Gates auto-zoom, crosshair rendering, and combo floating text. */
  readonly hasPointerPlayer: boolean;

  // Composite guards
  /** Camera should unzoom (an overlay blocks gameplay — pause / quit
   *  dialog / life-lost — or the phase timer is about to expire, or a
   *  transition is running). */
  readonly shouldUnzoom: boolean;
  /** Life-lost dialog is open AND the local pov player has an unresolved
   *  entry. While true, the camera holds the local player's home zone
   *  (overrides the standard `hasLifeLostDialog → unzoom` behavior) so
   *  the popup sits over their territory while they pick CONTINUE/ABANDON.
   *  Flips false the moment their entry resolves, even if the dialog stays
   *  open for other players — at which point the normal overlay-unzoom
   *  takes over and the camera snaps to fullMap. */
  readonly lifeLostKeepZoom: boolean;
  /** Non-interactive transition — camera suppresses auto-zoom. */
  readonly isTransition: boolean;
}

/** Discriminant for pause source. See `RuntimeState.pausedBy`. */
type PauseReason = "none" | "user" | "visibility";

interface ScoreDisplayState {
  deltas: {
    playerId: ValidPlayerId;
    delta: number;
    total: number;
    cx: number;
    cy: number;
  }[];
  deltaTimer: number;
  preScores: readonly number[];
}

interface OptionsUIState {
  context: OptionsContext;
  cursor: number;
}

interface InputTrackingState {
  /** Player slot joined by mouse/trackpad, or null if none joined yet. */
  mouseJoinedSlot: ValidPlayerId | null;
}

interface DialogRuntimeState {
  lifeLost: LifeLostDialogState | null;
  upgradePick: UpgradePickDialogState | null;
}

interface SelectionRuntimeState {
  states: Map<ValidPlayerId, SelectionState>;
  castleBuilds: CastleBuildState[];
}

/** Mutable runtime state bag for the game loop.
 *
 *  SHARED BAG CONTRACT: every sub-system has a reference to this. **Reads
 *  are unrestricted across sub-systems; writes are owned.** The README rule
 *  "sub-systems must not import each other" is about CODE DEPENDENCIES
 *  (no `import` between `createXSystem` files); state sharing via this bag
 *  is explicit design — `state`, `frame`, `overlay`, `mode`, `dialogs.*`,
 *  `battleAnim`, `scoreDisplay`, etc. are read by N subsystems and written
 *  by 1. The owning subsystem is identifiable by the field name (e.g.
 *  `dialogs.lifeLost` ↔ life-lost subsystem, `selection` ↔ selection
 *  subsystem, `scoreDisplay` ↔ score-delta subsystem) — writes from a
 *  non-owner are the actual contract violation, not reads.
 *
 *  For type-narrowed reads, every owning subsystem exposes a `get()` on
 *  its handle (`RuntimeLifeLost.get()`, `RuntimeUpgradePick.get()`, …).
 *  Prefer the handle for a single targeted read; use the bag directly
 *  when aggregating many fields (render, frame-context derivation).
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
  /** Routing inputs for the in-progress ROUND_END window, stashed by
   *  `enter-round-end`'s mutate from `finalizeRound`'s return and consumed
   *  when the life-lost dialog beat is built / the window exits. Null
   *  outside the window — `exitRoundEnd` clears it, and every FULL_STATE
   *  adoption overwrites it (`adoptRoundEndRouting`): mid-ROUND_END
   *  snapshots carry the sender's routing (`FullStateMessage.roundEnd` —
   *  the eliminated list is NOT board-derivable, and a stranded stale
   *  stash would route a different round's losers), any other snapshot
   *  nulls it. `deriveRoundEndRouting`'s board fallback covers the
   *  defensive no-stash-no-routing case. */
  roundEnd: {
    needsReselect: readonly ValidPlayerId[];
    eliminated: readonly ValidPlayerId[];
  } | null;

  /** Lockstep scheduled-actions queue — every wire-broadcast input that
   *  mutates GameState is enqueued (on both originator and receiver) and
   *  drained once per sim tick at the top of `runOneSubStep`. See
   *  `shared/core/action-schedule.ts`. */
  actionSchedule: ActionSchedule<GameState>;

  // Timers / accumulators
  accum: TimerAccums;
  lastTime: number;
  frameDt: number;

  /** Sim time (integer µs) this peer owes the lockstep timeline. Online,
   *  frame gaps beyond MAX_FRAME_DT (tab hidden — rAF stops; long GC or
   *  breakpoint stalls) are BANKED here instead of dropped, and repaid as
   *  bounded extra sub-steps per frame (`consumeLockstepDebtTicks` in
   *  `mainLoop`) — a deterministic fast-forward replay against the
   *  already-received action queue. Dropping the time instead leaves the
   *  peer permanently behind: its `applyAt` stamps land in other peers'
   *  past and the match forks. Always 0 offline (banking is gated on
   *  `isLockstepSession`) and 0 in healthy online play. Reset on session
   *  install and rebased to 0 by a FULL_STATE adoption (the snapshot's
   *  simTick re-levels the peer). */
  lockstepDebtUs: number;

  /** Set by tick handlers via `requestRender`; drained once per browser
   *  frame at the end of `mainLoop`. Coalescing N substep renders into 1
   *  prevents the spiral-of-death where heavy frames render multiple times
   *  but only the last image is ever painted. The few sites that need a
   *  synchronous render (e.g. `finalizeGameOver`'s terminal frame,
   *  `finishSelection`'s pre-mutate flush) bypass this flag and call
   *  `render()` directly. */
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
  /** Last battle crosshair position of the pointer player (touch devices),
   *  persisted across rounds so the next battle restores aim onto the same
   *  enemy (see `battle-aim.ts`). Written by the composition root's
   *  battle-aim seeding (battle-entry apply + round-end save); read by the
   *  camera's battle-entry zone anchor; cleared by `resetTransientState`
   *  (restart / rematch — `teardownSession` doesn't clear it; the next
   *  game's reset covers it). Pov-local presentational state — never
   *  synced. */
  lastBattleCrosshair: { x: number; y: number } | undefined;
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
  /** Monotonic counter bumped by every session teardown (quit-to-menu,
   *  route-level shutdown, game over). An in-flight `bootstrapGame`
   *  captures the value at entry and bails after each await once it no
   *  longer matches — without the check, a bootstrap parked on its AI
   *  module / controller-factory awaits when the user exits would resume
   *  and boot a full game (state + Mode.SELECTION + music) behind
   *  whatever UI replaced it. Never reset (not even in
   *  `resetTransientState`) — captured generations must stay comparable
   *  for the whole page session. */
  bootGeneration: number;

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

/** Bank wall-clock seconds the frame loop had to discard (gap beyond
 *  MAX_FRAME_DT) as owed lockstep sim time. Integer-µs accumulation —
 *  same idiom as SimTickAccumulator — so repeated banks never drift. */
export function bankLockstepDebt(
  runtimeState: RuntimeState,
  seconds: number,
): void {
  runtimeState.lockstepDebtUs += Math.round(seconds * 1_000_000);
}

/** Repay up to `maxTicks` of owed sim time; returns the number of extra
 *  sub-steps the caller must run this frame. */
export function consumeLockstepDebtTicks(
  runtimeState: RuntimeState,
  maxTicks: number,
): number {
  const ticks = Math.min(lockstepDebtTicks(runtimeState), maxTicks);
  runtimeState.lockstepDebtUs -= ticks * SIM_TICK_US;
  return ticks;
}

/** Lockstep `applyAt` stamp for an owner-funnel obligation committed NOW
 *  (selection confirm, cannon done-flag, dialog choice): SAFETY ticks in
 *  the future, plus any outstanding lockstep debt. Without the debt term,
 *  a commit made while this peer fast-forward replays a hidden-tab gap
 *  would land in the other peers' PAST; projecting past the remaining
 *  debt keeps it in everyone's future (0 in healthy play). Owner-funnel
 *  obligations are the commits the other peers' phase exit or dialog
 *  waits on, so they ride out during replay, stamp-corrected — unlike
 *  board commits, which are quarantined instead
 *  (`LOCKSTEP_QUARANTINE_DEBT_TICKS`). Callers must schedule locally AND
 *  broadcast the SAME stamp so origin and receivers apply on one
 *  simTick. */
export function lockstepStampTick(runtimeState: RuntimeState): number {
  return (
    runtimeState.state.simTick +
    DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS +
    lockstepDebtTicks(runtimeState)
  );
}

/** Whole sim ticks currently owed (floor — the sub-tick residue stays
 *  banked and merges with the next gap instead of being discarded). */
export function lockstepDebtTicks(runtimeState: RuntimeState): number {
  return Math.floor(runtimeState.lockstepDebtUs / SIM_TICK_US);
}

/** React to a tab-visibility change. Sets `pausedBy = "visibility"` when the
 *  tab hides AND nothing else holds the pause; clears it on return only if
 *  the current reason is still `"visibility"` (never overrides a user pause).
 *  Audio mute is a separate concern — the caller re-applies it after this.
 *  NOT wired for live online sessions (see the composition root's
 *  visibility listener): a lockstep peer must never pause — paused
 *  sub-steps consume accumulator time without advancing simTick, which is
 *  exactly the silent time-drop that forks the match. */
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
  runtimeState.lockstepDebtUs = 0;
  runtimeState.pausedBy = "none";
  runtimeState.speedMultiplier = 1;
  runtimeState.quit = { pending: false };
  runtimeState.optionsUI.context = { kind: "lobby" };
  runtimeState.actionSchedule.reset();
  runtimeState.modifierRevealPlayStartMs = undefined;
  runtimeState.lastBattleCrosshair = undefined;
  runtimeState.roundEnd = null;
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
    roundEnd: null,
    actionSchedule: createActionSchedule(),

    accum: createTimerAccums(),
    lastTime: 0,
    frameDt: DEFAULT_FRAME_DT,
    lockstepDebtUs: 0,
    renderDirty: false,

    battleAnim: createBattleAnimState(),
    banner: createBannerState(),
    modifierRevealPlayStartMs: undefined,
    lastBattleCrosshair: undefined,
    // Placeholder until the first mainLoop tick populates frame context.
    // Guarded by `stateInstalled` (same lifecycle as `state`).
    frameMeta: null as unknown as FrameContext,
    frame: freshFrame(),
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
    quit: { pending: false },
    optionsUI: { context: { kind: "lobby" }, cursor: 0 },

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
    },

    inputTracking: { mouseJoinedSlot: null },

    demoReturnTimer: undefined,
    bootGeneration: 0,
    speedMultiplier: 1,
    fixedStepMs: undefined,
  };
}

/** A fresh per-frame `FrameData`. Single source of truth for "an empty
 *  frame": preserves sticky fields (`gameOver`) that outlive a single
 *  tick when `prev` is supplied. Add new sticky fields here, not at the
 *  call sites (`createRuntimeState`, the loop's `clearFrameData`). */
export function freshFrame(prev?: FrameData): FrameData {
  return {
    crosshairs: [],
    ...(prev?.gameOver !== undefined ? { gameOver: prev.gameOver } : {}),
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
 *  (local bootstrap) and the online InitMessage handler.
 *
 *  `nowMs` (same clock as the rAF timestamps — `timing.now`) rebases the
 *  frame clock at session start: a peer hidden while the host starts the
 *  match would otherwise measure its first visible frame against a
 *  pre-session `lastTime` and bank lobby-era time as lockstep debt,
 *  overshooting the catch-up and forking the match the other way. */
export function setRuntimeGameState(
  runtimeState: RuntimeState,
  state: GameState,
  nowMs: number,
): void {
  runtimeState.state = state;
  runtimeState.stateInstalled = true;
  runtimeState.lastTime = nowMs;
  runtimeState.lockstepDebtUs = 0;
}
