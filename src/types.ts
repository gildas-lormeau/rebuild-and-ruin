/**
 * Core types, interfaces, and constants for the game engine.
 */

import type { Castle, GameMap, TilePos, Tower } from "./geometry-types.ts";
import type { Rng } from "./rng.ts";

export enum Phase {
  CASTLE_SELECT = "CASTLE_SELECT",
  CASTLE_RESELECT = "CASTLE_RESELECT",
  WALL_BUILD = "WALL_BUILD",
  CANNON_PLACE = "CANNON_PLACE",
  BATTLE = "BATTLE",
}

/** Input action names returned by matchKey / used in key dispatch. */
export enum Action {
  UP = "up",
  DOWN = "down",
  LEFT = "left",
  RIGHT = "right",
  CONFIRM = "confirm",
  ROTATE = "rotate",
}

/** Cannon placement mode. */
export enum CannonMode {
  NORMAL = "normal",
  SUPER = "super",
  BALLOON = "balloon",
}

/** Top-level UI mode — controls which screen/phase main loop renders. */
export enum Mode {
  LOBBY,
  OPTIONS,
  CONTROLS,
  SELECTION,
  BANNER,
  BALLOON_ANIM,
  CASTLE_BUILD,
  LIFE_LOST,
  GAME,
  STOPPED,
}

/** Game-over focus state — which button is highlighted on the game-over screen. */
export type GameOverFocus = "rematch" | "menu";

export interface Cannon extends TilePos {
  /** Hits remaining before destruction. Persists across rounds. */
  hp: number;
  /** Cannon variant: normal (2×2), super (3×3 incendiary), or balloon (2×2 propaganda). */
  mode: CannonMode;
  /** Facing angle in radians (snapped to 45° increments). 0 = up. */
  facing?: number;
}

/** A cannon captured by a propaganda balloon — fires for the balloon owner during battle. */
export interface CastleData {
  /** Wall tile positions encoded as row*GRID_COLS+col. */
  walls: Set<number>;
  /** Interior tile positions encoded as row*GRID_COLS+col. */
  interior: Set<number>;
  /** Cannon positions (top-left of 2×2 or 3×3 super) with HP. */
  cannons: Cannon[];
  /** Player index (for color). */
  playerId: number;
}

export interface CapturedCannon {
  /** The captured cannon reference. */
  cannon: Cannon;
  /** Index of the cannon in the victim's cannons array. */
  cannonIdx: number;
  /** The player who owns the captured cannon (victim). */
  victimId: number;
  /** The player who owns the balloon (capturer). */
  capturerId: number;
}

/** Result from nextReadyCombined — either an own cannon or a captured one. */
export type CombinedCannonResult =
  | { type: "own"; combinedIdx: number; ownIdx: number }
  | { type: "captured"; combinedIdx: number; cc: CapturedCannon };

/** Flight path for a balloon animation. */
export interface BalloonFlight {
  /** Start position in pixels (balloon base center). */
  startX: number;
  startY: number;
  /** Target position in pixels (captured cannon center). */
  endX: number;
  endY: number;
}

export interface Cannonball {
  /** Which cannon fired this ball (index into player.cannons). */
  cannonIdx: number;
  /** Start position in pixels. */
  startX: number;
  startY: number;
  /** Current position in pixels (sub-tile precision). */
  x: number;
  y: number;
  /** Target position in pixels. */
  targetX: number;
  targetY: number;
  /** Speed in pixels per second. */
  speed: number;
  /** Owner player id (used for in-flight tracking — index into this player's cannons array). */
  playerId: number;
  /** Player who should receive scoring credit. Differs from playerId for captured cannons. */
  scoringPlayerId?: number;
  /** If true, leaves a burning pit on impact (fired from super gun). */
  incendiary?: boolean;
}

export interface Impact extends TilePos {
  /** Seconds since the impact occurred. */
  age: number;
}

export interface BurningPit extends TilePos {
  /** Battle rounds remaining before the pit expires. */
  roundsLeft: number;
}

export interface BonusSquare extends TilePos {
  zone: number;
}

export interface Player {
  id: number;
  /** The tower this player selected as home castle. */
  homeTower: Tower | null;
  /** The castle built around the home tower. */
  castle: Castle | null;
  /** All towers currently enclosed by this player's walls. */
  ownedTowers: Tower[];
  /** Wall tiles owned by this player (row,col pairs encoded as row*COLS+col). */
  walls: Set<number>;
  /** Interior tiles (territory inside walls, encoded as row*COLS+col). */
  interior: Set<number>;
  /** Cannon positions (top-left tile of 2x2 cannon). */
  cannons: Cannon[];
  /** Lives remaining (starts at 3, lose 1 when failing to enclose any tower). */
  lives: number;
  /** Whether the player is eliminated (lives reached 0 and didn't continue). */
  eliminated: boolean;
  /** Accumulated territory points (scoring). */
  score: number;
  /** Default cannon facing (radians, 0 = up) — toward enemies, set at castle creation. */
  defaultFacing: number;
}

export interface Grunt extends TilePos {
  /** Which player's territory this grunt is attacking. */
  targetPlayerId: number;
  /** Locked target tower index. Stays until the tower is destroyed. */
  targetTowerIdx?: number;
  /** Countdown (seconds) before killing an adjacent tower or wall. Starts at 3 when adjacent. */
  attackTimer?: number;
  /** Number of consecutive battles the grunt has been blocked (not adjacent to target tower). */
  blockedBattles?: number;
  /** If true, this grunt is attacking a wall tile during battle (decided at battle start). */
  wallAttack?: boolean;
  /** Facing angle in radians (snapped to 90°). 0 = up. */
  facing?: number;
}

export interface GameState {
  /** Shared seeded RNG for deterministic gameplay decisions. */
  rng: Rng;
  map: GameMap;
  phase: Phase;
  round: number;
  /** Max rounds before the game ends (3, 5, 8, 12, or Infinity for "To The Death"). */
  battleLength: number;
  /** Hits needed to destroy a cannon (configurable: 3, 6, 9, or 12). */
  cannonMaxHp: number;
  /** Duration of the wall-build/repair phase in seconds (difficulty-scaled). */
  buildTimer: number;
  /** Duration of the cannon placement phase in seconds (difficulty-scaled). */
  cannonPlaceTimer: number;
  /** Cannons allowed in the first round (difficulty-scaled). */
  firstRoundCannons: number;
  players: Player[];
  /** Index of the player whose turn it is (for sequential phases). */
  activePlayer: number;
  /** Remaining time in seconds for timed phases (WALL_BUILD, BATTLE). */
  timer: number;
  /** Active cannonballs in flight. */
  cannonballs: Cannonball[];
  /** Number of cannonballs fired this battle round. */
  shotsFired: number;
  /** Active grunts on the map. */
  grunts: Grunt[];
  /** Whether each tower is alive (indexed same as map.towers). */
  towerAlive: boolean[];
  /** Dead towers that were enclosed last build phase — revive if still enclosed next build phase. */
  towerPendingRevive: Set<number>;
  /** Burning pits left by super gun incendiary cannonballs. Block placement. */
  burningPits: BurningPit[];
  /** Cannons captured by propaganda balloons this round (lasts one battle). */
  capturedCannons: CapturedCannon[];
  /** Persistent balloon hit counts — accumulates across battles, removed after capture or cannon destruction. */
  balloonHits: Map<Cannon, { count: number; capturerIds: number[] }>;
  /** Bonus squares on the map (3 per zone). */
  bonusSquares: BonusSquare[];
  /** Countdown before battle starts (Ready/Aim/Fire). 0 = battle active. */
  battleCountdown: number;
  /** Players who reselected a castle since the last cannon phase setup. */
  reselectedPlayers: Set<number>;
  /** Zone index assigned to each player (indexed by player id). Set at game start. */
  playerZones: number[];
  /** Cannon slot limits per player for the current cannon phase. Computed by computeCannonLimitsForPhase. */
  cannonLimits: number[];
}

/** Phase timer accumulators — tracks elapsed time per phase for host tick logic. */
export interface TimerAccums {
  battle: number;
  cannon: number;
  select: number;
  selectAnnouncement: number;
  build: number;
  grunt: number;
}

/** Battle animation state — territory/wall snapshots and in-flight effects. */
export interface BattleAnimState {
  territory: Set<number>[];
  walls: Set<number>[];
  flights: readonly { flight: BalloonFlight; progress: number }[];
  impacts: Impact[];
}

/** Mutable state for the controls-rebinding screen. */
export interface ControlsState {
  playerIdx: number;
  actionIdx: number;
  rebinding: boolean;
}

/** Per-player state during castle selection (highlighted tower, confirm status). */
export interface SelectionState {
  highlighted: number;
  confirmed: boolean;
  /** True once the user has explicitly tapped a tower (enables confirm on next tap). */
  tapped?: boolean;
}

/** Life-lost types. */
export enum LifeLostChoice {
  PENDING = "pending",
  CONTINUE = "continue",
  ABANDON = "abandon",
}

export type ResolvedChoice = LifeLostChoice.CONTINUE | LifeLostChoice.ABANDON;

export interface LifeLostEntry {
  playerId: number;
  lives: number;
  isAi: boolean;
  choice: LifeLostChoice;
  aiTimer: number;
  focused: number;
}

export interface LifeLostDialogState {
  entries: LifeLostEntry[];
  timer: number;
}

/** Player selection lobby state. */
export interface LobbyState {
  joined: boolean[];
  active: boolean;
  /** Accumulator for lobby countdown timer (local play). */
  timerAccum?: number;
  /** Pre-computed seed for the next game (also used for lobby map preview). */
  seed: number;
  map: GameMap | null;
}

export interface FrameContext {
  // Identity
  readonly myPlayerId: number;
  readonly firstHumanPlayerId: number;
  readonly isHost: boolean;
  readonly remoteHumanSlots: ReadonlySet<number>;

  // Mode / Phase
  readonly mode: Mode;
  readonly phase: Phase;

  // Overlay flags
  readonly paused: boolean;
  readonly quitPending: boolean;
  readonly hasLifeLostDialog: boolean;
  readonly isSelectionReady: boolean;
  /** True when the local human player is in the reselect queue. */
  readonly humanIsReselecting: boolean;

  // Composite guards
  /** UI overlay suppresses gameplay (pause, quit dialog, life-lost). */
  readonly uiBlocking: boolean;
  /** Phase timer about to expire (< PHASE_ENDING_THRESHOLD) on non-touch. */
  readonly phaseEnding: boolean;
  /** Camera should unzoom (uiBlocking OR phaseEnding). */
  readonly shouldUnzoom: boolean;
}

/** Exported for headless camera testing (test/scenario-helpers.ts). */
export interface FrameContextInputs {
  mode: Mode;
  phase: Phase;
  timer: number;
  paused: boolean;
  quitPending: boolean;
  hasLifeLostDialog: boolean;
  isSelectionReady: boolean;
  humanIsReselecting: boolean;
  myPlayerId: number;
  firstHumanPlayerId: number;
  isHost: boolean;
  remoteHumanSlots: ReadonlySet<number>;
  mobileAutoZoom: boolean;
}

/** Seconds before timer reaches 0 to trigger unzoom. */
const PHASE_ENDING_THRESHOLD = 1.5;
export const FOCUS_REMATCH: GameOverFocus = "rematch";
export const FOCUS_MENU: GameOverFocus = "menu";
export const CANNON_MODES: ReadonlySet<CannonMode> = new Set([
  CannonMode.NORMAL,
  CannonMode.SUPER,
  CannonMode.BALLOON,
]);

/** True if the cannon mode is normal. */
export function isNormalMode(mode: CannonMode): mode is CannonMode.NORMAL {
  return mode === CannonMode.NORMAL;
}

/** True if the cannon mode is super gun. */
export function isSuperMode(mode: CannonMode): mode is CannonMode.SUPER {
  return mode === CannonMode.SUPER;
}

/** True if the cannon mode is balloon. */
export function isBalloonMode(mode: CannonMode): mode is CannonMode.BALLOON {
  return mode === CannonMode.BALLOON;
}

/** True if the phase is castle selection (initial or reselect). */
export function isSelectionPhase(phase: Phase): boolean {
  return phase === Phase.CASTLE_SELECT || phase === Phase.CASTLE_RESELECT;
}

/** True if the phase is castle reselection specifically (not initial selection). */
export function isReselectPhase(phase: Phase): boolean {
  return phase === Phase.CASTLE_RESELECT;
}

/** True if the action is a directional movement. */
export function isMovementAction(action: Action): boolean {
  return (
    action === Action.UP ||
    action === Action.DOWN ||
    action === Action.LEFT ||
    action === Action.RIGHT
  );
}

export function createControlsState(): ControlsState {
  return { playerIdx: 0, actionIdx: 0, rebinding: false };
}

export function createTimerAccums(): TimerAccums {
  return {
    battle: 0,
    cannon: 0,
    select: 0,
    selectAnnouncement: 0,
    build: 0,
    grunt: 0,
  };
}

export function createBattleAnimState(): BattleAnimState {
  return { territory: [], walls: [], flights: [], impacts: [] };
}

/** True when a player can actively participate in zone-based gameplay. */
export function isPlayerActive(
  player: Player | null | undefined,
): player is Player & { homeTower: Tower } {
  return !!player && !player.eliminated && !!player.homeTower;
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
    myPlayerId,
    firstHumanPlayerId,
    isHost,
    remoteHumanSlots,
    mobileAutoZoom,
  } = inputs;

  const uiBlocking = paused || quitPending || hasLifeLostDialog;

  const timedPhase = isPlacementPhase(phase) || phase === Phase.BATTLE;
  const phaseEnding =
    !mobileAutoZoom &&
    timer > 0 &&
    timer <= PHASE_ENDING_THRESHOLD &&
    timedPhase;

  const shouldUnzoom = uiBlocking || phaseEnding;

  return {
    myPlayerId,
    firstHumanPlayerId,
    isHost,
    remoteHumanSlots,
    mode,
    phase,
    paused,
    quitPending,
    hasLifeLostDialog,
    isSelectionReady,
    humanIsReselecting,
    uiBlocking,
    phaseEnding,
    shouldUnzoom,
  };
}

/** True if the phase is a placement phase (walls or cannons). */
export function isPlacementPhase(phase: Phase): boolean {
  return phase === Phase.WALL_BUILD || phase === Phase.CANNON_PLACE;
}

/**
 * Compile-time exhaustiveness check for switch/if-else on enums.
 * A missing case makes `value` a concrete enum member instead of `never`,
 * producing a type error at the call site.
 */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
