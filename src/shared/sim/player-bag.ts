/**
 * Player piece-bag lifecycle — create/advance/clear a player's build-phase
 * bag. Sim-tier: it drives `state.rng` via the bag generator and must run
 * symmetrically on every peer (see clearAllPlayerBags). The `bag`/`currentPiece`
 * fields live on the universal Player struct; this is the write surface over
 * them, kept out of shared/core so the struct module carries no sim logic.
 */

import type { Player } from "../core/player-types.ts";
import type { Rng } from "../platform/rng.ts";
import { createBag, nextPiece } from "./pieces.ts";

/** Create a new piece bag on a player and draw the first piece. */
export function initPlayerBag(
  player: Player,
  round: number,
  rng: Rng,
  smallPieces?: boolean,
): void {
  player.bag = createBag(round, rng, smallPieces);
  player.currentPiece = nextPiece(player.bag);
}

/** Advance the piece bag after a successful placement.
 *  @param _placed — must be literal `true` (compile-time guard ensuring
 *  callers advance only after verified placement, never speculatively). */
export function advancePlayerBag(player: Player, _placed: true): void {
  if (!player.bag) {
    throw new Error(
      `advancePlayerBag: player ${player.id} bag is null — late-arriving ` +
        `placement after clearAllPlayerBags. state.rng will drift cross-peer.`,
    );
  }
  player.currentPiece = nextPiece(player.bag);
}

/** Clear every player's piece bag at end-of-build (round-end transition).
 *  Must run on every peer at the same logical sim tick — bags live on
 *  GameState, so a per-local-controller clear would let late-arriving
 *  piece-place actions drain on one peer (advancing + potentially shuffling
 *  the bag, drawing `state.rng`) while no-op'ing on the other (bag null
 *  → `advancePlayerBag` returns early). That asymmetry drifts `state.rng`
 *  cross-peer; symmetric clear closes the window. */
export function clearAllPlayerBags(state: {
  players: readonly Player[];
}): void {
  for (const player of state.players) clearPlayerBag(player);
}

/** Clear the piece bag (end of build phase / life lost / reset).
 *  File-private — callers should use `clearAllPlayerBags` to clear every
 *  player's bag at the same logical sim tick (see its docstring). */
function clearPlayerBag(player: Player): void {
  player.bag = undefined;
  player.currentPiece = undefined;
}
