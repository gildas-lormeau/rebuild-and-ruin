/**
 * Fat-wall metric — quantifies the "fat wall" pathology that the AI-build
 * comparison metrics (score / lives / enclosures) do NOT capture. Runs a seed
 * matrix headless to a fixed round and counts, per player, the number of 2×2
 * all-wall blocks in the final wall set (the doubled-wall signature). Reports
 * the fat-block density (blocks per 100 wall tiles) so wall-count differences
 * between code versions don't skew the comparison.
 *
 * Usage:
 *   deno run -A scripts/fat-wall-metric.ts [--rounds N] [--seeds a,b,c]
 *
 * Run it once on the current tree and once in a baseline worktree, then diff
 * the "fat/100w" aggregate — that is the direct measure of whether a change
 * actually reduces fat walls.
 */

import { GRID_COLS, GRID_ROWS, type TileKey } from "../src/shared/core/grid.ts";
import { computeOutside, packTile } from "../src/shared/core/spatial.ts";
import { createScenario } from "../test/scenario.ts";

await main();

async function main(): Promise<void> {
  const { rounds, seeds } = parseArgs(Deno.args);
  let totFat = 0;
  let totBuried = 0;
  let totWalls = 0;
  console.log(
    `fat-wall metric: ${seeds.length} seeds × ${rounds} rounds, modern`,
  );
  console.log(
    "buried = 2×2 all-wall block whose tiles touch NO outside tile (an internal\n" +
      "divider — the wasteful pathology, isolated from legit perimeter thickness).\n",
  );
  console.log(
    "seed       | per-player buried/fat/walls          | seed bur/100w",
  );
  console.log("-".repeat(68));
  for (const seed of seeds) {
    using sc = await createScenario({ seed, mode: "modern", rounds });
    sc.runGame({ timeoutMs: 900_000 });
    let seedFat = 0;
    let seedBuried = 0;
    let seedWalls = 0;
    const parts: string[] = [];
    for (const player of sc.state.players) {
      if (player.walls.size === 0) {
        parts.push("--");
        continue;
      }
      const { fat, buried } = countFatBlocks(player.walls);
      parts.push(`${buried}/${fat}/${player.walls.size}`);
      seedFat += fat;
      seedBuried += buried;
      seedWalls += player.walls.size;
    }
    totFat += seedFat;
    totBuried += seedBuried;
    totWalls += seedWalls;
    const ratio = seedWalls > 0 ? (seedBuried / seedWalls) * 100 : 0;
    console.log(
      `${String(seed).padEnd(10)} | ${parts.join("  ").padEnd(36)} | ${ratio.toFixed(1)}`,
    );
  }
  console.log("-".repeat(68));
  const burRatio = totWalls > 0 ? (totBuried / totWalls) * 100 : 0;
  const fatRatio = totWalls > 0 ? (totFat / totWalls) * 100 : 0;
  console.log(
    `AGG: ${totBuried} buried / ${totFat} fat / ${totWalls} walls  =  ${burRatio.toFixed(2)} buried/100w  (${fatRatio.toFixed(2)} fat/100w)`,
  );
}

/** Count 2×2 all-wall blocks. `fat` = every such block; `buried` = blocks
 *  none of whose 4 tiles touch an outside (perimeter) tile — internal
 *  dividers, the wasteful pathology, distinct from load-bearing perimeter
 *  thickness which the coarse `fat` count can't separate. */
function countFatBlocks(walls: ReadonlySet<TileKey>): {
  fat: number;
  buried: number;
} {
  const outside = computeOutside(walls);
  const touchesOutside = (r: number, c: number): boolean => {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        // Map border = outside (flood-fill origin). A block tile on the very
        // edge is on the perimeter by definition, so an out-of-bounds neighbor
        // counts as touching outside.
        if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) return true;
        if (outside.has(packTile(nr, nc))) return true;
      }
    }
    return false;
  };
  let fat = 0;
  let buried = 0;
  for (let r = 0; r < GRID_ROWS - 1; r++) {
    for (let c = 0; c < GRID_COLS - 1; c++) {
      if (
        walls.has(packTile(r, c)) &&
        walls.has(packTile(r, c + 1)) &&
        walls.has(packTile(r + 1, c)) &&
        walls.has(packTile(r + 1, c + 1))
      ) {
        fat++;
        const anyTouchesOutside =
          touchesOutside(r, c) ||
          touchesOutside(r, c + 1) ||
          touchesOutside(r + 1, c) ||
          touchesOutside(r + 1, c + 1);
        if (!anyTouchesOutside) buried++;
      }
    }
  }
  return { fat, buried };
}

function parseArgs(argv: readonly string[]): {
  rounds: number;
  seeds: number[];
} {
  let rounds = 8;
  let seeds = [1, 7, 42, 99, 256, 287751, 555555, 693378, 31337, 80085];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--rounds") rounds = Number.parseInt(argv[++i]!, 10);
    else if (argv[i] === "--seeds")
      seeds = argv[++i]!.split(",").map((s) => Number.parseInt(s, 10));
  }
  return { rounds, seeds };
}
