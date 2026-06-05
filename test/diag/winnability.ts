/**
 * Bag-coverage measurement for LATE_PLATEAU stalls.
 *
 * For each LATE_PLATEAU stall in the survival suite, identify the plateau-
 * start tick, capture (target rect, remaining ring gaps, pieces drawn after
 * plateau-start, board state). Run an offline backtracking solver: is there
 * ANY placement sequence of those pieces (any rotation, any valid anchor)
 * that closes all the remaining ring gaps?
 *
 * Output: per-stall WINNABLE/UNWINNABLE + aggregate by sub-mode.
 *
 * Usage: deno run -A test/diag/winnability.ts [seeds...]
 *   seeds defaults to the 40-seed survival suite.
 */

import { createScenario, waitForEvent } from "../scenario.ts";
import { Phase } from "../../src/shared/core/game-phase.ts";
import { GAME_EVENT } from "../../src/shared/core/game-event-bus.ts";
import { setAiBuildDiagHook } from "../../src/ai/ai-build-diag.ts";
import {
  ALL_PIECE_SHAPES,
  rotateCW,
  type PieceShape,
} from "../../src/shared/core/pieces.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  Tile,
  type TileKey,
} from "../../src/shared/core/grid.ts";
import { packTile, unpackTile } from "../../src/shared/core/spatial.ts";
import type { TileRect } from "../../src/shared/core/geometry-types.ts";
import type { ValidPlayerId } from "../../src/shared/core/player-slot.ts";
import {
  countIsolatedGaps,
  countNarrowPieces,
  solveWinnable,
} from "../winnability-solver.ts";

interface TickRecord {
  trajIdx: number;
  eventOrd: number;
  path: string;
  rectKey: string;
  rect: TileRect | null;
  gaps: TileKey[];
  pieceShape: string;
  /** Snapshot of the player's bag queue at this tick. The queue is stored
   *  in pop-order (.pop() returns the last element), so the actual draw
   *  order is queue.reverse(). Captured by reading sc.state.players[pid].bag
   *  at the time the hook fires. Used by the solver to model "what pieces
   *  could the AI have drawn if it had advanced the bag via wasteful
   *  placements?" — the key lever for true winnability measurement. */
  bagQueue: string[];
}

interface PlacementRecord {
  ownerPlayerId: ValidPlayerId;
  cells: TileKey[];
  pieceShape: string;
  eventOrd: number;
}

interface RoundCapture {
  round: number;
  ticksByPlayer: Map<ValidPlayerId, TickRecord[]>;
  placements: PlacementRecord[];
  /** Walls captured at start of WALL_BUILD (per player). */
  initialWalls: Map<ValidPlayerId, Set<TileKey>>;
  initialBlocked: Set<TileKey>;
  initialGrass: Set<TileKey>;
}

interface StallReport {
  seed: number;
  round: number;
  playerId: ValidPlayerId;
  subMode: string;
  walls: number;
  endStuck: number;
  totalProgress: number;
  endGapCount: number;
  remainingPieces: number;
  winnable: boolean | "TIMEOUT";
  solverNodes: number;
  rectKey: string;
  /** Count of remaining gaps whose ALL 4 cardinal neighbors are walls,
   *  blockers, or out-of-bounds. Such gaps can only ever be filled by a
   *  1x1 piece — counting them tests the "isolated-gap" hypothesis (the
   *  AI walls itself into single-cell holes that need narrow pieces the
   *  late-round bag rarely provides). */
  isolatedGapCount: number;
  /** Counts of narrow pieces (1-3 cells) in the plateau-start bag. The
   *  late-round bag is dominated by tier-2/tier-3 pieces; if isolated gaps
   *  exceed narrow-piece count, UNWINNABLE is mechanically forced. */
  narrowPieceCount: number;
}

interface SubModeResult {
  kind: "LATE_PLATEAU" | "OTHER";
  endStuck: number;
  totalProgress: number;
  plateauStartTrajIdx: number;
  endGap: number;
  endRectKey: string;
}

const DEFAULT_SEEDS = [
  42, 100, 147323, 203607, 314159, 409946, 510296, 550021, 555555, 634446,
  677242, 700000, 833681, 921118, 1234567, 1364287, 1992148, 2468171, 3020266,
  3391887, 3480269, 4514090, 4778786, 5923908, 6959185, 7082653, 7126930,
  7260128, 7414600, 7777777, 8055250, 8114943, 8815892, 9083713, 9142064,
  9364665, 9468552, 9634092, 9862896, 9974133,
];
const ROUNDS_TO_PLAY = 30;
const PLAYER_NAMES = ["RED", "BLUE", "GOLD"] as const;
const STALL_WALL_THRESHOLD = 25;
const RUN_BUDGET_MS = 5_500_000;

await main();

async function main() {
  const args = Deno.args.length > 0 ? Deno.args.map(Number) : DEFAULT_SEEDS;
  console.log(`# Bag-coverage / winnability diagnostic`);
  console.log(`# Running ${args.length} seeds, ${ROUNDS_TO_PLAY} rounds each`);

  const allReports: StallReport[] = [];

  for (const seed of args) {
    const start = performance.now();
    const reports = await measureSeed(seed);
    allReports.push(...reports);
    const ms = Math.round(performance.now() - start);
    console.log(
      `# seed=${seed} ${reports.length} LATE_PLATEAU stalls measured in ${ms}ms`,
    );
  }

  printAggregate(allReports);
}

async function measureSeed(seed: number): Promise<StallReport[]> {
  const sc = await createScenario({
    seed,
    mode: "modern",
    rounds: ROUNDS_TO_PLAY + 1,
  });

  const perRound = new Map<number, RoundCapture>();
  const getRound = (round: number): RoundCapture => {
    let cap = perRound.get(round);
    if (!cap) {
      cap = {
        round,
        ticksByPlayer: new Map(),
        placements: [],
        initialWalls: new Map(),
        initialBlocked: new Set(),
        initialGrass: new Set(),
      };
      perRound.set(round, cap);
    }
    return cap;
  };

  let eventOrd = 0;

  setAiBuildDiagHook((event) => {
    if (event.kind !== "target-selected") return;
    const cap = getRound(event.round);
    let ticks = cap.ticksByPlayer.get(event.playerId);
    if (!ticks) {
      ticks = [];
      cap.ticksByPlayer.set(event.playerId, ticks);
    }
    const rect = event.targetRect;
    const player = sc.state.players[event.playerId];
    // bag.queue is pop-ordered; reverse for draw-order. Optional chain in
    // case bag is undefined for unseated slots (shouldn't happen during
    // active build but guarded for safety).
    const bagQueue = player?.bag
      ? player.bag.queue
          .slice()
          .reverse()
          .map((p) => p.name)
      : [];
    ticks.push({
      trajIdx: ticks.length,
      eventOrd: eventOrd++,
      path: event.path,
      rectKey: rect
        ? `${rect.top},${rect.left}-${rect.bottom},${rect.right}`
        : "",
      rect,
      gaps: [...event.targetGaps],
      pieceShape: event.currentPieceShapeName,
      bagQueue,
    });
  });

  sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
    if (ev.phase !== Phase.WALL_BUILD) return;
    const cap = getRound(sc.state.round);
    // Snapshot per-player walls and shared blockers/grass at WALL_BUILD entry.
    for (let pid = 0 as ValidPlayerId; pid < 3; pid = (pid + 1) as ValidPlayerId) {
      const player = sc.state.players[pid];
      if (!player) continue;
      cap.initialWalls.set(pid, new Set(player.walls));
    }
    // Static blockers (towers, cannons) + grass set. Houses are added as
    // blockers; we don't track house death during build because the AI's
    // targetGaps already excludes house-occupied ring cells (via
    // filterUnfillableGaps). Walls placed on houses don't form walls anyway
    // (build-system.ts spawns a grunt instead), so a house at a gap cell
    // can never be sealed by piece placement — treating houses as blockers
    // is correct for ring closure.
    for (const tower of sc.state.map.towers) {
      for (let dr = 0; dr < 2; dr++) {
        for (let dc = 0; dc < 2; dc++) {
          cap.initialBlocked.add(packTile(tower.row + dr, tower.col + dc));
        }
      }
    }
    for (const house of sc.state.map.houses) {
      if (!house.alive) continue;
      cap.initialBlocked.add(packTile(house.row, house.col));
    }
    for (let pid2 = 0 as ValidPlayerId; pid2 < 3; pid2 = (pid2 + 1) as ValidPlayerId) {
      const p = sc.state.players[pid2];
      if (!p) continue;
      for (const cannon of p.cannons) {
        // Cannons are 2x2.
        for (let dr = 0; dr < 2; dr++) {
          for (let dc = 0; dc < 2; dc++) {
            cap.initialBlocked.add(packTile(cannon.row + dr, cannon.col + dc));
          }
        }
      }
    }
    for (const pit of sc.state.burningPits) {
      cap.initialBlocked.add(packTile(pit.row, pit.col));
    }
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        if (sc.state.map.tiles[r]![c] === Tile.Grass) {
          cap.initialGrass.add(packTile(r, c));
        }
      }
    }
  });

  sc.bus.on(GAME_EVENT.WALL_PLACED, (ev) => {
    const cap = getRound(sc.state.round);
    // Look up the pieceShape from the most recent tick for this player.
    const ticks = cap.ticksByPlayer.get(ev.playerId);
    const lastTick = ticks?.[ticks.length - 1];
    cap.placements.push({
      ownerPlayerId: ev.playerId,
      cells: [...ev.tileKeys],
      pieceShape: lastTick?.pieceShape ?? "?",
      eventOrd: eventOrd++,
    });
  });

  try {
    waitForEvent(
      sc,
      GAME_EVENT.PHASE_START,
      (ev) =>
        ev.phase === Phase.WALL_BUILD && sc.state.round === ROUNDS_TO_PLAY,
      { timeoutMs: RUN_BUDGET_MS, label: `seed=${seed} r${ROUNDS_TO_PLAY} WB` },
    );
    waitForEvent(sc, GAME_EVENT.ROUND_END, (ev) => ev.round === ROUNDS_TO_PLAY, {
      timeoutMs: 90_000,
      label: `seed=${seed} r${ROUNDS_TO_PLAY} end`,
    });
  } catch {
    // Game may end early via last-player-standing — partial data still useful.
  } finally {
    setAiBuildDiagHook(undefined);
  }

  // Analyze captured rounds for LATE_PLATEAU stalls + run solver.
  const reports: StallReport[] = [];
  for (const cap of perRound.values()) {
    for (let pid = 0; pid < 3; pid++) {
      const playerId = pid as ValidPlayerId;
      const ticks = cap.ticksByPlayer.get(playerId);
      if (!ticks || ticks.length === 0) continue;
      const wallCount = sumWalls(cap.placements, playerId);
      if (wallCount < STALL_WALL_THRESHOLD) continue;
      const submode = classifySubMode(ticks);
      if (submode.kind !== "LATE_PLATEAU") continue;
      const report = solveStall(seed, cap, playerId, ticks, wallCount, submode);
      if (report) {
        reports.push(report);
        printReport(report);
      }
    }
  }
  return reports;
}

function sumWalls(placements: PlacementRecord[], pid: ValidPlayerId): number {
  let sum = 0;
  for (const p of placements) {
    if (p.ownerPlayerId === pid) sum += p.cells.length;
  }
  return sum;
}

function classifySubMode(ticks: TickRecord[]): SubModeResult {
  if (ticks.length === 0) {
    return {
      kind: "OTHER",
      endStuck: 0,
      totalProgress: 0,
      plateauStartTrajIdx: 0,
      endGap: 0,
      endRectKey: "",
    };
  }
  let endStuck = 0;
  let plateauStartIdx = ticks.length;
  for (let i = ticks.length - 1; i > 0; i--) {
    const sameRect = ticks[i]!.rectKey === ticks[i - 1]!.rectKey;
    const gapDropped = ticks[i]!.gaps.length < ticks[i - 1]!.gaps.length;
    if (sameRect && !gapDropped) {
      endStuck++;
      plateauStartIdx = i - 1;
    } else {
      break;
    }
  }
  // Compute totalProgress = sum of (max-min) per rect across the trajectory.
  const rectGaps = new Map<string, { min: number; max: number }>();
  for (const tick of ticks) {
    const cur = rectGaps.get(tick.rectKey);
    if (!cur)
      rectGaps.set(tick.rectKey, {
        min: tick.gaps.length,
        max: tick.gaps.length,
      });
    else {
      if (tick.gaps.length < cur.min) cur.min = tick.gaps.length;
      if (tick.gaps.length > cur.max) cur.max = tick.gaps.length;
    }
  }
  let totalProgress = 0;
  for (const v of rectGaps.values()) totalProgress += v.max - v.min;

  const endGap = ticks[ticks.length - 1]!.gaps.length;
  const endRectKey = ticks[ticks.length - 1]!.rectKey;
  const kind: SubModeResult["kind"] =
    endStuck >= 8 && totalProgress >= 5 ? "LATE_PLATEAU" : "OTHER";
  return {
    kind,
    endStuck,
    totalProgress,
    plateauStartTrajIdx: plateauStartIdx,
    endGap,
    endRectKey,
  };
}

function solveStall(
  seed: number,
  cap: RoundCapture,
  playerId: ValidPlayerId,
  ticks: TickRecord[],
  wallCount: number,
  submode: SubModeResult,
): StallReport | null {
  const plateauTick = ticks[submode.plateauStartTrajIdx];
  if (!plateauTick || !plateauTick.rect) return null;
  const plateauEventOrd = plateauTick.eventOrd;
  // Reconstruct focal player's walls at plateau-start: initial + placements
  // for THIS player with eventOrd < plateauEventOrd.
  const initialWalls = cap.initialWalls.get(playerId) ?? new Set();
  const focalWalls = new Set<TileKey>(initialWalls);
  // Other players' walls + my older walls go into a single blocked set
  // (canPlacePiece treats own walls + enemy walls + towers/cannons all as
  // "cell unavailable"; for offline solver we just need a unified blocked
  // set + an overlap-allowance of 0 — modern Rampart has no global
  // overlap upgrade by default, so 0 is the conservative under-count).
  const enemyWalls = new Set<TileKey>();
  for (const place of cap.placements) {
    if (place.eventOrd >= plateauEventOrd) continue;
    if (place.ownerPlayerId === playerId) {
      for (const cell of place.cells) focalWalls.add(cell);
    } else {
      for (const cell of place.cells) enemyWalls.add(cell);
    }
  }
  // Also initial walls of enemies.
  for (let pid = 0 as ValidPlayerId; pid < 3; pid = (pid + 1) as ValidPlayerId) {
    if (pid === playerId) continue;
    const w = cap.initialWalls.get(pid);
    if (w) for (const cell of w) enemyWalls.add(cell);
  }
  // Build "remaining gaps at plateau start" from the plateau tick's targetGaps,
  // minus any cells that the focal player has already walled.
  const remainingGaps = new Set<TileKey>();
  for (const key of plateauTick.gaps) {
    if (!focalWalls.has(key)) remainingGaps.add(key);
  }
  if (remainingGaps.size === 0) {
    // Edge case: AI considered the rect "done" but the runner classified it
    // as a stall anyway — likely the rect's gaps got filtered to empty.
    // Treat as trivially winnable.
    return {
      seed,
      round: cap.round,
      playerId,
      subMode: "LATE_PLATEAU",
      walls: wallCount,
      endStuck: submode.endStuck,
      totalProgress: submode.totalProgress,
      endGapCount: submode.endGap,
      remainingPieces: 0,
      winnable: true,
      solverNodes: 0,
      rectKey: plateauTick.rectKey,
      isolatedGapCount: 0,
      narrowPieceCount: 0,
    };
  }
  // Pieces available to the AI from plateau-start onward. The AI's CURRENT
  // piece at plateau-start is `plateauTick.pieceShape`. The bag queue contains
  // the next pieces (deterministic order). The AI can model "what if I made
  // a wasteful placement to advance the bag and unlock a fitting piece?" —
  // so we hand the solver the full available sequence and let it skip pieces
  // it can't use (the skip models a wasteful placement that doesn't covergaps
  // but advances the bag).
  // Bound the count by remaining ticks (each tick can at most consume 1
  // piece — a generous upper bound on what the AI realistically draws).
  const ticksRemaining = ticks.length - submode.plateauStartTrajIdx;
  const fullPieceQueue = [plateauTick.pieceShape, ...plateauTick.bagQueue];
  const pieceNames = fullPieceQueue.slice(0, ticksRemaining);
  const pieces = pieceNames
    .map((name) => ALL_PIECE_SHAPES.find((s) => s.name === name))
    .filter((s): s is PieceShape => s !== undefined);
  // Build blocker set: enemy walls + towers + cannons + houses (from
  // initialBlocked) + own walls aren't included (they're in focalWalls,
  // tracked separately in the solver to support overlap allowance).
  const blocked = new Set<TileKey>(cap.initialBlocked);
  for (const cell of enemyWalls) blocked.add(cell);
  if (Deno.env.get("DBG_STALL") === `${seed}:${cap.round}:${playerId}`) {
    console.log(`DEBUG seed=${seed} r${cap.round} pid=${playerId}`);
    console.log(`  plateauTrajIdx=${submode.plateauStartTrajIdx} plateauEventOrd=${plateauEventOrd}`);
    console.log(`  initialGrass=${cap.initialGrass.size} initialBlocked=${cap.initialBlocked.size}`);
    console.log(`  focalWalls=${focalWalls.size} enemyWalls=${enemyWalls.size} blocked=${blocked.size}`);
    console.log(`  remainingGaps=${remainingGaps.size} pieces=[${pieceNames.join(",")}]`);
    const rect = plateauTick.rect!;
    console.log(`  rect=[${rect.top},${rect.left}-${rect.bottom},${rect.right}]`);
    for (const gk of [...remainingGaps]) {
      const { row, col } = unpackTile(gk);
      console.log(`  gap (${row},${col}): grass=${cap.initialGrass.has(gk)} blocked=${blocked.has(gk)} wall=${focalWalls.has(gk)}`);
    }
    // ASCII snapshot of rect + 3-cell halo. Symbols:
    //   G = focal wall, E = enemy wall, T = tower, H = house, C = cannon/pit (blocked),
    //   . = grass placeable, ~ = water/non-grass, * = remaining gap
    const rTop = Math.max(0, rect.top - 3);
    const rBot = Math.min(GRID_ROWS - 1, rect.bottom + 3);
    const cLeft = Math.max(0, rect.left - 3);
    const cRight = Math.min(GRID_COLS - 1, rect.right + 3);
    for (let r = rTop; r <= rBot; r++) {
      let row = `r${r.toString().padStart(2, "0")}: `;
      for (let c = cLeft; c <= cRight; c++) {
        const k = packTile(r, c);
        let ch = ".";
        if (remainingGaps.has(k)) ch = "*";
        else if (focalWalls.has(k)) ch = "G";
        else if (enemyWalls.has(k)) ch = "E";
        else if (blocked.has(k)) ch = "B";
        else if (!cap.initialGrass.has(k)) ch = "~";
        row += ch;
      }
      console.log(row);
    }
    // Enumerate placements per piece for first 3 pieces.
    for (let pi = 0; pi < Math.min(3, pieces.length); pi++) {
      const piece = pieces[pi]!;
      console.log(`  piece[${pi}]=${piece.name} offsets=${JSON.stringify(piece.offsets)}`);
      // For each rotation, enumerate.
      let cur = piece;
      const seenRot = new Set<string>();
      for (let rotIdx = 0; rotIdx < 4; rotIdx++) {
        const sk = [...cur.offsets]
          .map(([r, c]) => `${r},${c}`)
          .sort()
          .join(";");
        if (seenRot.has(sk)) {
          cur = rotateCW(cur);
          continue;
        }
        seenRot.add(sk);
        // enumerate per gap × per offset
        for (const gk of remainingGaps) {
          const { row: gr, col: gc } = unpackTile(gk);
          for (const [dr, dc] of cur.offsets) {
            const ar = gr - dr;
            const ac = gc - dc;
            const failCells: string[] = [];
            for (const [odr, odc] of cur.offsets) {
              const rr = ar + odr;
              const cc = ac + odc;
              if (rr < 0 || rr >= GRID_ROWS || cc < 0 || cc >= GRID_COLS) {
                failCells.push(`(${rr},${cc}):oob`);
                continue;
              }
              const key = packTile(rr, cc);
              if (!cap.initialGrass.has(key)) failCells.push(`(${rr},${cc}):ng`);
              else if (blocked.has(key)) failCells.push(`(${rr},${cc}):bl`);
              else if (focalWalls.has(key)) failCells.push(`(${rr},${cc}):wl`);
            }
            if (failCells.length > 0)
              console.log(
                `    rot${rotIdx} anchor=(${ar},${ac}) covers (${gr},${gc}): FAIL ${failCells.slice(0, 3).join(" ")}`,
              );
            else
              console.log(
                `    rot${rotIdx} anchor=(${ar},${ac}) covers (${gr},${gc}): VALID`,
              );
          }
        }
        cur = rotateCW(cur);
      }
    }
  }
  const winnable = solveWinnable(
    remainingGaps,
    focalWalls,
    blocked,
    cap.initialGrass,
    pieces,
  );
  // Corroborating stats: isolated gap count + narrow piece count. Both are
  // static signals (no search needed) — useful for cross-cutting even when
  // the solver result alone is the headline number.
  const isolatedGapCount = countIsolatedGaps(
    remainingGaps,
    focalWalls,
    blocked,
    cap.initialGrass,
  );
  const narrowPieceCount = countNarrowPieces(pieceNames);
  return {
    seed,
    round: cap.round,
    playerId,
    subMode: "LATE_PLATEAU",
    walls: wallCount,
    endStuck: submode.endStuck,
    totalProgress: submode.totalProgress,
    endGapCount: remainingGaps.size,
    remainingPieces: pieces.length,
    winnable: winnable.result,
    solverNodes: winnable.nodes,
    rectKey: plateauTick.rectKey,
    isolatedGapCount,
    narrowPieceCount,
  };
}

function printReport(r: StallReport): void {
  const win =
    r.winnable === true
      ? "WINNABLE"
      : r.winnable === false
        ? "UNWINNABLE"
        : "TIMEOUT";
  console.log(
    `STALL seed=${r.seed} r${r.round} ${PLAYER_NAMES[r.playerId]}: ${win} | gaps=${r.endGapCount} (iso=${r.isolatedGapCount}) pieces=${r.remainingPieces} (narrow=${r.narrowPieceCount}) stuck=${r.endStuck}t progress=${r.totalProgress}g walls=${r.walls} rect=${r.rectKey} nodes=${r.solverNodes}`,
  );
}

function printAggregate(reports: readonly StallReport[]): void {
  console.log(`\n# ============================================`);
  console.log(`# AGGREGATE: ${reports.length} LATE_PLATEAU stalls`);
  console.log(`# ============================================`);

  const winnable = reports.filter((r) => r.winnable === true).length;
  const unwinnable = reports.filter((r) => r.winnable === false).length;
  const timeout = reports.filter((r) => r.winnable === "TIMEOUT").length;
  const total = reports.length;
  console.log(
    `WINNABLE: ${winnable}/${total} (${pct(winnable, total)}%) | UNWINNABLE: ${unwinnable}/${total} (${pct(unwinnable, total)}%) | TIMEOUT: ${timeout}/${total} (${pct(timeout, total)}%)`,
  );

  // Breakdown by gap count
  console.log(`\n# By end-gap count:`);
  for (const bucket of [
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 5],
    [6, 8],
    [9, 99],
  ]) {
    const [lo, hi] = bucket;
    const xs = reports.filter((r) => r.endGapCount >= lo && r.endGapCount <= hi);
    if (xs.length === 0) continue;
    const win = xs.filter((r) => r.winnable === true).length;
    const lose = xs.filter((r) => r.winnable === false).length;
    const t = xs.filter((r) => r.winnable === "TIMEOUT").length;
    console.log(
      `  gaps=${lo}${lo === hi ? "" : `-${hi}`} n=${xs.length}: WIN=${win} (${pct(win, xs.length)}%) LOSE=${lose} (${pct(lose, xs.length)}%) TO=${t}`,
    );
  }

  // Breakdown by remaining pieces
  console.log(`\n# By remaining piece count:`);
  for (const bucket of [
    [0, 2],
    [3, 5],
    [6, 9],
    [10, 14],
    [15, 99],
  ]) {
    const [lo, hi] = bucket;
    const xs = reports.filter(
      (r) => r.remainingPieces >= lo && r.remainingPieces <= hi,
    );
    if (xs.length === 0) continue;
    const win = xs.filter((r) => r.winnable === true).length;
    const lose = xs.filter((r) => r.winnable === false).length;
    const t = xs.filter((r) => r.winnable === "TIMEOUT").length;
    console.log(
      `  pieces=${lo}-${hi} n=${xs.length}: WIN=${win} (${pct(win, xs.length)}%) LOSE=${lose} (${pct(lose, xs.length)}%) TO=${t}`,
    );
  }

  // Breakdown by player
  console.log(`\n# By player:`);
  for (let pid = 0; pid < 3; pid++) {
    const xs = reports.filter((r) => r.playerId === pid);
    if (xs.length === 0) continue;
    const win = xs.filter((r) => r.winnable === true).length;
    const lose = xs.filter((r) => r.winnable === false).length;
    const t = xs.filter((r) => r.winnable === "TIMEOUT").length;
    console.log(
      `  ${PLAYER_NAMES[pid]} n=${xs.length}: WIN=${win} (${pct(win, xs.length)}%) LOSE=${lose} (${pct(lose, xs.length)}%) TO=${t}`,
    );
  }

  // Median solver nodes
  const nodesSorted = [...reports.map((r) => r.solverNodes)].sort((a, b) => a - b);
  const medianNodes = nodesSorted[Math.floor(nodesSorted.length / 2)] ?? 0;
  console.log(
    `\n# Solver: median ${medianNodes} nodes, max ${nodesSorted[nodesSorted.length - 1] ?? 0}`,
  );

  // Cross-cut: isolated-gap vs narrow-piece mechanically-forced UNWINNABLE.
  // A stall is "mechanically forced UNWINNABLE" if isolated gaps exceed
  // narrow pieces in the bag (only narrow pieces can fill isolated gaps).
  console.log(
    `\n# Isolated-gap vs narrow-piece cross-cut (mechanically-forced UNWINNABLE):`,
  );
  let forced = 0;
  for (const r of reports) {
    if (r.isolatedGapCount > r.narrowPieceCount) forced++;
  }
  console.log(
    `  ${forced}/${reports.length} stalls have isolated gaps > narrow pieces in bag (${pct(forced, reports.length)}%)`,
  );
  // Headline: of UNWINNABLE stalls, how many are mechanically forced vs
  // strategic-impossible-but-not-shape-trivially-forced?
  const unwinnableReports = reports.filter((r) => r.winnable === false);
  const unwinnableForced = unwinnableReports.filter(
    (r) => r.isolatedGapCount > r.narrowPieceCount,
  ).length;
  console.log(
    `  of UNWINNABLE (${unwinnableReports.length}): ${unwinnableForced} mechanically forced by isolated gaps (${pct(unwinnableForced, unwinnableReports.length)}%), ${unwinnableReports.length - unwinnableForced} other (${pct(unwinnableReports.length - unwinnableForced, unwinnableReports.length)}%)`,
  );

  // Distribution of isolated gap counts.
  console.log(`\n# Isolated gap count distribution:`);
  const isoBuckets: Record<string, number> = {};
  for (const r of reports) {
    const k = r.isolatedGapCount.toString();
    isoBuckets[k] = (isoBuckets[k] ?? 0) + 1;
  }
  for (const k of Object.keys(isoBuckets).sort((a, b) => Number(a) - Number(b))) {
    console.log(`  ${k} isolated gaps: ${isoBuckets[k]} stalls`);
  }

  // Narrow piece distribution
  console.log(`\n# Narrow piece count in plateau-start bag distribution:`);
  const narrowBuckets: Record<string, number> = {};
  for (const r of reports) {
    const k = r.narrowPieceCount.toString();
    narrowBuckets[k] = (narrowBuckets[k] ?? 0) + 1;
  }
  for (const k of Object.keys(narrowBuckets).sort(
    (a, b) => Number(a) - Number(b),
  )) {
    console.log(`  ${k} narrow pieces: ${narrowBuckets[k]} stalls`);
  }
}

function pct(num: number, denom: number): number {
  if (denom === 0) return 0;
  return Math.round((100 * num) / denom);
}
