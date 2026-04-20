/**
 * 3D terrain mesh for the world renderer.
 *
 * Phase 2 of the 3D renderer migration (see docs/3d-renderer-migration.md).
 * Renders the base map terrain — grass, water (animated), frozen water, bonus
 * squares, and burning-pit placeholders — as a single `BufferGeometry` of
 * `GRID_ROWS * GRID_COLS` quads with per-tile vertex colors. Castle walls,
 * interiors, and other entities stay on the 2D renderer until Phase 3.
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
 * `render-map.ts` (GRASS_DARK/LIGHT/BATTLE, WATER_COLOR, ICE_COLOR) and the
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
  TILE_SIZE,
  Tile,
} from "../../shared/core/grid.ts";
import type { ValidPlayerSlot } from "../../shared/core/player-slot.ts";
import type { RenderOverlay } from "../../shared/ui/overlay-types.ts";
import { getPlayerColor } from "../../shared/ui/player-config.ts";
import type { RGB } from "../../shared/ui/theme.ts";

export interface TerrainContext {
  readonly mesh: THREE.Mesh;
  /** Rebuild geometry if `map.mapVersion` has changed since last build.
   *  Cheap no-op when the version matches. */
  ensureBuilt(map: GameMap): void;
  /** Per-frame update: recomputes vertex colors from `map` + `overlay` + `now`.
   *  Must be called after `ensureBuilt`. */
  update(map: GameMap, overlay: RenderOverlay | undefined, now: number): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

// Per-tile base colors — keep in sync with `src/render/render-map.ts`.
const GRASS_DARK: [number, number, number] = [45, 140, 45];
const GRASS_LIGHT: [number, number, number] = [51, 153, 51];
// Battle-phase grass — darkened 85% of GRASS_LIGHT so the map reads as
// a cobbled street during battle. Mirrors GRASS_BATTLE in render-map.ts.
const GRASS_BATTLE: [number, number, number] = [
  Math.floor(51 * 0.85),
  Math.floor(153 * 0.85),
  Math.floor(51 * 0.85),
];
const WATER_COLOR: [number, number, number] = [40, 104, 176];
const ICE_COLOR: [number, number, number] = [165, 210, 230];
// Cobblestone base color for battle-mode interiors. Matches
// COBBLESTONE_BASE + interiorLight * COBBLESTONE_TINT_FACTOR in
// `render-map.ts` → `cobblestoneBaseColor`. The 2D cobblestone sprite
// layers textured stone detail on top of this base; 3D just paints the
// per-tile average since every tile is a single vertex-colored quad.
const COBBLESTONE_BASE: [number, number, number] = [90, 85, 80];
const COBBLESTONE_TINT_FACTOR = 0.15;
// Bonus square base — matches `bonus_square` sprite fill in generate-sprites.html.
const BONUS_COLOR: [number, number, number] = [35, 140, 25];
// Water shimmer parameters — mirror `render-effects.ts` wave math so the 3D
// water feels spatially identical to 2D even though it's per-tile brightness
// rather than per-pixel highlights.
const WAVE_TIME_BASE = 0.8;
const WAVE_ROW_FREQ = 0.5;
const WAVE_COL_FREQ = 0.3;
// Max signed brightness delta applied to water RGB (out of 255).
const WATER_SHIMMER_AMPLITUDE = 18;
// Bonus square pulse — matches drawBonusSquares() alphaScale range (0.70–1.00)
// but we multiply brightness instead of alpha since the mesh is opaque.
const BONUS_FLASH_MS = 300;

export function createTerrain(): TerrainContext {
  const tileCount = GRID_ROWS * GRID_COLS;
  const vertsPerTile = 4;
  const trisPerTile = 2;

  const positions = new Float32Array(tileCount * vertsPerTile * 3);
  const indices = new Uint32Array(tileCount * trisPerTile * 3);
  const colors = new Float32Array(tileCount * vertsPerTile * 3);

  // Build static position + index buffers — these never change at runtime.
  // Tile (r, c) occupies world rect [c*T..(c+1)*T] × Z=[r*T..(r+1)*T] at Y=0.
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const tileIdx = r * GRID_COLS + c;
      const vertBase = tileIdx * vertsPerTile;
      const x0 = c * TILE_SIZE;
      const x1 = x0 + TILE_SIZE;
      const z0 = r * TILE_SIZE;
      const z1 = z0 + TILE_SIZE;
      // Four corners of the tile in world space (Y=0 ground plane).
      // Order: NW, NE, SE, SW (so CCW when viewed from +Y).
      setVertex(positions, vertBase + 0, x0, 0, z0);
      setVertex(positions, vertBase + 1, x1, 0, z0);
      setVertex(positions, vertBase + 2, x1, 0, z1);
      setVertex(positions, vertBase + 3, x0, 0, z1);

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
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // Single upward normal for every vertex — no lighting on tilt here, but the
  // hemisphere light still tints correctly.
  geometry.computeVertexNormals();
  // Position is static; color attribute is rewritten per frame.
  geometry.attributes["position"]!.needsUpdate = false;

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.FrontSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  // Render underneath everything else in the scene (walls, entities on top).
  mesh.renderOrder = 0;

  let builtForVersion: number | undefined;

  function ensureBuilt(map: GameMap): void {
    if (builtForVersion === map.mapVersion) return;
    // Nothing to rebuild in geometry — tile positions are fixed. We only
    // track `mapVersion` so `update` knows when the base tile types might
    // have changed (e.g. sinkhole modifier mutates tiles in place).
    builtForVersion = map.mapVersion;
  }

  function update(
    map: GameMap,
    overlay: RenderOverlay | undefined,
    now: number,
  ): void {
    const frozen = overlay?.entities?.frozenTiles;
    const bonusSquares = overlay?.entities?.bonusSquares;
    const sinkholeTiles = overlay?.entities?.sinkholeTiles;
    const inBattle = !!overlay?.battle?.inBattle;

    // Pre-compute frame-wide modulations (cheap constants per frame).
    const shimmerTime = now / 1000;
    const bonusPulse = Math.sin(now / BONUS_FLASH_MS) * 0.15 + 0.85;

    // Mark bonus tiles for quick lookup. Pit tiles deliberately don't
    // override the underlying terrain color — the pit sprite is drawn
    // with transparent edges so the grass / interior / cobble beneath
    // shows through, matching the 2D renderer's behavior.
    const bonusKeys = buildTileKeySet(bonusSquares);

    // Per-tile owner maps for interiors and sinkhole bank tinting.
    // Mirrors `buildOwnerTables` in render-map.ts: in battle we use
    // `overlay.battle.battleTerritory` (player index → territory set),
    // otherwise the live `castle.interior` sets.
    const interiorOwners = buildInteriorOwners(overlay, inBattle);

    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const tileIdx = r * GRID_COLS + c;
        const key = r * GRID_COLS + c;
        const tile = map.tiles[r]?.[c] ?? Tile.Grass;
        const interiorOwner = interiorOwners.get(key);

        let red: number;
        let green: number;
        let blue: number;

        if (bonusKeys?.has(key)) {
          red = BONUS_COLOR[0] * bonusPulse;
          green = BONUS_COLOR[1] * bonusPulse;
          blue = BONUS_COLOR[2] * bonusPulse;
        } else if (interiorOwner !== undefined && tile !== Tile.Water) {
          // Castle interior — checkered per-player tint out of battle,
          // cobblestone-tinted-gray in battle. Matches drawCastleInterior
          // + ownerGrassBase in render-map.ts.
          const baseColor = interiorTileColor(interiorOwner, r, c, inBattle);
          red = baseColor[0];
          green = baseColor[1];
          blue = baseColor[2];
        } else if (tile === Tile.Water) {
          if (frozen?.has(key)) {
            [red, green, blue] = ICE_COLOR;
          } else {
            // Owned sinkhole tiles — tint with the owning player's
            // interior-grass color so enclosed lakes read as part of the
            // castle interior (2D recolors the bank pixels per-pixel via
            // `drawSinkholeOverlays`; 3D approximates at tile resolution).
            const sinkholeOwner =
              sinkholeTiles?.has(key) && interiorOwner !== undefined
                ? interiorOwner
                : undefined;
            if (sinkholeOwner !== undefined) {
              const tint = interiorTileColor(sinkholeOwner, r, c, inBattle);
              red = tint[0];
              green = tint[1];
              blue = tint[2];
            } else {
              // Per-tile shimmer: the same sinusoidal phase used in 2D
              // wave math, scaled to a modest brightness delta so still
              // frames look right and motion reads as "rippling water".
              const phase =
                shimmerTime * WAVE_TIME_BASE +
                r * WAVE_ROW_FREQ +
                c * WAVE_COL_FREQ;
              const amp = inBattle ? WATER_SHIMMER_AMPLITUDE : 0;
              const delta = Math.sin(phase) * amp;
              red = clamp255(WATER_COLOR[0] + delta);
              green = clamp255(WATER_COLOR[1] + delta);
              blue = clamp255(WATER_COLOR[2] + delta);
            }
          }
        } else {
          // Grass: in battle the palette swaps to the darkened
          // GRASS_BATTLE (cobbled-street look); otherwise the peacetime
          // checkerboard by (r+c) parity.
          const base = inBattle
            ? GRASS_BATTLE
            : (r + c) % 2 === 0
              ? GRASS_DARK
              : GRASS_LIGHT;
          red = base[0];
          green = base[1];
          blue = base[2];
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
): void {
  for (let i = 0; i < 4; i++) {
    const offset = (vertBase + i) * 3;
    target[offset] = red;
    target[offset + 1] = green;
    target[offset + 2] = blue;
  }
}

function clamp255(value: number): number {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}

function sRGBToLinear(value: number): number {
  return value <= 0.04045
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** Pack `{row, col}` entries into a row*GRID_COLS+col Set for O(1) lookup. */
function buildTileKeySet(
  entries: readonly { row: number; col: number }[] | undefined,
): Set<number> | null {
  if (!entries || entries.length === 0) return null;
  const out = new Set<number>();
  for (const entry of entries) out.add(entry.row * GRID_COLS + entry.col);
  return out;
}

/** Build a tile-key → owner map from the overlay's interior sets.
 *  Matches `buildOwnerTables` in render-map.ts — battle mode reads
 *  `overlay.battle.battleTerritory[pid]`, peacetime reads each castle's
 *  `interior`. Used for both the castle interior color and the sinkhole
 *  owner tint. */
function buildInteriorOwners(
  overlay: RenderOverlay | undefined,
  inBattle: boolean,
): Map<number, ValidPlayerSlot> {
  const owners = new Map<number, ValidPlayerSlot>();
  if (inBattle) {
    const territories = overlay?.battle?.battleTerritory;
    if (territories) {
      for (let pid = 0; pid < territories.length; pid++) {
        const territory = territories[pid];
        if (!territory) continue;
        const playerSlot = pid as unknown as ValidPlayerSlot;
        for (const key of territory) owners.set(key, playerSlot);
      }
    }
  } else if (overlay?.castles) {
    for (const castle of overlay.castles) {
      for (const key of castle.interior) owners.set(key, castle.playerId);
    }
  }
  return owners;
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
