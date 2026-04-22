/**
 * Single-shot completion-callback slot.
 *
 * Shared by the three runtime dialog sub-systems (score-delta display,
 * life-lost, upgrade-pick) to store the "fire once when done" callback
 * that the driving phase machine passes in at show/tryShow time.
 *
 * The real axis of variation between the three sites is **tick scope**
 * (mode-independent vs mode-gated) — callback storage is the same shape
 * everywhere. See docs/dialog-completion-patterns.md.
 *
 * Semantics:
 *   - `set(cb)`: stash the callback (overwrites any prior pending cb).
 *   - `fire(...args)`: invoke the stashed callback at most once, then
 *     clear. Null-before-call ordering prevents re-entrancy loops — a
 *     callback that re-enters the owning system can safely call `set`
 *     again without being swallowed.
 *   - `clear()`: drop the stashed callback without firing (used by
 *     watcher-role force-clears).
 *   - `isPending()`: does a callback wait to fire?
 */

interface FireOnceSlot<Args extends readonly unknown[] = []> {
  set(callback: (...args: Args) => void): void;
  fire(...args: Args): void;
  clear(): void;
  isPending(): boolean;
}

export function createFireOnceSlot<
  Args extends readonly unknown[] = [],
>(): FireOnceSlot<Args> {
  let pending: ((...args: Args) => void) | undefined;

  return {
    set(callback) {
      pending = callback;
    },
    fire(...args) {
      const callback = pending;
      pending = undefined;
      callback?.(...args);
    },
    clear() {
      pending = undefined;
    },
    isPending() {
      return pending !== undefined;
    },
  };
}
