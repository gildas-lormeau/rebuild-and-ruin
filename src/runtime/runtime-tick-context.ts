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

import {
  emitBattleCeaseIfTimerCrossed,
  setBattleCountdown,
} from "../game/index.ts";
import {
  BATTLE_TIMER,
  GRUNT_TICK_INTERVAL,
} from "../shared/core/game-constants.ts";
import { isPlacementPhase, Phase } from "../shared/core/game-phase.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type { ControllerIdentity } from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";

/** Base networking context shared by all phase ticks.
 *  VOLATILE: `isHost` can flip mid-session during host promotion.
 *  Always read inline — never cache in a local variable across ticks. */
interface HostNetContext {
  /** Non-local player slots. See OnlineSession.remotePlayerSlots for full docs. */
  remotePlayerSlots: ReadonlySet<ValidPlayerSlot>;
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
  readonly modifierReveal: number;
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
export const ACCUM_MODIFIER_REVEAL =
  "modifierReveal" satisfies keyof TimerAccums;

/** True if this client is the host. Defaults to true when net is omitted (local play).
 *  VOLATILE: result can change between frames (host promotion). Never cache. */
export function isHostInContext(net?: Pick<HostNetContext, "isHost">): boolean {
  // eslint-disable-next-line no-restricted-syntax -- canonical implementation
  return net?.isHost ?? true;
}

/** Anchor the watcher phase timer to the current wall clock. Call from inside
 *  the banner onComplete callback — `performance.now()` at that instant is the
 *  moment the banner animation finished on this client, which is the logical
 *  moment the phase begins (mirroring the host's `resetAccum` at the end of
 *  the same transition recipe).
 *
 *  Use this helper for every phase whose watcher timer starts after a banner:
 *  cannon-start and build-start both call it. Do NOT pre-compute the origin
 *  as `bannerStartedAt + bannerDuration * 1000` — that relies on the banner
 *  animation matching its nominal duration exactly, which frame drops or
 *  browser throttling can violate. A dialog (upgrade-pick) that plays BEFORE
 *  the banner is fine: the dialog finishes before `showBanner()` is called,
 *  so the callback still fires at true banner-end. */
export function setWatcherPhaseTimerAtBannerEnd(
  timing: WatcherTimingState,
  phaseDuration: number,
  now: number,
): void {
  setWatcherPhaseTimer(timing, now, phaseDuration);
}

/** Reset watcher phase timing to idle (no active phase timer). */
export function clearWatcherPhaseTimer(timing: WatcherTimingState): void {
  timing.phaseStartTime = 0;
  timing.phaseDuration = 0;
}

/** Decay a persistent-announcement timer and surface its text into the frame.
 *
 *  Two announcement channels co-exist:
 *    1. `frame.announcement` — general-purpose, set directly per-frame
 *       (battle countdown, "Reconnecting…"). Cleared each frame by
 *       clearFrameData().
 *    2. A persistent `{ timer, text }` slot — survives frame clears, used
 *       for messages that must remain on screen for a fixed duration
 *       (e.g. host-migration announcement).
 *
 *  This helper bridges (2) → (1) without overwriting an existing per-frame
 *  announcement (so a Ready/Aim/Fire countdown beats the persistent text).
 *  When the timer expires, the slot self-clears. */
export function tickPersistentAnnouncement(
  banner: { timer: number; text: string },
  frame: { announcement?: string },
  dt: number,
): void {
  if (banner.timer <= 0) return;
  banner.timer -= dt;
  if (banner.timer > 0) {
    if (!frame.announcement) {
      frame.announcement = banner.text;
    }
  } else {
    banner.timer = 0;
    banner.text = "";
  }
}

/** Synthesize `state.timer` and battle-countdown announcements on the watcher.
 *
 *  Three regimes, gated on `state.phase`:
 *    1. Placement phases (+ MODIFIER_REVEAL) — wall-clock subtraction from
 *       `phaseStartTime + phaseDuration`. Resilient to frame jitter.
 *    2. Battle countdown — same wall-clock pattern, but routed through
 *       `setBattleCountdown` to drive the Ready/Aim/Fire announcement.
 *       When the countdown ends, anchor the phase timer to the exact
 *       countdown-end instant so the BATTLE timer continues seamlessly.
 *    3. Battle proper — dt-based decrement via `advancePhaseTimer`, matching
 *       the host. (Wall-clock synthesis here drifts ~17ms vs sim-tick across
 *       the 30s timer and shifts combo-streak windows.) */
export function tickWatcherTimers(
  state: GameState,
  frame: { announcement?: string },
  timing: WatcherTimingState,
  now: () => number,
  accum: TimerAccums,
  dt: number,
): void {
  if (isPlacementPhase(state.phase) || state.phase === Phase.MODIFIER_REVEAL) {
    const elapsed = Math.max(0, (now() - timing.phaseStartTime) / 1000);
    state.timer = Math.max(0, timing.phaseDuration - elapsed);
    return;
  }

  if (state.phase !== Phase.BATTLE) return;

  if (timing.countdownDuration > 0) {
    const elapsed = Math.max(0, (now() - timing.countdownStartTime) / 1000);
    frame.announcement = setBattleCountdown(
      state,
      timing.countdownDuration - elapsed,
    );
    if (!frame.announcement) {
      setWatcherPhaseTimer(
        timing,
        timing.countdownStartTime + timing.countdownDuration * 1000,
        BATTLE_TIMER,
      );
      timing.countdownDuration = 0;
    }
    return;
  }

  const prevTimer = state.timer;
  advancePhaseTimer(accum, ACCUM_BATTLE, state, dt, BATTLE_TIMER);
  emitBattleCeaseIfTimerCrossed(state, prevTimer);
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

/** Start tracking a new phase timer on the watcher. Call at the moment a phase
 *  begins on the watcher side. The watcher reconstructs `state.timer` each
 *  frame from `(now - phaseStartTime)`. */
export function setWatcherPhaseTimer(
  timing: WatcherTimingState,
  now: number,
  phaseDuration: number,
): void {
  timing.phaseStartTime = now;
  timing.phaseDuration = phaseDuration;
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
>(
  controllers: readonly T[],
  remotePlayerSlots: ReadonlySet<ValidPlayerSlot>,
): T[] {
  return controllers.filter(
    (ctrl) => !isRemotePlayer(ctrl.playerId, remotePlayerSlots),
  );
}

/** True if this player slot is controlled by a remote human (not local).
 *  Use this instead of inline `remotePlayerSlots.has(pid)` to make intent explicit. */
export function isRemotePlayer(
  playerId: ValidPlayerSlot,
  remotePlayerSlots: ReadonlySet<ValidPlayerSlot>,
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
    modifierReveal: 0,
  };
}

/** Reset a single accumulator to 0. Encapsulates the MutableAccums cast
 *  so callers don't need to import MutableAccums or write the cast inline. */
export function resetAccum(accum: TimerAccums, key: keyof TimerAccums): void {
  (accum as MutableAccums)[key] = 0;
}
