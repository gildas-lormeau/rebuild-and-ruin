/**
 * AI Strategy — cannon placement and tower selection implementation.
 *
 * Contains cannon scoring, placement logic, and tower selection
 * used by DefaultStrategy.
 */

import {
  cannonSlotCost,
  cannonSlotsUsed,
  canPlaceCannon,
  isCannonEnclosed,
} from "../game/index.ts";
import {
  CannonMode,
  isCannonAlive,
  isRampartCannon,
  isSuperCannon,
} from "../shared/core/battle-types.ts";
import { filterActiveEnemies } from "../shared/core/board-occupancy.ts";
import {
  GAME_MODE_MODERN,
  RAMPART_SHIELD_RADIUS,
} from "../shared/core/game-constants.ts";
import type { GameMap, TilePos, Tower } from "../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, type TileKey } from "../shared/core/grid.ts";
import { isCannonCaptured } from "../shared/core/occupancy-queries.ts";
import { getInterior } from "../shared/core/player-interior.ts";
import type { Player } from "../shared/core/player-types.ts";
import {
  cannonSize,
  computeCannonTileSet,
  DIRS_4,
  forEachCannonTile,
  inBounds,
  isWater,
  manhattanDistance,
  packTile,
  towerCenter,
  unpackTile,
  zoneAt,
} from "../shared/core/spatial.ts";
import type { CannonViewState } from "../shared/core/system-interfaces.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";
import type { Rng } from "../shared/platform/rng.ts";
import type {
  CannonPlacement,
  CannonPlacementContext,
} from "./ai-strategy-types.ts";
import { traitLookup } from "./ai-utils.ts";

type CannonCandidate = { row: number; col: number; score: number };

const SUPER_SLOT_COST = cannonSlotCost(CannonMode.SUPER);
const RAMPART_SLOT_COST = cannonSlotCost(CannonMode.RAMPART);
const BALLOON_SLOT_COST = cannonSlotCost(CannonMode.BALLOON);
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
/** Score cost per tile of distance to the nearest owned tower. Tuned to
 *  decisively beat the wasted-tile penalty (-10 per dead pocket × ~3
 *  pockets per tower-adjacent placement) so cannons cluster around towers
 *  instead of drifting into open middle space, while staying below the
 *  border (-30) and water (-15) penalty ceilings so coastal towers don't
 *  drag cannons onto edge tiles. */
const TOWER_DISTANCE_MULTIPLIER = 24;
/** Penalty per cannon tile that is 4-adjacent to one of the player's own
 *  walls. Wall-hugging cannons take enemy-fire splash on their own walls,
 *  exposing the castle. */
const WALL_ADJACENT_PENALTY = 8;
/** Penalty for each interior tile left with only 0–1 free neighbors (dead space). */
const WASTED_TILE_PENALTY = 10;
/** Random noise added to each score to break ties unpredictably. */
const SCORE_NOISE_RANGE = 2;
/** Minimum cannon slots before the AI considers placing a super gun. */
const SUPER_GUN_SLOT_THRESHOLD = 8;
/** Chance to attempt a super gun when slot threshold is met. */
const SUPER_GUN_PROBABILITY = 1 / 3;
/** Probability gate for rampart placement by defensiveness trait. */
const RAMPART_PROBABILITY: readonly [number, number, number] = [
  0,
  1 / 3,
  2 / 3,
];
/** Minimum cannon slots before the AI considers a rampart. */
const RAMPART_SLOT_THRESHOLD = 4;
/** Score bonus per uniquely-protected wall tile inside a rampart candidate's
 *  5×5 shield zone (wall tiles already covered by an existing rampart's
 *  shield don't count). Pulls new ramparts toward unprotected perimeter. */
const RAMPART_COVERAGE_BONUS = 5;

/** Pick a home tower for the given zone. Returns the chosen tower, or null if none available. */
export function autoSelectTower(
  map: GameMap,
  zone: ZoneId,
  rng: Rng,
  spatialAwareness: 1 | 2 | 3,
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
        if (zoneAt(map, r, c) === zone) {
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

export function createCannonPlacementContext(
  player: Player,
  count: number,
  rng: Rng,
  aggressiveness: 1 | 2 | 3,
  defensiveness: 1 | 2 | 3,
  spatialAwareness: 1 | 2 | 3,
): CannonPlacementContext {
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
  const rampartProb = traitLookup(defensiveness, RAMPART_PROBABILITY);
  // Pre-roll dice ONCE at init so the per-tick `nextCannonPlacement` is a
  // pure lookup against ctx flags + current player state — no extra RNG
  // side-effects leak into the animation loop.
  const pendingSuperGun = count >= superThreshold && rng.bool(superProb);
  const pendingRampart =
    defensiveness >= 2 &&
    count >= RAMPART_SLOT_THRESHOLD &&
    rng.bool(rampartProb);
  return {
    noiseScale,
    towerCenters: player.ownedTowers.map(towerCenter),
    defensiveness,
    pendingSuperGun,
    pendingRampart,
    pendingBalloon: defensiveness >= 2,
  };
}

/** Return the next single cannon placement the AI would make, given the
 *  current `player.cannons` and pending budget flags in `ctx`. Each call
 *  consumes at most one special-placement budget (super / rampart /
 *  balloon) — after those are exhausted it falls through to the highest-
 *  scoring NORMAL slot. Returns `undefined` when out of slots or no legal
 *  position remains. */
export function nextCannonPlacement(
  player: Player,
  count: number,
  state: CannonViewState,
  rng: Rng,
  ctx: CannonPlacementContext,
): CannonPlacement | undefined {
  const pendingCost = state.pendingCannonSlotCost[player.id] ?? 0;
  const slotsLeft = count - cannonSlotsUsed(player) - pendingCost;
  if (slotsLeft <= 0) return undefined;

  if (ctx.pendingSuperGun) {
    ctx.pendingSuperGun = false;
    if (slotsLeft >= SUPER_SLOT_COST) {
      const best = collectCannonCandidates(
        player,
        CannonMode.SUPER,
        state,
        rng,
        ctx.noiseScale,
        ctx.towerCenters,
      )[0];
      if (best) return { row: best.row, col: best.col, mode: CannonMode.SUPER };
    }
  }

  const normalCandidates = collectCannonCandidates(
    player,
    CannonMode.NORMAL,
    state,
    rng,
    ctx.noiseScale,
    ctx.towerCenters,
  );
  if (normalCandidates.length === 0) return undefined;

  if (ctx.pendingRampart) {
    ctx.pendingRampart = false;
    if (
      state.gameMode === GAME_MODE_MODERN &&
      slotsLeft >= RAMPART_SLOT_COST &&
      normalCandidates.length >= 4
    ) {
      const rampartCandidates = collectCannonCandidates(
        player,
        CannonMode.RAMPART,
        state,
        rng,
        ctx.noiseScale,
        ctx.towerCenters,
      );
      const position = rampartCandidates[0];
      if (position) {
        return {
          row: position.row,
          col: position.col,
          mode: CannonMode.RAMPART,
        };
      }
    }
  }

  if (ctx.pendingBalloon) {
    ctx.pendingBalloon = false;
    if (
      slotsLeft >= BALLOON_SLOT_COST &&
      shouldPlaceBalloon(
        state,
        player,
        ctx.defensiveness,
        normalCandidates.length,
      )
    ) {
      const position = normalCandidates[0]!;
      return {
        row: position.row,
        col: position.col,
        mode: CannonMode.BALLOON,
      };
    }
  }

  const best = normalCandidates[0]!;
  return { row: best.row, col: best.col, mode: CannonMode.NORMAL };
}

function collectCannonCandidates(
  player: Player,
  mode: CannonMode,
  state: CannonViewState,
  rng: Rng,
  noiseScale: number,
  towerCenters: readonly TilePos[],
): CannonCandidate[] {
  const candidates: CannonCandidate[] = [];
  for (const key of getInterior(player)) {
    const { row, col } = unpackTile(key);
    if (!canPlaceCannon(player, row, col, mode, state)) continue;
    candidates.push({
      row: row,
      col: col,
      score: scoreCannonPosition(
        player,
        row,
        col,
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
 * Internally accumulates penalties as positive values, then negates on return
 * so callers see higher = better. */
function scoreCannonPosition(
  player: Player,
  row: number,
  col: number,
  mode: CannonMode,
  state: CannonViewState,
  rng: Rng,
  noiseScale: number,
  towerCenters: readonly TilePos[],
): number {
  const size = cannonSize(mode);
  let score = 0;
  forEachCannonTile({ row, col, mode }, (r, c) => {
    score += scoreCannonTileLocalPenalty(state, player, r, c, mode);
  });
  if (mode === CannonMode.RAMPART) {
    score -= rampartNetWallCoverage(player, row, col) * RAMPART_COVERAGE_BONUS;
  }

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
  const checked = new Set<TileKey>();
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
        const neighborKey = packTile(r + dr2, c + dc2);
        if (
          interior.has(neighborKey) &&
          !occupied.has(neighborKey) &&
          !player.walls.has(neighborKey)
        ) {
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
  state: CannonViewState,
  player: Player,
  row: number,
  col: number,
  mode: CannonMode,
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

  // Penalize placement adjacent to own walls — enemy fire aimed at the cannon
  // splashes into the wall, breaching the castle. Ramparts are exempt: their
  // job is to shield nearby walls, so wall-adjacency is desirable.
  if (mode !== CannonMode.RAMPART) {
    for (const [ddr, ddc] of DIRS_4) {
      const ar = row + ddr;
      const ac = col + ddc;
      if (player.walls.has(packTile(ar, ac))) {
        penalty += WALL_ADJACENT_PENALTY;
      }
    }
  }

  return penalty;
}

/** Count wall tiles in the candidate rampart's 5×5 shield zone that are NOT
 *  already inside any existing alive+enclosed rampart's shield zone. Returns
 *  the number of net-new walls the candidate would uniquely protect. */
function rampartNetWallCoverage(
  player: Player,
  row: number,
  col: number,
): number {
  const candCenterRow = row + 1;
  const candCenterCol = col + 1;
  const existingRampartCenters: TilePos[] = [];
  for (const cannon of player.cannons) {
    if (!isCannonAlive(cannon) || !isRampartCannon(cannon)) continue;
    if ((cannon.shieldHp ?? 0) <= 0) continue;
    if (!isCannonEnclosed(cannon, player)) continue;
    existingRampartCenters.push({ row: cannon.row + 1, col: cannon.col + 1 });
  }
  let netCovered = 0;
  for (let dr = -RAMPART_SHIELD_RADIUS; dr <= RAMPART_SHIELD_RADIUS; dr++) {
    for (let dc = -RAMPART_SHIELD_RADIUS; dc <= RAMPART_SHIELD_RADIUS; dc++) {
      const r = candCenterRow + dr;
      const c = candCenterCol + dc;
      if (!inBounds(r, c)) continue;
      if (!player.walls.has(packTile(r, c))) continue;
      let alreadyShielded = false;
      for (const center of existingRampartCenters) {
        const cheby = Math.max(
          Math.abs(r - center.row),
          Math.abs(c - center.col),
        );
        if (cheby <= RAMPART_SHIELD_RADIUS) {
          alreadyShielded = true;
          break;
        }
      }
      if (!alreadyShielded) netCovered++;
    }
  }
  return netCovered;
}

function shouldPlaceBalloon(
  state: CannonViewState,
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
    enemyHasLiveCannon(state, enemy),
  );

  return (
    hasEnemySuperGun ||
    (hasEnemyCannons && normalCandidateCount <= 1) ||
    (defensiveness >= 3 && hasEnemyCannons)
  );
}

function enemyHasLiveCannon(state: CannonViewState, enemy: Player): boolean {
  return enemy.cannons.some(
    (c) => isCannonAlive(c) && !isCannonCaptured(state, c),
  );
}

function enemyHasThreateningSuperGun(
  state: CannonViewState,
  enemy: Player,
): boolean {
  return enemy.cannons.some(
    (c) =>
      isCannonAlive(c) &&
      isSuperCannon(c) &&
      !isCannonCaptured(state, c) &&
      isCannonEnclosed(c, enemy),
  );
}
