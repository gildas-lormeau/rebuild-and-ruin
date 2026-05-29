/**
 * AI battle-phase dispatcher: target picking (`pickTarget`), per-cannon shot
 * tracking (`trackShot`), `countUsableCannons`, and the shared helpers used
 * across the per-tactic `ai-plan-*` planner files (`findEnclosureComponents`,
 * the cross-tactic `DESTROY_POCKET_MAX_SIZE` threshold, and the
 * `BattleTargetMemory`/`ShotKey` types).
 */

import {
  canFireOwnCannon,
  getGruntTargetTower,
  pickSupplyShipTarget,
} from "../game/index.ts";
import {
  type Cannonball,
  isBalloonCannon,
  isCannonAlive,
} from "../shared/core/battle-types.ts";
import {
  computeCardinalObstacleMask,
  filterActiveEnemies,
} from "../shared/core/board-occupancy.ts";
import type {
  CannonIdx,
  PixelPos,
  TilePos,
} from "../shared/core/geometry-types.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  TILE_SIZE,
  type TileKey,
} from "../shared/core/grid.ts";
import { isCannonCapturedBy } from "../shared/core/occupancy-queries.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import {
  isPlayerEliminated,
  type Player,
} from "../shared/core/player-types.ts";
import {
  cannonSize,
  computeOutside,
  DIRS_4,
  forEachTowerTile,
  isCannonTile,
  manhattanDistance,
  packTile,
  pxToTile,
  unpackTile,
  zoneAt,
} from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import type { Rng } from "../shared/platform/rng.ts";
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

/** Packed `(playerId, cannonIdx)` key for the per-cannon shot counter map.
 *  Branded so a raw `number` can't be mistakenly fed into shotCounts.get(). */
export type ShotKey = number & { readonly __shotKey: true };

/** Timer seconds remaining that define the "second half" of battle
 *  (state.timer is in seconds; BATTLE_TIMER = 10). */
const BATTLE_SECOND_HALF_TIMER = 5;
/** Chance to switch focus to a different enemy in the second half. */
const TARGET_SWITCH_PROBABILITY = 0.25;
/** Chance to target a strategic wall tile (flanked by 2+ obstacles). */
const STRATEGIC_TARGET_PROBABILITY = 1 / 4;
/** Chance to target a supply ship sailing the river. Aiming uses lead
 *  prediction via `pickSupplyShipTarget`, but the chosen probability
 *  keeps ships from dominating AI shot selection. */
const SUPPLY_SHIP_TARGET_PROBABILITY = 1 / 8;
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
 *  Versioned by `player.walls.size`: during a battle walls are delete-only
 *  (cannonballs/grunts/modifiers destroy; nothing places until the next build),
 *  so size strictly decreases and the single cache entry — overwritten on every
 *  miss — can never serve a stale topology (a new battle's larger post-build
 *  size forces a miss that overwrites the prior entry before it could shrink
 *  back). Read-only and never written to `player.interior`, so the frozen
 *  battle interior that drives rendering and fire-eligibility is untouched.
 *  Pure function of synced walls → identical on every peer, no wire payload. */
const liveEnclosureCache = new WeakMap<
  Player,
  { wallCount: number; components: TileKey[][] }
>();
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
  wallsOnly?: boolean,
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

  const targets = collectEnemyTargets(
    state,
    playerId,
    focusFirePlayerId,
    switchTarget,
    shotCounts,
    wallsOnly,
  );

  // Filter out any target tile that already has a cannonball in flight
  const filtered = targets.filter(
    (tile) => !isTileTargetedByInFlightBall(state, tile.row, tile.col),
  );
  if (filtered.length === 0) return null;

  const currentRow = crosshair.y / TILE_SIZE;
  const currentCol = crosshair.x / TILE_SIZE;

  // Supply-ship targeting — first early gate so it competes fairly with
  // the other tactical picks. Skipped during `wallsOnly` (grunt-sweep
  // mode) since that mode is explicitly about clearing grunts off our
  // territory, not chasing river bonuses. Gated on `supplyShips != null`
  // so the rng roll only happens when ships are actually present —
  // preserves classic-mode determinism (no extra rng consumption when
  // the modifier is inactive).
  const supplyShips = state.modern?.supplyShips;
  if (!wallsOnly && supplyShips != null) {
    const shipProb = traitLookup(battleTactics, [
      0,
      SUPPLY_SHIP_TARGET_PROBABILITY,
      2 * SUPPLY_SHIP_TARGET_PROBABILITY,
    ] as const);
    if (rand() < shipProb) {
      const cannons = state.players[playerId]!.cannons;
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
        return { x: shipTarget.x, y: shipTarget.y };
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
    return jitterWithinTile(target.row, target.col, rand);
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
      return jitterWithinTile(target.row, target.col, rand);
    }
  }

  // Pick a random enclosure of the enemy, then target a wall bordering it.
  // This distributes fire across the enemy's fortress instead of clustering
  // near the AI's crosshair (which starts at the AI's own home tower).
  // `targetMemory` keeps the AI locked onto one enclosure across shots so
  // it doesn't oscillate between enclosures 10-15 tiles apart.
  const enclosureWall = pickEnclosureWallTarget(
    state,
    playerId,
    focusFirePlayerId,
    switchTarget,
    targetMemory,
    rand,
  );
  if (enclosureWall)
    return jitterWithinTile(enclosureWall.row, enclosureWall.col, rand);

  // Fallback: sweet-spot pick from the flat candidate pool.
  const target = pickSweetSpotTarget(filtered, currentRow, currentCol, rand);
  // Jitter within the target tile (never spill into adjacent tiles)
  return jitterWithinTile(target.row, target.col, rand);
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
      if (isBalloonCannon(cannon)) continue;
      if (isCannonTile(cannon, row, col)) {
        const key = shotCountKey(other.id, idx as CannonIdx);
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
    for (const tileKey of comp) {
      if (newOutside.has(tileKey)) {
        broken++;
        break;
      }
    }
  }
  return broken;
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
      // Skip walls already targeted by a cannonball in flight
      if (isTileTargetedByInFlightBall(state, wallRow, wallCol)) continue;
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
        !isTileTargetedByInFlightBall(state, nr, nc)
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
  wallsOnly?: boolean,
): TargetCandidate[] {
  const targets: TargetCandidate[] = [];
  for (const other of filterActiveEnemies(state, playerId)) {
    if (!isEnemyEligibleForFocus(other.id, focusFirePlayerId, switchTarget))
      continue;

    if (!wallsOnly) {
      for (let idx = 0; idx < other.cannons.length; idx++) {
        const cannon = other.cannons[idx]!;
        if (!isCannonAlive(cannon) || isBalloonCannon(cannon)) continue;
        if (isCannonCapturedBy(state, cannon, playerId)) continue;
        // Skip if we've already fired enough shots to destroy it
        const key = shotCountKey(other.id, idx as CannonIdx);
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

/** Stable numeric key for shotCounts: survives cannon object replacement.
 *  Uses a 16-bit shift so cannonIdx has room well beyond any conceivable
 *  per-player cap (slot caps put real values in the low single digits). */
function shotCountKey(playerId: ValidPlayerId, cannonIdx: CannonIdx): ShotKey {
  return ((playerId << 16) | cannonIdx) as ShotKey;
}

/** Pick an enclosure of an eligible enemy, then return a wall bordering it.
 *  Uses a LIVE enclosure view (`liveEnclosuresOf`, recomputed from current
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
  rand: () => number,
): TilePos | null {
  // Collect all enclosures across eligible enemies, tagged with their owner.
  type CachedEnclosure = {
    ownerId: ValidPlayerId;
    walls: ReadonlySet<TileKey>;
    tiles: TileKey[];
  };
  const allEnclosures: CachedEnclosure[] = [];
  for (const other of filterActiveEnemies(state, playerId)) {
    if (!isEnemyEligibleForFocus(other.id, focusFirePlayerId, switchTarget))
      continue;
    // Live (shared, cached) enclosure components — breached ones are absent.
    for (const comp of liveEnclosuresOf(other)) {
      allEnclosures.push({
        ownerId: other.id,
        walls: other.walls,
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

  if (enclosure === undefined) {
    // Pick a random enclosure (uniform — every enclosure equally likely) and
    // start a fresh contiguous walk.
    enclosure = allEnclosures[Math.floor(rand() * allEnclosures.length)]!;
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
        !isTileTargetedByInFlightBall(state, nr, nc)
      ) {
        seen.add(neighborKey);
        borderWalls.push({ row: nr, col: nc });
      }
    }
  }
  if (borderWalls.length === 0) return null;

  // Contiguity bias: prefer a border wall 4-adjacent to the last one hit, so
  // fire concentrates along one segment (deeper breach, cheaper crosshair
  // travel, tighter combo streaks). Fall back to a uniform pick.
  const chosen = pickContiguousWall(
    borderWalls,
    targetMemory.lastWallTileKey,
    rand,
  );
  targetMemory.lastWallTileKey = packTile(chosen.row, chosen.col);
  return chosen;
}

/** Choose a border wall, preferring one cardinally adjacent to `lastKey` to
 *  keep consecutive shots on a contiguous segment; uniform-random otherwise. */
function pickContiguousWall(
  borderWalls: readonly TilePos[],
  lastKey: TileKey | undefined,
  rand: () => number,
): TilePos {
  if (lastKey !== undefined) {
    const { row: lr, col: lc } = unpackTile(lastKey);
    const adjacent = borderWalls.filter(
      (wall) => Math.abs(wall.row - lr) + Math.abs(wall.col - lc) === 1,
    );
    if (adjacent.length > 0)
      return adjacent[Math.floor(rand() * adjacent.length)]!;
  }
  return borderWalls[Math.floor(rand() * borderWalls.length)]!;
}

/** Live enclosure components for an enemy — connected interior regions computed
 *  from the enemy's CURRENT walls (not the frozen battle snapshot). Cached and
 *  shared; recomputed only when the enemy's wall count changes. */
function liveEnclosuresOf(enemy: Player): TileKey[][] {
  const hit = liveEnclosureCache.get(enemy);
  if (hit !== undefined && hit.wallCount === enemy.walls.size)
    return hit.components;
  const components = findEnclosureComponents(computeLiveInterior(enemy.walls));
  liveEnclosureCache.set(enemy, { wallCount: enemy.walls.size, components });
  return components;
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

/** Inverse flood-fill interior from a wall set — mirrors `recomputeInterior`
 *  in build-system (grass not reachable from a map edge through non-wall tiles
 *  is interior), but reads the CURRENT walls so breaches are reflected live. */
function computeLiveInterior(walls: ReadonlySet<TileKey>): Set<TileKey> {
  const outside = computeOutside(walls);
  const interior = new Set<TileKey>();
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const key = packTile(row, col);
      if (!outside.has(key) && !walls.has(key)) interior.add(key);
    }
  }
  return interior;
}

/** True if any cannonball in flight is targeting (row, col). */
function isTileTargetedByInFlightBall(
  state: BattleViewState,
  row: number,
  col: number,
): boolean {
  return state.cannonballs.some((b) => ballTargeting(b, row, col));
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
