/**
 * AI tactic — finish it (perimeter spray). A dominant player (>=14 usable
 * cannons) glides the cursor around the LARGEST thin-walled enemy castle,
 * spamming SPACED holes: single-layer spots open with one, two-thick spots
 * punch THROUGH, spur gaps bridge via inner-wall pivots. Such a castle is a
 * MERGED seal, so breaching it faster than the defender reseals de-encloses ALL
 * its towers at once. Wired ABOVE pinch in `planBattle`; gate in `rollFinishIt`.
 */

import type { TilePos } from "../shared/core/geometry-types.ts";
import type { TileKey } from "../shared/core/grid.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import {
  computeOutside,
  DIRS_4,
  DIRS_8,
  inBounds,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import { filterActiveEnemies } from "../shared/sim/board-occupancy.ts";
import { computeLiveInterior } from "./ai-strategy-battle.ts";

/** A `pickThinnestCastle` match: the target's walls plus the identifying/sizing
 *  fields a caller needs to report the pick (e.g. a UI hint) without re-running
 *  the flood-fill/ratio scan itself. */
export interface FinishItTarget {
  readonly slot: ValidPlayerId;
  readonly walls: ReadonlySet<TileKey>;
  readonly interior: number;
  readonly thickRatio: number;
}

/** Concurrent player slots (Red/Blue/Gold). The spray's angular start is
 *  offset by slot so two dominant attackers hitting the same castle punch
 *  different holes instead of cloning the same sweep. */
const SLOT_COUNT = 3;
/** The 8 neighbour offsets in CLOCKWISE order from North — Moore tracing sweeps
 *  neighbours in this order to follow the boundary. */
const CLOCKWISE_8: readonly (readonly [number, number])[] = [
  [-1, 0], // N
  [-1, 1], // NE
  [0, 1], // E
  [1, 1], // SE
  [1, 0], // S
  [1, -1], // SW
  [0, -1], // W
  [-1, -1], // NW
];
/** Consecutive shots farther apart than this (Chebyshev) count as a cursor
 *  "jump". When a jump appears (the contour retracing a spur leaves the next
 *  hole far along), we bridge it with pivot holes through the wall mass — using
 *  INNER walls as stepping stones (destroying them too) — so the cursor glides.
 *  A jump is only tolerated when no wall-path can bridge it (a shell genuinely
 *  split by water). */
export const FINISH_IT_MAX_STEP = 5;
/** Interior tiles a target must enclose to count as "large". Started at the p75
 *  of all measured castles (145); lowered to 130 to fire more often — the size
 *  gate is the second-biggest frequency lever (a dominant player's victim is
 *  often small/being-crushed, so large targets are the scarce ingredient). Kept
 *  well above a crumb so the spray still lands on a castle worth the spend. */
export const FINISH_IT_MIN_INTERIOR = 130;
/** Minimum Manhattan gap between consecutive punched holes. ≥2 leaves at least
 *  one intact wall between holes, so each is a SEPARATE gap the victim fills
 *  with its own piece — the whole point (spread, not one contiguous breach). */
export const FINISH_IT_MIN_SPACING = 2;

/**
 * Plan a "finish it" perimeter spray: pick the largest thin-perimeter enemy
 * castle and return outer-wall holes spaced around its whole shell (with breach
 * punch-throughs at two-thick spots and inner-wall pivots bridging any spur
 * gaps), ordered as one fluid sweep around the castle (start rotated per
 * attacker). Returns null when no enemy is large enough, or its shell offers no
 * spaced holes.
 */
export function planFinishIt(
  state: BattleViewState,
  playerId: ValidPlayerId,
): TilePos[] | null {
  const target = pickThinnestCastle(state, playerId);
  if (!target) return null;
  const outside = computeOutside(target.walls);
  const shell = outerShellWalls(target.walls, outside);
  if (shell.length === 0) return null;
  const spread = spreadAroundRing(shell, playerId);
  if (spread.length === 0) return null;
  const shots = breachThroughThickSpots(spread, target.walls, outside);
  return bridgeJumps(shots, target.walls);
}

/** The active enemy with the THINNEST outer perimeter among the large-enough
 *  castles — the easiest to breach everywhere, so a sweep opens the merged seal
 *  in the most places. Interior size is the primary "large, high-payoff" gate
 *  (every large castle already encloses ≥2 towers, so it is inherently a merged
 *  castle); among those we pick the LOWEST thick-perimeter ratio, because fat
 *  OUTER walls resist breaching — a thick perimeter is a worse target, not a
 *  better one (the old guard, which REQUIRED a fat-wall count, had this
 *  backwards). Pure synced geometry — no rng — so every peer picks the same
 *  target; per-attacker desync lives in the walk-seed rotation. Exported so a
 *  caller (e.g. the MCP play harness) can run the SAME eligibility check to
 *  surface a "finish_it available" hint without duplicating the scan or paying
 *  for the full `planFinishIt` ring/spray computation just to answer "does a
 *  target qualify right now". */
export function pickThinnestCastle(
  state: BattleViewState,
  playerId: ValidPlayerId,
): FinishItTarget | undefined {
  let best: FinishItTarget | undefined;
  let bestRatio = Number.POSITIVE_INFINITY;
  for (const enemy of filterActiveEnemies(state, playerId)) {
    const interior = computeLiveInterior(enemy.walls);
    if (interior.size < FINISH_IT_MIN_INTERIOR) continue;
    const ratio = thickPerimeterRatio(enemy.walls, computeOutside(enemy.walls));
    if (ratio < bestRatio) {
      bestRatio = ratio;
      best = {
        slot: enemy.id,
        walls: enemy.walls,
        interior: interior.size,
        thickRatio: ratio,
      };
    }
  }
  return best;
}

/** Fraction of a castle's outer shell that is TWO-THICK — an outside-facing wall
 *  tile with another of the castle's own walls directly behind it (so a single
 *  hole there leaves the inner layer sealing; only a punch-through breaches). A
 *  high ratio = most of the perimeter resists breaching (a poor spray target); a
 *  low ratio = a thin wall the sweep holes open everywhere. */
function thickPerimeterRatio(
  walls: ReadonlySet<TileKey>,
  outside: ReadonlySet<TileKey>,
): number {
  let shell = 0;
  let thick = 0;
  for (const key of walls) {
    const { row, col } = unpackTile(key);
    let isShell = false;
    let behind = false;
    for (const [dr, dc] of DIRS_4) {
      const outR = row + dr;
      const outC = col + dc;
      if (!inBounds(outR, outC) || !outside.has(packTile(outR, outC))) continue;
      isShell = true;
      const inR = row - dr;
      const inC = col - dc;
      if (inBounds(inR, inC) && walls.has(packTile(inR, inC))) behind = true;
    }
    if (isShell) {
      shell++;
      if (behind) thick++;
    }
  }
  return shell > 0 ? thick / shell : 1;
}

/** The exposed outer shell: every wall tile 4-adjacent to the outside flood —
 *  the perimeter a hole directly punctures (deeper inner walls aren't visible
 *  to a demoralising "make holes all around" spray). */
function outerShellWalls(
  walls: ReadonlySet<TileKey>,
  outside: ReadonlySet<TileKey>,
): TilePos[] {
  const shell: TilePos[] = [];
  for (const key of walls) {
    const { row, col } = unpackTile(key);
    for (const [dr, dc] of DIRS_4) {
      const nr = row + dr;
      const nc = col + dc;
      // Bounds-guard before packTile: an edge wall's off-grid neighbour would
      // otherwise wrap to a bogus tile (and throw under the dev bounds check).
      if (inBounds(nr, nc) && outside.has(packTile(nr, nc))) {
        shell.push({ row, col });
        break;
      }
    }
  }
  return shell;
}

/** Order the shell as a fluid cursor PATH — a Moore contour trace of the largest
 *  boundary component, stepping only to 8-adjacent tiles (the human "run the
 *  cursor along the outside wall" motion) — then punch a hole on any traced tile
 *  not yet blocked by an earlier hole's spacing halo, so holes land ≈
 *  FINISH_IT_MIN_SPACING apart all the way around with an intact wall between
 *  each. The trace start is rotated by slot so concurrent attackers don't clone
 *  the sweep. No cap on count: it covers the whole ring and the battle timer is
 *  the natural limiter. */
function spreadAroundRing(
  shell: readonly TilePos[],
  playerId: ValidPlayerId,
): TilePos[] {
  const walk = mooreTrace(largestShellComponent(shell), playerId);
  const holes: TilePos[] = [];
  // Tiles within < FINISH_IT_MIN_SPACING (Chebyshev) of an already-placed hole.
  // Blocking GLOBALLY (not just vs the previous hole) keeps ≥1 intact wall
  // between every pair of gaps — even where the contour passes near itself, so
  // two arcs can't drop adjacent holes. Breach punch-throughs (added later) are
  // the only intended 2-adjacent shots.
  const blocked = new Set<TileKey>();
  const reach = FINISH_IT_MIN_SPACING - 1;
  for (const tile of walk) {
    const key = packTile(tile.row, tile.col);
    if (blocked.has(key)) continue;
    holes.push(tile);
    for (let dr = -reach; dr <= reach; dr++) {
      for (let dc = -reach; dc <= reach; dc++) {
        const nr = tile.row + dr;
        const nc = tile.col + dc;
        if (inBounds(nr, nc)) blocked.add(packTile(nr, nc));
      }
    }
  }
  return holes;
}

/** The largest 8-connected component of the shell — the castle's main outer
 *  wall (a merged castle's stray inner-courtyard boundary is a smaller, separate
 *  component). Ties broken by lowest member key so every peer picks the same
 *  ring for a given wall set (deterministic, no rng). */
function largestShellComponent(shell: readonly TilePos[]): TilePos[] {
  const inShell = new Set<TileKey>(shell.map((t) => packTile(t.row, t.col)));
  const visited = new Set<TileKey>();
  let best: TilePos[] = [];
  let bestKey = Number.POSITIVE_INFINITY;
  for (const seed of shell) {
    const seedKey = packTile(seed.row, seed.col);
    if (visited.has(seedKey)) continue;
    const comp: TilePos[] = [];
    const stack: TileKey[] = [seedKey];
    visited.add(seedKey);
    let minKey: number = seedKey;
    while (stack.length > 0) {
      const key = stack.pop()!;
      const { row, col } = unpackTile(key);
      comp.push({ row, col });
      if (key < minKey) minKey = key;
      for (const [dr, dc] of DIRS_8) {
        const nr = row + dr;
        const nc = col + dc;
        if (!inBounds(nr, nc)) continue;
        const neighborKey = packTile(nr, nc);
        if (inShell.has(neighborKey) && !visited.has(neighborKey)) {
          visited.add(neighborKey);
          stack.push(neighborKey);
        }
      }
    }
    if (
      comp.length > best.length ||
      (comp.length === best.length && minKey < bestKey)
    ) {
      best = comp;
      bestKey = minKey;
    }
  }
  return best;
}

/** Moore-neighbour contour trace of a connected shell component: a continuous
 *  closed walk around its boundary. From the top-left-most tile (entered from
 *  the west), each step sweeps the 8 neighbours CLOCKWISE starting just past the
 *  cell we came from and takes the first that is in the component — so every
 *  step is 8-adjacent (distance 1, the cursor never teleports) and the walk
 *  covers the WHOLE ring, retracing over junction tiles rather than stranding a
 *  branch. The closed walk is rotated by slot so concurrent attackers start at
 *  different points (rotation keeps adjacency: the contour's ends meet).
 *  Deterministic (no rng): fixed start + fixed clockwise sweep. */
function mooreTrace(
  comp: readonly TilePos[],
  playerId: ValidPlayerId,
): TilePos[] {
  if (comp.length === 0) return [];
  const inComp = new Set<TileKey>(comp.map((t) => packTile(t.row, t.col)));
  let start = comp[0]!;
  let startKey = packTile(start.row, start.col);
  for (const tile of comp) {
    const key = packTile(tile.row, tile.col);
    if (key < startKey) {
      startKey = key;
      start = tile;
    }
  }
  // Entered the top-left-most tile from the west (that cell is background).
  let back = { row: start.row, col: start.col - 1 };
  let cur = start;
  const walk: TilePos[] = [start];
  const maxSteps = comp.length * 8 + 8; // hard backstop against a trace that won't close
  for (let step = 0; step < maxSteps; step++) {
    let startIdx = 0;
    for (let i = 0; i < 8; i++) {
      if (
        cur.row + CLOCKWISE_8[i]![0] === back.row &&
        cur.col + CLOCKWISE_8[i]![1] === back.col
      ) {
        startIdx = i;
        break;
      }
    }
    let found: TilePos | undefined;
    let lastBack = back;
    for (let k = 1; k <= 8; k++) {
      const [dr, dc] = CLOCKWISE_8[(startIdx + k) % 8]!;
      const nr = cur.row + dr;
      const nc = cur.col + dc;
      if (inBounds(nr, nc) && inComp.has(packTile(nr, nc))) {
        found = { row: nr, col: nc };
        break;
      }
      lastBack = { row: nr, col: nc };
    }
    if (!found) break; // isolated tile
    back = lastBack;
    cur = found;
    if (cur.row === start.row && cur.col === start.col) break; // closed the loop
    walk.push(cur);
  }
  // Rotate the start by slot so concurrent attackers don't clone the sweep — but
  // ONLY when the contour is CLOSED (its ends are adjacent). Rotating a non-
  // closed trace would move its far-apart endpoints into the middle of the
  // sequence, a visible cursor jump; there we keep the natural top-left start.
  const first = walk[0]!;
  const lastTile = walk[walk.length - 1]!;
  const closed =
    Math.max(
      Math.abs(first.row - lastTile.row),
      Math.abs(first.col - lastTile.col),
    ) <= 1;
  const rot = closed ? Math.floor((playerId / SLOT_COUNT) * walk.length) : 0;
  return rot > 0 ? [...walk.slice(rot), ...walk.slice(0, rot)] : walk;
}

/** Expand the swept outer holes into the actual shot list: each hole is fired,
 *  and where the perimeter is two-thick at that spot the tile BEHIND the outer
 *  face is fired too — a punch-through that turns a mere chip into a real
 *  breach (the human "I need to break through a fat wall" move). Single-layer
 *  spots stay one shot; the cursor barely moves between an outer hole and its
 *  punch-through, so the sweep stays efficient. Duplicates (an inner tile that
 *  is also a later outer hole two tiles along) are dropped so no tile is shot
 *  twice. Ordering is preserved so the fire chain still glides around the ring. */
function breachThroughThickSpots(
  holes: readonly TilePos[],
  walls: ReadonlySet<TileKey>,
  outside: ReadonlySet<TileKey>,
): TilePos[] {
  const shots: TilePos[] = [];
  const seen = new Set<TileKey>();
  const push = (tile: TilePos) => {
    const key = packTile(tile.row, tile.col);
    if (seen.has(key)) return;
    seen.add(key);
    shots.push(tile);
  };
  for (const hole of holes) {
    push(hole);
    const behind = behindWallTile(walls, outside, hole);
    if (behind) push(behind);
  }
  return shots;
}

/** For an outer-shell tile, the wall tile directly BEHIND its outside face (the
 *  second layer to punch to breach a two-thick spot). Returns null when any
 *  outside-facing direction is single-layer — then the outer hole alone already
 *  opens the seal and no punch-through is needed. Prefers leaving thin spots
 *  as one shot (checks every outside face; a single thin face wins). O(1), no
 *  flood — mirrors how a human reads wall thickness by eye. */
function behindWallTile(
  walls: ReadonlySet<TileKey>,
  outside: ReadonlySet<TileKey>,
  tile: TilePos,
): TilePos | undefined {
  let thick: TilePos | undefined;
  for (const [dr, dc] of DIRS_4) {
    const outR = tile.row + dr;
    const outC = tile.col + dc;
    if (!inBounds(outR, outC) || !outside.has(packTile(outR, outC))) continue;
    const inR = tile.row - dr;
    const inC = tile.col - dc;
    if (!inBounds(inR, inC)) continue;
    if (!walls.has(packTile(inR, inC))) return undefined; // a thin face — one shot opens
    thick ??= { row: inR, col: inC };
  }
  return thick; // every outside face backed by wall — punch the second layer
}

/** Bridge cursor "jumps" in the shot list: wherever two consecutive shots are
 *  more than FINISH_IT_MAX_STEP apart (a spur retrace left the next hole far
 *  along the ring), route the cursor through the WALL MASS between them — a BFS
 *  shortest path over the castle's own 8-connected walls, cutting across inner
 *  walls where that is shorter — and insert those wall tiles as pivot holes, so
 *  every step stays small (and the inner walls get destroyed too). If no wall-
 *  path bridges the gap (a shell split by water), the jump is left as-is — a
 *  tolerated small jump. Deterministic (BFS over a fixed neighbour order). */
function bridgeJumps(
  shots: readonly TilePos[],
  walls: ReadonlySet<TileKey>,
): TilePos[] {
  const out: TilePos[] = [];
  for (let i = 0; i < shots.length; i++) {
    const cur = shots[i]!;
    if (i > 0 && chebyshevDistance(shots[i - 1]!, cur) > FINISH_IT_MAX_STEP) {
      const path = wallPathBetween(shots[i - 1]!, cur, walls);
      if (path) {
        for (let j = 1; j < path.length - 1; j++) {
          const pivot = path[j]!;
          const prev = out[out.length - 1]!;
          if (pivot.row !== prev.row || pivot.col !== prev.col) out.push(pivot);
        }
      }
    }
    out.push(cur);
  }
  return out;
}

/** BFS shortest path between two wall tiles over the castle's 8-connected wall
 *  mass, inclusive of both endpoints; null if they are not wall-connected.
 *  Neighbours sweep a fixed order so the path is deterministic (no rng). */
function wallPathBetween(
  from: TilePos,
  goal: TilePos,
  walls: ReadonlySet<TileKey>,
): TilePos[] | null {
  const startKey = packTile(from.row, from.col);
  const goalKey = packTile(goal.row, goal.col);
  if (startKey === goalKey) return [from];
  const cameFrom = new Map<TileKey, TileKey>();
  const seen = new Set<TileKey>([startKey]);
  let frontier: TilePos[] = [from];
  while (frontier.length > 0) {
    const next: TilePos[] = [];
    for (const tile of frontier) {
      for (const [dr, dc] of DIRS_8) {
        const nr = tile.row + dr;
        const nc = tile.col + dc;
        if (!inBounds(nr, nc)) continue;
        const neighborKey = packTile(nr, nc);
        if (seen.has(neighborKey) || !walls.has(neighborKey)) continue;
        seen.add(neighborKey);
        cameFrom.set(neighborKey, packTile(tile.row, tile.col));
        if (neighborKey === goalKey) {
          const path: TilePos[] = [];
          let key: TileKey | undefined = goalKey;
          while (key !== undefined) {
            path.push(unpackTile(key));
            key = key === startKey ? undefined : cameFrom.get(key);
          }
          return path.reverse();
        }
        next.push({ row: nr, col: nc });
      }
    }
    frontier = next;
  }
  return null;
}

/** Chebyshev (8-dir) distance — the number of cursor moves between two tiles. */
function chebyshevDistance(a: TilePos, b: TilePos): number {
  return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
}
