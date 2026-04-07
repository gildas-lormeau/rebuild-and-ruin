/**
 * AI Strategy — battle phase implementation.
 *
 * Contains battle planning, target picking, shot tracking,
 * and chain attack logic used by DefaultStrategy.
 */

import { canFireOwnCannon } from "../game/battle-system.ts";
import { filterActiveFiringCannons } from "../game/cannon-system.ts";
import type { Cannon, Cannonball } from "../shared/battle-types.ts";
import {
  computeCardinalObstacleMask,
  filterActiveEnemies,
  getBattleInterior,
} from "../shared/board-occupancy.ts";
import { MODIFIER_ID, TOWER_SIZE } from "../shared/game-constants.ts";
import type { GameMap, PixelPos, TilePos } from "../shared/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "../shared/grid.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import type { Rng } from "../shared/rng.ts";
import {
  cannonSize,
  computeOutside,
  DIRS_4,
  DIRS_8,
  inBounds,
  isBalloonCannon,
  isCannonTile,
  isGrass,
  manhattanDistance,
  orderByNearest,
  packTile,
  pxToTile,
  unpackTile,
} from "../shared/spatial.ts";
import type { BattleViewState } from "../shared/system-interfaces.ts";
import type {
  PrioritizedTilePos,
  StrategicPixelPos,
} from "./ai-build-types.ts";
import { traitLookup } from "./ai-constants.ts";

type TargetCandidate = PrioritizedTilePos;

type StructuralHitCandidate = {
  tiles: TilePos[];
  enclosuresBroken: number;
};

/** Minimum grunts targeting a player before a grunt sweep is considered.
 *  Lowered during grunt-heavy modifiers (grunt_surge, frozen_river) so the
 *  AI reacts sooner to the increased threat. */
const GRUNT_SWEEP_THRESHOLD = 15;
const GRUNT_SWEEP_THRESHOLD_MODIFIER = 8;
/** Skip charity sweep if the enemy has more usable cannons than this. */
const CHARITY_CANNON_THRESHOLD = 6;
/** Pockets smaller than this are worth destroying — can't fit a 2×2 cannon.
 *  Distinct from DESTROY_POCKET_MAX_SIZE (build scoring) which is higher (9)
 *  because build prevention is stricter than battle destruction. */
const DESTROY_POCKET_MAX_SIZE = 4;
/** Minimum number of small pockets before pocket destruction triggers. */
const POCKET_COUNT_THRESHOLD = 5;
/** Maximum wall tiles targeted in a single pocket destruction chain. */
const MAX_POCKET_TARGETS = 5;
/** Minimum connected wall tiles needed to start a wall demolition run. */
const MIN_WALL_SEGMENT_LENGTH = 4;
/** Maximum wall tiles targeted in a single wall demolition chain. */
const MAX_WALL_DEMOLITION_TARGETS = 10;
/** Timer ticks remaining that define the "second half" of battle. */
const BATTLE_SECOND_HALF_TIMER = 5;
/** Chance to switch focus to a different enemy in the second half. */
const TARGET_SWITCH_PROBABILITY = 0.25;
/** Chance to target a strategic wall tile (flanked by 2+ obstacles). */
const STRATEGIC_TARGET_PROBABILITY = 1 / 4;
/** Chance to target a wall tile blocking a grunt's path to its tower. */
const GRUNT_WALL_TARGET_PROBABILITY = 1 / 8;
/** How many of the closest candidates to pick randomly from. */
const TOP_TARGET_PICK_COUNT = 3;
/** Pixel inset from tile edges to prevent cannonballs spilling into neighbors. */
const TARGET_TILE_MARGIN = 1;
/** Minimum preferred distance (in tiles) from crosshair for target spread. */
const SWEET_SPOT_MIN_DISTANCE = 0;
/** Width of the preferred distance band (sweet spot = min .. min + range). */
const SWEET_SPOT_DISTANCE_RANGE = 5;
/** Tiles per side of the base (lateral from anchor). */
const ICE_TRENCH_BASE_HALF = 2;
/** Tiles per arm extending from each end of the base toward the enemy. */
const ICE_TRENCH_ARM_LENGTH = 2;

/** Count cannons that are alive and enclosed (usable for firing). */
export function countUsableCannons(
  state: BattleViewState,
  playerId: ValidPlayerSlot,
): number {
  const player = state.players[playerId]!;
  let count = 0;
  for (let i = 0; i < player.cannons.length; i++) {
    if (canFireOwnCannon(state, playerId, i)) count++;
  }
  return count;
}

/** Plan a grunt sweep: chain-fire at enemy grunts on our territory. */
export function planGruntSweep(
  state: BattleViewState,
  playerId: ValidPlayerSlot,
  usableCannonCount: number,
  rng: Rng,
): TilePos[] | null {
  return planGruntTargets(state, playerId, usableCannonCount, rng);
}

/** Plan a charity sweep: kill grunts on an enemy's territory when they can't. */
export function planCharitySweep(
  state: BattleViewState,
  playerId: ValidPlayerSlot,
  usableCannonCount: number,
  rng: Rng,
): TilePos[] | null {
  for (const enemy of state.players) {
    if (enemy.id === playerId || enemy.eliminated) continue;
    if (filterActiveFiringCannons(enemy).length > CHARITY_CANNON_THRESHOLD)
      continue;
    const targets = planGruntTargets(state, enemy.id, usableCannonCount, rng);
    if (targets) return targets;
  }
  return null;
}

/** Plan pocket destruction: find small enclosures (< 2x2) and non-square 4-tile pockets, target one wall per pocket.
 *
 *  Uses getBattleInterior() — interior is intentionally stale during battle
 *  (walls destroyed by cannonballs are not reflected until the next build phase).
 *  Pocket detection uses the last-known enclosure state to pick wall targets. */
export function planPocketDestruction(
  state: BattleViewState,
  playerId: ValidPlayerSlot,
): TilePos[] | null {
  const player = state.players[playerId]!;
  const interior = getBattleInterior(player);
  if (interior.size === 0) return null;
  const components = findEnclosureComponents(interior);
  const pockets = components.filter(
    (comp) =>
      comp.length < DESTROY_POCKET_MAX_SIZE ||
      (comp.length === DESTROY_POCKET_MAX_SIZE && !is2x2(comp)),
  );
  if (pockets.length <= POCKET_COUNT_THRESHOLD) return null;
  // Build a set of all small-pocket tiles for quick lookup
  const pocketTiles = new Set<number>();
  for (const pocket of pockets) {
    for (const k of pocket) pocketTiles.add(k);
  }

  const targets: TilePos[] = [];
  const picked = new Set<number>();
  for (const pocket of pockets) {
    let found = false;
    for (const key of pocket) {
      if (found) break;
      const { r, c } = unpackTile(key);
      for (const [dr, dc] of DIRS_4) {
        const nr = r + dr;
        const nc = c + dc;
        const neighborKey = packTile(nr, nc);
        if (!player.walls.has(neighborKey) || picked.has(neighborKey)) continue;
        // Check that this wall doesn't also border a large enclosure
        let bordersLarge = false;
        for (const [dr2, dc2] of DIRS_4) {
          const ar = nr + dr2;
          const ac = nc + dc2;
          const adjacentKey = packTile(ar, ac);
          if (interior.has(adjacentKey) && !pocketTiles.has(adjacentKey)) {
            bordersLarge = true;
            break;
          }
        }
        if (bordersLarge) continue;
        targets.push({ row: nr, col: nc });
        picked.add(neighborKey);
        found = true;
        break;
      }
    }
  }
  if (targets.length === 0) return null;
  if (targets.length > MAX_POCKET_TARGETS) targets.length = MAX_POCKET_TARGETS;
  return orderByNearest(targets);
}

/** Plan a super attack: like wall demolition but hit every other tile (stride of 2). */
export function planSuperAttack(
  state: BattleViewState,
  playerId: ValidPlayerSlot,
  usableCannonCount: number,
  rng: Rng,
): TilePos[] | null {
  const segment = planWallDemolition(
    state,
    playerId,
    usableCannonCount * 2,
    rng,
  );
  if (!segment) return null;
  // Keep every other tile
  const strided = segment.filter((_, i) => i % 2 === 0);
  return strided.length >= 2 ? strided : null;
}

/** Plan a wall demolition run: find connected enemy wall segment. */
export function planWallDemolition(
  state: BattleViewState,
  playerId: ValidPlayerSlot,
  usableCannonCount: number,
  rng: Rng,
): TilePos[] | null {
  const enemies = filterActiveEnemies(state, playerId);
  rng.shuffle(enemies);
  for (const enemy of enemies) {
    if (enemy.walls.size < MIN_WALL_SEGMENT_LENGTH) continue;
    const wallKeys = [...enemy.walls];
    const startKey = rng.pick(wallKeys);
    const segment = findConnectedWalls(
      enemy.walls,
      startKey,
      usableCannonCount,
      rng,
    );
    if (segment.length >= MIN_WALL_SEGMENT_LENGTH) {
      const maxLength = Math.min(
        segment.length,
        usableCannonCount,
        MAX_WALL_DEMOLITION_TARGETS,
      );
      const length = rng.int(MIN_WALL_SEGMENT_LENGTH, maxLength);
      return segment.slice(0, length).map((k) => {
        const { r, c } = unpackTile(k);
        return { row: r, col: c };
      });
    }
  }
  return null;
}

/** Plan a structural hit: find 1–2 wall tiles whose removal breaks 2+ large
 *  enclosures simultaneously.  Analyses each enemy's wall layout, finds
 *  "outer-shell" wall tiles adjacent to the outside flood, and simulates
 *  removal to count how many enclosures would be breached.
 *  Falls back to 2-tile pairs when single-tile hits aren't available
 *  (thick walls).  Returns up to `maxHits` worth of targets, ordered by
 *  nearest-neighbor for chain execution. */
export function planStructuralHit(
  state: BattleViewState,
  playerId: ValidPlayerSlot,
  maxHits: number,
): TilePos[] | null {
  const enemies = filterActiveEnemies(state, playerId);
  const allHits: StructuralHitCandidate[] = [];

  for (const enemy of enemies) {
    if (enemy.walls.size === 0) continue;
    const hits = findStructuralHits(enemy.walls, state.map.tiles);
    for (const hit of hits) allHits.push(hit);
  }

  if (allHits.length === 0) return null;

  // Prioritize hits that break the most enclosures
  allHits.sort((a, b) => b.enclosuresBroken - a.enclosuresBroken);

  // Collect up to maxHits distinct opportunities (no overlapping tiles)
  const usedTiles = new Set<number>();
  const targets: TilePos[] = [];
  let picked = 0;
  for (const hit of allHits) {
    if (picked >= maxHits) break;
    const overlaps = hit.tiles.some((tile) =>
      usedTiles.has(packTile(tile.row, tile.col)),
    );
    if (overlaps) continue;
    for (const tile of hit.tiles) {
      usedTiles.add(packTile(tile.row, tile.col));
      targets.push(tile);
    }
    picked++;
  }

  return targets.length > 0 ? orderByNearest(targets) : null;
}

/** Plan an ice trench to block enemy grunts crossing the frozen river.
 *  Builds two wings from an anchor point near the AI's most threatened tower,
 *  each extending diagonally toward the enemy zone.  Shape adapts to the ice
 *  layout — produces V shapes on diagonal rivers, U shapes on straight ones.
 *  Only fires when enemy grunts are on the opposite side heading toward us. */
export function planIceTrench(
  state: BattleViewState,
  playerId: ValidPlayerSlot,
): TilePos[] | null {
  const frozenTiles = state.modern?.frozenTiles;
  if (!frozenTiles || frozenTiles.size === 0) return null;

  const player = state.players[playerId]!;
  if (player.ownedTowers.length === 0) return null;
  const playerZone = state.playerZones[playerId];

  // Precondition: collect grunts on the opposite bank (enemy zone, 4-dir
  // adjacent to frozen water).  At battle start, victimPlayerId is stale
  // (pre-retarget), so we check location only.
  const bankGrunts: TilePos[] = [];
  for (const grunt of state.grunts) {
    const gruntZone = state.map.zones[grunt.row]?.[grunt.col];
    if (gruntZone === undefined || gruntZone === playerZone) continue;
    for (const [dr, dc] of DIRS_4) {
      if (frozenTiles.has(packTile(grunt.row + dr, grunt.col + dc))) {
        bankGrunts.push({ row: grunt.row, col: grunt.col });
        break;
      }
    }
  }
  if (bankGrunts.length === 0) return null;

  // 1. Find shoreline: frozen tiles 4-dir adjacent to AI-zone grass
  const shoreline: number[] = [];
  for (const key of frozenTiles) {
    const { r, c } = unpackTile(key);
    for (const [dr, dc] of DIRS_4) {
      const nr = r + dr;
      const nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      if (
        isGrass(state.map.tiles, nr, nc) &&
        state.map.zones[nr]?.[nc] === playerZone
      ) {
        shoreline.push(key);
        break;
      }
    }
  }
  if (shoreline.length === 0) return null;

  // 2. Anchor = shoreline tile closest to an incoming bank grunt,
  //    so the trench faces where grunts will actually cross.
  let bestAnchorKey = shoreline[0]!;
  let bestDist = Infinity;
  for (const grunt of bankGrunts) {
    for (const shoreKey of shoreline) {
      const { r, c } = unpackTile(shoreKey);
      const dist = manhattanDistance(grunt.row, grunt.col, r, c);
      if (dist < bestDist) {
        bestDist = dist;
        bestAnchorKey = shoreKey;
      }
    }
  }

  // 3. Determine inward direction (from shore into frozen river).
  //    The anchor is adjacent to AI-zone grass — inward is the opposite
  //    of that adjacency (points across the river toward the enemy).
  const anchor = unpackTile(bestAnchorKey);
  let inward: readonly [number, number] | undefined;
  for (const [dr, dc] of DIRS_4) {
    const nr = anchor.r + dr;
    const nc = anchor.c + dc;
    if (!inBounds(nr, nc)) continue;
    if (
      isGrass(state.map.tiles, nr, nc) &&
      state.map.zones[nr]?.[nc] === playerZone
    ) {
      inward = [-dr, -dc] as const;
      break;
    }
  }
  if (!inward) return null;

  // 4. Build U shape: base along shore, arms from ends toward enemy.
  const lateral1: [number, number] = inward[0] === 0 ? [1, 0] : [0, 1];
  const lateral2: [number, number] = inward[0] === 0 ? [-1, 0] : [0, -1];

  const trenchKeys = new Set<number>();
  trenchKeys.add(bestAnchorKey);

  // Base: walk laterally from anchor along the shoreline
  const armStarts: [number, number][] = [];
  for (const lateral of [lateral1, lateral2]) {
    let cr = anchor.r;
    let cc = anchor.c;
    for (let step = 0; step < ICE_TRENCH_BASE_HALF; step++) {
      const nr = cr + lateral[0];
      const nc = cc + lateral[1];
      if (!inBounds(nr, nc)) break;
      const tileKey = packTile(nr, nc);
      if (!frozenTiles.has(tileKey)) break;
      trenchKeys.add(tileKey);
      cr = nr;
      cc = nc;
    }
    armStarts.push([cr, cc]);
  }

  // Arms: from each end of the base, extend diagonally toward the enemy
  // (inward + lateral = smooth curve, no 90° corners)
  for (let idx = 0; idx < armStarts.length; idx++) {
    const [startR, startC] = armStarts[idx]!;
    const lateral = idx === 0 ? lateral1 : lateral2;
    let cr = startR;
    let cc = startC;
    for (let step = 0; step < ICE_TRENCH_ARM_LENGTH; step++) {
      // Prefer diagonal, fall back to straight inward
      let nr = cr + inward[0] + lateral[0];
      let nc = cc + inward[1] + lateral[1];
      if (!inBounds(nr, nc) || !frozenTiles.has(packTile(nr, nc))) {
        nr = cr + inward[0];
        nc = cc + inward[1];
      }
      if (!inBounds(nr, nc)) break;
      const tileKey = packTile(nr, nc);
      if (!frozenTiles.has(tileKey)) break;
      trenchKeys.add(tileKey);
      cr = nr;
      cc = nc;
    }
  }

  // Convert to TilePos
  const result: TilePos[] = [];
  for (const key of trenchKeys) {
    const { r, c } = unpackTile(key);
    result.push({ row: r, col: c });
  }

  return result.length > 0 ? orderByNearest(result) : null;
}

export function pickTarget(
  state: BattleViewState,
  playerId: ValidPlayerSlot,
  crosshair: PixelPos,
  focusFirePlayerId: ValidPlayerSlot | undefined,
  shotCounts: WeakMap<Cannon, number>,
  wallsOnly?: boolean,
  battleTactics = 2,
  rng: Rng = state.rng,
): StrategicPixelPos | null {
  const rand = () => rng.next();
  // Second half of battle: 1/4 chance to switch to the other enemy
  const secondHalf = state.timer <= BATTLE_SECOND_HALF_TIMER;
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
  const basePool = priorityTargets.length > 0 ? priorityTargets : filtered;

  // Prefer targets 3–8 tiles from crosshair to spread damage across the enemy.
  const target = pickSweetSpotTarget(basePool, currentRow, currentCol, rand);
  // Jitter within the target tile (never spill into adjacent tiles)
  return jitterWithinTile(target.row, target.col, rand);
}

export function trackShot(
  state: BattleViewState,
  playerId: ValidPlayerSlot,
  crosshair: PixelPos,
  shotCounts: WeakMap<Cannon, number>,
): void {
  const row = pxToTile(crosshair.y);
  const col = pxToTile(crosshair.x);
  for (const other of filterActiveEnemies(state, playerId)) {
    for (const cannon of other.cannons) {
      if (isBalloonCannon(cannon)) continue;
      if (isCannonTile(cannon, row, col)) {
        shotCounts.set(cannon, (shotCounts.get(cannon) ?? 0) + 1);
        return;
      }
    }
  }
}

function collectStrategicWallTargets(
  state: BattleViewState,
  playerId: ValidPlayerSlot,
  focusFirePlayerId: ValidPlayerSlot | undefined,
): TilePos[] {
  const strategic: TilePos[] = [];
  for (const other of filterActiveEnemies(state, playerId)) {
    if (focusFirePlayerId != null && other.id !== focusFirePlayerId) continue;
    for (const key of other.walls) {
      const { r: wallRow, c: wallCol } = unpackTile(key);
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
  playerId: ValidPlayerSlot,
): TilePos[] {
  const gruntWalls: TilePos[] = [];
  for (const grunt of state.grunts) {
    if (grunt.victimPlayerId === playerId) continue;
    if (grunt.targetTowerIdx == null) continue;
    const tower = state.map.towers[grunt.targetTowerIdx];
    if (!tower) continue;
    const enemy = state.players[grunt.victimPlayerId];
    if (!enemy || enemy.eliminated) continue;
    let bestTowerRow = tower.row,
      bestTowerCol = tower.col,
      bestDistance = Infinity;
    for (let tileRow = tower.row; tileRow < tower.row + TOWER_SIZE; tileRow++) {
      for (
        let tileCol = tower.col;
        tileCol < tower.col + TOWER_SIZE;
        tileCol++
      ) {
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
      }
    }
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

function collectEnemyTargets(
  state: BattleViewState,
  playerId: ValidPlayerSlot,
  focusFirePlayerId: ValidPlayerSlot | undefined,
  switchTarget: boolean,
  shotCounts: WeakMap<Cannon, number>,
  wallsOnly?: boolean,
): TargetCandidate[] {
  const targets: TargetCandidate[] = [];
  for (const other of filterActiveEnemies(state, playerId)) {
    if (!isEnemyEligibleForFocus(other.id, focusFirePlayerId, switchTarget))
      continue;

    if (!wallsOnly) {
      for (const cannon of filterActiveFiringCannons(other)) {
        if (
          state.capturedCannons.some(
            (cc) => cc.cannon === cannon && cc.capturerId === playerId,
          )
        ) {
          continue;
        }
        // Skip if we've already fired enough shots to destroy it
        const shots = shotCounts.get(cannon) ?? 0;
        if (shots >= state.cannonMaxHp) continue;
        const size = cannonSize(cannon.mode);
        const targetRow = cannon.row + (size - 1) / 2;
        const targetCol = cannon.col + (size - 1) / 2;
        targets.push({ row: targetRow, col: targetCol, priority: shots > 0 });
      }
    }

    for (const key of other.walls) {
      const { r: wallRow, c: wallCol } = unpackTile(key);
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

function isEnemyEligibleForFocus(
  enemyId: number,
  focusFirePlayerId: ValidPlayerSlot | undefined,
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
  const margin = TARGET_TILE_MARGIN;
  const low = margin;
  const high = TILE_SIZE - margin;
  return {
    x: col * TILE_SIZE + low + rand() * (high - low),
    y: row * TILE_SIZE + low + rand() * (high - low),
  };
}

/** Target grunts attacking a specific player, ordered by nearest neighbor from a random start.
 *  @param victimPlayerId — the player whose territory the grunts are attacking (not the AI).
 *  During frozen river, skip grunts heading cross-zone (they're attacking the enemy, not us). */
function planGruntTargets(
  state: BattleViewState,
  victimPlayerId: ValidPlayerSlot,
  usableCannonCount: number,
  rng: Rng,
): TilePos[] | null {
  const frozenActive = state.modern?.frozenTiles != null;
  const defenderZone = state.playerZones[victimPlayerId];
  const grunts = state.grunts.filter((grunt) => {
    if (grunt.victimPlayerId !== victimPlayerId) return false;
    // Frozen river: grunts in the defender's own zone will cross to attack the enemy —
    // don't kill them. Only target grunts that are already in enemy territory heading back.
    if (frozenActive) {
      const gruntZone = state.map.zones[grunt.row]?.[grunt.col];
      if (gruntZone === defenderZone) return false;
    }
    return true;
  });
  const mod = state.modern?.activeModifier;
  const threshold =
    mod === MODIFIER_ID.GRUNT_SURGE || mod === MODIFIER_ID.FROZEN_RIVER
      ? GRUNT_SWEEP_THRESHOLD_MODIFIER
      : GRUNT_SWEEP_THRESHOLD;
  if (grunts.length <= threshold) return null;
  const positions = grunts.map((grunt) => ({ row: grunt.row, col: grunt.col }));
  // Random starting point
  const startIndex = rng.int(0, positions.length - 1);
  [positions[0], positions[startIndex]] = [
    positions[startIndex]!,
    positions[0]!,
  ];
  return orderByNearest(positions, usableCannonCount);
}

/** Check if a 4-tile pocket forms a 2x2 square (can fit a cannon). */
function is2x2(keys: readonly number[]): boolean {
  const tiles = keys.map((key) => unpackTile(key));
  const minRow = Math.min(...tiles.map((tile) => tile.r));
  const minCol = Math.min(...tiles.map((tile) => tile.c));
  const expected: Set<number> = new Set([
    packTile(minRow, minCol),
    packTile(minRow, minCol + 1),
    packTile(minRow + 1, minCol),
    packTile(minRow + 1, minCol + 1),
  ]);
  return keys.length === 4 && keys.every((key) => expected.has(key));
}

/** Analyse a player's walls and find single- or double-tile removals that
 *  breach 2+ large enclosures at once.  Only enclosures larger than
 *  DESTROY_POCKET_MAX_SIZE are considered (smaller ones are pockets). */
function findStructuralHits(
  walls: ReadonlySet<number>,
  mapTiles: GameMap["tiles"],
): StructuralHitCandidate[] {
  // 1. Compute outside and interior
  const outside = computeOutside(walls);
  const interior = new Set<number>();
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const key = packTile(row, col);
      if (!outside.has(key) && !walls.has(key) && isGrass(mapTiles, row, col)) {
        interior.add(key);
      }
    }
  }

  // 2. Connected components of interior (4-dir) — each is an enclosure
  const components = findEnclosureComponents(interior);

  // Only consider large enclosures (> DESTROY_POCKET_MAX_SIZE tiles)
  const large = components.filter(
    (comp) => comp.length > DESTROY_POCKET_MAX_SIZE,
  );
  if (large.length < 2) return [];

  // Label each interior tile with its large-enclosure index
  const labels = new Map<number, number>();
  for (let idx = 0; idx < large.length; idx++) {
    for (const key of large[idx]!) labels.set(key, idx);
  }

  // 3. Find outer-shell walls (8-dir adjacent to outside)
  const outerWalls: number[] = [];
  for (const wallKey of walls) {
    const { r, c } = unpackTile(wallKey);
    for (const [dr, dc] of DIRS_8) {
      const nr = r + dr;
      const nc = c + dc;
      if (inBounds(nr, nc) && outside.has(packTile(nr, nc))) {
        outerWalls.push(wallKey);
        break;
      }
    }
  }

  // 4. Single-tile structural hits
  const hits: StructuralHitCandidate[] = [];
  for (const wallKey of outerWalls) {
    const bordered = borderedEnclosures(wallKey, labels);
    if (bordered.size < 2) continue;

    const modWalls = new Set(walls);
    modWalls.delete(wallKey);
    const broken = countBrokenEnclosures(modWalls, large);
    if (broken >= 2) {
      const { r, c } = unpackTile(wallKey);
      hits.push({ tiles: [{ row: r, col: c }], enclosuresBroken: broken });
    }
  }

  // 5. Two-tile pairs (only when no single-tile hits exist)
  if (hits.length === 0) {
    for (const wallKey of outerWalls) {
      const { r, c } = unpackTile(wallKey);
      for (const [dr, dc] of DIRS_4) {
        const nr = r + dr;
        const nc = c + dc;
        if (!inBounds(nr, nc)) continue;
        const neighborKey = packTile(nr, nc);
        // Deduplicate pairs and ensure neighbor is also a wall
        if (!walls.has(neighborKey) || neighborKey <= wallKey) continue;

        const bordered = borderedEnclosuresPair(wallKey, neighborKey, labels);
        if (bordered.size < 2) continue;

        const modWalls = new Set(walls);
        modWalls.delete(wallKey);
        modWalls.delete(neighborKey);
        const broken = countBrokenEnclosures(modWalls, large);
        if (broken >= 2) {
          const { r: nr2, c: nc2 } = unpackTile(neighborKey);
          hits.push({
            tiles: [
              { row: r, col: c },
              { row: nr2, col: nc2 },
            ],
            enclosuresBroken: broken,
          });
        }
      }
    }
  }

  return hits;
}

/** Which large-enclosure indices does a pair of wall tiles border? (8-dir) */
function borderedEnclosuresPair(
  keyA: number,
  keyB: number,
  labels: ReadonlyMap<number, number>,
): Set<number> {
  const result = borderedEnclosures(keyA, labels);
  for (const label of borderedEnclosures(keyB, labels)) result.add(label);
  return result;
}

/** Which large-enclosure indices does a wall tile border? (8-dir) */
function borderedEnclosures(
  wallKey: number,
  labels: ReadonlyMap<number, number>,
): Set<number> {
  const { r, c } = unpackTile(wallKey);
  const result = new Set<number>();
  for (const [dr, dc] of DIRS_8) {
    const nr = r + dr;
    const nc = c + dc;
    if (!inBounds(nr, nc)) continue;
    const label = labels.get(packTile(nr, nc));
    if (label !== undefined) result.add(label);
  }
  return result;
}

/** Simulate wall removal and count how many enclosures now have tiles
 *  reachable from map edges (breached by the 8-dir flood). */
function countBrokenEnclosures(
  modifiedWalls: ReadonlySet<number>,
  enclosures: readonly (readonly number[])[],
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

/** Find connected components of a tile set using 4-dir connectivity. */
function findEnclosureComponents(tileSet: ReadonlySet<number>): number[][] {
  const visited = new Set<number>();
  const components: number[][] = [];
  for (const key of tileSet) {
    if (visited.has(key)) continue;
    const component: number[] = [];
    const queue = [key];
    visited.add(key);
    while (queue.length > 0) {
      const current = queue.pop()!;
      component.push(current);
      const { r, c } = unpackTile(current);
      for (const [dr, dc] of DIRS_4) {
        const neighborKey = packTile(r + dr, c + dc);
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

/** Random walk to find up to maxLength connected wall tiles. */
function findConnectedWalls(
  walls: ReadonlySet<number>,
  startKey: number,
  maxLength: number,
  rng: Rng,
): number[] {
  const visited = new Set<number>();
  visited.add(startKey);
  const result: number[] = [startKey];
  let current = startKey;
  while (result.length < maxLength) {
    const { r, c } = unpackTile(current);
    const neighbors: number[] = [];
    for (const [dr, dc] of DIRS_4) {
      const nr = r + dr;
      const nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const neighborKey = packTile(nr, nc);
      if (!visited.has(neighborKey) && walls.has(neighborKey))
        neighbors.push(neighborKey);
    }
    if (neighbors.length === 0) break;
    current = rng.pick(neighbors);
    visited.add(current);
    result.push(current);
  }
  return result;
}
