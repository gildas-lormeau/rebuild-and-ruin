/**
 * 3D terrain mesh for the world renderer — paints every pixel of the map's
 * ground plane in a single shader patch on stock `MeshBasicMaterial`.
 *
 * One `BufferGeometry` of `GRID_ROWS * GRID_COLS` RGBA-vertex-colored quads
 * sitting at Y=ELEVATION_STACK.TERRAIN_MESH. Vertex colors carry castle
 * interior tints (alpha=1, opaque); raw terrain tiles get vertex
 * (rgba)=(0,0,0,0) and the fragment-shader patch paints them per-pixel:
 *
 *   - Default branch: paints grass / water / bank / ice using the SDF and
 *     the per-tile `FLAG_FROZEN` bit. Replaces the CPU-baked terrain
 *     bitmap that used to sit on a separate plane below this mesh
 *     (`effects/terrain-bitmap.ts`, deleted alongside `renderTerrainPixels`
 *     and the `GRASS_TEX` / `WATER_TEX` lookup tables in `render-map.ts`).
 *   - Owned-sinkhole branch: replaces the diffuse with the SDF-driven
 *     grass→bank→water gradient, owner-tinted (was `effects/sinkhole-overlay.ts`).
 *   - Open-water + battle: layers the drifting wave highlights on top of
 *     the flat water color (was `effects/water-waves.ts`). The flat-blue
 *     water in non-battle phases is the deliberate look — no static wave
 *     mask carries over from the old CPU bake.
 *
 * Per-pixel grass-blade pattern (battle only) comes from a static 16×16
 * R32F texture in `effects/terrain-pattern-textures.ts` — sampled, decoded
 * to an sRGB-byte offset, and applied to grass color via a sRGB round-trip
 * to match the byte-exact look of the original `texturedColor` bake.
 *
 * Per-tile vertex-color responsibilities:
 *   - Castle interiors: 2-shade checkered tint from the owning player's
 *     `interiorLight`/`interiorDark` palette, swapped to a uniform
 *     cobblestone-tinted-gray during battle. Sourced from the same
 *     `castle.interior` / `overlay.battle.battleTerritory` sets the 2D
 *     `drawCastleInterior` reads; the 2D `interiors` layer is flipped off
 *     in 3D mode so the mesh owns the visual outright.
 *   - Everything else: alpha=0; the shader patch owns the visual.
 *
 * Color parity: base RGB values mirror the original 2D renderer's tile
 * palette and the `bonus_square` / `burning_pit_*` sprites in
 * `scripts/generate-sprites.html`.
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
 *  All three are owned by separate managers (`effects/terrain-sdf-texture.ts`,
 *  `effects/terrain-tile-data.ts`, `effects/terrain-pattern-textures.ts`)
 *  and refreshed by their own update calls before each frame's
 *  `terrain.update`. */
interface TerrainDeps {
  readonly sdfTexture: THREE.DataTexture;
  readonly tileDataTexture: THREE.DataTexture;
  readonly grassPatternTexture: THREE.DataTexture;
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

// Cobblestone base color for battle-mode interiors. Intentionally
// lighter than the historical 2D sprite's `COBBLESTONE_BASE = [90, 85, 80]`:
// at 3D's tile resolution the uniform dark base swallowed tower silhouettes,
// so we fade it toward a light stone gray to boost contrast with castle
// geometry.
const COBBLESTONE_BASE: [number, number, number] = [125, 120, 115];
const COBBLESTONE_TINT_FACTOR = 0.13;
// Default terrain palette — sRGB byte triples, mirrored from the original
// 2D bake. Pre-linearized into uniforms at material init.
const GRASS_DARK_SRGB: RGB = [45, 140, 45];
const GRASS_LIGHT_SRGB: RGB = [51, 153, 51];
const GRASS_BATTLE_SRGB: RGB = [
  Math.floor(51 * 0.85),
  Math.floor(153 * 0.85),
  Math.floor(51 * 0.85),
];
const BANK_COLOR_SRGB: RGB = [139, 58, 26];
const WATER_COLOR_SRGB: RGB = [40, 104, 176];
const ICE_COLOR_SRGB: RGB = [165, 210, 230];
// Wave-overlay highlight + shadow stops for the in-battle animated drifting
// waves layered over open water. No static counterpart — out of battle the
// water is flat blue.
const WAVE_HIGHLIGHT_SRGB: RGB = [140, 200, 255];
const WAVE_SHADOW_SRGB: RGB = [20, 60, 120];
// SDF-distance thresholds (units = pixels in the blurred SDF). Same numbers
// as the historical `GRASS_TO_BANK_DIST` / `BANK_TO_WATER_DIST` /
// `TRANSITION_WIDTH` — kept here as GLSL string constants so the shader
// patch doesn't need uniform plumbing for them.
const GLSL_GRASS_TO_BANK_DIST = "2.0";
const GLSL_BANK_TO_WATER_DIST = "4.0";
const GLSL_TRANSITION_WIDTH = "1.5";
const GLSL_ICE_BLEND_WIDTH = "4.0";
// Bumped on every shader-source change — three.js dedupes programs by this
// key and reuses the cached one if it matches, so a stale key would silently
// keep the previous shader running after edits (HMR or otherwise).
const TERRAIN_PROGRAM_KEY = "terrain-full-paint-shader-v6";

export function createTerrain(deps: TerrainDeps): TerrainContext {
  const tileCount = GRID_ROWS * GRID_COLS;
  const vertsPerTile = 4;
  const trisPerTile = 2;

  const positions = new Float32Array(tileCount * vertsPerTile * 3);
  const indices = new Uint32Array(tileCount * trisPerTile * 3);
  // RGBA vertex colors: castle interiors get alpha=1 (opaque tint); raw
  // grass / water / bank / ice tiles get alpha=0 and are painted entirely
  // by the fragment-shader patch.
  const colors = new Float32Array(tileCount * vertsPerTile * 4);

  // Build static position + index buffers — these never change at runtime.
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
  geometry.computeVertexNormals();
  geometry.attributes["position"]!.needsUpdate = false;

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.FrontSide,
    // The shader patch paints every fragment, so the mesh is fully opaque.
    // Vertex-color alpha is repurposed as an "is interior" mask the shader
    // branches on; nothing is composited through to a layer below.
    transparent: false,
    depthWrite: true,
  });

  // Pre-linearize the palette + terrain color constants once at material
  // init. The shader operates in linear color space (matches the existing
  // vertex-color path's `sRGBToLinear`) and three.js converts to sRGB at
  // output. Reused across every frame.
  const palette = buildLinearPlayerPalette();
  const grassDarkLinear = sRGBVecToLinear(GRASS_DARK_SRGB);
  const grassLightLinear = sRGBVecToLinear(GRASS_LIGHT_SRGB);
  const grassBattleLinear = sRGBVecToLinear(GRASS_BATTLE_SRGB);
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
    grassPatternTex: { value: deps.grassPatternTexture },
    mapPxSize: { value: new THREE.Vector2(MAP_PX_W, MAP_PX_H) },
    gridSize: { value: new THREE.Vector2(GRID_COLS, GRID_ROWS) },
    interiorLightLinear: {
      value: palette.map(({ light }) => sRGBVecToLinear(light)),
    },
    interiorDarkLinear: {
      value: palette.map(({ dark }) => sRGBVecToLinear(dark)),
    },
    cobblestoneLinear: { value: cobblestoneUniforms },
    grassDarkLinear: { value: grassDarkLinear },
    grassLightLinear: { value: grassLightLinear },
    grassBattleLinear: { value: grassBattleLinear },
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
  mesh.renderOrder = 0;

  let builtForVersion: number | undefined;

  function ensureBuilt(map: GameMap): void {
    if (builtForVersion === map.mapVersion) return;
    // Tile positions are fixed; only `mapVersion` changes (e.g. sinkhole
    // modifier mutates tiles in place) — tracked so `update` knows when
    // the underlying tile types might have shifted.
    builtForVersion = map.mapVersion;
  }

  function update(ctx: FrameCtx): void {
    const { overlay, map, now } = ctx;
    // Bail when overlay is undefined so this mesh and the tile-data
    // texture (which has the same guard) stay in sync — otherwise the
    // mesh would repaint to "no interiors" while the tile-data texture
    // kept flagging them owned, briefly turning interiors into raw
    // terrain. Overlay is always defined during gameplay; this guards
    // against pre-first-frame / teardown ticks.
    if (!map || !overlay) return;
    const inBattle = !!overlay.battle?.inBattle;
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
        // alpha=1: shader keeps vertex color (interior tint).
        // alpha=0: shader paints grass / water / bank / ice / sinkhole
        // gradient itself.
        let alpha: number;

        if (interiorOwner !== undefined && tile !== Tile.Water) {
          const baseColor = interiorTileColor(interiorOwner, r, c, inBattle);
          red = baseColor[0];
          green = baseColor[1];
          blue = baseColor[2];
          alpha = 1;
        } else {
          red = 0;
          green = 0;
          blue = 0;
          alpha = 0;
        }

        const vertBase = tileIdx * 4;
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

/** Return the color for an owned interior tile at (row, col). Mirrors the
 *  original `ownerGrassBase`: peacetime uses the 2-shade checkered interior
 *  (light on even parity, dark on odd); battle uses a uniform
 *  cobblestone-tinted-gray per player. */
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

/** Cobblestone base color for a player. The 2D sprite added textured stone
 *  detail on top; the 3D mesh paints just the base since every tile is a
 *  single vertex-colored quad. */
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
 *  color space. */
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

/** Patch the terrain mesh's `MeshBasicMaterial` shader so the fragment
 *  pass paints every non-interior pixel itself: the default branch
 *  reproduces the historical CPU bake (grass / bank / water / ice via the
 *  blurred SDF, plus a 16×16 grass-blade pattern texture in battle), the
 *  owned-sinkhole branch swaps the grass terminus for the owner-tinted
 *  color, and the open-water branch in battle layers drifting wave
 *  highlights on top.
 *
 *  Vertex side: derive `vTerrainUv = position.xz / mapPxSize` so the
 *  fragment can sample the SDF + tile-data textures without three.js's
 *  built-in UV setup (no map texture is bound on this material).
 *
 *  Fragment side: branch on `vColor.a` — alpha=1 means the vertex-color
 *  already carries the interior tint (do nothing), alpha=0 means run the
 *  full terrain-paint path. */
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
uniform sampler2D grassPatternTex;
uniform vec2 mapPxSize;
uniform vec2 gridSize;
uniform vec3 interiorLightLinear[${MAX_PLAYERS}];
uniform vec3 interiorDarkLinear[${MAX_PLAYERS}];
uniform vec3 cobblestoneLinear[${MAX_PLAYERS}];
uniform vec3 grassDarkLinear;
uniform vec3 grassLightLinear;
uniform vec3 grassBattleLinear;
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
const float ICE_BLEND_WIDTH = ${GLSL_ICE_BLEND_WIDTH};
const int FLAG_SINKHOLE = 1;
const int FLAG_FROZEN = 2;

bool isFlagSet(int flags, int mask) {
  return (flags / mask - (flags / (mask * 2)) * 2) == 1;
}

vec3 srgbToLinearVec(vec3 c) {
  return mix(
    c / 12.92,
    pow((c + 0.055) / 1.055, vec3(2.4)),
    step(vec3(0.04045), c)
  );
}

vec3 linearToSrgbVec(vec3 c) {
  return mix(
    c * 12.92,
    1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055,
    step(vec3(0.0031308), c)
  );
}

vec3 ownerGrassLinear(int ownerIdx, ivec2 tileRC) {
  if (inBattle) return cobblestoneLinear[ownerIdx];
  bool isLight = mod(float(tileRC.x + tileRC.y), 2.0) < 0.5;
  return isLight
    ? interiorLightLinear[ownerIdx]
    : interiorDarkLinear[ownerIdx];
}

vec3 defaultGrassLinear(ivec2 tileRC) {
  if (inBattle) return grassBattleLinear;
  bool isLight = mod(float(tileRC.x + tileRC.y), 2.0) < 0.5;
  return isLight ? grassDarkLinear : grassLightLinear;
}

// Sample the per-pixel grass-blade offset (signed sRGB-byte fraction) and
// apply it to a linear grass color via a sRGB round-trip. Mirrors the
// original CPU-bake's texturedColor() byte-add-and-clamp behavior.
vec3 applyGrassPattern(vec3 grass, vec2 worldPx) {
  ivec2 inTile = ivec2(int(floor(worldPx.x)) - (int(floor(worldPx.x)) / 16) * 16,
                       int(floor(worldPx.y)) - (int(floor(worldPx.y)) / 16) * 16);
  float offset = texture2D(
    grassPatternTex,
    (vec2(inTile) + 0.5) / vec2(16.0)
  ).r;
  if (offset == 0.0) return grass;
  vec3 srgb = linearToSrgbVec(grass) + vec3(offset);
  srgb = clamp(srgb, 0.0, 1.0);
  return srgbToLinearVec(srgb);
}

// Sample the FLAG_FROZEN bit at a neighbor tile. Returns false for
// out-of-bounds neighbors so the edge of the map behaves the same as a
// non-frozen neighbor (matches frozenTiles.has() returning false).
bool isFrozenAt(ivec2 nrc) {
  if (nrc.x < 0 || nrc.x >= int(gridSize.y)) return false;
  if (nrc.y < 0 || nrc.y >= int(gridSize.x)) return false;
  vec2 uv = (vec2(nrc.y, nrc.x) + 0.5) / gridSize;
  vec4 nData = texture2D(tileDataTex, uv);
  int nFlags = int(nData.g * 255.0 + 0.5);
  return isFlagSet(nFlags, FLAG_FROZEN);
}

// For a pixel inside a frozen tile, returns 0..1 indicating "icyness":
// 1 = deep ice (interior), 0 = right at a non-frozen neighbor edge. GLSL
// port of the historical 2D iceEdgeBlend — cardinal + diagonal neighbor
// lookups, smoothstep over ICE_BLEND_WIDTH pixels.
float iceEdgeBlend(ivec2 tileRC, vec2 worldPx) {
  int lx = int(floor(worldPx.x)) - tileRC.y * 16;
  int ly = int(floor(worldPx.y)) - tileRC.x * 16;
  int ex = 15 - lx;
  int ey = 15 - ly;
  bool top = !isFrozenAt(tileRC + ivec2(-1, 0));
  bool bot = !isFrozenAt(tileRC + ivec2(1, 0));
  bool lft = !isFrozenAt(tileRC + ivec2(0, -1));
  bool rgt = !isFrozenAt(tileRC + ivec2(0, 1));
  float minDist = ICE_BLEND_WIDTH;
  if (top) minDist = min(minDist, float(ly));
  if (bot) minDist = min(minDist, float(ey));
  if (lft) minDist = min(minDist, float(lx));
  if (rgt) minDist = min(minDist, float(ex));
  if (top && lft) minDist = min(minDist, sqrt(float(lx * lx + ly * ly)));
  if (top && rgt) minDist = min(minDist, sqrt(float(ex * ex + ly * ly)));
  if (bot && lft) minDist = min(minDist, sqrt(float(lx * lx + ey * ey)));
  if (bot && rgt) minDist = min(minDist, sqrt(float(ex * ex + ey * ey)));
  float t = clamp(minDist / ICE_BLEND_WIDTH, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

// Pick the per-pixel terrain color from the SDF: grass for distance below
// BANK_GRASS_DIST, smoothstep into bank, then smoothstep into water past
// BANK_WATER_DIST. Grass tiles always land in the first branch (their SDF
// distance is negative).
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
// in (time, row, col, layer). Caller gates per-fragment on the SDF-aware
// open-water threshold so bank-zone pixels stay clean.
vec4 applyWaveOverlay(vec4 base, ivec2 tileRC, vec2 worldPx) {
  vec4 result = base;
  int worldXInt = int(floor(worldPx.x));
  int worldYInt = int(floor(worldPx.y));
  int tileX0 = tileRC.y * 16;
  int tileY0 = tileRC.x * 16;
  for (int layer = 0; layer < 3; layer++) {
    float phase = wavesTimeSec * (0.8 + float(layer) * 0.3)
                + float(tileRC.x) * (0.5 + float(layer) * 0.2)
                + float(tileRC.y) * (0.3 + float(layer) * 0.15)
                + float(layer) * 2.1;
    float wave = sin(phase) * 0.5 + 0.5;
    int waveY = tileY0 + 1 + int(floor(wave * 13.0));
    int waveLen = 3 + int(floor(wave * 4.0));
    float xPhase = wavesTimeSec * (0.6 + float(layer) * 0.25)
                 + float(tileRC.x) * 0.37
                 + float(tileRC.y) * 0.41
                 + float(layer) * 1.7;
    float xWave = sin(xPhase) * 0.5 + 0.5;
    int xRange = 12 - waveLen;
    int waveX = tileX0 + 1 + int(floor(xWave * float(xRange)));
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
  // Branch on the vertex-color alpha: alpha=1 means an interior tile,
  // diffuseColor already has the player tint baked in by <color_fragment>;
  // alpha=0 means a raw terrain tile, this patch paints it from scratch.
  if (vColor.a < 0.5) {
    ivec2 tileRC = ivec2(
      int(floor(vTerrainUv.y * gridSize.y)),
      int(floor(vTerrainUv.x * gridSize.x))
    );
    vec2 tileUv = (vec2(tileRC.y, tileRC.x) + 0.5) / gridSize;
    vec4 tileData = texture2D(tileDataTex, tileUv);
    int ownerId = int(tileData.r * 255.0 + 0.5) - 1;
    int flags = int(tileData.g * 255.0 + 0.5);
    bool isSinkhole = isFlagSet(flags, FLAG_SINKHOLE);
    bool isFrozen = isFlagSet(flags, FLAG_FROZEN);
    float d = texture2D(sdfTex, vTerrainUv).r;
    vec2 worldPx = vTerrainUv * mapPxSize;

    vec3 grass;
    vec3 water;
    if (ownerId >= 0 && isSinkhole) {
      // Owned-sinkhole gradient (was effects/sinkhole-overlay.ts). Paint
      // the whole water tile, let the bank math decide grass / bank /
      // water per pixel — matches the historical renderSinkholeTilePatch.
      grass = ownerGrassLinear(ownerId, tileRC);
      water = isFrozen ? iceColorLinear : waterColorLinear;
    } else {
      grass = defaultGrassLinear(tileRC);
      water = isFrozen
        ? mix(waterColorLinear, iceColorLinear, iceEdgeBlend(tileRC, worldPx))
        : waterColorLinear;
    }
    if (inBattle) {
      grass = applyGrassPattern(grass, worldPx);
    }
    vec3 terrainColor = selectBankColor(d, grass, water);
    diffuseColor = vec4(terrainColor, 1.0);

    // Open-water wave overlay (was effects/water-waves.ts) — the SDF gate
    // is the per-pixel equivalent of the 2D code's per-tile "all 4
    // neighbors are water" check, so bank-edge water tiles get waves on
    // their interior pixels for a more continuous open-water look.
    if (inBattle && !isSinkhole && !isFrozen
        && d > BANK_WATER_DIST + BANK_TRANSITION) {
      diffuseColor = applyWaveOverlay(diffuseColor, tileRC, worldPx);
    }
  }
}`,
    );
}
