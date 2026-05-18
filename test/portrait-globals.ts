/**
 * Side-effect module — imported BEFORE any code that touches `src/shared/core/grid.ts`,
 * so `GRID_PORTRAIT_LAUNCHED` resolves to true and the grid swaps to 28×44 portrait
 * dimensions. Used to reproduce mobile-portrait sessions in headless tests.
 *
 * Must be the very first import in any test file that needs portrait mode.
 */

export {};

type Mutable = Record<string, unknown>;

const target = globalThis as Mutable;

if (typeof target.window === "undefined") {
  // The grid check uses `"ontouchstart" in window` — needs `window` to be an
  // object that includes the key. Define a minimal stub.
  target.window = { ontouchstart: null };
}

if (typeof target.navigator === "undefined") {
  target.navigator = { maxTouchPoints: 1 };
}

if (typeof target.matchMedia === "undefined") {
  target.matchMedia = (query: string) => ({
    matches: query.includes("portrait"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
}
