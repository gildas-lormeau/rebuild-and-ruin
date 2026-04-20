/**
 * sprites-pipeline.mjs — shared UI/render pipeline for the
 * scripts/build-sprite-3d.html debug page.
 *
 * The HTML shell handles scene selection (dropdown over every sprite
 * scene in `src/render/3d/sprites/`) and dynamically imports the chosen
 * module. It then calls `createSpritePage({ THREE, variants, palette,
 * buildScene })` on this module to render every variant in side-by-side
 * panes with a pixel grid overlay.
 *
 * Per-variant pane layout (top → bottom):
 *   1. Internal render canvas (4× the output size — supersampled for AA).
 *   2. Game-2× canvas (canvasPx × canvasPxH). Palette-quantized.
 *   3. Game-1× canvas (half of game-2×).
 *   4. 8× zoom of the game-2× canvas + a 1-pixel grid overlay so the
 *      user can talk to the assistant in integer pixel coordinates
 *      ("move the south wall 1 unit down" etc).
 *
 * Controls (top of the page):
 *   - sprite picker dropdown (the page wires this).
 *   - pixel-grid toggle (always-on while hovered, sticky when checked).
 *   - top-down / 3/4 view buttons.
 *   - rotate ±45° (snaps to 8 cardinal/diagonal yaws).
 *
 * This module owns the WebGLRenderer, scene, lights, ortho camera, and
 * the per-variant DOM. It does NOT own the scene picker, the dropdown,
 * or any sprite-specific knowledge — that all lives in the HTML shell.
 */

const sideMap = (THREE) => ({
  front: THREE.FrontSide,
  back: THREE.BackSide,
  double: THREE.DoubleSide,
});

export function createSpritePage(opts) {
  const { THREE, variants, palette, buildScene } = opts;
  if (!THREE) throw new Error("createSpritePage: THREE is required");
  if (!Array.isArray(variants)) {
    throw new Error("createSpritePage: variants[] required");
  }
  if (!Array.isArray(palette)) {
    throw new Error("createSpritePage: palette[] required");
  }
  if (typeof buildScene !== "function") {
    throw new Error("createSpritePage: buildScene(scene, variant) required");
  }

  renderPaletteSwatches(palette);

  const ctx = {
    THREE,
    sideMap: sideMap(THREE),
    palette,
    quantize: (imageData) => quantizeImage(imageData, palette),
  };

  const state = { currentView: "top", rotationDeg: 0 };
  const handles = variants.map((variant) =>
    makeVariantPane(ctx, variant, buildScene),
  );

  function applyAll() {
    for (const handle of handles) applyView(THREE, handle, state);
    for (const handle of handles) renderVariant(handle, ctx);
  }
  applyAll();

  const viewLabel = document.getElementById("viewLabel");
  function updateLabel() {
    viewLabel.textContent = state.currentView === "top"
      ? "top-down"
      : `3/4 · yaw ${state.rotationDeg}°`;
  }
  updateLabel();

  document.getElementById("renderAll").onclick = () => {
    for (const handle of handles) renderVariant(handle, ctx);
  };
  document.getElementById("viewTop").onclick = () => {
    state.currentView = "top";
    applyAll();
    updateLabel();
  };
  document.getElementById("viewTilted").onclick = () => {
    state.currentView = "tilted";
    applyAll();
    updateLabel();
  };
  document.getElementById("rotLeft").onclick = () => {
    state.rotationDeg = (state.rotationDeg - 45 + 360) % 360;
    if (state.currentView !== "tilted") state.currentView = "tilted";
    applyAll();
    updateLabel();
  };
  document.getElementById("rotRight").onclick = () => {
    state.rotationDeg = (state.rotationDeg + 45) % 360;
    if (state.currentView !== "tilted") state.currentView = "tilted";
    applyAll();
    updateLabel();
  };
  document.getElementById("gridToggle").onchange = (e) => {
    document.body.classList.toggle("show-grid", e.target.checked);
  };

  return {
    handles,
    rerenderAll: () => {
      for (const handle of handles) renderVariant(handle, ctx);
    },
    /** Tear down every WebGL context + DOM node this page created so a
     *  scene switch can rebuild from a clean slate without leaking. */
    dispose: () => {
      const row = document.getElementById("variantsRow");
      while (row.firstChild) row.removeChild(row.firstChild);
      for (const h of handles) h.renderer.dispose();
      const out = document.getElementById("paletteOut");
      while (out.firstChild) out.removeChild(out.firstChild);
    },
  };
}

// ---------- internals -------------------------------------------------

function renderPaletteSwatches(palette) {
  const out = document.getElementById("paletteOut");
  if (!out) return;
  for (const [r, g, b] of palette) {
    const sw = document.createElement("span");
    sw.style.cssText =
      `display:inline-block;width:14px;height:14px;background:rgb(${r},${g},${b});border:1px solid #000;vertical-align:middle;margin:0 2px;`;
    out.append(sw);
  }
}

function quantizeImage(imageData, palette) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) {
      d[i + 3] = 0;
      continue;
    }
    let best = 0;
    let bd = Infinity;
    for (let p = 0; p < palette.length; p++) {
      const [r, g, b] = palette[p];
      const dr = d[i] - r;
      const dg = d[i + 1] - g;
      const db = d[i + 2] - b;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bd) {
        bd = dist;
        best = p;
      }
    }
    d[i] = palette[best][0];
    d[i + 1] = palette[best][1];
    d[i + 2] = palette[best][2];
    d[i + 3] = 255;
  }
}

function makeVariantPane(ctx, variant, buildScene) {
  const { THREE } = ctx;
  const out2xW = variant.canvasPx;
  const out2xH = variant.canvasPxH ?? variant.canvasPx;
  const out1xW = Math.floor(out2xW / 2);
  const out1xH = Math.floor(out2xH / 2);
  const internalW = out2xW * 4;
  const internalH = out2xH * 4;
  const zoomW = out2xW * 8;
  const zoomH = out2xH * 8;
  const aspect = out2xH / out2xW;
  const subtitle = `${out2xW}×${out2xH} → ${out1xW}×${out1xH}`;

  const pane = document.createElement("div");
  pane.className = "pane";
  pane.innerHTML = `
    <h2>${variant.label} <small>${subtitle}</small></h2>
    <div class="tiny">
      <span>internal ${internalW}×${internalH}</span>
      <span class="internalSlot"></span>
    </div>
    <div class="tiny">
      <span>${out2xW}×${out2xH} (game 2×)</span>
      <canvas class="out2x" width="${out2xW}" height="${out2xH}"></canvas>
      <span>${out1xW}×${out1xH} (game 1×)</span>
      <canvas class="out1x small" width="${out1xW}" height="${out1xH}"></canvas>
    </div>
    <div class="stage">
      <canvas class="zoom" width="${zoomW}" height="${zoomH}"></canvas>
      <canvas class="grid gridcanvas" width="${zoomW}" height="${zoomH}"></canvas>
    </div>
    <button class="tinybtn">Re-render ${variant.label}</button>
  `;
  document.getElementById("variantsRow").append(pane);

  const out2x = pane.querySelector(".out2x");
  const out1x = pane.querySelector(".out1x");
  const zoom = pane.querySelector(".zoom");
  const gridCanvas = pane.querySelector(".gridcanvas");
  const internalSlot = pane.querySelector(".internalSlot");
  const rerenderBtn = pane.querySelector("button.tinybtn");

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setSize(internalW, internalH);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.width = internalW + "px";
  renderer.domElement.style.height = internalH + "px";
  renderer.domElement.style.imageRendering = "pixelated";
  renderer.domElement.style.border = "1px solid #444";
  internalSlot.append(renderer.domElement);

  const scene = new THREE.Scene();
  // Three-point-ish lighting — same rig the original sprite-design pages
  // used. Independent of the in-game lighting so the debug previews stay
  // stable while the main lights.ts iterates.
  scene.add(new THREE.HemisphereLight(0xccccff, 0x403020, 0.4));
  const keyLight = new THREE.DirectionalLight(0xffd8a8, 0.9);
  keyLight.position.set(-1.5, 2, 2.5);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xaabbcc, 0.3);
  fillLight.position.set(1.5, 1, -0.5);
  scene.add(fillLight);

  buildScene(scene, variant);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);

  const handle = {
    variant,
    renderer,
    scene,
    camera,
    out2x,
    out1x,
    zoom,
    out2xW,
    out2xH,
    out1xW,
    out1xH,
    internalW,
    internalH,
    aspect,
  };

  // Grid uses game-1× pixel resolution: a 2×2-tile sprite (e.g. tower)
  // gets 32×32 cells = two 16×16 tile-sized regions. Per-game-2× pixel
  // would double the line density and blur tile structure.
  drawGrid(gridCanvas, out1xW, out1xH);
  rerenderBtn.onclick = () => renderVariant(handle, ctx);
  return handle;
}

function applyView(THREE, handle, state) {
  const cam = handle.camera;
  cam.zoom = 1;
  const a = handle.aspect;
  if (state.currentView === "top") {
    cam.left = -1;
    cam.right = 1;
    cam.top = a;
    cam.bottom = -a;
    cam.position.set(0, 3, 0);
    cam.up.set(0, 0, -1);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    return;
  }
  const v = a * 1.15;
  cam.left = -1;
  cam.right = 1;
  cam.top = v;
  cam.bottom = -v;
  const theta = THREE.MathUtils.degToRad(state.rotationDeg);
  const r = 1.5;
  cam.position.set(Math.sin(theta) * r, 2.6, Math.cos(theta) * r);
  cam.up.set(0, 1, 0);
  cam.lookAt(0, 0, 0);
  cam.updateProjectionMatrix();
}

function renderVariant(handle, ctx) {
  handle.renderer.render(handle.scene, handle.camera);

  const ctx2 = handle.out2x.getContext("2d", { willReadFrequently: true });
  ctx2.imageSmoothingEnabled = false;
  ctx2.clearRect(0, 0, handle.out2xW, handle.out2xH);
  ctx2.drawImage(
    handle.renderer.domElement,
    0, 0, handle.internalW, handle.internalH,
    0, 0, handle.out2xW, handle.out2xH,
  );
  const img2 = ctx2.getImageData(0, 0, handle.out2xW, handle.out2xH);
  ctx.quantize(img2);
  ctx2.putImageData(img2, 0, 0);

  const ctx1 = handle.out1x.getContext("2d");
  ctx1.imageSmoothingEnabled = false;
  ctx1.clearRect(0, 0, handle.out1xW, handle.out1xH);
  ctx1.drawImage(handle.out2x, 0, 0, handle.out1xW, handle.out1xH);

  const zctx = handle.zoom.getContext("2d");
  zctx.imageSmoothingEnabled = false;
  zctx.clearRect(0, 0, handle.zoom.width, handle.zoom.height);
  zctx.drawImage(handle.out2x, 0, 0, handle.zoom.width, handle.zoom.height);
}

function drawGrid(canvas, spriteW, spriteH = spriteW) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // 1 pixel cell = canvas.width / spriteW (cells are square).
  const cell = canvas.width / spriteW;
  // Per-pixel grid: faint white lines.
  ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= spriteW; i++) {
    const p = Math.round(i * cell) + 0.5;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, canvas.height);
    ctx.stroke();
  }
  for (let i = 0; i <= spriteH; i++) {
    const p = Math.round(i * cell) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(canvas.width, p);
    ctx.stroke();
  }
  // Tile-major grid every 16 game-1× pixels (one full tile) — gold lines.
  ctx.strokeStyle = "rgba(200, 160, 64, 0.55)";
  ctx.lineWidth = 1.5;
  for (let i = 0; i <= spriteW; i += 16) {
    const p = Math.round(i * cell) + 0.5;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, canvas.height);
    ctx.stroke();
  }
  for (let i = 0; i <= spriteH; i += 16) {
    const p = Math.round(i * cell) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(canvas.width, p);
    ctx.stroke();
  }
}
