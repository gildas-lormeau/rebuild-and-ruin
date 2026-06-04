/**
 * AI build — minimal enclosure cut: the fewest new wall tiles that stop
 * `computeOutside` reaching a desired interior, as a vertex-capacitated s-t min
 * cut on the SAME 8-adjacency flood graph (blocks diagonal leaks, no plug step).
 * Protected region (source, uncuttable) = footprint + rect grass interior. Water/
 * pits/houses/cannons/towers are uncuttable channels, except a pit is cuttable with
 * `allowPit` (Foundations: the owner walls through it); null = unenclosable.
 */

import { TOWER_SIZE } from "../shared/core/game-constants.ts";
import type {
  TileBounds,
  TileRect,
  Tower,
} from "../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, type TileKey } from "../shared/core/grid.ts";
import {
  DIRS_8,
  inBounds,
  packTile,
  zoneTileBounds,
} from "../shared/core/spatial.ts";
import type { GameViewState } from "../shared/core/system-interfaces.ts";
import { isRingWallable, isWallableGrass } from "./ai-castle-rect.ts";

/** One region the cut must enclose: a tower and its castle rect (cannon
 *  space). Pass several to enclose multiple towers in one shared ring. */
export interface EnclosureSeed {
  tower: Tower;
  interior: TileRect;
}

/** Capacity standing in for "uncuttable" — a channel the flood traverses but
 *  no wall can seal. Large enough to never be a min-cut bottleneck, small
 *  enough to stay well inside Int32 when summed across a handful of paths. */
const UNCUTTABLE = 1 << 24;

/**
 * The minimum set of new wall tiles that encloses every seed region (each
 * tower footprint plus its rect's grass interior — cannon space) given
 * `walls`. One seed = a solo castle ring; two = a merged enclosure whose
 * marginal wall cost the cut reports exactly. Empty set = already enclosed.
 * null = unenclosable (no finite cut exists).
 *
 * The flow graph spans only the tower zone's bounding box (`computeEnclosureBox`)
 * rather than the whole grid: zones are river-isolated, so a cut never crosses
 * into another zone, and any flood that leaves the box has reached "outside"
 * — modelled by draining box-edge tiles straight to the sink. This is exactly
 * equivalent to the whole-grid graph (verified byte-identical over thousands of
 * real placements + the determinism fixtures) while building ~70% fewer edges.
 */
export function findEnclosureCut(
  seeds: readonly EnclosureSeed[],
  state: GameViewState,
  walls: ReadonlySet<TileKey>,
  allowPit: boolean,
): Set<TileKey> | null {
  const tileCount = GRID_ROWS * GRID_COLS;
  // Node ids: IN(t) = t, OUT(t) = t + tileCount, SOURCE, SINK.
  const source = tileCount * 2;
  const sink = tileCount * 2 + 1;
  const box = computeEnclosureBox(seeds, state);
  const graph = new FlowGraph(tileCount * 2 + 2);

  const protectedTiles = collectProtectedTiles(seeds, state, walls);
  buildFlowGraph(
    graph,
    tileCount,
    source,
    sink,
    box,
    protectedTiles,
    state,
    walls,
    allowPit,
  );

  if (graph.maxFlow(source, sink) >= UNCUTTABLE) return null;

  // Source-side min cut: a cuttable tile whose IN is residual-reachable from
  // the source but whose OUT is not has its capacity-1 internal edge saturated
  // — it lies on the cut and must be walled. Only in-box tiles carry edges, so
  // only they can be reachable; scanning the box (row-major = ascending key)
  // visits the same cut tiles in the same order as a full-grid scan would.
  const reachable = graph.residualReachable(source);
  const cut = new Set<TileKey>();
  for (let row = box.minR; row <= box.maxR; row++) {
    for (let col = box.minC; col <= box.maxC; col++) {
      const key = packTile(row, col);
      if (reachable[key] && !reachable[key + tileCount]) {
        cut.add(key as TileKey);
      }
    }
  }
  return cut;
}

/** Bounding box the flow graph spans: the tower zone's tile bbox unioned with
 *  every seed's rect and footprint, expanded by a 1-tile margin so the cut ring
 *  (rect±1) and any wall just outside the zone bbox stay in-graph. */
function computeEnclosureBox(
  seeds: readonly EnclosureSeed[],
  state: GameViewState,
): TileBounds {
  const acc: TileBounds = {
    minR: GRID_ROWS,
    maxR: -1,
    minC: GRID_COLS,
    maxC: -1,
  };
  const zoneBox = zoneTileBounds(state.map, seeds[0]!.tower.zone);
  if (zoneBox) {
    extendBounds(acc, zoneBox.minR, zoneBox.maxR, zoneBox.minC, zoneBox.maxC);
  }
  for (const { tower, interior } of seeds) {
    extendBounds(
      acc,
      tower.row,
      tower.row + TOWER_SIZE - 1,
      tower.col,
      tower.col + TOWER_SIZE - 1,
    );
    extendBounds(
      acc,
      interior.top,
      interior.bottom,
      interior.left,
      interior.right,
    );
  }
  const MARGIN = 1;
  return {
    minR: Math.max(0, acc.minR - MARGIN),
    maxR: Math.min(GRID_ROWS - 1, acc.maxR + MARGIN),
    minC: Math.max(0, acc.minC - MARGIN),
    maxC: Math.min(GRID_COLS - 1, acc.maxC + MARGIN),
  };
}

/** Grow a mutable bounds accumulator to include the `[r0,r1]×[c0,c1]` box. */
function extendBounds(
  acc: TileBounds,
  r0: number,
  r1: number,
  c0: number,
  c1: number,
): void {
  if (r0 < acc.minR) acc.minR = r0;
  if (r1 > acc.maxR) acc.maxR = r1;
  if (c0 < acc.minC) acc.minC = c0;
  if (c1 > acc.maxC) acc.maxC = c1;
}

/** Tiles the cut must wrap around (never wall): every seed tower footprint
 *  plus the grass interior of its rect. Seeded from the source and forced
 *  uncuttable in the flow graph. */
function collectProtectedTiles(
  seeds: readonly EnclosureSeed[],
  state: GameViewState,
  walls: ReadonlySet<TileKey>,
): Set<TileKey> {
  const protectedTiles = new Set<TileKey>();
  for (const { tower, interior } of seeds) {
    for (let row = tower.row; row < tower.row + TOWER_SIZE; row++) {
      for (let col = tower.col; col < tower.col + TOWER_SIZE; col++) {
        if (inBounds(row, col)) protectedTiles.add(packTile(row, col));
      }
    }
    for (let row = interior.top; row <= interior.bottom; row++) {
      for (let col = interior.left; col <= interior.right; col++) {
        if (!inBounds(row, col)) continue;
        const key = packTile(row, col);
        if (!walls.has(key) && isWallableGrass(state, row, col)) {
          protectedTiles.add(key);
        }
      }
    }
  }
  return protectedTiles;
}

/** Wire the vertex-split flow graph over the `box` tiles only: per non-wall
 *  tile an IN→OUT edge (cap 1 if a wall can seal there and it isn't protected,
 *  else uncuttable), channel edges to passable in-box 8-neighbours, and a drain
 *  to the sink when the tile is on the map border OR has a neighbour outside the
 *  box (the flood escaping the zone box has reached "outside"). The source feeds
 *  every protected tile. */
function buildFlowGraph(
  graph: FlowGraph,
  tileCount: number,
  source: number,
  sink: number,
  box: TileBounds,
  protectedTiles: ReadonlySet<TileKey>,
  state: GameViewState,
  walls: ReadonlySet<TileKey>,
  allowPit: boolean,
): void {
  for (let row = box.minR; row <= box.maxR; row++) {
    for (let col = box.minC; col <= box.maxC; col++) {
      const key = packTile(row, col);
      if (walls.has(key)) continue;
      // Internal IN->OUT edge carries the vertex capacity: 1 if a wall can
      // seal here (cuttable), uncuttable otherwise. Protected interior tiles
      // are never cuttable — the cut must go around them. With `allowPit`
      // (Foundations) a burning pit is cuttable too: the owner walls through it.
      const cuttable =
        !protectedTiles.has(key) && isRingWallable(state, row, col, allowPit);
      graph.addEdge(key, key + tileCount, cuttable ? 1 : UNCUTTABLE);
      let escapesBox = false;
      for (const [dr, dc] of DIRS_8) {
        const nr = row + dr;
        const nc = col + dc;
        if (!inBounds(nr, nc)) continue;
        if (nr < box.minR || nr > box.maxR || nc < box.minC || nc > box.maxC) {
          // Neighbour outside the box: the flood escapes the zone box here,
          // which is equivalent to reaching the map border (outside).
          escapesBox = true;
          continue;
        }
        const neighborKey = packTile(nr, nc);
        if (walls.has(neighborKey)) continue;
        graph.addEdge(key + tileCount, neighborKey, UNCUTTABLE);
      }
      const onMapBorder =
        row === 0 ||
        row === GRID_ROWS - 1 ||
        col === 0 ||
        col === GRID_COLS - 1;
      if (onMapBorder || escapesBox) {
        graph.addEdge(key + tileCount, sink, UNCUTTABLE);
      }
    }
  }
  for (const key of protectedTiles) {
    graph.addEdge(source, key, UNCUTTABLE);
  }
}

/** Minimal adjacency-list max-flow (Edmonds-Karp). Augments one unit-capacity
 *  path per BFS; the flow value equals the cut size (small), so a handful of
 *  BFS sweeps suffice. Detects an unbounded (uncuttable) path and short-
 *  circuits, signalling the tower is unenclosable. */
class FlowGraph {
  private readonly head: Int32Array;
  private readonly edgeTo: number[] = [];
  private readonly edgeCap: number[] = [];
  private readonly edgeNext: number[] = [];

  constructor(nodeCount: number) {
    this.head = new Int32Array(nodeCount).fill(-1);
  }

  addEdge(from: number, dest: number, cap: number): void {
    this.edgeTo.push(dest);
    this.edgeCap.push(cap);
    this.edgeNext.push(this.head[from]!);
    this.head[from] = this.edgeTo.length - 1;
    // Reverse residual edge, capacity 0.
    this.edgeTo.push(from);
    this.edgeCap.push(0);
    this.edgeNext.push(this.head[dest]!);
    this.head[dest] = this.edgeTo.length - 1;
  }

  maxFlow(source: number, sink: number): number {
    let flow = 0;
    const nodeCount = this.head.length;
    const parentEdge = new Int32Array(nodeCount);
    const queue = new Int32Array(nodeCount);
    for (;;) {
      parentEdge.fill(-1);
      parentEdge[source] = -2;
      let qHead = 0;
      let qTail = 0;
      queue[qTail++] = source;
      let reached = false;
      while (qHead < qTail) {
        const node = queue[qHead++]!;
        if (node === sink) {
          reached = true;
          break;
        }
        for (let e = this.head[node]!; e !== -1; e = this.edgeNext[e]!) {
          if (this.edgeCap[e]! <= 0) continue;
          const next = this.edgeTo[e]!;
          if (parentEdge[next] !== -1) continue;
          parentEdge[next] = e;
          queue[qTail++] = next;
        }
      }
      if (!reached) break;
      // Bottleneck along the augmenting path.
      let bottleneck = UNCUTTABLE;
      for (let node = sink; node !== source; ) {
        const e = parentEdge[node]!;
        if (this.edgeCap[e]! < bottleneck) bottleneck = this.edgeCap[e]!;
        node = this.edgeTo[e ^ 1]!;
      }
      // An all-uncuttable path means no finite cut separates source from sink.
      if (bottleneck >= UNCUTTABLE) return UNCUTTABLE;
      for (let node = sink; node !== source; ) {
        const e = parentEdge[node]!;
        this.edgeCap[e] = this.edgeCap[e]! - bottleneck;
        this.edgeCap[e ^ 1] = this.edgeCap[e ^ 1]! + bottleneck;
        node = this.edgeTo[e ^ 1]!;
      }
      flow += bottleneck;
    }
    return flow;
  }

  residualReachable(source: number): Uint8Array {
    const nodeCount = this.head.length;
    const reachable = new Uint8Array(nodeCount);
    const queue = new Int32Array(nodeCount);
    let qHead = 0;
    let qTail = 0;
    reachable[source] = 1;
    queue[qTail++] = source;
    while (qHead < qTail) {
      const node = queue[qHead++]!;
      for (let e = this.head[node]!; e !== -1; e = this.edgeNext[e]!) {
        if (this.edgeCap[e]! <= 0) continue;
        const next = this.edgeTo[e]!;
        if (reachable[next]) continue;
        reachable[next] = 1;
        queue[qTail++] = next;
      }
    }
    return reachable;
  }
}
