/**
 * Minimal `document` shim for Deno test runs that import online code.
 *
 * `src/online/online-dom.ts` evaluates `document.getElementById(...)` at
 * module-load time for ~10 elements (canvas, lobby selects, error
 * containers, ...). In Deno there is no `document`, so any test file that
 * transitively imports `online-runtime-deps.ts` would crash on import.
 *
 * The dispatcher path (`handleServerIncrementalMessage`,
 * `handleServerLifecycleMessage`) never touches any of those elements — it
 * only reads `runtime.*` accessors and session/watcher state. Returning
 * `null` from every `getElementById` lookup is safe: the call sites use
 * `!` which is a TS lie, not a runtime check, and the dispatcher never
 * reads them.
 *
 * This file MUST be imported as a side-effect *before* any module that
 * transitively imports `online-dom.ts`. ESM evaluates side-effect imports
 * in source order, so placing it first in the file that needs it is
 * enough.
 */

export {};

interface MutableGlobal {
  document?: unknown;
}

const target = globalThis as MutableGlobal;

if (typeof target.document === "undefined") {
  target.document = {
    getElementById: (_id: string) => null,
    createElement: (_tag: string) => ({
      style: {},
      classList: {
        add: () => {},
        remove: () => {},
        contains: () => false,
        toggle: () => false,
      },
      appendChild: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
    body: null,
  };
}
