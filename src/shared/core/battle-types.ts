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
  RAMPART = "rampart",
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
  /** Shield HP pool for rampart mode. Decremented when rampart absorbs a nearby wall hit.
   *  Separate from `hp` (direct-hit durability). Only used for RAMPART cannons. */
  shieldHp?: number;
  /** Cumulative balloon hits toward capture threshold. Persists across battles.
   *  Cleared when cannon is captured or destroyed. */
  balloonHits?: number;
  /** Players who contributed balloon hits THIS battle. Reset each battle by
   *  cleanupBalloonHitTrackingAfterBattle — only the deciding battle's
   *  contributors can claim the capture. */
  balloonCapturerIds?: number[];
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
   *  They differ only when a cannon was captured by a balloon.
   *
   *  Typed as ValidPlayerSlot (not raw number) to match playerId — every
   *  producer already passes a branded slot id. */
  scoringPlayerId?: ValidPlayerSlot;
  /** If true, leaves a burning pit on impact (fired from super gun). */
  incendiary?: boolean;
  /** If true, this is a mortar round — 3×3 splash damage + burning pit at center. */
  mortar?: boolean;
  /** Set once after the descent-whistle bus event has fired for this ball.
   *  Prevents the SFX from retriggering every frame while the ball is in
   *  the trigger window. Undefined on fresh balls (not yet whistled). */
  whistled?: true;
  /** Firework-whistle variant index chosen at launch time. The variant is
   *  picked so its full duration fits in the remaining travel window —
   *  the built-in "pop" at the tail of the sample lands precisely at
   *  impact rather than overlapping the explosion SFX. The variant →
   *  sample mapping lives in sfx-player (game state stays asset-agnostic);
   *  the variant → duration mapping stays in battle-system where the
   *  physics lookup runs. Undefined on balls whose total trajectory is
   *  too short for any variant (skip the whistle entirely). */
  whistleVariant?: number;
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

/** A tile that was recently thawed — drives the crack-and-fade animation. */
export interface ThawingTile extends TilePos {
  /** Seconds since the tile was thawed. */
  age: number;
}

/** A tile where a wall was recently destroyed — drives the fire/smoke
 *  burst animation. Pure visual state; renderer derives all per-flame
 *  variation from `(row, col)` via tileSeed. */
export interface WallBurn extends TilePos {
  /** Seconds since the wall was destroyed. */
  age: number;
}

/** A cannon footprint where the cannon was just destroyed — drives a
 *  larger / denser cousin of the wall-burn burst, scaled to the cannon's
 *  2×2 / 3×3 size. Pure visual state. */
export interface CannonDestroy extends TilePos {
  /** Cannon footprint size in tiles (2 for normal/balloon/rampart, 3 for super). */
  size: number;
  /** Seconds since the cannon was destroyed. */
  age: number;
}

/** A tile where a grunt (tank) was just killed — drives a small
 *  fire/smoke/spark burst scaled to a 1×1 tile. Pure visual state. */
export interface GruntKill extends TilePos {
  /** Seconds since the grunt was killed. */
  age: number;
}

/** A tile where a house was just destroyed — drives a 1×1 collapse
 *  burst (fire + smoke + debris sparks). Pure visual state. */
export interface HouseDestroy extends TilePos {
  /** Seconds since the house was destroyed. */
  age: number;
}

/** Battle animation state — territory/wall snapshots and in-flight effects. */
export interface BattleAnimState {
  territory: Set<number>[];
  walls: Set<number>[];
  flights: readonly { flight: BalloonFlight; progress: number }[];
  impacts: Impact[];
  thawing: ThawingTile[];
  wallBurns: WallBurn[];
  cannonDestroys: CannonDestroy[];
  gruntKills: GruntKill[];
  houseDestroys: HouseDestroy[];
}

/** Duration of the ice-thaw crack-and-fade animation (seconds). */
export const THAW_DURATION = 0.6;
/** Duration of the destroyed-wall fire/smoke burst (seconds). Matches
 *  the demo TTL — long enough to read as a real burst, short enough to
 *  not delay the post-battle banner. */
export const WALL_BURN_DURATION = 0.7;
/** Duration of the destroyed-cannon fire/smoke burst (seconds). Slightly
 *  longer than wall-burns so the heavier blast has time to read. */
export const CANNON_DESTROY_DURATION = 0.9;
/** Duration of the killed-grunt (tank) burst (seconds). Short and
 *  punchy — grunts are 1×1 and the battle keeps moving. */
export const GRUNT_KILL_DURATION = 0.55;
/** Duration of the destroyed-house burst (seconds). Between wall and
 *  cannon — a small building collapse reads longer than a single wall
 *  tile exploding. */
export const HOUSE_DESTROY_DURATION = 0.75;

/** True if the cannon mode is super gun. */
export function isSuperMode(mode: CannonMode): mode is CannonMode.SUPER {
  return mode === CannonMode.SUPER;
}

/** True if the cannon mode is balloon. */
export function isBalloonMode(mode: CannonMode): mode is CannonMode.BALLOON {
  return mode === CannonMode.BALLOON;
}

/** True if the cannon mode is rampart (defensive wall shield). */
export function isRampartMode(mode: CannonMode): mode is CannonMode.RAMPART {
  return mode === CannonMode.RAMPART;
}

export function createBattleAnimState(): BattleAnimState {
  return {
    territory: [],
    walls: [],
    flights: [],
    impacts: [],
    thawing: [],
    wallBurns: [],
    cannonDestroys: [],
    gruntKills: [],
    houseDestroys: [],
  };
}

/** Clear all transient battle effect animations (e.g. on phase transition to build). */
export function clearImpacts(battleAnim: {
  impacts: Impact[];
  thawing: ThawingTile[];
  wallBurns: WallBurn[];
  cannonDestroys: CannonDestroy[];
  gruntKills: GruntKill[];
  houseDestroys: HouseDestroy[];
}): void {
  battleAnim.impacts = [];
  battleAnim.thawing = [];
  battleAnim.wallBurns = [];
  battleAnim.cannonDestroys = [];
  battleAnim.gruntKills = [];
  battleAnim.houseDestroys = [];
}

/** Age transient battle effect animations by `dt` seconds and remove expired ones. */
export function ageImpacts(
  battleAnim: {
    impacts: Impact[];
    thawing: ThawingTile[];
    wallBurns: WallBurn[];
    cannonDestroys: CannonDestroy[];
    gruntKills: GruntKill[];
    houseDestroys: HouseDestroy[];
  },
  dt: number,
  flashDuration: number,
): void {
  for (const imp of battleAnim.impacts) imp.age += dt;
  battleAnim.impacts = battleAnim.impacts.filter(
    (imp) => imp.age < flashDuration,
  );
  for (const th of battleAnim.thawing) th.age += dt;
  battleAnim.thawing = battleAnim.thawing.filter(
    (th) => th.age < THAW_DURATION,
  );
  for (const burn of battleAnim.wallBurns) burn.age += dt;
  battleAnim.wallBurns = battleAnim.wallBurns.filter(
    (burn) => burn.age < WALL_BURN_DURATION,
  );
  for (const destroy of battleAnim.cannonDestroys) destroy.age += dt;
  battleAnim.cannonDestroys = battleAnim.cannonDestroys.filter(
    (destroy) => destroy.age < CANNON_DESTROY_DURATION,
  );
  for (const kill of battleAnim.gruntKills) kill.age += dt;
  battleAnim.gruntKills = battleAnim.gruntKills.filter(
    (kill) => kill.age < GRUNT_KILL_DURATION,
  );
  for (const destroy of battleAnim.houseDestroys) destroy.age += dt;
  battleAnim.houseDestroys = battleAnim.houseDestroys.filter(
    (destroy) => destroy.age < HOUSE_DESTROY_DURATION,
  );
}
