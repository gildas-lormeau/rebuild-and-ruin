/**
 * 3D terrain mesh — flat quads at `ELEVATION_STACK.TERRAIN_MESH` with a
 * `MeshBasicMaterial` fragment patch painting every fragment from scratch:
 * grass / water / bank / ice via the SDF + `FLAG_FROZEN`, owner-tinted
 * interior + bank gradient inside owned territory, and open-water waves
 * during battle. Battle grass uses a 16×16 R32F pattern. Palette = 2D
 * tiles for byte parity.
 */

import * as THREE from "three";
import { Phase } from "../../shared/core/game-phase.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  MAP_PX_H,
  MAP_PX_W,
  TILE_SIZE,
} from "../../shared/core/grid.ts";
import type { ValidPlayerId } from "../../shared/core/player-slot.ts";
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
  readonly cobblestonePatternTexture: THREE.DataTexture;
}

export interface TerrainContext {
  readonly mesh: THREE.Mesh;
  /** Per-frame uniform refresh (battle flag, wave clock). The geometry
   *  is static; everything else flows through the SDF + tile-data textures
   *  the shader samples. */
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
const GRASS_DARK_SRGB: RGB = [0, 113, 0];
// #007100
const GRASS_LIGHT_SRGB: RGB = [0, 134, 0];
// #008600
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
const TERRAIN_PROGRAM_KEY = "terrain-full-paint-shader-v7";

export function createTerrain(deps: TerrainDeps): TerrainContext {
  const tileCount = GRID_ROWS * GRID_COLS;
  const vertsPerTile = 4;
  const trisPerTile = 2;

  const positions = new Float32Array(tileCount * vertsPerTile * 3);
  const indices = new Uint32Array(tileCount * trisPerTile * 3);

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
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.attributes["position"]!.needsUpdate = false;

  const material = new THREE.MeshBasicMaterial({
    side: THREE.FrontSide,
    // The shader patch paints every fragment from scratch (no map texture,
    // no vertex colors), so the mesh is fully opaque.
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
    cobblestonePatternTex: { value: deps.cobblestonePatternTexture },
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

  function update(ctx: FrameCtx): void {
    const { overlay, now } = ctx;
    // Overlay is always defined during gameplay; this guards against
    // pre-first-frame / teardown ticks.
    if (!overlay) return;
    shaderUniforms.inBattle.value = overlay.phase === Phase.BATTLE;
    shaderUniforms.wavesTimeSec.value = now / 1000;
  }

  function dispose(): void {
    geometry.dispose();
    material.dispose();
  }

  return { mesh, update, dispose };
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

/** Cobblestone base color for a player. The 2D sprite added textured stone
 *  detail on top; the 3D mesh's fragment shader stamps a pattern texture
 *  on top of this base to match. */
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
 *  triples. Indexed by `ValidPlayerId` (0..MAX_PLAYERS-1) — the shader
 *  reads at `ownerId - 1` after subtracting the +1 sentinel offset stored
 *  in the tile-data texture. */
function buildLinearPlayerPalette(): { light: RGB; dark: RGB }[] {
  const out: { light: RGB; dark: RGB }[] = [];
  for (let pid = 0; pid < MAX_PLAYERS; pid++) {
    const colors = getPlayerColor(pid as ValidPlayerId);
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
 *  owned-water branch (any water tile inside an owned interior) swaps the
 *  grass terminus for the owner-tinted color, and the open-water branch in
 *  battle layers drifting wave highlights on top.
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
uniform sampler2D cobblestonePatternTex;
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

// Checker parity convention (mirrors the retired 2D bake): even
// (col+row) tiles use the LIGHT interior shade but the DARK default
// grass — the two palettes alternate in opposite phase by design.
vec3 ownerGrassLinear(int ownerIdx, ivec2 tileRC) {
  if (inBattle) return cobblestoneLinear[ownerIdx];
  bool parityEven = mod(float(tileRC.x + tileRC.y), 2.0) < 0.5;
  return parityEven
    ? interiorLightLinear[ownerIdx]
    : interiorDarkLinear[ownerIdx];
}

vec3 defaultGrassLinear(ivec2 tileRC) {
  if (inBattle) return grassBattleLinear;
  bool parityEven = mod(float(tileRC.x + tileRC.y), 2.0) < 0.5;
  return parityEven ? grassDarkLinear : grassLightLinear;
}

// Sample a per-pixel pattern offset (signed sRGB-byte fraction) and apply
// it to a linear color via a sRGB round-trip. Mirrors the original CPU-bake's
// texturedColor() byte-add-and-clamp behavior. Used for both the grass-blade
// pattern (raw grass tiles in battle) and the cobblestone pattern (owned
// interiors in battle).
vec3 applyPatternOffset(vec3 base, vec2 worldPx, sampler2D patternTex) {
  ivec2 inTile = ivec2(int(floor(worldPx.x)) - (int(floor(worldPx.x)) / 16) * 16,
                       int(floor(worldPx.y)) - (int(floor(worldPx.y)) / 16) * 16);
  float offset = texture2D(
    patternTex,
    (vec2(inTile) + 0.5) / vec2(16.0)
  ).r;
  if (offset == 0.0) return base;
  vec3 srgb = linearToSrgbVec(base) + vec3(offset);
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
  // Full-paint terrain: every fragment derives its color from the SDF
  // (grass / bank / water gradient) and the tile-data texture (owner +
  // flags). No vertex-color shortcut — phantom overrides like high_tide
  // flooded grass and low_water exposed riverbed flow through the SDF,
  // so they MUST hit this branch unconditionally to render correctly.
  vec2 worldPx = vTerrainUv * mapPxSize;
  ivec2 tileRC = ivec2(
    int(floor(vTerrainUv.y * gridSize.y)),
    int(floor(vTerrainUv.x * gridSize.x))
  );
  vec2 tileUv = (vec2(tileRC.y, tileRC.x) + 0.5) / gridSize;
  vec4 tileData = texture2D(tileDataTex, tileUv);
  int ownerId = int(tileData.r * 255.0 + 0.5) - 1;
  int flags = int(tileData.g * 255.0 + 0.5);
  bool isFrozen = isFlagSet(flags, FLAG_FROZEN);
  float d = texture2D(sdfTex, vTerrainUv).r;

  vec3 grass;
  vec3 water;
  bool inOwnedInterior = ownerId >= 0;
  if (inOwnedInterior) {
    // Any tile inside an owned interior (grass, sinkhole, high-tide
    // flooded, or a naturally enclosed bay) paints with the player's
    // grass terminus so the SDF bank transition matches the surrounding
    // territory. ownerGrassLinear returns the cobblestone base in battle.
    grass = ownerGrassLinear(ownerId, tileRC);
    water = isFrozen ? iceColorLinear : waterColorLinear;
  } else {
    grass = defaultGrassLinear(tileRC);
    water = isFrozen
      ? mix(waterColorLinear, iceColorLinear, iceEdgeBlend(tileRC, worldPx))
      : waterColorLinear;
  }
  if (inBattle) {
    // Owned tiles get the cobblestone pattern (both flat interior and
    // bank gradient); unowned grass gets the grass-blade pattern.
    grass = inOwnedInterior
      ? applyPatternOffset(grass, worldPx, cobblestonePatternTex)
      : applyPatternOffset(grass, worldPx, grassPatternTex);
  }
  vec3 terrainColor = selectBankColor(d, grass, water);
  diffuseColor = vec4(terrainColor, 1.0);

  // Open-water wave overlay (replacing the old 2D water-waves effect) — the SDF gate
  // is the per-pixel equivalent of the 2D code's per-tile "all 4
  // neighbors are water" check, so bank-edge water tiles get waves on
  // their interior pixels for a more continuous open-water look.
  // Suppressed on owned-interior tiles (the small enclosed pool look —
  // sinkholes, enclosed high-tide, bays — doesn't suit the drifting
  // wave effect, which was tuned for the open river).
  if (inBattle && !inOwnedInterior && !isFrozen
      && d > BANK_WATER_DIST + BANK_TRANSITION) {
    diffuseColor = applyWaveOverlay(diffuseColor, tileRC, worldPx);
  }
}`,
    );
}
