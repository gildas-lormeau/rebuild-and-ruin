/**
 * Host promotion helpers — pure functions for controller rebuild and
 * accumulator sync during host migration.
 */

import {
  buildTimerBonus,
  enterCannonPhase,
  finalizeCastleConstruction,
} from "../game/index.ts";
import type { MutableAccums } from "../runtime/timer-accums.ts";
import type { AiPersonality } from "../shared/core/ai-personality.ts";
import { deriveAiStrategySeed } from "../shared/core/ai-seed.ts";
import { BATTLE_TIMER } from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { PlayerId, ValidPlayerId } from "../shared/core/player-slot.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import type { PlayerController } from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import { Rng } from "../shared/platform/rng.ts";

/** AI dependencies injected by the caller — keeps this file free of any
 *  `controllers/` or `ai/` imports. The caller wires up the concrete
 *  implementations (typically from `controllers/controller-factory.ts`). */
interface AiPromotionDeps {
  /** Resolves once AI chunks are loaded. Called once before the per-slot loop
   *  so `rollPersonality` can run synchronously. */
  readonly ensureLoaded: () => Promise<void>;
  /** Sync personality roll (requires `ensureLoaded` to have resolved). */
  readonly rollPersonality: (rng: Rng, difficulty?: number) => AiPersonality;
  /** Construct an AI controller for the given slot. */
  readonly create: (
    id: ValidPlayerId,
    rng: Rng,
    personality: AiPersonality,
  ) => Promise<PlayerController>;
}

/**
 * Return a new controller array with non-self slots replaced by fresh AI
 * controllers initialized for the current game phase. Called during host promotion.
 */
export async function rebuildControllersForPhase(
  state: GameState,
  controllers: readonly PlayerController[],
  myPlayerId: PlayerId,
  aiDeps: AiPromotionDeps,
  difficulty: number | undefined,
): Promise<PlayerController[]> {
  // Pre-load AI modules so rollPersonality can run synchronously inside
  // the per-slot loop (matches the bootstrap path).
  await aiDeps.ensureLoaded();
  return Promise.all(
    controllers.map(async (existing, i) => {
      if (i === myPlayerId) return existing;
      const player = state.players[i];
      if (!player || isPlayerEliminated(player)) return existing;

      const pid = i as ValidPlayerId;
      const strategyRng = new Rng(
        deriveAiStrategySeed(state.rng.seed, state.round, pid),
      );
      // Roll personality from a separate, deterministic Rng. We must NOT
      // touch state.rng here — promotion-time construction runs only on
      // the new host, so any state.rng draw would drift the watcher's
      // canonical sequence.
      const personalityRng = new Rng(
        deriveAiStrategySeed(state.rng.seed ^ 1, state.round, pid),
      );
      const personality = aiDeps.rollPersonality(personalityRng, difficulty);
      const ctrl = await aiDeps.create(pid, strategyRng, personality);

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
