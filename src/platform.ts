/**
 * Platform/device capability detection — computed once at load time.
 */

/** Whether the device supports touch input (includes desktop with touchscreen/trackpad). */

export const IS_TOUCH_DEVICE: boolean =
  typeof window !== "undefined" &&
  ("ontouchstart" in window || navigator.maxTouchPoints > 0);
/** Whether running in dev mode (Vite dev server or localhost). */
export const IS_DEV: boolean =
  // @ts-ignore — import.meta.env is Vite-specific (not recognized by Deno LSP)
  !!(import.meta.env?.DEV) || (typeof location !== "undefined" && location?.hostname === "localhost");
