/**
 * Combo scoring system — rewards skilled play during battle (modern mode only).
 *
 * Tracks per-player hit streaks within a time window and awards bonus score.
 * Transient state: lives only during battle, not serialized or checkpointed.
 */

import { GAME_MODE_MODERN, type ValidPlayerSlot } from "./game-constants.ts";
import type { GameState, ModernState } from "./types.ts";

/** Inferred from ModernState.comboTracker — defined inline in types.ts to avoid circular deps. */
type ComboTracker = NonNullable<ModernState["comboTracker"]>;

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
/** Lifetime of a combo floating text in seconds. */
const COMBO_EVENT_LIFETIME = 2;

export function createComboTracker(playerCount: number): ComboTracker {
  const players: ComboPlayerState[] = [];
  for (let i = 0; i < playerCount; i++) {
    players.push({
      lastWallHitTime: -Infinity,
      wallStreak: 0,
      lastGruntKillTime: -Infinity,
      gruntStreak: 0,
      wallsDestroyedThisRound: 0,
    });
  }
  return { players, events: [] };
}

/** Process an impact event for combo tracking. Returns bonus score to add.
 *  `battleTime` is elapsed seconds since battle start (monotonic). */
export function comboOnWallDestroyed(
  tracker: ComboTracker,
  shooterId: ValidPlayerSlot,
  battleTime: number,
): number {
  const ps = tracker.players[shooterId];
  if (!ps) return 0;

  ps.wallsDestroyedThisRound++;

  // Check if within streak window
  if (battleTime - ps.lastWallHitTime <= STREAK_WINDOW) {
    ps.wallStreak++;
  } else {
    ps.wallStreak = 1;
  }
  ps.lastWallHitTime = battleTime;

  // Wall streak bonus
  if (ps.wallStreak >= WALL_STREAK_MIN) {
    tracker.events.push({
      text: `Wall Streak x${ps.wallStreak}! +${WALL_STREAK_BONUS}`,
      age: 0,
      playerId: shooterId,
    });
    return WALL_STREAK_BONUS;
  }
  return 0;
}

export function comboOnCannonKill(
  tracker: ComboTracker,
  shooterId: ValidPlayerSlot,
): number {
  const ps = tracker.players[shooterId];
  if (!ps) return 0;
  tracker.events.push({
    text: `Cannon Kill! +${CANNON_KILL_BONUS}`,
    age: 0,
    playerId: shooterId,
  });
  return CANNON_KILL_BONUS;
}

export function comboOnGruntKill(
  tracker: ComboTracker,
  shooterId: ValidPlayerSlot,
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
    tracker.events.push({
      text: `Grunt Sniper x${ps.gruntStreak}! +${GRUNT_STREAK_BONUS}`,
      age: 0,
      playerId: shooterId,
    });
    return GRUNT_STREAK_BONUS;
  }
  return 0;
}

/** Called at end of battle to award demolition bonuses. Returns total bonus per player. */
export function comboDemolitionBonus(tracker: ComboTracker): number[] {
  return tracker.players.map((ps) =>
    ps.wallsDestroyedThisRound >= DEMOLITION_THRESHOLD ? DEMOLITION_BONUS : 0,
  );
}

/** Age combo events by dt seconds, remove expired ones (> 2s). */
export function ageComboEvents(tracker: ComboTracker, dt: number): void {
  for (const ev of tracker.events) ev.age += dt;
  tracker.events = tracker.events.filter((ev) => ev.age < COMBO_EVENT_LIFETIME);
}

/** Check if combo scoring is active for this game. */
export function isCombosEnabled(state: GameState): boolean {
  return state.gameMode === GAME_MODE_MODERN;
}
