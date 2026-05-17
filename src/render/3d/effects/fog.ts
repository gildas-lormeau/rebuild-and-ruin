/**
 * Fog-of-war overlay — three InstancedMeshes (opaque base, drifting
 * highlight band, concave-corner fillets). Base/band run a rounded-box
 * SDF driven by a per-instance corner mask (only convex outer corners
 * round; shared inter-tile edges stay sharp). Fillets draw a crescent
 * SDF in empty cells whose 3 surrounding tiles wrap a 90° concave
 * corner. Size + xor-key fingerprint gates rebuild; hot path is alloc-free.
 */

import * as THREE from "three";
import { TILE_SIZE, type TileKey } from "../../../shared/core/grid.ts";
import {
  inBounds,
  packTile,
  unpackTile,
} from "../../../shared/core/spatial.ts";
import { ELEVATION_STACK, RENDER_ORDER, Z_FIGHT_MARGIN } from "../elevation.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import { tileSeed } from "./helpers.ts";

interface FogManager {
  /** Per-frame update. Rebuilds the fog tile set only when castles'
   *  interior/wall composition changes; otherwise just re-drives the
   *  highlight band positions + brightness from `now`. Reads
   *  `overlay.battle.fogRevealOpacity` and applies it to base + band
   *  material alpha (undefined = no override = full opacity). */
  update(ctx: FrameCtx): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

interface FogTile {
  row: number;
  col: number;
  seed: number;
}

/** A concave-corner fillet — a quarter-disk drawn inside an empty cell,
 *  tangent to two adjacent fog edges, smoothing the inward 90° turn
 *  where three fog tiles wrap a concave corner of the fog mass. */
interface Fillet {
  row: number; // empty cell row
  col: number; // empty cell col
  /** Sign vector of the corner this fillet hugs (+x = east, +y = south
   *  in tile-local coords; matches the vTilePos axis convention). */
  dirX: 1 | -1;
  dirY: 1 | -1;
}

const FOG_BASE_ALPHA = 0.95;
// 120, 128, 140 → 0x78808c
const FOG_BASE_COLOR = 0x78808c;
// 200, 210, 220 → 0xc8d2dc
const FOG_HIGHLIGHT_COLOR = 0xc8d2dc;
const FOG_HIGHLIGHT_ALPHA = 0.18;
const FOG_DRIFT_HZ = 0.6;
// Minimum + span of the per-instance brightness wave. Matches the old
// per-tile alpha wave `FOG_HIGHLIGHT_ALPHA * (0.6 + wave * 0.4)`: the
// material holds max alpha and the instance color scales brightness.
const FOG_WAVE_MIN = 0.6;
const FOG_WAVE_SPAN = 0.4;
const INITIAL_CAPACITY = 64;
// Corner radius in tile-local [-1, 1] units. 0.7 makes the rounding
// visible even at mobile-portrait zoom; dial back toward ~0.35 if the
// effect feels too pillowy at desktop scale.
const FOG_CORNER_RADIUS = 0.7;
const VERTEX_SHADER = /* glsl */ `
attribute vec2 tileOrigin;
attribute vec4 cornerMask;
varying vec2 vTilePos;
varying vec4 vCornerMask;
#ifdef USE_INSTANCING_COLOR
varying vec3 vInstanceColor;
#endif

void main() {
  vec4 modelPos = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    modelPos = instanceMatrix * modelPos;
  #endif
  vec4 worldPos = modelMatrix * modelPos;
  // Map fragment's world XZ into tile-local [-1, 1] using the tile's
  // NW-corner origin. Works for both the full base plane and the thin
  // drifting band — both occupy positions inside the same tile.
  vTilePos = ((worldPos.xz - tileOrigin) / ${TILE_SIZE.toFixed(1)}) * 2.0 - 1.0;
  vCornerMask = cornerMask;
  #ifdef USE_INSTANCING_COLOR
    vInstanceColor = instanceColor;
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * modelPos;
}
`;
const FILLET_VERTEX_SHADER = /* glsl */ `
attribute vec2 tileOrigin;
attribute vec2 filletDir;
varying vec2 vTilePos;
varying vec2 vFilletDir;

void main() {
  vec4 modelPos = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    modelPos = instanceMatrix * modelPos;
  #endif
  vec4 worldPos = modelMatrix * modelPos;
  vTilePos = ((worldPos.xz - tileOrigin) / ${TILE_SIZE.toFixed(1)}) * 2.0 - 1.0;
  vFilletDir = filletDir;
  gl_Position = projectionMatrix * modelViewMatrix * modelPos;
}
`;
const FILLET_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uOpacity;
uniform float uRadius;

varying vec2 vTilePos;
varying vec2 vFilletDir;

void main() {
  // Fillet = crescent at the targeted corner: fog within r of the
  // L-corner point AND outside the arc disk (tangent to the two fog
  // edges). The arc is the smooth concave boundary that replaces the
  // 90° inward turn. filletDir is the sign vector of the corner —
  // e.g. (-1, +1) for the SW corner of the empty cell.
  vec2 cornerPos = vFilletDir;
  vec2 arcCenter = vFilletDir * (1.0 - uRadius);
  float distToCorner = length(vTilePos - cornerPos);
  float distToArcCenter = length(vTilePos - arcCenter);
  // SDF intersection: inside the corner-r disk (d_corner < 0) AND
  // outside the arc disk (d_arc_complement < 0).
  float d = max(distToCorner - uRadius, uRadius - distToArcCenter);
  float aa = fwidth(d) + 0.001;
  float alpha = 1.0 - smoothstep(-aa, aa, d);
  gl_FragColor = vec4(uColor, uOpacity * alpha);
}
`;
const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uOpacity;
uniform float uRadius;

varying vec2 vTilePos;
varying vec4 vCornerMask;
#ifdef USE_INSTANCING_COLOR
varying vec3 vInstanceColor;
#endif

void main() {
  // Pick this fragment's corner radius based on which quadrant of the
  // tile we're in. Mask layout: x=NE, y=SE, z=SW, w=NW (1 = outer
  // corner, round it; 0 = shared with a neighbor, keep sharp).
  // vTilePos.y > 0 maps to world +Z = row+ direction = SOUTH (the
  // plane rotateX(-π/2) puts the original +Y vertex at +Z relative to
  // tile origin), so southern quadrants pick SE/SW.
  float r;
  if (vTilePos.x > 0.0) {
    r = vTilePos.y > 0.0 ? vCornerMask.y : vCornerMask.x;
  } else {
    r = vTilePos.y > 0.0 ? vCornerMask.z : vCornerMask.w;
  }
  r *= uRadius;

  // Rounded-box SDF, half-size = 1 in tile-local units.
  vec2 q = abs(vTilePos) - 1.0 + r;
  float d = min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;

  // Anti-alias only inside the outer-corner region (q.x > 0 && q.y > 0
  // && r > 0). Everywhere else use a hard 0/1 alpha so adjacent fog
  // tiles meet at full opacity without a darker seam at the shared
  // edge.
  float alpha;
  if (q.x > 0.0 && q.y > 0.0 && r > 0.0) {
    float aa = fwidth(d) + 0.001;
    alpha = 1.0 - smoothstep(-aa, aa, d);
  } else {
    alpha = d <= 0.0 ? 1.0 : 0.0;
  }

  vec3 color = uColor;
  #ifdef USE_INSTANCING_COLOR
    color *= vInstanceColor;
  #endif
  gl_FragColor = vec4(color, uOpacity * alpha);
}
`;

export function createFogManager(scene: THREE.Scene): FogManager {
  const root = new THREE.Group();
  root.name = "fog";
  scene.add(root);

  const tileGeometry = new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE);
  tileGeometry.rotateX(-Math.PI / 2);
  // Thin highlight band — 2 px tall drifting line, parity with the 2D
  // 2-px rectangle highlight.
  const bandGeometry = new THREE.PlaneGeometry(TILE_SIZE, 2);
  bandGeometry.rotateX(-Math.PI / 2);
  // Fillets need their own geometry: per-instance custom attributes
  // live on the geometry, and the fillet's `tileOrigin` differs from
  // the base mesh's (empty cell vs fog tile).
  const filletGeometry = new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE);
  filletGeometry.rotateX(-Math.PI / 2);

  const baseUniforms = {
    uColor: { value: new THREE.Color(FOG_BASE_COLOR) },
    uOpacity: { value: FOG_BASE_ALPHA },
    uRadius: { value: FOG_CORNER_RADIUS },
  };
  const bandUniforms = {
    uColor: { value: new THREE.Color(FOG_HIGHLIGHT_COLOR) },
    uOpacity: { value: FOG_HIGHLIGHT_ALPHA },
    uRadius: { value: FOG_CORNER_RADIUS },
  };
  const filletUniforms = {
    uColor: { value: new THREE.Color(FOG_BASE_COLOR) },
    uOpacity: { value: FOG_BASE_ALPHA },
    uRadius: { value: FOG_CORNER_RADIUS },
  };

  const baseMaterial = new THREE.ShaderMaterial({
    uniforms: baseUniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    extensions: { derivatives: true },
  });
  const bandMaterial = new THREE.ShaderMaterial({
    uniforms: bandUniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    extensions: { derivatives: true },
  });
  const filletMaterial = new THREE.ShaderMaterial({
    uniforms: filletUniforms,
    vertexShader: FILLET_VERTEX_SHADER,
    fragmentShader: FILLET_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    extensions: { derivatives: true },
  });

  let baseMesh: THREE.InstancedMesh | undefined;
  let bandMesh: THREE.InstancedMesh | undefined;
  let filletMesh: THREE.InstancedMesh | undefined;
  let baseCornerMask: THREE.InstancedBufferAttribute | undefined;
  let baseTileOrigin: THREE.InstancedBufferAttribute | undefined;
  let bandCornerMask: THREE.InstancedBufferAttribute | undefined;
  let bandTileOrigin: THREE.InstancedBufferAttribute | undefined;
  let filletDirAttr: THREE.InstancedBufferAttribute | undefined;
  let filletTileOrigin: THREE.InstancedBufferAttribute | undefined;
  let capacity = 0;
  let filletCapacity = 0;

  const tiles: FogTile[] = [];
  const fillets: Fillet[] = [];
  const scratchMatrix = new THREE.Matrix4();
  const scratchColor = new THREE.Color();
  // Reused across frames so `dilateInto` doesn't allocate. `clear()` then refill.
  const keys = new Set<number>();
  let lastFingerprint = -1;

  function ensureCapacity(required: number): void {
    if (baseMesh && bandMesh && required <= capacity) return;
    disposeMeshes();
    capacity = Math.max(INITIAL_CAPACITY, nextPowerOfTwo(required));

    baseCornerMask = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 4),
      4,
    );
    baseTileOrigin = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 2),
      2,
    );
    tileGeometry.setAttribute("cornerMask", baseCornerMask);
    tileGeometry.setAttribute("tileOrigin", baseTileOrigin);

    baseMesh = new THREE.InstancedMesh(tileGeometry, baseMaterial, capacity);
    baseMesh.count = 0;
    baseMesh.frustumCulled = false;
    baseMesh.renderOrder = RENDER_ORDER.FOG;
    baseMesh.name = "fog-base";
    root.add(baseMesh);

    bandCornerMask = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 4),
      4,
    );
    bandTileOrigin = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 2),
      2,
    );
    bandGeometry.setAttribute("cornerMask", bandCornerMask);
    bandGeometry.setAttribute("tileOrigin", bandTileOrigin);

    bandMesh = new THREE.InstancedMesh(bandGeometry, bandMaterial, capacity);
    bandMesh.count = 0;
    bandMesh.frustumCulled = false;
    bandMesh.renderOrder = RENDER_ORDER.FOG + 1;
    bandMesh.name = "fog-band";
    // Allocate the per-instance color buffer up-front so `setColorAt`
    // works immediately in the per-frame update.
    bandMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3),
      3,
    );
    root.add(bandMesh);
  }

  function ensureFilletCapacity(required: number): void {
    if (filletMesh && required <= filletCapacity) return;
    if (filletMesh) {
      root.remove(filletMesh);
      filletMesh.dispose();
      filletMesh = undefined;
    }
    filletCapacity = Math.max(INITIAL_CAPACITY, nextPowerOfTwo(required));
    filletDirAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(filletCapacity * 2),
      2,
    );
    filletTileOrigin = new THREE.InstancedBufferAttribute(
      new Float32Array(filletCapacity * 2),
      2,
    );
    filletGeometry.setAttribute("filletDir", filletDirAttr);
    filletGeometry.setAttribute("tileOrigin", filletTileOrigin);
    filletMesh = new THREE.InstancedMesh(
      filletGeometry,
      filletMaterial,
      filletCapacity,
    );
    filletMesh.count = 0;
    filletMesh.frustumCulled = false;
    // Render alongside base — slight Z bias to avoid co-planar fight
    // with terrain but below the band.
    filletMesh.renderOrder = RENDER_ORDER.FOG;
    filletMesh.name = "fog-fillet";
    root.add(filletMesh);
  }

  function disposeMeshes(): void {
    if (baseMesh) {
      root.remove(baseMesh);
      baseMesh.dispose();
      baseMesh = undefined;
    }
    if (bandMesh) {
      root.remove(bandMesh);
      bandMesh.dispose();
      bandMesh = undefined;
    }
    if (filletMesh) {
      root.remove(filletMesh);
      filletMesh.dispose();
      filletMesh = undefined;
    }
    baseCornerMask = undefined;
    baseTileOrigin = undefined;
    bandCornerMask = undefined;
    bandTileOrigin = undefined;
    filletDirAttr = undefined;
    filletTileOrigin = undefined;
    capacity = 0;
    filletCapacity = 0;
  }

  function rebuild(): void {
    tiles.length = 0;
    fillets.length = 0;
    for (const key of keys) {
      const { r, c } = unpackTile(key as TileKey);
      tiles.push({ row: r, col: c, seed: tileSeed(r, c) });
    }
    ensureCapacity(tiles.length);
    if (
      !baseMesh ||
      !baseCornerMask ||
      !baseTileOrigin ||
      !bandCornerMask ||
      !bandTileOrigin
    ) {
      return;
    }
    const baseMask = baseCornerMask.array as Float32Array;
    const baseOrigin = baseTileOrigin.array as Float32Array;
    const bandMask = bandCornerMask.array as Float32Array;
    const bandOrigin = bandTileOrigin.array as Float32Array;
    // Base instance matrices are static — write once here, band fills
    // positions per-frame in the animation loop. Per-instance corner
    // masks + tile origins are static too (until `rebuild` runs again).
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]!;
      scratchMatrix.makeTranslation(
        tile.col * TILE_SIZE + TILE_SIZE / 2,
        ELEVATION_STACK.FOG,
        tile.row * TILE_SIZE + TILE_SIZE / 2,
      );
      baseMesh.setMatrixAt(i, scratchMatrix);

      const openN = isOpen(tile.row - 1, tile.col);
      const openS = isOpen(tile.row + 1, tile.col);
      const openE = isOpen(tile.row, tile.col + 1);
      const openW = isOpen(tile.row, tile.col - 1);
      // Mask layout (consumed by fragment shader): x=NE, y=SE, z=SW,
      // w=NW. Quadrant detection uses world XZ relative to the tile
      // origin: +x = col+ (east), +z = row+ (south).
      const roundNE = openN && openE ? 1 : 0;
      const roundSE = openS && openE ? 1 : 0;
      const roundSW = openS && openW ? 1 : 0;
      const roundNW = openN && openW ? 1 : 0;
      baseMask[i * 4 + 0] = roundNE;
      baseMask[i * 4 + 1] = roundSE;
      baseMask[i * 4 + 2] = roundSW;
      baseMask[i * 4 + 3] = roundNW;
      bandMask[i * 4 + 0] = roundNE;
      bandMask[i * 4 + 1] = roundSE;
      bandMask[i * 4 + 2] = roundSW;
      bandMask[i * 4 + 3] = roundNW;

      const originX = tile.col * TILE_SIZE;
      const originZ = tile.row * TILE_SIZE;
      baseOrigin[i * 2 + 0] = originX;
      baseOrigin[i * 2 + 1] = originZ;
      bandOrigin[i * 2 + 0] = originX;
      bandOrigin[i * 2 + 1] = originZ;

      // Concave-corner detection. For each diagonal direction, both
      // cardinal neighbors must be fog AND the diagonal must be empty
      // — that's the 3-fog-tiles-wrap-an-empty-corner pattern. Each
      // fillet sits in the empty diagonal cell, in the corner facing
      // back toward this fog tile. Iterating one diagonal per fog tile
      // produces each fillet exactly once.
      if (!openN && !openE && isOpen(tile.row - 1, tile.col + 1)) {
        // NE diagonal empty → SW corner of (row-1, col+1) gets a fillet.
        fillets.push({
          row: tile.row - 1,
          col: tile.col + 1,
          dirX: -1,
          dirY: 1,
        });
      }
      if (!openS && !openE && isOpen(tile.row + 1, tile.col + 1)) {
        // SE diagonal empty → NW corner of (row+1, col+1).
        fillets.push({
          row: tile.row + 1,
          col: tile.col + 1,
          dirX: -1,
          dirY: -1,
        });
      }
      if (!openS && !openW && isOpen(tile.row + 1, tile.col - 1)) {
        // SW diagonal empty → NE corner of (row+1, col-1).
        fillets.push({
          row: tile.row + 1,
          col: tile.col - 1,
          dirX: 1,
          dirY: -1,
        });
      }
      if (!openN && !openW && isOpen(tile.row - 1, tile.col - 1)) {
        // NW diagonal empty → SE corner of (row-1, col-1).
        fillets.push({
          row: tile.row - 1,
          col: tile.col - 1,
          dirX: 1,
          dirY: 1,
        });
      }
    }
    baseMesh.count = tiles.length;
    baseMesh.instanceMatrix.needsUpdate = true;
    baseCornerMask.needsUpdate = true;
    baseTileOrigin.needsUpdate = true;
    bandCornerMask.needsUpdate = true;
    bandTileOrigin.needsUpdate = true;
    if (bandMesh) bandMesh.count = tiles.length;

    ensureFilletCapacity(fillets.length);
    if (!filletMesh || !filletDirAttr || !filletTileOrigin) return;
    const filletDirArr = filletDirAttr.array as Float32Array;
    const filletOriginArr = filletTileOrigin.array as Float32Array;
    for (let i = 0; i < fillets.length; i++) {
      const fillet = fillets[i]!;
      scratchMatrix.makeTranslation(
        fillet.col * TILE_SIZE + TILE_SIZE / 2,
        ELEVATION_STACK.FOG,
        fillet.row * TILE_SIZE + TILE_SIZE / 2,
      );
      filletMesh.setMatrixAt(i, scratchMatrix);
      filletDirArr[i * 2 + 0] = fillet.dirX;
      filletDirArr[i * 2 + 1] = fillet.dirY;
      filletOriginArr[i * 2 + 0] = fillet.col * TILE_SIZE;
      filletOriginArr[i * 2 + 1] = fillet.row * TILE_SIZE;
    }
    filletMesh.count = fillets.length;
    filletMesh.instanceMatrix.needsUpdate = true;
    filletDirAttr.needsUpdate = true;
    filletTileOrigin.needsUpdate = true;
  }

  function update(ctx: FrameCtx): void {
    const { overlay, now } = ctx;
    const fogActive = !!overlay?.battle?.fogOfWar;
    const castles = overlay?.castles;

    // Apply the runtime-derived reveal multiplier to material alpha.
    // `undefined` = no override = full alpha. The fog manager owns no
    // ramp/state of its own — `deriveFogRevealOpacity` (runtime-side)
    // produces the value each frame and lands it in
    // `overlay.battle.fogRevealOpacity`.
    const revealMultiplier = overlay?.battle?.fogRevealOpacity ?? 1;
    baseUniforms.uOpacity.value = FOG_BASE_ALPHA * revealMultiplier;
    bandUniforms.uOpacity.value = FOG_HIGHLIGHT_ALPHA * revealMultiplier;
    filletUniforms.uOpacity.value = FOG_BASE_ALPHA * revealMultiplier;

    if (!fogActive || !castles || castles.length === 0) {
      if (lastFingerprint !== 0) {
        lastFingerprint = 0;
        keys.clear();
        tiles.length = 0;
        fillets.length = 0;
        if (baseMesh) baseMesh.count = 0;
        if (bandMesh) bandMesh.count = 0;
        if (filletMesh) filletMesh.count = 0;
      }
      return;
    }

    keys.clear();
    for (const castle of castles) {
      if (castle.interior.size === 0) continue;
      const walls =
        overlay?.battle?.battleWalls?.[castle.playerId] ?? castle.walls;
      dilateInto(keys, castle.interior, walls);
    }

    const fingerprint = computeFingerprint(keys);
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      rebuild();
    }

    if (tiles.length === 0 || !bandMesh) return;
    const time = now / 1000;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]!;
      const wave = Math.sin(time * FOG_DRIFT_HZ + tile.seed);
      const brightness = FOG_WAVE_MIN + Math.max(0, wave) * FOG_WAVE_SPAN;
      scratchColor.setHex(FOG_HIGHLIGHT_COLOR).multiplyScalar(brightness);
      bandMesh.setColorAt(i, scratchColor);
      // 2D moves the band between y=py and y=py + (TILE_SIZE - 3). We map
      // that vertical offset onto Z.
      const bandOffset =
        (Math.sin(time + tile.seed) + 1) * 0.5 * (TILE_SIZE - 3);
      scratchMatrix.makeTranslation(
        tile.col * TILE_SIZE + TILE_SIZE / 2,
        ELEVATION_STACK.FOG + Z_FIGHT_MARGIN,
        tile.row * TILE_SIZE + 1 + bandOffset,
      );
      bandMesh.setMatrixAt(i, scratchMatrix);
    }
    bandMesh.instanceMatrix.needsUpdate = true;
    if (bandMesh.instanceColor) bandMesh.instanceColor.needsUpdate = true;
  }

  function dispose(): void {
    disposeMeshes();
    tileGeometry.dispose();
    bandGeometry.dispose();
    filletGeometry.dispose();
    baseMaterial.dispose();
    bandMaterial.dispose();
    filletMaterial.dispose();
    scene.remove(root);
  }

  function isOpen(r: number, c: number): boolean {
    if (!inBounds(r, c)) return true;
    return !keys.has(packTile(r, c));
  }

  return { update, dispose };
}

/** Add to `out` every tile in the castle footprint (interior ∪ walls)
 *  dilated by one tile in all 8 directions. */
function dilateInto(
  out: Set<number>,
  interior: ReadonlySet<number>,
  walls: ReadonlySet<number>,
): void {
  for (const key of interior) dilateKey(out, key as TileKey);
  for (const key of walls) dilateKey(out, key as TileKey);
}

function dilateKey(out: Set<number>, key: TileKey): void {
  out.add(key);
  const { r, c } = unpackTile(key);
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      out.add(packTile(nr, nc));
    }
  }
}

/** Cheap O(n) fingerprint of a packed-key set. Size + running xor +
 *  additive hash: flips for any add/remove without sorting or joining
 *  strings. Collisions are theoretically possible but negligible for
 *  our footprint sizes (≤ a few hundred tiles). Reserves `0` to mean
 *  "fog inactive" so the toggle reliably triggers a clear. */
function computeFingerprint(packedKeys: Set<number>): number {
  if (packedKeys.size === 0) return -2;
  let hash = packedKeys.size;
  for (const key of packedKeys) {
    hash = (hash * 31 + key) | 0;
    hash ^= key;
  }
  return hash === 0 ? 1 : hash;
}

function nextPowerOfTwo(value: number): number {
  let power = 1;
  while (power < value) power <<= 1;
  return power;
}
