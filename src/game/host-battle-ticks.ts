/**
 * Host-side tick functions for the battle phase.
 *
 * Contains the pure tick logic (advanceBattleCountdown, collectBattleFrameEvents,
 * initBattleControllers, enterBuildSkippingBattle) consumed by
 * runtime-phase-ticks.ts.
 *
 * Network-agnostic: callers pre-filter controllers and provide optional
 * callbacks for event broadcasting. The game domain has zero knowledge of
 * host/watcher topology or remote human slots.
 */

import type {
  BattleEvent,
  CannonFiredMessage,
  ImpactEvent,
} from "../../server/protocol.ts";
import type { TilePos } from "../shared/geometry-types.ts";
import type {
  BattleController,
  ControllerIdentity,
} from "../shared/system-interfaces.ts";
import type { GameState } from "../shared/types.ts";
import {
  createCannonFiredMsg,
  getCountdownAnnouncement,
} from "./battle-system.ts";

type BattleCapable = ControllerIdentity & BattleController;

/** Result of a single battle frame's event collection.
 *  All state mutations (cannonball advancement, tower kills) have already
 *  been applied to `state` — the caller broadcasts events and renders. */
interface BattleFrameResult {
  fireEvents: readonly CannonFiredMessage[];
  towerEvents: readonly BattleEvent[];
  impactEvents: readonly ImpactEvent[];
  newImpacts: readonly TilePos[];
}

/** Decrement the battle countdown timer and return announcement text.
 *  Pure game logic — no rendering or crosshair sync. */
export function advanceBattleCountdown(
  state: GameState,
  dt: number,
): string | undefined {
  state.battleCountdown = Math.max(0, state.battleCountdown - dt);
  return getCountdownAnnouncement(state.battleCountdown);
}

/** Collect one frame of battle events. Pure game logic — mutates state
 *  (cannonball advancement, tower kills, wall impacts) but does NOT render,
 *  broadcast, or call callbacks.
 *
 *  Event collection order (load-bearing — do not reorder):
 *    1. Tick controllers → fire events (new cannonballs from battleTick)
 *    2. collectTowerEvents → tower kill/damage events
 *    3. tickCannonballsWithEvents → impact events (walls, cannons, houses, grunts)
 *  Steps 1→3 are sequential because each depends on state produced by the prior.
 *  Reordering silently corrupts event data. */
export function collectBattleFrameEvents(params: {
  state: GameState;
  dt: number;
  localControllers: readonly BattleCapable[];
  collectTowerEvents: (state: GameState, dt: number) => BattleEvent[];
  tickCannonballsWithEvents: (
    state: GameState,
    dt: number,
  ) => { impacts: TilePos[]; events: ImpactEvent[] };
}): BattleFrameResult {
  const {
    state,
    dt,
    localControllers,
    collectTowerEvents,
    tickCannonballsWithEvents,
  } = params;

  // Step 1: tick controllers → fire events (new cannonballs from battleTick)
  const ballsBefore = state.cannonballs.length;
  for (const ctrl of localControllers) {
    ctrl.battleTick(state, dt);
  }
  const fireEvents: CannonFiredMessage[] = [];
  for (let idx = ballsBefore; idx < state.cannonballs.length; idx++) {
    fireEvents.push(createCannonFiredMsg(state.cannonballs[idx]!));
  }

  // Step 2: tower kill/damage events
  const towerEvents = collectTowerEvents(state, dt);

  // Step 3: advance cannonballs → impact events
  const { impacts: newImpacts, events: impactEvents } =
    tickCannonballsWithEvents(state, dt);

  return { fireEvents, towerEvents, impactEvents, newImpacts };
}

/** Initialize battle state on all provided controllers.
 *  Pure game logic — no UI mode switches or timer setup. */
export function initBattleControllers(
  controllers: readonly BattleCapable[],
  state: GameState,
): void {
  for (const ctrl of controllers) {
    ctrl.initBattleState(state);
  }
}
