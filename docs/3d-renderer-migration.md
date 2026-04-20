# 3D renderer migration plan

Goal: replace the canvas 2D world renderer with a three.js-based live 3D
renderer, shipped behind a feature flag and flipped to default once parity
is verified. UI layer stays 2D.

## Strategy: hybrid stacked canvases

Two canvases, same DOM size:

- **`#world-canvas`** (z=0, WebGL) — terrain, walls, cannons, towers,
  grunts, cannonballs, balloons, pits, debris, battle effects.
- **`#canvas`** (z=1, 2D, existing) — banners, HUD, dialogs, loupe,
  upgrade-pick, game-over, life-lost. Unchanged.

Rationale: UI is a polished, working product. Canvas text rendering
(`fillText`/`measureText`) has no clean three.js equivalent; rewriting
the UI in Troika/baked textures is 1-2 weeks of work with no visual gain.
The "3D world" benefit is entirely about tile rendering.

## Guardrails

- `rendererKind: '2d' | '3d'` setting, localStorage-persisted, defaults
  to `'2d'` until Phase 9. Toggle hidden until Phase 9 (dev-only key combo).
- 2D renderer stays untouched the entire migration.
- Every phase merges with both renderers shippable. Pre-commit hooks
  (tsc, layers, tests) must pass at every merge.
- No changes to `src/game/`, `src/ai/`, `src/controllers/`, `src/shared/`
  (except settings), `src/online/`, `test/`, or `server/`.
- Three.js version: stay at `0.160` (matches sprite previews).
- No shadow maps — pixel-art aesthetic doesn't benefit.

## Architectural seams

Already in place (no changes required):

- `RendererInterface` in `src/render/render-canvas.ts` — abstract
  `drawFrame(state)` entry point. `createRender3d()` plugs in alongside
  `createRenderCanvas()`.
- Headless test runtime already stubs the renderer, so scenario and
  determinism tests are renderer-agnostic.
- `Viewport` from `src/runtime/runtime-camera.ts` — renderer-neutral
  output (zone, pan, zoom). 3D camera consumes it the same way 2D does.
- `GameState` is the sole source of truth for what's on screen. Cannonball
  positions, grunt positions, impact timelines, pit state, etc. are all
  state fields — renderer is stateless beyond transient animation
  interpolation.

New seams this migration introduces:

- `src/render/3d/sprites/` — scene builders live here already (moved from
  `tmp/sprites-design/` in the pre-migration refactor). Still `.mjs`;
  convert to `.ts` file-by-file as each is integrated.
- `src/render/3d/renderer.ts` — the `createRender3d()` factory.
- `src/render/3d/entities/` — per-entity-type mesh managers (walls, cannons,
  grunts, etc.) that read game state and update three.js meshes.

---

## Phase 0 — Infrastructure

**Deliverable**: 3D canvas exists behind the 2D canvas, feature-flagged,
renderer factory scaffolded, game fully playable in 2D mode with no
regressions; 3D mode shows transparent WebGL canvas with 2D UI over it.

**Files**:
- `package.json` — add `three@^0.160`.
- `src/shared/core/settings.ts` — add `rendererKind: '2d' | '3d'` field.
- `src/shared/core/game-constants.ts` — default `'2d'`.
- `index.html` — add `<canvas id="world-canvas">` behind existing
  `<canvas id="canvas">`, absolute-positioned, same dims.
- new `src/render/3d/renderer.ts` — `createRender3d(): RendererInterface`.
  `drawFrame` is a no-op that clears the WebGL canvas.
- new `src/render/3d/scene.ts` — scene root, camera placeholder, lights.
- `src/runtime/runtime-composition.ts` — pick renderer by setting.

**Gate**: flipping the setting in devtools switches renderers cleanly.
Game remains playable end-to-end in both modes. Pre-commit hooks pass.

---

## Phase 1 — Camera + pixel discipline

**Deliverable**: ortho camera correctly sized to the map, accepting
`Viewport` updates from `runtime-camera.ts`. Pinch/D-pad zoom works in
3D mode. Empty colored ground plane visible for debug.

**Files**:
- new `src/render/3d/camera.ts` — ortho camera sized to map world units
  (1 world unit = 1 game-1× pixel). `updateCameraFromViewport(camera, vp)`.
- new `src/render/3d/pixel-snap.ts` — `pixelSnap(vec)` helper.
- new `src/render/3d/lights.ts` — hemispheric + subtle directional.
- `src/render/3d/renderer.ts` — integrate camera + lights.

**Gate**: 3D mode shows a placeholder ground plane sized correctly;
pinch/D-pad/keyboard zoom adjust the camera to match 2D mode.

---

## Phase 2 — Terrain

**Deliverable**: terrain renders in 3D for every map (grass, water,
interior, bonus, frozen water, pit marker placeholder). Water animates.

**Files**:
- new `src/render/3d/terrain.ts` — builds tile grid as `PlaneGeometry`
  with per-tile UVs into a small tile atlas, or per-vertex colors.
  Water is a separate material with UV scroll.
- `src/render/3d/renderer.ts` — instantiate terrain; rebuild on
  `mapVersion` change (parity with 2D's `WeakMap` cache).

**Gate**: every `map-example.txt` variant renders with correct tile
types, matching 2D after quantization. Water animates. Map edits
(territory flips, wall destruction) rebuild terrain cleanly.

---

## Phase 3 — Static entities

**Deliverable**: walls, towers, houses, dead-cannon debris, tower debris
all render at correct positions with correct player colors. Convert the
relevant `*-scene.mjs` files to `.ts` as they integrate (the TS
conversion item from the pre-migration refactor happens here, file by
file, as real integration exercises the types).

**Files**:
- new `src/render/3d/entities/walls.ts` — `InstancedMesh` for walls
  (~80-120 per battle). Mask-based variant selection.
- new `src/render/3d/entities/towers.ts` — home + secondary variants,
  player-tinted materials.
- new `src/render/3d/entities/houses.ts`.
- new `src/render/3d/entities/debris.ts` — cannon/tower/wall debris.
- Convert `src/render/3d/sprites/wall-scene.mjs` → `.ts`.
- Convert `src/render/3d/sprites/tower-scene.mjs` → `.ts`.
- Convert `src/render/3d/sprites/house-scene.mjs` → `.ts`.
- Convert `src/render/3d/sprites/debris-scene.mjs` → `.ts`.
- Convert `src/render/3d/sprites/sprite-kit.mjs`,
  `sprite-materials.mjs`, `sprite-bounds.mjs` → `.ts` (they're
  dependencies of the above).

**Gate**: a static map snapshot (mid-build) renders with castles, walls,
houses, and any existing debris in correct positions and player colors.

---

## Phase 4 — Dynamic entities

**Deliverable**: cannons (all 5 modes), grunts, cannonballs (3 types),
pits (3 states), balloons (base/flight) all render and update from game
state per frame.

**Files**:
- new `src/render/3d/entities/cannons.ts` — variant by `CannonMode`
  (default tier_1/2/3, rampart, super_gun, mortar). Rotation by facing.
- new `src/render/3d/entities/grunts.ts` — facing → variant. `InstancedMesh`.
- new `src/render/3d/entities/cannonballs.ts` — scale by altitude
  (parabolic from `remaining/totalDist`). Variant by ball type.
- new `src/render/3d/entities/pits.ts` — 3 state variants per pit.
- new `src/render/3d/entities/balloons.ts` — base ↔ flight swap.
- Convert the corresponding `*-scene.mjs` → `.ts` in `src/render/3d/sprites/`.

**Gate**: full battle renders correctly in 3D. Side-by-side with 2D for
visual comparison.

---

## Phase 5 — Input coordinate translation

**Deliverable**: clicks, taps, and pinches map to the correct tiles in
3D mode at every zoom level and camera state.

**Files**:
- `src/render/render-layout.ts` (or new `src/input/input-layout.ts`) —
  add 3D-mode `screenToTile` using ortho camera raycast against the
  ground plane.
- `src/input/input-mouse.ts`, `src/input/input-touch-canvas.ts` — route
  through the new translator when `rendererKind === '3d'`.

**Gate**: castle select, wall placement, cannon placement, firing aim
all work in 3D mode at every zoom level, identical to 2D.

---

## Phase 6 — Battle effects

**Deliverable**: impact flashes, wall-damage transitions, frozen-tile
visual, fog-of-war (if applicable) all render correctly in 3D.

**Files**:
- new `src/render/3d/effects.ts` — impact billboards with phase timeline
  driven by state timestamps (matches 2D behavior).
- Extend `src/render/3d/terrain.ts` for frozen-tile tint pass.
- Extend `src/render/3d/renderer.ts` for fog-of-war overlay plane (if
  the mode is active in the settings in use at battle time).

**Gate**: battle impacts visually readable; scoring flashes and
territory changes animate; fog-of-war masks unrevealed zones.

---

## Phase 7 — Phase-specific camera tilt

**Deliverable**: CASTLE_SELECT (+ RESELECT) and BATTLE phases use a
tilted 3/4 camera; other phases top-down. Smooth transitions.

**Files**:
- `src/render/3d/camera.ts` — add tilt target state + interpolator
  (~400-600ms tween on phase change).
- `src/runtime/runtime-render.ts` or similar — emit phase change signal
  to camera.

**Gate**: phase transitions show expected tilt changes. Pinch zoom
continues to work at any tilt.

---

## Phase 8 — Perf

**Deliverable**: steady 60fps on desktop and target mobile at peak
battle load (2-3 zones, 20+ cannons, 30+ grunts, 100+ walls).

**Files**: scattered — `InstancedMesh` adoption across
`entities/walls.ts`, `entities/grunts.ts`, `entities/debris.ts`.
- Per-frame diff: only update instance matrices/materials that changed.
- Profile on mid-tier Android + iOS devices.

**Gate**: 60fps steady at peak battle; frame-time budget documented.

---

## Phase 9 — Parity review + expose toggle

**Deliverable**: zero visual regressions vs 2D; toggle surfaced in
options screen for dogfooding; community playtest approval.

**Files**:
- `src/render/render-ui-settings.ts` — surface the `rendererKind`
  toggle in the options screen.

**Review checklist** (manual QA, per map-example, per phase):
- Fog-of-war reveals at correct timing
- Balloon animation

**Gate**: playtest approval; ready to flip default.

---

## Phase 10 — Flip default, retire 2D

**Deliverable**: 3D is the default; 2D stays opt-in for one release;
retire 2D afterward.

**Immediate files**:
- `src/shared/core/game-constants.ts` — default flipped to `'3d'`.

**Follow-up release** (after 2-4 weeks of stability):
- Delete `src/render/render-map.ts`, `render-sprites.ts`,
  `render-towers.ts`, `render-effects.ts`, `render-canvas.ts` (2D
  implementations only — keep `render-ui.ts`, `render-layout.ts`).
- Delete `tmp/sprites-design/` previews, `assembly-scene.mjs`.
- Simplify or delete `test/recording-canvas.ts` if unused.
- Retire sprite atlas PNG if 3D renderer doesn't consume it.
- Remove `rendererKind` setting.

---

## Timeline estimate

| Phase | Est. work | Cumulative |
|---|---|---|
| 0 | 0.5 week | 0.5 w |
| 1 | 0.5 week | 1 w |
| 2 | 0.5-1 week | 1.5-2 w |
| 3 | 1-2 weeks | 2.5-4 w |
| 4 | 1-2 weeks | 3.5-6 w |
| 5 | 0.5 week | 4-6.5 w |
| 6 | 0.5-1 week | 4.5-7.5 w |
| 7 | 0.5 week | 5-8 w |
| 8 | 1 week | 6-9 w |
| 9 | 1 week | 7-10 w |
| 10 | +2-4 weeks stability | — |

**Total core work: ~5-8 weeks**, plus 2-4 weeks of production stability
before retiring 2D.

---

## Files / subsystems not touched

- `src/game/*` — simulation, phase logic, spatial algorithms.
- `src/ai/*` — AI strategy.
- `src/controllers/*` — input→intent conversion.
- `src/shared/*` — types, constants, protocol (except one settings field).
- `src/online/*` — checkpoint sync is state-level, renderer-independent.
- `test/*` — `createScenario` already mocks the renderer. E2E ASCII
  renderer is state-only, no changes needed.
- `server/` — Deno deploy target, no rendering.
- `src/render/render-ui.ts`, `render-ui-*.ts`, `render-layout.ts`,
  `render-loupe.ts` — the 2D UI layer stays.

---

## Open follow-ups (track during migration)

- Loupe implementation over 3D world: may need `readPixels` from the
  WebGL canvas or a separate small 3D render pass at high zoom. Decide
  when Phase 1 lands.
- Shadow-less aesthetic: if playtesters feel 3D looks "flat", consider
  a cheap fake-shadow ground pass (AO discs per entity, already in
  sprite designs). No true shadow maps.
- Shader patching for wall textures.
- Phantoms as full-sprite ghosts: phantoms currently render as plain
  semi-transparent boxes (green/red tint). Upgrade to the full
  `buildWall`/`buildCannon` mesh with a transparent material override
  so the cursor preview visually matches the locked result. Target:
  before Phase 9 parity review — the plain-box → sprite snap at lock
  is the most visible remaining rough edge.
