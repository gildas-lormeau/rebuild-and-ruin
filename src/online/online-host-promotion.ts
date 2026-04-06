/**
 * Host promotion helpers — pure functions for controller rebuild and
 * accumulator sync during host migration.
 */

import { enterCannonPlacePhase } from "../game/game-engine.ts";
import { finalizeCastleConstruction } from "../game/phase-setup.ts";
import {
  BATTLE_TIMER,
  MASTER_BUILDER_BONUS_SECONDS,
} from "../shared/game-constants.ts";
import { Phase } from "../shared/game-phase.ts";
import type { PlayerSlotId, ValidPlayerSlot } from "../shared/player-slot.ts";
import { isPlayerAlive } from "../shared/player-types.ts";
import type { PlayerController } from "../shared/system-interfaces.ts";
import type { MutableAccums } from "../shared/tick-context.ts";
import type { GameState } from "../shared/types.ts";

/** Large prime for deriving per-round AI strategy seeds (ensures uncorrelated rounds). */
const SEED_ROUND_MULTIPLIER = 1000003;
/** Golden ratio hash constant (2^32 × φ⁻¹) for deriving per-slot AI strategy seeds. */
const SEED_SLOT_MULTIPLIER = 0x9e3779b9;

/**
 * Return a new controller array with non-self slots replaced by fresh AI
 * controllers initialized for the current game phase. Called during host promotion.
 */
export function rebuildControllersForPhase(
  state: GameState,
  controllers: readonly PlayerController[],
  myPlayerId: PlayerSlotId,
  createAiController: (
    id: ValidPlayerSlot,
    seed: number,
  ) => Promise<PlayerController>,
): Promise<PlayerController[]> {
  return Promise.all(
    controllers.map(async (existing, i) => {
      if (i === myPlayerId) return existing;
      const player = state.players[i];
      if (!isPlayerAlive(player)) return existing;

      const pid = i as ValidPlayerSlot;
      const strategySeed = deriveAiStrategySeed(
        state.rng.seed,
        state.round,
        pid,
      );
      const ctrl = await createAiController(pid, strategySeed);

      // Initialize AI for the current phase
      if (state.phase === Phase.WALL_BUILD) {
        ctrl.startBuildPhase(state);
      } else if (state.phase === Phase.CANNON_PLACE) {
        const max = state.cannonLimits[i] ?? 0;
        ctrl.placeCannons(state, max);
        if (player.homeTower) {
          ctrl.cannonCursor = {
            row: player.homeTower.row,
            col: player.homeTower.col,
          };
        }
        ctrl.startCannonPhase(state);
      } else if (state.phase === Phase.BATTLE) {
        ctrl.initBattleState(state);
      }
      // SELECTION, CASTLE_RESELECT — AI will be driven by selection system
      return ctrl;
    }),
  );
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
    const hasMB = (state.modern?.masterBuilderOwners?.size ?? 0) > 0;
    const buildMax =
      state.buildTimer + (hasMB ? MASTER_BUILDER_BONUS_SECONDS : 0);
    accum.build = buildMax - state.timer;
  } else if (state.phase === Phase.CANNON_PLACE) {
    accum.cannon = state.cannonPlaceTimer - state.timer;
  } else if (state.phase === Phase.BATTLE) {
    accum.battle = BATTLE_TIMER - state.timer;
  }
}

/** Derive a deterministic AI strategy seed from the base RNG seed, round, and player slot.
 *  Both multipliers must be used together — they ensure seeds are uncorrelated
 *  across rounds (large prime) and across slots (golden ratio hash). */
function deriveAiStrategySeed(
  baseSeed: number,
  round: number,
  slot: number,
): number {
  return (
    (baseSeed + round * SEED_ROUND_MULTIPLIER + slot * SEED_SLOT_MULTIPLIER) >>>
    0 // >>> 0 coerces to uint32 (consistent seed behavior across platforms)
  );
}
