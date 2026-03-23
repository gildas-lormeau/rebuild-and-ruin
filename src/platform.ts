/**
 * Platform/device capability detection — computed once at load time.
 */

/** Whether the device supports touch input (includes desktop with touchscreen/trackpad). */
export const IS_TOUCH_DEVICE: boolean =
  typeof window !== "undefined" &&
  ("ontouchstart" in window || navigator.maxTouchPoints > 0);
