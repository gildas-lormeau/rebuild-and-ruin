/**
 * AI Strategy — cannon placement and tower selection implementation.
 *
 * Contains cannon scoring, placement logic, and tower selection
 * used by DefaultStrategy.
 */

import { traitLookup } from "./ai-constants.ts";
import { hasTowerAt } from "./board-occupancy.ts";
import {
  cannonSlotsUsed,
  canPlaceCannon,
  placeCannon,
} from "./cannon-system.ts";
import type { GameMap, TilePos, Tower } from "./geometry-types.ts";
import { GRID_COLS, GRID_ROWS } from "./grid.ts";
import type { Rng } from "./rng.ts";
import {
  DIRS_4,
  forEachCannonTile,
  inBounds,
  isCannonAlive,
  isWater,
  manhattanDistance,
  packTile,
  towerCenter,
  unpackTile,
} from "./spatial.ts";
import type { GameState, Player } from "./types.ts";
import { BALLOON_COST, CannonMode, SUPER_GUN_COST } from "./types.ts";

type CannonCandidate = { row: number; col: number; score: number };

/** Chance to pick the tower closest to zone centroid vs random. */
const CENTROID_TOWER_PROBABILITY = 2 / 3;
/** Tiles from map edge before border penalty kicks in. */
const BORDER_DISTANCE_THRESHOLD = 2;
/** Score penalty per edge-proximity tier (lower = worse placement). */
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
export function autoSelectTowerImpl(
  map: GameMap,
  zone: number,
  rng: Rng,
  spatialAwareness = 2,
): Tower | null {
  const zoneTowers = map.towers.filter((t) => t.zone === zone);
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
      for (const t of zoneTowers) {
        const center = towerCenter(t);
        const distance = manhattanDistance(
          center.row,
          center.col,
          centroidRow,
          centroidCol,
        );
        if (distance < bestDistance) {
          bestDistance = distance;
          bestTower = t;
        }
      }
      return bestTower;
    }
  }

  return rng.pick(zoneTowers);
}

export function autoPlaceCannonsImpl(
  player: Player,
  count: number,
  state: GameState,
  rng: Rng,
  aggressiveness = 2,
  defensiveness = 2,
  spatialAwareness = 2,
): void {
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
  );

  // Collect and score normal 2x2 cannon candidates
  const normalCandidates = collectCannonCandidates(
    player,
    CannonMode.NORMAL,
    2,
    state,
    rng,
    noiseScale,
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
    );
    if (!bestPosition) break;
    placeCannon(
      player,
      bestPosition.row,
      bestPosition.col,
      count,
      undefined,
      state,
    );
  }
}

function findBestNormalCannonPosition(
  player: Player,
  state: GameState,
  rng: Rng,
  noiseScale: number,
): TilePos | null {
  let bestPosition: TilePos | null = null;
  let bestScore = Infinity;
  for (const key of player.interior) {
    const { r, c } = unpackTile(key);
    if (!canPlaceCannon(player, r, c, CannonMode.NORMAL, state)) continue;
    const score = scoreCannonPosition(player, r, c, 2, state, rng, noiseScale);
    if (score < bestScore) {
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
): void {
  if (count < superThreshold || !rng.bool(superProb)) return;
  const superCandidates = collectCannonCandidates(
    player,
    CannonMode.SUPER,
    3,
    state,
    rng,
    noiseScale,
  );
  const best = superCandidates[0];
  if (best && count - cannonSlotsUsed(player) >= SUPER_GUN_COST) {
    placeCannon(player, best.row, best.col, count, CannonMode.SUPER, state);
  }
}

function collectCannonCandidates(
  player: Player,
  mode: CannonMode,
  size: number,
  state: GameState,
  rng: Rng,
  noiseScale: number,
): CannonCandidate[] {
  const candidates: CannonCandidate[] = [];
  for (const key of player.interior) {
    const { r, c } = unpackTile(key);
    if (!canPlaceCannon(player, r, c, mode, state)) continue;
    candidates.push({
      row: r,
      col: c,
      score: scoreCannonPosition(player, r, c, size, state, rng, noiseScale),
    });
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates;
}

/**
 * Score a cannon placement position. Lower = better.
 * Penalizes: proximity to map edges, proximity to water, wasted interior tiles.
 */
function scoreCannonPosition(
  player: Player,
  row: number,
  col: number,
  size: number,
  state: GameState,
  rng: Rng,
  noiseScale = 1,
): number {
  let score = 0;
  forEachCannonTile({ row, col, super: size === 3 }, (r, c) => {
    score += scoreCannonTileLocalPenalty(state, r, c);
  });

  if (player.ownedTowers.length > 0) {
    const centerRow = row + size / 2;
    const centerCol = col + size / 2;
    let minTowerDistance = Infinity;
    for (const t of player.ownedTowers) {
      const center = towerCenter(t);
      const distance = manhattanDistance(
        centerRow,
        centerCol,
        center.row,
        center.col,
      );
      if (distance < minTowerDistance) minTowerDistance = distance;
    }
    score += minTowerDistance * TOWER_DISTANCE_MULTIPLIER;
  }

  const cannonTiles = new Set<number>();
  forEachCannonTile({ row, col, super: size === 3 }, (_r, _c, key) => {
    cannonTiles.add(key);
  });
  const occupied = new Set(cannonTiles);
  for (const cannon of player.cannons) {
    forEachCannonTile(cannon, (_r, _c, key) => occupied.add(key));
  }
  const checked = new Set<number>();
  for (let dr = -1; dr <= size; dr++) {
    for (let dc = -1; dc <= size; dc++) {
      if (dr >= 0 && dr < size && dc >= 0 && dc < size) continue;
      const r = row + dr;
      const c = col + dc;
      if (!inBounds(r, c)) continue;
      const key = packTile(r, c);
      if (checked.has(key) || !player.interior.has(key) || occupied.has(key))
        continue;
      if (player.walls.has(key)) continue;
      checked.add(key);
      let freeNeighbors = 0;
      for (const [dr2, dc2] of DIRS_4) {
        const nk = packTile(r + dr2, c + dc2);
        if (
          player.interior.has(nk) &&
          !occupied.has(nk) &&
          !player.walls.has(nk)
        ) {
          freeNeighbors++;
        }
      }
      if (freeNeighbors <= 1) score += WASTED_TILE_PENALTY;
    }
  }

  score += rng.next() * SCORE_NOISE_RANGE * noiseScale;

  return score;
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
  normalCandidates: CannonCandidate[],
): void {
  const slotsLeft = count - cannonSlotsUsed(player);
  if (
    !shouldPlaceBalloon(state, player, defensiveness, normalCandidates.length)
  )
    return;
  if (slotsLeft < BALLOON_COST) return;
  const position = normalCandidates[0];
  if (
    position &&
    placeCannon(
      player,
      position.row,
      position.col,
      count,
      CannonMode.BALLOON,
      state,
    )
  ) {
    normalCandidates.shift();
  }
}

function shouldPlaceBalloon(
  state: GameState,
  player: Player,
  defensiveness: number,
  normalCandidateCount: number,
): boolean {
  if (defensiveness < 2) return false;

  const enemyPlayers = liveEnemyPlayers(state, player.id);
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

function liveEnemyPlayers(state: GameState, playerId: number): Player[] {
  return state.players.filter((p) => p.id !== playerId && !p.eliminated);
}

function enemyHasLiveCannon(enemy: Player): boolean {
  return enemy.cannons.some((c) => isCannonAlive(c));
}

function enemyHasThreateningSuperGun(state: GameState, enemy: Player): boolean {
  return enemy.cannons.some((c) => {
    if (!isCannonAlive(c) || !c.super) return false;
    if (state.capturedCannons.some((cc) => cc.cannon === c)) return false;
    let fullyEnclosed = true;
    forEachCannonTile(c, (_r, _c, key) => {
      if (!enemy.interior.has(key)) fullyEnclosed = false;
    });
    return fullyEnclosed;
  });
}
