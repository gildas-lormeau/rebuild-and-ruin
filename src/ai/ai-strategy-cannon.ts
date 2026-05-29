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
/** Corridor penalty: a perimeter wall left with ZERO free interior neighbors
 *  after this cannon is placed. If that wall is breached in battle, only a 1×1
 *  piece dropped exactly on it can repair it — effectively a dead corridor the
 *  ring can't re-close. Tuned above the border ceiling (30) so the AI decisively
 *  avoids sealing a wall against its own cannon. */
const CORRIDOR_DEAD_PENALTY = 50;
/** Corridor penalty: a perimeter wall left with exactly ONE free interior
 *  neighbor. Narrow — only small pieces can repair a breach there. */
const CORRIDOR_TIGHT_PENALTY = 22;
/** Enclosed (firing) cannons a player must already have before the AI is
 *  willing to decline a corridor-creating placement. Below this it still needs
 *  firepower and tolerates the risk; at or above it, refusing costs little. */
const ABSTAIN_MIN_ENCLOSED = 4;
/** Scaled corridor penalty (raw × corridorScale) at or above which the AI will
 *  decline a placement / stop placing. Set to the tight tier so a low-awareness
 *  AI (corridorScale 0.3) never reaches it and keeps boxing itself in. */
const ABSTAIN_CORRIDOR_FLOOR = CORRIDOR_TIGHT_PENALTY;
/** Corridor-penalty multiplier per spatialAwareness tier (1=low … 3=high).
 *  Tier 2 stays at 1.0 to preserve the validated baseline behavior. */
const CORRIDOR_SCALE_BY_AWARENESS: readonly [number, number, number] = [
  0.3, 1.0, 1.3,
];
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
    towerCenters: player.enclosedTowers.map(towerCenter),
    defensiveness,
    corridorScale: traitLookup(spatialAwareness, CORRIDOR_SCALE_BY_AWARENESS),
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
        ctx.corridorScale,
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
    ctx.corridorScale,
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
        ctx.corridorScale,
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

  // The best remaining spot would seal a perimeter wall into an unrepairable
  // corridor. If we already hold enough firing cannons, don't strand a
  // permanent one here: place an ephemeral balloon (removed before WALL_BUILD,
  // so it can't trap the rebuild) if one would capture something, otherwise
  // stop placing for the round.
  if (
    countEnclosedAliveCannons(player) >= ABSTAIN_MIN_ENCLOSED &&
    corridorPenaltyAt(player, best.row, best.col) * ctx.corridorScale >=
      ABSTAIN_CORRIDOR_FLOOR
  ) {
    const balloonWorthwhile =
      state.gameMode === GAME_MODE_MODERN &&
      slotsLeft >= BALLOON_SLOT_COST &&
      filterActiveEnemies(state, player.id).some((enemy) =>
        enemyHasLiveCannon(state, enemy),
      );
    if (balloonWorthwhile) {
      return { row: best.row, col: best.col, mode: CannonMode.BALLOON };
    }
    return undefined;
  }

  return { row: best.row, col: best.col, mode: CannonMode.NORMAL };
}

function collectCannonCandidates(
  player: Player,
  mode: CannonMode,
  state: CannonViewState,
  rng: Rng,
  noiseScale: number,
  towerCenters: readonly TilePos[],
  corridorScale: number,
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
        corridorScale,
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
  corridorScale: number,
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

  // Balloons are removed before WALL_BUILD (phase-setup cleanup), so their
  // footprint can never trap a future enclosure repair — exempt them. The
  // penalty is scaled by spatialAwareness (corridorScale): unaware AIs barely
  // notice corridors and box themselves in.
  if (mode !== CannonMode.BALLOON) {
    score +=
      corridorPenalty(player, cannonTiles, occupied, interior) * corridorScale;
  }

  score += rng.next() * SCORE_NOISE_RANGE * noiseScale;

  return -score;
}

/** Raw (unscaled) corridor penalty for placing a NORMAL cannon at (row,col)
 *  — see `corridorPenalty`. Cheap single-position check used by the abstain
 *  decision, which scales it by the player's corridorScale. */
function corridorPenaltyAt(player: Player, row: number, col: number): number {
  const footprint = computeCannonTileSet({ row, col, mode: CannonMode.NORMAL });
  const occupied = new Set(footprint);
  for (const cannon of player.cannons) {
    for (const key of computeCannonTileSet(cannon)) occupied.add(key);
  }
  return corridorPenalty(player, footprint, occupied, getInterior(player));
}

/** Penalty for sealing a perimeter wall against this cannon. For each of the
 *  player's own perimeter walls cardinally adjacent to the candidate footprint,
 *  count the free buildable interior tiles still touching that wall once the
 *  cannon occupies its tiles. A wall left with ≤1 free interior neighbor is a
 *  "corridor" a breach can't be repaired into with normal pieces — the very
 *  geometry that strands cannons when the ring later re-opens. Only perimeter
 *  walls (those facing outside the interior) count; deep interior walls don't
 *  gate enclosure. Pure function of current geometry — no future prediction. */
function corridorPenalty(
  player: Player,
  footprint: ReadonlySet<TileKey>,
  occupied: ReadonlySet<TileKey>,
  interior: ReadonlySet<TileKey>,
): number {
  let penalty = 0;
  const seenWalls = new Set<TileKey>();
  for (const tileKey of footprint) {
    const { row, col } = unpackTile(tileKey);
    for (const [dr, dc] of DIRS_4) {
      const wallRow = row + dr;
      const wallCol = col + dc;
      if (!inBounds(wallRow, wallCol)) continue;
      const wallKey = packTile(wallRow, wallCol);
      if (!player.walls.has(wallKey) || seenWalls.has(wallKey)) continue;
      seenWalls.add(wallKey);
      let freeInterior = 0;
      let facesOutside = false;
      for (const [ndr, ndc] of DIRS_4) {
        const neighborRow = wallRow + ndr;
        const neighborCol = wallCol + ndc;
        // Off-map neighbors are "outside" the interior — a wall touching the
        // map edge faces outside there.
        if (!inBounds(neighborRow, neighborCol)) {
          facesOutside = true;
          continue;
        }
        const neighborKey = packTile(neighborRow, neighborCol);
        const isInterior = interior.has(neighborKey);
        if (
          isInterior &&
          !occupied.has(neighborKey) &&
          !player.walls.has(neighborKey)
        ) {
          freeInterior++;
        }
        if (!isInterior && !player.walls.has(neighborKey)) facesOutside = true;
      }
      // Only perimeter walls gate enclosure; skip deep interior walls.
      if (!facesOutside) continue;
      if (freeInterior === 0) penalty += CORRIDOR_DEAD_PENALTY;
      else if (freeInterior === 1) penalty += CORRIDOR_TIGHT_PENALTY;
    }
  }
  return penalty;
}

/** Count the player's alive cannons that are currently enclosed (i.e. able to
 *  fire). Used to gate the corridor-abstain: plenty of firepower → declining a
 *  risky spot is cheap. */
function countEnclosedAliveCannons(player: Player): number {
  let count = 0;
  for (const cannon of player.cannons) {
    if (isCannonAlive(cannon) && isCannonEnclosed(cannon, player)) count++;
  }
  return count;
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
