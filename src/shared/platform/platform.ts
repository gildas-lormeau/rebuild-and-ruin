/**
 * Platform/device capability detection — computed once at load time.
 */

/** Whether the device supports touch input (includes desktop with touchscreen/trackpad). */

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
/** Web Audio AudioContext state values — reused by the music and SFX
 *  subsystems when gating suspend/resume transitions. */
export const AUDIO_CONTEXT_RUNNING = "running";
export const AUDIO_CONTEXT_SUSPENDED = "suspended";
/** Whether running in dev mode (Vite dev server or localhost). */
export const IS_DEV: boolean =
  // @ts-ignore — import.meta.env is Vite-specific (not recognized by Deno LSP)
  !!import.meta.env?.DEV ||
  (typeof location !== "undefined" && location?.hostname === "localhost");
