import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import {
  isPlayerEliminated,
  type ValidPlayerId,
} from "../shared/core/player-slot.ts";
import { isPlayerAlive, type Player } from "../shared/core/player-types.ts";
import type { GameState } from "../shared/core/types.ts";
import { eliminatePlayer } from "../shared/sim/player-rules.ts";
import { evictGruntsTargetingZone } from "./grunt-movement.ts";

/** Reason a game-over fires. Carried on `GameOverOutcome` so the runtime
 *  can log which path ended the match; not consumed by game flow. */
type GameOverReason = "last-player-standing" | "round-limit-reached";

export interface GameOverOutcome {
  winner: { id: ValidPlayerId };
  reason: GameOverReason;
}

/** Pure peek: does the just-closed round trigger game-over?
 *
 *  Called twice per round-end against the CLOSING round (`advanceRound` is
 *  deferred to the continue branch of `routeLifeLostResolution`, so
 *  `state.round` is unchanged across both calls):
 *    1. in the round-end transition's mutate, AFTER `applyLifePenalties`
 *       and BEFORE the score / life-lost dialog displays — decides whether
 *       to suppress the (now-moot) interactive continue/abandon prompt.
 *    2. in that transition's postDisplay, AFTER the dialog resolves — the
 *       dialog's ABANDON/AFK choices can eliminate more players, newly
 *       creating a last-player-standing. Reusing the full peek here is safe
 *       precisely because the round hasn't advanced: the round-limit branch
 *       was already false in call 1 and the round is the same, so only the
 *       alive-count condition can flip.
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

/** Emit GAME_END for the decided winner. Called from the single game-over
 *  chokepoint (`finalizeGameOver` in game-lifecycle.ts) so EVERY peer emits it
 *  exactly once — the host + a non-preempted watcher reach it via their local
 *  game-over dispatch, a preempted watcher via the wire GAME_OVER handler. The
 *  event fires at dispatch time (after the score overlay), not at decision time.
 *  Takes just the winner (not the full GameOverOutcome) so the watcher's wire
 *  path — which has no locally-computed outcome/reason — can call it too. */
export function emitGameEnd(
  state: GameState,
  winner: { id: ValidPlayerId },
): void {
  emitGameEvent(state.bus, GAME_EVENT.GAME_END, {
    round: state.round,
    winner: winner.id,
  });
}

/** Eliminate the listed players and emit `PLAYER_ELIMINATED` for each.
 *  Skips missing/null player slots so callers can pass raw IDs from UI
 *  state without pre-filtering. Game rule — the runtime merely picks
 *  which players to eliminate (e.g. life-lost ABANDON choice).
 *
 *  Also evicts grunts still targeting the player's zone — the one cleanup
 *  delta vs the life-loss zone reset that already ran this round-end
 *  (`resetZoneState(ownerEliminated=false)` spares cross-zone targeters
 *  because a rebuilding owner is still a valid raid target), so an
 *  ABANDON elimination leaves the same world state as lives hitting zero. */
export function eliminatePlayers(
  state: GameState,
  playerIds: readonly ValidPlayerId[],
): void {
  for (const playerId of playerIds) {
    const player = state.players[playerId];
    if (!player) continue;
    // Already-eliminated players land here when the life-lost dialog
    // pre-resolves their entry to ABANDON (see life-lost-core.ts) — skip
    // so PLAYER_ELIMINATED doesn't re-fire for an elimination that already
    // emitted from `finalizeRound`.
    if (isPlayerEliminated(player)) continue;
    eliminatePlayer(player);
    emitGameEvent(state.bus, GAME_EVENT.PLAYER_ELIMINATED, {
      playerId: player.id,
      round: state.round,
    });
    const zone = state.playerZones[player.id];
    if (zone !== undefined) evictGruntsTargetingZone(state, zone);
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
