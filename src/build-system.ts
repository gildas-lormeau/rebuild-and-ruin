/**
 * Build/repair phase — piece placement, territory claiming (flood-fill).
 *
 * AI placement strategy lives in ai-strategy.ts.
 */

import {
  addPlayerWalls,
  BONUS_PLACEMENT_BLOCKED,
  collectAllInterior,
  collectOccupiedTiles,
  hasCannonAt,
  hasGruntAt,
  hasTowerAt,
  hasWallAt,
  isTileOwnedByPlayer,
  markInteriorFresh,
} from "./board-occupancy.ts";
import {
  BONUS_SQUARE_MIN_DISTANCE,
  BONUS_SQUARES_PER_ZONE,
  CASTLE_BONUS_TABLE,
  DESTROY_GRUNT_POINTS,
  ENCLOSED_GRUNT_RESPAWN_CHANCE,
  TERRITORY_POINT_TIERS,
  TOWER_SIZE,
} from "./game-constants.ts";
import type { TilePos } from "./geometry-types.ts";
import { GRID_COLS, GRID_ROWS, type Tile } from "./grid.ts";
import { spawnGruntNearPos, spawnGruntOnZone } from "./grunt-system.ts";
import { topZonesBySize } from "./map-generation.ts";
import type { PieceShape } from "./pieces.ts";
import {
  computeOutside,
  DIRS_8,
  hasPitAt,
  inBounds,
  isGrass,
  isWater,
  manhattanDistance,
  packTile,
} from "./spatial.ts";
import { type GameState, isPlayerSeated, type Player } from "./types.ts";

/** Validate + apply piece placement. Returns true if placed. */
export function placePiece(
  state: GameState,
  playerId: number,
  piece: PieceShape,
  row: number,
  col: number,
): boolean {
  if (!canPlacePiece(state, playerId, piece, row, col)) return false;
  applyPiecePlacement(state, playerId, piece.offsets, row, col);
  return true;
}

/**
 * Check if a piece can be placed at (row, col) for a player.
 * All piece tiles must be on grass, not on any player's walls, not on towers, cannons, grunts, or burning pits.
 */
export function canPlacePiece(
  state: GameState,
  playerId: number,
  piece: PieceShape,
  row: number,
  col: number,
  excludeInterior?: ReadonlySet<number>,
): boolean {
  return canPlacePieceOffsets(
    state,
    playerId,
    piece.offsets,
    row,
    col,
    excludeInterior,
  );
}

/** Validate piece placement on the grid.
 *  Checks: grass, playerZone, ALL towers (not just owned), grunts, cannons, burning pits.
 *  Does NOT check interior (enclosed territory) — pieces can go on open grass.
 *
 *  CONTRAST with canPlaceCannon() in cannon-system.ts:
 *    - Cannon: checks INTERIOR (enclosed territory) + owned towers only
 *    - Piece:  checks GRASS + zone + ALL towers (no interior check)
 *  Copying validation from one to the other produces wrong results.
 *
 *  Same as canPlacePiece but accepts raw offsets — used when no PieceShape is available (e.g. network validation). */
export function canPlacePieceOffsets(
  state: GameState,
  playerId: number,
  offsets: readonly [number, number][],
  row: number,
  col: number,
  excludeInterior?: ReadonlySet<number>,
): boolean {
  const playerZone = state.players[playerId]?.homeTower?.zone;
  for (const [dr, dc] of offsets) {
    const r = row + dr;
    const c = col + dc;
    if (!inBounds(r, c)) return false;
    if (!isGrass(state.map.tiles, r, c)) return false;
    // Must be within the player's zone
    if (playerZone !== undefined && state.map.zones[r]![c] !== playerZone)
      return false;
    const key = packTile(r, c);

    // AI callers pass excludeInterior to prevent placing inside enclosed zones
    if (excludeInterior && excludeInterior.has(key)) return false;

    if (hasWallAt(state, r, c)) return false;
    if (hasTowerAt(state, r, c)) return false;
    if (hasCannonAt(state, r, c)) return false;
    if (hasGruntAt(state, r, c)) return false;

    // Check burning pits
    if (hasPitAt(state.burningPits, r, c)) return false;

    // Bonus squares CAN be covered (you lose the bonus) — no block here
  }
  return true;
}

/** Apply a piece placement to the board. Marks walls dirty after mutation.
 *  WARNING: Leaves interior stale. Caller MUST call recheckTerritory(state) before
 *  any code reads player.interior. Enforced at runtime by assertInteriorFresh().
 *  Used by host and watcher (no validation). */
export function applyPiecePlacement(
  state: GameState,
  playerId: number,
  offsets: readonly [number, number][],
  row: number,
  col: number,
): void {
  const player = state.players[playerId]!;
  const destroyedHousePositions: TilePos[] = [];
  const pieceKeys = new Set(
    offsets.map(([dr, dc]) => packTile(row + dr, col + dc)),
  );
  addPlayerWalls(player, pieceKeys);
  for (const house of state.map.houses) {
    if (!house.alive) continue;
    const hKey = packTile(house.row, house.col);
    if (pieceKeys.has(hKey)) {
      house.alive = false;
      destroyedHousePositions.push({ row: house.row, col: house.col });
    }
  }
  state.bonusSquares = state.bonusSquares.filter(
    (b) => !pieceKeys.has(packTile(b.row, b.col)),
  );
  recheckTerritory(state);
  for (const pos of destroyedHousePositions) {
    spawnGruntNearPos(state, playerId, pos.row, pos.col);
  }
}

/** Reclaim territory for all players after a wall mutation during active build phase.
 *  Sub-functions: recomputeInterior → updateOwnedTowers → removeEnclosedGrunts →
 *  destroyEnclosedHouses → captureEnclosedBonusSquares → sweepMisplacedGrunts.
 *  Call after each piece placement or wall change during build phase.
 *  Do NOT use at end-of-build — use finalizeTerritory() instead (adds tower revival + scoring). */
export function recheckTerritory(state: GameState): void {
  for (const player of state.players) {
    recomputeInterior(state, player);
    updateOwnedTowers(state, player);
    removeEnclosedGruntsAndRespawn(state, player);
    destroyEnclosedHousesAndSpawnGrunts(state, player);
    captureEnclosedBonusSquares(state, player);
  }
  sweepMisplacedGrunts(state);
}

/** End-of-build territory finalization. Same as recheckTerritory() plus:
 *  - Awards territory/enclosure scoring points
 *  - Resolves pending tower revives (towerPendingRevive → alive if still enclosed)
 *  - Clears unenclosed pending revives
 *  Called exactly once at end of build phase from finalizeBuildPhase(). */
export function finalizeTerritory(state: GameState): void {
  // ── Per-player territory claims (loop above) ──
  for (const player of state.players) {
    recomputeInterior(state, player);
    updateOwnedTowers(state, player);
    reviveEnclosedTowers(state, player);
    removeEnclosedGruntsAndRespawn(state, player);
    destroyEnclosedHousesAndSpawnGrunts(state, player);
    captureEnclosedBonusSquares(state, player);
    awardEndOfBuildPoints(state, player, player.interior.size);
  }
  // ── Post-loop: global finalization ──
  sweepMisplacedGrunts(state);
  clearUnenclosedPendingRevives(state);
}

/**
 * Replenish bonus squares to maintain BONUS_SQUARES_PER_ZONE per zone.
 * Placed on free grass tiles with 1-tile gap from borders and river,
 * never inside enclosed areas.
 */
export function replenishBonusSquares(state: GameState): void {
  const { map } = state;
  const { tiles, zones } = map;

  // Identify the 3 main zones, skip zones of eliminated players
  const eliminatedZones = new Set(
    state.players
      .filter((player) => player.eliminated)
      .map((player) => state.playerZones[player.id]),
  );
  const mainZones = topZonesBySize(map, 3)
    .map(({ zone }) => zone)
    .filter((zone) => !eliminatedZones.has(zone));

  // Build sets of enclosed and occupied tiles
  const enclosed = collectAllInterior(state);
  const occupied = collectOccupiedTiles(state, BONUS_PLACEMENT_BLOCKED);

  for (const zoneId of mainZones) {
    const existing = state.bonusSquares.filter(
      (bs) => bs.zone === zoneId,
    ).length;
    const needed = BONUS_SQUARES_PER_ZONE - existing;
    if (needed <= 0) continue;

    const candidates = findBonusSpawnCandidates(
      tiles,
      zones,
      zoneId,
      occupied,
      enclosed,
    );

    state.rng.shuffle(candidates);

    let placed = 0;
    for (const [r, c] of candidates) {
      if (placed >= needed) break;
      // Ensure minimum distance from every existing bonus square
      const tooClose = state.bonusSquares.some(
        (bs) =>
          manhattanDistance(bs.row, bs.col, r, c) < BONUS_SQUARE_MIN_DISTANCE,
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

/** Recompute interior and ownedTowers from walls — no side effects.
 *  Used by checkpoint restore where grunts/houses/bonus are already correct. */
export function recomputeTerritoryFromWalls(
  state: GameState,
  player: Player,
): void {
  recomputeInterior(state, player);
  updateOwnedTowers(state, player);
}

/** Collect valid grass tiles for bonus square placement in a single zone. */
function findBonusSpawnCandidates(
  tiles: readonly (readonly Tile[])[],
  zones: readonly (readonly number[])[],
  zoneId: number,
  occupied: ReadonlySet<number>,
  enclosed: ReadonlySet<number>,
): [number, number][] {
  const candidates: [number, number][] = [];
  // 1-tile padding from map edges — bonus squares must be enclosable
  for (let r = 1; r < GRID_ROWS - 1; r++) {
    for (let c = 1; c < GRID_COLS - 1; c++) {
      if (!isGrass(tiles, r, c)) continue;
      if (zones[r]![c] !== zoneId) continue;
      const key = packTile(r, c);
      if (occupied.has(key)) continue;
      if (enclosed.has(key)) continue;
      // Must not be adjacent to map edge or water (unenclosable)
      if (
        DIRS_8.some(([dr, dc]) => {
          const nr = r + dr,
            nc = c + dc;
          return !inBounds(nr, nc) || isWater(tiles, nr, nc);
        })
      )
        continue;
      candidates.push([r, c]);
    }
  }
  return candidates;
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
  for (const tower of player.ownedTowers) {
    if (state.towerAlive[tower.index]!) {
      castleUnits += tower === player.homeTower ? 2 : 1;
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
      if (enemy.id === player.id || !isPlayerSeated(enemy)) continue;
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
  for (const grunt of state.grunts) {
    if (player.interior.has(packTile(grunt.row, grunt.col))) {
      enclosed.push(grunt);
    } else {
      kept.push(grunt);
    }
  }
  if (enclosed.length === 0) return;

  state.grunts = kept;
  player.score += enclosed.length * DESTROY_GRUNT_POINTS;

  const enemies = state.players.filter(
    (other) => other.id !== player.id && isPlayerSeated(other),
  );
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
    const isEnclosed = state.players.some((player) =>
      player.ownedTowers.includes(state.map.towers[ti]!),
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
  const fresh = new Set<number>();
  const outside = computeOutside(player.walls);
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const key = packTile(r, c);
      if (!outside.has(key) && !player.walls.has(key)) {
        if (isGrass(state.map.tiles, r, c)) {
          fresh.add(key);
        }
      }
    }
  }
  player.interior = markInteriorFresh(player, fresh);
}

/** Find towers enclosed by a player's territory and update ownedTowers list. */
function updateOwnedTowers(state: GameState, player: Player): void {
  player.ownedTowers = [];
  for (const tower of state.map.towers) {
    if (!isTowerOwnedByPlayer(tower, player)) continue;
    player.ownedTowers.push(tower);
  }
}

/** Process delayed tower revival for a single player (end-of-build-phase only).
 *  Dead towers enclosed for two consecutive build phases are revived.
 *  Dead towers enclosed for only one phase are marked pending. */
function reviveEnclosedTowers(state: GameState, player: Player): void {
  for (const tower of player.ownedTowers) {
    if (state.towerAlive[tower.index]) continue;
    if (state.towerPendingRevive.has(tower.index)) {
      state.towerAlive[tower.index] = true;
      state.towerPendingRevive.delete(tower.index);
    } else {
      state.towerPendingRevive.add(tower.index);
    }
  }
}

/** Award bonus square points for squares enclosed by a player's territory. */
function captureEnclosedBonusSquares(state: GameState, player: Player): void {
  const territorySize = player.interior.size;
  state.bonusSquares = state.bonusSquares.filter((bs) => {
    const bKey = packTile(bs.row, bs.col);
    if (player.interior.has(bKey)) {
      player.score += territoryBonusSquarePoints(territorySize);
      return false;
    }
    return true;
  });
}

/** SNES Rampart formula: 10×√territory, quantized to nearest 100, clamped [100,1000]. */
function territoryBonusSquarePoints(territorySize: number): number {
  const raw = Math.floor((10 * Math.sqrt(territorySize)) / 100) * 100;
  return Math.max(100, Math.min(1000, raw));
}

/** Check if all tiles in a tower's footprint are owned by the given player. */
function isTowerOwnedByPlayer(
  tower: TilePos,
  player: Pick<Player, "id" | "interior" | "walls">,
): boolean {
  // Towers occupy a TOWER_SIZE×TOWER_SIZE footprint — check all tiles
  for (let dr = 0; dr < TOWER_SIZE; dr++) {
    for (let dc = 0; dc < TOWER_SIZE; dc++) {
      if (
        !isTileOwnedByPlayer(player, packTile(tower.row + dr, tower.col + dc))
      )
        return false;
    }
  }
  return true;
}

/** Remove grunts that landed on any player's territory during processing. */
function sweepMisplacedGrunts(state: GameState): void {
  state.grunts = state.grunts.filter((grunt) => {
    const gKey = packTile(grunt.row, grunt.col);
    return !state.players.some((player) => isTileOwnedByPlayer(player, gKey));
  });
}
