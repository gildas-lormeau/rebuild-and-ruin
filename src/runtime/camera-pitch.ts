/**
 * Camera pitch (battle-tilt) state machine — runtime-root primitive in
 * the `camera-projection.ts` style: a plain state object plus pure
 * functions, consumed by `subsystems/camera.ts`. The tick is
 * deterministic (driven by the pinned SIM_TICK frame dt) — its settle
 * frame feeds the battle-done dispatch gate, so every peer animates
 * pitch identically.
 */

/** Pitch state machine values.
 *  - `flat`: settled at pitch 0 (build / select / lobby / upgrade-pick).
 *  - `tilting`: easing from flat → battle (or from interrupted untilt back up).
 *  - `tilted`: settled at the battle 3/4 view pitch.
 *  - `untilting`: easing battle → flat (or from an interrupted tilt back down).
 *
 *  Call sites that need the settle edge as a one-shot continuation
 *  park a callback off `tickPitchAnim`'s returned edge (see the
 *  camera's `awaitPitchSettled`). Call sites that already poll per
 *  tick (phase-ticks' untilt wait) read `anim.state`. */

export type PitchState = "flat" | "tilting" | "tilted" | "untilting";

/** Mutable pitch-animation state. Created once per camera system via
 *  `createPitchAnim()`; every mutation goes through the functions below
 *  (plus `resetPitchAnim` for the rematch snap). Settle choreography
 *  (the parked `awaitPitchSettled` continuation) deliberately does NOT
 *  live here — storing a subsystem closure in this low-layer object
 *  would invert the layer graph (lint-callback-inversion); the camera
 *  keeps the callback and consumes `tickPitchAnim`'s settled edge. */
export interface PitchAnim {
  /** Rendered pitch (radians); eases toward `target` each tick. */
  current: number;
  /** Destination pitch (radians); re-set on phase enter. */
  target: number;
  /** Ease start value captured when `target` last changed. */
  animFrom: number;
  /** Seconds elapsed in the in-flight ease; >= PITCH_DURATION = settled. */
  animElapsed: number;
  state: PitchState;
}

/** Pitch animation duration (seconds). CSS `transition: Xms ease-out` equivalent. */
const PITCH_DURATION = 0.6;

export function createPitchAnim(): PitchAnim {
  return {
    current: 0,
    target: 0,
    animFrom: 0,
    animElapsed: PITCH_DURATION,
    state: "flat",
  };
}

export function setPitchTarget(anim: PitchAnim, next: number): void {
  if (next === anim.target) return;
  anim.animFrom = anim.current;
  anim.target = next;
  anim.animElapsed = 0;
  // Entering an animation: `tilting` if the new target is non-zero,
  // `untilting` otherwise. Covers mid-anim reversals too (e.g. a
  // paused battle-enter that gets undone before the animation
  // settles) since direction is derived from the target, not the
  // prior state.
  anim.state = next > 0 ? "tilting" : "untilting";
}

/** Ease `current` toward `target` by `dt` seconds. Returns true on the
 *  single tick that crosses the duration boundary (the settle edge —
 *  fired once per animation, not on the idle frames that follow); the
 *  caller runs its parked settle continuation off that edge. */
export function tickPitchAnim(anim: PitchAnim, dt: number): boolean {
  if (anim.animElapsed >= PITCH_DURATION) {
    if (anim.current !== anim.target) anim.current = anim.target;
    return false;
  }
  if (dt <= 0) return false;
  anim.animElapsed = Math.min(PITCH_DURATION, anim.animElapsed + dt);
  const t = anim.animElapsed / PITCH_DURATION;
  const eased = easeOutCubic(t);
  anim.current = anim.animFrom + (anim.target - anim.animFrom) * eased;
  if (anim.animElapsed >= PITCH_DURATION) {
    anim.current = anim.target;
    anim.state = anim.target > 0 ? "tilted" : "flat";
    return true;
  }
  return false;
}

/** True when no ease is in flight (`flat` and `tilted` both count). */
export function isPitchSettled(anim: PitchAnim): boolean {
  return anim.state === "flat" || anim.state === "tilted";
}

/** Snap to settled-flat (rematch bootstrap — see `resetCamera`). The
 *  caller drops its parked settle continuation separately
 *  (`clearAllZoomState`) because a dying session's continuation must
 *  never run. */
export function resetPitchAnim(anim: PitchAnim): void {
  anim.current = 0;
  anim.target = 0;
  anim.animFrom = 0;
  anim.animElapsed = PITCH_DURATION;
  anim.state = "flat";
}

/** Cubic ease-out. Written as repeated multiplication (not `**`) so the
 *  float results stay bit-identical with the historical inline forms —
 *  `tickPitchAnim`'s settle frame feeds the battle-done dispatch gate.
 *  Also consumed by the camera's tap-nudge tween. */
export function easeOutCubic(t: number): number {
  return 1 - (1 - t) * (1 - t) * (1 - t);
}
