# Sprite-scene conventions

Reference for authors of `*-scene.mjs` files. These conventions are enforced
mechanically by `sprite-kit.mjs` + `sprite-bounds.mjs` where possible.

## World coordinates

Every scene renders through an orthographic camera with a **±1 frustum on X
and Z** (a.k.a. `FRUSTUM_HALF = 1` in `sprite-bounds.mjs`). The frustum is
independent of `canvasPx` — a 1×1 tile sprite and a 2×2 tile sprite both
render the same ±1 world box. `canvasPx` only controls the pixel resolution
of the output.

Corollary: a 1×1 sprite maps 1 tile onto 2 world units, so one tile spans
from −1 to +1. A 2×2 sprite maps 2 tiles onto 2 world units, so each tile
occupies 1 world unit.

### Tall sprites

Some sprites (e.g., `balloon_flight`) are taller than wide. Those set
`canvasPxH` to override the height. The Y frustum then extends to
`±aspect` where `aspect = canvasPxH / canvasPx`. The pipeline adds a 15%
padding when rendering the tilted view, giving `±aspect × 1.15`.

## Cell grid

`CELL = 0.125` world units. Authored geometry snaps to multiples of CELL
(or half-CELL where needed) so sprite edges land on pixel boundaries after
quantization. Use `cells(n)` from `sprite-kit.mjs` to read this as "n cells".

Pixel density (at game-1×):
- 1×1 sprite (`canvasPx=32`): 1 cell = 1 pixel.
- 2×2 sprite (`canvasPx=64`): 1 cell = 1 pixel.

The ratio is constant because both the frustum (±1) and the cell grid are
fixed; only `canvasPx` changes to produce a bigger output image.

### What to align, what to leave free

- **Align**: axis-aligned box dims (width/height/depth), positions of
  box edges that define the silhouette, tile-footprint extents, flame
  heights, slab thicknesses.
- **Free-valued** (curves, OK to leave unaligned): sphere/cylinder radii,
  rotation angles in radians, random rock scatter positions (RNG-driven
  by construction).

## Procedural scatter bounds

For scenes that scatter rotated rocks/chunks within a footprint:

```
halfFootprint + 0.707 × maxRockSize ≤ FRUSTUM_HALF
```

The 0.707 factor is the worst-case corner reach of a box of edge length
`maxRockSize` under random XZ rotation. Breaking this rule means rocks at
the footprint edge can extend past the sprite frame when rotated to a
diagonal. Noted verbally in the debris spec; not yet an automatic check.

## variantReport shape

Every scene exports `variantReport(variant) => { name, warnings, ...extras }`:

- `name` (required) — the variant's name.
- `warnings` (required) — array of strings, never undefined. Empty =
  sprite is valid.
- `...extras` — scene-specific facts useful for debugging (bounds, pieces
  count, apex height, etc.). Optional; no caller should rely on them.

Warning format: `"<part> extends past ±<limit> (<value>)"`. Use
`fmtBound()` from `sprite-bounds.mjs` to format consistently.

Standard epsilon: `BOUND_EPS = 1e-4`.

## Material specs

One canonical `MaterialSpec` typedef in `sprite-kit.mjs`. Fields:
`kind` (`'basic' | 'standard'`), `color`, optional `side`, `emissive`,
`opacity`, `roughness`, `metalness`, `flat`. Use `createMaterial(THREE, spec)`
to instantiate; all fields are honored uniformly.

Shared named-material constants live in `sprite-materials.mjs`. Scene-local
materials (only used by one file) stay in their scene file.

## File layout

- `sprite-kit.mjs` — infrastructure (CELL, cells, createMaterial, SIDE_MAP_KEYS,
  MaterialSpec typedef).
- `sprite-materials.mjs` — shared material constants (STONE, ROOF, FLAG, etc.).
- `sprite-bounds.mjs` — bounds helpers (FRUSTUM_HALF, fmtBound, radialReach).
- `*-scene.mjs` — one per sprite category. Exports `VARIANTS`, `PALETTE`,
  `variantReport`, and a `build<Name>` function.
- `build-*-3d.html` — per-scene preview pages. Import the matching
  `*-scene.mjs` + `sprites-pipeline.mjs`.
- `assembly-scene.mjs` — prototype world composer (temporary; the live
  renderer will supersede it).
- `sprites-pipeline.mjs` — rendering harness shared by all preview pages.

## Migration notes

These files will move to `src/render/3d/sprites/` and convert to TypeScript
when the live 3D renderer integration begins. Keep the shared modules
stable during that transition — behavior-preserving refactors only.
