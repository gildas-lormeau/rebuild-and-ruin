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
 *  Eligibility is binary — eliminated players (no lives left) cannot win
 *  while any non-eliminated player exists. Among alive candidates, **score
 *  is the only tiebreak**; how many lives each has remaining doesn't matter.
 *  No side effects: GAME_END is emitted by the caller at dispatch time so
 *  the event lands AFTER the score overlay, not at decision time. */
export function peekGameOverOutcome(state: GameState): GameOverOutcome | null {
  const alive = state.players.filter(isPlayerAlive);
  if (alive.length <= 1) {
    const winner = alive[0] ?? pickByScore(state.players)!;
    return { winner, reason: "last-player-standing" };
  }
  if (state.round >= state.maxRounds) {
    return {
      winner: pickByScore(alive)!,
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

/** Highest-score winner pick. Ties resolved by slot order (the reduce keeps
 *  `best` on equality). Caller is responsible for filtering candidates by
 *  eligibility (alive vs eliminated) — this helper does not look at lives.
 *  Returns null only on an empty list. */
function pickByScore(candidates: readonly Player[]): Player | null {
  if (candidates.length === 0) return null;
  return candidates.reduce(
    (best, player) => (player.score > best.score ? player : best),
    candidates[0]!,
  );
}
