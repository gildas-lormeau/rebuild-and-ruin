/**
 * 3D terrain overlay mesh for the world renderer.
 *
 * Phase 2 of the 3D renderer migration (see docs/3d-renderer-migration.md).
 * Renders only the per-tile OVERLAY visuals — castle interiors, bonus
 * squares, frozen tiles, owned sinkhole tints — as a single
 * `BufferGeometry` of `GRID_ROWS * GRID_COLS` RGBA-vertex-colored quads.
 * Raw grass / water / bank pixels come from the 2D `getTerrainBitmap`
 * texture uploaded by `effects/terrain-bitmap.ts` and sitting at Y=0;
 * this mesh sits at Y=0.01 and outputs alpha=0 on raw grass/water tiles
 * so the bitmap shows through, alpha=1 on overlay tiles so it covers.
 *
 * Design:
 *   - One quad per tile (4 verts), placed in the XZ plane at Y=0 (camera looks
 *     straight down -Y). Quad (r, c) spans world rect
 *     `[c*TILE_SIZE, (c+1)*TILE_SIZE] × [r*TILE_SIZE, (r+1)*TILE_SIZE]`.
 *   - Geometry is rebuilt only when `map.mapVersion` changes (matches the 2D
 *     renderer's `WeakMap<GameMap, ImageData>` cache policy, but cheaper — we
 *     rebuild the tiny buffer, never precompute a pixel grid).
 *   - Per-frame `update(overlay, now)` rewrites the color attribute so water
 *     can shimmer, bonus squares can pulse, and burning pits / frozen tiles
 *     respond to state changes without rebuilding geometry.
 *
 * Color parity: base RGB values mirror the 2D renderer's tile palette in
 * `render-map.ts` (GRASS_DARK/LIGHT/BATTLE) and the
 * `bonus_square` / `burning_pit_*` sprites in `scripts/generate-sprites.html`.
 * Water shimmer uses the same period/phase math as `drawWaterAnimation` in
 * `render-effects.ts`, reduced to a per-tile amplitude modulation on the
 * WATER_COLOR base (Phase 2 doesn't draw the fine wave highlights — the 2D
 * layer handles those until a future polish pass).
 *
 * Per-tile owner tinting (added after Phase 6):
 *   - Castle interiors: 2-shade checkered tint from the owning player's
 *     `interiorLight`/`interiorDark` palette, swapped to a uniform
 *     cobblestone-tinted-gray during battle. Sourced from the same
 *     `castle.interior` / `overlay.battle.battleTerritory` sets the 2D
 *     `drawCastleInterior` reads; the 2D `interiors` layer is flipped off
 *     in 3D mode so the mesh owns the visual outright.
 *   - Sinkhole banks: enclosed sinkhole tiles (water tiles inside a
 *     player's interior) are tinted with the owner's interior color, so
 *     owned lakes visually belong to the castle. This is a tile-grain
 *     approximation of the 2D per-pixel `drawSinkholeOverlays` bank fade.
 *   - Battle grass: out-of-interior grass tiles use GRASS_BATTLE during
 *     battle (flat darkened green), mirroring the 2D `grassBaseColor`
 *     battle branch.
 */

import * as THREE from "three";
import type { GameMap } from "../../shared/core/geometry-types.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  MAP_PX_H,
  MAP_PX_W,
  TILE_SIZE,
  Tile,
} from "../../shared/core/grid.ts";
import type { ValidPlayerSlot } from "../../shared/core/player-slot.ts";
import { interiorOwnersFromOverlay } from "../../shared/ui/overlay-types.ts";
import { getPlayerColor, MAX_PLAYERS } from "../../shared/ui/player-config.ts";
import type { RGB } from "../../shared/ui/theme.ts";
import { ELEVATION_STACK } from "./elevation.ts";
import type { FrameCtx } from "./frame-ctx.ts";

/** Construction deps — DataTextures the terrain shader samples per-fragment.
 *  Both are owned by separate managers (`effects/terrain-sdf-texture.ts`,
 *  `effects/terrain-tile-data.ts`) and refreshed by their own update calls
 *  before each frame's `terrain.update`. */
interface TerrainDeps {
  readonly sdfTexture: THREE.DataTexture;
  readonly tileDataTexture: THREE.DataTexture;
}

export interface TerrainContext {
  readonly mesh: THREE.Mesh;
  /** Rebuild geometry if `map.mapVersion` has changed since last build.
   *  Cheap no-op when the version matches. */
  ensureBuilt(map: GameMap): void;
  /** Per-frame update: recomputes vertex colors from `ctx.map` + `ctx.overlay`.
   *  Must be called after `ensureBuilt`. */
  update(ctx: FrameCtx): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

// Per-tile base colors — raw grass/water/bank/ice now come from the 2D
// `getTerrainBitmap` texture uploaded in `effects/terrain-bitmap.ts`;
// the mesh only owns overlay tile colors (interiors, bonus, owned
// sinkhole tints) which must stay in sync with `render-map.ts`.
// Cobblestone base color for battle-mode interiors. Intentionally
// lighter than the 2D sprite's `COBBLESTONE_BASE = [90, 85, 80]` in
// `render-map.ts` → `cobblestoneBaseColor`: at 3D's tile resolution the
// uniform dark base swallowed tower silhouettes, so we fade it toward a
// light stone gray to boost contrast with castle geometry. The 2D sprite
// still layers textured stone detail on top of its own darker base.
const COBBLESTONE_BASE: [number, number, number] = [125, 120, 115];
const COBBLESTONE_TINT_FACTOR = 0.13;
// Bank-gradient color stops for the shader's per-pixel sinkhole override.
// Mirrored from `render-map.ts` so the GLSL `selectTerrainColor` produces
// the same band the 2D bake does (only the grass terminus differs —
// owner-tinted instead of default green).
const BANK_COLOR_SRGB: RGB = [139, 58, 26];
const WATER_COLOR_SRGB: RGB = [40, 104, 176];
const ICE_COLOR_SRGB: RGB = [165, 210, 230];
// SDF-distance thresholds (units = pixels in the blurred SDF). Same numbers
// as `render-map.ts`'s `GRASS_TO_BANK_DIST` / `BANK_TO_WATER_DIST` /
// `TRANSITION_WIDTH` — kept here as GLSL string constants so the shader
// patch doesn't need uniform plumbing for them.
const GLSL_GRASS_TO_BANK_DIST = "2.0";
const GLSL_BANK_TO_WATER_DIST = "4.0";
const GLSL_TRANSITION_WIDTH = "1.5";
const TERRAIN_PROGRAM_KEY = "terrain-sinkhole-shader-v1";

export function createTerrain(deps: TerrainDeps): TerrainContext {
  const tileCount = GRID_ROWS * GRID_COLS;
  const vertsPerTile = 4;
  const trisPerTile = 2;

  const positions = new Float32Array(tileCount * vertsPerTile * 3);
  const indices = new Uint32Array(tileCount * trisPerTile * 3);
  // RGBA vertex colors: raw grass/water pixels get alpha=0 so the
  // terrain-bitmap plane below shows through; castle interiors, bonus
  // squares, frozen tiles, and owned sinkhole tiles get alpha=1.
  const colors = new Float32Array(tileCount * vertsPerTile * 4);

  // Build static position + index buffers — these never change at runtime.
  // Tile (r, c) occupies world rect [c*T..(c+1)*T] × Z=[r*T..(r+1)*T] at
  // Y=ELEVATION_STACK.TERRAIN_MESH, just above the terrain bitmap plane at Y=0 so opaque
  // interior pixels composite over raw grass/water from the bitmap.
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const tileIdx = r * GRID_COLS + c;
      const vertBase = tileIdx * vertsPerTile;
      const x0 = c * TILE_SIZE;
      const x1 = x0 + TILE_SIZE;
      const z0 = r * TILE_SIZE;
      const z1 = z0 + TILE_SIZE;
      // Four corners of the tile in world space.
      // Order: NW, NE, SE, SW (so CCW when viewed from +Y).
      setVertex(positions, vertBase + 0, x0, ELEVATION_STACK.TERRAIN_MESH, z0);
      setVertex(positions, vertBase + 1, x1, ELEVATION_STACK.TERRAIN_MESH, z0);
      setVertex(positions, vertBase + 2, x1, ELEVATION_STACK.TERRAIN_MESH, z1);
      setVertex(positions, vertBase + 3, x0, ELEVATION_STACK.TERRAIN_MESH, z1);

      const idxBase = tileIdx * trisPerTile * 3;
      // Wind CCW seen from above (camera +Y looking -Y; up = -Z), matches
      // three.js default front-face so lights hit the expected side.
      indices[idxBase + 0] = vertBase + 0;
      indices[idxBase + 1] = vertBase + 3;
      indices[idxBase + 2] = vertBase + 2;
      indices[idxBase + 3] = vertBase + 0;
      indices[idxBase + 4] = vertBase + 2;
      indices[idxBase + 5] = vertBase + 1;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // Single upward normal for every vertex — no lighting on tilt here, but the
  // hemisphere light still tints correctly.
  geometry.computeVertexNormals();
  // Position is static; color attribute is rewritten per frame.
  geometry.attributes["position"]!.needsUpdate = false;

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.FrontSide,
    // Raw grass / water tiles output alpha=0 so the terrain-bitmap
    // plane at Y=0 shows through. Castle interiors and other opaque
    // tile kinds output alpha=1 and cover the bitmap.
    transparent: true,
    depthWrite: true,
  });

  // Pre-linearize the player palette + bank/water/ice constants once at
  // material init. The shader operates in linear color space (matches the
  // existing vertex-color path's `sRGBToLinear`) and three.js converts to
  // sRGB at output. Reused across every frame's owner-bank-gradient override.
  const palette = buildLinearPlayerPalette();
  const bankColorLinear = sRGBVecToLinear(BANK_COLOR_SRGB);
  const waterColorLinear = sRGBVecToLinear(WATER_COLOR_SRGB);
  const iceColorLinear = sRGBVecToLinear(ICE_COLOR_SRGB);
  const cobblestoneUniforms = palette.map(({ light }) =>
    sRGBVecToLinear(cobblestoneBaseColor(light)),
  );

  const shaderUniforms = {
    sdfTex: { value: deps.sdfTexture },
    tileDataTex: { value: deps.tileDataTexture },
    mapPxSize: { value: new THREE.Vector2(MAP_PX_W, MAP_PX_H) },
    gridSize: { value: new THREE.Vector2(GRID_COLS, GRID_ROWS) },
    interiorLightLinear: {
      value: palette.map(({ light }) => sRGBVecToLinear(light)),
    },
    interiorDarkLinear: {
      value: palette.map(({ dark }) => sRGBVecToLinear(dark)),
    },
    cobblestoneLinear: { value: cobblestoneUniforms },
    bankColorLinear: { value: bankColorLinear },
    waterColorLinear: { value: waterColorLinear },
    iceColorLinear: { value: iceColorLinear },
    inBattle: { value: false },
  };

  material.customProgramCacheKey = terrainProgramCacheKey;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shaderUniforms);
    patchTerrainShader(shader);
  };
  material.needsUpdate = true;

  const mesh = new THREE.Mesh(geometry, material);
  // Render above the terrain bitmap (Y=0) so opaque interior / bonus
  // / frozen pixels composite over raw grass/water from the bitmap.
  mesh.renderOrder = 0;

  let builtForVersion: number | undefined;

  function ensureBuilt(map: GameMap): void {
    if (builtForVersion === map.mapVersion) return;
    // Nothing to rebuild in geometry — tile positions are fixed. We only
    // track `mapVersion` so `update` knows when the base tile types might
    // have changed (e.g. sinkhole modifier mutates tiles in place).
    builtForVersion = map.mapVersion;
  }

  function update(ctx: FrameCtx): void {
    const { overlay, map } = ctx;
    if (!map) return;
    const inBattle = !!overlay?.battle?.inBattle;
    shaderUniforms.inBattle.value = inBattle;

    const interiorOwners = interiorOwnersFromOverlay(overlay);

    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const tileIdx = r * GRID_COLS + c;
        const key = r * GRID_COLS + c;
        const tile = map.tiles[r]?.[c] ?? Tile.Grass;
        const interiorOwner = interiorOwners.get(key);

        let red: number;
        let green: number;
        let blue: number;
        // alpha=0: transparent, lets the underlying terrain-bitmap
        // plane (raw grass / water / bank pixels) show through.
        // alpha=1: opaque, covers the bitmap at this tile.
        let alpha: number;

        if (interiorOwner !== undefined && tile !== Tile.Water) {
          // Castle interior — checkered per-player tint out of battle,
          // cobblestone-tinted-gray in battle. Matches drawCastleInterior
          // + ownerGrassBase in render-map.ts.
          const baseColor = interiorTileColor(interiorOwner, r, c, inBattle);
          red = baseColor[0];
          green = baseColor[1];
          blue = baseColor[2];
          alpha = 1;
        } else {
          // Raw grass / raw water / owned-sinkhole water — let the terrain
          // bitmap paint the base. Owned-sinkhole pixels are then overridden
          // by the fragment-shader patch with the per-pixel bank gradient
          // toward the owning player's grass color (handles ice via the
          // tile-data texture's frozen flag).
          red = 0;
          green = 0;
          blue = 0;
          alpha = 0;
        }

        const vertBase = tileIdx * 4;
        // Pre-linearize: vertex-color buffers skip THREE's auto sRGB
        // decode, so we do it here. The renderer's PBR pipeline expects
        // linear inputs and re-encodes on output — matching the 2D
        // canvas byte-for-byte requires feeding it linear values.
        writeTileColor(
          colors,
          vertBase,
          sRGBToLinear(red / 255),
          sRGBToLinear(green / 255),
          sRGBToLinear(blue / 255),
          alpha,
        );
      }
    }

    (geometry.attributes["color"] as THREE.BufferAttribute).needsUpdate = true;
  }

  function dispose(): void {
    geometry.dispose();
    material.dispose();
  }

  return { mesh, ensureBuilt, update, dispose };
}

function setVertex(
  target: Float32Array,
  vertIdx: number,
  worldX: number,
  worldY: number,
  worldZ: number,
): void {
  const offset = vertIdx * 3;
  target[offset] = worldX;
  target[offset + 1] = worldY;
  target[offset + 2] = worldZ;
}

function writeTileColor(
  target: Float32Array,
  vertBase: number,
  red: number,
  green: number,
  blue: number,
  alpha: number,
): void {
  for (let i = 0; i < 4; i++) {
    const offset = (vertBase + i) * 4;
    target[offset] = red;
    target[offset + 1] = green;
    target[offset + 2] = blue;
    target[offset + 3] = alpha;
  }
}

/** Return the color for an owned interior tile at (row, col). Mirrors
 *  `ownerGrassBase` in render-map.ts: peacetime uses the 2-shade
 *  checkered interior (light on even parity, dark on odd); battle uses a
 *  uniform cobblestone-tinted-gray per player. */
function interiorTileColor(
  ownerId: ValidPlayerSlot,
  row: number,
  col: number,
  inBattle: boolean,
): RGB {
  const colors = getPlayerColor(ownerId);
  if (inBattle) return cobblestoneBaseColor(colors.interiorLight);
  const isLight = (row + col) % 2 === 0;
  return isLight ? colors.interiorLight : colors.interiorDark;
}

/** Cobblestone base color for a player — mirrors `cobblestoneBaseColor`
 *  in render-map.ts. The 2D sprite adds textured stone detail on top;
 *  the 3D mesh paints just the base since every tile is a single
 *  vertex-colored quad. */
function cobblestoneBaseColor(interiorLight: RGB): RGB {
  return [
    Math.floor(
      COBBLESTONE_BASE[0] + interiorLight[0] * COBBLESTONE_TINT_FACTOR,
    ),
    Math.floor(
      COBBLESTONE_BASE[1] + interiorLight[1] * COBBLESTONE_TINT_FACTOR,
    ),
    Math.floor(
      COBBLESTONE_BASE[2] + interiorLight[2] * COBBLESTONE_TINT_FACTOR,
    ),
  ];
}

/** Convert an sRGB byte triple `[0..255]` to a `THREE.Vector3` in linear
 *  color space. Used for shader uniforms — the fragment shader operates
 *  in linear and three.js converts to sRGB at output. */
function sRGBVecToLinear(srgb: RGB): THREE.Vector3 {
  return new THREE.Vector3(
    sRGBToLinear(srgb[0] / 255),
    sRGBToLinear(srgb[1] / 255),
    sRGBToLinear(srgb[2] / 255),
  );
}

function sRGBToLinear(value: number): number {
  return value <= 0.04045
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** Snapshot the player palette into per-player `{ light, dark }` sRGB
 *  triples. Indexed by `ValidPlayerSlot` (0..MAX_PLAYERS-1) — the shader
 *  reads at `ownerId - 1` after subtracting the +1 sentinel offset stored
 *  in the tile-data texture. */
function buildLinearPlayerPalette(): { light: RGB; dark: RGB }[] {
  const out: { light: RGB; dark: RGB }[] = [];
  for (let pid = 0; pid < MAX_PLAYERS; pid++) {
    const colors = getPlayerColor(pid as ValidPlayerSlot);
    out.push({ light: colors.interiorLight, dark: colors.interiorDark });
  }
  return out;
}

function terrainProgramCacheKey(): string {
  return TERRAIN_PROGRAM_KEY;
}

/** Patch the terrain mesh's `MeshBasicMaterial` shader to override the
 *  per-fragment diffuse color for owned-sinkhole pixels with a per-pixel
 *  bank gradient (toward the owning player's interior grass color, fading
 *  through `BANK_COLOR` into water/ice). Replaces the previous
 *  second-plane `effects/sinkhole-overlay.ts` CanvasTexture upload.
 *
 *  Vertex side: derive `vTerrainUv = position.xz / mapPxSize` so the
 *  fragment can sample the SDF + tile-data textures without three.js's
 *  built-in UV setup (no map texture is bound on this material).
 *
 *  Fragment side: sample the SDF for the per-pixel water/grass distance,
 *  resolve the current tile's owner + flags from the tile-data texture,
 *  and run the GLSL port of `selectTerrainColor` to produce the gradient
 *  when the tile is an owned sinkhole. Other fragments keep the vertex-
 *  color output unchanged. */
function patchTerrainShader(
  shader: THREE.WebGLProgramParametersWithUniforms,
): void {
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>
varying vec2 vTerrainUv;
uniform vec2 mapPxSize;`,
    )
    .replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
vTerrainUv = vec2(position.x, position.z) / mapPxSize;`,
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>
varying vec2 vTerrainUv;
uniform sampler2D sdfTex;
uniform sampler2D tileDataTex;
uniform vec2 gridSize;
uniform vec3 interiorLightLinear[${MAX_PLAYERS}];
uniform vec3 interiorDarkLinear[${MAX_PLAYERS}];
uniform vec3 cobblestoneLinear[${MAX_PLAYERS}];
uniform vec3 bankColorLinear;
uniform vec3 waterColorLinear;
uniform vec3 iceColorLinear;
uniform bool inBattle;

const float BANK_GRASS_DIST = ${GLSL_GRASS_TO_BANK_DIST};
const float BANK_WATER_DIST = ${GLSL_BANK_TO_WATER_DIST};
const float BANK_TRANSITION = ${GLSL_TRANSITION_WIDTH};
const int FLAG_SINKHOLE = 1;
const int FLAG_FROZEN = 2;

vec3 ownerGrassLinear(int ownerIdx, ivec2 tileRC) {
  // ownerIdx clamped to [0, MAX_PLAYERS-1] by the gating ownerId >= 0
  // check below; the tile-data texture's R channel is ownerId+1 so any
  // out-of-range value would have been filtered to the unowned branch
  // before reaching here. WebGL2 allows non-const array indexing directly.
  if (inBattle) return cobblestoneLinear[ownerIdx];
  bool isLight = mod(float(tileRC.x + tileRC.y), 2.0) < 0.5;
  return isLight
    ? interiorLightLinear[ownerIdx]
    : interiorDarkLinear[ownerIdx];
}

vec3 selectBankColor(float distance, vec3 grass, vec3 water) {
  if (distance < BANK_GRASS_DIST) return grass;
  if (distance < BANK_GRASS_DIST + BANK_TRANSITION) {
    float t = smoothstep(0.0, 1.0,
      (distance - BANK_GRASS_DIST) / BANK_TRANSITION);
    return mix(grass, bankColorLinear, t);
  }
  if (distance < BANK_WATER_DIST) return bankColorLinear;
  if (distance < BANK_WATER_DIST + BANK_TRANSITION) {
    float t = smoothstep(0.0, 1.0,
      (distance - BANK_WATER_DIST) / BANK_TRANSITION);
    return mix(bankColorLinear, water, t);
  }
  return water;
}`,
    )
    .replace(
      "#include <alphamap_fragment>",
      `#include <alphamap_fragment>
{
  ivec2 tileRC = ivec2(
    int(floor(vTerrainUv.y * gridSize.y)),
    int(floor(vTerrainUv.x * gridSize.x))
  );
  vec2 tileUv = (vec2(tileRC.y, tileRC.x) + 0.5) / gridSize;
  vec4 tileData = texture2D(tileDataTex, tileUv);
  int ownerId = int(tileData.r * 255.0 + 0.5) - 1;
  int flags = int(tileData.g * 255.0 + 0.5);
  bool isSinkhole = (flags / FLAG_SINKHOLE - (flags / (FLAG_SINKHOLE * 2)) * 2) == 1;
  bool isFrozen = (flags / FLAG_FROZEN - (flags / (FLAG_FROZEN * 2)) * 2) == 1;
  // Gate on the CURRENT tile being an owned sinkhole, NOT on the SDF
  // sign. After the box-blur on the chamfer distance, corner pixels of
  // a 2x2 sinkhole can dip slightly negative; selectBankColor below
  // returns the owner-grass color for those (d < BANK_GRASS_DIST), which
  // matches the 2D renderSinkholeTilePatch behavior — paint the whole
  // water tile, let the bank math decide grass / bank / water per pixel.
  if (ownerId >= 0 && isSinkhole) {
    float d = texture2D(sdfTex, vTerrainUv).r;
    vec3 grass = ownerGrassLinear(ownerId, tileRC);
    vec3 water = isFrozen ? iceColorLinear : waterColorLinear;
    vec3 color = selectBankColor(d, grass, water);
    diffuseColor = vec4(color, 1.0);
  }
}`,
    );
}
