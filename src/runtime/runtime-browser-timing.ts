/**
 * Browser binding of the injected `TimingApi`.
 *
 * Shared by main.ts (local play) and online/online-runtime-game.ts (online play)
 * so both entry points can pass the same `RuntimeConfig.timing` without
 * duplicating the globals-binding logic. Parallel to `createCanvasRenderer` in
 * src/render/render-canvas.ts — a factory that produces an injected dep by
 * wrapping browser globals.
 *
 * Only entry points should import this module. Descendant sub-systems receive
 * the constructed `TimingApi` via `RuntimeConfig.timing` and must not reach
 * for these globals directly.
 */

import type { TimingApi } from "./runtime-types.ts";

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
