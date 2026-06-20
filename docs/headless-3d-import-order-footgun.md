# Footgun: headless test import order vs. 3D-sprite module load

**Status:** known issue, should be fixed. Worked around per-file today via a
forced import-evaluation order.

## Symptom

A Deno test that imports the online/network harness crashes at load with:

```
TypeError: canvas.getContext is not a function
  at createTiledCanvasTexture (src/render/3d/sprites/procedural-texture.ts)
  ... elevation.ts → boundsYOf → tower-scene → procedural-texture
```

## Root cause — an ordering dependency between two side-effect imports

1. `test/online-dom-shim.ts` installs a stub `globalThis.document` whose
   `createElement()` returns a bare element **without `getContext`** (it only
   needs `getElementById`/`createElement` for `online-dom.ts`'s module-load
   element lookups).
2. `src/render/3d/sprites/procedural-texture.ts` guards 3D-texture building
   with `if (typeof document === "undefined") return undefined;` — an SSR-safe
   early return. The 3D-sprite modules (`elevation.ts` → `boundsYOf` → …) run
   this **at module-load time**.
3. `scenario.ts` transitively imports `render-canvas.ts` → the 3D-sprite
   modules.

So the outcome depends on **which side-effect import runs first**:

- `scenario.ts` (render-canvas) first, while `document` is still undefined →
  the guard early-returns, 3D modules load harmlessly. ✅
- `online-dom-shim.ts` first → `document` is now *defined* but canvas-less, the
  guard passes, and `document.createElement("canvas").getContext("2d")`
  throws. ❌

## Current workaround (fragile)

Test files import `createScenario` from `scenario.ts` **as a value, first**, to
force its evaluation before `network-setup.ts` installs the shim:

```ts
import { createScenario, type Scenario } from "./scenario.ts"; // MUST be first
// ... network-setup.ts (installs online-dom-shim) comes after
void createScenario; // prevent elision of the value import
```

See the header comment in `test/network-bidirectional.test.ts` and
`test/skew-repro.test.ts`. A type-only `import type { Scenario }` is elided at
runtime and does **not** force the order — that is the trap.

## Proper fixes (pick one)

- **Defensive guard (smallest):** in `procedural-texture.ts`, also check the
  context is obtainable — `const ctx = canvas.getContext?.("2d"); if (!ctx)
  return undefined;` — so a canvas-less stub `document` no longer crashes,
  regardless of import order.
- **Honest shim:** make `online-dom-shim.ts`'s `createElement("canvas")` return
  a stub exposing a no-op `getContext` (mirrors `test/recording-canvas.ts`),
  so headless 3D-texture code degrades to no-op instead of throwing.
- **No work at module load:** move the `boundsYOf`/sprite module-load
  computations behind explicit renderer init so merely importing the 3D modules
  does nothing — headless (stub-renderer) paths never trigger them.

Any of these removes the import-order dependency so test files no longer need
the forced-evaluation-order incantation.
