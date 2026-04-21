/**
 * wall-scene.ts — fortification walls with corner-aware autotile.
 *
 * Each wall cell occupies its FULL 1×1 tile (a "fat wall" is just two
 * adjacent wall cells, not a thin-wall mesh). The cell's 4 outer
 * corners are independently rounded based on the 4-cardinal mask:
 *
 *   corner state    | adjacent cardinals  | visual
 *   ----------------|---------------------|----------------------------
 *   rounded outer   | both empty          | quarter-circle round
 *   square          | one or both walls   | sharp 90°, flush to edge
 *
 * This single rule handles both regimes:
 *   • fat walls — adjacent cells have square inner corners that meet
 *     edge-to-edge, so a 2×2 block reads as a single rounded mass.
 *   • diagonal gaps — two cells touching only diagonally each have
 *     rounded outer corners on the touching side, so a visible gap
 *     remains (matches the "diagonals don't enclose" game rule).
 *
 * Battlements (merlons) line every open edge — i.e. each cardinal
 * direction with no neighbor.
 *
 * The 4-cardinal mask gives 16 configurations → 6 unique meshes after
 * rotational symmetry (endpoint, stub, straight, L, T, cross). The
 * blob-tileset 47-tile system isn't needed here because the diagonal
 * cell either renders or it doesn't — the gap visual emerges naturally
 * from rounding rather than from per-cell diagonal logic.
 */

import type * as THREE from "three";
import { createTiledCanvasTexture } from "./procedural-texture.ts";
import { createMaterial, type MaterialSpec } from "./sprite-kit.ts";
import { MERLON_AO, WALL_STONE_LIGHT } from "./sprite-materials.ts";

export type UVOffset = readonly [number, number];

export interface WallCellParams {
  mask: number;
  uvOffset?: UVOffset;
}

export interface WallMazeParams {
  grid: string[] | number[][];
}

export type WallParams = WallCellParams | WallMazeParams;

export interface VariantDescriptor {
  name: string;
  label: string;
  canvasPx: number;
  params: WallParams;
}

export type VariantReport =
  | {
      name: string;
      kind: "maze";
      gridSize: string;
      cells: number;
      apex: number;
      warnings: string[];
    }
  | {
      name: string;
      kind: "cell";
      mask: number;
      cardinalsConnected: number;
      openEdges: number;
      roundedCorners: number;
      apex: number;
      warnings: string[];
    };

// Textured stone. The material color acts as a multiplier on the
// canvas texture — this combination was tuned against two palettes:
//   • wall-scene's 5-colour quantize  (0x2a..0xa5)
//   • assembly's broader 8-grey ramp  (0x1a..0xa5 + near-whites 0xc8/0xe0/0xff)
// With color ≈ 0x8a and texture base 130, the lit pixel lands around
// 100-130 → snaps to 0x6a/0x8a in BOTH palettes. A pure-white material
// would skew the assembly render toward the near-white buckets (the
// "walls look white" bug). A fully dark material would collapse the
// texture variation below the wall-scene palette's step size.
interface TexturedSpec extends MaterialSpec {
  texture?: "stone" | "wall_top";
}

type Dir = "N" | "E" | "S" | "W";

interface UVGenerator {
  generateTopUV(
    geometry: THREE.ExtrudeGeometry,
    vertices: number[],
    iA: number,
    iB: number,
    iC: number,
  ): THREE.Vector2[];
  generateSideWallUV(
    geometry: THREE.ExtrudeGeometry,
    vertices: number[],
    iA: number,
    iB: number,
    iC: number,
    iD: number,
  ): THREE.Vector2[];
}

const STONE_MAIN: TexturedSpec = {
  kind: "standard",
  color: 0xdcdcd8,
  roughness: 0.85,
  metalness: 0.05,
  texture: "stone",
};
const STONE_LIGHT: TexturedSpec = {
  kind: "standard",
  color: 0xa5a5a0,
  roughness: 0.8,
  metalness: 0.05,
  texture: "stone",
};
// Flagstone material for the wall's TOP cap — the walkable allure, which
// on a real fortification is paved with large flat stones laid as a
// floor, not the running-bond brick pattern that shows on the side.
const WALL_TOP: TexturedSpec = {
  kind: "standard",
  color: 0xdcdcd8,
  roughness: 0.9,
  metalness: 0.05,
  texture: "wall_top",
};
const TILE_R = 1.0;
// tile half-extent (each tile is 2×2 in world units)
const CORNER_R = 0.3;
// outer corner radius
const H = 3.22;
// wall body height — 20% lower than the tall
// 4.10 setting. Apex (H + M_H)/2 = 1.76 world,
// still clears all cannon apexes except super_gun.
const M_H = 0.3;
// merlon height (battlement) — original value
const M_S = 0.25;
// merlon footprint (4 px at 2× / 2 px at 1×)
const M_INSET_FACE = 0.0625;
// Fixed world-lattice of merlon positions along each tile's perpendicular
// axis. 4 merlons per tile at ±0.25, ±0.75 → spacing 0.5 (8 px at 2×,
// 4 px at 1×). Because these are absolute tile-local positions (not
// span-dependent), adjacent cells always place merlons at the same
// cross-tile offsets → merlons line up cleanly across a fat wall.
const MERLON_LATTICE = [-0.75, -0.25, +0.25, +0.75];
const N = 1 << 0;
const E = 1 << 1;
const S = 1 << 2;
const W = 1 << 3;
const CARDINALS = [N, E, S, W];
// UV_DENSITY = texture wraps per world unit. Set lower than the tower's
// 2.0 because wall tiles are tiny in sprite space (≤ 32 px/tile on the
// assembly page). With one tile = 2 world wide and 4 bricks per wrap,
// UV_DENSITY=0.5 yields 1 wrap/tile = 4 bricks across a tile → ~8
// sprite pixels per brick. Anything denser gets averaged into flat
// colour after the mipmap/downsample/5-grey quantize chain.
const UV_DENSITY = 0.5;
export const VARIANTS: VariantDescriptor[] = [
  // ─── single-tile inspection (the 6 archetype meshes after rotation) ───
  {
    name: "wall_isolated",
    label: "isolated (0 nbrs)",
    canvasPx: 64,
    params: { mask: 0 },
  },
  {
    name: "wall_stub_n",
    label: "stub (N nbr)",
    canvasPx: 64,
    params: { mask: maskFromDirs(["N"]) },
  },
  {
    name: "wall_straight",
    label: "straight (W+E)",
    canvasPx: 64,
    params: { mask: maskFromDirs(["W", "E"]) },
  },
  {
    name: "wall_corner",
    label: "L-corner (N+E)",
    canvasPx: 64,
    params: { mask: maskFromDirs(["N", "E"]) },
  },
  {
    name: "wall_t",
    label: "T-junction (N+E+S)",
    canvasPx: 64,
    params: { mask: maskFromDirs(["N", "E", "S"]) },
  },
  {
    name: "wall_cross",
    label: "cross (N+E+S+W)",
    canvasPx: 64,
    params: { mask: maskFromDirs(["N", "E", "S", "W"]) },
  },

  // ─── maze tests (validate tiling + corners on real configurations) ───
  // 6×6 grid → canvasPx 192 keeps each tile at the standard game-2× size
  // of 32 px (1/3 unit per tile in the ±1 frustum).
  {
    name: "maze_diagonal",
    label: "maze: diagonal pair (gap rule)",
    canvasPx: 192,
    params: {
      grid: ["......", "..#...", "...#..", "..#...", "...#..", "......"],
    },
  },
  {
    name: "maze_fat_2x2",
    label: "maze: 2×2 fat block",
    canvasPx: 192,
    params: {
      grid: ["......", "......", "..##..", "..##..", "......", "......"],
    },
  },
  {
    name: "maze_fat_l",
    label: "maze: fat L (3-cell, missing corner)",
    canvasPx: 192,
    params: {
      grid: ["......", ".##...", ".#....", "......", "......", "......"],
    },
  },
  {
    name: "maze_castle",
    label: "maze: thin castle perimeter",
    canvasPx: 192,
    params: {
      grid: ["......", ".####.", ".#..#.", ".#..#.", ".####.", "......"],
    },
  },
  {
    name: "maze_mixed",
    label: "maze: mixed thin + fat",
    canvasPx: 192,
    params: {
      grid: ["..####", "..#...", "..####", "..##.#", "...#.#", "...###"],
    },
  },
];
export const PALETTE: [number, number, number][] = [
  [0x4a, 0x4a, 0x45],
  [0x6a, 0x6a, 0x65],
  [0x8a, 0x8a, 0x85],
  [0xa5, 0xa5, 0xa0],
  [0x2a, 0x2a, 0x28],
];

// Procedural stone texture (mirror of tower-scene's `getStoneTexture`).
let _stoneTexture: THREE.CanvasTexture | undefined;
// Procedural flagstone texture for the wall-walk. 4×4 grid of
// roughly-square pavers with thick mortar joints — how the top of a
// real fortification wall is actually paved. Per-stone value swing is
// large so neighbouring stones land on distinct palette buckets after
// quantize (they shouldn't all snap to the same grey).
let _wallTopTexture: THREE.CanvasTexture | undefined;

export function variantReport(variant: VariantDescriptor): VariantReport {
  const p = variant.params;
  const warnings: string[] = [];
  if ("grid" in p) {
    const grid = parseGrid(p.grid);
    let cells = 0;
    for (const row of grid) for (const c of row) if (c) cells++;
    return {
      name: variant.name,
      kind: "maze",
      gridSize: `${grid[0]?.length ?? 0}×${grid.length}`,
      cells,
      apex: H + M_H,
      warnings,
    };
  }
  const m = p.mask;
  const cardinals = CARDINALS.filter((d) => m & d).length;
  const opens = 4 - cardinals;
  const roundedCorners = countRoundedCorners(m);
  return {
    name: variant.name,
    kind: "cell",
    mask: m,
    cardinalsConnected: cardinals,
    openEdges: opens,
    roundedCorners,
    apex: H + M_H,
    warnings,
  };
}

/**
 * Top-level build dispatch. Looks at the variant params: `grid` →
 * maze; otherwise `mask` → single cell.
 */
export function buildWall(
  three: typeof THREE,
  scene: THREE.Scene | THREE.Group,
  params: WallParams,
): void {
  if ("grid" in params) {
    buildMaze(three, scene, parseGrid(params.grid));
    return;
  }
  const cellGroup = buildCell(three, params.mask, params.uvOffset);
  scene.add(cellGroup);
}

function maskFromDirs(dirs: Dir[]): number {
  const lookup: Record<Dir, number> = { N, E, S, W };
  return dirs.reduce((m, d) => m | lookup[d], 0);
}

function countRoundedCorners(mask: number): number {
  let n = 0;
  // NE corner: rounded if N AND E are empty
  if (!(mask & N) && !(mask & E)) n++;
  if (!(mask & N) && !(mask & W)) n++;
  if (!(mask & S) && !(mask & E)) n++;
  if (!(mask & S) && !(mask & W)) n++;
  return n;
}

function buildMaze(
  three: typeof THREE,
  scene: THREE.Scene | THREE.Group,
  grid: number[][],
): void {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  // Fit grid into the ±1 frustum (2-unit span). Each tile is
  // (2 / cols) wide along X and (2 / rows) along Z.
  const cellSize = Math.min(2 / cols, 2 / rows);
  // The cell builder assumes TILE_R=1 (tile is 2 units wide). Scale
  // each cell group down so its tile occupies cellSize.
  const scale = cellSize / 2;

  // Center the maze inside the frustum (handles non-square grids too).
  const totalW = cellSize * cols;
  const totalH = cellSize * rows;
  const offsetX = -totalW / 2;
  const offsetZ = -totalH / 2;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!grid[row]![col]) continue;
      const mask = maskFromGrid(grid, col, row);
      // Offset this cell's UV space by (col, row) × one tile of UV wrap
      // (2 * UV_DENSITY per axis, since a shape spans ±1 in local coords
      // and UV = shape × UV_DENSITY). Adjacent cells then sit in
      // adjacent UV wraps → the brick pattern is continuous across the
      // whole maze, hiding the tile-boundary look.
      const uvStep = 2 * UV_DENSITY;
      const uvOffset: UVOffset = [col * uvStep, row * uvStep];
      const cell = buildCell(three, mask, uvOffset);
      cell.position.set(
        offsetX + (col + 0.5) * cellSize,
        0,
        offsetZ + (row + 0.5) * cellSize,
      );
      cell.scale.setScalar(scale);
      scene.add(cell);
    }
  }
}

/**
 * Build the 4-cardinal mask for cell (col,row) in a 2D grid (0/1 cells).
 * Out-of-bounds and 0 cells are treated as empty.
 */
export function maskFromGrid(
  grid: number[][],
  col: number,
  row: number,
): number {
  let m = 0;
  if (grid[row - 1]?.[col]) m |= N;
  if (grid[row + 1]?.[col]) m |= S;
  if (grid[row]?.[col + 1]) m |= E;
  if (grid[row]?.[col - 1]) m |= W;
  return m;
}

function buildCell(
  three: typeof THREE,
  mask: number,
  uvOffset: UVOffset = [0, 0],
): THREE.Group {
  const [uOff, vOff] = uvOffset;
  const group = new three.Group();
  const aoMat = makeMaterial(three, MERLON_AO);
  // Body: vertical sides get the running-bond brick texture (as real
  // fortifications do); the horizontal top cap gets a flagstone map
  // (the "allure" pavement — large square pavers with mortar joints,
  // laid flat as a walkable floor). ExtrudeGeometry groups: 0 = caps,
  // 1 = sides.
  const stoneSideMat = makeMaterial(three, STONE_MAIN);
  const wallTopMat = makeMaterial(three, WALL_TOP);
  // Merlons: per-face array so top/bottom stay untextured while the
  // four vertical faces get the textured material.
  const merlonSideMat = makeMaterial(three, STONE_LIGHT);
  const merlonCapMat = makeMaterial(three, WALL_STONE_LIGHT);
  const merlonMatArray = [
    merlonSideMat,
    merlonSideMat,
    merlonCapMat,
    merlonCapMat,
    merlonSideMat,
    merlonSideMat,
  ];

  // Base body via ExtrudeGeometry of a corner-aware Shape.
  const shape = makeCellShape(three, mask);
  const geom = new three.ExtrudeGeometry(shape, {
    depth: H,
    bevelEnabled: false,
    UVGenerator: stoneWallUVGenerator(three, uOff, vOff),
  } as THREE.ExtrudeGeometryOptions);
  // Shape lives in XY; extrusion goes along +Z. Rotate so XY → XZ
  // (the Shape's Y becomes world Z) and Z extrusion becomes +Y.
  geom.rotateX(-Math.PI / 2);
  // After rotateX(-π/2): shape's +Y → world -Z (we want shape's +Y → world +Z),
  // and extrusion direction +Z → world +Y (correct, walls grow upward).
  // Mirror Z so shape's +Y maps to world +Z (so 'south' is +Z as elsewhere).
  // Actually rotateX(-π/2) takes (x, y, z) → (x, z, -y) which means
  // shape +Y → world -Z. We want shape +Y → world +Z, so rotate the
  // OTHER way (+π/2) — but then extrusion goes to -Y. Compromise:
  // use rotateX(-π/2) and flip the Shape's Y axis at construction.
  // Simpler: keep rotateX(-π/2) and accept shape +Y → world -Z; this
  // means we authored the Shape with (x, -z) coords.
  const body = new three.Mesh(geom, [wallTopMat, stoneSideMat]);
  group.add(body);

  // Battlements on each open edge.
  for (const dir of CARDINALS) {
    if (mask & dir) continue;
    placeMerlons(three, group, dir, mask, merlonMatArray, uOff, vOff, aoMat);
  }

  // Corner merlons — one at each rounded outer corner, sitting at the
  // arc center so the merlon sits inside the wall's rounded footprint.
  // Fills the ±0.75 lattice slots that get clipped by the rounding.
  placeCornerMerlons(three, group, mask, merlonMatArray, uOff, vOff, aoMat);

  return group;
}

// Texture-aware wrapper: delegates to sprite-kit's createMaterial for
// the base material, then attaches a procedural map based on
// `spec.texture`. The procedural generators live below and are scene-
// specific, so they stay here rather than in sprite-kit.
function makeMaterial(
  three: typeof THREE,
  spec: TexturedSpec,
): THREE.MeshBasicMaterial | THREE.MeshStandardMaterial {
  const mat = createMaterial(spec);
  if (spec.texture === "stone") {
    const tex = getStoneTexture(three);
    if (tex) mat.map = tex;
  } else if (spec.texture === "wall_top") {
    const tex = getWallTopTexture(three);
    if (tex) mat.map = tex;
  }
  return mat;
}

// uOff/vOff are added to the final UVs so each cell can be positioned
// in a shared texture space — used by the maze builder to make the
// brick pattern flow continuously across adjacent wall cells instead
// of repeating identically in every tile.
function stoneWallUVGenerator(
  three: typeof THREE,
  uOff = 0,
  vOff = 0,
): UVGenerator {
  const uv = (px: number, py: number): THREE.Vector2 =>
    new three.Vector2(px * UV_DENSITY + uOff, py * UV_DENSITY + vOff);
  return {
    generateTopUV(_geometry, vertices, iA, iB, iC) {
      return [
        uv(vertices[iA * 3]!, vertices[iA * 3 + 1]!),
        uv(vertices[iB * 3]!, vertices[iB * 3 + 1]!),
        uv(vertices[iC * 3]!, vertices[iC * 3 + 1]!),
      ];
    },
    generateSideWallUV(_geometry, vertices, iA, iB, iC, iD) {
      const pos = (i: number): [number, number, number] => [
        vertices[i * 3]!,
        vertices[i * 3 + 1]!,
        vertices[i * 3 + 2]!,
      ];
      const [ax, ay, az] = pos(iA);
      const [bx, by, bz] = pos(iB);
      const [cx, cy, cz] = pos(iC);
      const [dx, dy, dz] = pos(iD);
      const useX = Math.abs(ay - by) < Math.abs(ax - bx);
      const u = (px: number, py: number): number =>
        (useX ? px : py) * UV_DENSITY + uOff;
      // `pz` is the extrusion direction (pre-rotate). Walls don't use
      // a group-level Y scale, so no pre-compensation needed.
      const v = (pz: number): number => pz * UV_DENSITY + vOff;
      return [
        new three.Vector2(u(ax, ay), v(az)),
        new three.Vector2(u(bx, by), v(bz)),
        new three.Vector2(u(cx, cy), v(cz)),
        new three.Vector2(u(dx, dy), v(dz)),
      ];
    },
  };
}

function getStoneTexture(three: typeof THREE): THREE.CanvasTexture | undefined {
  if (_stoneTexture) return _stoneTexture;
  const tex = createTiledCanvasTexture(three, 64, ({ ctx, size, rand }) => {
    const brickW = 16;
    const brickH = 8;
    for (let row = 0; row * brickH < size; row++) {
      const offset = (row % 2) * (brickW / 2);
      for (let col = -1; col * brickW + offset < size; col++) {
        const x = col * brickW + offset;
        const y = row * brickH;
        // Mid-dark stone tone with LARGE per-brick swing (±50) so after
        // the material 0x8a multiply (×0.54) and lighting, neighbouring
        // bricks land on different palette buckets (0x4a..0x8a in both
        // wall-scene and assembly palettes). Small variation gets lost
        // when each brick covers only a handful of sprite pixels.
        const base = 130 + Math.floor((rand() - 0.5) * 60);
        ctx.fillStyle = `rgb(${base},${base},${base})`;
        ctx.fillRect(x, y, brickW, brickH);
        const count = 6 + Math.floor(rand() * 5);
        for (let i = 0; i < count; i++) {
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
    ctx.fillStyle = "rgb(60,57,52)";
    for (let y = 0; y < size; y += brickH) ctx.fillRect(0, y, size, 1);
    for (let row = 0; row * brickH < size; row++) {
      const y = row * brickH;
      const offset = (row % 2) * (brickW / 2);
      for (let x = offset; x < size; x += brickW) ctx.fillRect(x, y, 1, brickH);
    }
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
  if (tex) _stoneTexture = tex;
  return tex;
}

function getWallTopTexture(
  three: typeof THREE,
): THREE.CanvasTexture | undefined {
  if (_wallTopTexture) return _wallTopTexture;
  const tex = createTiledCanvasTexture(three, 64, ({ ctx, size, rand }) => {
    const cells = 4;
    const cellSize = size / cells;
    for (let r = 0; r < cells; r++) {
      for (let col = 0; col < cells; col++) {
        // Base tone ~30 below the brick sides (which sit at 130) so the
        // allure reads as noticeably darker stone — closer to the 0x4a
        // palette bucket than the sides' 0x6a/0x8a.
        const base = 85 + Math.floor((rand() - 0.5) * 60);
        ctx.fillStyle = `rgb(${base},${base},${base - 3})`;
        ctx.fillRect(col * cellSize, r * cellSize, cellSize, cellSize);
        // Per-paver stipple — a few small pits/chips.
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
    // Mortar joints — 2 px wide, darker than the stone courses.
    ctx.fillStyle = "rgb(60,57,52)";
    for (let x = 0; x < size; x += cellSize) ctx.fillRect(x, 0, 2, size);
    for (let y = 0; y < size; y += cellSize) ctx.fillRect(0, y, 2, size);
  });
  if (tex) _wallTopTexture = tex;
  return tex;
}

/**
 * Place one merlon at each rounded outer corner. A corner is rounded
 * iff both of its adjacent cardinals are empty — check that via the
 * per-corner bit pair.
 */
function placeCornerMerlons(
  three: typeof THREE,
  group: THREE.Group,
  mask: number,
  mat: THREE.Material[],
  uOff: number,
  vOff: number,
  aoMat: THREE.Material,
): void {
  const yMerlon = H + M_H / 2;
  const c = TILE_R - CORNER_R; // arc-center coord, magnitude
  const corners = [
    { adj: N | W, sx: -1, sz: -1 },
    { adj: N | E, sx: +1, sz: -1 },
    { adj: S | W, sx: -1, sz: +1 },
    { adj: S | E, sx: +1, sz: +1 },
  ];
  for (const k of corners) {
    if ((mask & k.adj) !== 0) continue; // at least one adjacent cardinal is wall → square
    const geom = new three.BoxGeometry(M_S, M_H, M_S);
    applyBoxWallUV(geom, M_S, M_H, M_S, uOff, vOff);
    const merlon = new three.Mesh(geom, mat);
    merlon.position.set(k.sx * c, yMerlon, k.sz * c);
    group.add(merlon);
    addMerlonAO(three, group, k.sx * c, k.sz * c, aoMat);
  }
}

/**
 * Build the cell's 2D footprint Shape. Coords convention: shape +X = world
 * +X (east), shape +Y = world -Z (north). So NW = (-1,+1), NE = (+1,+1),
 * SE = (+1,-1), SW = (-1,-1) in shape coords.
 *
 * Trace counter-clockwise (so ExtrudeGeometry's faces point outward
 * after the rotateX(-π/2) flip): NW → SW → SE → NE → back to NW.
 */
function makeCellShape(three: typeof THREE, mask: number): THREE.Shape {
  const isWall = (b: number): boolean => (mask & b) !== 0;
  const r = TILE_R;
  const R = CORNER_R;

  // Per corner: rounded only when BOTH adjacent cardinals are empty.
  const roundNW = !isWall(N) && !isWall(W);
  const roundSW = !isWall(S) && !isWall(W);
  const roundSE = !isWall(S) && !isWall(E);
  const roundNE = !isWall(N) && !isWall(E);

  const shape = new three.Shape();
  // Corners (in shape coords, where +Y = north):
  //   NW = (-r, +r)   NE = (+r, +r)
  //   SW = (-r, -r)   SE = (+r, -r)
  // Trace counter-clockwise: start at NW, go down to SW, right to SE,
  // up to NE, left back to NW.

  // Start on the W edge below the NW corner.
  if (roundNW) shape.moveTo(-r, +r - R);
  else shape.moveTo(-r, +r);

  // W edge → SW corner
  if (roundSW) {
    shape.lineTo(-r, -r + R);
    shape.absarc(-r + R, -r + R, R, Math.PI, 1.5 * Math.PI, false);
  } else {
    shape.lineTo(-r, -r);
  }

  // S edge → SE corner
  if (roundSE) {
    shape.lineTo(+r - R, -r);
    shape.absarc(+r - R, -r + R, R, 1.5 * Math.PI, 2 * Math.PI, false);
  } else {
    shape.lineTo(+r, -r);
  }

  // E edge → NE corner
  if (roundNE) {
    shape.lineTo(+r, +r - R);
    shape.absarc(+r - R, +r - R, R, 0, 0.5 * Math.PI, false);
  } else {
    shape.lineTo(+r, +r);
  }

  // N edge → NW corner
  if (roundNW) {
    shape.lineTo(-r + R, +r);
    shape.absarc(-r + R, +r - R, R, 0.5 * Math.PI, Math.PI, false);
  } else {
    shape.lineTo(-r, +r);
  }

  return shape;
}

/**
 * Place merlons along the cell's open edge in direction `openDir`.
 * The edge's perpendicular span shrinks by CORNER_R at each end where
 * the adjacent corner is rounded.
 */
function placeMerlons(
  three: typeof THREE,
  group: THREE.Group,
  openDir: number,
  mask: number,
  mat: THREE.Material[],
  uOff: number,
  vOff: number,
  aoMat: THREE.Material,
): void {
  const isWall = (b: number): boolean => (mask & b) !== 0;

  // Determine perpendicular axis + span endpoints + the open coord.
  let perpAxis: "x" | "z";
  let perpStart: number;
  let perpEnd: number;
  let openCoord: number;
  if (openDir === N || openDir === S) {
    perpAxis = "x";
    // Perp axis = X. NW corner rounded iff !N && !W; here !N is true
    // (we only call this when openDir's neighbor is empty — but for
    // openDir = S, N might still be a wall, etc.). Actually we need to
    // know whether the corner at each end is rounded — that's a
    // function of the OTHER cardinals at that corner.
    // openDir = N: NW corner rounded iff !N && !W → since N empty, just !W
    //              NE corner rounded iff !N && !E → just !E
    // openDir = S: SW corner rounded iff !S && !W → just !W
    //              SE corner rounded iff !S && !E → just !E
    perpStart = isWall(W) ? -TILE_R : -TILE_R + CORNER_R;
    perpEnd = isWall(E) ? +TILE_R : +TILE_R - CORNER_R;
    openCoord =
      openDir === N
        ? -TILE_R + M_S / 2 + M_INSET_FACE // (note: world +Z is south)
        : +TILE_R - M_S / 2 - M_INSET_FACE;
  } else {
    perpAxis = "z";
    // openDir = E: NE rounded iff !N → !N; SE rounded iff !S → !S
    // openDir = W: NW rounded iff !N → !N; SW rounded iff !S → !S
    perpStart = isWall(N) ? -TILE_R : -TILE_R + CORNER_R;
    perpEnd = isWall(S) ? +TILE_R : +TILE_R - CORNER_R;
    openCoord =
      openDir === E
        ? +TILE_R - M_S / 2 - M_INSET_FACE
        : -TILE_R + M_S / 2 + M_INSET_FACE;
  }

  // Pick lattice positions that fit fully within the edge span (small
  // epsilon so a merlon sitting flush against a rounded-corner tangent
  // still counts as "inside" despite floating-point slop).
  const yMerlon = H + M_H / 2;
  const eps = 1e-4;
  for (const perp of MERLON_LATTICE) {
    if (perp - M_S / 2 < perpStart - eps) continue;
    if (perp + M_S / 2 > perpEnd + eps) continue;
    const geom = new three.BoxGeometry(M_S, M_H, M_S);
    applyBoxWallUV(geom, M_S, M_H, M_S, uOff, vOff);
    const merlon = new three.Mesh(geom, mat);
    const mx = perpAxis === "x" ? perp : openCoord;
    const mz = perpAxis === "x" ? openCoord : perp;
    merlon.position.set(mx, yMerlon, mz);
    group.add(merlon);
    addMerlonAO(three, group, mx, mz, aoMat);
  }
}

function applyBoxWallUV(
  geom: THREE.BoxGeometry,
  w: number,
  h: number,
  d: number,
  uOff = 0,
  vOff = 0,
): void {
  const uv = geom.attributes["uv"] as THREE.BufferAttribute;
  const a = uv.array as Float32Array;
  const scales: [number, number][] = [
    [d, h], // +X
    [d, h], // -X
    [w, d], // +Y (plain mat — UVs don't render)
    [w, d], // -Y
    [w, h], // +Z
    [w, h], // -Z
  ];
  for (let face = 0; face < 6; face++) {
    const [su, sv] = scales[face]!;
    for (let v = 0; v < 4; v++) {
      const i = (face * 4 + v) * 2;
      a[i] = a[i]! * su * UV_DENSITY + uOff;
      a[i + 1] = a[i + 1]! * sv * UV_DENSITY + vOff;
    }
  }
  uv.needsUpdate = true;
}

/**
 * Thin dark plane laid on the wall-walk directly under a merlon,
 * slightly larger than the merlon's footprint so a halo of shadow
 * pokes out around each side. Sits 0.001 above the wall's top face
 * to win z-fighting with the flagstone surface.
 */
function addMerlonAO(
  three: typeof THREE,
  group: THREE.Group,
  x: number,
  z: number,
  aoMat: THREE.Material,
): void {
  const halo = M_S * 0.5; // pad by half a merlon footprint on each side
  const geom = new three.PlaneGeometry(M_S + halo, M_S + halo);
  geom.rotateX(-Math.PI / 2);
  const plane = new three.Mesh(geom, aoMat);
  plane.position.set(x, H + 0.001, z);
  group.add(plane);
}

function parseGrid(input: string[] | number[][]): number[][] {
  // Accept either an array of strings ("##." → [1,1,0]) or already-parsed
  // 2D array of 0/1.
  if (Array.isArray(input) && typeof input[0] === "string") {
    return (input as string[]).map((row) =>
      Array.from(row, (ch) => (ch === "#" ? 1 : 0)),
    );
  }
  return input as number[][];
}
