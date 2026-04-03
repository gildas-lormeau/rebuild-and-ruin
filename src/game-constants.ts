/**
 * Pure numeric/string/array game constants — no type dependencies.
 */

/** Game mode: classic (original Rampart rules) or modern (environmental modifiers). */

export type GameMode = "classic" | "modern";

/** Identifier for a round modifier (modern mode only). */
export type ModifierId =
  | "wildfire"
  | "crumbling_walls"
  | "grunt_surge"
  | "frozen_river";

/** A player's slot id in an online session, or SPECTATOR_SLOT (-1) for watchers.
 *  Always check with `isActivePlayer()` before using as an array index. */
export type PlayerSlotId = number;

/** Narrowed PlayerSlotId that passed the `isActivePlayer()` guard (>= 0).
 *  Safe to use as an index into `state.players` or `controllers`.
 *
 *  `as ValidPlayerSlot` casts are acceptable in three cases:
 *  1. Loop index bounded by playerCount: `for (let i = 0; i < playerCount; i++)`
 *  2. Server-validated message field: `msg.playerId as ValidPlayerSlot`
 *  3. Value just checked locally: `if (id >= 0) … id as ValidPlayerSlot`
 *  Prefer `isActivePlayer()` type guard when possible. */
export type ValidPlayerSlot = number & { readonly __validSlot: true };

/** Human-readable labels for modifier IDs (used by HUD and banners). */
const MODIFIER_LABELS: Record<ModifierId, string> = {
  wildfire: "Wildfire",
  crumbling_walls: "Crumbling Walls",
  grunt_surge: "Grunt Surge",
  frozen_river: "Frozen River",
};
/** Named constants for modifier IDs — use these instead of raw string literals. */
export const MODIFIER_ID = {
  WILDFIRE: "wildfire",
  CRUMBLING_WALLS: "crumbling_walls",
  GRUNT_SURGE: "grunt_surge",
  FROZEN_RIVER: "frozen_river",
} as const satisfies Record<string, ModifierId>;
export const GAME_MODE_CLASSIC: GameMode = "classic";
export const GAME_MODE_MODERN: GameMode = "modern";
/** First round that can roll a modifier (modern mode). */
export const MODIFIER_FIRST_ROUND = 3;
/** Probability that any modifier fires on an eligible round. */
export const MODIFIER_ROLL_CHANCE = 0.65;
export const CANNON_MAX_HP = 3;
/** How many cannon slots a super gun costs. */
export const SUPER_GUN_COST = 4;
/** Size of a super gun in tiles. */
export const SUPER_GUN_SIZE = 3;
/** How many cannon slots a propaganda balloon costs. */
export const BALLOON_COST = 3;
/** Size of a balloon base in tiles. */
export const BALLOON_SIZE = 2;
/** Size of a normal cannon in tiles (2x2). */
export const NORMAL_CANNON_SIZE = 2;
/** Number of bonus squares per zone. */
export const BONUS_SQUARES_PER_ZONE = 3;
/** Minimum Manhattan distance between any two bonus squares. */
export const BONUS_SQUARE_MIN_DISTANCE = 3;
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
export const SELECT_ANNOUNCEMENT_DURATION = 1;
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
/** Interval between grunt movement ticks during build phase (seconds). */
export const GRUNT_TICK_INTERVAL = 1.0;
/** Scoring weight for super guns in balloon threat evaluation. */
export const SUPER_GUN_THREAT_WEIGHT = 100;
/** Maximum total cannon slots a reselecting player can earn. */
export const MAX_CANNON_LIMIT_ON_RESELECT = 8;
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
/** Auto-resolve delay in the life-lost dialog (seconds). */
export const LIFE_LOST_AUTO_DELAY = 2.0;
/** Maximum time before the life-lost dialog auto-resolves (seconds). */
export const LIFE_LOST_MAX_TIMER = 10.0;
/** Maximum frame delta time in seconds (caps large frame gaps). */
export const MAX_FRAME_DT = 0.1;
/** Duration to display score-delta popups (seconds). */
export const SCORE_DELTA_DISPLAY_TIME = 2;
/** Duration of host-migration announcement overlay (seconds). */
export const MIGRATION_ANNOUNCEMENT_DURATION = 3;
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
/** Tile padding around tower during selection zoom. */
export const ZONE_PAD_SELECTION = 7;
/** Pixel distance threshold for viewport lerp convergence snap. */
export const VIEWPORT_SNAP_THRESHOLD = 0.5;
/** Minimum Manhattan distance between any two houses. */
export const HOUSE_MIN_DISTANCE = 3;
/** Tower footprint size in tiles (towers are 2×2). */
export const TOWER_SIZE = 2;
/** Sentinel value for myPlayerId: client joined but did not select a slot.
 *  Spectators can watch the game but not control any player. If promoted to host
 *  (original host disconnects), all players become AI. */
export const SPECTATOR_SLOT = -1;

/** Type guard: true if this is a valid player slot (not spectating).
 *  Narrows `PlayerSlotId` to `ValidPlayerSlot` in the true branch. */
export function isActivePlayer(
  playerId: PlayerSlotId,
): playerId is ValidPlayerSlot {
  return playerId >= 0;
}

/** Human-readable label for a modifier id. */
export function modifierLabel(id: ModifierId): string {
  return MODIFIER_LABELS[id];
}
