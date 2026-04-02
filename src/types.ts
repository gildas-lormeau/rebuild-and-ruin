/**
 * Core types, interfaces, and constants for the game engine.
 */

import type { GameMode, ModifierId } from "./game-constants.ts";
import type { Castle, GameMap, TilePos, Tower } from "./geometry-types.ts";
import type { Rng } from "./rng.ts";
import type { UpgradeId } from "./upgrade-defs.ts";

export enum Phase {
  CASTLE_SELECT = "CASTLE_SELECT",
  CASTLE_RESELECT = "CASTLE_RESELECT",
  WALL_BUILD = "WALL_BUILD",
  CANNON_PLACE = "CANNON_PLACE",
  BATTLE = "BATTLE",
}

/** Input action names returned by matchKey / used in key dispatch.
 *  ROTATE is context-dependent: rotates piece in WALL_BUILD,
 *  cycles cannon mode in CANNON_PLACE, and sprints crosshair in BATTLE. */
export enum Action {
  UP = "up",
  DOWN = "down",
  LEFT = "left",
  RIGHT = "right",
  CONFIRM = "confirm",
  /** Rotate piece (build), cycle cannon mode (cannon), sprint crosshair (battle). */
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
  UPGRADE_PICK,
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
  /** Owner player id — the player whose cannon fired this ball.
   *  Used for in-flight tracking (index into this player's cannons array).
   *  NOT necessarily who gets scoring credit — see scoringPlayerId. */
  playerId: number;
  /** Player who receives scoring credit for this cannonball's impacts.
   *  Set to capturerId when this cannon was captured by a propaganda balloon.
   *  When undefined, defaults to playerId (normal cannon fire).
   *  Always use: `const shooter = ball.scoringPlayerId ?? ball.playerId`
   *
   *  Key distinction: playerId = cannon owner, scoringPlayerId = point receiver.
   *  They differ only when a cannon was captured by a balloon. */
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

/** Branded ReadonlySet<number> proving that interior was recomputed after the
 *  last wall mutation. Only produced by `markInteriorFresh` (board-occupancy)
 *  and `emptyFreshInterior` (initial construction / deserialization).
 *  Consumers can read `.has()` / `.size` / iterate freely — the brand carries
 *  through because FreshInterior extends ReadonlySet<number>. */
export type FreshInterior = ReadonlySet<number> & {
  readonly __brand: "FreshInterior";
};

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
  /** Enclosed territory: grass tiles fully surrounded by walls (inverse flood-fill),
   *  encoded as row*COLS+col. Determines cannon eligibility, grunt blocking, and scoring.
   *  Branded as FreshInterior — only recomputeInterior(), resetCastle(),
   *  and checkpoint deserialization may write to it. */
  interior: FreshInterior;
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
  /** Castle wall tiles (including clumsy extras) — protected from debris sweep. */
  castleWallTiles: ReadonlySet<number>;
  /** Active upgrades for this player (modern mode only). Key = upgrade id, value = stack count. */
  upgrades: Map<UpgradeId, number>;
  /** Wall tiles that have absorbed one hit (reinforced walls upgrade).
   *  Cleared at build phase start. Second hit destroys normally. */
  damagedWalls: Set<number>;
}

export interface Grunt extends TilePos {
  /** Which player's territory this grunt is attacking. */
  targetPlayerId: number;
  /** Locked target tower index. Stays until the tower is destroyed. */
  targetTowerIdx?: number;
  /** Countdown (seconds) before killing an adjacent tower or wall. Starts at 3 when adjacent. */
  attackTimer?: number;
  /** Number of consecutive battles the grunt has been blocked (not adjacent to target tower).
   *  Initialized to 0 at spawn; incremented by updateGruntBlockedBattles at end of each battle. */
  blockedBattles: number;
  /** If true, this grunt is attacking a wall tile during battle (decided at battle start). */
  wallAttack?: boolean;
  /** Facing angle in radians (snapped to 90°). 0 = up. */
  facing?: number;
}

export interface GameState {
  /** Shared seeded RNG for deterministic gameplay decisions.
   *  Available methods: .next() → [0,1), .int(lo,hi), .bool(prob),
   *  .pick(arr), .shuffle(arr). See rng.ts for full API. */
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
  /** Remaining time in seconds for timed phases (counts DOWN from phase max to 0).
   *
   *  Host: computed by advancePhaseTimer() as `timer = max - elapsed`, where elapsed
   *  is accumulated in TimerAccums per frame. This is the authoritative source.
   *
   *  Watcher: recomputed each frame as `timer = phaseDuration - (now - phaseStart)`,
   *  using wall-clock time since the watcher doesn't run the host tick loop.
   *  Both converge to the same value but the computation path differs by role.
   *
   *  Check `timer > 0` for "time left". Never write `timer -= dt` directly. */
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
  /** Countdown before battle starts (Ready/Aim/Fire). 0 = battle active.
   *  Phase-dependent: only meaningful when `state.phase === Phase.BATTLE`. */
  battleCountdown: number;
  /** Players who reselected a castle since the last cannon phase setup. */
  reselectedPlayers: Set<number>;
  /** Zone index assigned to each player (indexed by player id). Set at game start. */
  playerZones: number[];
  /** Cannon slot limits per player for the current cannon phase.
   *  Computed by computeCannonLimitsForPhase at CANNON_PLACE start.
   *  Phase-dependent: only meaningful when `state.phase === Phase.CANNON_PLACE`.
   *  Always guard: `if (state.phase === Phase.CANNON_PLACE) { ... state.cannonLimits ... }` */
  cannonLimits: number[];
  /** Game mode: classic (original rules) or modern (environmental modifiers). Immutable for the match. */
  gameMode: GameMode;
  /** Active modifier for the current round (modern mode only). null = none. */
  activeModifier: ModifierId | null;
  /** Previous round's modifier id (for no-repeat rule). null = none. */
  lastModifierId: ModifierId | null;
  /** Combo scoring tracker (modern mode, transient during battle, not serialized). */
  comboTracker: {
    players: {
      lastWallHitTime: number;
      wallStreak: number;
      lastGruntKillTime: number;
      gruntStreak: number;
      roundWalls: number;
    }[];
    /** Combo events for floating text display. Aged by the renderer, removed when expired. */
    events: { text: string; age: number; playerId: number }[];
  } | null;
  /** Pre-generated upgrade offers per player for the current round (modern mode).
   *  Generated in enterBuildFromBattle using synced RNG, consumed by the upgrade pick dialog.
   *  null in classic mode or before UPGRADE_FIRST_ROUND. */
  pendingUpgradeOffers: Map<number, [UpgradeId, UpgradeId, UpgradeId]> | null;
  /** Frozen river tiles (packed tile keys) — water tiles that grunts can cross.
   *  Set during battle when frozen_river modifier is active, null otherwise. */
  frozenTiles: Set<number> | null;
}

/** Battle animation state — territory/wall snapshots and in-flight effects. */
export interface BattleAnimState {
  territory: Set<number>[];
  walls: Set<number>[];
  flights: readonly { flight: BalloonFlight; progress: number }[];
  impacts: Impact[];
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

/** Per-player state during castle selection (highlighted tower, confirm status). */
export interface SelectionState {
  highlighted: number;
  confirmed: boolean;
  /** True once the user has tapped/clicked the highlighted tower once,
   *  enabling confirmation on the second tap. Reset on pointer-move to a
   *  different tower. Used by touch input to require a deliberate double-tap. */
  towerAlreadyHighlighted?: boolean;
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
  /** Which button is focused: LIFE_LOST_FOCUS_CONTINUE (0) or LIFE_LOST_FOCUS_ABANDON (1). */
  focused: number;
}

export interface LifeLostDialogState {
  entries: LifeLostEntry[];
  timer: number;
}

export interface UpgradePickEntry {
  playerId: number;
  offers: readonly [UpgradeId, UpgradeId, UpgradeId];
  choice: UpgradeId | null;
  isAi: boolean;
  aiTimer: number;
  /** Which offer card is focused (0, 1, or 2). */
  focused: number;
}

export interface UpgradePickDialogState {
  entries: UpgradePickEntry[];
  timer: number;
}

/** Mutable state for the controls-rebinding screen. */
export interface ControlsState {
  playerIdx: number;
  actionIdx: number;
  rebinding: boolean;
}

/** Which button is focused in the life-lost dialog. */
export const LIFE_LOST_FOCUS_CONTINUE = 0;
export const LIFE_LOST_FOCUS_ABANDON = 1;
export const FOCUS_REMATCH: GameOverFocus = "rematch";
export const FOCUS_MENU: GameOverFocus = "menu";
export const CANNON_MODES: ReadonlySet<CannonMode> = new Set([
  CannonMode.NORMAL,
  CannonMode.SUPER,
  CannonMode.BALLOON,
]);

/** Create a branded empty interior set. Use at Player creation. */
export function emptyFreshInterior(): FreshInterior {
  return new Set<number>() as unknown as FreshInterior;
}

/** Brand an existing set as fresh interior. Use at checkpoint
 *  deserialization where the set is constructed from trusted data. */
export function brandFreshInterior(set: ReadonlySet<number>): FreshInterior {
  return set as FreshInterior;
}

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

export function createBattleAnimState(): BattleAnimState {
  return { territory: [], walls: [], flights: [], impacts: [] };
}

/** Type guard: player exists and is not eliminated.
 *  Use this instead of the `!player || player.eliminated` pattern. */
export function isPlayerAlive(
  player: Player | null | undefined,
): player is Player {
  return !!player && !player.eliminated;
}

/** True when a player has selected a castle and can actively participate. */
export function isPlayerSeated(
  player: Player | null | undefined,
): player is Player & { homeTower: Tower } {
  return !!player && !player.eliminated && !!player.homeTower;
}

/** True if the phase is a placement phase (walls or cannons). */
export function isPlacementPhase(phase: Phase): boolean {
  return phase === Phase.WALL_BUILD || phase === Phase.CANNON_PLACE;
}

/** Mode allows direct gameplay interaction (active game or tower selection).
 *  Use this instead of `mode === Mode.GAME || mode === Mode.SELECTION`. */
export function isInteractiveMode(mode: Mode): boolean {
  return mode === Mode.GAME || mode === Mode.SELECTION;
}

/** Mode represents an in-game screen that should be paused/ticked (not lobby/options/stopped).
 *  Use this instead of negated multi-mode checks. */
export function isGameplayMode(mode: Mode): boolean {
  return (
    mode !== Mode.LOBBY &&
    mode !== Mode.OPTIONS &&
    mode !== Mode.CONTROLS &&
    mode !== Mode.STOPPED
  );
}

export function createControlsState(): ControlsState {
  return { playerIdx: 0, actionIdx: 0, rebinding: false };
}

/** True if the mode is a non-interactive transition (banner, balloon anim, castle build). */
export function isTransitionMode(mode: Mode): boolean {
  return (
    mode === Mode.BANNER ||
    mode === Mode.BALLOON_ANIM ||
    mode === Mode.CASTLE_BUILD
  );
}
