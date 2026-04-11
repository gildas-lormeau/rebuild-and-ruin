# `src/render/` — Canvas rendering + UI overlays

The **render** domain owns everything that paints pixels: the Canvas
2D renderer, the sprite atlas, map drawing (terrain + entities),
cannon/tower sprites, visual effects (phantoms, loupes, cannonballs),
and the UI overlay builders (options, controls, lobby, banner,
status bar, game-over).

Render code **never mutates game state**. Every function here takes
a render payload (map + overlay + viewport) and draws it. The game
decides what to draw; render decides how. If a render function seems
to need to mutate state, the fix is usually to lift the decision out
to the runtime subsystem and pass the result in.

## Read these first

1. **[render-canvas.ts](./render-canvas.ts)** — `createCanvasRenderer(canvas)`
   — the `RendererInterface` implementation. Exposes
   `drawFrame(map, overlay, viewport, now)`. Every draw call goes
   through this. **Start here to see what a render payload looks
   like.**

2. **[render-map.ts](./render-map.ts)** — `drawTerrain()`,
   `drawEntities()` — the bulk of the rendering. Also owns
   `warmMapCache()`, which pre-rasterizes the static terrain layer
   for fast re-draws.

3. **[render-composition.ts](./render-composition.ts)** — UI overlay
   composition helpers: banner UI, online overlay, render summary,
   status bar, lobby layout, hit-tests for the game-over / life-lost /
   upgrade-pick dialogs. The **glue between runtime state and UI
   draw calls**.

## File categories

### Core renderer
- **`render-canvas.ts`** — Canvas 2D implementation of
  `RendererInterface`. Exposes `drawFrame`, `warmMapCache`,
  `clientToSurface`, `screenToContainerCSS`, `eventTarget`, `container`.
- **`render-sprites.ts`** — Sprite atlas loader. `loadAtlas()`
  fetches + parses the PNG sprite sheet. `drawSprite()` paints a
  sprite by name.
- **`render-snapshot.ts`** — Pre-render snapshot construction. The
  renderer calls this internally to build the per-frame draw list
  from the overlay + viewport.

### Map + entity layers
- **`render-map.ts`** — Terrain tile drawing (grass/water/sand/wall),
  entity drawing (grunts, cannonballs, castles, houses, bonus
  squares, modifier tiles). Caches the static terrain layer via
  `warmMapCache()` for fast redraws during BATTLE phase.
- **`render-towers.ts`** — Tower rendering: alive/dead state, color
  tinting by owner, selection highlight.
- **`render-effects.ts`** — Phantom preview drawing (cannon
  placement preview, piece placement preview), upgrade lockout
  timer animation, modifier reveal animation.
- **`render-loupe.ts`** — Mobile loupe (magnifier) overlay for
  precision tile selection on touch devices. Triggered by long-press.

### UI overlays (options / controls / lobby / banner / etc.)
- **`render-ui.ts`** — Top-level UI overlay composer. Used by the
  runtime render subsystem to produce the per-frame overlay.
- **`render-ui-screens.ts`** — Screen overlay builders: options,
  controls, lobby, banner, life-lost dialog, upgrade-pick dialog,
  game-over panel. Each returns a structured overlay for the
  renderer to draw.
- **`render-ui-settings.ts`** — Options + controls screen rendering,
  plus hit-testing functions (`controlsScreenHitTest`,
  `optionsScreenHitTest`). The runtime uses the hit-tests to route
  clicks.
- **`render-ui-theme.ts`** — Shared constants, types, and drawing
  primitives for all `render-ui-*.ts` files: drawButton,
  drawPanel, standard colors, text sizes.
- **`render-composition.ts`** — Composition root for UI overlays.
  Builds banner UI, status bar, render summary message, online
  overlay. Provides hit-testers for life-lost / upgrade-pick /
  game-over dialogs.

## The render payload contract

Render functions consume three things:

```ts
drawFrame(
  map: GameMap,           // static terrain (zones, rivers, tiles)
  overlay: RenderOverlay, // per-frame entities + UI overlays
  viewport: Viewport | null, // camera / zoom / pan (or null for default)
  now: number,            // frame timestamp for animation
): void
```

- **`GameMap`** is built once at game start and cached in
  `runtimeState.lobby.map` / `state.map`. Static terrain tiles,
  zone bounds, tower positions.
- **`RenderOverlay`** is rebuilt every frame from
  `runtimeState.overlay`. Dynamic entities (grunts, cannonballs,
  walls, castles with damage state), plus UI overlay flags (show
  banner? show options? show life-lost dialog?).
- **`Viewport`** comes from the camera subsystem. If `null`, use
  the default (full map, no zoom).
- **`now`** is `performance.now()` at the start of the frame.
  Render uses it for animations (banner cross-fade, cannonball
  trail, score delta pulse).

**Render functions are pure:** they take these inputs and draw. No
mutation, no side effects beyond canvas writes. If a render
function needs to decide "should I draw X?", the decision should
be encoded in the overlay fields by a runtime subsystem before
`drawFrame` is called.

## How the runtime wires render

The runtime has a `runtime-render.ts` subsystem that:

1. Builds the `RenderOverlay` from `runtimeState` each frame.
2. Computes the current viewport from the camera subsystem.
3. Calls `renderer.drawFrame(map, overlay, viewport, now)`.
4. Updates touch controls via `input-touch-update.ts`.

The composition root (`runtime-composition.ts`) wires a bunch of
`render/*` factory functions into the render subsystem via the
`deps` bag: `createBannerUi`, `createOnlineOverlay`,
`createStatusBar`, `createLobbyOverlay`, `createOptionsOverlay`,
`createControlsOverlay`, `visibleOptions`, `updateSelectionOverlay`.
These factories return the overlay structures that get merged into
the per-frame render payload.

## Common operations

### Add a new UI overlay
1. Add an overlay factory function to `render-ui-screens.ts` (or a
   new file if it's large).
2. Export it so `runtime-composition.ts` can import + inject it.
3. Add a render slot in the composition (via the existing deps
   pattern).
4. Add a hit-test function if the overlay has interactive elements;
   wire it in `runtime-render.ts` or `runtime-input.ts`.

### Add a new visual effect
Effects usually live in `render-effects.ts`. Add a new draw
function that takes an overlay field (e.g. `overlay.myNewEffect`)
and draws it. Then add the overlay field to `RenderOverlay` in
`src/shared/ui/overlay-types.ts` and populate it in whichever
runtime subsystem owns the state.

### Add a new sprite
1. Update the sprite atlas PNG + its JSON manifest.
2. Add a draw call using `drawSprite("new-name", x, y)`.
3. `render-sprites.ts` handles loading and caching.

### Debug a missing draw call
Add logging inside `drawFrame` in `render-canvas.ts` — it's called
once per frame. If the per-frame call is happening but nothing
appears, the issue is in the overlay (missing data from the
runtime). If the call isn't happening, the issue is upstream in
`runtime-render.ts` or the main loop.

## Gotchas

- **`render/` is type-only from `runtime/` except through the
  composition root.** The `typeOnlyFrom` rule in
  `.domain-boundaries.json` says runtime can import render TYPES
  (e.g., `RendererInterface`) but can't import render FUNCTIONS.
  The composition root is the one file allowed to import render
  functions and thread them into the runtime via deps. Don't try
  to import `render-composition.ts` from a runtime subsystem — the
  lint will reject it.

- **Terrain caching is a correctness gotcha.** `warmMapCache(map)`
  pre-rasterizes the static terrain layer. If you mutate the map
  (e.g., high-tide modifier adds water tiles), you must re-warm the
  cache. Existing modifier code does this; new modifiers must too.

- **Sprite atlas is fetched over HTTP.** Loading is async; the
  entry point awaits `loadAtlas()` before showing the game. In
  tests, the atlas is stubbed in `test/runtime-headless.ts`.

- **`drawFrame` must be called EVEN WHEN NOTHING CHANGED.** The
  canvas context doesn't persist between frames — if you skip a
  frame, the previous frame's contents vanish. The runtime's main
  loop calls it unconditionally; don't try to optimize by skipping
  frames on identity-unchanged state.

- **Hit-tests are separate from drawing.** A button drawn at
  `(x, y)` needs a matching hit-test function that checks if a
  click at `(mx, my)` is inside the button rect. Keep them
  consistent — if you change a button position, update both.

- **UI overlays use scaled coordinates.** The canvas is drawn at
  a logical resolution (MAP_PX_W × MAP_PX_H) and scaled to the
  physical canvas. Hit-tests receive physical coords and divide by
  SCALE. If your new UI element misfires on high-DPR displays, the
  scale factor is probably wrong.

## Related reading

- **[src/runtime/runtime-render.ts](../runtime/runtime-render.ts)** —
  The runtime subsystem that calls into this folder.
- **[src/shared/ui/overlay-types.ts](../shared/ui/overlay-types.ts)**
  — `RenderOverlay`, `EntityOverlay`, `CastleData`, `GameOverOverlay`,
  `RendererInterface`. The types render consumes.
- **[src/shared/ui/theme.ts](../shared/ui/theme.ts)** — Color
  constants used by all render files.
- **[src/shared/ui/canvas-layout.ts](../shared/ui/canvas-layout.ts)**
  — Letterbox math for the canvas aspect ratio.
- **[CLAUDE.md](../../CLAUDE.md)** — "Render" references under the
  domain boundaries section.
