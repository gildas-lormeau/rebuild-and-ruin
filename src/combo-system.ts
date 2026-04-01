/**
 * Combo scoring system — rewards skilled play during battle (modern mode only).
 *
 * Tracks per-player hit streaks within a time window and awards bonus score.
 * Transient state: lives only during battle, not serialized or checkpointed.
 */

import { GAME_MODE_MODERN } from "./game-constants.ts";
import type { GameState } from "./types.ts";

/** Inferred from GameState.comboTracker — defined inline in types.ts to avoid circular deps. */
type ComboTracker = NonNullable<GameState["comboTracker"]>;

type ComboPlayerState = ComboTracker["players"][number];

/** Time window (seconds) for consecutive hits to count as a streak. */
const STREAK_WINDOW = 1.5;
/** Minimum wall hits in a streak to trigger a wall combo. */
const WALL_STREAK_MIN = 3;
/** Bonus score per wall beyond the minimum in a streak. */
const WALL_STREAK_BONUS = 50;
/** Bonus score for destroying an enemy cannon. */
const CANNON_KILL_BONUS = 100;
/** Minimum grunt kills in a streak to trigger a grunt combo. */
const GRUNT_STREAK_MIN = 2;
/** Bonus score per grunt beyond the minimum in a streak. */
const GRUNT_STREAK_BONUS = 75;
/** Bonus for destroying 5+ walls in one battle round. */
const DEMOLITION_THRESHOLD = 5;
const DEMOLITION_BONUS = 150;

export function createComboTracker(playerCount: number): ComboTracker {
  const players: ComboPlayerState[] = [];
  for (let i = 0; i < playerCount; i++) {
    players.push({
      lastWallHitTime: -Infinity,
      wallStreak: 0,
      lastGruntKillTime: -Infinity,
      gruntStreak: 0,
      roundWalls: 0,
    });
  }
  return { players };
}

/** Process an impact event for combo tracking. Returns bonus score to add.
 *  `battleTime` is elapsed seconds since battle start (monotonic). */
export function comboOnWallDestroyed(
  tracker: ComboTracker,
  shooterId: number,
  battleTime: number,
): number {
  const ps = tracker.players[shooterId];
  if (!ps) return 0;

  ps.roundWalls++;

  // Check if within streak window
  if (battleTime - ps.lastWallHitTime <= STREAK_WINDOW) {
    ps.wallStreak++;
  } else {
    ps.wallStreak = 1;
  }
  ps.lastWallHitTime = battleTime;

  // Wall streak bonus
  if (ps.wallStreak >= WALL_STREAK_MIN) {
    return WALL_STREAK_BONUS;
  }
  return 0;
}

export function comboOnCannonKill(
  tracker: ComboTracker,
  shooterId: number,
): number {
  const ps = tracker.players[shooterId];
  if (!ps) return 0;
  return CANNON_KILL_BONUS;
}

export function comboOnGruntKill(
  tracker: ComboTracker,
  shooterId: number,
  battleTime: number,
): number {
  const ps = tracker.players[shooterId];
  if (!ps) return 0;

  if (battleTime - ps.lastGruntKillTime <= STREAK_WINDOW) {
    ps.gruntStreak++;
  } else {
    ps.gruntStreak = 1;
  }
  ps.lastGruntKillTime = battleTime;

  if (ps.gruntStreak >= GRUNT_STREAK_MIN) {
    return GRUNT_STREAK_BONUS;
  }
  return 0;
}

/** Called at end of battle to award demolition bonuses. Returns total bonus per player. */
export function comboDemolitionBonus(tracker: ComboTracker): number[] {
  return tracker.players.map((ps) =>
    ps.roundWalls >= DEMOLITION_THRESHOLD ? DEMOLITION_BONUS : 0,
  );
}

/** Check if combo scoring is active for this game. */
export function isCombosEnabled(state: GameState): boolean {
  return state.gameMode === GAME_MODE_MODERN;
}
