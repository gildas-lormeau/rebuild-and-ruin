import type { BallisticTrajectory } from "./battle-events.ts";
import type {
  CannonIdx,
  PixelPos,
  TilePos,
  TowerIdx,
} from "./geometry-types.ts";
import type { TileKey } from "./grid.ts";
import type { ValidPlayerId } from "./player-slot.ts";
import { WALL_DESTROY_ANIM_DURATION } from "./wall-destroy-anim.ts";

export interface Grunt extends TilePos {
  /** Pathing target (a tower the grunt is walking toward) — used by
   *  `moveGrunts` during build phase. Sticky until the target's zone is
   *  eliminated, to avoid oscillation during frozen-river crossings.
   *  NOT the attack target: `gruntAttackTowers` computes that from the
   *  grunt's current zone each tick, so a grunt stranded in another
   *  zone attacks whatever tower is adjacent THERE, not this pathing
   *  goal (see "grunts attack towers in their current territory"). */
  targetTowerIdx?: TowerIdx;
  /** Countdown (seconds) before killing an adjacent tower or wall. Starts at 3 when adjacent. */
  attackCountdown?: number;
  /** Number of consecutive battles the grunt has been blocked (not adjacent to target tower).
   *  Initialized to 0 at spawn; incremented by updateGruntBlockedBattles at end of each battle. */
  blockedRounds: number;
  /** If true, this grunt is attacking a wall tile during battle (decided at battle start).
   *  Absent ≡ not attacking — every reader uses a truthy check, and the explicit-`false`
   *  state was indistinguishable from absent. */
  attackingWall?: true;
  /** Tile key of the wall this grunt would attack — the adjacent wall closest
   *  to its target tower. Computed once at end-of-build in `finalizeRoundCleanup`,
   *  cleared when that wall is destroyed mid-battle (no recompute — grunts
   *  don't move during battle), reset on every grunt at battle end. Read by
   *  sapper's reveal banner and by `gruntAttackTowers`'s wall pick. Derived
   *  from synced state — not serialized. */
  targetedWall?: TileKey;
  /** Facing angle in radians (snapped to 90°). 0 = up. */
  facing?: number;
  /** True after this grunt has absorbed one frostbite hit (next hit kills).
   *  Set only when frostbite is the active modifier; otherwise ignored. Lives
   *  on the grunt itself so chip state dies when the grunt dies — no separate
   *  tile-key tracker to keep in sync. Stale flags from a prior frostbite
   *  round are reset in `frostbiteImpl.apply` if frostbite re-rolls. */
  chipped?: true;
  /** Optional variant tag. Absence = regular grunt. "catapult" = slower
   *  variant that can attack towers from Manhattan distance ≤ 3 (bypasses
   *  up to two rows of cannons shielding the tower). Gated by the
   *  "catapults" feature. */
  kind?: "catapult";
  /** Catapult-only: toggles each build-phase movement tick. When true, the
   *  catapult skips this tick (half movement speed). Cleared on skip; set
   *  after a move. Ignored for regular grunts. */
  slowSkip?: true;
}

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
  mortar?: true;
  /** True when this cannon is shielded (immune to damage) for the current battle round. */
  shielded?: true;
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

/** A live cannonball: the originator-pinned trajectory plus the per-tick
 *  cursor (current position, elapsed time, current altitude) and SFX
 *  bookkeeping. Trajectory fields live on BallisticTrajectory so the wire
 *  format stays in lockstep — see CannonFiredMessage. */
export interface Cannonball extends BallisticTrajectory {
  /** Current position in pixels (sub-tile precision). Derived each
   *  tick from the parametric trajectory — never the primary source of
   *  truth, but exposed here so overlays/checkpoints can read it
   *  without recomputing. */
  x: number;
  y: number;
  /** Seconds elapsed since launch. Advanced by dt every tick. */
  elapsed: number;
  /** Current altitude in world units. Recomputed each tick from the
   *  parametric trajectory (cache — renderer reads it directly). */
  altitude: number;
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
  cannonIdx: CannonIdx;
  /** The player who owns the captured cannon (victim). */
  victimId: ValidPlayerId;
  /** The player who owns the balloon (capturer). */
  capturerId: ValidPlayerId;
}

/** Result from nextReadyCannon — either an own cannon or a captured one. */
export type CombinedCannonResult =
  | { type: "own"; combinedIdx: number; ownIdx: CannonIdx }
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

export interface Crosshair extends PixelPos {
  playerId: ValidPlayerId;
  cannonReady?: boolean;
}

/** A tile that was recently thawed — drives the crack-and-fade animation. */
export interface ThawingTile extends TilePos {
  /** Seconds since the tile was thawed. */
  age: number;
}

/** A tile where a wall was recently destroyed by cannonball or grunt
 *  impact — drives the unified destruction animation (sink + dust +
 *  held-mesh + fire/smoke burst). Pure visual state; renderer derives
 *  per-tile variation from `(row, col)` via tileSeed.
 *
 *  `damaged` and `playerId` are captured at destruction time so the
 *  held-mesh path can render the correct shell variant + ownership tint
 *  while the wall is mid-animation (the live wall set has already
 *  dropped this tile). */
export interface DestroyedWall extends TilePos {
  /** Seconds since the wall was destroyed. */
  age: number;
  /** True if the wall was in the damaged-shell state at destruction
   *  time (reinforced-walls upgrade). Drives the held-mesh shell variant. */
  damaged: boolean;
  /** Owner of the destroyed wall — used by the held-mesh path for the
   *  per-player material tint. */
  playerId: ValidPlayerId;
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

/** A tile where a defensive shield absorbed an incoming hit — rampart-
 *  protected wall (wallShielded event) or Shield-Battery-protected
 *  cannon (cannonShielded event). Drives a brief cyan ring expand-and-
 *  fade. Pure visual state. */
export interface ShieldFlash extends TilePos {
  /** Seconds since the absorb happened. */
  age: number;
}

/** Battle animation state — territory/wall snapshots and in-flight effects. */
export interface BattleAnimState {
  territory: Set<TileKey>[];
  walls: Set<TileKey>[];
  flights: readonly { flight: BalloonFlight; progress: number }[];
  impacts: Impact[];
  thawing: ThawingTile[];
  destroyedWalls: DestroyedWall[];
  cannonDestroys: CannonDestroy[];
  gruntKills: GruntKill[];
  houseDestroys: HouseDestroy[];
  shieldFlashes: ShieldFlash[];
}

/** Duration of the ice-thaw crack-and-fade animation (seconds). */
export const THAW_DURATION = 0.6;
/** Duration of the fire/smoke burst layered on top of `impact`-cause
 *  destructions (seconds). The fire plays AFTER the sink + dust + tail-
 *  fade window completes, so the wall has visibly collapsed before the
 *  explosion flash + smoke. The wall-burns manager filters
 *  `destroyedWalls` to entries with `age >= WALL_DESTROY_ANIM_DURATION`
 *  AND `age < WALL_DESTROY_ANIM_DURATION + WALL_BURN_DURATION`, and
 *  re-bases each entry's `age` to fire-relative time so the kernel sees
 *  a normal 0..duration timeline. */
export const WALL_BURN_DURATION = 0.25;
/** Total impact-entry lifetime: sink phase + fire phase. The entry is
 *  kept alive long enough for both visual phases to play; ageImpacts
 *  purges past this. */
const IMPACT_ENTRY_LIFETIME = WALL_DESTROY_ANIM_DURATION + WALL_BURN_DURATION;
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
/** Duration of the shield-absorb cyan ring expand-and-fade (seconds).
 *  Short and clean — the absorb is a non-event for the protected entity,
 *  the ping just communicates "your shield ate that hit". */
export const SHIELD_FLASH_DURATION = 0.5;

export function createBattleAnimState(): BattleAnimState {
  return {
    territory: [],
    walls: [],
    flights: [],
    impacts: [],
    thawing: [],
    destroyedWalls: [],
    cannonDestroys: [],
    gruntKills: [],
    houseDestroys: [],
    shieldFlashes: [],
  };
}

/** Clear all transient battle effect animations (e.g. on phase transition to build). */
export function clearImpacts(battleAnim: {
  impacts: Impact[];
  thawing: ThawingTile[];
  destroyedWalls: DestroyedWall[];
  cannonDestroys: CannonDestroy[];
  gruntKills: GruntKill[];
  houseDestroys: HouseDestroy[];
  shieldFlashes: ShieldFlash[];
}): void {
  battleAnim.impacts = [];
  battleAnim.thawing = [];
  battleAnim.destroyedWalls = [];
  battleAnim.cannonDestroys = [];
  battleAnim.gruntKills = [];
  battleAnim.houseDestroys = [];
  battleAnim.shieldFlashes = [];
}

/** Age transient battle effect animations by `dt` seconds and remove expired ones. */
export function ageImpacts(
  battleAnim: {
    impacts: Impact[];
    thawing: ThawingTile[];
    destroyedWalls: DestroyedWall[];
    cannonDestroys: CannonDestroy[];
    gruntKills: GruntKill[];
    houseDestroys: HouseDestroy[];
    shieldFlashes: ShieldFlash[];
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
  for (const wall of battleAnim.destroyedWalls) wall.age += dt;
  battleAnim.destroyedWalls = battleAnim.destroyedWalls.filter(
    (wall) => wall.age < IMPACT_ENTRY_LIFETIME,
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
  for (const flash of battleAnim.shieldFlashes) flash.age += dt;
  battleAnim.shieldFlashes = battleAnim.shieldFlashes.filter(
    (flash) => flash.age < SHIELD_FLASH_DURATION,
  );
}

/** True if a cannon still has hit points remaining. */
export function isCannonAlive(cannon: Pick<Cannon, "hp">): boolean {
  return cannon.hp > 0;
}

export function isBalloonCannon(cannon: {
  mode: CannonMode;
}): cannon is { mode: CannonMode.BALLOON } {
  return cannon.mode === CannonMode.BALLOON;
}

/** True if a cannon is a super gun (3×3 incendiary). */
export function isSuperCannon(cannon: {
  mode: CannonMode;
}): cannon is { mode: CannonMode.SUPER } {
  return cannon.mode === CannonMode.SUPER;
}

/** True if a cannon is a rampart (defensive wall shield). */
export function isRampartCannon(cannon: {
  mode: CannonMode;
}): cannon is { mode: CannonMode.RAMPART } {
  return cannon.mode === CannonMode.RAMPART;
}
