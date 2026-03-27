/**
 * AI Strategy — battle phase implementation.
 *
 * Contains battle planning, target picking, shot tracking,
 * and chain attack logic used by DefaultStrategy.
 */

import { SMALL_POCKET_MAX_SIZE, traitLookup } from "./ai-constants.ts";
import { canFire } from "./battle-system.ts";
import { getActiveEnemies, getCardinalObstacleMask } from "./board-occupancy.ts";
import { getActiveFiringCannons } from "./cannon-system.ts";
import type {
  PixelPos,
  PrioritizedTilePos,
  StrategicPixelPos,
  TilePos,
} from "./geometry-types.ts";
import { TILE_SIZE } from "./grid.ts";
import type { Rng } from "./rng.ts";
import {
  cannonSize,
  DIRS_4,
  inBounds,
  isCannonTile,
  manhattanDistance,
  orderByNearest,
  packTile,
  pxToTile,
  unpackTile,
} from "./spatial.ts";
import { type Cannon, type Cannonball, CannonMode, type GameState } from "./types.ts";

type TargetCandidate = PrioritizedTilePos;

/** Minimum grunts targeting a player before a grunt sweep is considered. */
const GRUNT_SWEEP_THRESHOLD = 15;
/** Skip charity sweep if the enemy has more usable cannons than this. */
const CHARITY_CANNON_THRESHOLD = 6;
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
const SWEET_SPOT_MIN_DISTANCE = 3;
/** Width of the preferred distance band (sweet spot = min .. min + range). */
const SWEET_SPOT_DISTANCE_RANGE = 5;

/** Count cannons that are alive and enclosed (usable for firing). */
export function countUsableCannons(state: GameState, playerId: number): number {
  const player = state.players[playerId]!;
  let count = 0;
  for (let i = 0; i < player.cannons.length; i++) {
    if (canFire(state, playerId, i)) count++;
  }
  return count;
}

/** Plan a grunt sweep: chain-fire at enemy grunts on our territory. */
export function planGruntSweep(
  state: GameState,
  playerId: number,
  readyCount: number,
  rng: Rng,
): TilePos[] | null {
  return planGruntTargets(state, playerId, readyCount, rng);
}

/** Plan a charity sweep: kill grunts on an enemy's territory when they can't. */
export function planCharitySweep(
  state: GameState,
  playerId: number,
  readyCount: number,
  rng: Rng,
): TilePos[] | null {
  for (const enemy of state.players) {
    if (enemy.id === playerId || enemy.eliminated) continue;
    if (getActiveFiringCannons(enemy).length > CHARITY_CANNON_THRESHOLD) continue;
    const targets = planGruntTargets(state, enemy.id, readyCount, rng);
    if (targets) return targets;
  }
  return null;
}

/** Plan pocket destruction: find small enclosures (< 2x2) and non-square 4-tile pockets, target one wall per pocket. */
export function planPocketDestruction(
  state: GameState,
  playerId: number,
): TilePos[] | null {
  const player = state.players[playerId]!;
  if (player.interior.size === 0) return null;
  const visited = new Set<number>();
  const pockets: number[][] = [];
  for (const key of player.interior) {
    if (visited.has(key)) continue;
    const component: number[] = [];
    const queue = [key];
    visited.add(key);
    while (queue.length > 0) {
      const current = queue.pop()!;
      component.push(current);
      const { r, c } = unpackTile(current);
      for (const [dr, dc] of DIRS_4) {
        const nk = packTile(r + dr, c + dc);
        if (!visited.has(nk) && player.interior.has(nk)) {
          visited.add(nk);
          queue.push(nk);
        }
      }
    }
    if (
      component.length < SMALL_POCKET_MAX_SIZE ||
      (component.length === SMALL_POCKET_MAX_SIZE && !is2x2(component))
    ) {
      pockets.push(component);
    }
  }
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
        const nk = packTile(nr, nc);
        if (!player.walls.has(nk) || picked.has(nk)) continue;
        // Check that this wall doesn't also border a large enclosure
        let bordersLarge = false;
        for (const [dr2, dc2] of DIRS_4) {
          const ar = nr + dr2;
          const ac = nc + dc2;
          const ak = packTile(ar, ac);
          if (player.interior.has(ak) && !pocketTiles.has(ak)) {
            bordersLarge = true;
            break;
          }
        }
        if (bordersLarge) continue;
        targets.push({ row: nr, col: nc });
        picked.add(nk);
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
  state: GameState,
  playerId: number,
  readyCount: number,
  rng: Rng,
): TilePos[] | null {
  const segment = planWallDemolition(state, playerId, readyCount * 2, rng);
  if (!segment) return null;
  // Keep every other tile
  const strided = segment.filter((_, i) => i % 2 === 0);
  return strided.length >= 2 ? strided : null;
}

/** Plan a wall demolition run: find connected enemy wall segment. */
export function planWallDemolition(
  state: GameState,
  playerId: number,
  readyCount: number,
  rng: Rng,
): TilePos[] | null {
  const enemies = getActiveEnemies(state, playerId);
  rng.shuffle(enemies);
  for (const enemy of enemies) {
    if (enemy.walls.size < MIN_WALL_SEGMENT_LENGTH) continue;
    const wallKeys = [...enemy.walls];
    const startKey = rng.pick(wallKeys);
    const segment = findConnectedWalls(enemy.walls, startKey, readyCount, rng);
    if (segment.length >= MIN_WALL_SEGMENT_LENGTH) {
      const maxLength = Math.min(
        segment.length,
        readyCount,
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

export function pickTarget(
  state: GameState,
  playerId: number,
  crosshair: PixelPos,
  focusPlayerId: number | null,
  shotCounts: WeakMap<Cannon, number>,
  wallsOnly?: boolean,
  battleTactics = 2,
  rng: Rng = state.rng,
): StrategicPixelPos | null {
  const rand = () => rng.next();
  // Second half of battle: 1/4 chance to switch to the other enemy
  const secondHalf = state.timer <= BATTLE_SECOND_HALF_TIMER;
  const switchTarget =
    secondHalf && focusPlayerId != null && rand() < TARGET_SWITCH_PROBABILITY;

  const targets = collectEnemyTargets(
    state,
    playerId,
    focusPlayerId,
    switchTarget,
    shotCounts,
    wallsOnly,
  );

  // Filter out any target tile that already has a cannonball in flight
  const filtered = targets.filter(
    (t) => !isTileTargetedByInFlightBall(state, t.row, t.col),
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
      focusPlayerId,
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
  const priorityTargets = filtered.filter((t) => t.priority);
  const basePool = priorityTargets.length > 0 ? priorityTargets : filtered;

  // Prefer targets 3–8 tiles from crosshair to spread damage across the enemy.
  const target = pickSweetSpotTarget(basePool, currentRow, currentCol, rand);
  // Jitter within the target tile (never spill into adjacent tiles)
  return jitterWithinTile(target.row, target.col, rand);
}

export function trackShot(
  state: GameState,
  playerId: number,
  crosshair: PixelPos,
  shotCounts: WeakMap<Cannon, number>,
): void {
  const row = pxToTile(crosshair.y);
  const col = pxToTile(crosshair.x);
  for (const other of getActiveEnemies(state, playerId)) {
    for (const cannon of other.cannons) {
      if (cannon.kind === CannonMode.BALLOON) continue;
      if (isCannonTile(cannon, row, col)) {
        shotCounts.set(cannon, (shotCounts.get(cannon) ?? 0) + 1);
        return;
      }
    }
  }
}

function collectStrategicWallTargets(
  state: GameState,
  playerId: number,
  focusPlayerId: number | null,
): TilePos[] {
  const strategic: TilePos[] = [];
  for (const other of getActiveEnemies(state, playerId)) {
    if (focusPlayerId != null && other.id !== focusPlayerId) continue;
    for (const key of other.walls) {
      const { r: wallRow, c: wallCol } = unpackTile(key);
      // Skip walls already targeted by a cannonball in flight
      if (isTileTargetedByInFlightBall(state, wallRow, wallCol)) continue;
      // Track obstacle directions: [north, south, west, east]
      const obstacles = getCardinalObstacleMask(state, wallRow, wallCol, {
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
  state: GameState,
  playerId: number,
): TilePos[] {
  const gruntWalls: TilePos[] = [];
  for (const grunt of state.grunts) {
    if (grunt.targetPlayerId === playerId) continue;
    if (grunt.targetTowerIdx == null) continue;
    const tower = state.map.towers[grunt.targetTowerIdx];
    if (!tower) continue;
    const enemy = state.players[grunt.targetPlayerId];
    if (!enemy || enemy.eliminated) continue;
    let bestTowerRow = tower.row,
      bestTowerCol = tower.col,
      bestDistance = Infinity;
    for (let tileRow = tower.row; tileRow < tower.row + 2; tileRow++) {
      for (let tileCol = tower.col; tileCol < tower.col + 2; tileCol++) {
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
      const nk = packTile(nr, nc);
      if (enemy.walls.has(nk) && !isTileTargetedByInFlightBall(state, nr, nc)) {
        gruntWalls.push({ row: nr, col: nc });
      }
    }
  }
  return gruntWalls;
}

/** True if any cannonball in flight is targeting (row, col). */
function isTileTargetedByInFlightBall(
  state: GameState,
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
  return (
    pxToTile(b.targetY) === row &&
    pxToTile(b.targetX) === col
  );
}

function collectEnemyTargets(
  state: GameState,
  playerId: number,
  focusPlayerId: number | null,
  switchTarget: boolean,
  shotCounts: WeakMap<Cannon, number>,
  wallsOnly?: boolean,
): TargetCandidate[] {
  const targets: TargetCandidate[] = [];
  for (const other of getActiveEnemies(state, playerId)) {
    if (!isEnemyEligibleForFocus(other.id, focusPlayerId, switchTarget))
      continue;

    if (!wallsOnly) {
      for (const cannon of getActiveFiringCannons(other)) {
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
        const size = cannonSize(cannon);
        const targetRow = cannon.row + (size - 1) / 2;
        const targetCol = cannon.col + (size - 1) / 2;
        targets.push({ row: targetRow, col: targetCol, priority: shots > 0 });
      }
    }

    for (const key of other.walls) {
      const { r: wallRow, c: wallCol } = unpackTile(key);
      targets.push({ row: wallRow, col: wallCol, priority: false });
    }
  }

  return targets;
}

function isEnemyEligibleForFocus(
  enemyId: number,
  focusPlayerId: number | null,
  switchTarget: boolean,
): boolean {
  if (focusPlayerId == null) return true;
  if (!switchTarget) return enemyId === focusPlayerId;
  return enemyId !== focusPlayerId;
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

/** Target grunts attacking a specific player, ordered by nearest neighbor from a random start. */
function planGruntTargets(
  state: GameState,
  targetPlayerId: number,
  readyCount: number,
  rng: Rng,
): TilePos[] | null {
  const grunts = state.grunts.filter(
    (g) => g.targetPlayerId === targetPlayerId,
  );
  if (grunts.length <= GRUNT_SWEEP_THRESHOLD) return null;
  const positions = grunts.map((g) => ({ row: g.row, col: g.col }));
  // Random starting point
  const startIndex = rng.int(0, positions.length - 1);
  [positions[0], positions[startIndex]] = [
    positions[startIndex]!,
    positions[0]!,
  ];
  return orderByNearest(positions, readyCount);
}

/** Check if a 4-tile pocket forms a 2x2 square (can fit a cannon). */
function is2x2(keys: readonly number[]): boolean {
  const tiles = keys.map((key) => unpackTile(key));
  const minRow = Math.min(...tiles.map((t) => t.r));
  const minCol = Math.min(...tiles.map((t) => t.c));
  const expected = new Set([
    packTile(minRow, minCol),
    packTile(minRow, minCol + 1),
    packTile(minRow + 1, minCol),
    packTile(minRow + 1, minCol + 1),
  ]);
  return keys.length === 4 && keys.every((key) => expected.has(key));
}

/** Random walk to find up to maxLength connected wall tiles. */
function findConnectedWalls(
  walls: Set<number>,
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
      const nk = packTile(nr, nc);
      if (!visited.has(nk) && walls.has(nk)) neighbors.push(nk);
    }
    if (neighbors.length === 0) break;
    current = rng.pick(neighbors);
    visited.add(current);
    result.push(current);
  }
  return result;
}
