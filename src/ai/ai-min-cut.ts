/**
 * AI build — minimal enclosure cut: the fewest new wall tiles that stop
 * `computeOutside` reaching a desired interior, as a vertex-capacitated s-t min
 * cut on the SAME 8-adjacency flood graph (blocks diagonal leaks, no plug step).
 * Protected region (source, uncuttable) = footprint + rect grass interior, so the
 * cut wraps the cannon space. Water/pits/houses/cannons/towers are uncuttable
 * channels (like `isTowerEnclosable`); existing walls leave the graph; null = unenclosable.
 */

import { TOWER_SIZE } from "../shared/core/game-constants.ts";
import type { TileRect, Tower } from "../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, type TileKey } from "../shared/core/grid.ts";
import { DIRS_8, inBounds, packTile } from "../shared/core/spatial.ts";
import type { BuildViewState } from "../shared/core/system-interfaces.ts";
import { isWallableGrass } from "./ai-castle-rect.ts";

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
 */
export function findEnclosureCut(
  seeds: readonly EnclosureSeed[],
  state: BuildViewState,
  walls: ReadonlySet<TileKey>,
): Set<TileKey> | null {
  const tileCount = GRID_ROWS * GRID_COLS;
  // Node ids: IN(t) = t, OUT(t) = t + tileCount, SOURCE, SINK.
  const source = tileCount * 2;
  const sink = tileCount * 2 + 1;
  const graph = new FlowGraph(tileCount * 2 + 2);

  const protectedTiles = collectProtectedTiles(seeds, state, walls);
  buildFlowGraph(graph, tileCount, source, sink, protectedTiles, state, walls);

  if (graph.maxFlow(source, sink) >= UNCUTTABLE) return null;

  // Source-side min cut: a cuttable tile whose IN is residual-reachable from
  // the source but whose OUT is not has its capacity-1 internal edge saturated
  // — it lies on the cut and must be walled.
  const reachable = graph.residualReachable(source);
  const cut = new Set<TileKey>();
  for (let key = 0; key < tileCount; key++) {
    if (reachable[key] && !reachable[key + tileCount]) {
      cut.add(key as TileKey);
    }
  }
  return cut;
}

/** Tiles the cut must wrap around (never wall): every seed tower footprint
 *  plus the grass interior of its rect. Seeded from the source and forced
 *  uncuttable in the flow graph. */
function collectProtectedTiles(
  seeds: readonly EnclosureSeed[],
  state: BuildViewState,
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

/** Wire the vertex-split flow graph: per non-wall tile an IN→OUT edge (cap 1
 *  if a wall can seal there and it isn't protected, else uncuttable), channel
 *  edges to passable 8-neighbours, border drains to the sink, and the source
 *  feeds every protected tile. */
function buildFlowGraph(
  graph: FlowGraph,
  tileCount: number,
  source: number,
  sink: number,
  protectedTiles: ReadonlySet<TileKey>,
  state: BuildViewState,
  walls: ReadonlySet<TileKey>,
): void {
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const key = packTile(row, col);
      if (walls.has(key)) continue;
      // Internal IN->OUT edge carries the vertex capacity: 1 if a wall can
      // seal here (cuttable), uncuttable otherwise. Protected interior tiles
      // are never cuttable — the cut must go around them.
      const cuttable =
        !protectedTiles.has(key) && isWallableGrass(state, row, col);
      graph.addEdge(key, key + tileCount, cuttable ? 1 : UNCUTTABLE);
      for (const [dr, dc] of DIRS_8) {
        const nr = row + dr;
        const nc = col + dc;
        if (!inBounds(nr, nc)) continue;
        const neighborKey = packTile(nr, nc);
        if (walls.has(neighborKey)) continue;
        graph.addEdge(key + tileCount, neighborKey, UNCUTTABLE);
      }
      if (
        row === 0 ||
        row === GRID_ROWS - 1 ||
        col === 0 ||
        col === GRID_COLS - 1
      ) {
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
