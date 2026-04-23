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
import {
  applyBoxWallUV,
  createMaterial,
  type MaterialSpec,
} from "./sprite-kit.ts";
import { MERLON_AO, WALL_STONE_LIGHT } from "./sprite-materials.ts";
import { buildTexturedMaterial, type TexturedSpec } from "./sprite-textures.ts";

export type UVOffset = readonly [number, number];

export interface WallCellParams {
  mask: number;
  uvOffset?: UVOffset;
  /** When true, one merlon is replaced by a broken stump + rubble pile to
   *  signal a reinforced-wall hit. Pick is seeded from `mask` so every
   *  damaged wall of the same neighbour configuration shares geometry —
   *  required because the entity manager instances one geometry per
   *  (mask, damaged) bucket. */
  damaged?: boolean;
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
  texture: "wall_stone",
};
const STONE_LIGHT: TexturedSpec = {
  kind: "standard",
  color: 0xa5a5a0,
  roughness: 0.8,
  metalness: 0.05,
  texture: "wall_stone",
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

  // ─── damaged (reinforced-walls absorbed-hit state) ────────────────────
  // One merlon is replaced by a broken stump + rubble pile. Mask drives
  // which merlon is picked, so each archetype shows a distinct damage
  // spot.
  {
    name: "wall_isolated_damaged",
    label: "isolated · damaged",
    canvasPx: 64,
    params: { mask: 0, damaged: true },
  },
  {
    name: "wall_straight_damaged",
    label: "straight · damaged",
    canvasPx: 64,
    params: { mask: maskFromDirs(["W", "E"]), damaged: true },
  },
  {
    name: "wall_corner_damaged",
    label: "L-corner · damaged",
    canvasPx: 64,
    params: { mask: maskFromDirs(["N", "E"]), damaged: true },
  },
  {
    name: "wall_t_damaged",
    label: "T-junction · damaged",
    canvasPx: 64,
    params: { mask: maskFromDirs(["N", "E", "S"]), damaged: true },
  },
  {
    name: "wall_cross_damaged",
    label: "cross · damaged",
    canvasPx: 64,
    params: { mask: maskFromDirs(["N", "E", "S", "W"]), damaged: true },
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
  const cellGroup = buildCell(
    three,
    params.mask,
    params.uvOffset,
    params.damaged ?? false,
  );
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
  damaged = false,
): THREE.Group {
  const [uOff, vOff] = uvOffset;
  const group = new three.Group();
  const aoMat = buildTexturedMaterial(three, MERLON_AO);
  // Body: vertical sides get the running-bond brick texture (as real
  // fortifications do); the horizontal top cap gets a flagstone map
  // (the "allure" pavement — large square pavers with mortar joints,
  // laid flat as a walkable floor). ExtrudeGeometry groups: 0 = caps,
  // 1 = sides.
  const stoneSideMat = buildTexturedMaterial(three, STONE_MAIN);
  const wallTopMat = buildTexturedMaterial(three, WALL_TOP);
  // Merlons: per-face array so top/bottom stay untextured while the
  // four vertical faces get the textured material.
  const merlonSideMat = buildTexturedMaterial(three, STONE_LIGHT);
  const merlonCapMat = buildTexturedMaterial(three, WALL_STONE_LIGHT);
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

  if (damaged) {
    applyWallDamage(three, group, mask, merlonSideMat);
  }

  return group;
}

/**
 * Apply reinforced-wall absorbed-hit damage. Always targets the same 3
 * classes of damage simultaneously so the effect reads at game-view
 * distance without any painted textures:
 *   - up to 3 merlons destroyed (stump + rubble pile each)
 *   - up to 3 surviving merlons tilted / sunk as blast-shake
 *   - up to 3 dark "scar" blocks pressed against the outer wall face,
 *     one directly below each destroyed merlon
 *
 * Selections are seeded from `mask` so every wall cell sharing the same
 * neighbour configuration gets identical damage geometry — required
 * because the entity manager instances one (mask, damaged) pair of
 * geometry across every damaged wall on the board.
 *
 * At least 1 merlon is always kept intact so the silhouette still reads
 * as "damaged wall" rather than "rubble platform." Small masks with
 * fewer than 4 merlons get proportionally less destruction.
 */
function applyWallDamage(
  three: typeof THREE,
  group: THREE.Group,
  mask: number,
  stoneMat: THREE.Material,
): void {
  const merlons: THREE.Mesh[] = [];
  for (const child of group.children) {
    if (child instanceof three.Mesh && child.userData.merlon === true) {
      merlons.push(child);
    }
  }
  if (merlons.length === 0) return;

  // Seeded shuffle: pair each merlon with a per-mask random key, sort.
  // Deterministic because `damageRand(mask, salt)` is a pure hash. The
  // first entries become destruction targets, the next entries become
  // shake targets — order within each group is stable across builds.
  const shuffled = merlons
    .map((merlon, idx) => ({ merlon, key: damageRand(mask, idx * 7 + 5) }))
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.merlon);

  // Keep ≥ 1 merlon standing so the cell still reads as a wall.
  const destroyCount = Math.min(3, Math.max(0, shuffled.length - 1));
  const destroyed = shuffled.slice(0, destroyCount);
  const surviving = shuffled.slice(destroyCount);

  // Blast-shake: tilt + slightly sink up to 3 surviving merlons. Not
  // distance-gated — we want at least 3 visibly affected regardless of
  // where the destroyed merlons cluster.
  const shakeCount = Math.min(3, surviving.length);
  for (let i = 0; i < shakeCount; i++) {
    const merlon = surviving[i]!;
    merlon.rotation.x = (damageRand(mask, 150 + i) - 0.5) * 0.24;
    merlon.rotation.z = (damageRand(mask, 160 + i) - 0.5) * 0.24;
    merlon.position.y -= 0.02 + damageRand(mask, 170 + i) * 0.04;
  }

  // Scar material: medium-gray matte, no texture. Darker than the wall
  // stone so the scars read as bruises/pockmarks under lit stone, but
  // not near-black (which made them look like holes punched through).
  // Shared across all 9 scars in the cell; tracked for disposal via
  // `buildVariantBucket` → extractSubParts.
  const scarMat = createMaterial({
    kind: "standard",
    color: 0x6a6763,
    roughness: 1.0,
    metalness: 0.0,
  } satisfies MaterialSpec);

  for (let i = 0; i < destroyed.length; i++) {
    const victim = destroyed[i]!;
    const cx = victim.position.x;
    const cz = victim.position.z;
    group.remove(victim);

    addStumpAndRubble(three, group, mask, cx, cz, stoneMat, i);
    addWallScar(three, group, mask, cx, cz, scarMat, i);
  }

  // Extra scars — seeded to positions along open edges that are NOT tied
  // to destroyed merlons, so the outer faces of the wall read as shelled
  // rather than clean-except-at-merlon-stumps. 15 extras + 3 destroyed-
  // merlon scars = 18 total when there's enough open-face perimeter.
  const openDirs: number[] = [];
  for (const dir of CARDINALS) if (!(mask & dir)) openDirs.push(dir);
  if (openDirs.length > 0) {
    const extraCount = 15;
    for (let i = 0; i < extraCount; i++) {
      const dir =
        openDirs[Math.floor(damageRand(mask, 300 + i) * openDirs.length)]!;
      const perp = (damageRand(mask, 310 + i) - 0.5) * 1.4;
      let sx: number;
      let sz: number;
      if (dir === N) {
        sx = perp;
        sz = -0.85;
      } else if (dir === S) {
        sx = perp;
        sz = +0.85;
      } else if (dir === E) {
        sx = +0.85;
        sz = perp;
      } else {
        sx = -0.85;
        sz = perp;
      }
      addWallScar(three, group, mask, sx, sz, scarMat, 3 + i);
    }
  }
}

function addStumpAndRubble(
  three: typeof THREE,
  group: THREE.Group,
  mask: number,
  cx: number,
  cz: number,
  stoneMat: THREE.Material,
  slot: number,
): void {
  // Stump: keep the merlon's footprint, slice to ~¼ height with slight
  // tilt so the break reads as fractured, not a clean cut.
  const stumpH = M_H * (0.22 + damageRand(mask, 3 + slot) * 0.18);
  const stumpGeom = new three.BoxGeometry(M_S, stumpH, M_S);
  applyBoxWallUV(stumpGeom, M_S, stumpH, M_S, UV_DENSITY, 0, 0);
  const stump = new three.Mesh(stumpGeom, stoneMat);
  stump.position.set(cx, H + stumpH / 2, cz);
  stump.rotation.z = (damageRand(mask, 10 + slot) - 0.5) * 0.24;
  stump.rotation.x = (damageRand(mask, 11 + slot) - 0.5) * 0.24;
  group.add(stump);

  // Rubble chunks: 3 small boxes scattered on the walkway around the
  // stump. Sizes + offsets seeded so each destroyed site has its own
  // distinct pile.
  const chunkCount = 3;
  const saltBase = 20 + slot * 10;
  for (let i = 0; i < chunkCount; i++) {
    const angle =
      (i / chunkCount) * Math.PI * 2 + damageRand(mask, saltBase + i) * 1.3;
    const distFromStump = 0.08 + damageRand(mask, saltBase + i + 5) * 0.1;
    const width = 0.07 + damageRand(mask, saltBase + i + 10) * 0.05;
    const depth = 0.06 + damageRand(mask, saltBase + i + 15) * 0.05;
    const height = 0.04 + damageRand(mask, saltBase + i + 20) * 0.06;
    const geom = new three.BoxGeometry(width, height, depth);
    applyBoxWallUV(geom, width, height, depth, UV_DENSITY, 0, 0);
    const chunk = new three.Mesh(geom, stoneMat);
    chunk.position.set(
      cx + Math.cos(angle) * distFromStump,
      H + height / 2,
      cz + Math.sin(angle) * distFromStump,
    );
    chunk.rotation.y = damageRand(mask, saltBase + i + 25) * Math.PI * 2;
    chunk.rotation.x = (damageRand(mask, saltBase + i + 30) - 0.5) * 0.8;
    chunk.rotation.z = (damageRand(mask, saltBase + i + 35) - 0.5) * 0.8;
    group.add(chunk);
  }
}

function addWallScar(
  three: typeof THREE,
  group: THREE.Group,
  mask: number,
  merlonX: number,
  merlonZ: number,
  scarMat: THREE.Material,
  slot: number,
): void {
  // Project the (destroyed) merlon XZ outward to the wall face and push
  // a touch further so the dark scar block sits unambiguously outside
  // the wall sides (and wins any z-fight with the brick texture).
  const { nx, nz } = outwardDirection(merlonX, merlonZ);
  const pushOut = 0.22;
  const scarW = 0.34 + damageRand(mask, 200 + slot) * 0.18;
  const scarH = 0.26 + damageRand(mask, 210 + slot) * 0.18;
  const scarD = 0.08;
  // Middle of the wall height, jittered so scars on neighbouring cells
  // don't line up in a neat row.
  const scarY = H * (0.32 + damageRand(mask, 220 + slot) * 0.4);
  const scarGeom = new three.BoxGeometry(scarW, scarH, scarD);
  const scar = new three.Mesh(scarGeom, scarMat);
  scar.position.set(merlonX + nx * pushOut, scarY, merlonZ + nz * pushOut);
  // Rotate around Y so the box's depth axis aligns with the outward
  // normal — scarD becomes the protrusion, scarW becomes the tangent.
  scar.rotation.y = Math.atan2(-nx, nz);
  scar.rotation.z = (damageRand(mask, 230 + slot) - 0.5) * 0.35;
  scar.rotation.x = (damageRand(mask, 240 + slot) - 0.5) * 0.2;
  group.add(scar);
}

/** Outward-normal direction for a merlon at (x, z) in cell-local coords.
 *  Edge merlons (|dominant axis| ≈ 0.81) project straight out along that
 *  axis; corner merlons (both axes ≈ 0.7) project diagonally. */
function outwardDirection(x: number, z: number): { nx: number; nz: number } {
  const ax = Math.abs(x);
  const az = Math.abs(z);
  if (ax > 0.65 && az > 0.65) {
    const len = Math.hypot(x, z) || 1;
    return { nx: x / len, nz: z / len };
  }
  if (az >= ax) return { nx: 0, nz: Math.sign(z) || 1 };
  return { nx: Math.sign(x) || 1, nz: 0 };
}

/** Deterministic [0, 1) from (mask, salt). Same shape as wall-burns'
 *  pseudoRandom — a sin-based hash that gives stable per-mask variety
 *  without any allocation. */
function damageRand(seed: number, salt: number): number {
  const mixed = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
  return mixed - Math.floor(mixed);
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
    applyBoxWallUV(geom, M_S, M_H, M_S, UV_DENSITY, uOff, vOff);
    const merlon = new three.Mesh(geom, mat);
    merlon.position.set(k.sx * c, yMerlon, k.sz * c);
    merlon.userData.merlon = true;
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
    applyBoxWallUV(geom, M_S, M_H, M_S, UV_DENSITY, uOff, vOff);
    const merlon = new three.Mesh(geom, mat);
    const mx = perpAxis === "x" ? perp : openCoord;
    const mz = perpAxis === "x" ? openCoord : perp;
    merlon.position.set(mx, yMerlon, mz);
    merlon.userData.merlon = true;
    group.add(merlon);
    addMerlonAO(three, group, mx, mz, aoMat);
  }
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
