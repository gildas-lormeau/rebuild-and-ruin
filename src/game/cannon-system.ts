/**
 * Cannon placement and management — validation, slot counting, placement.
 */

import {
  type BurningPit,
  type Cannon,
  CannonMode,
} from "../shared/core/battle-types.ts";
import {
  filterAliveOwnedTowers,
  hasWallAt,
  isCannonEnclosed,
} from "../shared/core/board-occupancy.ts";
import { cannonModeDef } from "../shared/core/cannon-mode-defs.ts";
import {
  MAX_CANNON_LIMIT_ON_RESELECT,
  RAMPART_SHIELD_HP,
  STARTING_LIVES,
  TOWER_SIZE,
} from "../shared/core/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { TilePos } from "../shared/core/geometry-types.ts";
import {
  assertInteriorFresh,
  getInterior,
} from "../shared/core/player-interior.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import {
  isPlayerEliminated,
  isPlayerSeated,
  type Player,
} from "../shared/core/player-types.ts";
import {
  cannonSize,
  DIRS_4,
  FACING_90_STEP,
  hasPitAt,
  inBounds,
  isBalloonCannon,
  isCannonAlive,
  isCannonTile,
  isRampartCannon,
  isTowerTile,
  isWater,
  packTile,
  snapAngle,
  towerCenter,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { GameViewState } from "../shared/core/system-interfaces.ts";
import { type GameState } from "../shared/core/types.ts";
import { cannonSlotsBonus, onCannonPlaced } from "./upgrade-system.ts";
import { rapidEmplacementDiscount } from "./upgrades/rapid-emplacement.ts";

export { isCannonEnclosed };

/** Max search radius when snapping cannon placement to a valid tile. */
const CANNON_SNAP_RADIUS = 2;

/** Whether any valid placement exists for the given cannon mode in the player's territory. */
export function hasAnyCannonPlacement(
  player: Player,
  mode: CannonMode,
  state: GameViewState & { readonly burningPits: readonly BurningPit[] },
): boolean {
  return findFirstLegalCannonPlacement(player, mode, state) !== null;
}

/** Auto-place normal cannons for round-1 if none were placed.
 *  Safety net — ensures every player starts with cannons even if they
 *  skipped placement. Picks evenly spaced valid interior positions. */
export function autoPlaceRound1Cannons(
  state: GameViewState & {
    readonly burningPits: readonly BurningPit[];
    readonly cannonMaxHp: number;
    readonly pendingCannonSlotCost: readonly number[];
    readonly round?: number;
  },
  playerId: ValidPlayerSlot,
  maxSlots: number,
): void {
  if (state.round !== 1) return;
  const player = state.players[playerId];
  if (!player || isPlayerEliminated(player) || player.cannons.length > 0)
    return;

  const candidates = findLegalCannonPlacements(
    player,
    CannonMode.NORMAL,
    state,
  );
  if (candidates.length === 0) return;

  // Evenly space placements across candidates for spread
  const needed = maxSlots - cannonSlotsUsed(player);
  const stride = Math.max(
    1,
    Math.floor(candidates.length / Math.max(1, needed)),
  );
  for (
    let i = 0;
    i < candidates.length && cannonSlotsUsed(player) < maxSlots;
    i += stride
  ) {
    const pos = candidates[i]!;
    placeCannon(player, pos.row, pos.col, maxSlots, CannonMode.NORMAL, state);
  }
  // Fill remaining slots from any skipped candidates
  for (
    let i = 0;
    i < candidates.length && cannonSlotsUsed(player) < maxSlots;
    i++
  ) {
    const pos = candidates[i]!;
    placeCannon(player, pos.row, pos.col, maxSlots, CannonMode.NORMAL, state);
  }
}

/** Validate + apply cannon placement. Returns true if placed. */
export function placeCannon(
  player: Player,
  row: number,
  col: number,
  maxCannons: number,
  mode: CannonMode,
  state: GameViewState & {
    readonly burningPits: readonly BurningPit[];
    readonly cannonMaxHp: number;
    readonly pendingCannonSlotCost: readonly number[];
  },
): boolean {
  if (isPlayerEliminated(player)) return false;
  if (!isCannonPlacementLegal(player, row, col, mode, maxCannons, state))
    return false;
  applyCannonPlacement(player, row, col, mode, state);
  onCannonPlaced(player);
  emitGameEvent(state.bus, GAME_EVENT.CANNON_PLACED, {
    playerId: player.id,
    row,
    col,
    cannonIdx: player.cannons.length - 1,
  });
  return true;
}

/** True when every non-eliminated slot has flagged itself done with the
 *  CANNON_PLACE phase. Mirrors `allSelectionsConfirmed` (game/selection.ts)
 *  for the cannon phase: same shape, different storage (a Set on
 *  GameState rather than a Map of per-slot states). Used by
 *  `tickCannonPhase` as the early-exit predicate; the timer-fallback
 *  path bypasses this check (unfinished slots are discarded — see
 *  the project rule for cannon-phase timer expiry). */
export function allCannonPlaceDone(state: GameState): boolean {
  return state.players.every(
    (player) =>
      isPlayerEliminated(player) || state.cannonPlaceDone.has(player.id),
  );
}

/** Drain-time cannon placement: re-validates against `applyAt` state (which
 *  may differ from schedule-time state — other placements may have consumed
 *  tiles or slots in the SAFETY window) and runs the full placement effect
 *  (apply + post-place upgrade hooks). Both the originator
 *  (`scheduled-actions.ts`) and receiver (`online-server-events.ts`) paths
 *  call this so the apply body lives in one place. The synchronous local
 *  `placeCannon` path is separate because it also emits the CANNON_PLACED
 *  bus event — scheduled placements don't (no observer needs that signal at
 *  drain time today). */
export function applyCannonAtDrain(
  state: GameState,
  playerId: ValidPlayerSlot,
  row: number,
  col: number,
  mode: CannonMode,
): boolean {
  const player = state.players[playerId];
  if (!player) return false;
  const maxCannons = state.cannonLimits[playerId] ?? 0;
  if (!isCannonPlacementLegal(player, row, col, mode, maxCannons, state))
    return false;
  applyCannonPlacement(player, row, col, mode, state);
  onCannonPlaced(player);
  return true;
}

/** True if the player can legally place a cannon of `mode` at `(row, col)`.
 *  Composes the slot-budget check (slots used + this cannon's effective cost
 *  must fit in `maxCannons`) and the spatial check (`canPlaceCannon`).
 *
 *  Single source of truth for both the local action path (`placeCannon`)
 *  and the host-side anti-cheat gate in the network handler — keeping them
 *  in lockstep is what prevents a peer from bypassing a future placement
 *  rule that's added in only one place. */
export function isCannonPlacementLegal(
  player: Player,
  row: number,
  col: number,
  mode: CannonMode,
  maxCannons: number,
  state: GameViewState & {
    readonly burningPits: readonly BurningPit[];
    readonly pendingCannonSlotCost: readonly number[];
  },
): boolean {
  // Lockstep guard: include scheduled-but-not-yet-drained slot cost so the
  // originator's AI doesn't plan past `maxCannons` during the SAFETY
  // window between schedule and apply. See `state.pendingCannonSlotCost`.
  const pendingCost = state.pendingCannonSlotCost[player.id] ?? 0;
  if (
    cannonSlotsUsed(player) +
      pendingCost +
      effectivePlacementCost(player, mode) >
    maxCannons
  )
    return false;
  return canPlaceCannon(player, row, col, mode, state);
}

/** Prepare state for cannon phase: compute limits, recompute default facings
 *  (enemy territory may have changed since last cannon phase), and flush the
 *  new facings to existing cannons.
 *  Does NOT init controllers — call prepareControllerCannonPhase separately. */
export function prepareCannonPhase(state: GameState): void {
  computeCannonLimitsForPhase(state);
  resetCannonFacings(state);
  state.timer = state.cannonPlaceTimer;
  state.pendingCannonSlotCost.fill(0);
}

/**
 * Reset cannon facings to point toward the average enemy position.
 * Convenience wrapper: computes defaultFacing + applies to all cannons.
 * Call at the start of the build phase and in online checkpoints.
 */
export function resetCannonFacings(state: GameViewState): void {
  computeDefaultFacings(state);
  applyDefaultFacings(state);
}

/** Compute cannon-phase init data for a single player.
 *  Pure computation — no controller interaction.
 *  Used by both host (startCannonPhase loop) and watcher (handleCannonStartTransition).
 *  PRECONDITION: phase must already be CANNON_PLACE (set by enterCannonPlacePhase).
 *  Returns null for eliminated players (no init needed). */
export function prepareControllerCannonPhase(
  playerId: ValidPlayerSlot,
  state: GameState,
): { maxSlots: number; cursorPos: { row: number; col: number } } | null {
  if (state.phase !== Phase.CANNON_PLACE) {
    throw new Error(
      `prepareControllerCannonPhase called in ${Phase[state.phase]} — must be CANNON_PLACE`,
    );
  }
  const player = state.players[playerId];
  if (!player || isPlayerEliminated(player)) return null;
  const maxSlots = state.cannonLimits[player.id] ?? 0;
  let cursorPos = {
    row: player.homeTower?.row ?? 0,
    col: player.homeTower?.col ?? 0,
  };
  if (player.homeTower) {
    const snapped = findNearestValidCannonPlacement(
      player,
      player.homeTower.row,
      player.homeTower.col,
      CannonMode.NORMAL,
      state,
    );
    if (snapped) cursorPos = snapped;
  }
  return { maxSlots, cursorPos };
}

/** Return a player's alive cannons that can fire (excludes balloons and dead cannons). */
export function filterActiveFiringCannons(player: Player): Cannon[] {
  return player.cannons.filter(
    (c) => isCannonAlive(c) && !isBalloonCannon(c) && !isRampartCannon(c),
  );
}

/** BFS from home tower tiles through interior + owned tower tiles.
 *  Returns the set of tile keys in the connected enclosed region.
 *  Exported so the upgrade-system dispatcher can inject it into
 *  per-upgrade battle-start hooks (e.g. shield-battery). */
export function homeEnclosedRegion(player: Player): Set<number> {
  assertInteriorFresh(player);
  const interior = getInterior(player);
  // Build traversable set: interior tiles + all owned tower tiles
  const traversable = new Set(interior);
  for (const tower of player.ownedTowers) {
    for (let dr = 0; dr < TOWER_SIZE; dr++) {
      for (let dc = 0; dc < TOWER_SIZE; dc++) {
        traversable.add(packTile(tower.row + dr, tower.col + dc));
      }
    }
  }
  // Seed BFS from home tower tiles
  const home = player.homeTower!;
  const visited = new Set<number>();
  const queue: number[] = [];
  for (let dr = 0; dr < TOWER_SIZE; dr++) {
    for (let dc = 0; dc < TOWER_SIZE; dc++) {
      const key = packTile(home.row + dr, home.col + dc);
      if (traversable.has(key)) {
        visited.add(key);
        queue.push(key);
      }
    }
  }
  // Flood through traversable tiles using 4-dir connectivity
  while (queue.length > 0) {
    const key = queue.pop()!;
    const { r, c } = unpackTile(key);
    for (const [dr, dc] of DIRS_4) {
      const neighborKey = packTile(r + dr, c + dc);
      if (!visited.has(neighborKey) && traversable.has(neighborKey)) {
        visited.add(neighborKey);
        queue.push(neighborKey);
      }
    }
  }
  return visited;
}

/** Effective slot cost for placing a cannon, accounting for Rapid Emplacement discount. */
export function effectivePlacementCost(
  player: Player,
  mode: CannonMode,
): number {
  return Math.max(1, cannonSlotCost(mode) - rapidEmplacementDiscount(player));
}

/** Apply cannon placement (no validation). Internal helper — external
 *  callers go through `placeCannon` (synchronous + bus event) or
 *  `applyCannonAtDrain` (scheduled drain + post-place upgrade hooks). */
function applyCannonPlacement(
  player: Player,
  row: number,
  col: number,
  mode: CannonMode,
  state: { readonly cannonMaxHp: number },
): void {
  if (isPlayerEliminated(player)) return;
  player.cannons.push({
    row,
    col,
    hp: state.cannonMaxHp,
    mode,
    facing: player.defaultFacing,
    shieldHp: mode === CannonMode.RAMPART ? RAMPART_SHIELD_HP : undefined,
  });
}

/** Find the first legal cannon placement in interior-iteration order, or
 *  null if no valid position exists. Used internally by
 *  hasAnyCannonPlacement; promote to a barrel export when an external
 *  caller (test or AI) needs it. */
function findFirstLegalCannonPlacement(
  player: Player,
  mode: CannonMode,
  state: GameViewState & { readonly burningPits: readonly BurningPit[] },
): TilePos | null {
  const interior = getInterior(player);
  for (const key of interior) {
    const { r, c } = unpackTile(key);
    if (canPlaceCannon(player, r, c, mode, state)) return { row: r, col: c };
  }
  return null;
}

/** Collect every legal cannon placement in interior-iteration order.
 *  Used internally by autoPlaceRound1Cannons; promote to a barrel export
 *  when an external caller (test or AI) needs it. Order matches
 *  getInterior() iteration order, which is deterministic for a given
 *  wall set. */
function findLegalCannonPlacements(
  player: Player,
  mode: CannonMode,
  state: GameViewState & { readonly burningPits: readonly BurningPit[] },
): TilePos[] {
  const interior = getInterior(player);
  const candidates: TilePos[] = [];
  for (const key of interior) {
    const { r, c } = unpackTile(key);
    if (canPlaceCannon(player, r, c, mode, state)) {
      candidates.push({ row: r, col: c });
    }
  }
  return candidates;
}

/** Apply each player's defaultFacing to all their existing cannons.
 *  Private — callers should use `resetCannonFacings` (recompute + apply)
 *  or `prepareCannonPhase` (which calls resetCannonFacings internally). */
function applyDefaultFacings(state: GameViewState): void {
  for (const player of state.players) {
    if (!isPlayerSeated(player)) continue;
    for (const cannon of player.cannons) {
      cannon.facing = player.defaultFacing;
    }
  }
}

/** Compute cannon limits for the upcoming cannon phase, store in state, and drain the fresh-castle marker. */
function computeCannonLimitsForPhase(state: GameState): void {
  state.cannonLimits = state.players.map((player, idx) => {
    const base = cannonSlotsForRound(player, state);
    const salvage = state.salvageSlots[idx] ?? 0;
    return base + cannonSlotsBonus(player) + salvage;
  });
  state.salvageSlots = state.players.map(() => 0);
  state.freshCastlePlayers.clear();
}

/**
 * Find the nearest valid cannon placement within CANNON_SNAP_RADIUS tiles of (row, col).
 * Returns the snapped position, or undefined if nothing valid is nearby.
 */
function findNearestValidCannonPlacement(
  player: Player,
  row: number,
  col: number,
  mode: CannonMode,
  state: GameViewState & { readonly burningPits: readonly BurningPit[] },
): { row: number; col: number } | undefined {
  // Check origin first — if valid, no snapping needed
  if (canPlaceCannon(player, row, col, mode, state)) {
    return { row, col };
  }
  let bestDist = Infinity;
  let best: { row: number; col: number } | undefined;
  for (let dr = -CANNON_SNAP_RADIUS; dr <= CANNON_SNAP_RADIUS; dr++) {
    for (let dc = -CANNON_SNAP_RADIUS; dc <= CANNON_SNAP_RADIUS; dc++) {
      if (dr === 0 && dc === 0) continue;
      const dist = dr * dr + dc * dc;
      if (dist >= bestDist) continue;
      if (canPlaceCannon(player, row + dr, col + dc, mode, state)) {
        bestDist = dist;
        best = { row: row + dr, col: col + dc };
      }
    }
  }
  return best;
}

/** Validate cannon placement on the grid.
 *  Checks: interior (enclosed territory), walls, owned towers (not ALL), cannons, burning pits.
 *  Does NOT check grass or playerZone — cannon placement requires enclosed territory.
 *  Contrast with canPlacePieceOffsets() in build-system.ts which checks grass + zone + all towers.
 *
 *  All tiles must be interior, not a wall, not a tower, not an existing cannon.
 *  PRECONDITION: player.interior must be freshly computed (via recheckTerritory)
 *  after any wall mutation. Stale interior is caught at runtime by
 *  assertInteriorFresh() inside isCannonEnclosed() — see cannon-system.ts:52. */
export function canPlaceCannon(
  player: Player,
  row: number,
  col: number,
  mode: CannonMode,
  state: GameViewState & { readonly burningPits: readonly BurningPit[] },
): boolean {
  const interior = getInterior(player);
  const size = cannonSize(mode);
  // Cannon footprints are square: cannonSize() returns width=height (1 for normal, 2 for balloon/super).
  for (let dr = 0; dr < size; dr++) {
    for (let dc = 0; dc < size; dc++) {
      const r = row + dr;
      const c = col + dc;
      if (!inBounds(r, c)) return false;
      const key = packTile(r, c);
      if (!interior.has(key)) return false;
      if (isWater(state.map.tiles, r, c)) return false;
      if (hasWallAt(state, r, c)) return false;
      if (overlapsOwnedTower(player.ownedTowers, r, c)) return false;
      if (overlapsExistingCannon(player.cannons, r, c)) return false;
      if (hasPitAt(state.burningPits, r, c)) return false;
    }
  }
  return true;
}

/**
 * Compute the total cannon slot limit for a player this round.
 * Two paths: fresh-castle (firstRoundCannons + 1 per lost life, capped) for
 * any player who built a fresh castle this round — covers both round-1
 * auto-build (lives === STARTING_LIVES, so the formula collapses to
 * firstRoundCannons) and mid-game reselect; or normal (tower-based: 2 for
 * home + 1 per other) for steady-state rounds.
 */
function cannonSlotsForRound(
  player: Player,
  state: {
    readonly freshCastlePlayers: ReadonlySet<number>;
    readonly firstRoundCannons: number;
    readonly towerAlive: readonly boolean[];
  },
): number {
  const existingSlots = cannonSlotsUsed(player);
  let newSlots: number;
  if (state.freshCastlePlayers.has(player.id)) {
    // Fresh castle: compensate for lost lives (zero in round 1), capped at MAX_CANNON_LIMIT_ON_RESELECT
    newSlots = Math.min(
      state.firstRoundCannons + (STARTING_LIVES - player.lives),
      MAX_CANNON_LIMIT_ON_RESELECT,
    );
  } else {
    const aliveTowers = filterAliveOwnedTowers(player, state);
    const ownsHome =
      player.homeTower &&
      aliveTowers.some((tower) => tower === player.homeTower);
    const otherCount = aliveTowers.length - (ownsHome ? 1 : 0);
    newSlots = (ownsHome ? 2 : 0) + otherCount;
  }
  return existingSlots + newSlots;
}

/** Count how many cannon slots are used by a player. Normal = 1, super = SUPER_GUN_COST, balloon = BALLOON_COST. */
export function cannonSlotsUsed(player: Player): number {
  let slots = 0;
  for (const cannon of player.cannons) {
    if (!isCannonAlive(cannon)) continue;
    slots += cannonSlotCost(cannon.mode);
  }
  return slots;
}

export function cannonSlotCost(mode: CannonMode): number {
  return cannonModeDef(mode).slotCost;
}

/**
 * Compute each player's defaultFacing toward the average enemy position.
 * Does NOT update existing cannon facings — call resetCannonFacings or
 * applyDefaultFacings for that.  Separated so that new cannons placed by
 * AI controllers pick up the right defaultFacing before the banner
 * captures old cannon facings for the old-scene overlay.
 */
function computeDefaultFacings(state: GameViewState): void {
  for (const player of state.players) {
    if (!isPlayerSeated(player)) continue;
    const playerCenter = towerCenter(player.homeTower);
    let ex = 0,
      ey = 0,
      count = 0;
    for (const other of state.players) {
      if (other.id === player.id || !isPlayerSeated(other)) continue;
      const otherCenter = towerCenter(other.homeTower);
      ex += otherCenter.col;
      ey += otherCenter.row;
      count++;
    }
    if (count > 0) {
      const avgEx = ex / count;
      const avgEy = ey / count;
      const dx = avgEx - playerCenter.col;
      const dy = avgEy - playerCenter.row;
      player.defaultFacing = snapAngle(Math.atan2(dx, -dy), FACING_90_STEP);
    } else {
      player.defaultFacing = 0;
    }
  }
}

function overlapsExistingCannon(
  cannons: readonly Cannon[],
  row: number,
  col: number,
): boolean {
  return cannons.some((cannon) => isCannonTile(cannon, row, col));
}

function overlapsOwnedTower(
  ownedTowers: readonly Player["ownedTowers"][number][],
  row: number,
  col: number,
): boolean {
  return ownedTowers.some((tower) => isTowerTile(tower, row, col));
}
