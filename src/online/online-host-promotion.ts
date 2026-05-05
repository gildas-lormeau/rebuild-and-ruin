/**
 * Host promotion helpers — pure functions for controller rebuild and
 * accumulator sync during host migration.
 */

import {
  buildTimerBonus,
  enterCannonPhase,
  finalizeCastleConstruction,
} from "../game/index.ts";
import type { MutableAccums } from "../runtime/runtime-tick-context.ts";
import { BATTLE_TIMER } from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type {
  PlayerSlotId,
  ValidPlayerSlot,
} from "../shared/core/player-slot.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import type { PlayerController } from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";

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
      if (!player || isPlayerEliminated(player)) return existing;

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
      // CASTLE_SELECT (initial or reselect cycle) — AI driven by selection system
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
  // finalizeCastleConstruction no longer flips the phase — enterCannonPhase
  // owns the CANNON_PLACE transition + preparation. Per-player init data
  // is ignored here; the new host rebuilds controllers separately via
  // rebuildControllersForPhase.
  enterCannonPhase(state);
}

/**
 * Rebuild per-phase accumulators from `state.timer` after a checkpoint
 * apply (FULL_STATE) or host promotion.
 *
 * Every peer ticks accumulators identically (`accum.X += dt`, with
 * `state.timer = max - accum.X` via `advancePhaseTimer`). When the
 * authoritative `state.timer` arrives via FULL_STATE — or when a peer
 * is promoted to host and starts authoring timer ticks — the local
 * accumulators may not match the new timer value, so we recompute them
 * from `state.timer` to preserve the `timer = max - elapsed` invariant.
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
    accum.build = state.buildTimer + buildTimerBonus(state) - state.timer;
  } else if (state.phase === Phase.CANNON_PLACE) {
    accum.cannon = state.cannonPlaceTimer - state.timer;
  } else if (state.phase === Phase.BATTLE) {
    accum.battle = BATTLE_TIMER - state.timer;
  }
}

/** Derive a deterministic AI strategy seed from the base RNG seed, round, and player slot.
 *  Both multipliers must be used together — they ensure seeds are uncorrelated
 *  across rounds (large prime) and across slots (golden ratio hash).
 *
 *  Contract vs. the initial-host path (runtime-bootstrap.ts):
 *    - Initial hosts pull AI seeds from state.rng.int() in player order,
 *      which advances state.rng before castle selection.
 *    - Promoted hosts derive seeds from (baseSeed, round, slot) without
 *      touching state.rng, because a promoted host doesn't know what the
 *      original host pulled at init time.
 *
 *  The two formulas are intentionally different. As a result, a promoted
 *  host's AI identity (personality, targeting rhythm, etc.) does NOT match
 *  what the previous host was running — it's effectively a new AI instance.
 *  This is acceptable because watchers replay events (not AI decisions), so
 *  parity is preserved within each "era". If identity preservation across
 *  promotion ever matters, checkpoint the strategy seeds into SerializedPlayer
 *  and restore them in rebuildControllersForPhase above. */
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
