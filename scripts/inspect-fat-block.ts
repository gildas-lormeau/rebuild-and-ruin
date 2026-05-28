/**
 * Inspect a seed where a player ends WALL_BUILD with fat-wall blocks.
 *
 * Reports per-fat-block:
 *   - top-left (row, col) of the 2×2 wall block
 *   - which alive enclosed towers are within Chebyshev distance 8
 *   - small ASCII patch around the block (5×9) so we can verify it's the
 *     "secondary ring touching primary ring" geometry
 *
 * Usage: deno run -A scripts/inspect-fat-block.ts --seed N [--player RED|BLUE|GOLD] [--round N] [--mode modern|classic]
 */

import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { GRID_COLS, GRID_ROWS, Tile } from "../src/shared/core/grid.ts";
import { packTile } from "../src/shared/core/spatial.ts";
import type { GameState, Tower } from "../src/shared/core/types.ts";
import { createScenario } from "../test/scenario.ts";

interface Args {
  seed: number;
  round: number;
  player: 0 | 1 | 2 | null;
  mode: "modern" | "classic";
}

interface DoubledRun {
  orientation: "horizontal" | "vertical";
  row: number;
  col: number;
  length: number;
}

run();

async function run(): Promise<void> {
  const args = parseArgs();
  const sc = await createScenario({
    seed: args.seed,
    mode: args.mode,
    rounds: args.round + 1,
  });
  let captured: { round: number; state: GameState } | null = null;
  sc.bus.on(GAME_EVENT.ROUND_END, () => {
    if (captured) return;
    if (sc.state.round !== args.round) return;
    captured = { round: sc.state.round, state: sc.state };
  });
  sc.runUntil(() => captured !== null, { timeoutMs: 480_000 });
  if (!captured) {
    console.error(`no ROUND_END for round ${args.round} on seed ${args.seed}`);
    Deno.exit(1);
  }
  const state = captured.state;
  for (const player of state.players) {
    if (player.eliminated) continue;
    if (args.player !== null && player.id !== args.player) continue;
    const walls = player.walls as ReadonlySet<number>;
    const runs = findDoubledRuns(walls);
    if (runs.length === 0) continue;
    runs.sort((a, b) => b.length - a.length);
    const homeTowerIdx = player.homeTower?.index;
    console.log(
      `seed=${args.seed} mode=${args.mode} r${args.round} END  player=${player.id} (${["RED", "BLUE", "GOLD"][player.id]}) homeTower=T${homeTowerIdx} enclosedTowers=${player.enclosedTowers
        .map((t) => t.index)
        .join(",")} walls=${walls.size} doubledRuns=${runs.length}`,
    );
    for (const run of runs) {
      const near = nearbyEnclosedTowers(
        player.enclosedTowers,
        run.row,
        run.col,
        run.length,
        run.orientation,
      );
      console.log(
        `  ${run.orientation}-run (${run.row},${run.col}) length=${run.length} near-enclosed-towers=[${near
          .map((t) => `T${t.index}@(${t.row},${t.col})`)
          .join(", ")}]`,
      );
      console.log(renderRun(state, run, walls));
    }
  }
}

function findDoubledRuns(walls: ReadonlySet<number>): DoubledRun[] {
  const runs: DoubledRun[] = [];
  for (let row = 0; row + 1 < GRID_ROWS; row++) {
    let start = -1;
    for (let col = 0; col <= GRID_COLS; col++) {
      const doubled =
        col < GRID_COLS &&
        walls.has(packTile(row, col)) &&
        walls.has(packTile(row + 1, col));
      if (doubled) {
        if (start < 0) start = col;
      } else if (start >= 0) {
        const length = col - start;
        if (length >= 3) {
          runs.push({ orientation: "horizontal", row, col: start, length });
        }
        start = -1;
      }
    }
  }
  for (let col = 0; col + 1 < GRID_COLS; col++) {
    let start = -1;
    for (let row = 0; row <= GRID_ROWS; row++) {
      const doubled =
        row < GRID_ROWS &&
        walls.has(packTile(row, col)) &&
        walls.has(packTile(row, col + 1));
      if (doubled) {
        if (start < 0) start = row;
      } else if (start >= 0) {
        const length = row - start;
        if (length >= 3) {
          runs.push({ orientation: "vertical", row: start, col, length });
        }
        start = -1;
      }
    }
  }
  return runs;
}

function nearbyEnclosedTowers(
  enclosedTowers: readonly Tower[],
  r: number,
  c: number,
  length: number,
  orientation: "horizontal" | "vertical",
): Tower[] {
  const rEnd = orientation === "vertical" ? r + length - 1 : r + 1;
  const cEnd = orientation === "horizontal" ? c + length - 1 : c + 1;
  const out: Tower[] = [];
  for (const tower of enclosedTowers) {
    const dr = Math.max(0, Math.max(tower.row - rEnd, r - (tower.row + 1)));
    const dc = Math.max(0, Math.max(tower.col - cEnd, c - (tower.col + 1)));
    const cheb = Math.max(dr, dc);
    if (cheb <= 8) out.push(tower);
  }
  return out;
}

function renderRun(
  state: GameState,
  run: DoubledRun,
  ownerWalls: ReadonlySet<number>,
): string {
  const radius = 4;
  const rEnd =
    run.orientation === "vertical" ? run.row + run.length - 1 : run.row + 1;
  const cEnd =
    run.orientation === "horizontal" ? run.col + run.length - 1 : run.col + 1;
  const r0 = Math.max(0, run.row - radius);
  const r1 = Math.min(GRID_ROWS - 1, rEnd + radius);
  const c0 = Math.max(0, run.col - radius);
  const c1 = Math.min(GRID_COLS - 1, cEnd + radius);
  const towerSet = new Set<number>();
  for (const tower of state.map.towers) {
    if (!tower.alive) continue;
    for (let dr = 0; dr < 2; dr++) {
      for (let dc = 0; dc < 2; dc++) {
        towerSet.add(packTile(tower.row + dr, tower.col + dc));
      }
    }
  }
  const allWalls = new Set<number>();
  for (const player of state.players) {
    for (const key of player.walls) allWalls.add(key);
  }
  const lines: string[] = [];
  const header =
    "    " +
    Array.from({ length: c1 - c0 + 1 }, (_, idx) =>
      String((c0 + idx) % 10),
    ).join("");
  lines.push(header);
  for (let row = r0; row <= r1; row++) {
    const cells: string[] = [];
    for (let col = c0; col <= c1; col++) {
      const key = packTile(row, col);
      const tile = state.map.tiles[row]![col];
      const inRun =
        row >= run.row && row <= rEnd && col >= run.col && col <= cEnd;
      if (towerSet.has(key)) {
        cells.push("T");
      } else if (ownerWalls.has(key)) {
        cells.push(inRun ? "@" : "#");
      } else if (allWalls.has(key)) {
        cells.push("o");
      } else if (tile === Tile.Water) {
        cells.push("~");
      } else {
        cells.push(".");
      }
    }
    lines.push(`${String(row).padStart(3, " ")} ${cells.join("")}`);
  }
  return lines.join("\n");
}

function parseArgs(): Args {
  const args = Deno.args;
  let seed = 0;
  let round = 1;
  let player: 0 | 1 | 2 | null = null;
  let mode: "modern" | "classic" = "modern";
  for (let idx = 0; idx < args.length; idx++) {
    const arg = args[idx];
    if (arg === "--seed" && args[idx + 1]) seed = Number(args[++idx]);
    else if (arg === "--round" && args[idx + 1]) round = Number(args[++idx]);
    else if (arg === "--player" && args[idx + 1]) {
      const next = args[++idx]!.toUpperCase();
      if (next === "RED") player = 0;
      else if (next === "BLUE") player = 1;
      else if (next === "GOLD") player = 2;
    } else if (arg === "--mode" && args[idx + 1]) {
      mode = args[++idx] === "classic" ? "classic" : "modern";
    }
  }
  return { seed, round, player, mode };
}
