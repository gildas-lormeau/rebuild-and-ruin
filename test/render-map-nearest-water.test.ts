/**
 * Unit test for the SDF nearest-water-tile extension on render-map.ts.
 *
 * `getNearestWaterTilePerPixel` returns a Uint16Array of packed
 * `(row << 8) | col` coords identifying the nearest water-tile pixel for every
 * pixel in the map bitmap, computed during the existing chamfer-distance pass.
 * The follow-up shader-port PR will sample this so bank pixels in grass-tile
 * neighbors of an owned sinkhole can find the owner via
 * `tileData[nearestWater]` instead of a separate per-pixel overlay plane.
 *
 * Three cases:
 *   1. Fully-grass map — every pixel keeps the `NEAREST_WATER_NONE` sentinel
 *      because nothing seeds the propagation.
 *   2. Single water tile — every pixel resolves to that one tile's coords.
 *   3. Two distant water tiles — discrimination matches geometric nearest.
 */

import { assertEquals } from "@std/assert";
import { createRenderMap, NEAREST_WATER_NONE } from "../src/render/render-map.ts";
import type { GameMap } from "../src/shared/core/geometry-types.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  MAP_PX_H,
  MAP_PX_W,
  Tile,
  TILE_SIZE,
} from "../src/shared/core/grid.ts";
import { createCanvasRecorder } from "./recording-canvas.ts";

Deno.test(
  "getNearestWaterTilePerPixel: fully-grass map yields all sentinels",
  () => {
    const renderMap = makeRenderMap();
    const map = makeAllGrassMap();
    const data = renderMap.getNearestWaterTilePerPixel(map);
    assertEquals(data?.length, MAP_PX_W * MAP_PX_H);
    let firstMismatch = -1;
    for (let i = 0; i < data!.length; i++) {
      if (data![i] !== NEAREST_WATER_NONE) {
        firstMismatch = i;
        break;
      }
    }
    assertEquals(
      firstMismatch,
      -1,
      `expected every pixel to be sentinel (0x${NEAREST_WATER_NONE.toString(16)}) on a water-free map`,
    );
  },
);

Deno.test(
  "getNearestWaterTilePerPixel: single water tile, every pixel resolves to it",
  () => {
    const renderMap = makeRenderMap();
    const map = makeAllGrassMap();
    const waterRow = 5;
    const waterCol = 10;
    map.tiles[waterRow]![waterCol] = Tile.Water;
    const data = renderMap.getNearestWaterTilePerPixel(map)!;
    const expected = pack(waterRow, waterCol);
    let firstMismatch = -1;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== expected) {
        firstMismatch = i;
        break;
      }
    }
    assertEquals(
      firstMismatch,
      -1,
      `expected every pixel to point to the only water tile (${waterRow}, ${waterCol})`,
    );
  },
);

Deno.test(
  "getNearestWaterTilePerPixel: two distant water tiles, closer tile wins",
  () => {
    const renderMap = makeRenderMap();
    const map = makeAllGrassMap();
    const leftRow = 10;
    const leftCol = 5;
    const rightRow = 10;
    const rightCol = 25;
    map.tiles[leftRow]![leftCol] = Tile.Water;
    map.tiles[rightRow]![rightCol] = Tile.Water;
    const data = renderMap.getNearestWaterTilePerPixel(map)!;

    // Pixel inside the left water tile resolves to its own tile.
    const leftCenter = tileCenter(leftRow, leftCol);
    assertEquals(
      data[pixelIndex(leftCenter.px, leftCenter.py)],
      pack(leftRow, leftCol),
    );

    // Pixel inside the right water tile resolves to its own tile.
    const rightCenter = tileCenter(rightRow, rightCol);
    assertEquals(
      data[pixelIndex(rightCenter.px, rightCenter.py)],
      pack(rightRow, rightCol),
    );

    // Pixel at column 10 (5 tiles right of left, 15 tiles left of right) on
    // the same row — clearly closer to the left water tile.
    const leftSidePx = 10 * TILE_SIZE + TILE_SIZE / 2;
    const sameRowPy = leftRow * TILE_SIZE + TILE_SIZE / 2;
    assertEquals(
      data[pixelIndex(leftSidePx, sameRowPy)],
      pack(leftRow, leftCol),
    );

    // Pixel at column 22 (17 tiles right of left, 3 tiles left of right) on
    // the same row — clearly closer to the right water tile.
    const rightSidePx = 22 * TILE_SIZE + TILE_SIZE / 2;
    assertEquals(
      data[pixelIndex(rightSidePx, sameRowPy)],
      pack(rightRow, rightCol),
    );
  },
);

function makeAllGrassMap(): GameMap {
  return {
    tiles: Array.from({ length: GRID_ROWS }, () =>
      new Array(GRID_COLS).fill(Tile.Grass),
    ),
    towers: [],
    houses: [],
    zones: Array.from(
      { length: GRID_ROWS },
      () => new Array(GRID_COLS).fill(0),
    ),
    junction: { x: 0, y: 0 },
    exits: [],
    mapVersion: 0,
  };
}

function makeRenderMap() {
  const recorder = createCanvasRecorder({ discardCalls: true });
  return createRenderMap({ canvasFactory: recorder.factory });
}

function pack(row: number, col: number): number {
  return (row << 8) | col;
}

function pixelIndex(px: number, py: number): number {
  return py * MAP_PX_W + px;
}

function tileCenter(row: number, col: number): { px: number; py: number } {
  return {
    px: col * TILE_SIZE + TILE_SIZE / 2,
    py: row * TILE_SIZE + TILE_SIZE / 2,
  };
}
