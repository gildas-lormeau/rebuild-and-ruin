/** Injected timing primitives. Production callers (main.ts, online/runtime/game.ts)
 *  bind to `performance.now`, `setTimeout`, `clearTimeout`, `requestAnimationFrame`.
 *  Tests pass deterministic stubs or Deno's natives. Following the project's
 *  "DOM/global helpers as deps" rule — no runtime sub-system should reach for
 *  these globals directly. */

// lint:allow-callback-inversion -- scheduler primitives: callbacks fire at
// the caller's identity; receiver doesn't read return values to drive its
// own logic. Same shape as `window.setTimeout` / `requestAnimationFrame`.

export interface TimingApi {
  /** Monotonic timestamp source — produces frame timestamps used by render
   *  animations, dedup channels, and lobby/banner timers. Must be monotonic
   *  within a single runtime instance. */
  readonly now: () => number;
  /** Schedule a one-shot callback after `ms` milliseconds. Returns a handle
   *  that can be passed to `clearTimeout`. */
  readonly setTimeout: (callback: () => void, ms: number) => number;
  /** Cancel a previously scheduled timeout. */
  readonly clearTimeout: (handle: number) => void;
  /** Schedule a callback to run before the next browser paint. Same signature
   *  as `window.requestAnimationFrame` — the `now` argument is a high-resolution
   *  timestamp. Tests pass a synchronous trampoline or no-op (since headless
   *  tests drive the main loop manually). */
  readonly requestFrame: (callback: (now: number) => void) => void;
}
