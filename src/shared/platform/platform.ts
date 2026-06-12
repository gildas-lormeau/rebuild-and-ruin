/**
 * Platform/device capability detection — computed once at load time.
 */

/** Whether the device supports touch input (includes desktop with touchscreen/trackpad). */

/** Web Audio AudioContext state values — reused by the music and SFX
 *  subsystems when gating suspend/resume transitions. */

const AUDIO_CONTEXT_RUNNING = "running";
/** iOS Safari's non-standard state during a system audio interruption
 *  (phone call, Siri, alarm). It is NOT "suspended" — strict
 *  suspended/running gates skip it entirely, which strands contexts
 *  (resume never issued) or lets one-shots queue against the silent
 *  context and burst when iOS releases the interruption. Absent from
 *  lib.dom's AudioContextState, hence the string-typed helpers below —
 *  every suspend/resume gate goes through them so the quirk lives here
 *  once. */
const AUDIO_CONTEXT_INTERRUPTED = "interrupted";
export const IS_TOUCH_DEVICE: boolean =
  typeof window !== "undefined" &&
  ("ontouchstart" in window || navigator.maxTouchPoints > 0);
/** Whether the device supports the Vibration API. */
export const CAN_VIBRATE: boolean =
  typeof navigator !== "undefined" && !!navigator.vibrate;
/** Keyboard event key constants — shared across input and settings files. */
export const KEY_UP = "ArrowUp";
export const KEY_DOWN = "ArrowDown";
export const KEY_LEFT = "ArrowLeft";
export const KEY_RIGHT = "ArrowRight";
export const KEY_ENTER = "Enter";
export const KEY_ESCAPE = "Escape";
/** CSS cursor values — shared across input and runtime files. */
export const CURSOR_POINTER = "pointer";
export const CURSOR_DEFAULT = "default";
export const AUDIO_CONTEXT_SUSPENDED = "suspended";
/** Whether running in dev mode (Vite dev server or localhost). */
export const IS_DEV: boolean =
  // @ts-ignore — import.meta.env is Vite-specific (not recognized by Deno LSP)
  !!import.meta.env?.DEV ||
  (typeof location !== "undefined" && location?.hostname === "localhost");

/** True when the context is in iOS's interruption state. One-shot
 *  playback should DROP in this window — moment-anchored sounds queued
 *  against an interrupted context all burst out when the call ends. */
export function isAudioContextInterrupted(ctx: AudioContext): boolean {
  return (ctx.state as string) === AUDIO_CONTEXT_INTERRUPTED;
}

/** True when `resume()` should be issued to get the context running:
 *  regular suspension, or iOS's interruption — an explicit resume both
 *  registers intent with WebKit and recovers the documented
 *  stuck-interrupted state after unlock. */
export function audioContextNeedsResume(ctx: AudioContext): boolean {
  const state = ctx.state as string;
  return (
    state === AUDIO_CONTEXT_SUSPENDED || state === AUDIO_CONTEXT_INTERRUPTED
  );
}

/** True when `suspend()` should be issued to honor a pause: the context
 *  is running, or iOS-interrupted — suspending during the interruption
 *  pins the context down so the interruption-end auto-resume doesn't
 *  un-pause the audio behind the game's back. */
export function audioContextCanSuspend(ctx: AudioContext): boolean {
  const state = ctx.state as string;
  return state === AUDIO_CONTEXT_RUNNING || state === AUDIO_CONTEXT_INTERRUPTED;
}
