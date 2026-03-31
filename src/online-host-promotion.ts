/**
 * Host promotion helpers — pure functions for controller rebuild and
 * accumulator sync during host migration.
 */

import type { PlayerController } from "./controller-interfaces.ts";
import { BATTLE_TIMER } from "./game-constants.ts";
import { enterCannonPlacePhase } from "./game-engine.ts";
import { finalizeCastleConstruction } from "./phase-setup.ts";
import type { MutableAccums } from "./tick-context.ts";
import { type GameState, isPlayerAlive, Phase } from "./types.ts";

/** Large prime for deriving per-round AI strategy seeds (ensures uncorrelated rounds). */
const SEED_ROUND_MULTIPLIER = 1000003;
/** Golden ratio hash constant (2^32 × φ⁻¹) for deriving per-slot AI strategy seeds. */
const SEED_SLOT_MULTIPLIER = 0x9e3779b9;

/**
 * Replace non-self controllers with fresh AI and initialize them for
 * the current game phase. Called during host promotion.
 */
export function rebuildControllersForPhase(
  state: GameState,
  controllers: PlayerController[],
  myPlayerId: number,
  createAiController: (id: number, seed: number) => PlayerController,
): void {
  for (let i = 0; i < controllers.length; i++) {
    if (i === myPlayerId) continue;
    const player = state.players[i];
    if (!isPlayerAlive(player)) continue;

    const strategySeed =
      (state.rng.seed +
        state.round * SEED_ROUND_MULTIPLIER +
        i * SEED_SLOT_MULTIPLIER) >>>
      0;
    controllers[i] = createAiController(i, strategySeed);

    // Initialize AI for the current phase
    if (state.phase === Phase.WALL_BUILD) {
      controllers[i]!.startBuild(state);
    } else if (state.phase === Phase.CANNON_PLACE) {
      const max = state.cannonLimits[i] ?? 0;
      controllers[i]!.placeCannons(state, max);
      if (player.homeTower) {
        controllers[i]!.cannonCursor = {
          row: player.homeTower.row,
          col: player.homeTower.col,
        };
      }
      controllers[i]!.onCannonPhaseStart(state);
    } else if (state.phase === Phase.BATTLE) {
      controllers[i]!.initBattleState(state);
    }
    // SELECTION, CASTLE_RESELECT — AI will be driven by selection system
  }
}

/**
 * Fast-forward past the castle build animation during host promotion.
 * Finalizes construction and enters cannon placement so the new host
 * can immediately resume gameplay.
 */
export function skipCastleBuildAnimation(state: GameState): void {
  finalizeCastleConstruction(state);
  enterCannonPlacePhase(state);
}

/**
 * Sync accumulators from watcher's wall-clock timer after host promotion.
 *
 * Timer semantics differ by role:
 *   Host: uses accumulators (accum.X += dt each tick). Timer counts elapsed time.
 *   Watcher: uses wall-clock subtraction (timer = phaseDuration - elapsed). Timer counts remaining time.
 *
 * On promotion (watcher → host), this function converts the watcher's remaining-time timer
 * back into accumulator values so the new host can resume ticking correctly.
 */
export function syncAccumulatorsFromTimer(
  state: GameState,
  accum: MutableAccums,
): void {
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
