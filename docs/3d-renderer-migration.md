Phase-by-phase breakdown (agent-ready)
Each task is self-contained with files, signatures, and acceptance criteria.

Phase A
A1 — Derive entity top-Y from authored bounds
Files: src/render/3d/sprites/*.ts (add a bounds helper per scene), src/render/3d/elevation.ts (consume), src/render/3d/sprites/sprite-kit.ts (shared walker).

Shape:


// sprite-kit.ts
export function measureVariantBoundsY(
  three: typeof THREE,
  build: (scratch: THREE.Group) => void,
): { minY: number; maxY: number };
Each scene exports boundsYOf(variant) using measureVariantBoundsY against its builder. elevation.ts replaces hand-tuned constants with calls like towerTopY(), cannonTopY(), houseTopY(), gruntTopY() — each cached per variant.

Acceptance: crosshair/cannonball tops match current visual (within ±1 world unit); delete TOWER_TOP_Y, CANNON_TOP_Y, HOUSE_TOP_Y, GRUNT_TOP_Y. Scenario tests pass.

Complexity: medium. ~3h.

A2 — Tag-based mesh metadata
Files: src/render/3d/sprites/cannon-scene.ts (add tags to DecorationSpec + stamp userData), src/render/3d/sprites/rampart-scene.ts (tag shield plane), src/render/3d/entities/cannons.ts (read tags), src/render/3d/entities/entity-helpers.ts (shared tag accessor).

Shape:


// entity-helpers.ts
export function subPartHasTag(part: ExtractedSubPart, tag: string): boolean;

// cannon scene decorations that used named "base" / "groundShadow" / "groundAO":
{ ..., tags: ["battle-hidden"] }

// rampart shield plane:
{ ..., tags: ["render-behind"] }
extractSubParts carries userData.tags through. cannons.ts replaces the partName === "base" || "groundShadow" || "groundAO" string switch with subPartHasTag(part, "battle-hidden"). The rampart renderOrder = -1 hack in cannons.ts:buildBucket goes away — handled by a tag-scan at wrap time.

Acceptance: battle-mode cannon hide behavior unchanged; renaming a mesh no longer silently breaks either behavior.

Complexity: medium. ~3h.

A3 — Consolidate makeMaterial + texture pattern
New file: src/render/3d/sprites/sprite-textures.ts.
Touches: cannon-scene.ts, tower-scene.ts, wall-scene.ts, house-scene.ts, debris-scene.ts.

Shape:


// sprite-textures.ts
type TextureId = "stone" | "wall_top" | "wood" | "metal_grip" | "roof" | "door" | "roof_tile";
export function buildTexturedMaterial(
  three: typeof THREE,
  spec: MaterialSpec & { texture?: TextureId },
): THREE.Material;
Registers per-texture-id lazy builders (all already exist as private getXxxTexture functions in the scenes — move them in). Each scene drops its local makeMaterial wrapper and imports buildTexturedMaterial.

Acceptance: knip reports zero dead exports from the scene files; npm run test:scenario + a manual visual smoke test show no texture regressions.

Complexity: medium-large. ~4h. Touches 5 files; risk of accidental texture drift.

A4 — Normalize manager update signatures
Files: src/render/3d/scene.ts, src/render/3d/renderer.ts, all src/render/3d/entities/*.ts, all src/render/3d/effects/*.ts, src/render/3d/terrain.ts.

Shape:


// new shared type
export interface FrameCtx {
  overlay: RenderOverlay | undefined;
  map: GameMap | undefined;
  now: number;
}

// every manager:
update(ctx: FrameCtx): void;
Managers that don't need a field just ignore it. renderer.ts builds const ctx = { overlay, map, now } once and passes it to every manager.

Acceptance: every _map / _overlay param gone; orchestration loop in renderer.ts is one array of update(ctx) calls (data-driven possible but optional).

Complexity: medium mechanical. ~2h. Lots of files, trivial changes.

Phase B
B1 — Camera tilt state machine
Files: src/runtime/runtime-camera.ts, src/runtime/runtime-phase-machine.ts (add wait-for-pitch helper), src/shared/core/game-event-bus.ts (new event), src/shared/core/battle-events.ts (event constant).

Shape:


// new event
PITCH_SETTLED: { pitch: number }

// runtime-camera.ts
type PitchState = "flat" | "tilting" | "tilted" | "untilting";
Replace beginUntilt() + isPitchSettled() + per-frame polling with a state-enum progression. Emit PITCH_SETTLED on each settle. Keep backwards compat: isPitchSettled() stays as a getter.

Acceptance: camera-state determinism test — given a scripted phase transition, pitch state transitions match expected order.

Complexity: medium. ~3h.

B2 — Pitch-settle gate for balloon animation
Files: src/runtime/runtime-phase-machine.ts:proceedToBattle, src/runtime/runtime-phase-ticks.ts.

Shape: proceedToBattle subscribes to PITCH_SETTLED (or polls) before firing BALLOON_ANIM_START. If no flights, flow unchanged. Safety timeout (1500ms) as a fallback.

Acceptance: watch a battle start at the game — tilt completes, then balloon lifts. No more balloon-before-tilt.

Complexity: small. ~1h. Depends on B1.

B3 — FBO-based capture
Files: src/render/3d/scene.ts (renderer setup), src/render/3d/renderer.ts:captureScene (read from target), delete preserveDrawingBuffer: true.

Shape:


// scene.ts
const renderTarget = new THREE.WebGLRenderTarget(W, H, { /* no mip, linear */ });
renderer.setRenderTarget(renderTarget);
renderer.render(scene, camera);
renderer.setRenderTarget(null);
renderer.render(scene, camera); // display blit

// renderer.ts
function captureScene(): ImageData {
  const pixels = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(renderTarget, 0, 0, W, H, pixels);
  // flip Y, pack into ImageData
}
Acceptance: banner capture is byte-identical (compare against a fixture); no willReadFrequently warning; FPS improvement measurable (even 1ms per frame is a win).

Complexity: medium. ~3h.

B4 — Loupe under tilt
Files: src/render/3d/renderer.ts:loupeSample, src/runtime/camera-projection.ts (new helper).

Shape:


// camera-projection.ts
export function projectWorldRectToScreen(
  state: CameraState,
  canvas: { w: number; h: number },
  worldRect: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number };
Loupe math ports to use this helper when state.pitch > 0.

Acceptance: switch to loupe during battle (tilted) — crop aligns with the crosshair's world position, not the flat-camera projection. Compare visually against tilted battle screenshot.

Complexity: medium. ~2h. Requires understanding the existing loupe math.

B5 — Auto-zoom under tilt
Files: src/runtime/runtime-camera.ts:autoZoom, src/runtime/camera-projection.ts:visibleGroundAABB (already exists — route through it).

Shape: autoZoom computes the target zone's world AABB, calls fitTileBoundsToViewport(rect, ..., pitch), which already exists with a pitch param. Confirm the call site passes currentPitch (not 0) when battle-tilted.

Acceptance: auto-zoom after a kill during battle — crop fits the remaining zone with the current tilt, not the flat projection.

Complexity: small. ~1h. Probably just a missing arg.

Phase C
C1 — Barrel pitch during flight
Files: src/render/3d/sprites/cannon-scene.ts (tag barrel sub-part), src/render/3d/entities/cannons.ts (per-instance pitch in fillBucket compose callback).

Shape:

Tag the barrel mesh with tags: ["barrel"] in each cannon variant.
cannons.ts tracks barrelPitch[playerId × cannonId] eased from 0 to launch-angle when a ball spawns from that cannon, back to 0 after it lands.
In fillBucket's compose callback, if the current sub-part has the "barrel" tag, apply an extra rotation around the breech pivot (from barrelWorldPoints() in cannon-scene.ts).
Acceptance: during a shot, the shooting cannon's barrel visibly raises and returns; other cannons unaffected.

Complexity: large. ~5h. Per-instance sub-part matrix twist is new territory. Depends on A2.

C2 — Balloon flight polish
Files: src/render/3d/entities/balloons.ts:positionFlights.

Shape: during flight, the basket rotates ±3° on its Z axis (forward tilt), envelope bobs ±2% radius on a 1.5s sine, gores rotate slowly. All derived from overlay.balloon.progress + now.

Acceptance: balloon visibly "breathes" during flight — subtle, not distracting.

Complexity: small. ~1h.

C3 — Shader polish for phantoms + walls (defer or skip)
Files: src/render/3d/entities/phantoms.ts, src/render/3d/sprites/wall-scene.ts.

Shape: custom shader material with bevel computed in fragment shader (phantoms), slight specular response (walls).

Acceptance: phantoms look sharp at all zooms; walls have subtle depth under tilt.

Complexity: large. ~6h. Defer unless other polish is done.

C4 — Banner prev-scene overlay fade-in / fade-out
Files: render-canvas.ts banner draw path (`drawBanner` or equivalent), or wherever the prev-scene snapshot is composited onto the display canvas during the sweep animation.

Shape: the banner transition currently pops the semi-transparent prev-scene overlay on in a single frame — the first sweep frame is already at full intended alpha. Ramp alpha from 0 → target over the first ~80ms of the sweep, and back to 0 over the last ~80ms. Target alpha stays the same in the middle. Just a multiplier on `ctx.globalAlpha` (or the prev-scene layer's source alpha) keyed off banner progress.

Acceptance: starting a banner no longer feels like a flash; the prev-scene layer ghosts in, stays for the sweep, and ghosts out. Verify visually — no pop.

Complexity: small. ~1h.

Phase D
D1 — Perf baseline + bench gate
Files: scripts/bench-render.ts (new), package.json, test/bench-scenarios.ts (fixtures).

Shape: runs 60s of deterministic game state (known seed, known phase mix), measures frame time via performance.now() deltas, produces JSON with p50/p95/p99 per renderer. Fails the run if 3D p95 > 1.1 × 2D p95.

Acceptance: command runs in CI; numbers are reproducible (±3%).

Complexity: medium-large. ~4h.

D2 — Flip default to 3D
Files: src/shared/ui/player-config.ts:GameSettings (change default), docs/3d-renderer-migration.md.

Shape: rendererKind: "3d" as default. /set renderer 2d remains available. Changelog entry.

Acceptance: fresh install loads 3D; existing users keep their stored preference.

Complexity: trivial. ~30min.

D3 — Delete 2D renderer
Files (delete): src/render/render-map.ts, src/render/render-effects.ts, src/render/render-sprites.ts, scripts/generate-sprites.html, all associated tests.

Files (modify): src/render/render-canvas.ts (remove 2D branch), src/render/3d/renderer.ts (inline what used to be in render-canvas), src/runtime/runtime-render.ts (drop renderer-kind branching).

Shape: large pure subtraction. Before deletion, audit that every 2D-unique helper is either reimplemented in 3D or genuinely unused.

Acceptance: npm run build passes; npm run test:scenario passes; ~5k LOC gone. No visual regression.

Complexity: large but low-risk (it's pure deletion). ~4h. Must come after D1/D2 ship and bake.

Phase E
E1 — Visual regression suite
Files: test/vr/*.spec.ts (new), test/vr-snapshots/ (new), scripts/update-vr-baseline.ts.

Shape: Playwright + createE2EScenario; take a pixel-perfect screenshot at defined checkpoints (scene-enter, banner-midpoint, battle-firing). Diff with baseline via pixelmatch (0.1% tolerance). Pre-commit gate.

Acceptance: running with no code change shows zero diffs; intentional change needs --update-baseline.

Complexity: large. ~6h. Playwright setup + 6-10 scenarios.

E2 — Scenario suite in 3D mode
Files: test/scenario.test.ts (parametrize).

Shape: every createScenario({...}) call gets a rendererKind pass, each test runs twice (2D + 3D). Any test that only exercises overlay state auto-passes.

Acceptance: both variants pass; failures reveal real 3D-only bugs.

Complexity: small. ~1h.

E3 — Mobile perf floor
Files: scripts/bench-render.ts extension, CI config.

Shape: mobile profile (throttled CPU, 375×812 viewport). Asserts ≥50fps median during BATTLE.

Acceptance: CI gate; regressions caught before merge.

Complexity: medium. ~2h. Depends on D1.

Recommended dispatch order
Agent-parallel-friendly groups (each group = agents that can run concurrently):

Group 1: A4 (signatures) — simple mechanical. Can run while planning later phases.
Group 2: A1 (bounds) + A2 (tags) — same subsystem, sequential.
Group 3: A3 (textures) — big diff, run alone.
Group 4: B1 (state machine) + B3 (FBO) — independent.
Group 5: B2 (gate) after B1; B4 (loupe) + B5 (autozoom) — camera-projection work, can parallel.
Group 6: C1 (barrel) — substantial, run alone.
Group 7: E1 + E2 — testing harness.
Group 8: D1 → D2 → D3 sequentially, each gated on the prior shipping.
