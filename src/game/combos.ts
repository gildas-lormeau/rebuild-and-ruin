import { BATTLE_TIMER } from "../shared/core/game-constants.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type { GameState, ModernState } from "../shared/core/types.ts";

/** Inferred from ModernState.comboTracker — defined inline in types.ts to avoid circular deps. */
type ComboTracker = NonNullable<ModernState["comboTracker"]>;

type ComboPlayerState = ComboTracker["players"][number];

/** Combo impact kinds — used by battle-system callers. */
type ComboKind = "wall" | "cannon" | "grunt";

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
export const COMBO_WALL = "wall" as const;
export const COMBO_CANNON = "cannon" as const;
export const COMBO_GRUNT = "grunt" as const;

/** Called at end of battle to award demolition bonuses. Returns total bonus per player. */
export function comboDemolitionBonus(tracker: ComboTracker): number[] {
  return tracker.players.map((playerState) =>
    playerState.wallsDestroyedThisRound >= DEMOLITION_THRESHOLD
      ? DEMOLITION_BONUS
      : 0,
  );
}

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

/** Facade: score combo bonus for an impact event. Returns bonus points (0 in classic mode). */
export function scoreImpactCombo(
  state: GameState,
  kind: ComboKind,
  sid: ValidPlayerSlot | undefined,
): number {
  if (sid === undefined) return 0;
  const tracker = state.modern?.comboTracker;
  if (!tracker) return 0;
  const playerState = tracker.players[sid];
  if (!playerState) return 0;
  const battleTime = BATTLE_TIMER - state.timer;

  switch (kind) {
    case COMBO_WALL: {
      playerState.wallsDestroyedThisRound++;
      if (battleTime - playerState.lastWallHitTime <= STREAK_WINDOW) {
        playerState.wallStreak++;
      } else {
        playerState.wallStreak = 1;
      }
      playerState.lastWallHitTime = battleTime;
      if (playerState.wallStreak >= WALL_STREAK_MIN) {
        tracker.events.push({
          kind: COMBO_WALL,
          streak: playerState.wallStreak,
          bonus: WALL_STREAK_BONUS,
          age: 0,
          playerId: sid,
        });
        return WALL_STREAK_BONUS;
      }
      return 0;
    }
    case COMBO_CANNON: {
      tracker.events.push({
        kind: COMBO_CANNON,
        streak: 1,
        bonus: CANNON_KILL_BONUS,
        age: 0,
        playerId: sid,
      });
      return CANNON_KILL_BONUS;
    }
    case COMBO_GRUNT: {
      if (battleTime - playerState.lastGruntKillTime <= STREAK_WINDOW) {
        playerState.gruntStreak++;
      } else {
        playerState.gruntStreak = 1;
      }
      playerState.lastGruntKillTime = battleTime;
      if (playerState.gruntStreak >= GRUNT_STREAK_MIN) {
        tracker.events.push({
          kind: COMBO_GRUNT,
          streak: playerState.gruntStreak,
          bonus: GRUNT_STREAK_BONUS,
          age: 0,
          playerId: sid,
        });
        return GRUNT_STREAK_BONUS;
      }
      return 0;
    }
  }
}

/** Facade: age combo events by dt seconds. No-op in classic mode. */
export function tickComboTracking(state: GameState, dt: number): void {
  if (state.modern?.comboTracker) ageComboEvents(state.modern.comboTracker, dt);
}

/** Age combo events by dt seconds, remove expired ones (> 2s). */
function ageComboEvents(tracker: ComboTracker, dt: number): void {
  for (const event of tracker.events) event.age += dt;
  tracker.events = tracker.events.filter(
    (event) => event.age < COMBO_EVENT_LIFETIME,
  );
}
