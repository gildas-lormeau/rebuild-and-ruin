# Sprite-scene conventions

Reference for authors of `*-scene.ts` files (one per sprite category — wall,
tower, house, cannon, cannonball, grunt, balloon, debris, pit, rampart).
Conventions here are conventions only — there is no automated checker; the
3D renderer just consumes whatever shape the builder returns.

## World coordinates

Every scene is authored against an orthographic frustum that's **±1 on X
and Z**. The frustum is independent of how big the sprite is in tiles — a
1×1 sprite and a 2×2 sprite both author against the same ±1 world box.
What changes between them is only where geometry is positioned inside that
box.

Corollary: a 1×1 sprite maps 1 tile onto 2 world units, so one tile spans
−1 to +1. A 2×2 sprite maps 2 tiles onto 2 world units, so each tile
occupies 1 world unit.

### Tall sprites

Some sprites (e.g. `balloon_flight`) are taller than wide. They extend the
Y frustum to `±aspect` where `aspect = height / width`; the in-engine
camera adds a 15% padding under tilt.

## Cell grid

`CELL = 0.125` world units. Authored geometry snaps to multiples of CELL
(or half-CELL where needed) so sprite edges land on pixel boundaries after
quantization. Use `cells(n)` from `sprite-kit.ts` to read this as "n cells".

### What to align, what to leave free

- **Align**: axis-aligned box dims (width/height/depth), positions of box
  edges that define the silhouette, tile-footprint extents, flame
  heights, slab thicknesses.
- **Free-valued** (curves, OK to leave unaligned): sphere/cylinder radii,
  rotation angles in radians, random rock scatter positions (RNG-driven
  by construction).

## Procedural scatter bounds

For scenes that scatter rotated rocks/chunks within a footprint, keep:

```
halfFootprint + 0.707 × maxRockSize ≤ 1   (the ±1 frustum half-width)
```

The 0.707 factor is the worst-case corner reach of a box of edge length
`maxRockSize` under random XZ rotation. Breaking this rule means rocks at
the footprint edge can extend past the sprite frame when rotated to a
diagonal. Verified visually, not automatically.

## Scene module shape

Each `*-scene.ts` exports:

- `VARIANTS: Variant[]` — the list of named variants (e.g.
  `tower_round_small`, `wall_brick`).
- `PALETTE: [number, number, number][]` — the (sRGB) colors used to bake
  the scene's material atlas, in priority order.
- `getXVariant(name) => Variant | undefined` — name lookup.
- `boundsYOf(variant)` (where applicable) — pure-math Y extents helper for
  sizing camera frusta in standalone previews.
- `buildX(scene, variant, ...)` — the actual builder; appends meshes to
  the supplied `THREE.Group` / `THREE.Scene` and returns nothing useful.

There is no `variantReport` and no bounds-warning shape — earlier
generations had one, but the in-engine renderer reads variants directly
through the lookup helpers, and out-of-bounds geometry is caught visually
in the preview pages.

## Material specs

One canonical `MaterialSpec` typedef in `sprite-kit.ts`. Fields:
`kind` (`'basic' | 'standard'`), `color`, optional `side`, `emissive`,
`opacity`, `roughness`, `metalness`, `flat`. Use `createMaterial(spec)` to
instantiate; all fields are honored uniformly.

Shared named-material constants live in `sprite-materials.ts`.
Scene-local materials (only used by one file) stay in their scene file.

For textured materials (procedural `CanvasTexture` from
`procedural-texture.ts`), declare a `TextureId` in `sprite-textures.ts`
and use `buildTexturedMaterial(three, spec)`; the cache is module-level.

## File layout

- `sprite-kit.ts` — infrastructure (`CELL`, `cells`, `createMaterial`,
  `SIDE_MAP_KEYS`, `MaterialSpec`, `findVariant`, `measureVariantBoundsY`,
  `applyBoxWallUV`).
- `sprite-materials.ts` — shared material constants (STONE, ROOF, FLAG,
  etc.).
- `procedural-texture.ts` — seeded-LCG canvas wrapper for tileable
  `CanvasTexture`s (`createTiledCanvasTexture`).
- `sprite-textures.ts` — `TextureId` enum + `buildTexturedMaterial`,
  including all bricked / planked / knurled procedural textures.
- `*-scene.ts` — one per sprite category. Exports `VARIANTS`, `PALETTE`,
  `getXVariant`, optional `boundsYOf`, and `buildX`.

Standalone preview tooling (build harness + per-scene HTML) lives outside
the runtime tree (see `scripts/sprites-pipeline.mjs` and
`tmp/sprites-design/build-*-3d.html`). They consume the scene exports as
plain ES modules.
