/**
 * Player rule-field write surface — the sole authority that writes the
 * game-owned `Player` fields (`lives`, `eliminated`, `score`), which are
 * `readonly` + branded. The only branded-value mints are the private
 * `brand*` fns below, so every write flows through a producer here. Consumed
 * by `game/` (live play) + `online/` (checkpoint restore) only; the brand
 * *types* stay with the struct in `player-types.ts` (read vocabulary).
 */

import { STARTING_LIVES } from "./game-constants.ts";
import type { Eliminated, Lives, Player, Score } from "./player-types.ts";

/** Writable view of the game-owned Player rule fields. The producers below
 *  cast through it to perform the one blessed write — mirrors `MutableAccums`
 *  for the timer accumulators. Nothing else may mutate these fields. */
type WritableRuleFields = {
  -readonly [K in "lives" | "eliminated" | "score"]: Player[K];
};

/** Decrement a player's lives by one (failed to enclose any tower this round).
 *  The sole in-game producer of a reduced `Lives` value. */
export function loseLife(player: Player): void {
  (player as WritableRuleFields).lives = brandLives(player.lives - 1);
}

/** Mark a player as eliminated (lives = 0, eliminated = true). */
export function eliminatePlayer(player: Player): void {
  const writable = player as WritableRuleFields;
  writable.eliminated = brandEliminated(true);
  writable.lives = brandLives(0);
}

/** Starting lives for a freshly created player. Creation-time producer —
 *  keeps the `STARTING_LIVES` knowledge next to the `Lives` type, mirroring
 *  `emptyFreshInterior()` for the interior brand. */
export function initialLives(): Lives {
  return brandLives(STARTING_LIVES);
}

/** The not-yet-eliminated flag for a freshly created player. Creation-time
 *  producer — mirrors `initialLives()`. */
export function notEliminated(): Eliminated {
  return brandEliminated(false);
}

/** Restore a player's lives from trusted checkpoint data (post-construction
 *  write at the deserialize boundary — the field is `readonly`, so even a
 *  branded value can't be assigned inline). Takes a plain number so
 *  `shared/core` stays free of protocol wire shapes. */
export function restoreLives(player: Player, value: number): void {
  (player as WritableRuleFields).lives = brandLives(value);
}

/** Restore a player's eliminated flag from trusted checkpoint data. */
export function restoreEliminated(player: Player, value: boolean): void {
  (player as WritableRuleFields).eliminated = brandEliminated(value);
}

/** Add territory points to a player's score. The sole in-game producer of an
 *  increased `Score` (every scoring site is additive). */
export function addScore(player: Player, points: number): void {
  (player as WritableRuleFields).score = brandScore(player.score + points);
}

/** Starting score for a freshly created player (0). Creation-time producer —
 *  mirrors `initialLives()`. */
export function initialScore(): Score {
  return brandScore(0);
}

/** Restore a player's score from trusted checkpoint data. */
export function restoreScore(player: Player, value: number): void {
  (player as WritableRuleFields).score = brandScore(value);
}

/** Mint a `Lives` — module-private; all field writes go through the producers
 *  above (the field is `readonly`, so a minted value can't be assigned
 *  except via the blessed `WritableRuleFields` cast). */
function brandLives(value: number): Lives {
  return value as Lives;
}

/** Mint an `Eliminated` — module-private (see `brandLives`). */
function brandEliminated(value: boolean): Eliminated {
  return value as Eliminated;
}

/** Mint a `Score` — module-private (see `brandLives`). */
function brandScore(value: number): Score {
  return value as Score;
}
