/**
 * Core types, interfaces, and constants for the game engine.
 */

import type { Castle, GameMap, TilePos, Tower } from "./geometry-types.ts";
import type { Rng } from "./rng.ts";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

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

/** True if the action is a directional movement. */
export function isMovementAction(action: Action): boolean {
  return (
    action === Action.UP ||
    action === Action.DOWN ||
    action === Action.LEFT ||
    action === Action.RIGHT
  );
}

/** Cannon placement mode. */
export enum CannonMode {
  NORMAL = "normal",
  SUPER = "super",
  BALLOON = "balloon",
}

// ---------------------------------------------------------------------------
// Cannon types & constants
// ---------------------------------------------------------------------------

export interface Cannon extends TilePos {
  /** Hits remaining before destruction. Persists across rounds. */
  hp: number;
  /** If true, this is a 3x3 super gun that fires incendiary cannonballs. */
  super?: boolean;
  /** If true, this is a propaganda balloon base (2x2). */
  balloon?: boolean;
  /** Facing angle in radians (snapped to 45° increments). 0 = up. */
  facing?: number;
}

/** Default hits needed to destroy a cannon. */
export const CANNON_MAX_HP = 3;
/** How many cannon slots a super gun costs. */
export const SUPER_GUN_COST = 4;
/** Size of a super gun in tiles. */
export const SUPER_GUN_SIZE = 3;
/** How many cannon slots a propaganda balloon costs. */
export const BALLOON_COST = 3;
/** Size of a balloon base in tiles. */
export const BALLOON_SIZE = 2;
/** Size of a normal cannon in tiles (2×2). */
export const NORMAL_CANNON_SIZE = 2;

// ---------------------------------------------------------------------------
// Battle types
// ---------------------------------------------------------------------------

/** A cannon captured by a propaganda balloon — fires for the balloon owner during battle. */
export interface CapturedCannon {
  /** The captured cannon reference. */
  cannon: Cannon;
  /** The player who owns the captured cannon (victim). */
  victimId: number;
  /** The player who owns the balloon (capturer). */
  capturerId: number;
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

/** Number of bonus squares per zone. */
export const BONUS_SQUARES_PER_ZONE = 3;
/** Minimum Manhattan distance between any two bonus squares. */
export const BONUS_SQUARE_MIN_DISTANCE = 3;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Territory points — tiered by number of interior squares (SNES table).
 * Thresholds are perfect squares: 1, 4, 9, 16, 25, 36, 49, 64, 81, 100.
 * Each entry is [minSquares, points].
 */
export const TERRITORY_POINT_TIERS: readonly [number, number][] = [
  [100, 1000],
  [81, 900],
  [64, 800],
  [49, 700],
  [36, 600],
  [25, 500],
  [16, 400],
  [9, 300],
  [4, 200],
  [1, 100],
];

/**
 * Castle bonus — escalating by number of "castle units" enclosed.
 * Home castle = 2 units, other castles = 1 unit each.
 * Index 0 = unused (0 units = no bonus).
 */
export const CASTLE_BONUS_TABLE: readonly number[] = [
  0, 500, 700, 900, 1000, 1200, 1400,
];

/** Destruction points for hitting a wall tile. */
export const DESTROY_WALL_POINTS = 2;
/** Destruction points for killing a grunt (enclosing or shooting). */
export const DESTROY_GRUNT_POINTS = 16;
/** Destruction points for destroying a cannon. */
export const DESTROY_CANNON_POINTS = 16;

// ---------------------------------------------------------------------------
// Player & Grunt
// ---------------------------------------------------------------------------

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

/** True when a player can actively participate in zone-based gameplay. */
export function isPlayerActive(
  player: Player | null | undefined,
): player is Player & { homeTower: Tower } {
  return !!player && !player.eliminated && !!player.homeTower;
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

// ---------------------------------------------------------------------------
// Tower & Build phase
// ---------------------------------------------------------------------------

/** Max cannons allowed in the first round. */
export const FIRST_ROUND_CANNONS = 3;
/** Duration of the battle phase in seconds. */
export const BATTLE_TIMER = 10;
/** Duration of the wall-build/repair phase in seconds. */
export const BUILD_TIMER = 25;
/** Duration of the cannon placement phase in seconds. */
export const CANNON_PLACE_TIMER = 15;
/** Duration of the castle selection phase in seconds. */
export const SELECT_TIMER = 10;
export const SELECT_ANNOUNCEMENT_DURATION = 2;
/** Duration of the pre-battle countdown in seconds (Ready 3s + Aim 2s + Fire! 1s). */
export const BATTLE_COUNTDOWN = 6;
/** Seconds for a grunt to destroy an adjacent tower or wall. */
export const GRUNT_ATTACK_DURATION = 3.0;
/** How many battle rounds a burning pit lasts. */
export const BURNING_PIT_DURATION = 3;
/** Balloon hits needed to capture a normal cannon. */
export const BALLOON_HITS_NEEDED = 1;
/** Balloon hits needed to capture a super gun. */
export const SUPER_BALLOON_HITS_NEEDED = 2;
/** Probability that a cannonball-destroyed house spawns a grunt. */
export const HOUSE_GRUNT_SPAWN_CHANCE = 0.5;
/** Probability that a blocked grunt rolls a wall attack each battle. */
export const GRUNT_WALL_ATTACK_CHANCE = 0.25;
/** Minimum consecutive blocked battles before a grunt is eligible for a wall attack. */
export const GRUNT_WALL_ATTACK_MIN_BATTLES = 2;
/** Probability that an enclosed grunt respawns on an enemy zone. */
export const ENCLOSED_GRUNT_RESPAWN_CHANCE = 0.5;
/** Probability per attempt that a grunt spawns on a player's zone between battles. */
export const INTERBATTLE_GRUNT_SPAWN_CHANCE = 0.1;
/** Number of spawn attempts per player between battles. */
export const INTERBATTLE_GRUNT_SPAWN_ATTEMPTS = 2;
/** First round that spawns grunts between battles. */
export const FIRST_GRUNT_SPAWN_ROUND = 2;
/** Number of lives each player starts with. */
export const STARTING_LIVES = 3;
/** Cannonball travel speed in pixels per second. */
export const BALL_SPEED = 150;
/** Scoring weight for super guns in balloon threat evaluation. */
export const SUPER_GUN_THREAT_WEIGHT = 100;
/** Maximum total cannon slots a reselecting player can earn. */
export const MAX_CANNON_LIMIT_ON_RESELECT = 8;

// ---------------------------------------------------------------------------
// UI / Animation timing
// ---------------------------------------------------------------------------

/** Balloon flight animation duration in seconds. */
export const BALLOON_FLIGHT_DURATION = 4.0;
/** Duration of the impact flash effect in seconds. */
export const IMPACT_FLASH_DURATION = 0.3;
/** Duration of phase-transition banner sweep in seconds. */
export const BANNER_DURATION = 3.0;
/** Duration of the player selection lobby in seconds. */
export const LOBBY_TIMER = 15;
/** Lobby timer seconds below which spam-to-skip is blocked. */
export const LOBBY_SKIP_LOCKOUT = 3;
/** Seconds subtracted per action press during lobby skip. */
export const LOBBY_SKIP_STEP = 1;
/** Interval between each wall tile during castle construction animation (ms). */
export const WALL_BUILD_INTERVAL = 160;
/** AI auto-continue delay in the life-lost dialog (seconds). */
export const LIFE_LOST_AI_DELAY = 2.0;
/** Maximum time before the life-lost dialog auto-resolves (seconds). */
export const LIFE_LOST_MAX_TIMER = 10.0;
/** Maximum frame delta time in seconds (caps large frame gaps). */
export const MAX_FRAME_DT = 0.1;
/** Duration to display score-delta popups (seconds). */
export const SCORE_DELTA_DISPLAY_TIME = 2;
/** Duration of host-migration announcement overlay (seconds). */
export const MIGRATION_ANNOUNCEMENT_DURATION = 3;

// ---------------------------------------------------------------------------
// Camera / zoom
// ---------------------------------------------------------------------------
/** Minimum zoom width as fraction of full map width. */
export const MIN_ZOOM_RATIO = 0.15;
/** Zoom viewport interpolation speed (higher = faster). */
export const ZOOM_LERP_SPEED = 6;
/** Maximum zoomed viewport as fraction of full map (prevents over-zoom). */
export const MAX_ZOOM_VIEWPORT_RATIO = 0.85;
/** Pinch threshold to snap to full map (fraction of full map width). */
export const PINCH_FULL_MAP_SNAP = 0.95;
/** Tile padding around player walls when computing zone bounds. */
export const ZONE_PAD_WITH_WALLS = 4;
/** Tile padding around zone tiles when player has no walls. */
export const ZONE_PAD_NO_WALLS = 1;
/** Seconds before timer reaches 0 to trigger unzoom. */
export const PHASE_ENDING_THRESHOLD = 1.5;
/** Seconds to wait before auto-zoom on first selection. */
export const SELECTION_ZOOM_DELAY = 2;
/** Pixel distance threshold for viewport lerp convergence snap. */
export const VIEWPORT_SNAP_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// House placement
// ---------------------------------------------------------------------------
/** Minimum Manhattan distance between any two houses. */
export const HOUSE_MIN_DISTANCE = 3;

// ---------------------------------------------------------------------------
// Game State
// ---------------------------------------------------------------------------

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
