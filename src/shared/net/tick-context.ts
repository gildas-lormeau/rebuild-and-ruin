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
 * ### Phase lifecycle terminology (three distinct terms, NOT interchangeable)
 *
 *   "done"     — query:    "is this phase finished?"  (isCannonPhaseDone checks slots/timer)
 *   "finalize" — action:   run end-of-phase cleanup   (finalizeBuildPhase sweeps + scores)
 *   "ended"    — callback: signal that phase is over   (onBattlePhaseEnded notifies tick system)
 *
 * Use the term that matches the operation: query → done, cleanup → finalize, signal → ended.
 * Not every phase has all three stages (battle has no "finalize" — it ends on timer).
 *
 * Finalize functions may have internal sub-steps that must NOT be called directly:
 *   finalizeCannonPhase() = flushCannons() + initCannons()  (see controller-types.ts)
 *   finalizeBuildPhase()  = wall sweep + territory scoring   (see build-system.ts)
 * The composite function guarantees correct ordering; calling sub-steps individually
 * skips prerequisites (e.g. flush before init, sweep before score).
 */

import { GRUNT_TICK_INTERVAL } from "../core/game-constants.ts";
import type { ValidPlayerSlot } from "../core/player-slot.ts";
import type { ControllerIdentity } from "../core/system-interfaces.ts";
import type { GameState } from "../core/types.ts";

/** Base networking context shared by all phase ticks.
 *  VOLATILE: `isHost` can flip mid-session during host promotion.
 *  Always read inline — never cache in a local variable across ticks. */
interface HostNetContext {
  /** Non-local player slots. See OnlineSession.remotePlayerSlots for full docs. */
  remotePlayerSlots: ReadonlySet<number>;
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

/** Mutable view of TimerAccums — use ONLY inside blessed mutation sites:
 *  - advancePhaseTimer() / tickGruntsIfDue() in tick-context.ts
 *  - tickSelectionPhase() in selection.ts
 *  - syncAccumulatorsFromTimer() in online-host-promotion.ts (host migration)
 *  - resetAccum() below — phase-boundary resets in runtime sub-systems
 *  Everywhere else, pass TimerAccums (readonly) to prevent accidental mutation. */
export type MutableAccums = { -readonly [K in keyof TimerAccums]: number };

/** Watcher phase/countdown timing state.
 *  All timestamps are performance.now() values (ms since page load).
 *  Sentinel: 0 = not yet started (no phase/countdown active).
 *  Durations are in seconds. */
export interface WatcherTimingState {
  /** Phase start timestamp (ms). 0 = no phase timer active. */
  phaseStartTime: number;
  /** Phase duration (seconds). 0 = no phase timer active. */
  phaseDuration: number;
  /** Countdown start timestamp (ms). 0 = no countdown active. */
  countdownStartTime: number;
  /** Countdown duration (seconds). 0 = no countdown active. */
  countdownDuration: number;
}

/** Timer accumulator key constants. */
export const ACCUM_BATTLE = "battle" satisfies keyof TimerAccums;
export const ACCUM_CANNON = "cannon" satisfies keyof TimerAccums;
export const ACCUM_GRUNT = "grunt" satisfies keyof TimerAccums;
export const ACCUM_BUILD = "build" satisfies keyof TimerAccums;
export const ACCUM_SELECT = "select" satisfies keyof TimerAccums;

/** True if this client is the host. Defaults to true when net is omitted (local play).
 *  VOLATILE: result can change between frames (host promotion). Never cache. */
export function isHostInContext(net?: Pick<HostNetContext, "isHost">): boolean {
  // eslint-disable-next-line no-restricted-syntax -- canonical implementation
  return net?.isHost ?? true;
}

/** Advance a phase timer: accum += dt, state.timer = max - accum.
 *  INVARIANT: All phase timers MUST use this function. Never manually write `accum.X += dt`.
 *
 *  This is the ONLY correct way to advance phase timers. It mutates both
 *  `accum` and `state.timer` atomically so they can't drift out of sync.
 *  Separate mutations silently break the `timer = max - elapsed` invariant
 *  with no compile error.
 *  @param dt — Delta time in SECONDS (not ms). All tick functions use seconds. */
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

/** Filter controllers to only local (non-remote) players.
 *  Does NOT filter eliminated players — game systems (fire, placePiece, etc.)
 *  self-guard against eliminated players at the mutation boundary. */
export function localControllers<
  T extends ControllerIdentity = ControllerIdentity,
>(controllers: readonly T[], remotePlayerSlots: ReadonlySet<number>): T[] {
  return controllers.filter(
    (ctrl) => !isRemotePlayer(ctrl.playerId, remotePlayerSlots),
  );
}

/** True if this player slot is controlled by a remote human (not local).
 *  Use this instead of inline `remotePlayerSlots.has(pid)` to make intent explicit. */
export function isRemotePlayer(
  playerId: ValidPlayerSlot,
  remotePlayerSlots: ReadonlySet<number>,
): boolean {
  return remotePlayerSlots.has(playerId);
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

/** Reset a single accumulator to 0. Encapsulates the MutableAccums cast
 *  so callers don't need to import MutableAccums or write the cast inline. */
export function resetAccum(accum: TimerAccums, key: keyof TimerAccums): void {
  (accum as MutableAccums)[key] = 0;
}
