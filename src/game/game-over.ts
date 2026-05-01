import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import {
  eliminatePlayer,
  isPlayerAlive,
  type Player,
} from "../shared/core/player-types.ts";
import type { GameState } from "../shared/core/types.ts";

/** Reason a game-over fires — threaded into the phase machine's transition
 *  id so each path stays distinct in telemetry / tests / future divergence. */
export type GameOverReason = "last-player-standing" | "round-limit-reached";

export interface GameOverOutcome {
  winner: { id: ValidPlayerSlot };
  reason: GameOverReason;
}

/** Pure peek: does the just-closed round trigger game-over?
 *
 *  Called from the round-end transition's mutate, AFTER `applyLifePenalties`
 *  and BEFORE the score / life-lost dialog displays. `state.round` is still
 *  the closing round — the increment is deferred to the continue / reselect
 *  branch so this comparison sees the round that just ended.
 *
 *  Win rules:
 *    - `last-player-standing`: 0 or 1 alive players remain after life
 *      penalties.
 *    - `round-limit-reached`: closing round equals `state.maxRounds`
 *      (we just played the final scheduled round).
 *  Returns `null` when neither condition is met.
 *
 *  Winner is picked by **lives first, then score**. A player who lost a
 *  life this round (lives reduced but still > 0) is "alive" but ranks
 *  below players who didn't — so the score-only tiebreak no longer
 *  hands the win to a life-losing leader over an opponent who was untouched.
 *  No side effects: GAME_END is emitted by the caller at dispatch time
 *  so the event lands AFTER the score overlay, not at decision time. */
export function peekGameOverOutcome(state: GameState): GameOverOutcome | null {
  const alive = state.players.filter(isPlayerAlive);
  if (alive.length <= 1) {
    const winner = alive[0] ?? pickByLivesThenScore(state.players)!;
    return { winner, reason: "last-player-standing" };
  }
  if (state.round >= state.maxRounds) {
    return {
      winner: pickByLivesThenScore(alive)!,
      reason: "round-limit-reached",
    };
  }
  return null;
}

/** Emit GAME_END for an outcome decided earlier by `peekGameOverOutcome`.
 *  Split from the peek so the bus event fires at dispatch time (after the
 *  score overlay), not at decision time (during the round-end mutate). */
export function emitGameEnd(state: GameState, outcome: GameOverOutcome): void {
  emitGameEvent(state.bus, GAME_EVENT.GAME_END, {
    round: state.round,
    winner: outcome.winner.id,
  });
}

/** Eliminate the listed players and emit `PLAYER_ELIMINATED` for each.
 *  Skips missing/null player slots so callers can pass raw IDs from UI
 *  state without pre-filtering. Game rule — the runtime merely picks
 *  which players to eliminate (e.g. life-lost ABANDON choice). */
export function eliminatePlayers(
  state: GameState,
  playerIds: readonly ValidPlayerSlot[],
): void {
  for (const playerId of playerIds) {
    const player = state.players[playerId];
    if (!player) continue;
    eliminatePlayer(player);
    emitGameEvent(state.bus, GAME_EVENT.PLAYER_ELIMINATED, {
      playerId: player.id,
      round: state.round,
    });
  }
}

/** Lives-then-score winner pick. More lives wins; ties broken by score;
 *  remaining ties resolved by slot order (the reduce keeps `best` on
 *  equality). Returns null only on an empty list. */
function pickByLivesThenScore(candidates: readonly Player[]): Player | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((best, player) => {
    if (player.lives !== best.lives)
      return player.lives > best.lives ? player : best;
    return player.score > best.score ? player : best;
  }, candidates[0]!);
}
