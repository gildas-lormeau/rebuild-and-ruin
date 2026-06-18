/**
 * Grunt lifecycle — spawning, respawn, tower attacks, and blocked tracking.
 *
 * Movement and pathfinding live in grunt-movement.ts.
 */

import {
  BATTLE_MESSAGE,
  type ImpactEvent,
  type TowerKilledMessage,
} from "../shared/core/battle-events.ts";
import type { Grunt } from "../shared/core/battle-types.ts";
import { FID } from "../shared/core/feature-defs.ts";
import {
  CATAPULT_SPAWN_CHANCE,
  FIRST_GRUNT_SPAWN_ROUND,
  GRUNT_ATTACK_DURATION,
  GRUNT_SPAWN_JITTER_CHANCE,
  GRUNT_SPAWN_MIN_DISTANCE,
  GRUNT_WALL_ATTACK_CHANCE,
  GRUNT_WALL_ATTACK_MIN_BATTLES,
  INTERBATTLE_GRUNT_SPAWN_ATTEMPTS,
  INTERBATTLE_GRUNT_SPAWN_CHANCE,
  MODIFIER_ID,
  TOWER_SIZE,
} from "../shared/core/game-constants.ts";
import { GAME_EVENT } from "../shared/core/game-event-bus.ts";
import type {
  TilePos,
  Tower,
  TowerIdx,
} from "../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, type TileKey } from "../shared/core/grid.ts";
import {
  isPlayerEliminated,
  type ValidPlayerId,
} from "../shared/core/player-slot.ts";
import {
  findTowerOwner,
  isPlayerSeated,
  type Player,
} from "../shared/core/player-types.ts";
import {
  DIRS_4,
  distanceToTower,
  inBounds,
  isGrass,
  isWater,
  manhattanDistance,
  packTile,
  unpackTile,
  zoneAt,
} from "../shared/core/spatial.ts";
import {
  type GameState,
  hasFeature,
  nextGruntSpawnSeq,
} from "../shared/core/types.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";
import {
  hasGruntAt,
  hasInteriorAt,
  hasWallAt,
} from "../shared/sim/board-occupancy.ts";
import { deletePlayerWallBattle } from "../shared/sim/player-walls.ts";
import {
  getDeadZones,
  getGruntTargetTower,
  getLiveTargetTower,
  isGruntPassableTile,
  isInTowerAttackRange,
} from "./grunt-movement.ts";
import { applyWallShield, resolveWallShield } from "./wall-impact.ts";

/** Search radius for finding nearest water tile. */
const WATER_SEARCH_RADIUS = 5;
/** Max ring radius when spawning a grunt near a destroyed house. */
const NEAR_SPAWN_RADIUS = 8;

/** Spawn a grunt exactly at (row, col) — used when a piece is laid on
 *  top of a house, so the new occupant emerges where the house stood
 *  (no wall is built on that tile). Skips if `excludePlayerId` is the
 *  only non-eliminated player. Caller must guarantee the tile is grass
 *  and unobstructed; `addGrunt` silently no-ops otherwise. */
export function spawnGruntAtTile(
  state: GameState,
  excludePlayerId: ValidPlayerId,
  row: number,
  col: number,
): void {
  if (
    state.players.every(
      (player) => player.id === excludePlayerId || isPlayerEliminated(player),
    )
  )
    return;
  addGrunt(state, row, col, "at-tile");
}

/** Find a spawn position near (posRow, posCol) by spiralling outward.
 *  Checks expanding rings up to NEAR_SPAWN_RADIUS.
 *  Only considers tiles in the same zone that pass isValidGruntSpawnTile. */
export function findGruntSpawnNear(
  state: GameState,
  posRow: number,
  posCol: number,
): TilePos | null {
  const zone = zoneAt(state.map, posRow, posCol);
  if (zone === undefined) return null;

  for (let radius = 1; radius <= NEAR_SPAWN_RADIUS; radius++) {
    let best: TilePos | undefined;
    let bestDist = Infinity;
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.abs(dr) !== radius && Math.abs(dc) !== radius) continue;
        const row = posRow + dr;
        const col = posCol + dc;
        if (!inBounds(row, col)) continue;
        if (zoneAt(state.map, row, col) !== zone) continue;
        if (!isValidGruntSpawnTile(state, row, col)) continue;
        const dist = manhattanDistance(row, col, posRow, posCol);
        if (dist < bestDist) {
          bestDist = dist;
          best = { row, col };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/** Spawn grunts distributed evenly across alive towers in a player's zone.
 *  Uses the same bank/edge spawn logic as regular grunt spawning, then
 *  round-robin assigns each position to the nearest alive tower. */
export function spawnGruntSurgeOnZone(
  state: GameState,
  playerId: ValidPlayerId,
  totalCount: number,
): void {
  const player = state.players[playerId];
  if (!isPlayerSeated(player)) return;

  const zone = player.homeTower.zone;

  // Collect alive towers in this zone
  const zoneTowers: { row: number; col: number }[] = [];
  for (let towerIdx = 0; towerIdx < state.map.towers.length; towerIdx++) {
    const tower = state.map.towers[towerIdx]!;
    if (tower.zone !== zone || !state.towerAlive[towerIdx]) continue;
    zoneTowers.push({ row: tower.row, col: tower.col });
  }
  if (zoneTowers.length === 0) return;

  // Reuse bank/edge spawn logic (border-first, then water proximity)
  const positions = findGruntSpawnPositions(state, player, totalCount);

  // Round-robin towers, for each pick the nearest available position
  const used = new Set<number>();
  for (let gruntIdx = 0; gruntIdx < positions.length; gruntIdx++) {
    const tower = zoneTowers[gruntIdx % zoneTowers.length]!;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let posIdx = 0; posIdx < positions.length; posIdx++) {
      if (used.has(posIdx)) continue;
      const pos = positions[posIdx]!;
      const dist = distanceToTower(tower, pos.row, pos.col);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = posIdx;
      }
    }
    if (bestIdx < 0) break;
    used.add(bestIdx);
    const pick = positions[bestIdx]!;
    addGrunt(state, pick.row, pick.col, "zone-pick");
  }
  if (positions.length < totalCount) {
    state.bus.emit(GAME_EVENT.GRUNT_SPAWN_BLOCKED, {
      type: GAME_EVENT.GRUNT_SPAWN_BLOCKED,
      playerId,
      requested: totalCount,
      placed: positions.length,
    });
  }
}

export function gruntAttackTowers(
  state: GameState,
  dt: number,
): { towerEvents: TowerKilledMessage[]; wallEvents: ImpactEvent[] } {
  // Frostbite: ice-cube grunts can't swing at adjacent walls or towers either.
  if (state.modern?.activeModifier === MODIFIER_ID.FROSTBITE)
    return { towerEvents: [], wallEvents: [] };

  const deadZones = getDeadZones(state);
  const events: TowerKilledMessage[] = [];
  const wallEvents: ImpactEvent[] = [];
  for (const grunt of state.grunts) {
    // 1 action point per battle: a grunt that already completed a swing
    // this battle is done — no wall→tower or wall→wall chaining (this
    // also stops catapults re-routing to the next blocking wall).
    if (grunt.attackDone) continue;

    // Attack target is derived from the grunt's CURRENT zone every tick —
    // a grunt attacks the nearest live tower in its current territory that
    // it's in range of, regardless of where it was originally heading.
    // The pathing target (grunt.targetTowerIdx) drives movement during
    // build but is irrelevant here.
    const attackTarget = nearestAttackableTowerInZone(state, grunt, deadZones);

    // Catapult path-blocking: a wall between a catapult and its attack
    // target diverts the shot to the wall. Re-evaluated per-tick so a
    // blocking wall destroyed by other means mid-swing (cannonball) re-
    // routes the swing — chaining past the catapult's own completed swing
    // is stopped by the attackDone gate above. Sets attackingWall +
    // targetedWall when blocked.
    if (grunt.kind === "catapult") {
      maybeRouteCatapultToBlockingWall(state, grunt, attackTarget);
    }

    // Wall attack: executing decision made by rollGruntWallAttacks() at
    // battle start (regular grunts), or set this tick by the catapult
    // path-block pre-pass above. Regular grunts' targetedWall was picked
    // at end-of-build (`recomputeGruntTargetedWalls`) and is cleared on
    // destruction in applyImpactEvent — they don't move during battle.
    // Catapults re-evaluate every tick via the pre-pass.
    if (grunt.attackingWall) {
      if (grunt.targetedWall !== undefined) {
        if (tickGruntAttackTimer(grunt, dt)) {
          completeWallSwing(state, grunt.targetedWall, wallEvents);
          delete grunt.attackingWall;
          grunt.attackDone = true;
        }
        continue;
      }
      // No targeted wall — stop wall attack
      delete grunt.attackingWall;
    }

    if (attackTarget !== undefined) {
      if (tickGruntAttackTimer(grunt, dt)) {
        // Lookup BEFORE mutating towerAlive so POV-filtered consumers
        // (haptics) see the owner as-of kill time. Unenclosed neutral
        // towers have no owner — the kill still proceeds (matches pre-
        // POV-filtering behaviour); playerId is omitted so haptics
        // correctly no-ops for every POV.
        const ownerId = findTowerOwner(state.players, attackTarget);
        state.towerAlive[attackTarget] = false;
        const towerEvent: TowerKilledMessage = {
          type: BATTLE_MESSAGE.TOWER_KILLED,
          towerIdx: attackTarget,
          ...(ownerId !== undefined && { playerId: ownerId }),
        };
        events.push(towerEvent);
        state.bus.emit(BATTLE_MESSAGE.TOWER_KILLED, towerEvent);
        grunt.attackDone = true;
      }
    } else {
      // Reset timer if no longer adjacent to attackable tower
      grunt.attackCountdown = undefined;
    }
  }
  return { towerEvents: events, wallEvents };
}

/**
 * Called at end of battle: update blockedRounds counter for each grunt.
 * A grunt is "blocked" if it has an alive target tower but is not in attack
 * range (adjacent for grunts, Manhattan ≤ 3 for catapults).
 */
export function updateGruntBlockedBattles(state: GameState): void {
  for (const grunt of state.grunts) {
    const liveTarget = getLiveTargetTower(state, grunt);
    if (!liveTarget) continue;

    const inRange = isInTowerAttackRange(
      state,
      grunt.row,
      grunt.col,
      liveTarget.towerIndex,
      grunt.kind,
    );

    if (inRange) {
      grunt.blockedRounds = 0;
    } else {
      grunt.blockedRounds += 1;
    }
    // Clear wall attack state (decision does not persist across rounds)
    delete grunt.attackingWall;
  }
}

/**
 * Called at start of battle: blocked grunts (≥2 battles) with alive target
 * have 1/4 chance to attack an adjacent wall.
 */
/** attackingWall lifecycle: rollGruntWallAttacks (set) → gruntAttackTowers (execute) →
 *  updateGruntBlockedBattles (clear). All three run during BATTLE phase only.
 *  Sapper bypasses both the blocked-battles requirement and the random roll —
 *  any grunt adjacent to a wall flips the flag. */
export function rollGruntWallAttacks(state: GameState): void {
  const sapperActive = state.modern?.activeModifier === MODIFIER_ID.SAPPER;
  for (const grunt of state.grunts) {
    if (!canAttemptWallAttack(state, grunt, sapperActive)) continue;

    if (sapperActive || state.rng.bool(GRUNT_WALL_ATTACK_CHANCE)) {
      grunt.attackingWall = true;
    }
  }
}

/** Recompute `targetedWall` for every grunt — the adjacent wall closest to
 *  the grunt's target tower (or undefined if no eligible wall). Called once
 *  at end-of-build in `finalizeRoundCleanup`, after wall sweep + dead-zone
 *  grunt sweep. The cached value is read by the sapper reveal banner and by
 *  `gruntAttackTowers`'s wall pick during battle. Cleared on the destroyed
 *  wall in `applyImpactEvent`; cleared on all grunts in `finalizeBattle`. */
export function recomputeGruntTargetedWalls(state: GameState): void {
  for (const grunt of state.grunts) {
    grunt.targetedWall = computeGruntTargetedWall(state, grunt);
  }
}

/** Spawn interbattle grunts on each player's zone (bank-first).
 *  PRECONDITION: interior must be fresh (recheckTerritory already called).
 *
 *  `upcomingRound` is the round whose battle these grunts will join. The
 *  caller (prepareNextRound, at `battle-done`) passes `state.round + 1`
 *  because state.round doesn't advance until this round's `round-end` mutate
 *  (end of the upcoming WALL_BUILD) — so it's still the closing round here. */
export function spawnInterbattleGrunts(
  state: GameState,
  upcomingRound: number,
): void {
  if (upcomingRound < FIRST_GRUNT_SPAWN_ROUND) return;

  for (const player of state.players.filter(isPlayerSeated)) {
    let spawnCount = 0;
    for (let idx = 0; idx < INTERBATTLE_GRUNT_SPAWN_ATTEMPTS; idx++) {
      if (state.rng.bool(INTERBATTLE_GRUNT_SPAWN_CHANCE)) spawnCount++;
    }
    if (spawnCount > 0) spawnGruntGroupOnZone(state, player.id, spawnCount);
  }
}

/** Spawn a group of grunts on a player's zone (bank-first). */
export function spawnGruntGroupOnZone(
  state: GameState,
  playerId: ValidPlayerId,
  count: number,
): void {
  const player = state.players[playerId];
  if (!isPlayerSeated(player)) return;
  const positions = findGruntSpawnPositions(state, player, count);
  for (const pos of positions) {
    addGrunt(state, pos.row, pos.col, "zone-pick");
  }
  if (positions.length < count) {
    state.bus.emit(GAME_EVENT.GRUNT_SPAWN_BLOCKED, {
      type: GAME_EVENT.GRUNT_SPAWN_BLOCKED,
      playerId,
      requested: count,
      placed: positions.length,
    });
  }
}

/** Resolve a completed wall swing. The wall survives if a Reinforced Walls
 *  absorption or nearby allied Rampart shields it; shield side effects are
 *  applied directly (no bus events — matches today's silent grunt wall
 *  removal). Otherwise the wall is destroyed: WALL_DESTROYED is emitted so
 *  the watcher mirrors the wall set mid-battle. shooterId omitted — no
 *  scoring on grunt-broken walls. The host applies the mutation locally
 *  here (calling applyImpactEvent would cycle the import — battle-system
 *  already imports from this file); the event is bubbled to
 *  `tickBattlePhase` via `wallEvents` for wire broadcast and watcher-side
 *  `applyImpactEvent`.
 *  Interior-staleness contract: see battle-system.ts applyImpactEvent JSDoc. */
function completeWallSwing(
  state: GameState,
  targetedWall: TileKey,
  wallEvents: ImpactEvent[],
): void {
  const { row, col } = unpackTile(targetedWall);
  const result = resolveWallShield(state, row, col, targetedWall);
  if (result?.absorbed) {
    applyWallShield(state, result);
    return;
  }
  if (!result) return;
  const owner = state.players[result.playerId];
  if (owner) deletePlayerWallBattle(owner, targetedWall);
  // Mirror applyImpactEvent: clear targetedWall on every grunt that was
  // aiming at this wall (grunts don't move, no repick).
  for (const other of state.grunts) {
    if (other.targetedWall === targetedWall) other.targetedWall = undefined;
  }
  const event: ImpactEvent = {
    type: BATTLE_MESSAGE.WALL_DESTROYED,
    row: row,
    col: col,
    playerId: result.playerId,
  };
  wallEvents.push(event);
  state.bus.emit(event.type, event);
}

/** Nearest live tower in the grunt's current zone that the grunt is in
 *  attack range of (4-dir adjacency for regular grunts, Manhattan ≤ 3
 *  for catapults). Returns undefined when the grunt is off-zone (e.g.
 *  standing on frozen water) or no in-zone tower is in range. Used by
 *  `gruntAttackTowers` to enforce "grunts attack towers in their
 *  current territory". */
function nearestAttackableTowerInZone(
  state: GameState,
  grunt: Grunt,
  deadZones: ReadonlySet<ZoneId>,
): TowerIdx | undefined {
  const gruntZone = zoneAt(state.map, grunt.row, grunt.col);
  if (gruntZone === undefined) return undefined;
  if (deadZones.has(gruntZone)) return undefined;
  let best: TowerIdx | undefined;
  let bestDist = Infinity;
  for (let i = 0; i < state.map.towers.length; i++) {
    if (!state.towerAlive[i]) continue;
    const tower = state.map.towers[i]!;
    if (tower.zone !== gruntZone) continue;
    if (
      !isInTowerAttackRange(
        state,
        grunt.row,
        grunt.col,
        i as TowerIdx,
        grunt.kind,
      )
    )
      continue;
    const dist = distanceToTower(tower, grunt.row, grunt.col);
    if (dist < bestDist) {
      best = i as TowerIdx;
      bestDist = dist;
    }
  }
  return best;
}

/** Pick the adjacent wall a grunt would attack — the one closest to its
 *  target tower. Returns undefined if the grunt has no live target tower or
 *  no adjacent wall. Bypasses the blocked-battles requirement (this is the
 *  "stable answer" for the upcoming battle, regardless of whether a random
 *  roll picks the grunt to actually attack). */
function computeGruntTargetedWall(
  state: GameState,
  grunt: Grunt,
): TileKey | undefined {
  if (!canAttemptWallAttack(state, grunt, true)) return undefined;
  const target = getGruntTargetTower(state, grunt);
  return pickAdjacentWallKeyForAttack(state, grunt.row, grunt.col, target);
}

/** Per-tick check for catapults: if a wall sits between the catapult and
 *  its in-zone attack target, tag that wall as the attack target so the
 *  existing wall-attack flow handles destruction. When the blocking wall
 *  changes or disappears mid-swing (e.g. a cannonball broke it), reset the
 *  attack countdown so the catapult starts a fresh swing on the new
 *  target. Never runs after the catapult's own swing completes — the
 *  1-action-point gate in `gruntAttackTowers` skips spent grunts before
 *  this pre-pass. Caller passes the precomputed attack target
 *  (`nearestAttackableTowerInZone`); no-op when undefined (no in-zone
 *  tower in catapult's range). */
function maybeRouteCatapultToBlockingWall(
  state: GameState,
  grunt: Grunt,
  attackTarget: TowerIdx | undefined,
): void {
  if (attackTarget === undefined) return;
  const tower = state.map.towers[attackTarget];
  if (!tower) return;
  const blockingWall = findCatapultBlockingWall(
    state,
    grunt.row,
    grunt.col,
    tower,
  );
  if (blockingWall !== null) {
    if (grunt.targetedWall !== blockingWall) {
      grunt.targetedWall = blockingWall;
      grunt.attackCountdown = undefined;
    }
    grunt.attackingWall = true;
  } else if (grunt.attackingWall) {
    delete grunt.attackingWall;
    grunt.targetedWall = undefined;
    grunt.attackCountdown = undefined;
  }
}

/** Walk the canonical Manhattan path from (catapultRow, catapultCol) to the
 *  nearest tile of `tower` (greater-axis-first). Return the tile key of the
 *  first wall encountered, or null if the path is clear. Both endpoints are
 *  excluded — the catapult's own tile and the tower's nearest tile are
 *  never tested. */
function findCatapultBlockingWall(
  state: GameState,
  catapultRow: number,
  catapultCol: number,
  tower: Tower,
): TileKey | null {
  const targetRow = Math.max(
    tower.row,
    Math.min(catapultRow, tower.row + TOWER_SIZE - 1),
  );
  const targetCol = Math.max(
    tower.col,
    Math.min(catapultCol, tower.col + TOWER_SIZE - 1),
  );
  let row = catapultRow;
  let col = catapultCol;
  while (row !== targetRow || col !== targetCol) {
    const remainingRow = Math.abs(targetRow - row);
    const remainingCol = Math.abs(targetCol - col);
    if (remainingRow > remainingCol) row += Math.sign(targetRow - row);
    else col += Math.sign(targetCol - col);
    if (row === targetRow && col === targetCol) break;
    if (hasWallAt(state, row, col)) return packTile(row, col);
  }
  return null;
}

/** Add a grunt at (row, col). Validates position is in-bounds and on passable grass.
 *  Grunts are ownerless hazards — the "victim" (player whose territory is
 *  being attacked) is derived from the grunt's current zone at read time,
 *  never stored. Listeners on GRUNT_SPAWN do `zoneOwnerIdAt(state, row, col)`
 *  if they need that. */
function addGrunt(
  state: GameState,
  row: number,
  col: number,
  source: "zone-pick" | "at-tile",
): void {
  if (!inBounds(row, col) || !isGrass(state.map.tiles, row, col)) return;
  const grunt: Grunt = { row, col, blockedRounds: 0 };
  if (hasFeature(state, FID.CATAPULTS) && state.rng.bool(CATAPULT_SPAWN_CHANCE))
    grunt.kind = "catapult";
  state.grunts.push(grunt);
  state.bus.emit(GAME_EVENT.GRUNT_SPAWN, {
    type: GAME_EVENT.GRUNT_SPAWN,
    row,
    col,
    source,
    round: state.round,
  });
}

/** Find spawn positions for grunts in an enemy's zone.
 *  Priority: bank (adjacent to water, waterDist=1) → edge (row/col 0 or max) → nothing.
 *  Within each tier, tiles closer to the zone's nearest alive tower are preferred. */
function findGruntSpawnPositions(
  state: GameState,
  enemy: Player,
  count: number,
): TilePos[] {
  const zone = enemy.homeTower?.zone;
  if (zone === undefined) return [];

  const bank: { row: number; col: number }[] = [];
  const edge: { row: number; col: number }[] = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      if (zoneAt(state.map, row, col) !== zone) continue;
      if (!isValidGruntSpawnTile(state, row, col)) continue;
      if (minWaterDistance(state, row, col) <= 1) {
        bank.push({ row, col });
      } else if (isEdgeTile(row, col)) {
        edge.push({ row, col });
      }
    }
  }

  // Score each tile by distance to its NEAREST alive tower in the zone
  // (2x2 → +1 offset to center). Using min-over-towers instead of a
  // single anchor tower means bank tiles near any tower rank similarly,
  // so spawns spread across the whole zone instead of clustering on
  // one tower's bank.
  const aliveTowerCenters: { row: number; col: number }[] = [];
  for (let i = 0; i < state.map.towers.length; i++) {
    const tower = state.map.towers[i]!;
    if (tower.zone === zone && state.towerAlive[i]) {
      aliveTowerCenters.push({ row: tower.row + 1, col: tower.col + 1 });
    }
  }
  const scoreToNearestTower = (row: number, col: number): number => {
    if (aliveTowerCenters.length === 0) return 0;
    let best = Infinity;
    for (const tower of aliveTowerCenters) {
      const dist = manhattanDistance(tower.row, tower.col, row, col);
      if (dist < best) best = dist;
    }
    return best;
  };
  const sortByNearestTower = (arr: { row: number; col: number }[]): void => {
    if (aliveTowerCenters.length === 0) return;
    arr.sort(
      (a, b) =>
        scoreToNearestTower(a.row, a.col) - scoreToNearestTower(b.row, b.col),
    );
  };
  sortByNearestTower(bank);
  sortByNearestTower(edge);

  // Rotate the sorted list by `seq % length` so successive calls cycle
  // through every candidate tile instead of all seeding at the closest
  // tile. Optional minor RNG jitter swaps the top two ~30% of the time
  // to break stable mirror cycles. Applied identically to bank (primary
  // tier) and edge (fallback tier).
  const seq = nextGruntSpawnSeq(state);
  const jitter = state.rng.bool(GRUNT_SPAWN_JITTER_CHANCE);
  const rotateList = (arr: { row: number; col: number }[]): void => {
    if (arr.length < 2) return;
    const rotation = seq % arr.length;
    if (rotation > 0) {
      const head = arr.slice(0, rotation);
      const tail = arr.slice(rotation);
      arr.length = 0;
      arr.push(...tail, ...head);
    }
    if (jitter && arr.length >= 2) {
      const swap = arr[0]!;
      arr[0] = arr[1]!;
      arr[1] = swap;
    }
  };
  rotateList(bank);
  rotateList(edge);

  // Existing grunts in this zone act as "prior picks" — successive spawn
  // calls (separate rounds, separate enclosures) would otherwise all seed
  // at the closest-to-tower bank tile and cluster across time, not just
  // within one batch.
  const zoneGrunts = state.grunts.filter(
    (grunt) => zoneAt(state.map, grunt.row, grunt.col) === zone,
  );

  // Tiles already used for spawns this round (regardless of where the
  // grunt is now — it may have walked inland). Distance-based filter
  // against these prevents clustering when the rotation cycle wraps
  // past `bank.length`.
  const usedTiles: { row: number; col: number }[] = [];
  const usedSet = state.gruntSpawnUsedTiles.get(zone);
  if (usedSet) {
    for (const tileKey of usedSet) {
      const { row, col } = unpackTile(tileKey);
      usedTiles.push({ row: row, col: col });
    }
  }

  // Two-pass pick: first pass enforces spacing against zone grunts,
  // recently-used spawn tiles, and batch picks. If still short of
  // `count`, second pass drops only the zoneGrunts filter (the soft
  // "don't crowd existing grunts" preference); used-tile and batch
  // filters stay active so the relaxation never produces adjacent
  // clusters in the same round.
  const result: TilePos[] = [];
  // lint:allow-closure-captures -- intentional: `pick` is a local
  // helper that splits the strict/relaxed pass over the same picking
  // state (`result`, `usedTiles`, `zoneGrunts`, `count`) — lifting it
  // to module scope would force a 5-field params object for a
  // single-file helper.
  const pick = (
    candidates: readonly { row: number; col: number }[],
    strict: boolean,
  ) => {
    for (const cand of candidates) {
      if (result.length >= count) return;
      const tooCloseToBatch = result.some(
        (existing) =>
          manhattanDistance(existing.row, existing.col, cand.row, cand.col) <
          GRUNT_SPAWN_MIN_DISTANCE,
      );
      if (tooCloseToBatch) continue;
      const tooCloseToUsed = usedTiles.some(
        (used) =>
          manhattanDistance(used.row, used.col, cand.row, cand.col) <
          GRUNT_SPAWN_MIN_DISTANCE,
      );
      if (tooCloseToUsed) continue;
      if (strict) {
        const tooCloseToZoneGrunt = zoneGrunts.some(
          (grunt) =>
            manhattanDistance(grunt.row, grunt.col, cand.row, cand.col) <
            GRUNT_SPAWN_MIN_DISTANCE,
        );
        if (tooCloseToZoneGrunt) continue;
      }
      result.push({ row: cand.row, col: cand.col });
    }
  };
  pick(bank, true);
  pick(edge, true);
  if (result.length < count) {
    pick(bank, false);
    pick(edge, false);
  }

  // Record the picks in this round's used-tile set so future calls
  // avoid clustering near them.
  if (result.length > 0) {
    let zoneUsed = state.gruntSpawnUsedTiles.get(zone);
    if (!zoneUsed) {
      zoneUsed = new Set();
      state.gruntSpawnUsedTiles.set(zone, zoneUsed);
    }
    for (const pos of result) {
      zoneUsed.add(packTile(pos.row, pos.col));
    }
  }

  return result;
}

function isEdgeTile(row: number, col: number): boolean {
  return row <= 0 || col <= 0 || row >= GRID_ROWS - 1 || col >= GRID_COLS - 1;
}

/** Core validity check for grunt spawning. Rejects frozen water (grunts
 *  walk on ice but cannot spawn there), walls, interior territory, existing
 *  grunts, and all blocking obstacles (cannons, houses, towers, pits).
 *  Zone filtering and batch-dedup are layered on top by callers. */
function isValidGruntSpawnTile(
  state: GameState,
  row: number,
  col: number,
): boolean {
  if (!inBounds(row, col)) return false;
  if (!isGrass(state.map.tiles, row, col)) return false;
  if (!isGruntPassableTile(state, row, col)) return false;
  if (hasInteriorAt(state, packTile(row, col))) return false;
  return !hasGruntAt(state.grunts, row, col);
}

function minWaterDistance(state: GameState, row: number, col: number): number {
  let minWaterDist = Infinity;
  for (
    let dr = -WATER_SEARCH_RADIUS;
    dr <= WATER_SEARCH_RADIUS && minWaterDist > 1;
    dr++
  ) {
    for (
      let dc = -WATER_SEARCH_RADIUS;
      dc <= WATER_SEARCH_RADIUS && minWaterDist > 1;
      dc++
    ) {
      const nr = row + dr;
      const nc = col + dc;
      if (inBounds(nr, nc) && isWater(state.map.tiles, nr, nc)) {
        const distance = Math.abs(dr) + Math.abs(dc);
        if (distance < minWaterDist) minWaterDist = distance;
      }
    }
  }
  return minWaterDist;
}

function canAttemptWallAttack(
  state: GameState,
  grunt: Grunt,
  bypassBlockedRequirement: boolean,
): boolean {
  return (
    (bypassBlockedRequirement || hasBlockedBattlesForWallAttack(grunt)) &&
    getLiveTargetTower(state, grunt) !== null &&
    hasAdjacentWall(state, grunt.row, grunt.col)
  );
}

function hasBlockedBattlesForWallAttack(
  grunt: Pick<Grunt, "blockedRounds">,
): boolean {
  return grunt.blockedRounds >= GRUNT_WALL_ATTACK_MIN_BATTLES;
}

function hasAdjacentWall(state: GameState, row: number, col: number): boolean {
  return adjacentWallKeys(state, row, col).length > 0;
}

function tickGruntAttackTimer(grunt: Grunt, dt: number): boolean {
  if (grunt.attackCountdown === undefined) {
    grunt.attackCountdown = GRUNT_ATTACK_DURATION;
  }
  grunt.attackCountdown -= dt;
  if (grunt.attackCountdown <= 0) {
    grunt.attackCountdown = undefined;
    return true;
  }
  return false;
}

function pickAdjacentWallKeyForAttack(
  state: GameState,
  row: number,
  col: number,
  target: TilePos | null,
): TileKey | undefined {
  const walls = adjacentWallKeys(state, row, col);
  if (!target) return walls[0];
  let bestWallKey: TileKey | undefined;
  let bestDist = Infinity;
  for (const wallKey of walls) {
    const { row: nr, col: nc } = unpackTile(wallKey);
    const distance = manhattanDistance(nr, nc, target.row, target.col);
    if (distance < bestDist) {
      bestDist = distance;
      bestWallKey = wallKey;
    }
  }
  return bestWallKey;
}

function adjacentWallKeys(
  state: GameState,
  row: number,
  col: number,
): TileKey[] {
  const walls: TileKey[] = [];
  for (const [dr, dc] of DIRS_4) {
    const nr = row + dr;
    const nc = col + dc;
    if (!inBounds(nr, nc)) continue;
    if (!hasWallAt(state, nr, nc)) continue;
    walls.push(packTile(nr, nc));
  }
  return walls;
}
