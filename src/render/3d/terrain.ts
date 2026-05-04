/**
 * 3D terrain overlay mesh for the world renderer.
 *
 * One `BufferGeometry` of `GRID_ROWS * GRID_COLS` RGBA-vertex-colored quads
 * sitting at Y=ELEVATION_STACK.TERRAIN_MESH (just above the terrain bitmap
 * plane at Y=0). Vertex colors paint per-tile overlays (castle interiors at
 * alpha=1); raw grass/water tiles output alpha=0 so the underlying bitmap
 * shows through. A fragment-shader patch added via `onBeforeCompile` then
 * does per-pixel work on top:
 *
 *   - Owned-sinkhole tiles: replaces the diffuse with the SDF-driven
 *     grass→bank→water gradient, owner-tinted. Replaces the previous
 *     CPU-baked `effects/sinkhole-overlay.ts` second-plane CanvasTexture.
 *   - Open-water pixels in battle: layers the drifting wave highlights
 *     that used to live in `effects/water-waves.ts`, gated per-fragment
 *     on the SDF so bank-zone pixels stay clean (the 2D code's per-tile
 *     "all 4 cardinal neighbors are water" check is now an SDF-aware
 *     per-pixel `d > BANK_WATER_DIST + BANK_TRANSITION` test).
 *
 * Both per-pixel passes share the same SDF + tile-data DataTextures
 * (created by `effects/terrain-sdf-texture.ts` + `effects/terrain-tile-data.ts`).
 *
 * Per-tile vertex-color responsibilities:
 *   - Castle interiors: 2-shade checkered tint from the owning player's
 *     `interiorLight`/`interiorDark` palette, swapped to a uniform
 *     cobblestone-tinted-gray during battle. Sourced from the same
 *     `castle.interior` / `overlay.battle.battleTerritory` sets the 2D
 *     `drawCastleInterior` reads; the 2D `interiors` layer is flipped off
 *     in 3D mode so the mesh owns the visual outright.
 *   - Battle grass: out-of-interior grass tiles use GRASS_BATTLE during
 *     battle (flat darkened green), mirroring the 2D `grassBaseColor`
 *     battle branch.
 *   - Everything else (raw grass, water, owned-sinkhole water tiles):
 *     alpha=0; the bitmap or shader patch owns the visual.
 *
 * Color parity: base RGB values mirror the 2D renderer's tile palette in
 * `render-map.ts` (GRASS_DARK/LIGHT/BATTLE) and the
 * `bonus_square` / `burning_pit_*` sprites in `scripts/generate-sprites.html`.
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
// Wave-overlay highlight + shadow stops — mirror the (now-deleted)
// effects/water-waves.ts CanvasTexture pass. The shader paints the same
// drifting 1-px highlight + 1-px shadow per layer per fragment, gated on
// the SDF-aware open-water threshold below so bank pixels stay clean.
const WAVE_HIGHLIGHT_SRGB: RGB = [140, 200, 255];
const WAVE_SHADOW_SRGB: RGB = [20, 60, 120];
// SDF-distance thresholds (units = pixels in the blurred SDF). Same numbers
// as `render-map.ts`'s `GRASS_TO_BANK_DIST` / `BANK_TO_WATER_DIST` /
// `TRANSITION_WIDTH` — kept here as GLSL string constants so the shader
// patch doesn't need uniform plumbing for them.
const GLSL_GRASS_TO_BANK_DIST = "2.0";
const GLSL_BANK_TO_WATER_DIST = "4.0";
const GLSL_TRANSITION_WIDTH = "1.5";
// Bumped on every shader-source change — three.js dedupes programs by this
// key and reuses the cached one if it matches, so a stale key would silently
// keep the previous shader running after edits (HMR or otherwise).
const TERRAIN_PROGRAM_KEY = "terrain-sinkhole-waves-shader-v5";

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
  const waveHighlightLinear = sRGBVecToLinear(WAVE_HIGHLIGHT_SRGB);
  const waveShadowLinear = sRGBVecToLinear(WAVE_SHADOW_SRGB);
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
    waveHighlightLinear: { value: waveHighlightLinear },
    waveShadowLinear: { value: waveShadowLinear },
    inBattle: { value: false },
    wavesTimeSec: { value: 0 },
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
    const { overlay, map, now } = ctx;
    if (!map) return;
    const inBattle = !!overlay?.battle?.inBattle;
    shaderUniforms.inBattle.value = inBattle;
    shaderUniforms.wavesTimeSec.value = now / 1000;

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
uniform vec2 mapPxSize;
uniform vec2 gridSize;
uniform vec3 interiorLightLinear[${MAX_PLAYERS}];
uniform vec3 interiorDarkLinear[${MAX_PLAYERS}];
uniform vec3 cobblestoneLinear[${MAX_PLAYERS}];
uniform vec3 bankColorLinear;
uniform vec3 waterColorLinear;
uniform vec3 iceColorLinear;
uniform vec3 waveHighlightLinear;
uniform vec3 waveShadowLinear;
uniform bool inBattle;
uniform float wavesTimeSec;

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
}

// Three drifting 1-px highlight + 1-px shadow lines per tile, deterministic
// in (time, row, col, layer). Mirrors the (now-deleted) 2D drawWaterAnimation
// inner loop. Caller gates per-fragment on the SDF-aware open-water threshold
// so bank-zone pixels stay clean — that's the per-pixel replacement for the
// 2D code's per-tile "all 4 neighbors are water" exclusion. Both the bitmap-painted
// bank gradient (unowned sinkholes / regular water) and the shader-painted
// owner-bank gradient land OUTSIDE this gate, so the wave overlay never
// stacks on top of bank colors.
// Returns the final fragment color (premultiplied-alpha rgba) for the wave
// overlay. The terrain mesh's vertex-color alpha is 0 on water tiles so the
// underlying terrain bitmap shows through; we have to OWN the alpha here
// (modifying only .rgb leaves the fragment transparent and invisible).
// Non-wave fragments return the original color unchanged.
vec4 applyWaveOverlay(vec4 base, ivec2 tileRC, vec2 worldPx) {
  vec4 result = base;
  int worldXInt = int(floor(worldPx.x));
  int worldYInt = int(floor(worldPx.y));
  int tileX0 = tileRC.y * 16;
  int tileY0 = tileRC.x * 16;
  for (int layer = 0; layer < 3; layer++) {
    // Vertical bob + length/alpha pulse — the original 2D drawWaterAnimation
    // formula. waveY oscillates over the 13-pixel inner band of the tile.
    float phase = wavesTimeSec * (0.8 + float(layer) * 0.3)
                + float(tileRC.x) * (0.5 + float(layer) * 0.2)
                + float(tileRC.y) * (0.3 + float(layer) * 0.15)
                + float(layer) * 2.1;
    float wave = sin(phase) * 0.5 + 0.5;
    int waveY = tileY0 + 1 + int(floor(wave * 13.0));
    int waveLen = 3 + int(floor(wave * 4.0));
    // Horizontal drift — a second sine on a different frequency so each
    // layer slides across the tile independently of its vertical bob.
    // Range chosen so the wave segment stays inside the tile interior
    // (waveX in [tileX0+1, tileX0+1+(12-waveLen)]).
    float xPhase = wavesTimeSec * (0.6 + float(layer) * 0.25)
                 + float(tileRC.x) * 0.37
                 + float(tileRC.y) * 0.41
                 + float(layer) * 1.7;
    float xWave = sin(xPhase) * 0.5 + 0.5;
    int xRange = 12 - waveLen;
    int waveX = tileX0 + 1 + int(floor(xWave * float(xRange)));
    // Alpha doubled vs the 2D's 0.06..0.15 — lifts the 1-pixel highlight
    // above the bitmap's static WAVE_TEX pattern noise floor without
    // overpowering the underlying water color.
    float alpha = (0.06 + wave * 0.09) * 2.0;
    if (worldYInt == waveY && worldXInt >= waveX && worldXInt < waveX + waveLen) {
      result = mix(result, vec4(waveHighlightLinear, 1.0), alpha);
    } else if (worldYInt == waveY + 1 && worldXInt >= waveX && worldXInt < waveX + waveLen) {
      result = mix(result, vec4(waveShadowLinear, 1.0), alpha * 0.5);
    }
  }
  return result;
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
  float d = texture2D(sdfTex, vTerrainUv).r;
  // Gate on the CURRENT tile being an owned sinkhole, NOT on the SDF
  // sign. After the box-blur on the chamfer distance, corner pixels of
  // a 2x2 sinkhole can dip slightly negative; selectBankColor below
  // returns the owner-grass color for those (d < BANK_GRASS_DIST), which
  // matches the 2D renderSinkholeTilePatch behavior — paint the whole
  // water tile, let the bank math decide grass / bank / water per pixel.
  if (ownerId >= 0 && isSinkhole) {
    vec3 grass = ownerGrassLinear(ownerId, tileRC);
    vec3 water = isFrozen ? iceColorLinear : waterColorLinear;
    vec3 color = selectBankColor(d, grass, water);
    diffuseColor = vec4(color, 1.0);
  } else if (inBattle && !isSinkhole && !isFrozen
             && d > BANK_WATER_DIST + BANK_TRANSITION) {
    // Open-water wave overlay — replaces effects/water-waves.ts. The
    // d > BANK_WATER_DIST + BANK_TRANSITION gate is the SDF-aware
    // per-pixel equivalent of the 2D code per-tile "all 4 neighbors are
    // water" check; bank-edge water tiles now get waves on their interior
    // pixels (closer to a continuous open-water look).
    vec2 worldPx = vTerrainUv * mapPxSize;
    diffuseColor = applyWaveOverlay(diffuseColor, tileRC, worldPx);
  }
}`,
    );
}
