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
import { ELEVATION_STACK } from "./elevation.ts";
import type { FrameCtx } from "./frame-ctx.ts";

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

// Per-tile base colors — raw grass/water/bank now come from the 2D
// `getTerrainBitmap` texture uploaded in `effects/terrain-bitmap.ts`;
// the mesh only owns overlay tile colors (interiors, bonus, frozen,
// owned sinkhole tints) which must stay in sync with `render-map.ts`.
const ICE_COLOR: [number, number, number] = [165, 210, 230];
// Cobblestone base color for battle-mode interiors. Intentionally
// lighter than the 2D sprite's `COBBLESTONE_BASE = [90, 85, 80]` in
// `render-map.ts` → `cobblestoneBaseColor`: at 3D's tile resolution the
// uniform dark base swallowed tower silhouettes, so we fade it toward a
// light stone gray to boost contrast with castle geometry. The 2D sprite
// still layers textured stone detail on top of its own darker base.
const COBBLESTONE_BASE: [number, number, number] = [125, 120, 115];
const COBBLESTONE_TINT_FACTOR = 0.13;

export function createTerrain(): TerrainContext {
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
    const frozen = overlay?.entities?.frozenTiles;
    const sinkholeTiles = overlay?.entities?.sinkholeTiles;
    const inBattle = !!overlay?.battle?.inBattle;

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
        } else if (tile === Tile.Water) {
          if (frozen?.has(key)) {
            [red, green, blue] = ICE_COLOR;
            alpha = 1;
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
              alpha = 1;
            } else {
              // Raw water — let the terrain bitmap paint this tile
              // (including the SDF bank band at any grass/water edge).
              red = 0;
              green = 0;
              blue = 0;
              alpha = 0;
            }
          }
        } else {
          // Raw grass — let the terrain bitmap paint this tile
          // (including the checkerboard noise baked in 2D).
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

function sRGBToLinear(value: number): number {
  return value <= 0.04045
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4);
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
