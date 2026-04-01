/**
 * Shared types and utilities for phase/battle tick functions.
 *
 * Extracted from phase-ticks.ts so that battle-ticks.ts can import
 * without creating a peer dependency on phase-ticks.
 *
 * ### State mutation phases (applies across all game code)
 *
 * Game state is mutated in three distinct phases per frame. The order is
 * load-bearing — reordering causes silent correctness bugs.
 *
 * 1. **APPLY** (message handlers) — Incremental mutations from remote
 *    players. Guards ensure valid state transitions. Runs as messages
 *    arrive (may be zero or many per frame).
 *    Examples: applyPiecePlacement, applyImpactEvent, applyCannonPlacement.
 *
 * 2. **TICK** (main game loop) — Deterministic per-frame simulation:
 *    cannonball physics, grunt movement, battle timers, phase countdowns.
 *    Runs exactly once per frame.
 *    Examples: tickCannonballs, tickGrunts, advancePhaseTimer.
 *
 * 3. **CHECKPOINT** (phase transitions) — Full state reset from host
 *    checkpoint. Replaces entire subsystem state. Runs at most once per
 *    frame, only when the phase changes.
 *    Examples: applyBattleStartCheckpoint, applyBuildStartCheckpoint.
 *
 * Within a single frame: APPLY → TICK → CHECKPOINT (if phase change).
 *
 * Phase completion terminology (three distinct terms, NOT interchangeable):
 *   "done" — query: "is this phase finished?" (e.g. isCannonPhaseDone checks slots/timer)
 *   "finalize" — action: run end-of-phase cleanup and scoring (e.g. finalizeBuildPhase)
 *   "ended" — callback: signal that phase is over (e.g. onBattlePhaseEnded notifies tick system)
 * Use the term that matches the operation: query → done, cleanup → finalize, signal → ended.
 */

import type { ControllerIdentity } from "./controller-interfaces.ts";
import { GRUNT_TICK_INTERVAL } from "./game-constants.ts";
import type { GameState } from "./types.ts";

/** Base networking context shared by all phase ticks.
 *  VOLATILE: `isHost` can flip mid-session during host promotion.
 *  Always read inline — never cache in a local variable across ticks. */
export interface HostNetContext {
  remoteHumanSlots: ReadonlySet<number>;
  isHost: boolean;
}

/** Phase timer accumulators — tracks elapsed time per phase for host tick logic.
 *  NEVER mutate these fields directly — always use advancePhaseTimer() from
 *  tick-context.ts, which keeps accum and state.timer in sync.
 *
 *  Naming convention:
 *    - One key per distinct timer: accum.cannon, accum.battle, accum.build, accum.select
 *    - Separate concerns get their own key: accum.grunt (cross-phase spawning interval),
 *      accum.selectAnnouncement (UI countdown separate from selection timer)
 *    - All keys are reset to 0 via createTimerAccums() at game start / rematch. */
export interface TimerAccums {
  readonly battle: number;
  readonly cannon: number;
  readonly select: number;
  readonly selectAnnouncement: number;
  readonly build: number;
  readonly grunt: number;
}

/** Mutable view of TimerAccums — use ONLY inside these blessed mutation sites:
 *  - advancePhaseTimer() in tick-context.ts — canonical phase timer advancement
 *  - tickGruntsIfDue() in tick-context.ts — cross-phase grunt spawn interval
 *  - tickSelectionPhase() in selection.ts — selection phase has custom timer logic
 *  Everywhere else, pass TimerAccums (readonly) to prevent accidental mutation. */
export type MutableAccums = { -readonly [K in keyof TimerAccums]: number };

/** Empty set used as default when no remote players exist (local play). */
const NO_REMOTE_SLOTS: ReadonlySet<number> = Object.freeze(new Set<number>());

/** True if this client is the host. Defaults to true when net is omitted (local play).
 *  VOLATILE: result can change between frames (host promotion). Never cache. */
export function isHostInContext(net?: Pick<HostNetContext, "isHost">): boolean {
  // eslint-disable-next-line no-restricted-syntax -- canonical implementation
  return net?.isHost ?? true;
}

/** Extract remote human slots from optional net context, defaulting to empty for local play. */
export function getRemoteSlots(
  net?: Pick<HostNetContext, "remoteHumanSlots">,
): ReadonlySet<number> {
  return net?.remoteHumanSlots ?? NO_REMOTE_SLOTS;
}

/** Advance a phase timer: accum += dt, state.timer = max - accum.
 *  INVARIANT: All phase timers MUST use this function. Never manually write `accum.X += dt`.
 *  Returns the updated timer value (milliseconds, counts down to 0).
 *
 *  This is the ONLY correct way to advance phase timers. It mutates both
 *  `accum` and `state.timer` atomically so they can't drift out of sync.
 *  Separate mutations silently break the `timer = max - elapsed` invariant
 *  with no compile error. */
export function advancePhaseTimer<K extends string>(
  accum: Record<K, number>,
  key: K,
  state: { timer: number },
  dt: number,
  max: number,
): void {
  const elapsed = (accum[key] += dt);
  state.timer = Math.max(0, max - elapsed);
}

/** Advance grunt accumulator and tick grunts when the interval elapses.
 *  Shared between host (tickHostBuildPhase) and watcher to prevent interval drift. */
export function tickGruntsIfDue(
  accum: { grunt: number },
  dt: number,
  state: GameState,
  tickGrunts: (state: GameState) => void,
): void {
  accum.grunt += dt;
  if (accum.grunt >= GRUNT_TICK_INTERVAL) {
    accum.grunt -= GRUNT_TICK_INTERVAL;
    tickGrunts(state);
  }
}

/** Filter controllers to only local (non-remote) players that are still alive. */
export function localActiveControllers<
  T extends ControllerIdentity = ControllerIdentity,
>(
  controllers: readonly T[],
  remoteHumanSlots: ReadonlySet<number>,
  state: GameState,
): T[] {
  return controllers.filter(
    (ctrl) =>
      !remoteHumanSlots.has(ctrl.playerId) &&
      !state.players[ctrl.playerId]?.eliminated,
  );
}

export function createTimerAccums(): TimerAccums {
  return {
    battle: 0,
    cannon: 0,
    select: 0,
    selectAnnouncement: 0,
    build: 0,
    grunt: 0,
  };
}
