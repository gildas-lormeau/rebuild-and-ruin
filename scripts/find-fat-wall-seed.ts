/**
 * Find seeds where an AI player ends a WALL_BUILD with two (or more)
 * enclosed towers AND a parallel-doubled-wall RUN in their walls — a
 * visible 2×N or N×2 (N ≥ 3) segment of touching walls.
 *
 * A single 2×2 wall block is too loose: every wall corner where a
 * horizontal segment meets a vertical segment produces one, even on
 * a clean isolated ring. The user-visible "fat wall" pathology shows
 * up as a RUN — two parallel walls 1 tile apart over 3+ rows (or
 * 3+ cols), producing the ASCII pattern:
 *     ##         ####
 *     ##   or    ####
 *     ##
 *
 * That requires the doubled segment to span at least 2 consecutive 2×2
 * blocks (equivalent to a 2×3 or 3×2 all-wall rectangle).
 *
 * Usage: deno run -A scripts/find-fat-wall-seed.ts [--start N] [--tries N] [--rounds N] [--mode modern|classic]
 */

import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { GRID_COLS, GRID_ROWS } from "../src/shared/core/grid.ts";
import { packTile } from "../src/shared/core/spatial.ts";
import { createScenario } from "../test/scenario.ts";

interface CliConfig {
  start: number;
  tries: number;
  rounds: number;
  mode: "modern" | "classic";
  timeoutMsPerSeed: number;
}

/** Find parallel-doubled-wall runs in a single player's walls. A "run" is a
 *  maximal axis-aligned 2×N or N×2 all-wall rectangle with N ≥ 3 (i.e. at
 *  least two adjacent 2×2 fat blocks). Returns one entry per run with
 *  orientation, anchor (top-left), and length along the run axis.
 *
 *  Horizontal run at (r, c) length L: walls at (r..r+1, c..c+L-1).
 *  Vertical   run at (r, c) length L: walls at (r..r+L-1, c..c+1). */
interface DoubledWallRun {
  orientation: "horizontal" | "vertical";
  row: number;
  col: number;
  length: number;
}

run();

async function run(): Promise<void> {
  const config = parseArgs();
  console.log(
    `Searching seeds ${config.start}..${config.start + config.tries - 1} ` +
      `(${config.rounds} rounds, ${config.mode} mode)\n`,
  );
  const startTime = Date.now();
  const matches: {
    seed: number;
    round: number;
    playerId: number;
    fatCount: number;
  }[] = [];

  for (let offset = 0; offset < config.tries; offset++) {
    const seed = config.start + offset;
    try {
      const sc = await createScenario({
        seed,
        mode: config.mode,
        rounds: config.rounds,
      });
      let found: (typeof matches)[number] | null = null;
      sc.bus.on(GAME_EVENT.ROUND_END, () => {
        if (found) return;
        for (const player of sc.state.players) {
          if (player.eliminated) continue;
          if (player.ownedTowers.length < 2) continue;
          const runs = findDoubledWallRuns(player.walls as ReadonlySet<number>);
          if (runs.length === 0) continue;
          const longest = runs.reduce(
            (acc, run) => (run.length > acc ? run.length : acc),
            0,
          );
          found = {
            seed,
            round: sc.state.round,
            playerId: player.id,
            fatCount: longest,
          };
          return;
        }
      });
      sc.runUntil(() => found !== null, { timeoutMs: config.timeoutMsPerSeed });
      if (found) {
        matches.push(found);
        console.log(
          `  seed=${found.seed}  round=${found.round}  player=${found.playerId}  fatBlocks=${found.fatCount}`,
        );
      }
    } catch {
      // timeout / unplayable map — skip
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  if (matches.length === 0) {
    console.log(`\nNo matches in ${elapsed}s. Try --tries higher.`);
    Deno.exit(1);
  }
  console.log(`\n${matches.length} match(es) in ${elapsed}s`);
  const head = matches[0]!;
  console.log(
    `\nRecommended: seed=${head.seed}, round=${head.round}, player=${head.playerId}`,
  );
}

function findDoubledWallRuns(walls: ReadonlySet<number>): DoubledWallRun[] {
  const runs: DoubledWallRun[] = [];
  // Horizontal runs: scan each (r, r+1) row pair left-to-right, count
  // consecutive cols where both rows have a wall.
  for (let row = 0; row + 1 < GRID_ROWS; row++) {
    let runStart = -1;
    for (let col = 0; col <= GRID_COLS; col++) {
      const doubled =
        col < GRID_COLS &&
        walls.has(packTile(row, col)) &&
        walls.has(packTile(row + 1, col));
      if (doubled) {
        if (runStart < 0) runStart = col;
      } else if (runStart >= 0) {
        const length = col - runStart;
        if (length >= 3) {
          runs.push({
            orientation: "horizontal",
            row,
            col: runStart,
            length,
          });
        }
        runStart = -1;
      }
    }
  }
  // Vertical runs: scan each (c, c+1) col pair top-to-bottom.
  for (let col = 0; col + 1 < GRID_COLS; col++) {
    let runStart = -1;
    for (let row = 0; row <= GRID_ROWS; row++) {
      const doubled =
        row < GRID_ROWS &&
        walls.has(packTile(row, col)) &&
        walls.has(packTile(row, col + 1));
      if (doubled) {
        if (runStart < 0) runStart = row;
      } else if (runStart >= 0) {
        const length = row - runStart;
        if (length >= 3) {
          runs.push({
            orientation: "vertical",
            row: runStart,
            col,
            length,
          });
        }
        runStart = -1;
      }
    }
  }
  return runs;
}

function parseArgs(): CliConfig {
  const args = Deno.args;
  let start = 0;
  let tries = 200;
  let rounds = 4;
  let mode: "modern" | "classic" = "modern";
  let timeoutMsPerSeed = 480_000;
  for (let idx = 0; idx < args.length; idx++) {
    const arg = args[idx];
    if (arg === "--start" && args[idx + 1]) start = Number(args[++idx]);
    else if (arg === "--tries" && args[idx + 1]) tries = Number(args[++idx]);
    else if (arg === "--rounds" && args[idx + 1]) rounds = Number(args[++idx]);
    else if (arg === "--mode" && args[idx + 1]) {
      mode = args[++idx] === "classic" ? "classic" : "modern";
    } else if (arg === "--timeout-ms" && args[idx + 1]) {
      timeoutMsPerSeed = Number(args[++idx]);
    }
  }
  return { start, tries, rounds, mode, timeoutMsPerSeed };
}
