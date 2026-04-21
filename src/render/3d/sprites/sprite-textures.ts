/**
 * sprite-textures.ts — shared procedural texture library + material factory.
 *
 * Every scene file that wanted a texture map used to ship its own
 * `makeMaterial` wrapper around `createMaterial` plus one or more
 * cached `getXxxTexture(three)` helpers. The wrappers all did the same
 * thing — build the base material, then attach a lazy per-id
 * `CanvasTexture`. Each scene kept its own cache variable and its own
 * "stone" id (wall and tower both had a `texture: "stone"` spec, but
 * the builders were intentionally different — wall-stone is darker +
 * has weathering streaks, tower-stone is lighter + cleaner).
 *
 * This module factors the wrapper into one `buildTexturedMaterial`
 * function and hosts every procedural builder behind a module-level
 * `Map<TextureId, THREE.Texture>` cache. Scene files keep their texture
 * intent by naming a disambiguated `TextureId` (`wall_stone` vs
 * `tower_stone`, etc.) in their spec's `texture` field — the visual
 * output is unchanged because every builder was lifted verbatim.
 *
 * Not moved here: `createMaterial` (lives in sprite-kit.ts — it's the
 * color-only factory), `createTiledCanvasTexture` (lives in
 * procedural-texture.ts — it's the square-canvas + seeded-LCG wrapper
 * that most of these builders call). The cannon wood / metal-grip and
 * the tower door textures use a direct canvas rather than the seeded
 * wrapper (deterministic `Math.sin` drifts / rectangular canvas), so
 * those keep their direct `new three.CanvasTexture(canvas)` bodies.
 */

import type * as THREE from "three";
import { createTiledCanvasTexture } from "./procedural-texture.ts";
import { createMaterial, type MaterialSpec } from "./sprite-kit.ts";

export type TextureId =
  | "wall_stone"
  | "wall_top"
  | "tower_stone"
  | "tower_door"
  | "tower_roof"
  | "house_roof_tile"
  | "cannon_wood"
  | "cannon_metal_grip";

export interface TexturedSpec extends MaterialSpec {
  readonly texture?: TextureId;
}

const textureCache = new Map<TextureId, THREE.Texture>();

/** Build a THREE material from a `TexturedSpec`. If `spec.texture` is
 *  set, the matching cached procedural texture is attached as `.map`.
 *  Both `MeshBasicMaterial` and `MeshStandardMaterial` support `.map`,
 *  so no kind-check is needed. Returns whatever `createMaterial` picked
 *  based on `spec.kind`. */
export function buildTexturedMaterial(
  three: typeof THREE,
  spec: TexturedSpec,
): THREE.MeshBasicMaterial | THREE.MeshStandardMaterial {
  const mat = createMaterial(spec);
  if (spec.texture !== undefined) {
    const tex = getTexture(three, spec.texture);
    if (tex) mat.map = tex;
  }
  return mat;
}

function getTexture(
  three: typeof THREE,
  id: TextureId,
): THREE.Texture | undefined {
  const cached = textureCache.get(id);
  if (cached) return cached;
  const tex = buildTexture(three, id);
  if (tex) textureCache.set(id, tex);
  return tex;
}

function buildTexture(
  three: typeof THREE,
  id: TextureId,
): THREE.Texture | undefined {
  switch (id) {
    case "wall_stone":
      return buildWallStone(three);
    case "wall_top":
      return buildWallTop(three);
    case "tower_stone":
      return buildTowerStone(three);
    case "tower_door":
      return buildTowerDoor(three);
    case "tower_roof":
      return buildTowerRoof(three);
    case "house_roof_tile":
      return buildHouseRoofTile(three);
    case "cannon_wood":
      return buildCannonWood(three);
    case "cannon_metal_grip":
      return buildCannonMetalGrip(three);
  }
}

/** Darker, streakier running-bond brick — tuned against wall-scene's
 *  5-grey quantize palette (0x2a..0xa5). Base tone ~130 (lands on
 *  0x6a/0x8a buckets) with ±60 jitter and 2-3 weathering streaks. */
function buildWallStone(three: typeof THREE): THREE.CanvasTexture | undefined {
  return createTiledCanvasTexture(three, 64, ({ ctx, size, rand }) => {
    paintRunningBondBrick(ctx, size, rand, {
      baseTone: 130,
      baseJitter: 60,
      mortar: "rgb(60,57,52)",
    });
    // Vertical weathering streaks — 2-3 irregular darker columns spanning
    // most of the texture height. Simulates water stains running down
    // from the wall-walk. Broken into short segments so the streak looks
    // organic rather than a perfect line.
    for (let i = 0; i < 3; i++) {
      const streakX = Math.floor(rand() * size);
      const streakShade = 80 + Math.floor(rand() * 20);
      ctx.fillStyle = `rgb(${streakShade},${streakShade},${streakShade})`;
      for (let y = 0; y < size; y++) {
        if (rand() < 0.75) ctx.fillRect(streakX, y, 1, 1);
      }
    }
  });
}

/** Flagstone paving for the wall-walk (allure): 4×4 grid of
 *  roughly-square pavers with thick mortar joints. Darker than the
 *  sides so the walk reads as a distinct layer. */
function buildWallTop(three: typeof THREE): THREE.CanvasTexture | undefined {
  return createTiledCanvasTexture(three, 64, ({ ctx, size, rand }) => {
    const cells = 4;
    const cellSize = size / cells;
    for (let r = 0; r < cells; r++) {
      for (let col = 0; col < cells; col++) {
        const base = 85 + Math.floor((rand() - 0.5) * 60);
        ctx.fillStyle = `rgb(${base},${base},${base - 3})`;
        ctx.fillRect(col * cellSize, r * cellSize, cellSize, cellSize);
        const chips = 4 + Math.floor(rand() * 4);
        for (let i = 0; i < chips; i++) {
          const shade = Math.max(0, base - 25 - Math.floor(rand() * 30));
          ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
          ctx.fillRect(
            col * cellSize + Math.floor(rand() * cellSize),
            r * cellSize + Math.floor(rand() * cellSize),
            1 + Math.floor(rand() * 2),
            1,
          );
        }
      }
    }
    ctx.fillStyle = "rgb(60,57,52)";
    for (let x = 0; x < size; x += cellSize) ctx.fillRect(x, 0, 2, size);
    for (let y = 0; y < size; y += cellSize) ctx.fillRect(0, y, size, 2);
  });
}

/** Lighter running-bond brick for tower bodies — base 200 (±50),
 *  no streaks, lighter mortar (120,115,108). Paired with the tower
 *  material's 0xffffff multiplier so lit pixels land on the near-white
 *  buckets of the assembly palette. */
function buildTowerStone(three: typeof THREE): THREE.CanvasTexture | undefined {
  return createTiledCanvasTexture(three, 64, ({ ctx, size, rand }) => {
    paintRunningBondBrick(ctx, size, rand, {
      baseTone: 200,
      baseJitter: 50,
      mortar: "rgb(120,115,108)",
    });
  });
}

/** Paint a staggered running-bond brick pattern + mortar lines into
 *  `ctx`. `baseTone ± baseJitter/2` is the per-brick grey; each brick
 *  gets a handful of darker stipple dots. The mortar fill runs as a
 *  horizontal line per course plus vertical lines between bricks. */
function paintRunningBondBrick(
  ctx: CanvasRenderingContext2D,
  size: number,
  rand: () => number,
  opts: { baseTone: number; baseJitter: number; mortar: string },
): void {
  const brickW = 16;
  const brickH = 8;
  for (let row = 0; row * brickH < size; row++) {
    const offset = (row % 2) * (brickW / 2);
    for (let col = -1; col * brickW + offset < size; col++) {
      const x = col * brickW + offset;
      const y = row * brickH;
      const base = opts.baseTone + Math.floor((rand() - 0.5) * opts.baseJitter);
      ctx.fillStyle = `rgb(${base},${base},${base})`;
      ctx.fillRect(x, y, brickW, brickH);
      const stippleCount = 6 + Math.floor(rand() * 5);
      for (let i = 0; i < stippleCount; i++) {
        const shade = Math.max(0, base - 20 - Math.floor(rand() * 30));
        ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
        ctx.fillRect(
          x + Math.floor(rand() * brickW),
          y + Math.floor(rand() * brickH),
          1 + Math.floor(rand() * 2),
          1,
        );
      }
    }
  }
  ctx.fillStyle = opts.mortar;
  for (let y = 0; y < size; y += brickH) ctx.fillRect(0, y, size, 1);
  for (let row = 0; row * brickH < size; row++) {
    const y = row * brickH;
    const offset = (row % 2) * (brickW / 2);
    for (let x = offset; x < size; x += brickW) ctx.fillRect(x, y, 1, brickH);
  }
}

/** 2-plank oak door — deterministic 64×32 (non-square). Uses a direct
 *  canvas rather than `createTiledCanvasTexture` (which is square-only
 *  and seeded-LCG). */
function buildTowerDoor(three: typeof THREE): THREE.CanvasTexture | undefined {
  if (typeof document === "undefined") return undefined;
  const w = 64;
  const h = 32;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return undefined;

  const plankCount = 2;
  const plankW = w / plankCount;
  const r = 16;
  const g = 10;
  const b = 6;
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = `rgb(${r - 4},${g - 2},${b - 1})`;
  for (let i = 0; i < plankCount; i++) {
    ctx.fillRect(Math.floor(i * plankW + plankW / 2), 0, 1, h);
  }
  ctx.fillStyle = "rgb(2,1,0)";
  for (let i = 0; i < plankCount; i++) {
    ctx.fillRect(i * plankW + plankW - 1, 0, 1, h);
  }
  ctx.fillStyle = "rgb(14,14,16)";
  ctx.fillRect(0, 3, w, 2);
  ctx.fillRect(0, h - 5, w, 2);
  ctx.fillStyle = "rgb(70,70,74)";
  for (let i = 0; i < plankCount; i++) {
    const cx = Math.floor(i * plankW + plankW / 2);
    ctx.fillRect(cx, 3, 1, 1);
    ctx.fillRect(cx, h - 5, 1, 1);
  }

  const tex = new three.CanvasTexture(c);
  tex.wrapS = three.RepeatWrapping;
  tex.wrapT = three.RepeatWrapping;
  return tex;
}

/** Light slate roof tiles — 32-px canvas, 8×8 tiles with checker-light
 *  shading + per-pixel jitter + bright speckles + tile-boundary jitter
 *  that breaks the grid into an organic-looking slate pattern. */
function buildTowerRoof(three: typeof THREE): THREE.CanvasTexture | undefined {
  return createTiledCanvasTexture(three, 32, ({ ctx, size, rand }) => {
    const w = size;
    const h = size;
    ctx.fillStyle = "rgb(230,230,230)";
    ctx.fillRect(0, 0, w, h);
    const tileW = 8;
    const tileH = 8;
    for (let ty = 0; ty < h / tileH; ty++) {
      for (let tx = 0; tx < w / tileW; tx++) {
        const dim = ((tx + ty) % 2) * 12;
        ctx.fillStyle = `rgb(${230 - dim},${230 - dim},${230 - dim})`;
        ctx.fillRect(tx * tileW, ty * tileH, tileW, tileH);
      }
    }
    const img = ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = Math.floor((rand() - 0.5) * 60);
      img.data[i] = Math.max(0, Math.min(255, img.data[i]! + n));
      img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1]! + n));
      img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2]! + n));
    }
    ctx.putImageData(img, 0, 0);
    for (let i = 0; i < 80; i++) {
      const x = Math.floor(rand() * (w - 1));
      const y = Math.floor(rand() * (h - 1));
      const shade = 150 + Math.floor(rand() * 60);
      ctx.fillStyle = `rgb(${shade},${shade},${shade + 4})`;
      ctx.fillRect(x, y, 2, 2);
    }
    for (let i = 0; i < 120; i++) {
      const shade = 130 + Math.floor(rand() * 40);
      ctx.fillStyle = `rgb(${shade},${shade},${shade + 4})`;
      const wPx = rand() < 0.3 ? 2 : 1;
      ctx.fillRect(Math.floor(rand() * w), Math.floor(rand() * h), wPx, 1);
    }
    ctx.fillStyle = "rgb(180,180,185)";
    for (let y = tileH - 1; y < h; y += tileH) {
      for (let x = 0; x < w; x++) {
        const jy = y + (rand() < 0.15 ? (rand() < 0.5 ? -1 : 1) : 0);
        ctx.fillRect(x, jy, 1, 1);
      }
    }
    for (let x = tileW - 1; x < w; x += tileW) {
      for (let y = 0; y < h; y++) {
        const jx = x + (rand() < 0.15 ? (rand() < 0.5 ? -1 : 1) : 0);
        ctx.fillRect(jx, y, 1, 1);
      }
    }
  });
}

/** Clay tile rows — staggered 8×4 tiles. Base is white-ish so the house
 *  material's ROOF_RED color multiplies through as the visible tint. */
function buildHouseRoofTile(
  three: typeof THREE,
): THREE.CanvasTexture | undefined {
  return createTiledCanvasTexture(three, 32, ({ ctx, size, rand }) => {
    const courseH = 4;
    const tileW = 8;
    for (let row = 0; row * courseH < size; row++) {
      const y = row * courseH;
      const offset = (row % 2) * (tileW / 2);
      for (let col = -1; col * tileW + offset < size; col++) {
        const x = col * tileW + offset;
        const base = 220 + Math.floor((rand() - 0.5) * 40);
        ctx.fillStyle = `rgb(${base},${base},${base})`;
        ctx.fillRect(x, y, tileW, courseH);
      }
    }
    ctx.fillStyle = "rgb(110,80,70)";
    for (let y = courseH - 1; y < size; y += courseH)
      ctx.fillRect(0, y, size, 1);
    for (let row = 0; row * courseH < size; row++) {
      const y = row * courseH;
      const offset = (row % 2) * (tileW / 2);
      for (let x = offset + tileW - 1; x < size; x += tileW)
        ctx.fillRect(x, y, 1, courseH);
    }
  });
}

/** Light oak for cannon carriages — deterministic sine-drift grain +
 *  three fixed knots. Uses a direct canvas (not `createTiledCanvasTexture`)
 *  because the variation is `Math.sin`-based, not seeded-LCG. */
function buildCannonWood(three: typeof THREE): THREE.Texture | undefined {
  if (typeof document === "undefined") return undefined;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.fillStyle = "#c8c8c8";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "rgba(60, 40, 20, 0.55)";
  ctx.lineWidth = 1;
  for (let yLine = 1; yLine < size; yLine += 3) {
    ctx.beginPath();
    const drift = Math.sin(yLine * 0.15) * 1.2;
    ctx.moveTo(0, yLine + drift);
    for (let xStep = 4; xStep <= size; xStep += 4) {
      const wobble = Math.sin((xStep + yLine) * 0.22) * 1.1;
      ctx.lineTo(xStep, yLine + drift + wobble);
    }
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(40, 25, 10, 0.35)";
  for (const [kx, ky, kr] of [
    [12, 20, 3],
    [44, 38, 2.5],
    [28, 52, 2],
  ] as const) {
    ctx.beginPath();
    ctx.ellipse(kx, ky, kr, kr * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new three.CanvasTexture(canvas);
  tex.wrapS = three.RepeatWrapping;
  tex.wrapT = three.RepeatWrapping;
  return tex;
}

/** Diamond-knurl metal grip for cannon trunnion bands — staggered
 *  dark/light ellipses simulate embossed cross-hatching. Direct canvas
 *  (no seeded RNG). */
function buildCannonMetalGrip(three: typeof THREE): THREE.Texture | undefined {
  if (typeof document === "undefined") return undefined;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.fillStyle = "#c0c0c0";
  ctx.fillRect(0, 0, size, size);
  const step = 4;
  ctx.fillStyle = "rgba(40, 40, 50, 0.55)";
  for (let row = 0; row < size / step + 1; row++) {
    const offset = (row % 2) * (step / 2);
    for (let column = 0; column < size / step + 1; column++) {
      const xCenter = column * step + offset;
      const yCenter = row * step;
      ctx.beginPath();
      ctx.ellipse(
        xCenter + 0.3,
        yCenter + 0.3,
        1.2,
        0.7,
        Math.PI / 4,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }
  ctx.fillStyle = "rgba(240, 240, 240, 0.55)";
  for (let row = 0; row < size / step + 1; row++) {
    const offset = (row % 2) * (step / 2);
    for (let column = 0; column < size / step + 1; column++) {
      const xCenter = column * step + offset;
      const yCenter = row * step;
      ctx.beginPath();
      ctx.ellipse(
        xCenter - 0.3,
        yCenter - 0.3,
        1.05,
        0.55,
        Math.PI / 4,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }
  const tex = new three.CanvasTexture(canvas);
  tex.wrapS = three.RepeatWrapping;
  tex.wrapT = three.RepeatWrapping;
  return tex;
}
