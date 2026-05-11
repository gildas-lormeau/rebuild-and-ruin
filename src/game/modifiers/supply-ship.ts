/**
 * Supply Ship modifier — 3 neutral cargo ships sail the Y-river during
 * battle. Spawn at battle start (one per `map.exits`), tick toward
 * `map.junction`, auto-sink on arrival. Cleared at battle end. Hit
 * detection + bonus award land in a follow-up commit.
 */

import type {
  SupplyBonusId,
  SupplyShip,
} from "../../shared/core/modifier-defs.ts";
import type { GameState } from "../../shared/core/types.ts";
import type { ModifierImpl } from "./modifier-types.ts";

/** Three ships per battle — one per Y-river arm (map.exits has 3 entries). */
const SUPPLY_SHIP_COUNT = 3;
/** HP at spawn. First hit reveals damage; second hit triggers sink. */
const SUPPLY_SHIP_HP = 2;
/** Speed in tiles per second. Calibrated so a ship traverses arm-mouth
 *  → junction in roughly the BATTLE_TIMER window (10s on a ~15-tile
 *  arm). Tuned to land at junction just before battle end if untouched. */
const SUPPLY_SHIP_SPEED = 1.8;
/** Sink animation duration in seconds — drives `sinking.progress` from
 *  0 → 1. Matches the renderer's tilt-then-descend window. */
const SUPPLY_SHIP_SINK_DURATION = 1.2;
/** Distance threshold (tiles) for "arrived at junction" detection. */
const JUNCTION_ARRIVAL_RADIUS = 1.0;
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
 *  each frame; cheap early-out when no ships are active. */
export function tickSupplyShips(state: GameState, dt: number): void {
  const ships = state.modern?.supplyShips;
  if (!ships || ships.length === 0) return;

  const junctionCol = state.map.junction.x;
  const junctionRow = state.map.junction.y;

  for (let i = ships.length - 1; i >= 0; i--) {
    const ship = ships[i]!;

    if (ship.sinking) {
      ship.sinking.progress += dt / SUPPLY_SHIP_SINK_DURATION;
      if (ship.sinking.progress >= 1) ships.splice(i, 1);
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

function applySupplyShip(state: GameState): readonly number[] {
  const { exits, junction } = state.map;
  const ships: SupplyShip[] = [];
  const armCount = Math.min(SUPPLY_SHIP_COUNT, exits.length);
  for (let armIndex = 0; armIndex < armCount; armIndex++) {
    const exit = exits[armIndex]!;
    const bonus = BONUS_POOL[state.rng.int(0, BONUS_POOL.length - 1)]!;
    ships.push({
      id: armIndex,
      spawnArm: armIndex as 0 | 1 | 2,
      position: { col: exit.x, row: exit.y },
      headingRad: Math.atan2(junction.y - exit.y, junction.x - exit.x),
      hp: SUPPLY_SHIP_HP,
      bonus,
    });
  }
  if (state.modern) state.modern.supplyShips = ships;
  // Entity-layer modifier — no tile mutation to surface in the reveal banner.
  return [];
}
