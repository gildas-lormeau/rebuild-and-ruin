/**
 * AI battle-phase dispatcher: target picking (`pickTarget`), per-cannon shot
 * tracking (`trackShot`), `countUsableCannons`, and the shared helpers used
 * across the per-tactic `ai-plan-*` planner files (`findEnclosureComponents`,
 * the cross-tactic `DESTROY_POCKET_MAX_SIZE` threshold, and the
 * `BattleTargetMemory`/`ShotKey` types).
 */

import {
  aimRedirectsOntoTower,
  canFireOwnCannon,
  getGruntTargetTower,
  pickSupplyShipTarget,
  shouldAbsorbWallHit,
} from "../game/index.ts";
import {
  type Cannon,
  type Cannonball,
  isBalloonCannon,
  isCannonAlive,
  isSuperCannon,
} from "../shared/core/battle-types.ts";
import type {
  CannonIdx,
  PixelPos,
  TileBounds,
  TilePos,
} from "../shared/core/geometry-types.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  TILE_SIZE,
  type TileKey,
} from "../shared/core/grid.ts";
import {
  isPlayerEliminated,
  type ValidPlayerId,
} from "../shared/core/player-slot.ts";
import { type Player } from "../shared/core/player-types.ts";
import {
  cannonSize,
  computeOutside,
  DIRS_4,
  DIRS_8,
  filterOffTiles,
  forEachTowerTile,
  inBounds,
  isCannonTile,
  manhattanDistance,
  packTile,
  pxToTile,
  unpackTile,
  zoneAt,
  zoneTileBounds,
} from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import type { Rng } from "../shared/platform/rng.ts";
import {
  computeCardinalObstacleMask,
  filterActiveEnemies,
  getBattleInterior,
} from "../shared/sim/board-occupancy.ts";
import { isCannonCapturedBy } from "../shared/sim/occupancy-queries.ts";
import type { PickPath } from "./ai-battle-diag.ts";
import type { StrategicPixelPos } from "./ai-strategy-types.ts";
import { traitLookup } from "./ai-utils.ts";

type TargetCandidate = TilePos & {
  priority: boolean;
  isCannon?: boolean;
};

/** Persistent target memory — keeps the AI locked onto one enclosure across
 *  shots so it doesn't oscillate between random enclosures. The anchor is any
 *  interior tile of the chosen enclosure; reuse lasts as long as that tile is
 *  still inside an eligible enemy's interior. */
export type BattleTargetMemory = {
  ownerId: ValidPlayerId | undefined;
  anchorTileKey: TileKey | undefined;
  /** Last enclosure-wall tile this player aimed at — so consecutive shots
   *  walk along one contiguous segment (concentrate into a breach) instead
   *  of scattering across the enclosure perimeter. Reset on enclosure switch. */
  lastWallTileKey: TileKey | undefined;
};

/** Packed `(cannonTile, playerId, cannonIdx)` key for the per-cannon shot
 *  counter map (see `shotCountKey` for the layout and why the tile is in it).
 *  Branded so a raw `number` can't be mistakenly fed into shotCounts.get(). */
export type ShotKey = number & { readonly __shotKey: true };

/** Timer seconds remaining that define the "second half" of battle
 *  (state.timer is in seconds; BATTLE_TIMER = 10). */
const BATTLE_SECOND_HALF_TIMER = 5;
/** Chance to switch focus to a different enemy in the second half. */
const TARGET_SWITCH_PROBABILITY = 0.25;
/** Chance to target a strategic wall tile (flanked by 2+ obstacles). */
const STRATEGIC_TARGET_PROBABILITY = 1 / 4;
/** Chance to aim fire at a strategic (load-bearing) wall while the player has a
 *  fire-capable SUPER gun. A 3×3 super gun's incendiary splash + burning pit
 *  breach such walls far better than a normal ball, so it's worth leaning on
 *  them while one is up. Opportunistic — the runtime round-robins which cannon
 *  fires; this biases targeting (`hasReadySuperGun`) rather than forcing a
 *  specific cannon, so the super gun's shots land on load-bearing walls in turn.
 *  Personality-gated like the regular strategic pick (tier-1 never); tier-2 base
 *  is 30%, doubling at the aggressive tier (mirrors the supply-ship ladder). */
const SUPER_GUN_STRATEGIC_PROBABILITY = 3 / 10;
/** Chance to target a supply ship sailing the river. Aiming uses lead
 *  prediction via `pickSupplyShipTarget`, but the chosen probability
 *  keeps ships from dominating AI shot selection. Raised from 1/8 to 3/16:
 *  the dominant blocker on AI sinks isn't accuracy but follow-up volume —
 *  a 2-HP ship needs two ship-shots stacked on one hull, and at 1/8 the AI
 *  rarely re-rolls the ship branch in time to engage the same ship twice.
 *  More attempts feed the `SHIP_ENGAGED_RADIUS` priority loop that
 *  concentrates the second shot. Still well below the strategic/cannon
 *  picks so ships don't dominate shot selection. */
const SUPPLY_SHIP_TARGET_PROBABILITY = 3 / 16;
/** Chance to target a wall tile blocking a grunt's path to its tower. */
const GRUNT_WALL_TARGET_PROBABILITY = 1 / 8;
/** Chance to target a fresh (undamaged) enemy cannon before defaulting to
 *  enclosure-wall sieging. Damaged cannons are handled by the priority pool. */
const FRESH_CANNON_TARGET_PROBABILITY = 1 / 3;
/** How many of the closest candidates to pick randomly from. */
const TOP_TARGET_PICK_COUNT = 3;
/** Minimum preferred distance (in tiles) from crosshair for target spread. */
const SWEET_SPOT_MIN_DISTANCE = 0;
/** Width of the preferred distance band (sweet spot = min .. min + range). */
const SWEET_SPOT_DISTANCE_RANGE = 5;
/** Shared, AI-local cache of LIVE enclosure components per enemy player. The
 *  live interior (flood-fill from CURRENT walls) is identical for every AI that
 *  targets a given enemy — it's a pure function of that enemy's walls — so it's
 *  computed once and reused across all AI controllers (they import this module).
 *
 *  Versioned by a CONTENT stamp (`wallSetStamp`: size + order-independent
 *  mixed-key sum), not by `walls.size` alone — size-only versioning served a
 *  stale topology across battles whenever a build netted zero wall delta
 *  (placements offset by the wall sweep, Master Builder lockout, AFK player)
 *  yet moved walls around. The stamp reflects content, so a rebuilt Player
 *  after a checkpoint join also recomputes to the same components every other
 *  peer's cache holds. Read-only and never written to `player.interior`, so
 *  the frozen battle interior that drives rendering and fire-eligibility is
 *  untouched. Pure function of synced walls → identical on every peer, no
 *  wire payload. */
const liveEnclosureCache = new WeakMap<
  Player,
  {
    stamp: number;
    components: TileKey[][];
    /** Per-wall distance to the outside flood (`wallDepthToOutside`). Cached
     *  with `components`: both are pure functions of `walls`, so one stamp
     *  invalidates both — and the enclosure-wall pick reads `depth` on every
     *  shot, so recomputing the flood per pick (as the pre-cache code did)
     *  was the dominant per-shot cost on the sieging path. */
    depth: ReadonlyMap<TileKey, number>;
  }
>();
/** Margin around an enclosure's bounding box for the breach search when a zone
 *  box can't be derived — must exceed any plausible wall-ring thickness so the
 *  box reaches the outside flood beyond the ring. */
const BREACH_FALLBACK_BOX_MARGIN = 8;
/** Sentinel "unreached" distance for the breach-cut 0-1 BFS. */
const BREACH_UNREACHED = 1 << 20;
/** Pockets smaller than this are worth destroying — can't fit a 2×2 cannon.
 *  Distinct from DESTROY_POCKET_MAX_SIZE (build scoring) which is higher (9)
 *  because build prevention is stricter than battle destruction. Exported
 *  for the pocket-destruction and structural-hit tactic files. */
export const DESTROY_POCKET_MAX_SIZE = 4;

/** Count cannons that are alive and enclosed (usable for firing). */
export function countUsableCannons(
  state: BattleViewState,
  playerId: ValidPlayerId,
): number {
  const player = state.players[playerId]!;
  let count = 0;
  for (let i = 0; i < player.cannons.length; i++) {
    if (canFireOwnCannon(state, playerId, i as CannonIdx)) count++;
  }
  return count;
}

export function pickTarget(
  state: BattleViewState,
  playerId: ValidPlayerId,
  crosshair: PixelPos,
  focusFirePlayerId: ValidPlayerId | undefined,
  shotCounts: Map<ShotKey, number>,
  targetMemory: BattleTargetMemory,
  rng: Rng,
  battleTactics = 2,
): StrategicPixelPos | null {
  const rand = () => rng.next();
  // Second half of battle: 1/4 chance to switch to the other enemy.
  // Gated on `battleCountdown <= 0` so the check only fires once battle
  // is actually running. During the countdown (battleCountdown > 0),
  // pickTarget is also called from `tickCountdown`, but `state.timer`
  // still reflects the prior phase's value (≈ 0 in modern-with-modifier
  // because MODIFIER_REVEAL decayed it; BATTLE_TIMER in classic) — both
  // paths must agree, and only post-countdown is "second half" meaningful.
  const secondHalf =
    state.battleCountdown <= 0 && state.timer <= BATTLE_SECOND_HALF_TIMER;
  const switchTarget =
    secondHalf &&
    focusFirePlayerId != null &&
    rand() < TARGET_SWITCH_PROBABILITY;

  let targets = collectEnemyTargets(
    state,
    playerId,
    focusFirePlayerId,
    switchTarget,
    shotCounts,
  );
  // "Switch to the other enemy" only makes sense when another enemy exists.
  // In a 1v1 endgame the focus enemy is the sole target, so switching filters
  // away every candidate — fall back to normal targeting rather than forfeiting
  // the shot. The switchTarget rng draw above already happened and
  // collectEnemyTargets consumes no rng, so this retry keeps the stream aligned
  // across peers.
  if (switchTarget && targets.length === 0) {
    targets = collectEnemyTargets(
      state,
      playerId,
      focusFirePlayerId,
      false,
      shotCounts,
    );
  }

  // Filter out any target tile that OUR OWN cannonball is already heading at.
  // Owner-scoped on purpose: reading the exact target tile of an opponent's
  // in-flight ball is info a human can't act on (they see the arc, not a
  // tile-precise reticle on enemy shots), so deduping against enemy balls
  // would be a soft cheat — keep firing symmetric with humans. We only know
  // where WE aimed. Cannon candidates aim at the FOOTPRINT CENTER — fractional
  // row/col for even sizes (+0.5 for the standard 2×2) — and the jittered shot
  // lands in one of the tiles around that corner, so fractional coords expand
  // to their floor/ceil tiles. Exact-comparing here silently disabled the
  // dedup for every even-size cannon candidate (an integer ball tile never
  // equals an x.5 candidate row).
  // Also drop any tile whose aim the occlusion seam would only redirect onto a
  // tower: that wall is hidden behind a camera-near tower under the battle tilt,
  // so the crosshair snaps onto the (invulnerable) tower and the shot is wasted
  // no matter which cannon fires. Skipping it here steers ranking to a reachable
  // wall instead of fixating on one we can never hit. Consumes no rng (pure,
  // synced GameState), so peer parity holds — same shape as the in-flight dedup.
  const filtered = targets.filter(
    (tile) =>
      !isTargetAreaInFlight(state, tile.row, tile.col, playerId) &&
      !aimRedirectsOntoTower(state, tile.row, tile.col),
  );
  if (filtered.length === 0) return null;

  const currentRow = crosshair.y / TILE_SIZE;
  const currentCol = crosshair.x / TILE_SIZE;

  // Supply-ship targeting — first early gate so it competes fairly with
  // the other tactical picks. Gated on `supplyShips != null` so the rng
  // roll only happens when ships are actually present — preserves
  // classic-mode determinism (no extra rng consumption when the modifier
  // is inactive).
  const supplyShips = state.modern?.supplyShips;
  if (supplyShips != null) {
    const shipProb = traitLookup(battleTactics, [
      0,
      SUPPLY_SHIP_TARGET_PROBABILITY,
      2 * SUPPLY_SHIP_TARGET_PROBABILITY,
    ] as const);
    const cannons = state.players[playerId]!.cannons;
    // Guard the centroid divide: a player firing only a CAPTURED cannon has
    // an empty own-cannons array (life-loss board reset), and 0/0 would NaN-
    // poison the lead-prediction aim. The rand() draw stays unconditional so
    // the roll order matches the cannons-present path.
    if (rand() < shipProb && cannons.length > 0) {
      let sumRow = 0;
      let sumCol = 0;
      for (const cannon of cannons) {
        sumRow += cannon.row;
        sumCol += cannon.col;
      }
      const shooterTile = {
        row: sumRow / cannons.length,
        col: sumCol / cannons.length,
      };
      const shipTarget = pickSupplyShipTarget(
        supplyShips,
        shooterTile,
        crosshair,
        state.cannonballs,
        playerId,
        rng,
      );
      if (shipTarget) {
        return { x: shipTarget.x, y: shipTarget.y, pickPath: "supply_ship" };
      }
    }
  }

  // Super-gun opportunism: while the player has a fire-capable 3×3 super gun,
  // bias toward a strategic (load-bearing) wall — its incendiary splash +
  // burning pit make those breaches count. Same targets as the regular strategic
  // gate; runs first so a ready super gun gets an extra, higher roll. The runtime
  // round-robins which cannon fires, so this just concentrates fire on
  // load-bearing walls while a super gun is up; the super gun's own shots land
  // there in turn. Gated on `hasReadySuperGun` — a pure function of synced state,
  // so the rand() draw is identical on every peer. (A `nextReadyCannon` peek
  // would read the controller-local rotation index, which diverges after host
  // migration / reselect and would break rng parity.)
  if (hasReadySuperGun(state, playerId)) {
    const superStrategicProb = traitLookup(battleTactics, [
      0,
      SUPER_GUN_STRATEGIC_PROBABILITY,
      2 * SUPER_GUN_STRATEGIC_PROBABILITY,
    ] as const);
    if (rand() < superStrategicProb) {
      const strategic = collectStrategicWallTargets(
        state,
        playerId,
        focusFirePlayerId,
      );
      if (strategic.length > 0) {
        const jitter = pickJitteredNearestTarget(
          strategic,
          currentRow,
          currentCol,
          rand,
        );
        return {
          x: jitter.x,
          y: jitter.y,
          strategic: true,
          pickPath: "super_strategic",
        };
      }
    }
  }

  // Strategic targeting — controlled by battleTactics
  const strategicProb = traitLookup(battleTactics, [
    0,
    STRATEGIC_TARGET_PROBABILITY,
    1 / 2,
  ] as const);
  if (rand() < strategicProb) {
    const strategic = collectStrategicWallTargets(
      state,
      playerId,
      focusFirePlayerId,
    );
    if (strategic.length > 0) {
      // Prefer closer strategic targets
      const jitter = pickJitteredNearestTarget(
        strategic,
        currentRow,
        currentCol,
        rand,
      );
      return {
        x: jitter.x,
        y: jitter.y,
        strategic: true,
        pickPath: "strategic",
      };
    }
  }

  // Grunt-blocking targeting — controlled by battleTactics
  const gruntWallProb = traitLookup(battleTactics, [
    0,
    GRUNT_WALL_TARGET_PROBABILITY,
    1 / 4,
  ] as const);
  if (rand() < gruntWallProb) {
    const gruntWalls = collectGruntBlockingWallTargets(state, playerId);
    if (gruntWalls.length > 0) {
      // Prefer closer grunt-wall targets
      const jitter = pickJitteredNearestTarget(
        gruntWalls,
        currentRow,
        currentCol,
        rand,
      );
      return {
        x: jitter.x,
        y: jitter.y,
        pickPath: "grunt_wall",
      };
    }
  }

  // Prefer priority targets (cannons we already shot at) to finish them off
  const priorityTargets = filtered.filter((target) => target.priority);
  if (priorityTargets.length > 0) {
    const target = pickSweetSpotTarget(
      priorityTargets,
      currentRow,
      currentCol,
      rand,
    );
    return tagPath(
      jitterWithinTile(target.row, target.col, rand),
      "priority_cannon",
    );
  }

  // Fresh cannon targeting — without this, enclosure-wall sieging always wins
  // and undamaged cannons are never shot. Damaged cannons already fire above.
  const freshCannonProb = traitLookup(battleTactics, [
    0,
    FRESH_CANNON_TARGET_PROBABILITY,
    1 / 2,
  ] as const);
  if (rand() < freshCannonProb) {
    const freshCannons = filtered.filter(
      (cand) => cand.isCannon && !cand.priority,
    );
    if (freshCannons.length > 0) {
      const target = pickSweetSpotTarget(
        freshCannons,
        currentRow,
        currentCol,
        rand,
      );
      return tagPath(
        jitterWithinTile(target.row, target.col, rand),
        "fresh_cannon",
      );
    }
  }

  // Pick an enclosure of the enemy, then target a wall bordering it.
  // `targetMemory` keeps the AI locked onto one enclosure across shots so it
  // doesn't oscillate; when that lock invalidates (breach / consumed / focus
  // switch), the switch is biased to the enclosure NEAREST the crosshair so
  // fire concentrates on one fortress region (breach it fully, then hop to the
  // next nearest) instead of teleporting across the map.
  const enclosureWall = pickEnclosureWallTarget(
    state,
    playerId,
    focusFirePlayerId,
    switchTarget,
    targetMemory,
    currentRow,
    currentCol,
    rand,
  );
  if (enclosureWall) {
    const path: PickPath = enclosureWall.contiguous
      ? "enclosure_contig"
      : enclosureWall.reused
        ? "enclosure_deadend"
        : "enclosure_switch";
    return tagPath(
      jitterWithinTile(enclosureWall.row, enclosureWall.col, rand),
      path,
    );
  }

  // Fallback: sweet-spot pick from the flat candidate pool.
  const target = pickSweetSpotTarget(filtered, currentRow, currentCol, rand);
  // Jitter within the target tile (never spill into adjacent tiles)
  return tagPath(jitterWithinTile(target.row, target.col, rand), "fallback");
}

export function trackShot(
  state: BattleViewState,
  playerId: ValidPlayerId,
  crosshair: PixelPos,
  shotCounts: Map<ShotKey, number>,
): void {
  const row = pxToTile(crosshair.y);
  const col = pxToTile(crosshair.x);
  for (const other of filterActiveEnemies(state, playerId)) {
    for (let idx = 0; idx < other.cannons.length; idx++) {
      const cannon = other.cannons[idx]!;
      // Match collectEnemyTargets' filter: a dead cannon is never offered as a
      // target, so its shot-count key would never be read — don't bump it.
      if (!isCannonAlive(cannon) || isBalloonCannon(cannon)) continue;
      if (isCannonTile(cannon, row, col)) {
        const key = shotCountKey(other.id, idx as CannonIdx, cannon);
        shotCounts.set(key, (shotCounts.get(key) ?? 0) + 1);
        return;
      }
    }
  }
}

/** Simulate wall removal and count how many of the supplied enclosures now
 *  have at least one tile reachable from a map edge (breached by the 8-dir
 *  flood). Used by structural-hit and wall-demolition to evaluate whether
 *  a candidate set of wall removals actually breaches an enemy's territory.
 *  Caller is responsible for filtering `enclosures` to the size class they
 *  care about (typically `> DESTROY_POCKET_MAX_SIZE`). */
export function countBrokenEnclosures(
  modifiedWalls: ReadonlySet<TileKey>,
  enclosures: readonly (readonly TileKey[])[],
): number {
  const newOutside = computeOutside(modifiedWalls);
  let broken = 0;
  for (const comp of enclosures) {
    if (isEnclosureBroken(comp, newOutside)) broken++;
  }
  return broken;
}

/** The minimum breach cut against `enemy`'s LIVE walls: the fewest wall tiles
 *  to destroy that open its intact large enclosures, ordered shell-first for
 *  chain execution. Because the enclosure flood is 8-connected, the cheapest
 *  crossing of a thick wall body is a diagonal staircase, so this breaches a fat
 *  (2+ thick) ring of ANY shape — the dual of the build-side `findEnclosureCut`.
 *
 *  When a defender splits its towers across several rings, it loses a life only
 *  when EVERY enclosed tower is opened in one build, so this greedily packs as
 *  many ring breaches as the `cap` shot budget allows into one chain —
 *  tower-bearing rings first (the actual life-loss lever), cheapest-first, then
 *  tower-less large pockets as a repair tax. One affordable chain can open every
 *  tower ring (a same-round kill); a tighter budget opens what it can each round.
 *  Returns null when no intact large enclosure is breachable within `cap`.
 *  Shared by the deny-enclosure and fat-breach tactics. */
export function findMinBreach(
  state: BattleViewState,
  enemy: Player,
  cap: number,
): TilePos[] | null {
  if (cap < 1) return null;
  const outside = computeOutside(enemy.walls);
  // Validate only against STILL-INTACT enclosures: an already-breached one is
  // reached by the live flood whatever the plan, so it must not seed a search.
  // Breach candidates: still-intact enclosures that are EITHER large enough to
  // hold real territory OR wrap an alive tower. The pocket-size threshold alone
  // would discard a tightly-walled tower sitting in a ≤4-tile pocket (its 2×2
  // footprint with no spare interior) — but that ring is a life-loss lever no
  // matter how small, so `componentHoldsTower` keeps it in. The size term only
  // filters tower-LESS interior crumbs (wall-gap noise not worth a breach).
  const candidates = findEnclosureComponents(getBattleInterior(enemy)).filter(
    (comp) =>
      (comp.length > DESTROY_POCKET_MAX_SIZE ||
        componentHoldsTower(comp, enemy)) &&
      !isEnclosureBroken(comp, outside),
  );
  if (candidates.length === 0) return null;

  // The cheapest independent breach of each ring (each a min-cut on the same
  // live walls), tagged with whether the ring holds an enclosed tower.
  const breaches: { path: TilePos[]; holdsTower: boolean; firstKey: number }[] =
    [];
  for (const comp of candidates) {
    const path = findBreachPath(state, enemy, comp, outside, cap);
    if (!path || path.length === 0) continue;
    breaches.push({
      path,
      holdsTower: componentHoldsTower(comp, enemy),
      firstKey: packTile(path[0]!.row, path[0]!.col),
    });
  }
  if (breaches.length === 0) return null;

  // Tower rings first (opening them is what forces the life loss), then
  // cheapest-first, with a stable key tiebreak so the chain is deterministic.
  breaches.sort(
    (a, b) =>
      Number(b.holdsTower) - Number(a.holdsTower) ||
      a.path.length - b.path.length ||
      a.firstKey - b.firstKey,
  );

  // Greedily accumulate rings while the shared budget lasts. A ring that doesn't
  // fit is skipped (a cheaper later one may still fit). Dedupe tiles so a wall
  // shared between adjacent rings isn't double-charged against the budget.
  const shots: TilePos[] = [];
  const queued = new Set<TileKey>();
  for (const { path } of breaches) {
    const fresh = filterOffTiles(path, queued);
    if (shots.length + fresh.length > cap) continue;
    for (const tile of fresh) {
      shots.push(tile);
      queued.add(packTile(tile.row, tile.col));
    }
  }
  return shots.length > 0 ? shots : null;
}

/** True when any tile of the enclosure component is reached by the outside
 *  flood. Exposed so plan modules can filter ALREADY-breached enclosures out
 *  of their validation set against a precomputed live `computeOutside` —
 *  otherwise, once an enclosure is breached mid-battle, removing ANY segment
 *  "validates" (the flood reaches it regardless) and re-plans commit whole
 *  chains against walls that no longer enclose anything. */
export function isEnclosureBroken(
  enclosure: readonly TileKey[],
  outside: ReadonlySet<TileKey>,
): boolean {
  for (const tileKey of enclosure) {
    if (outside.has(tileKey)) return true;
  }
  return false;
}

/** Inverse flood-fill interior from a wall set — mirrors `recomputeInterior`
 *  in build-system (grass not reachable from a map edge through non-wall tiles
 *  is interior), but reads the CURRENT walls so breaches are reflected live. */
export function computeLiveInterior(walls: ReadonlySet<TileKey>): Set<TileKey> {
  return interiorFromOutside(walls, computeOutside(walls));
}

/** Whether an enclosure component contains any of the enemy's enclosed-tower
 *  footprints — i.e. breaching it un-encloses a tower (a life-loss lever),
 *  versus a tower-less pocket whose breach is only a repair tax. */
export function componentHoldsTower(
  comp: readonly TileKey[],
  enemy: Player,
): boolean {
  if (enemy.enclosedTowers.length === 0) return false;
  const interiorSet = new Set(comp);
  for (const tower of enemy.enclosedTowers) {
    let hit = false;
    forEachTowerTile(tower, (_r, _c, key) => {
      if (interiorSet.has(key)) hit = true;
    });
    if (hit) return true;
  }
  return false;
}

/** True when the player owns a fire-capable super gun (alive, enclosed, no ball
 *  in flight). Pure function of synced GameState — no controller-local rotation
 *  index — so every peer computes the same value at the same sim-tick, keeping
 *  the super-gun targeting gate's rng draw in lockstep across host migration /
 *  reselect. */
function hasReadySuperGun(
  state: BattleViewState,
  playerId: ValidPlayerId,
): boolean {
  const player = state.players[playerId];
  if (!player) return false;
  for (let idx = 0; idx < player.cannons.length; idx++) {
    if (
      isSuperCannon(player.cannons[idx]!) &&
      canFireOwnCannon(state, playerId, idx as CannonIdx)
    )
      return true;
  }
  return false;
}

function collectStrategicWallTargets(
  state: BattleViewState,
  playerId: ValidPlayerId,
  focusFirePlayerId: ValidPlayerId | undefined,
): TilePos[] {
  const strategic: TilePos[] = [];
  for (const other of filterActiveEnemies(state, playerId)) {
    if (focusFirePlayerId != null && other.id !== focusFirePlayerId) continue;
    for (const key of other.walls) {
      const { row: wallRow, col: wallCol } = unpackTile(key);
      // Skip walls already targeted by one of our OWN cannonballs in flight
      // (owner-scoped — see the fairness note in pickTarget).
      if (isTileTargetedByInFlightBall(state, wallRow, wallCol, playerId))
        continue;
      // A wall hidden behind a camera-near tower is unhittable — the aim seam
      // would only redirect onto the (invulnerable) tower, wasting the shot. Skip
      // it so a ready super gun / strategic shot picks a reachable load-bearing
      // wall instead of fixating on one no cannon can land on.
      if (aimRedirectsOntoTower(state, wallRow, wallCol)) continue;
      // Track obstacle directions: [north, south, west, east]
      const obstacles = computeCardinalObstacleMask(state, wallRow, wallCol, {
        excludeBalloonCannons: true,
      });
      // Require 2+ obstacles with at least one opposite pair (N/S or W/E)
      const total = obstacles.filter(Boolean).length;
      const hasOpposite =
        (obstacles[0] && obstacles[1]) || (obstacles[2] && obstacles[3]);
      if (total >= 2 && hasOpposite)
        strategic.push({ row: wallRow, col: wallCol });
    }
  }
  return strategic;
}

function collectGruntBlockingWallTargets(
  state: BattleViewState,
  playerId: ValidPlayerId,
): TilePos[] {
  const gruntWalls: TilePos[] = [];
  const myZone = state.playerZones[playerId];
  for (const grunt of state.grunts) {
    const gruntZone = zoneAt(state.map, grunt.row, grunt.col);
    // Skip grunts in my own zone (they attack me — not a "charity" target).
    if (gruntZone === undefined || gruntZone === myZone) continue;
    if (grunt.targetTowerIdx == null) continue;
    const tower = getGruntTargetTower(state, grunt);
    if (!tower) continue;
    // "Enemy" = owner of the zone the grunt is currently in (the player
    // it's attacking, under the current-zone attack rule).
    const enemyId = state.playerZones.indexOf(gruntZone);
    const enemy = enemyId >= 0 ? state.players[enemyId] : undefined;
    if (!enemy || isPlayerEliminated(enemy)) continue;
    let bestTowerRow = tower.row;
    let bestTowerCol = tower.col;
    let bestDistance = Infinity;
    forEachTowerTile(tower, (tileRow, tileCol) => {
      const distance = manhattanDistance(
        tileRow,
        tileCol,
        grunt.row,
        grunt.col,
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        bestTowerRow = tileRow;
        bestTowerCol = tileCol;
      }
    });
    const dr = Math.sign(bestTowerRow - grunt.row);
    const dc = Math.sign(bestTowerCol - grunt.col);
    const dirs: [number, number][] = [];
    if (dr !== 0) dirs.push([dr, 0]);
    if (dc !== 0) dirs.push([0, dc]);
    for (const [ddr, ddc] of dirs) {
      const nr = grunt.row + ddr;
      const nc = grunt.col + ddc;
      const neighborKey = packTile(nr, nc);
      if (
        enemy.walls.has(neighborKey) &&
        !isTileTargetedByInFlightBall(state, nr, nc, playerId) &&
        // Unhittable if a camera-near tower hides it (aim snaps onto the tower).
        !aimRedirectsOntoTower(state, nr, nc)
      ) {
        gruntWalls.push({ row: nr, col: nc });
      }
    }
  }
  return gruntWalls;
}

function collectEnemyTargets(
  state: BattleViewState,
  playerId: ValidPlayerId,
  focusFirePlayerId: ValidPlayerId | undefined,
  switchTarget: boolean,
  shotCounts: Map<ShotKey, number>,
): TargetCandidate[] {
  const targets: TargetCandidate[] = [];
  for (const other of filterActiveEnemies(state, playerId)) {
    if (!isEnemyEligibleForFocus(other.id, focusFirePlayerId, switchTarget))
      continue;

    for (let idx = 0; idx < other.cannons.length; idx++) {
      const cannon = other.cannons[idx]!;
      if (!isCannonAlive(cannon) || isBalloonCannon(cannon)) continue;
      if (isCannonCapturedBy(state, cannon, playerId)) continue;
      // Skip if we've already fired enough shots to destroy it
      const key = shotCountKey(other.id, idx as CannonIdx, cannon);
      const shots = shotCounts.get(key) ?? 0;
      if (shots >= state.cannonMaxHp) continue;
      const size = cannonSize(cannon.mode);
      const targetRow = cannon.row + (size - 1) / 2;
      const targetCol = cannon.col + (size - 1) / 2;
      targets.push({
        row: targetRow,
        col: targetCol,
        priority: shots > 0,
        isCannon: true,
      });
    }

    for (const key of other.walls) {
      const { row: wallRow, col: wallCol } = unpackTile(key);
      // Prioritize already-damaged reinforced walls (one more hit destroys them)
      targets.push({
        row: wallRow,
        col: wallCol,
        priority: other.damagedWalls.has(key),
      });
    }
  }

  return targets;
}

/** Stable numeric key for shotCounts: survives cannon OBJECT replacement
 *  (checkpoint restore rebuilds the array with identical positions) while
 *  rolling over on cannon INDEX reuse — a life-loss board reset empties
 *  `player.cannons`, so the rebuilt board hands indices 0..n to brand-new
 *  cannons. Folding the cannon's tile into the key gives those fresh cannons
 *  fresh counters instead of inheriting this index's destroyed-cannon history
 *  (which permanently blacklisted them once the old count hit cannonMaxHp).
 *  Layout: tileKey (< TILE_COUNT < 2^11) << 18 | playerId << 16 | cannonIdx. */
function shotCountKey(
  playerId: ValidPlayerId,
  cannonIdx: CannonIdx,
  cannon: Cannon,
): ShotKey {
  return ((packTile(cannon.row, cannon.col) << 18) |
    (playerId << 16) |
    cannonIdx) as ShotKey;
}

/** Pick an enclosure of an eligible enemy, then return a wall bordering it.
 *  Uses a LIVE enclosure view (`liveEnclosureDataOf`, recomputed from current
 *  walls) rather than the frozen battle interior — so an enclosure already
 *  breached this battle drops out and the AI redirects fire to a still-intact
 *  tower's enclosure instead of poking an open hole. Reuses the cached
 *  enclosure from `targetMemory` while its anchor tile is still enclosed;
 *  otherwise picks a new random one. Within an enclosure, prefers a border
 *  wall adjacent to the last one hit (`lastWallTileKey`) so consecutive shots
 *  walk one contiguous segment into a breach instead of scattering. Returns
 *  null when no enclosure has untargeted border walls. */
function pickEnclosureWallTarget(
  state: BattleViewState,
  playerId: ValidPlayerId,
  focusFirePlayerId: ValidPlayerId | undefined,
  switchTarget: boolean,
  targetMemory: BattleTargetMemory,
  refRow: number,
  refCol: number,
  rand: () => number,
): (TilePos & { contiguous: boolean; reused: boolean }) | null {
  // Collect all enclosures across eligible enemies, tagged with their owner.
  type CachedEnclosure = {
    ownerId: ValidPlayerId;
    walls: ReadonlySet<TileKey>;
    depth: ReadonlyMap<TileKey, number>;
    tiles: TileKey[];
  };
  const allEnclosures: CachedEnclosure[] = [];
  for (const other of filterActiveEnemies(state, playerId)) {
    if (!isEnemyEligibleForFocus(other.id, focusFirePlayerId, switchTarget))
      continue;
    // Live (shared, cached) enclosure components — breached ones are absent.
    // `depth` rides the same cache entry so the thinnest-barrier scoring below
    // reads it instead of re-flooding the board on every shot.
    const data = liveEnclosureDataOf(other);
    for (const comp of data.components) {
      allEnclosures.push({
        ownerId: other.id,
        walls: other.walls,
        depth: data.depth,
        tiles: comp,
      });
    }
  }
  if (allEnclosures.length === 0) {
    targetMemory.ownerId = undefined;
    targetMemory.anchorTileKey = undefined;
    targetMemory.lastWallTileKey = undefined;
    return null;
  }

  // Try to reuse the cached enclosure: find the component that still contains
  // the anchor tile (owner must match too, so focus-fire switches re-pick).
  // With the live view this also self-invalidates on breach — a de-flooded
  // enclosure no longer contains its anchor, forcing a redirect.
  let enclosure: CachedEnclosure | undefined;
  if (targetMemory.anchorTileKey !== undefined) {
    const anchor = targetMemory.anchorTileKey;
    const ownerId = targetMemory.ownerId;
    for (const candidate of allEnclosures) {
      if (candidate.ownerId !== ownerId) continue;
      if (candidate.tiles.includes(anchor)) {
        enclosure = candidate;
        break;
      }
    }
  }
  // Diag-only: did we keep the same enclosure as the previous shot (so a
  // non-contiguous pick is a within-enclosure dead-end, not a switch)?
  const reused = enclosure !== undefined;

  if (enclosure === undefined) {
    // The lock invalidated — start a fresh walk on the enclosure NEAREST the
    // crosshair (ref), so fire concentrates on one fortress region rather than
    // teleporting to a random far enclosure (the dominant scatter source). A
    // tiny top-2 random keeps ties / near-equidistant picks from locking
    // deterministically and consumes one rand draw (parity-stable). Distance
    // uses each enclosure's centroid — cheap and only computed on a switch.
    enclosure = pickNearestEnclosure(allEnclosures, refRow, refCol, rand);
    targetMemory.ownerId = enclosure.ownerId;
    targetMemory.anchorTileKey = enclosure.tiles[0];
    targetMemory.lastWallTileKey = undefined;
  }

  // Find walls bordering this enclosure (4-dir adjacent to an enclosure tile).
  // `enclosure.tiles` is already unique (built by findEnclosureComponents BFS
  // with a visited set), so iterate it directly instead of allocating a Set.
  const seen = new Set<TileKey>();
  const borderWalls: TilePos[] = [];
  for (const key of enclosure.tiles) {
    const { row, col } = unpackTile(key);
    for (const [dr, dc] of DIRS_4) {
      const nr = row + dr;
      const nc = col + dc;
      const neighborKey = packTile(nr, nc);
      if (
        !seen.has(neighborKey) &&
        enclosure.walls.has(neighborKey) &&
        !isTileTargetedByInFlightBall(state, nr, nc, playerId) &&
        // Skip a border wall hidden behind a camera-near tower: the aim seam
        // would snap onto the (invulnerable) tower, so drilling it never breaches
        // — keep the walk on walls a cannon can actually land on.
        !aimRedirectsOntoTower(state, nr, nc)
      ) {
        seen.add(neighborKey);
        borderWalls.push({ row: nr, col: nc });
      }
    }
  }
  if (borderWalls.length === 0) return null;

  // Thinnest-barrier bias: score each border wall by how many wall tiles a shot
  // would have to drill straight through here to reach the outside (1 = a
  // single-thick, load-bearing wall that breaches in one shot). Firing at the
  // thinnest segment — and, via the contiguity tiebreak below, drilling that
  // one column radially — converges on a real breach instead of peeling the
  // redundant inner shell of a double-walled corner (shots the defender need
  // not even repair). Uses only board-visible wall geometry (no peeking).
  // `depth` was computed once per wall-set and cached in `liveEnclosureDataOf`.
  const chosen = pickBreachWall(
    borderWalls,
    enclosure.depth,
    targetMemory.lastWallTileKey,
    rand,
  );
  targetMemory.lastWallTileKey = packTile(chosen.row, chosen.col);
  return {
    row: chosen.row,
    col: chosen.col,
    contiguous: chosen.contiguous,
    reused,
  };
}

/** Choose a border wall, preferring the THINNEST barrier (fewest wall tiles
 *  between it and the outside, per `depth`) so fire targets load-bearing
 *  perimeter that actually breaches, not the redundant inner shell. Among
 *  equally-thin walls, prefer one cardinally adjacent to `lastKey` so
 *  consecutive shots drill one column radially toward the breach (also cheaper
 *  crosshair travel + tighter combo streaks); uniform-random otherwise.
 *  `contiguous` reports whether the adjacency bias engaged vs a scatter pick —
 *  surfaced for the fire-decision diag. Draws exactly one `rand()` on every
 *  path (RNG-parity stable). */
function pickBreachWall(
  borderWalls: readonly TilePos[],
  depth: ReadonlyMap<TileKey, number>,
  lastKey: TileKey | undefined,
  rand: () => number,
): TilePos & { contiguous: boolean } {
  // Primary key: thinnest barrier. Walls the BFS never reached (fully sealed,
  // no path of walls to the outside) sort last via Infinity, leaving the old
  // uniform behaviour as the fallback when nothing is breachable.
  let minDepth = Number.POSITIVE_INFINITY;
  for (const wall of borderWalls) {
    const wallDepth = depth.get(packTile(wall.row, wall.col)) ?? Infinity;
    if (wallDepth < minDepth) minDepth = wallDepth;
  }
  const thinnest = borderWalls.filter(
    (wall) =>
      (depth.get(packTile(wall.row, wall.col)) ?? Infinity) === minDepth,
  );
  if (lastKey !== undefined) {
    const { row: lr, col: lc } = unpackTile(lastKey);
    const adjacent = thinnest.filter(
      (wall) => Math.abs(wall.row - lr) + Math.abs(wall.col - lc) === 1,
    );
    if (adjacent.length > 0) {
      const wall = adjacent[Math.floor(rand() * adjacent.length)]!;
      return { row: wall.row, col: wall.col, contiguous: true };
    }
  }
  const wall = thinnest[Math.floor(rand() * thinnest.length)]!;
  return { row: wall.row, col: wall.col, contiguous: false };
}

/** Pick the enclosure nearest the reference tile (crosshair), with a top-2
 *  random tiebreak. Distance is reference→centroid Manhattan; centroid is the
 *  tile-mean of the component, computed here (only on an enclosure switch).
 *  Concentrates fire on the closest fortress region instead of a uniform-random
 *  far jump — the dominant inter-shot scatter source (see pickPath diag). */
function pickNearestEnclosure<T extends { tiles: TileKey[] }>(
  enclosures: readonly T[],
  refRow: number,
  refCol: number,
  rand: () => number,
): T {
  const scored = enclosures.map((enc) => {
    let sumRow = 0;
    let sumCol = 0;
    for (const key of enc.tiles) {
      const { row, col } = unpackTile(key);
      sumRow += row;
      sumCol += col;
    }
    const tileCount = enc.tiles.length;
    const dist =
      Math.abs(sumRow / tileCount - refRow) +
      Math.abs(sumCol / tileCount - refCol);
    return { enc, dist };
  });
  scored.sort((a, b) => a.dist - b.dist);
  const topCount = Math.min(2, scored.length);
  return scored[Math.floor(rand() * topCount)]!.enc;
}

/** Live enclosure data for an enemy — connected interior `components` plus the
 *  per-wall `depth` to the outside flood, both computed from the enemy's CURRENT
 *  walls (not the frozen battle snapshot). Cached and shared; recomputed only
 *  when the enemy's wall-set content changes. Sharing one `computeOutside` flood
 *  across both outputs (and caching `depth`) keeps the per-shot enclosure-wall
 *  pick flood-free between wall destructions. */
function liveEnclosureDataOf(enemy: Player): {
  components: TileKey[][];
  depth: ReadonlyMap<TileKey, number>;
} {
  const stamp = wallSetStamp(enemy.walls);
  const hit = liveEnclosureCache.get(enemy);
  if (hit !== undefined && hit.stamp === stamp) return hit;
  const outside = computeOutside(enemy.walls);
  const components = findEnclosureComponents(
    interiorFromOutside(enemy.walls, outside),
  );
  const depth = wallDepthToOutside(enemy.walls, outside);
  const entry = { stamp, components, depth };
  liveEnclosureCache.set(enemy, entry);
  return entry;
}

/** Find connected components of a tile set using 4-dir connectivity. */
export function findEnclosureComponents(
  tileSet: ReadonlySet<TileKey>,
): TileKey[][] {
  const visited = new Set<TileKey>();
  const components: TileKey[][] = [];
  for (const key of tileSet) {
    if (visited.has(key)) continue;
    const component: TileKey[] = [];
    const queue = [key];
    visited.add(key);
    while (queue.length > 0) {
      const current = queue.pop()!;
      component.push(current);
      const { row, col } = unpackTile(current);
      for (const [dr, dc] of DIRS_4) {
        const neighborKey = packTile(row + dr, col + dc);
        if (!visited.has(neighborKey) && tileSet.has(neighborKey)) {
          visited.add(neighborKey);
          queue.push(neighborKey);
        }
      }
    }
    components.push(component);
  }
  return components;
}

/** Interior tiles given a precomputed outside flood — grass neither outside nor
 *  wall. Split out so `liveEnclosureDataOf` can reuse a single `computeOutside`
 *  flood for both the interior and the wall-depth map. */
function interiorFromOutside(
  walls: ReadonlySet<TileKey>,
  outside: ReadonlySet<TileKey>,
): Set<TileKey> {
  const interior = new Set<TileKey>();
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const key = packTile(row, col);
      if (!outside.has(key) && !walls.has(key)) interior.add(key);
    }
  }
  return interior;
}

/** Distance, in wall tiles, from each enemy wall to the nearest outside tile —
 *  a multi-source BFS seeded at walls 4-adjacent to `outside` (depth 1) and
 *  propagated 4-dir through the wall body. A border wall's value is how many
 *  shots it takes to drill a breach straight through at that point. Walls with
 *  no 4-connected path to the outside are absent from the map. */
function wallDepthToOutside(
  walls: ReadonlySet<TileKey>,
  outside: ReadonlySet<TileKey>,
): Map<TileKey, number> {
  const depth = new Map<TileKey, number>();
  const queue: TileKey[] = [];
  for (const wallKey of walls) {
    const { row, col } = unpackTile(wallKey);
    for (const [dr, dc] of DIRS_4) {
      const nr = row + dr;
      const nc = col + dc;
      if (inBounds(nr, nc) && outside.has(packTile(nr, nc))) {
        depth.set(wallKey, 1);
        queue.push(wallKey);
        break;
      }
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const key = queue[head]!;
    const next = depth.get(key)! + 1;
    const { row, col } = unpackTile(key);
    for (const [dr, dc] of DIRS_4) {
      const nr = row + dr;
      const nc = col + dc;
      if (!inBounds(nr, nc)) continue;
      const neighborKey = packTile(nr, nc);
      if (walls.has(neighborKey) && !depth.has(neighborKey)) {
        depth.set(neighborKey, next);
        queue.push(neighborKey);
      }
    }
  }
  return depth;
}

/** Order-independent content stamp of a wall set: size plus a sum of
 *  Knuth-multiplicative-mixed packed keys. O(n) integer adds — far cheaper
 *  than the interior flood it guards — exact in float64 (each mixed term
 *  < 2^42, ≤ TILE_COUNT terms), and insertion-order-independent so identical
 *  wall sets stamp identically on every peer. Mixing makes an accidental
 *  same-size/same-sum collision across topologies negligible. */
function wallSetStamp(walls: ReadonlySet<TileKey>): number {
  let sum = 0;
  for (const key of walls) sum += (key + 1) * 2654435761;
  return walls.size + sum;
}

/** Footprint-aware in-flight dedup for pick candidates: integer coords test
 *  their exact tile; fractional coords (even-size cannon footprint centers)
 *  test the floor/ceil tiles the jittered aim can land in. Wall/strategic
 *  callers with guaranteed-integer tiles use `isTileTargetedByInFlightBall`
 *  directly. */
function isTargetAreaInFlight(
  state: BattleViewState,
  row: number,
  col: number,
  playerId: ValidPlayerId,
): boolean {
  for (const tileRow of tileSpan(row)) {
    for (const tileCol of tileSpan(col)) {
      if (isTileTargetedByInFlightBall(state, tileRow, tileCol, playerId))
        return true;
    }
  }
  return false;
}

/** Tiles a (possibly fractional) target coordinate resolves to. */
function tileSpan(coord: number): readonly number[] {
  return Number.isInteger(coord)
    ? [coord]
    : [Math.floor(coord), Math.ceil(coord)];
}

/** True if one of `playerId`'s OWN cannonballs in flight is targeting
 *  (row, col). Scoped to the effective firer (`scoringPlayerId ?? playerId`,
 *  so captured-cannon shots count for the capturer) — see the fairness note at
 *  the call site: the AI must not read opponents' ball targets. */
function isTileTargetedByInFlightBall(
  state: BattleViewState,
  row: number,
  col: number,
  playerId: ValidPlayerId,
): boolean {
  return state.cannonballs.some(
    (b) =>
      (b.scoringPlayerId ?? b.playerId) === playerId &&
      ballTargeting(b, row, col),
  );
}

/** True if a cannonball in flight is targeting (row, col). */
function ballTargeting(
  b: Pick<Cannonball, "targetY" | "targetX">,
  row: number,
  col: number,
): boolean {
  return pxToTile(b.targetY) === row && pxToTile(b.targetX) === col;
}

function isEnemyEligibleForFocus(
  enemyId: ValidPlayerId,
  focusFirePlayerId: ValidPlayerId | undefined,
  switchTarget: boolean,
): boolean {
  if (focusFirePlayerId == null) return true;
  if (!switchTarget) return enemyId === focusFirePlayerId;
  return enemyId !== focusFirePlayerId;
}

function pickSweetSpotTarget(
  targets: readonly TargetCandidate[],
  currentRow: number,
  currentCol: number,
  rand: () => number,
): TargetCandidate {
  const sweetSpot =
    SWEET_SPOT_MIN_DISTANCE + rand() * SWEET_SPOT_DISTANCE_RANGE;
  const sorted = [...targets].sort((a, b) => {
    const distanceA = Math.abs(
      manhattanDistance(a.row, a.col, currentRow, currentCol) - sweetSpot,
    );
    const distanceB = Math.abs(
      manhattanDistance(b.row, b.col, currentRow, currentCol) - sweetSpot,
    );
    return distanceA - distanceB;
  });
  return pickRandomFromTop(sorted, TOP_TARGET_PICK_COUNT, rand);
}

function pickJitteredNearestTarget(
  targets: readonly TilePos[],
  currentRow: number,
  currentCol: number,
  rand: () => number,
): PixelPos {
  const sorted = sortByDistanceFrom(targets, currentRow, currentCol);
  const target = pickRandomFromTop(sorted, TOP_TARGET_PICK_COUNT, rand);
  return jitterWithinTile(target.row, target.col, rand);
}

/** Sort targets by Manhattan distance from a reference tile, returning a new array. */
function sortByDistanceFrom(
  targets: readonly TilePos[],
  refRow: number,
  refCol: number,
): TilePos[] {
  return [...targets].sort(
    (a, b) =>
      manhattanDistance(a.row, a.col, refRow, refCol) -
      manhattanDistance(b.row, b.col, refRow, refCol),
  );
}

function pickRandomFromTop<T>(
  items: readonly T[],
  topCount: number,
  rand: () => number,
): T {
  const count = Math.min(topCount, items.length);
  return items[Math.floor(rand() * count)]!;
}

/** Attach a diag-only pickPath tag to a pixel target (provenance for the
 *  fire-decision diag; never affects behavior). */
function tagPath(pos: PixelPos, pickPath: PickPath): StrategicPixelPos {
  return { x: pos.x, y: pos.y, pickPath };
}

function jitterWithinTile(
  row: number,
  col: number,
  rand: () => number,
): PixelPos {
  // Keep shots close to the tile center with at most ±TILE_SIZE/4 of
  // random offset. Wide jitter (full-tile minus margin) made AI fire
  // scatter into neighbouring walls and miss their intended target.
  const jitterRange = TILE_SIZE / 2; // full spread = ±TILE_SIZE/4
  const centerX = col * TILE_SIZE + TILE_SIZE / 2;
  const centerY = row * TILE_SIZE + TILE_SIZE / 2;
  return {
    x: centerX + (rand() - 0.5) * jitterRange,
    y: centerY + (rand() - 0.5) * jitterRange,
  };
}

/** The fewest destroyable wall tiles connecting `interior` to the `outside`
 *  flood, ordered shell-first (outside end first). A 0-1 BFS over the enemy's
 *  zone box: stepping onto a non-wall tile is free, onto a single-hit wall
 *  costs one shot, and a reinforced wall (absorbs the first hit, so one chain
 *  shot can't clear it) is impassable — the breach routes around it. Returns
 *  null when the cheapest breach exceeds `cap` shots or none exists in-box. */
function findBreachPath(
  state: BattleViewState,
  enemy: Player,
  interior: readonly TileKey[],
  outside: ReadonlySet<TileKey>,
  cap: number,
): TilePos[] | null {
  const walls = enemy.walls;
  const box = breachBox(state, interior);
  const boxW = box.maxC - box.minC + 1;
  const size = boxW * (box.maxR - box.minR + 1);
  const localId = (row: number, col: number): number =>
    (row - box.minR) * boxW + (col - box.minC);
  const inBox = (row: number, col: number): boolean =>
    row >= box.minR && row <= box.maxR && col >= box.minC && col <= box.maxC;

  const dist = new Int32Array(size).fill(BREACH_UNREACHED);
  const parent = new Int32Array(size).fill(-1);
  // Dial's algorithm: one bucket per distance 0..cap. Distances never exceed
  // `cap` (paths costing more are pruned), so a fixed bucket array suffices and
  // processing buckets in order settles each tile at its minimum cost.
  const buckets: number[][] = Array.from({ length: cap + 1 }, () => []);

  for (const key of interior) {
    const { row, col } = unpackTile(key);
    if (!inBox(row, col)) continue;
    const id = localId(row, col);
    dist[id] = 0;
    buckets[0]!.push(id);
  }

  for (let cost = 0; cost <= cap; cost++) {
    const bucket = buckets[cost]!;
    while (bucket.length > 0) {
      const id = bucket.pop()!;
      if (dist[id] !== cost) continue; // stale (settled cheaper already)
      const row = box.minR + Math.floor(id / boxW);
      const col = box.minC + (id % boxW);
      // Reaching an outside tile means the path's walls, if destroyed, let the
      // flood in — `cost` is the breach cost. Sources are intact interior, so
      // the first outside tile settled is the global minimum (cost >= 1).
      if (outside.has(packTile(row, col))) {
        return reconstructBreachWalls(parent, id, box, boxW, walls);
      }
      for (const [dr, dc] of DIRS_8) {
        const nr = row + dr;
        const nc = col + dc;
        if (!inBox(nr, nc)) continue;
        const nKey = packTile(nr, nc);
        let step = 0;
        if (walls.has(nKey)) {
          // A reinforced wall can't be cleared by the chain's single shot.
          if (shouldAbsorbWallHit(enemy, nKey)) continue;
          step = 1;
        }
        const nextCost = cost + step;
        if (nextCost > cap) continue;
        const nId = localId(nr, nc);
        if (nextCost < dist[nId]!) {
          dist[nId] = nextCost;
          parent[nId] = id;
          buckets[nextCost]!.push(nId);
        }
      }
    }
  }
  return null;
}

/** Walk the BFS parent chain from the settled outside tile back to its interior
 *  source, collecting only the wall tiles crossed — the breach shots, in
 *  shell-first (outside→interior) order. */
function reconstructBreachWalls(
  parent: Int32Array,
  endId: number,
  box: TileBounds,
  boxW: number,
  walls: ReadonlySet<TileKey>,
): TilePos[] {
  const shots: TilePos[] = [];
  for (let id = endId; id !== -1; id = parent[id]!) {
    const row = box.minR + Math.floor(id / boxW);
    const col = box.minC + (id % boxW);
    if (walls.has(packTile(row, col))) shots.push({ row, col });
  }
  return shots;
}

/** The grid box the breach search spans: the enclosure's river zone (which
 *  always contains the whole ring plus the outside-flood tiles beside it), or —
 *  when the zone can't be derived — the interior's bounding box grown by a
 *  margin wider than any wall ring. */
function breachBox(
  state: BattleViewState,
  interior: readonly TileKey[],
): TileBounds {
  const first = unpackTile(interior[0]!);
  const zone = zoneAt(state.map, first.row, first.col);
  const zoneBox = zone === undefined ? null : zoneTileBounds(state.map, zone);
  if (zoneBox) return zoneBox;

  let minR = first.row;
  let maxR = first.row;
  let minC = first.col;
  let maxC = first.col;
  for (const key of interior) {
    const { row, col } = unpackTile(key);
    if (row < minR) minR = row;
    if (row > maxR) maxR = row;
    if (col < minC) minC = col;
    if (col > maxC) maxC = col;
  }
  return {
    minR: Math.max(0, minR - BREACH_FALLBACK_BOX_MARGIN),
    maxR: Math.min(GRID_ROWS - 1, maxR + BREACH_FALLBACK_BOX_MARGIN),
    minC: Math.max(0, minC - BREACH_FALLBACK_BOX_MARGIN),
    maxC: Math.min(GRID_COLS - 1, maxC + BREACH_FALLBACK_BOX_MARGIN),
  };
}
