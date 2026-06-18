/**
 * Player write-surface — the authority that mutates `Player` fields: the
 * game-owned branded scalars `lives` / `eliminated` / `score` (the only mints
 * are the private `brand*` producers below, so every write flows through one)
 * plus `homeTower` selection (`selectPlayerTower`). Consumed by `game/`,
 * `online/` (checkpoint restore), and `ai/` only; the brand *types* stay with
 * the struct in `player-types.ts`.
 */

import { STARTING_LIVES } from "../core/game-constants.ts";
import type { Tower } from "../core/geometry-types.ts";
import type { Eliminated, Lives, Player, Score } from "../core/player-types.ts";

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

/** Set a player's home tower. Called during selection phase when a player
 *  picks or changes their highlighted tower.
 *
 *  Deliberately does NOT touch `enclosedTowers` — that list is derived
 *  state, maintained by `updateEnclosedTowers` in build-system.ts via the
 *  territory flood-fill. Seeding it here would create a "ghost"
 *  enclosure at the moment of highlight (before any walls exist), which
 *  misleads consumers that treat `enclosedTowers` as "towers actually
 *  enclosed by my territory" — notably the SFX layer, which uses the
 *  list to decide whether a player deserves the fanfare. */
export function selectPlayerTower(player: Player, tower: Tower): void {
  player.homeTower = tower;
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
