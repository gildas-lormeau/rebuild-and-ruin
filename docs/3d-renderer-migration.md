3D renderer migration — status

The migration from the 2D-only canvas renderer to a Three.js scene is functionally
complete. `createRender3d` is the only renderer in production: it owns
`#world-canvas` (WebGL) and creates a 2D UI canvas internally for HUD/dialog
overlays and banner snapshot replay.

Where things live now
- World content (terrain, walls, towers, cannons, grunts, houses, debris,
  cannonballs, balloons, pits, all four burn effects, impacts, crosshairs,
  phantoms, fog, water waves, sinkhole tint, bonus pulse) — `src/render/3d/scene.ts`.
- 2D UI canvas (timers, placement cursor, score deltas, modifier-reveal flash,
  banner chrome, dialogs, modals, banner snapshot replay, combo floats,
  announcement, status bar) — `src/render/render-map.ts` + `src/render/render-ui*.ts`.
- Banner prev/new-scene snapshots composite WebGL world + 2D UI into a single
  bitmap; `captureScene` (visible) and `captureSceneOffscreen` (FBO readback)
  in `src/render/3d/renderer.ts`.

Shipped
- A1 boundsYOf per scene; `elevation.ts` consumes them — sprite top-Y is no
  longer hand-tuned.
- A2 tag-based mesh metadata (`battle-hidden`, `render-behind`) on cannon /
  rampart sub-parts.
- A3 `buildTexturedMaterial` + `sprite-textures.ts` — every scene shares one
  material builder.
- A4 `FrameCtx` — every manager takes a single `update(ctx)`.
- B1 pitch state machine (`getPitchState() -> "flat" | "tilting" | "tilted" | "untilting"`).
- B2 phase-ticks gates on `getPitchState() === "flat"` before flow-critical work.
- B3 FBO-based capture via `readRenderTargetPixels` (no `preserveDrawingBuffer`).
- B4 / B5 pitch-aware projection in `runtime/camera-projection.ts`; loupe and
  auto-zoom thread the current pitch.
- C1 per-instance barrel pitch on the firing cannon.
- D2 / D3 functionally complete — there is no `rendererKind` setting and no
  2D-only branch in production. `render-map.ts` survives as the UI/overlay
  layer (intentional, not a missing migration step).

Remaining
- C2 balloon flight breathing — small visual polish.
- C3 phantom + wall shader polish — explicitly deferred.
- C4 banner prev-scene fade-in/fade-out — small.
- D1 perf benchmark + CI gate — `scripts/bench-render.ts` does not exist.
- E1 visual regression suite — `test/vr/` does not exist.
- E3 mobile perf floor — depends on D1.
