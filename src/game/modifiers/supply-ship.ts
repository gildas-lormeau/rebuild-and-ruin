/**
 * Supply Ship modifier — 3 neutral cargo ships sail the Y-river during
 * battle. Spawn at battle start (one per `map.exits`), tick toward
 * `map.junction`, auto-sink on arrival. Cleared at battle end. Hit
 * detection + bonus award land in a follow-up commit.
 */

import { BATTLE_MESSAGE } from "../../shared/core/battle-events.ts";
import type { TilePos } from "../../shared/core/geometry-types.ts";
import type {
  SupplyBonusId,
  SupplyShip,
} from "../../shared/core/modifier-defs.ts";
import type { ValidPlayerSlot } from "../../shared/core/player-slot.ts";
import type { GameState } from "../../shared/core/types.ts";
import type { ModifierImpl } from "./modifier-types.ts";

/** Three ships per battle — one per Y-river arm (map.exits has 3 entries). */
const SUPPLY_SHIP_COUNT = 3;
/** HP at spawn. First hit reveals damage; second hit triggers sink. */
const SUPPLY_SHIP_HP = 2;
/** Speed in tiles per second. Tuned slow enough that a ship cannot
 *  auto-sink at the junction during a normal 10s battle (a ship
 *  covers ~9 tiles, minimum arm length ≈ 13 tiles after the spawn
 *  inset). Ships that aren't hit are swept off by the battle-end
 *  banner — the auto-sink at junction is a safety net for outlier
 *  battles only. */
const SUPPLY_SHIP_SPEED = 0.9;
/** Distance (tiles) along the heading direction to inset the spawn
 *  position from the river-mouth `exit`. The exits are 1 tile outside
 *  the grid (`exit.y = -1` for top edges, etc.); inset 3 tiles inward
 *  along heading so the entire 1×2 hull is on-screen the moment the
 *  modifier-reveal banner captures the post-apply scene snapshot. */
const SUPPLY_SHIP_SPAWN_INSET = 3;
/** Sink animation duration in seconds — drives `sinking.progress` from
 *  0 → 1. Matches the renderer's tilt-then-descend window. */
const SUPPLY_SHIP_SINK_DURATION = 1.2;
/** Distance threshold (tiles) for "arrived at junction" detection. */
const JUNCTION_ARRIVAL_RADIUS = 1.0;
/** Distance threshold (tiles) for a cannonball impact to count as a ship
 *  hit. Generous (~1 tile) so leading a moving target feels rewarding
 *  rather than punishing. Tuned with playtest. */
const HIT_RADIUS = 1.0;
/** Seconds added to WALL_BUILD timer per consumed `extra_build_time`
 *  bonus. Matches Master Builder's `MASTER_BUILDER_BONUS_SECONDS` so
 *  the player intuition of "+5s build" is consistent across sources. */
const EXTRA_BUILD_TIME_SECONDS = 5;
/** One-round bonus pool. Each ship rolls one at spawn (hidden until
 *  sunk). Bonus application lands in the follow-up collision commit. */
const BONUS_POOL: readonly SupplyBonusId[] = [
  "extra_cannon",
  "extra_build_time",
  "mortar_shot",
  "small_pieces_bias",
];
export const supplyShipImpl: ModifierImpl = {
  lifecycle: "instant",
  apply: (state: GameState) => ({
    changedTiles: applySupplyShip(state),
    gruntsSpawned: 0,
  }),
  clear: (state: GameState) => {
    if (state.modern) state.modern.supplyShips = null;
  },
  // Ships are entity-layer; no tile or wall mutation.
  skipsRecheck: true,
};

/** Advance ship positions during battle. Called from `tickBattlePhase`
 *  each frame; cheap early-out when no ships are active. Pushes one
 *  `TilePos` to `impactsOut` per ship reaching sink-completion (sinking
 *  progress crossing ≥ 1) so the runtime's existing impact-splash
 *  pipeline renders the foam ring without a dedicated effect manager. */
export function tickSupplyShips(
  state: GameState,
  dt: number,
  impactsOut: TilePos[],
): void {
  const ships = state.modern?.supplyShips;
  if (!ships || ships.length === 0) return;

  const junctionCol = state.map.junction.x;
  const junctionRow = state.map.junction.y;

  for (let i = ships.length - 1; i >= 0; i--) {
    const ship = ships[i]!;

    if (ship.sinking) {
      ship.sinking.progress += dt / SUPPLY_SHIP_SINK_DURATION;
      if (ship.sinking.progress >= 1) {
        impactsOut.push({
          row: Math.round(ship.position.row),
          col: Math.round(ship.position.col),
        });
        ships.splice(i, 1);
      }
      continue;
    }

    ship.position.col += Math.cos(ship.headingRad) * SUPPLY_SHIP_SPEED * dt;
    ship.position.row += Math.sin(ship.headingRad) * SUPPLY_SHIP_SPEED * dt;

    const deltaCol = junctionCol - ship.position.col;
    const deltaRow = junctionRow - ship.position.row;
    if (
      deltaCol * deltaCol + deltaRow * deltaRow <=
      JUNCTION_ARRIVAL_RADIUS * JUNCTION_ARRIVAL_RADIUS
    ) {
      ship.sinking = { progress: 0 };
    }
  }
}

/** Register a cannonball hit on the supply ship nearest the impact tile,
 *  if any are within `HIT_RADIUS`. Sinking ships and ships at hp 0 are
 *  ignored (already done). Returns the hit outcome or null if no ship
 *  was in range. Called by `tickCannonballs` after each impact resolves.
 *
 *  Deterministic: positions and hp are mirror-simulated, so host and
 *  watcher reach the same hit/sink result without wire traffic. */
export function tryHitSupplyShip(
  state: GameState,
  impactCol: number,
  impactRow: number,
  shooterId: ValidPlayerSlot,
): void {
  const ships = state.modern?.supplyShips;
  if (!ships || ships.length === 0) return;

  let closestIndex = -1;
  let closestDistSq = HIT_RADIUS * HIT_RADIUS;
  for (let i = 0; i < ships.length; i++) {
    const ship = ships[i]!;
    if (ship.sinking || ship.hp <= 0) continue;
    const deltaCol = ship.position.col - impactCol;
    const deltaRow = ship.position.row - impactRow;
    const distSq = deltaCol * deltaCol + deltaRow * deltaRow;
    if (distSq <= closestDistSq) {
      closestDistSq = distSq;
      closestIndex = i;
    }
  }
  if (closestIndex < 0) return;

  const ship = ships[closestIndex]!;
  ship.hp -= 1;
  ship.lastHitterId = shooterId;
  state.bus.emit(BATTLE_MESSAGE.SHIP_HIT, {
    type: BATTLE_MESSAGE.SHIP_HIT,
    shipId: ship.id,
    shooterId,
    newHp: ship.hp,
  });
  if (ship.hp <= 0) {
    ship.sinking = { progress: 0 };
    queueSupplyBonus(state, shooterId, ship.bonus);
    state.bus.emit(BATTLE_MESSAGE.SHIP_SUNK, {
      type: BATTLE_MESSAGE.SHIP_SUNK,
      shipId: ship.id,
      shooterId,
    });
  }
}

/** Total seconds added to the WALL_BUILD timer this round from supply
 *  ship `extra_build_time` bonuses across all players. Each consumed
 *  bonus contributes `EXTRA_BUILD_TIME_SECONDS`. Called from
 *  `enterWallBuildPhase`. Drains the consumed entries. */
export function supplyShipBuildTimerBonus(state: GameState): number {
  const pending = state.modern?.pendingSupplyBonuses;
  if (!pending) return 0;
  let totalSeconds = 0;
  for (const playerId of [...pending.keys()]) {
    const consumed = consumeSupplyBonuses(state, playerId, "extra_build_time");
    totalSeconds += consumed * EXTRA_BUILD_TIME_SECONDS;
  }
  return totalSeconds;
}

/** Peek: does the player have at least one bonus of `type` queued?
 *  Used by fire paths to decide whether to elevate a normal cannon shot
 *  to a mortar shot WITHOUT consuming yet — the consume runs on every
 *  peer in `applyCannonFired` for cross-peer parity. */
export function hasSupplyBonus(
  state: GameState,
  playerId: ValidPlayerSlot,
  bonusType: SupplyBonusId,
): boolean {
  const queue = state.modern?.pendingSupplyBonuses?.get(playerId);
  return queue !== undefined && queue.includes(bonusType);
}

/** Consume exactly one bonus of `type` for `playerId` if any are queued.
 *  Returns true if a bonus was drained. Drives per-use consumables
 *  (e.g. mortar_shot) where each event consumes one — contrast with
 *  `consumeSupplyBonuses` which drains all of a type at once. */
export function consumeOneSupplyBonus(
  state: GameState,
  playerId: ValidPlayerSlot,
  bonusType: SupplyBonusId,
): boolean {
  const pending = state.modern?.pendingSupplyBonuses;
  const queue = pending?.get(playerId);
  if (!queue) return false;
  const idx = queue.indexOf(bonusType);
  if (idx < 0) return false;
  queue.splice(idx, 1);
  if (queue.length === 0) pending!.delete(playerId);
  if (pending && pending.size === 0 && state.modern) {
    state.modern.pendingSupplyBonuses = null;
  }
  return true;
}

/** Consume all queued bonuses of `bonusType` for `playerId`, returning
 *  the count. Each call drains the matching entries; subsequent calls
 *  return 0 until new bonuses are queued. Used by phase-entry hooks
 *  (e.g. cannon-limit computation) to materialize one-round effects. */
export function consumeSupplyBonuses(
  state: GameState,
  playerId: ValidPlayerSlot,
  bonusType: SupplyBonusId,
): number {
  const pending = state.modern?.pendingSupplyBonuses;
  if (!pending) return 0;
  const queue = pending.get(playerId);
  if (!queue) return 0;
  let count = 0;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i] === bonusType) {
      count += 1;
      queue.splice(i, 1);
    }
  }
  if (queue.length === 0) pending.delete(playerId);
  if (pending.size === 0 && state.modern)
    state.modern.pendingSupplyBonuses = null;
  return count;
}

function queueSupplyBonus(
  state: GameState,
  playerId: ValidPlayerSlot,
  bonus: SupplyBonusId,
): void {
  if (!state.modern) return;
  if (!state.modern.pendingSupplyBonuses) {
    state.modern.pendingSupplyBonuses = new Map();
  }
  const queue = state.modern.pendingSupplyBonuses.get(playerId) ?? [];
  queue.push(bonus);
  state.modern.pendingSupplyBonuses.set(playerId, queue);
}

function applySupplyShip(state: GameState): readonly number[] {
  const { exits, junction } = state.map;
  const ships: SupplyShip[] = [];
  const armCount = Math.min(SUPPLY_SHIP_COUNT, exits.length);
  for (let armIndex = 0; armIndex < armCount; armIndex++) {
    const exit = exits[armIndex]!;
    const bonus = BONUS_POOL[state.rng.int(0, BONUS_POOL.length - 1)]!;
    const headingRad = Math.atan2(junction.y - exit.y, junction.x - exit.x);
    ships.push({
      id: armIndex,
      spawnArm: armIndex as 0 | 1 | 2,
      position: {
        col: exit.x + Math.cos(headingRad) * SUPPLY_SHIP_SPAWN_INSET,
        row: exit.y + Math.sin(headingRad) * SUPPLY_SHIP_SPAWN_INSET,
      },
      headingRad,
      hp: SUPPLY_SHIP_HP,
      bonus,
    });
  }
  if (state.modern) state.modern.supplyShips = ships;
  // Entity-layer modifier — no tile mutation to surface in the reveal banner.
  return [];
}
