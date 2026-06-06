# `src/render/` — Hybrid 3D + 2D rendering

The **render** domain owns everything that paints pixels. The game is
rendered as a hybrid: a WebGL `worldCanvas` carries all world content
(terrain, walls, towers, cannons, grunts, houses, debris, cannonballs,
balloons, pits, effects), and a stacked 2D canvas carries the UI/HUD
overlay (banner, dialogs, status bar, modal screens, HUD text). The two
canvases share dimensions and aspect ratio so they stack 1:1 under CSS
`object-fit: contain`.

Render code **never mutates game state**. Every function takes a render
payload (map + overlay + viewport + now) and draws it. The game decides
what to draw; render decides how.

## Read these first

1. **[render-canvas.ts](./render-canvas.ts)** — `createCanvasRenderer(canvas)`,
   the 2D-only `RendererInterface` implementation. Used directly in 2D
   mode and as the UI/HUD delegate by the 3D renderer.

2. **[render-map.ts](./render-map.ts)** — `createRenderMap()`, the 2D
   draw orchestrator. Owns the offscreen scene canvas, the banner
   prev/new-scene snapshot bridges, and the terrain SDF / nearest-water
   caches (consumed by the 3D shader, even though the SDF computation
   lives in 2D-land). The header comment at the top of `drawMap` is the
   canonical inventory of what stays in 2D.

3. **[3d/renderer.ts](./3d/renderer.ts)** — `createRender3d(worldCanvas,
   uiCanvas)`, the WebGL `RendererInterface` implementation. Delegates
   UI/HUD to a `createCanvasRenderer` wrapped with the reserved top-strip
   flag, then renders the world via Three.js into the world canvas.

4. **[render-ui-overlays.ts](./render-ui-overlays.ts)** — the per-frame
   overlay factories + hit-tests that the runtime composition root wires
   in: `createBannerUi`, `createOnlineOverlay`, `buildGameOverOverlay`,
   `updateSelectionOverlay`, click hit-tests for life-lost / upgrade-pick
   / lobby / game-over dialogs.

## File categories

### 2D rendering
- **`render-canvas.ts`** — `RendererInterface` impl for 2D-only rendering.
  Exposes `drawFrame`, `warmMapCache`, `clientToSurface`,
  `screenToContainerCSS`, `captureScene`, `captureSceneOffscreen`,
  `createLoupe`. In 3D mode this is wrapped (not replaced) — see
  `3d/renderer.ts`.
- **`render-map.ts`** — `createRenderMap()`: 2D draw pipeline + scene
  canvas + banner snapshot bridges + terrain SDF computation (uploaded
  to the 3D shader as a `DataTexture`, see `3d/effects/terrain-sdf-texture.ts`).
- **`render-layout.ts`** — letterbox math (`clientToCanvas`,
  `computeLetterboxLayout`).
- **`render-loupe.ts`** — `createLoupe()`: mobile magnifier overlay for
  precision tile selection on touch devices. In 3D mode it samples a
  WebGL+2D composite (assembled in `3d/renderer.ts` `loupeCompositeSource`).

### UI / HUD overlays (2D)
- **`render-ui.ts`** — concrete draw functions for the 2D layer:
  `drawPhaseTimer`, `drawSelectionCursor`, `drawAnnouncement`,
  `drawBanner`, `drawScoreDeltas`, `drawStatusBar`, `drawGameOver`,
  `drawLifeLostDialog`, `drawComboFloats`, `drawUpgradePick`, `drawLobby`.
- **`render-ui-overlays.ts`** — per-frame overlay factories + hit-tests
  consumed by the runtime composition root (banner UI, online overlay,
  game-over overlay, lobby layout, dialog click handlers, selection
  overlay updater).
- **`render-ui-screens.ts`** — overlay constructors for the modal
  screens: `createOptionsOverlay`, `createControlsOverlay`,
  `createLobbyOverlay`, plus `visibleOptions`.
- **`render-ui-settings.ts`** — options + controls screen *drawing* and
  matching hit-tests (`optionsScreenHitTest`, `controlsScreenHitTest`).
- **`render-ui-theme.ts`** — shared drawing primitives (`drawPanel`,
  `drawButton`, `beginModalScreen`).

### 3D rendering (`3d/`)
- **`3d/renderer.ts`** — `createRender3d`: `RendererInterface` impl
  backed by Three.js, including the FBO-readback path for banner
  B-snapshots and the WebGL+2D loupe composite.
- **`3d/scene.ts`** — `createRender3dScene`: scene graph construction,
  fullscreen-quad blit pass for FBO → default-framebuffer.
- **`3d/camera.ts`** — viewport → camera transform under pitch.
- **`3d/lights.ts`** — ambient + directional sun, pitch-blended shadow
  intensity, sun-arc direction (`updateSunDirection`).
- **`3d/elevation.ts`** — Y-elevation helper for walls/towers under
  fog/sinkhole; also exports `pickHitWorld` for cursor hit-testing
  against tilted geometry.
- **`3d/terrain.ts`** — terrain mesh + shader (consumes the blurred SDF
  + tile-data textures).
- **`3d/entities/`** — per-entity-type managers (walls, towers, houses,
  cannons, grunts, cannonballs, balloons, pits, debris, phantoms,
  tower-labels). Each exposes `update(frameCtx)`.
- **`3d/effects/`** — visual effects (bonus squares, crosshairs, fog,
  impacts, wall burns, modifier-driven effects, etc.). Each exposes
  `update(frameCtx)`.
- **`3d/sprites/`** — sprite scene builders (`*-scene.ts`) and procedural
  `CanvasTexture` builders for entity materials. See
  `3d/sprites/CONVENTIONS.md`.
- **`3d/frame-ctx.ts`** — per-frame `FrameCtx` passed to every manager.
- **`3d/light-debug.ts`**, **`3d/perf-hud.ts`** — ancillary helpers.

## The render payload contract

```ts
drawFrame(
  map: GameMap,               // static terrain (zones, rivers, tile grid)
  overlay: RenderOverlay,     // per-frame entities + UI overlays
  viewport: Viewport | null,  // camera / zoom / pan (null = full map)
  now: number,                // performance.now() — for animations
  pitch?: number,             // camera tilt (3D only; 2D ignores)
  skip3DScene?: boolean,      // banner-frame optimization (3D only)
  sunT?: number,              // battle-progress sun arc (3D only)
  pitchMax?: number,          // pitch normalization (3D only)
): void
```

The full surface (including `captureScene`, `captureSceneOffscreen`,
`setCannonFacingProvider`, etc.) is defined in
`src/shared/ui/overlay-types.ts` as `RendererInterface`.

- **`GameMap`** is built once at game start and cached in
  `runtimeState.lobby.map` / `state.map`.
- **`RenderOverlay`** is rebuilt every frame from `runtimeState.overlay`.
  Dynamic entities, dialogs, banner state, UI flags.
- **`Viewport`** comes from the camera subsystem.
- **`now`** is `performance.now()` at the start of the frame.

**Render functions are pure:** they take these inputs and draw. No
mutation, no side effects beyond canvas writes. If a render function
needs to decide "should I draw X?", the decision should be encoded in
the overlay fields by a runtime subsystem before `drawFrame` is called.

## How the runtime wires render

`src/runtime/runtime-composition.ts` is the composition root. It picks
the renderer factory (`createCanvasRenderer` for 2D, `createRender3d`
for 3D) and injects the per-frame overlay factories from
`render-ui-overlays.ts` / `render-ui-screens.ts` into the runtime's
render subsystem via a deps bag.

`src/runtime/subsystems/render.ts` then:
1. Builds the `RenderOverlay` from `runtimeState` each frame.
2. Computes the current viewport from the camera subsystem.
3. Calls `renderer.drawFrame(map, overlay, viewport, now, pitch, ...)`.
4. Updates touch controls via `input-touch-update.ts`.

## Common operations

### Add a new UI overlay
1. Add an overlay factory to `render-ui-screens.ts` (or
   `render-ui-overlays.ts` if it's a thin transformer of runtime state).
2. Export it; `runtime-composition.ts` imports + wires it via deps.
3. Add an `overlay.ui.xxx` field in
   `src/shared/ui/overlay-types.ts` and populate it from the runtime
   subsystem that owns the state.
4. Add a draw function in `render-ui.ts` (or `render-ui-settings.ts` for
   modal screens) and call it from `render-map.ts` `drawMap`.
5. If interactive, add a hit-test and wire it in the appropriate
   `runtime/subsystems/*.ts` input handler.

### Add a new world entity / visual effect
World content lives in 3D. Add a manager under `3d/entities/` (entity)
or `3d/effects/` (effect) exposing `update(frameCtx)`. Wire it into
`3d/scene.ts` `createRender3dScene` and call its `update` from
`3d/renderer.ts` `renderSceneToFBO`. Author the visual via a sprite
scene (`3d/sprites/*-scene.ts`) and/or a procedural `CanvasTexture` in
`3d/sprites/sprite-textures.ts`.

For one-shot modifier effects, prefer the `MODIFIER_EFFECT_FACTORIES`
registry in `3d/effects/modifier-effect-registry.ts` — one factory entry
adds an effect without touching the scene assembly.

## Gotchas

- **`render/` is type-only from `runtime/` except through the
  composition root.** The `typeOnlyFrom` rule in
  `.domain-boundaries.json` says runtime can import render TYPES (e.g.
  `RendererInterface`) but not render FUNCTIONS. The composition root
  (`runtime/runtime-composition.ts`) is the one place allowed to import
  render functions and thread them into the runtime via deps.

- **Terrain SDF cache is keyed by `mapVersion`.** A genuine water/grass
  geometry change (sinkhole, high_tide, low_water) bumps `mapVersion`,
  which invalidates both the 2D cache (`render-map.ts`) and the 3D shader's
  uploaded `DataTexture` (`3d/effects/terrain-sdf-texture.ts`). Frozen-river
  freeze/thaw does NOT bump `mapVersion` — water stays water, so the SDF
  shoreline is unchanged; it bumps `frozenVersion` instead, which only the
  per-tile flags texture (`3d/effects/terrain-tile-data.ts`) watches. This
  keeps a cannonball-on-ice impact from forcing a full-resolution SDF
  rebuild every frame during a frozen-river battle.

- **`drawFrame` must be called EVEN WHEN NOTHING CHANGED.** Neither the
  2D context nor the WebGL default framebuffer persists between frames
  reliably (WebGL is double-buffered). The runtime's main loop calls it
  unconditionally.

- **`skip3DScene` only affects the WebGL pipeline.** During banners the
  2D layer composites pre-captured snapshots, so re-rendering the live
  3D scene would be fully occluded. The 2D-only renderer ignores the
  flag.

- **Hit-tests are separate from drawing.** A button drawn at `(x, y)`
  needs a matching hit-test function. Keep them consistent — if you
  move a button, update both.

- **UI overlays use scaled coordinates.** The 2D canvas is drawn at a
  logical resolution and scaled to the physical canvas; hit-tests
  receive physical coords and divide by `SCALE`.

## Related reading

- **[src/runtime/subsystems/render.ts](../runtime/subsystems/render.ts)** —
  Runtime subsystem that calls into this folder.
- **[src/runtime/runtime-composition.ts](../runtime/runtime-composition.ts)** —
  Composition root that picks the renderer and wires overlay factories.
- **[src/shared/ui/overlay-types.ts](../shared/ui/overlay-types.ts)** —
  `RendererInterface`, `RenderOverlay`, `UIOverlay`, `CastleData`,
  `GameOverOverlay`, `BannerUi`, etc.
- **[src/shared/ui/theme.ts](../shared/ui/theme.ts)** — color + font
  constants shared by every draw function.
- **[3d/sprites/CONVENTIONS.md](./3d/sprites/CONVENTIONS.md)** — sprite
  scene authoring conventions.
- **[CLAUDE.md](../../CLAUDE.md)** — "Directory structure" + "Module
  layers" sections.
