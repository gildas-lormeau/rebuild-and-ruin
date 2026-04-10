/**
 * Minimal `document` shim for the online receive-side test wrapper.
 *
 * `src/online/online-dom.ts` evaluates `document.getElementById(...)` at
 * module-load time for ~10 elements (canvas, lobby selects, error
 * containers, ...). In Deno there is no `document`, so any test file that
 * transitively imports `online-runtime-deps.ts` would crash on import.
 *
 * The dispatcher path (`handleServerIncrementalMessage`) never reaches into
 * any of those elements — it only touches `runtime.*` accessors and the
 * session/watcher state. The lifecycle path uses `createError` / `joinError`
 * for error UI; the receive-seam tests don't exercise that path. So
 * returning `null` from every `getElementById` lookup is safe: the values
 * become `null at runtime` (the `!` in online-dom.ts is a TS lie, not a
 * runtime check), and the dispatcher never reads them.
 *
 * This file MUST be imported as a side-effect *before* any module that
 * transitively imports `online-dom.ts`. ESM evaluates side-effect imports
 * in source order, so placing this import first in `test/online-headless.ts`
 * is enough.
 */

interface MutableGlobal {
  document?: unknown;
}

const target = globalThis as MutableGlobal;

if (typeof target.document === "undefined") {
  // The dispatcher never touches any of these — `getElementById` returning
  // null is enough for module evaluation to succeed. We do NOT install a
  // full DOM polyfill; that's deliberately out of scope.
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

export {};
