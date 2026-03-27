/**
 * Build/repair phase — piece placement, territory claiming (flood-fill).
 *
 * AI placement strategy lives in ai-strategy.ts.
 */

import { collectAllInterior, collectOccupiedTiles, hasCannonAt, hasGruntAt, hasTowerAt, hasWallAt, isTileOwnedByPlayer } from "./board-occupancy.ts";
import type { TilePos } from "./geometry-types.ts";
import { GRID_COLS, GRID_ROWS } from "./grid.ts";
import { spawnGruntNearPos, spawnGruntOnZone } from "./grunt-system.ts";
import { topZonesBySize } from "./map-generation.ts";
import type { PieceShape } from "./pieces.ts";
import { computeOutside, DIRS_8, inBounds, isAtTile, isGrass, isPitAt, isWater, manhattanDistance, packTile } from "./spatial.ts";
import { BONUS_SQUARE_MIN_DISTANCE, BONUS_SQUARES_PER_ZONE, CASTLE_BONUS_TABLE, DESTROY_GRUNT_POINTS, ENCLOSED_GRUNT_RESPAWN_CHANCE, type GameState, isPlayerActive, type Player, TERRITORY_POINT_TIERS } from "./types.ts";

/** Validate + apply piece placement. Returns true if placed. */
export function placePiece(state: GameState, playerId: number, piece: PieceShape, row: number, col: number): boolean {
  if (!canPlacePiece(state, playerId, piece, row, col)) return false;
  applyPiecePlacement(state, playerId, piece.offsets, row, col);
  return true;
}

/**
 * Check if a piece can be placed at (row, col) for a player.
 * All piece tiles must be on grass, not on any player's walls, not on towers, cannons, grunts, or burning pits.
 */
export function canPlacePiece(state: GameState, playerId: number, piece: PieceShape, row: number, col: number, excludeInterior?: Set<number>): boolean {
  const playerZone = state.players[playerId]?.homeTower?.zone;
  for (const [dr, dc] of piece.offsets) {
    const r = row + dr;
    const c = col + dc;
    if (!inBounds(r, c)) return false;
    if (!isGrass(state.map.tiles, r, c)) return false;
    // Must be within the player's zone
    if (playerZone !== undefined && state.map.zones[r]![c] !== playerZone) return false;
    const key = packTile(r, c);

    // AI callers pass excludeInterior to prevent placing inside enclosed zones
    if (excludeInterior && excludeInterior.has(key)) return false;

    if (hasWallAt(state, r, c)) return false;
    if (hasTowerAt(state, r, c)) return false;
    if (hasCannonAt(state, r, c)) return false;
    if (hasGruntAt(state, r, c)) return false;

    // Check burning pits
    if (isPitAt(state.burningPits, r, c)) return false;

    // Bonus squares CAN be covered (you lose the bonus) — no block here
  }
  return true;
}

/** Apply piece placement to state (no validation). Used by host and watcher. */
export function applyPiecePlacement(state: GameState, playerId: number, offsets: [number, number][], row: number, col: number): void {
  const player = state.players[playerId]!;
  const destroyedHousePositions: TilePos[] = [];
  const pieceKeys = new Set(offsets.map(([dr, dc]) => packTile(row + dr, col + dc)));
  for (const [dr, dc] of offsets) {
    const pr = row + dr, pc = col + dc;
    player.walls.add(packTile(pr, pc));
    for (const house of state.map.houses) {
      if (house.alive && isAtTile(house, pr, pc)) {
        house.alive = false;
        destroyedHousePositions.push({ row: pr, col: pc });
      }
    }
  }
  state.bonusSquares = state.bonusSquares.filter(
    (b) => !pieceKeys.has(packTile(b.row, b.col)),
  );
  claimTerritory(state);
  replenishBonusSquares(state);
  for (const pos of destroyedHousePositions) {
    spawnGruntNearPos(state, playerId, pos.row, pos.col);
  }
}

export function claimTerritory(state: GameState, endOfBuildPhase = false): void {
  for (const player of state.players) {
    recomputeInterior(state, player);
    updateOwnedTowers(state, player, endOfBuildPhase);
    removeEnclosedGruntsAndRespawn(state, player);
    destroyEnclosedHousesAndSpawnGrunts(state, player);
    captureEnclosedBonusSquares(state, player);
    if (endOfBuildPhase) {
      awardEndOfBuildPoints(state, player, player.interior.size);
    }
  }

  sweepMisplacedGrunts(state);

  if (endOfBuildPhase) {
    clearUnenclosedPendingRevives(state);
  }
}

/**
 * Replenish bonus squares to maintain BONUS_SQUARES_PER_ZONE per zone.
 * Placed on free grass tiles with 1-tile gap from borders and river,
 * never inside enclosed areas.
 */
export function replenishBonusSquares(state: GameState): void {
  const { map } = state;
  const { tiles, zones } = map;

  // Identify the 3 main zones
  const mainZones = topZonesBySize(map, 3).map(({ zone }) => zone);

  // Build sets of enclosed and occupied tiles
  const enclosed = collectAllInterior(state);
  const occupied = collectOccupiedTiles(state, {
    includeWalls: true,
    includeCannons: true,
    includeTowers: true,
    includeHouses: true,
    includePits: true,
    includeBonusSquares: true,
    includeGrunts: true,
  });

  for (const zoneId of mainZones) {
    const existing = state.bonusSquares.filter(bs => bs.zone === zoneId).length;
    const needed = BONUS_SQUARES_PER_ZONE - existing;
    if (needed <= 0) continue;

    const candidates: [number, number][] = [];
    for (let r = 1; r < GRID_ROWS - 1; r++) {
      for (let c = 1; c < GRID_COLS - 1; c++) {
        if (!isGrass(tiles, r, c)) continue;
        if (zones[r]![c] !== zoneId) continue;
        const key = packTile(r, c);
        if (occupied.has(key)) continue;
        if (enclosed.has(key)) continue;
        // Must not be adjacent to map edge or water (unenclosable)
        if (DIRS_8.some(([dr, dc]) => {
          const nr = r + dr, nc = c + dc;
          return !inBounds(nr, nc) || isWater(tiles, nr, nc);
        })) continue;
        candidates.push([r, c]);
      }
    }

    state.rng.shuffle(candidates);

    let placed = 0;
    for (const [r, c] of candidates) {
      if (placed >= needed) break;
      // Ensure minimum distance from every existing bonus square
      const tooClose = state.bonusSquares.some(bs =>
        manhattanDistance(bs.row, bs.col, r, c) < BONUS_SQUARE_MIN_DISTANCE
      );
      if (tooClose) continue;
      occupied.add(packTile(r, c));
      state.bonusSquares.push({ row: r, col: c, zone: zoneId });
      placed++;
    }
  }
}

/** Remove bonus squares that are covered by walls. */
export function removeBonusSquaresCoveredByWalls(
  state: GameState,
  walls: Set<number>,
): void {
  state.bonusSquares = state.bonusSquares.filter(
    (bonusSquare) => !walls.has(packTile(bonusSquare.row, bonusSquare.col)),
  );
}

function awardEndOfBuildPoints(
  state: GameState,
  player: Player,
  territorySize: number,
): void {
  // Territory points (tiered by interior size)
  for (const [threshold, points] of TERRITORY_POINT_TIERS) {
    if (territorySize >= threshold) {
      player.score += points;
      break;
    }
  }

  // Castle bonus (home castle = 2 units, others = 1 unit)
  const castleUnits = countCastleBonusUnits(state, player);
  if (castleUnits > 0) {
    const idx = Math.min(castleUnits, CASTLE_BONUS_TABLE.length - 1);
    player.score += CASTLE_BONUS_TABLE[idx]!;
  }
}

function countCastleBonusUnits(state: GameState, player: Player): number {
  let castleUnits = 0;
  for (const t of player.ownedTowers) {
    if (state.towerAlive[t.index]!) {
      castleUnits += (t === player.homeTower) ? 2 : 1;
    }
  }
  return castleUnits;
}

function destroyEnclosedHousesAndSpawnGrunts(
  state: GameState,
  player: Player,
): void {
  for (const house of state.map.houses) {
    if (!house.alive) continue;
    const hKey = packTile(house.row, house.col);
    if (!player.interior.has(hKey)) continue;

    house.alive = false;
    for (const enemy of state.players) {
      if (enemy.id === player.id || !isPlayerActive(enemy)) continue;
      spawnGruntOnZone(state, enemy.id);
    }
  }
}

function removeEnclosedGruntsAndRespawn(
  state: GameState,
  player: Player,
): void {
  const kept: typeof state.grunts = [];
  const enclosed: typeof state.grunts = [];
  for (const g of state.grunts) {
    if (player.interior.has(packTile(g.row, g.col))) {
      enclosed.push(g);
    } else {
      kept.push(g);
    }
  }
  if (enclosed.length === 0) return;

  state.grunts = kept;
  player.score += enclosed.length * DESTROY_GRUNT_POINTS;

  const enemies = state.players.filter(p => p.id !== player.id && isPlayerActive(p));
  if (enemies.length === 0) return;

  // Each enclosed grunt has 50% chance to respawn, alternating between enemies
  let enemyIdx = 0;
  for (let i = 0; i < enclosed.length; i++) {
    if (!state.rng.bool(ENCLOSED_GRUNT_RESPAWN_CHANCE)) continue;
    const enemy = enemies[enemyIdx % enemies.length]!;
    spawnGruntOnZone(state, enemy.id);
    enemyIdx++;
  }
}

function clearUnenclosedPendingRevives(state: GameState): void {
  const toRemove: number[] = [];
  for (const ti of state.towerPendingRevive) {
    if (ti < 0 || ti >= state.map.towers.length) {
      toRemove.push(ti);
      continue;
    }
    const isEnclosed = state.players.some(
      p => p.ownedTowers.includes(state.map.towers[ti]!),
    );
    if (!isEnclosed) toRemove.push(ti);
  }
  for (const ti of toRemove) state.towerPendingRevive.delete(ti);
}

/**
 * Claim territory via inverse flood-fill. For each player, flood from map edges
 * to find tiles NOT reachable through non-wall tiles. Unreachable grass tiles
 * become interior (territory).
 */
/** Recompute a player's interior via inverse flood-fill. */
function recomputeInterior(state: GameState, player: Player): void {
  player.interior.clear();
  const outside = computeOutside(player.walls);
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const key = packTile(r, c);
      if (!outside.has(key) && !player.walls.has(key)) {
        if (isGrass(state.map.tiles, r, c)) {
          player.interior.add(key);
        }
      }
    }
  }
}

/** Find towers enclosed by a player's territory; handle revival logic at end of build phase. */
function updateOwnedTowers(state: GameState, player: Player, endOfBuildPhase: boolean): void {
  player.ownedTowers = [];
  for (const tower of state.map.towers) {
    if (!isTowerOwnedByPlayer(tower, player)) continue;
    player.ownedTowers.push(tower);
    if (endOfBuildPhase && !state.towerAlive[tower.index]) {
      if (state.towerPendingRevive.has(tower.index)) {
        state.towerAlive[tower.index] = true;
        state.towerPendingRevive.delete(tower.index);
      } else {
        state.towerPendingRevive.add(tower.index);
      }
    }
  }
}

/** Award bonus square points for squares enclosed by a player's territory. */
function captureEnclosedBonusSquares(state: GameState, player: Player): void {
  const territorySize = player.interior.size;
  state.bonusSquares = state.bonusSquares.filter(bs => {
    const bKey = packTile(bs.row, bs.col);
    if (player.interior.has(bKey)) {
      player.score += territoryBonusSquarePoints(territorySize);
      return false;
    }
    return true;
  });
}

function territoryBonusSquarePoints(territorySize: number): number {
  const raw = Math.floor(10 * Math.sqrt(territorySize) / 100) * 100;
  return Math.max(100, Math.min(1000, raw));
}

/** Remove grunts that landed on any player's territory during processing. */
function isTowerOwnedByPlayer(tower: TilePos, player: Pick<Player, "interior" | "walls">): boolean {
  for (let dr = 0; dr < 2; dr++) {
    for (let dc = 0; dc < 2; dc++) {
      if (!isTileOwnedByPlayer(player, packTile(tower.row + dr, tower.col + dc))) return false;
    }
  }
  return true;
}

function sweepMisplacedGrunts(state: GameState): void {
  state.grunts = state.grunts.filter(g => {
    const gKey = packTile(g.row, g.col);
    return !state.players.some(p => isTileOwnedByPlayer(p, gKey));
  });
}
