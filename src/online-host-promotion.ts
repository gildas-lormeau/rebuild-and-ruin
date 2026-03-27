/**
 * Host promotion helpers — extracted from online-client.ts so each step
 * of promoteToHost() is a named, testable function.
 *
 * When adding new mutable state to the online system, check whether it
 * needs to be reset in resetNetworkingForHost() or handled in
 * skipPendingAnimations().
 */

import { createController } from "./controller-factory.ts";
import type { PlayerController } from "./controller-interfaces.ts";
import type { TimerAccums } from "./game-ui-types.ts";
import { BATTLE_TIMER, type GameState, Phase } from "./types.ts";

const SEED_ROUND_MULTIPLIER = 1000003;
const SEED_SLOT_MULTIPLIER = 0x9e3779b9;

/**
 * Replace non-self controllers with fresh AI and initialize them for
 * the current game phase. Called during host promotion.
 */
export function rebuildControllersForPhase(
  state: GameState,
  controllers: PlayerController[],
  myPlayerId: number,
): void {
  for (let i = 0; i < controllers.length; i++) {
    if (i === myPlayerId) continue;
    const player = state.players[i];
    if (!player || player.eliminated) continue;

    const strategySeed = (state.rng.seed + state.round * SEED_ROUND_MULTIPLIER + i * SEED_SLOT_MULTIPLIER) >>> 0;
    controllers[i] = createController(i, true, undefined, strategySeed);

    // Initialize AI for the current phase
    if (state.phase === Phase.WALL_BUILD) {
      controllers[i]!.startBuild(state);
    } else if (state.phase === Phase.CANNON_PLACE) {
      const max = state.cannonLimits[i] ?? 0;
      controllers[i]!.placeCannons(state, max);
      if (player.homeTower) {
        controllers[i]!.cannonCursor = { row: player.homeTower.row, col: player.homeTower.col };
      }
      controllers[i]!.onCannonPhaseStart(state);
    } else if (state.phase === Phase.BATTLE) {
      controllers[i]!.resetBattle(state);
    }
    // SELECTION, CASTLE_RESELECT — AI will be driven by selection system
  }
}

/**
 * Sync phase accumulators from the watcher's wall-clock timer.
 * The host uses accumulators (accum.X += dt) while watchers use
 * wall-clock subtraction (timer = max - elapsed). This converts
 * the watcher's remaining timer into the equivalent accumulator value.
 */
export function syncAccumulatorsFromTimer(state: GameState, accum: TimerAccums): void {
  accum.build = 0;
  accum.cannon = 0;
  accum.battle = 0;
  accum.grunt = 0;
  accum.select = 0;
  accum.selectAnnouncement = 0;

  if (state.phase === Phase.WALL_BUILD) {
    accum.build = state.buildTimer - state.timer;
  } else if (state.phase === Phase.CANNON_PLACE) {
    accum.cannon = state.cannonPlaceTimer - state.timer;
  } else if (state.phase === Phase.BATTLE) {
    accum.battle = BATTLE_TIMER - state.timer;
  }
}
