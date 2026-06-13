/** Phase timer accumulators — host tick elapsed-time bag.
 *  NEVER mutate directly; use advancePhaseTimer() to keep state.timer in sync. */

/** Naming convention:
 *    - One key per distinct timer: accum.cannon, accum.battle, accum.build, accum.select
 *    - Separate concerns get their own key: accum.grunt (grunt-movement interval, WALL_BUILD only),
 *      accum.selectAnnouncement (UI countdown separate from selection timer)
 *    - All keys are reset to 0 via createTimerAccums() at game start / rematch. */

export interface TimerAccums {
  readonly battle: number;
  readonly cannon: number;
  readonly select: number;
  readonly selectAnnouncement: number;
  readonly build: number;
  readonly grunt: number;
  readonly modifierReveal: number;
}

/** Mutable view of TimerAccums — use ONLY inside blessed mutation sites:
 *  - advancePhaseTimer() / tickGruntsIfDue() in tick-context.ts
 *  - tickSelection() / enterTowerSelection() in selection.ts
 *  - syncAccumulatorsFromTimer() in online-host-promotion.ts, called on
 *    every FULL_STATE apply (host promotion, watcher restore, rehydrate)
 *  - resetAccum() below — phase-boundary resets in runtime sub-systems
 *  Everywhere else, pass TimerAccums (readonly) to prevent accidental mutation. */
export type MutableAccums = { -readonly [K in keyof TimerAccums]: number };

/** Timer accumulator key constants. */
export const ACCUM_BATTLE = "battle" satisfies keyof TimerAccums;
export const ACCUM_CANNON = "cannon" satisfies keyof TimerAccums;
export const ACCUM_GRUNT = "grunt" satisfies keyof TimerAccums;
export const ACCUM_BUILD = "build" satisfies keyof TimerAccums;
export const ACCUM_SELECT = "select" satisfies keyof TimerAccums;
export const ACCUM_MODIFIER_REVEAL =
  "modifierReveal" satisfies keyof TimerAccums;

export function createTimerAccums(): TimerAccums {
  return {
    battle: 0,
    cannon: 0,
    select: 0,
    selectAnnouncement: 0,
    build: 0,
    grunt: 0,
    modifierReveal: 0,
  };
}

/** Reset a single accumulator to 0. Encapsulates the MutableAccums cast
 *  so callers don't need to import MutableAccums or write the cast inline. */
export function resetAccum(accum: TimerAccums, key: keyof TimerAccums): void {
  (accum as MutableAccums)[key] = 0;
}
