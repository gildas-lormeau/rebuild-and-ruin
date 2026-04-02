/**
 * AI Strategy — cannon placement and tower selection implementation.
 *
 * Contains cannon scoring, placement logic, and tower selection
 * used by DefaultStrategy.
 */

import { traitLookup } from "./ai-constants.ts";
import {
  filterActiveEnemies,
  getInterior,
  hasTowerAt,
} from "./board-occupancy.ts";
import {
  cannonSlotsUsed,
  canPlaceCannon,
  isCannonEnclosed,
  placeCannon,
} from "./cannon-system.ts";
import { BALLOON_COST, SUPER_GUN_COST } from "./game-constants.ts";
import type { GameMap, TilePos, Tower } from "./geometry-types.ts";
import { GRID_COLS, GRID_ROWS } from "./grid.ts";
import type { Rng } from "./rng.ts";
import {
  cannonSize,
  computeCannonTileSet,
  DIRS_4,
  forEachCannonTile,
  inBounds,
  isCannonAlive,
  isSuperCannon,
  isWater,
  manhattanDistance,
  packTile,
  towerCenter,
  unpackTile,
} from "./spatial.ts";
import { CannonMode, type GameState, type Player } from "./types.ts";

type CannonCandidate = { row: number; col: number; score: number };

/** Chance to pick the tower closest to zone centroid vs random. */
const CENTROID_TOWER_PROBABILITY = 2 / 3;
/** Tiles from map edge before border penalty kicks in. */
const BORDER_DISTANCE_THRESHOLD = 2;
/** Score penalty per edge-proximity tier. */
const BORDER_PENALTY_MULTIPLIER = 10;
/** How far (in tiles) to scan for nearby water around each cannon tile. */
const WATER_SEARCH_RANGE = 2;
/** Penalty for water directly adjacent (Manhattan distance 1). */
const WATER_ADJACENT_PENALTY = 15;
/** Penalty for water at Manhattan distance 2. */
const WATER_NEAR_PENALTY = 8;
/** Score cost per tile of distance to the nearest owned tower. */
const TOWER_DISTANCE_MULTIPLIER = 2;
/** Penalty when a cannon tile is adjacent to a tower tile (enemy fire splashes into wall). */
const TOWER_ADJACENT_PENALTY = 8;
/** Penalty for each interior tile left with only 0–1 free neighbors (dead space). */
const WASTED_TILE_PENALTY = 10;
/** Random noise added to each score to break ties unpredictably. */
const SCORE_NOISE_RANGE = 2;
/** Minimum cannon slots before the AI considers placing a super gun. */
const SUPER_GUN_SLOT_THRESHOLD = 8;
/** Chance to attempt a super gun when slot threshold is met. */
const SUPER_GUN_PROBABILITY = 1 / 3;

/** Pick a home tower for the given zone. Returns the chosen tower, or null if none available. */
export function autoSelectTower(
  map: GameMap,
  zone: number,
  rng: Rng,
  spatialAwareness = 2,
): Tower | null {
  const zoneTowers = map.towers.filter((tower) => tower.zone === zone);
  if (zoneTowers.length === 0) return null;

  // spatialAwareness: 1 = 1/3 centroid, 2 = 2/3 centroid, 3 = always centroid
  const centroidProb = traitLookup(spatialAwareness, [
    1 / 3,
    CENTROID_TOWER_PROBABILITY,
    1.0,
  ] as const);
  if (rng.bool(centroidProb)) {
    // Pick the tower closest to the zone centroid
    let sumRow = 0,
      sumCol = 0,
      count = 0;
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        if (map.zones[r]![c] === zone) {
          sumRow += r;
          sumCol += c;
          count++;
        }
      }
    }
    if (count > 0) {
      const centroidRow = sumRow / count,
        centroidCol = sumCol / count;
      let bestTower = zoneTowers[0]!;
      let bestDistance = Infinity;
      for (const tower of zoneTowers) {
        const center = towerCenter(tower);
        const distance = manhattanDistance(
          center.row,
          center.col,
          centroidRow,
          centroidCol,
        );
        if (distance < bestDistance) {
          bestDistance = distance;
          bestTower = tower;
        }
      }
      return bestTower;
    }
  }

  return rng.pick(zoneTowers);
}

export function autoPlaceCannons(
  player: Player,
  count: number,
  state: GameState,
  rng: Rng,
  aggressiveness = 2,
  defensiveness = 2,
  spatialAwareness = 2,
): { row: number; col: number; mode: CannonMode }[] {
  const beforeCount = player.cannons.length;
  // Precompute tower centers once — used by all scoring calls
  const towerCenters = player.ownedTowers.map(towerCenter);
  // Cannon scoring noise — controlled by spatialAwareness
  // 1 = noisy (×5), 2 = default (×1), 3 = precise (×0.25)
  const noiseScale = traitLookup(spatialAwareness, [5, 1, 0.25] as const);

  // Super gun placement — controlled by aggressiveness
  // 1 = never, 2 = 1/3 chance at 8+ slots, 3 = 2/3 chance at 6+ slots
  const superProb = traitLookup(aggressiveness, [
    0,
    SUPER_GUN_PROBABILITY,
    2 / 3,
  ] as const);
  const superThreshold = traitLookup(aggressiveness, [
    Infinity,
    SUPER_GUN_SLOT_THRESHOLD,
    6,
  ] as const);
  tryPlaceSuperGun(
    player,
    count,
    state,
    rng,
    noiseScale,
    superProb,
    superThreshold,
    towerCenters,
  );

  // Collect and score normal 2x2 cannon candidates
  const normalCandidates = collectCannonCandidates(
    player,
    CannonMode.NORMAL,
    state,
    rng,
    noiseScale,
    towerCenters,
  );

  // Place a propaganda balloon — controlled by defensiveness
  // 1 = never, 2 = react to enemy super guns or space constraint,
  // 3 = proactive when enemies have any live cannons
  tryPlaceBalloon(player, count, state, defensiveness, normalCandidates);

  // Fill remaining slots with normal 2x2 cannons, re-scoring after each placement
  while (cannonSlotsUsed(player) < count) {
    const bestPosition = findBestNormalCannonPosition(
      player,
      state,
      rng,
      noiseScale,
      towerCenters,
    );
    if (!bestPosition) break;
    placeCannon(
      player,
      bestPosition.row,
      bestPosition.col,
      count,
      CannonMode.NORMAL,
      state,
    );
  }
  return player.cannons.slice(beforeCount).map((c) => ({
    row: c.row,
    col: c.col,
    mode: c.mode,
  }));
}

function findBestNormalCannonPosition(
  player: Player,
  state: GameState,
  rng: Rng,
  noiseScale: number,
  towerCenters: readonly TilePos[],
): TilePos | null {
  let bestPosition: TilePos | null = null;
  let bestScore = -Infinity;
  for (const key of getInterior(player)) {
    const { r, c } = unpackTile(key);
    if (!canPlaceCannon(player, r, c, CannonMode.NORMAL, state)) continue;
    const score = scoreCannonPosition(
      player,
      r,
      c,
      CannonMode.NORMAL,
      state,
      rng,
      noiseScale,
      towerCenters,
    );
    if (score > bestScore) {
      bestScore = score;
      bestPosition = { row: r, col: c };
    }
  }
  return bestPosition;
}

function tryPlaceSuperGun(
  player: Player,
  count: number,
  state: GameState,
  rng: Rng,
  noiseScale: number,
  superProb: number,
  superThreshold: number,
  towerCenters: readonly TilePos[],
): void {
  if (count < superThreshold || !rng.bool(superProb)) return;
  const superCandidates = collectCannonCandidates(
    player,
    CannonMode.SUPER,
    state,
    rng,
    noiseScale,
    towerCenters,
  );
  const best = superCandidates[0];
  if (best && count - cannonSlotsUsed(player) >= SUPER_GUN_COST) {
    placeCannon(player, best.row, best.col, count, CannonMode.SUPER, state);
  }
}

function collectCannonCandidates(
  player: Player,
  mode: CannonMode,
  state: GameState,
  rng: Rng,
  noiseScale: number,
  towerCenters: readonly TilePos[],
): CannonCandidate[] {
  const candidates: CannonCandidate[] = [];
  for (const key of getInterior(player)) {
    const { r, c } = unpackTile(key);
    if (!canPlaceCannon(player, r, c, mode, state)) continue;
    candidates.push({
      row: r,
      col: c,
      score: scoreCannonPosition(
        player,
        r,
        c,
        mode,
        state,
        rng,
        noiseScale,
        towerCenters,
      ),
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

/**
 * Score a cannon placement position. Higher = better (same convention as build scoring).
 * Penalizes: proximity to map edges, proximity to water, wasted interior tiles.
 */
function scoreCannonPosition(
  player: Player,
  row: number,
  col: number,
  mode: CannonMode,
  state: GameState,
  rng: Rng,
  noiseScale = 1,
  towerCenters: readonly TilePos[] = player.ownedTowers.map(towerCenter),
): number {
  const size = cannonSize(mode);
  let score = 0;
  forEachCannonTile({ row, col, mode }, (r, c) => {
    score += scoreCannonTileLocalPenalty(state, r, c);
  });

  if (towerCenters.length > 0) {
    const centerRow = row + size / 2;
    const centerCol = col + size / 2;
    let minTowerDistance = Infinity;
    for (const tc of towerCenters) {
      const distance = manhattanDistance(centerRow, centerCol, tc.row, tc.col);
      if (distance < minTowerDistance) minTowerDistance = distance;
    }
    score += minTowerDistance * TOWER_DISTANCE_MULTIPLIER;
  }

  const cannonTiles = computeCannonTileSet({ row, col, mode });
  const occupied = new Set(cannonTiles);
  for (const cannon of player.cannons) {
    for (const key of computeCannonTileSet(cannon)) occupied.add(key);
  }
  const interior = getInterior(player);
  const checked = new Set<number>();
  for (let dr = -1; dr <= size; dr++) {
    for (let dc = -1; dc <= size; dc++) {
      if (dr >= 0 && dr < size && dc >= 0 && dc < size) continue;
      const r = row + dr;
      const c = col + dc;
      if (!inBounds(r, c)) continue;
      const key = packTile(r, c);
      if (checked.has(key) || !interior.has(key) || occupied.has(key)) continue;
      if (player.walls.has(key)) continue;
      checked.add(key);
      let freeNeighbors = 0;
      for (const [dr2, dc2] of DIRS_4) {
        const nk = packTile(r + dr2, c + dc2);
        if (interior.has(nk) && !occupied.has(nk) && !player.walls.has(nk)) {
          freeNeighbors++;
        }
      }
      if (freeNeighbors <= 1) score += WASTED_TILE_PENALTY;
    }
  }

  score += rng.next() * SCORE_NOISE_RANGE * noiseScale;

  return -score;
}

function scoreCannonTileLocalPenalty(
  state: GameState,
  row: number,
  col: number,
): number {
  let penalty = 0;
  const borderDistance = Math.min(
    row,
    col,
    GRID_ROWS - 1 - row,
    GRID_COLS - 1 - col,
  );
  if (borderDistance <= BORDER_DISTANCE_THRESHOLD) {
    penalty +=
      (BORDER_DISTANCE_THRESHOLD + 1 - borderDistance) *
      BORDER_PENALTY_MULTIPLIER;
  }

  for (
    let waterRowOffset = -WATER_SEARCH_RANGE;
    waterRowOffset <= WATER_SEARCH_RANGE;
    waterRowOffset++
  ) {
    for (
      let waterColOffset = -WATER_SEARCH_RANGE;
      waterColOffset <= WATER_SEARCH_RANGE;
      waterColOffset++
    ) {
      if (waterRowOffset === 0 && waterColOffset === 0) continue;
      const nr = row + waterRowOffset;
      const nc = col + waterColOffset;
      if (!inBounds(nr, nc)) continue;
      if (!isWater(state.map.tiles, nr, nc)) continue;
      const distance = Math.abs(waterRowOffset) + Math.abs(waterColOffset);
      penalty +=
        distance === 1
          ? WATER_ADJACENT_PENALTY
          : distance === 2
            ? WATER_NEAR_PENALTY
            : 0;
    }
  }

  // Penalize placement adjacent to towers — enemy fire aimed at cannon splashes into wall
  for (const [ddr, ddc] of DIRS_4) {
    const ar = row + ddr;
    const ac = col + ddc;
    if (hasTowerAt(state, ar, ac)) {
      penalty += TOWER_ADJACENT_PENALTY;
    }
  }

  return penalty;
}

function tryPlaceBalloon(
  player: Player,
  count: number,
  state: GameState,
  defensiveness: number,
  normalCandidates: readonly CannonCandidate[],
): void {
  const slotsLeft = count - cannonSlotsUsed(player);
  if (
    !shouldPlaceBalloon(state, player, defensiveness, normalCandidates.length)
  )
    return;
  if (slotsLeft < BALLOON_COST) return;
  const position = normalCandidates[0];
  if (position) {
    placeCannon(
      player,
      position.row,
      position.col,
      count,
      CannonMode.BALLOON,
      state,
    );
  }
}

function shouldPlaceBalloon(
  state: GameState,
  player: Player,
  defensiveness: number,
  normalCandidateCount: number,
): boolean {
  if (defensiveness < 2) return false;

  const enemyPlayers = filterActiveEnemies(state, player.id);
  const hasEnemySuperGun = enemyPlayers.some((enemy) =>
    enemyHasThreateningSuperGun(state, enemy),
  );
  const hasEnemyCannons = enemyPlayers.some((enemy) =>
    enemyHasLiveCannon(enemy),
  );

  return (
    hasEnemySuperGun ||
    (hasEnemyCannons && normalCandidateCount <= 1) ||
    (defensiveness >= 3 && hasEnemyCannons)
  );
}

function enemyHasLiveCannon(enemy: Player): boolean {
  return enemy.cannons.some((c) => isCannonAlive(c));
}

function enemyHasThreateningSuperGun(state: GameState, enemy: Player): boolean {
  return enemy.cannons.some((c) => {
    if (!isCannonAlive(c) || !isSuperCannon(c)) return false;
    if (state.capturedCannons.some((cc) => cc.cannon === c)) return false;
    return isCannonEnclosed(c, enemy);
  });
}
