import type { TilePos } from "./geometry-types.ts";
import type { ValidPlayerSlot } from "./player-slot.ts";

export interface Grunt extends TilePos {
  /** The player whose territory this grunt is attacking. Grunts are ownerless hazards. */
  victimPlayerId: ValidPlayerSlot;
  /** Locked target tower index. Stays until the tower is destroyed. */
  targetTowerIdx?: number;
  /** Countdown (seconds) before killing an adjacent tower or wall. Starts at 3 when adjacent. */
  attackCountdown?: number;
  /** Number of consecutive battles the grunt has been blocked (not adjacent to target tower).
   *  Initialized to 0 at spawn; incremented by updateGruntBlockedBattles at end of each battle. */
  blockedRounds: number;
  /** If true, this grunt is attacking a wall tile during battle (decided at battle start). */
  attackingWall?: boolean;
  /** Facing angle in radians (snapped to 90°). 0 = up. */
  facing?: number;
}

/** Cannon placement mode. */
export enum CannonMode {
  NORMAL = "normal",
  SUPER = "super",
  BALLOON = "balloon",
}

export interface Cannon extends TilePos {
  /** Hits remaining before destruction. Persists across rounds. */
  hp: number;
  /** Cannon variant: normal (2×2), super (3×3 incendiary), or balloon (2×2 propaganda). */
  mode: CannonMode;
  /** Facing angle in radians (snapped to 45° increments). 0 = up. */
  facing?: number;
  /** True when this cannon is the elected mortar for the current battle round. */
  mortar?: boolean;
  /** True when this cannon is shielded (immune to damage) for the current battle round. */
  shielded?: boolean;
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
  playerId: ValidPlayerSlot;
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
  /** If true, this is a mortar round — 3×3 splash damage + burning pit at center. */
  mortar?: boolean;
}

export interface CapturedCannon {
  /** The captured cannon reference. */
  cannon: Cannon;
  /** Index of the cannon in the victim's cannons array, or CANNON_NOT_FOUND (-1). */
  cannonIdx: number;
  /** The player who owns the captured cannon (victim). */
  victimId: ValidPlayerSlot;
  /** The player who owns the balloon (capturer). */
  capturerId: ValidPlayerSlot;
}

/** Result from nextReadyCombined — either an own cannon or a captured one. */
export type CombinedCannonResult =
  | { type: "own"; combinedIdx: number; ownIdx: number }
  | { type: "captured"; combinedIdx: number; captured: CapturedCannon };

/** Flight path for a balloon animation. */
export interface BalloonFlight {
  /** Start position in pixels (balloon base center). */
  startX: number;
  startY: number;
  /** Target position in pixels (captured cannon center). */
  endX: number;
  endY: number;
}

export interface Impact extends TilePos {
  /** Seconds since the impact occurred. */
  age: number;
}

export interface BurningPit extends TilePos {
  /** Battle rounds remaining before the pit expires. */
  roundsLeft: number;
}

export interface Crosshair {
  x: number;
  y: number;
  playerId: ValidPlayerSlot;
  cannonReady?: boolean;
}

/** Battle animation state — territory/wall snapshots and in-flight effects. */
export interface BattleAnimState {
  territory: Set<number>[];
  walls: Set<number>[];
  flights: readonly { flight: BalloonFlight; progress: number }[];
  impacts: Impact[];
}

/** A grunt waiting to spawn through a wall breach during build phase.
 *  Queued in enterBuildFromBattle, drained one-per-tick by tickBreachSpawnQueue. */
export interface BreachSpawnEntry {
  row: number;
  col: number;
  victimPlayerId: ValidPlayerSlot;
}

/** True if the cannon mode is super gun. */
export function isSuperMode(mode: CannonMode): mode is CannonMode.SUPER {
  return mode === CannonMode.SUPER;
}

/** True if the cannon mode is balloon. */
export function isBalloonMode(mode: CannonMode): mode is CannonMode.BALLOON {
  return mode === CannonMode.BALLOON;
}

export function createBattleAnimState(): BattleAnimState {
  return { territory: [], walls: [], flights: [], impacts: [] };
}

/** Clear all impact flashes (e.g. on phase transition to build). */
export function clearImpacts(battleAnim: { impacts: Impact[] }): void {
  battleAnim.impacts = [];
}

/** Age impact flashes by `dt` seconds and remove expired ones. */
export function ageImpacts(
  battleAnim: { impacts: Impact[] },
  dt: number,
  flashDuration: number,
): void {
  for (const imp of battleAnim.impacts) imp.age += dt;
  battleAnim.impacts = battleAnim.impacts.filter(
    (imp) => imp.age < flashDuration,
  );
}
