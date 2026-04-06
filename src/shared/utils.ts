/**
 * Generic JS/TS utilities with no game-type dependencies.
 */

/**
 * Compile-time exhaustiveness check for switch/if-else on enums.
 * A missing case makes `value` a concrete enum member instead of `never`,
 * producing a type error at the call site.
 */

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

/** Invoke a one-shot callback field and clear it to prevent re-entry.
 *  Pattern: runtimeState stores an optional callback (e.g., scoreDeltaOnDone).
 *  fireOnce() calls it exactly once, then sets the field to null.
 *  This prevents double-firing if the caller runs again before the next frame.
 *
 *  The null-before-call order prevents re-entrancy loops.
 *
 *  Usage:  `fireOnce(obj, "callback")` replaces the manual pattern:
 *    `const cb = obj.callback; obj.callback = null; cb?.();`
 *
 *  In dev mode, logs a warning if the field was already null (double-fire). */
export function fireOnce<
  K extends string,
  T extends Record<K, (() => void) | null>,
>(obj: T, key: K, label?: string): void {
  const callback = obj[key] as (() => void) | null;
  (obj as Record<K, (() => void) | null>)[key] = null;
  if (callback) {
    callback();
  } else if (
    typeof import.meta !== "undefined" &&
    // @ts-ignore — import.meta.env is Vite-specific
    import.meta.env?.DEV
  ) {
    console.warn(`fireOnce: ${label ?? key} was already null (double-fire?)`);
  }
}
