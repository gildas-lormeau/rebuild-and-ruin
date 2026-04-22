import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { isPlayerAlive } from "../shared/core/player-types.ts";
import type { GameState } from "../shared/core/types.ts";

/** Reason a game-over fires — threaded into the phase machine's transition
 *  id so each path stays distinct in telemetry / tests / future divergence. */
export type GameOverReason = "last-player-standing" | "round-limit-reached";

/** Outcome of checking win conditions after a life-lost dialog resolves.
 *  `game-over` fires GAME_END and stops the match; `reselect` routes the
 *  continuing players to CASTLE_RESELECT; `continue` resumes normal play. */
type GameOutcome =
  | {
      kind: "game-over";
      winner: { id: ValidPlayerSlot };
      reason: GameOverReason;
    }
  | { kind: "reselect"; continuing: readonly ValidPlayerSlot[] }
  | { kind: "continue" };

/** Compute the post-life-lost game outcome.
 *
 *  Side effect: emits `GAME_EVENT.GAME_END` with the winner when the match
 *  is over. Routing (onGameOver / onReselect / onContinue) is the caller's
 *  responsibility — this function only decides what happens and fires the
 *  event. Win rules:
 *    - `last-player-standing`: 0 or 1 alive players remain.
 *    - `round-limit-reached`: current round exceeded `state.maxRounds`.
 *    - Otherwise: reselect if any players continue, else plain continue.
 *  Winner is picked by highest score when more than one candidate exists. */
export function computeGameOutcome(
  state: GameState,
  continuing: readonly ValidPlayerSlot[],
): GameOutcome {
  const alive = state.players.filter(isPlayerAlive);
  if (alive.length <= 1) {
    const winner =
      alive[0] ??
      state.players.reduce((best, player) =>
        player.score > best.score ? player : best,
      );
    emitGameEvent(state.bus, GAME_EVENT.GAME_END, {
      round: state.round,
      winner: winner.id,
    });
    return { kind: "game-over", winner, reason: "last-player-standing" };
  }

  if (state.round > state.maxRounds) {
    const winner = alive.reduce(
      (best, player) => (player.score > best.score ? player : best),
      alive[0]!,
    );
    emitGameEvent(state.bus, GAME_EVENT.GAME_END, {
      round: state.round,
      winner: winner.id,
    });
    return { kind: "game-over", winner, reason: "round-limit-reached" };
  }

  if (continuing.length > 0) {
    return { kind: "reselect", continuing };
  }

  return { kind: "continue" };
}
