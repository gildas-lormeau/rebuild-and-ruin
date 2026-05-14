import type { TimingApi } from "./timing-api.ts";

export function createBrowserTimingApi(): TimingApi {
  return {
    now: () => performance.now(),
    setTimeout: (callback, ms) => Number(globalThis.setTimeout(callback, ms)),
    clearTimeout: (handle) => {
      globalThis.clearTimeout(handle);
    },
    requestFrame: (callback) => {
      requestAnimationFrame(callback);
    },
  };
}
