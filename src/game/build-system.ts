/**
 * Build/repair phase — piece placement, territory claiming (flood-fill).
 *
 * AI placement strategy lives in ai-strategy.ts.
 */

import {
  BOARD_LOCAL_SITE,
  deriveBoardLocalSeed,
} from "../shared/core/ai-seed.ts";
import {
  aliveCannons,
  CannonMode,
  type Grunt,
} from "../shared/core/battle-types.ts";
import {
  BONUS_SQUARE_MIN_DISTANCE,
  BONUS_SQUARES_PER_ZONE,
  CASTLE_BONUS_TABLE,
  DESTROY_GRUNT_POINTS,
  ENCLOSED_GRUNT_RESPAWN_CHANCE,
  MODIFIER_ID,
  type ModifierId,
  RAMPART_SHIELD_HP,
  TERRITORY_POINTS_PER_SQUARE,
  TOWER_SIZE,
} from "../shared/core/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import type { TilePos, TowerIdx } from "../shared/core/geometry-types.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  type Tile,
  type TileKey,
} from "../shared/core/grid.ts";
import type { PieceShape } from "../shared/core/pieces.ts";
import {
  isPlayerEliminated,
  type ValidPlayerId,
} from "../shared/core/player-slot.ts";
import {
  type FreshInterior,
  findTowerOwner,
  isPlayerSeated,
  type Player,
} from "../shared/core/player-types.ts";
import {
  computeOutside,
  DIRS_4,
  filterOffTiles,
  hasEnclosableMargin,
  hasPitAt,
  inBounds,
  isFloodedTile,
  isGrass,
  manhattanDistance,
  packTile,
  unpackTile,
  zoneAt,
} from "../shared/core/spatial.ts";
import type { GameViewState } from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import type { ZoneCell, ZoneId } from "../shared/core/zone-id.ts";
import { Rng } from "../shared/platform/rng.ts";
import {
  BONUS_PLACEMENT_BLOCKED,
  collectAllInterior,
  collectOccupiedTiles,
  hasGruntAt,
  hasWallAt,
  isCannonEnclosed,
  isTileOwnedByPlayer,
  type OccupancyCache,
} from "../shared/sim/board-occupancy.ts";
import { hasCannonAt, hasTowerAt } from "../shared/sim/occupancy-queries.ts";
import { advancePlayerBag } from "../shared/sim/player-bag.ts";
import {
  getInterior,
  markInteriorFresh,
} from "../shared/sim/player-interior.ts";
import { addScore } from "../shared/sim/player-rules.ts";
import { addPlayerWalls } from "../shared/sim/player-walls.ts";
import { getDeadZones } from "./grunt-movement.ts";
import { spawnGruntAtTile, spawnGruntGroupOnZone } from "./grunt-system.ts";
import { topZonesBySize } from "./map-generation.ts";
import {
  canPlaceOverBurningPit,
  canPlaceOverGrunt,
  onPiecePlaced,
  territoryScoreMult,
  wallOverlapAllowance,
} from "./upgrade-system.ts";
import { restorationCrewInstantRevive } from "./upgrades/restoration-crew.ts";

/** Per-player invariants used by `canPlacePiece`. Build once via
 *  `buildPlacementContext` outside a candidate loop and pass it into every
 *  iteration to skip the upgrade-registry walks done per call. */
export interface PlacementContext {
  readonly player: Player;
  readonly zone: ZoneId | undefined;
  readonly overlapAllowance: number;
  readonly allowPitOverlap: boolean;
  readonly allowGruntOverlap: boolean;
}

/** Validate + apply piece placement. Returns true if placed. */
export function placePiece(
  state: GameState,
  playerId: ValidPlayerId,
  piece: PieceShape,
  row: number,
  col: number,
): boolean {
  if (isPlayerEliminated(state.players[playerId])) return false;
  if (!canPlacePiece(state, playerId, piece.offsets, row, col)) return false;
  applyPiecePlacement(state, playerId, piece.offsets, row, col);
  return true;
}

/** Validate piece placement on the grid from raw offsets.
 *  Checks: grass, playerZone, ALL towers (not just owned), grunts, cannons, burning pits.
 *  Does NOT check interior (enclosed territory) — pieces can go on open grass.
 *
 *  CONTRAST with canPlaceCannon() in cannon-system.ts:
 *    - Cannon: checks INTERIOR (enclosed territory) + owned towers only
 *    - Piece:  checks GRASS + zone + ALL towers (no interior check)
 *  Copying validation from one to the other produces wrong results.
 *
 *  Hot-loop callers should pass a pre-built `PlacementContext` (skips
 *  per-call upgrade-registry walks) and an `OccupancyCache` (skips per-tile
 *  linear scans over walls / towers / cannons / grunts / pits). */
export function canPlacePiece(
  state: GameViewState & {
    readonly grunts: readonly Grunt[];
    readonly modern?: {
      readonly activeModifier: ModifierId | null;
      readonly exposedRiverbedTiles?: ReadonlySet<TileKey> | null;
    } | null;
  },
  playerId: ValidPlayerId,
  offsets: readonly [number, number][],
  row: number,
  col: number,
  excludeInterior?: ReadonlySet<number>,
  cache?: OccupancyCache,
  ctx?: PlacementContext,
): boolean {
  const placementCtx = ctx ?? buildPlacementContext(state, playerId);
  if (!placementCtx) return false;
  const { player, zone, overlapAllowance, allowPitOverlap, allowGruntOverlap } =
    placementCtx;
  // High Tide: tiles stay grass mechanically but the visible water rules
  // them out for placement. Per-tile lookup (not full-set construction)
  // so the AI's hot inner loop doesn't pay O(map_size) on every call —
  // each offset costs O(4 + |towers|) only when the modifier is active.
  const highTideActive = state.modern?.activeModifier === MODIFIER_ID.HIGH_TIDE;
  // low_water: the exposed riverbed counts as grass for wall placement.
  // Zone recompute already maps each exposed tile to its grass-side zone,
  // so the zone check below passes naturally.
  const exposed = state.modern?.exposedRiverbedTiles ?? null;
  let wallOverlaps = 0;
  for (const [dr, dc] of offsets) {
    const r = row + dr;
    const c = col + dc;
    if (!inBounds(r, c)) return false;
    const key = packTile(r, c);
    if (!isGrass(state.map.tiles, r, c) && !exposed?.has(key)) return false;
    if (highTideActive && isFloodedTile(state.map, r, c)) return false;
    // Must be within the player's zone
    if (zone !== undefined && zoneAt(state.map, r, c) !== zone) return false;

    // AI callers pass excludeInterior to prevent placing inside enclosed zones
    if (excludeInterior && excludeInterior.has(key)) return false;

    if (player.walls.has(key)) {
      if (wallOverlaps < overlapAllowance) {
        wallOverlaps++;
      } else {
        return false;
      }
    } else if (cache ? cache.wallKeys.has(key) : hasWallAt(state, r, c)) {
      // Enemy wall — never overlap-eligible.
      return false;
    }
    if (cache) {
      if (cache.towerKeys.has(key)) return false;
      if (cache.cannonKeys.has(key)) return false;
      if (!allowGruntOverlap && cache.gruntKeys.has(key)) return false;
      if (!allowPitOverlap && cache.pitKeys.has(key)) return false;
    } else {
      if (hasTowerAt(state, r, c)) return false;
      if (hasCannonAt(state, r, c)) return false;
      if (!allowGruntOverlap && hasGruntAt(state.grunts, r, c)) return false;
      if (!allowPitOverlap && hasPitAt(state.burningPits, r, c)) return false;
    }

    // Bonus squares CAN be covered (you lose the bonus) — no block here
  }
  return true;
}

/** Build a `PlacementContext` for the given player, or null if the slot is
 *  unseated. Hoists the upgrade-registry walks (overlap allowance, pit /
 *  grunt overlap permission) out of per-candidate loops. */
export function buildPlacementContext(
  state: GameViewState,
  playerId: ValidPlayerId,
): PlacementContext | null {
  const player = state.players[playerId];
  if (!player) return null;
  return {
    player,
    zone: player.homeTower?.zone,
    overlapAllowance: wallOverlapAllowance(player),
    allowPitOverlap: canPlaceOverBurningPit(player),
    allowGruntOverlap: canPlaceOverGrunt(state.players, player),
  };
}

/** Apply a piece placement to the board. Marks walls dirty after mutation.
 *  WARNING: Leaves interior stale. Caller MUST call recheckTerritory(state) before
 *  any code reads player.interior. Enforced at runtime by assertInteriorFresh().
 *  Used by host and watcher (no validation).
 *
 *  Advances the player's piece bag at the end so host and watcher consume
 *  state.rng identically per placement: `advancePlayerBag → nextPiece →
 *  refillBagQueueIfNeeded → piecePool → state.rng.shuffle` runs on both
 *  sides at the same point in the RNG stream. Skipping it on the watcher
 *  drifts state.rng once any player's bag refills mid-build, with the drift
 *  showing up later as desynced grunt/house spawn positions. */
export function applyPiecePlacement(
  state: GameState,
  playerId: ValidPlayerId,
  offsets: readonly [number, number][],
  row: number,
  col: number,
): void {
  if (isPlayerEliminated(state.players[playerId])) return;
  const player = state.players[playerId]!;
  const pieceKeys = new Set(
    offsets.map(([dr, dc]) => packTile(row + dr, col + dc)),
  );
  // Original-Rampart parity: piece tiles that overlap alive houses do
  // NOT become walls — the house is destroyed and a grunt emerges in
  // its place, occupying the tile. Wall set = piece minus house tiles.
  const destroyedHousePositions: TilePos[] = [];
  const houseTileKeys = new Set<TileKey>();
  for (const house of state.map.houses) {
    if (!house.alive) continue;
    const houseKey = packTile(house.row, house.col);
    if (pieceKeys.has(houseKey)) {
      house.alive = false;
      destroyedHousePositions.push({ row: house.row, col: house.col });
      houseTileKeys.add(houseKey);
    }
  }
  const wallKeys =
    houseTileKeys.size === 0
      ? pieceKeys
      : new Set([...pieceKeys].filter((key) => !houseTileKeys.has(key)));
  addPlayerWalls(player, wallKeys);
  emitGameEvent(state.bus, GAME_EVENT.WALL_PLACED, {
    playerId,
    tileKeys: [...wallKeys],
  });
  for (const pos of destroyedHousePositions) {
    emitGameEvent(state.bus, GAME_EVENT.HOUSE_CRUSHED, {
      playerId,
      row: pos.row,
      col: pos.col,
    });
  }
  state.bonusSquares = filterOffTiles(state.bonusSquares, wallKeys);
  onPiecePlaced(state, player, wallKeys);
  recheckTerritory(state);
  for (const pos of destroyedHousePositions) {
    spawnGruntAtTile(state, playerId, pos.row, pos.col);
  }
  advancePlayerBag(player, true);
}

/** Reclaim territory for all players after a wall mutation during active build phase.
 *  Sub-functions: recomputeInterior → updateEnclosedTowers → removeEnclosedGrunts →
 *  destroyEnclosedHouses → captureEnclosedBonusSquares → sweepMisplacedGrunts.
 *  Call after each piece placement or wall change during build phase.
 *  Do NOT use at end-of-build — use finalizeTerritoryWithScoring() instead (adds tower revival + scoring). */
export function recheckTerritory(state: GameState): void {
  // Pass 1: recompute ALL interiors before any grunt/house operations.
  // Grunt respawn (pass 2) calls hasInteriorAt which asserts freshness for
  // every player — all interiors must be fresh before any cross-player reads.
  for (const player of state.players) {
    recomputeInterior(player);
  }
  // Pass 2: territory-dependent operations (safe — all interiors are fresh).
  for (const player of state.players) {
    const interior = getInterior(player);
    updateEnclosedTowers(state, player);
    removeEnclosedGruntsAndRespawn(state, player, interior);
    destroyEnclosedHousesAndSpawnGrunts(state, player, interior);
    captureEnclosedBonusSquares(state, player, interior);
  }
  sweepMisplacedGrunts(state);
  refillRampartShields(state);
}

/** End-of-build territory finalization. Same as recheckTerritory() plus:
 *  - Awards territory/enclosure scoring points
 *  - Resolves pending tower revives (towerPendingRevive → alive if still enclosed)
 *  - Clears unenclosed pending revives
 *  Called exactly once at end of build phase from finalizeRound(). */
export function finalizeTerritoryWithScoring(state: GameState): void {
  // Pass 1: recompute ALL interiors (same rationale as recheckTerritory).
  for (const player of state.players) {
    recomputeInterior(player);
  }
  // Pass 2: territory-dependent operations + scoring.
  for (const player of state.players) {
    const interior = getInterior(player);
    updateEnclosedTowers(state, player);
    reviveEnclosedTowers(state, player);
    removeEnclosedGruntsAndRespawn(state, player, interior);
    destroyEnclosedHousesAndSpawnGrunts(state, player, interior);
    captureEnclosedBonusSquares(state, player, interior);
    awardEndOfBuildPoints(state, player, interior.size);
  }
  // ── Post-loop: global finalization ──
  sweepMisplacedGrunts(state);
  clearUnenclosedPendingRevives(state);
  refillRampartShields(state);
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
  const eliminatedZones = getDeadZones(state);
  const mainZones = topZonesBySize(map, 3)
    .map(({ zone }) => zone)
    .filter((zone) => !eliminatedZones.has(zone));

  // Build sets of enclosed and occupied tiles
  const enclosed = collectAllInterior(state);
  const occupied = collectOccupiedTiles(state, BONUS_PLACEMENT_BLOCKED);

  for (const zoneId of mainZones) {
    const existing = state.bonusSquares.filter(
      (bonus) => bonus.zone === zoneId,
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

    // R5b: candidate count is board-derived — shuffle on a private Rng (keyed
    // by zone) so the shared cursor advance stays board-independent.
    new Rng(
      deriveBoardLocalSeed(
        state.rng.seed,
        state.round,
        BOARD_LOCAL_SITE.BONUS_REFILL,
        zoneId,
      ),
    ).shuffle(candidates);

    let placed = 0;
    for (const [r, c] of candidates) {
      if (placed >= needed) break;
      // Ensure minimum distance from every existing bonus square
      const tooClose = state.bonusSquares.some(
        (bonus) =>
          manhattanDistance(bonus.row, bonus.col, r, c) <
          BONUS_SQUARE_MIN_DISTANCE,
      );
      if (tooClose) continue;
      occupied.add(packTile(r, c));
      state.bonusSquares.push({ row: r, col: c, zone: zoneId });
      placed++;
    }
  }
}

export function removeBonusSquaresCoveredByWalls(
  state: GameState,
  walls: ReadonlySet<TileKey>,
): void {
  state.bonusSquares = filterOffTiles(state.bonusSquares, walls);
}

/** Recompute interior + enclosedTowers for every player. Used by checkpoint
 *  rehydration and deserialization paths where the full player wall set
 *  has just been replaced and all interiors need to be re-flooded. */
export function recomputeAllTerritory(state: GameState): void {
  for (const player of state.players) {
    recomputeTerritoryFromWalls(state, player);
  }
}

/** Refill every alive rampart's shield to RAMPART_SHIELD_HP when its 2×2
 *  footprint is enclosed in its owner's interior; zero it when not enclosed.
 *  Called from `recheckTerritory` so the shield value tracks current
 *  enclosure throughout build/cannon-place phases (cross emblem flips green
 *  as soon as the perimeter closes, back to grey if it breaks). During
 *  battle the interior is intentionally stale, so battle-tick callers don't
 *  run recheckTerritory — the only mid-battle changes come from absorbed
 *  hits via `applyWallShield`. */
function refillRampartShields(state: GameState): void {
  for (const player of state.players) {
    for (const cannon of aliveCannons(player.cannons)) {
      if (cannon.mode !== CannonMode.RAMPART) continue;
      cannon.shieldHp = isCannonEnclosed(cannon, player)
        ? RAMPART_SHIELD_HP
        : 0;
    }
  }
}

/** Recompute interior and enclosedTowers from walls — no side effects.
 *  Used by checkpoint restore where grunts/houses/bonus are already correct. */
/** Private — callers outside this file should use `recomputeAllTerritory`. */
function recomputeTerritoryFromWalls(state: GameState, player: Player): void {
  recomputeInterior(player);
  updateEnclosedTowers(state, player);
}

/** Collect valid grass tiles for bonus square placement in a single zone. */
function findBonusSpawnCandidates(
  tiles: readonly (readonly Tile[])[],
  zones: readonly (readonly ZoneCell[])[],
  zoneId: ZoneId,
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
      if (!hasEnclosableMargin(tiles, r, c)) continue;
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
  // Territory points — 1 point per enclosed square (linear; see
  // TERRITORY_POINTS_PER_SQUARE). The upgrade multiplier still applies.
  const territoryMult = territoryScoreMult(player);
  const terrPts = territorySize * TERRITORY_POINTS_PER_SQUARE * territoryMult;
  if (terrPts > 0) addScore(player, terrPts);

  // Castle bonus (home castle = 2 units, others = 1 unit)
  const castleUnits = countCastleBonusUnits(state, player);
  let castlePts = 0;
  if (castleUnits > 0) {
    const idx = Math.min(castleUnits, CASTLE_BONUS_TABLE.length - 1);
    castlePts = CASTLE_BONUS_TABLE[idx]!;
    addScore(player, castlePts);
  }
}

function countCastleBonusUnits(state: GameState, player: Player): number {
  let castleUnits = 0;
  for (const tower of player.enclosedTowers) {
    if (state.towerAlive[tower.index]!) {
      castleUnits += tower === player.homeTower ? 2 : 1;
    }
  }
  return castleUnits;
}

/** Destroy houses enclosed by a player's territory and spawn a grunt per enemy.
 *  PRECONDITION: interior must be fresh (via recomputeInterior). */
function destroyEnclosedHousesAndSpawnGrunts(
  state: GameState,
  player: Player,
  interior: FreshInterior,
): void {
  const enemyCounts = new Map<ValidPlayerId, number>();
  for (const house of state.map.houses) {
    if (!house.alive) continue;
    const hKey = packTile(house.row, house.col);
    if (!interior.has(hKey)) continue;

    house.alive = false;
    for (const enemy of state.players) {
      if (enemy.id === player.id || !isPlayerSeated(enemy)) continue;
      enemyCounts.set(enemy.id, (enemyCounts.get(enemy.id) ?? 0) + 1);
    }
  }
  for (const [enemyId, count] of enemyCounts) {
    spawnGruntGroupOnZone(state, enemyId, count);
  }
}

/** Remove grunts enclosed by a player's territory (awards points).
 *  Each enclosed grunt has 50% chance to respawn on an enemy's zone.
 *  PRECONDITION: interior must be fresh (via recomputeInterior). */
function removeEnclosedGruntsAndRespawn(
  state: GameState,
  player: Player,
  interior: FreshInterior,
): void {
  const kept: Grunt[] = [];
  const enclosed: Grunt[] = [];
  for (const grunt of state.grunts) {
    if (interior.has(packTile(grunt.row, grunt.col))) {
      enclosed.push(grunt);
    } else {
      kept.push(grunt);
    }
  }
  if (enclosed.length === 0) return;

  state.grunts = kept;
  addScore(player, enclosed.length * DESTROY_GRUNT_POINTS);

  // One event per connected enclosed region containing grunts — drives
  // the `woodcrus` SFX. A single placement that seals off two disjoint
  // pockets simultaneously emits twice.
  emitGruntsEnclosedPerRegion(state, player.id, enclosed, interior);

  const enemies = state.players.filter(
    (other) => other.id !== player.id && isPlayerSeated(other),
  );
  if (enemies.length === 0) return;

  // Each enclosed grunt has 50% chance to respawn, alternating between
  // enemies. Tally per-enemy counts first, then batch-spawn so the
  // group-spawn min-spacing filter spreads them along the bank instead of
  // clustering at the closest-to-tower stretch.
  const counts = new Array<number>(enemies.length).fill(0);
  let enemyIdx = 0;
  // R5b: one respawn roll per enclosed grunt — count is board-dependent. Draw
  // from a private Rng (keyed by the enclosing player) so the shared cursor is
  // unmoved; recheckTerritory calls this many times per round.
  const localRng = new Rng(
    deriveBoardLocalSeed(
      state.rng.seed,
      state.round,
      BOARD_LOCAL_SITE.ENCLOSED_GRUNT_RESPAWN,
      player.id,
    ),
  );
  for (let i = 0; i < enclosed.length; i++) {
    if (!localRng.bool(ENCLOSED_GRUNT_RESPAWN_CHANCE)) continue;
    counts[enemyIdx % enemies.length] = counts[enemyIdx % enemies.length]! + 1;
    enemyIdx++;
  }
  for (let e = 0; e < enemies.length; e++) {
    if (counts[e]! > 0)
      spawnGruntGroupOnZone(state, enemies[e]!.id, counts[e]!);
  }
}

/** Flood-fill the interior (4-dir) from each unvisited enclosed grunt to
 *  group grunts by connected enclosed region, then emit one
 *  `gruntsEnclosed` event per group. Walls separate regions, so two
 *  pockets sealed by a single placement are treated as distinct
 *  enclosures. */
function emitGruntsEnclosedPerRegion(
  state: GameState,
  playerId: ValidPlayerId,
  enclosed: readonly Grunt[],
  interior: FreshInterior,
): void {
  const visited = new Set<TileKey>();
  for (const seed of enclosed) {
    const startKey = packTile(seed.row, seed.col);
    if (visited.has(startKey)) continue;
    let count = 0;
    const queue: TileKey[] = [startKey];
    visited.add(startKey);
    while (queue.length > 0) {
      const key = queue.shift()!;
      if (enclosed.some((grunt) => packTile(grunt.row, grunt.col) === key)) {
        count++;
      }
      const { row, col } = unpackTile(key);
      for (const [dr, dc] of DIRS_4) {
        const nKey = packTile(row + dr, col + dc);
        if (interior.has(nKey) && !visited.has(nKey)) {
          visited.add(nKey);
          queue.push(nKey);
        }
      }
    }
    emitGameEvent(state.bus, GAME_EVENT.GRUNTS_ENCLOSED, { playerId, count });
  }
}

/** Remove tower indices from towerPendingRevive if no longer enclosed by any player.
 *  Called at end of build to prevent reviving towers that lost enclosure. */
function clearUnenclosedPendingRevives(state: GameState): void {
  const toRemove: TowerIdx[] = [];
  for (const towerIdx of state.towerPendingRevive) {
    if (towerIdx < 0 || towerIdx >= state.map.towers.length) {
      toRemove.push(towerIdx);
      continue;
    }
    if (findTowerOwner(state.players, towerIdx) === undefined) {
      toRemove.push(towerIdx);
    }
  }
  for (const towerIdx of toRemove) state.towerPendingRevive.delete(towerIdx);
}

/** Recompute a player's interior via inverse flood-fill from map edges.
 *  Grass tiles not reachable through non-wall tiles become interior (territory).
 *  Calls markInteriorFresh() — after this, getInterior(player) is safe. */
function recomputeInterior(player: Player): void {
  const fresh = new Set<TileKey>();
  const outside = computeOutside(player.walls);
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const key = packTile(r, c);
      if (!outside.has(key) && !player.walls.has(key)) {
        fresh.add(key);
      }
    }
  }
  player.interior = markInteriorFresh(player, fresh);
}

/** Recompute `player.enclosedTowers` from the current interior and emit one
 *  `TOWER_ENCLOSED` event per tower that transitioned to enclosed this
 *  pass (SFX uses the events for the enclosure stinger + first-per-phase
 *  fanfare). The prior `enclosedTowers` is captured BEFORE rebuild — that
 *  snapshot is the diff source for newly-enclosed detection. */
function updateEnclosedTowers(state: GameState, player: Player): void {
  const previouslyEnclosed = new Set(
    player.enclosedTowers.map((tower) => tower.index),
  );
  player.enclosedTowers = state.map.towers.filter((tower) =>
    isTowerOwnedByPlayer(tower, player),
  );
  for (const tower of player.enclosedTowers) {
    if (previouslyEnclosed.has(tower.index)) continue;
    emitGameEvent(state.bus, GAME_EVENT.TOWER_ENCLOSED, {
      playerId: player.id,
      towerIndex: tower.index,
    });
  }
}

/** Process delayed tower revival for a single player (end-of-build-phase only).
 *  Dead towers enclosed for two consecutive build phases are revived.
 *  Dead towers enclosed for only one phase are marked pending.
 *  Restoration Crew: the first newly-pending tower skips the wait and
 *  revives immediately (the upgrade is consumed on use). */
function reviveEnclosedTowers(state: GameState, player: Player): void {
  for (const tower of player.enclosedTowers) {
    if (state.towerAlive[tower.index]) continue;
    if (state.towerPendingRevive.has(tower.index)) {
      state.towerAlive[tower.index] = true;
      state.towerPendingRevive.delete(tower.index);
    } else if (restorationCrewInstantRevive(player)) {
      state.towerAlive[tower.index] = true;
    } else {
      state.towerPendingRevive.add(tower.index);
    }
  }
}

/** Award bonus square points for squares enclosed by a player's territory. */
function captureEnclosedBonusSquares(
  state: GameState,
  player: Player,
  interior: FreshInterior,
): void {
  const territorySize = interior.size;
  state.bonusSquares = state.bonusSquares.filter((bonus) => {
    const bonusSquareKey = packTile(bonus.row, bonus.col);
    if (interior.has(bonusSquareKey)) {
      const pts = territoryBonusSquarePoints(territorySize);
      addScore(player, pts);
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
function isTowerOwnedByPlayer(tower: TilePos, player: Player): boolean {
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
    const gruntKey = packTile(grunt.row, grunt.col);
    return !state.players.some((player) =>
      isTileOwnedByPlayer(player, gruntKey),
    );
  });
}
