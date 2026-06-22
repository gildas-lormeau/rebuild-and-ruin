/**
 * Recon data-quality validator. Checks two physical invariants of the game that
 * a clean reconstruction must satisfy, and reports where they break (= recon
 * misses / false detections that would poison the movement analysis):
 *
 *   1. Grunts never disappear except on a zone reset (life lost). A zone reset
 *      only happens between rounds, never inside one build episode — so WITHIN an
 *      episode the grunt count must be non-decreasing (new grunts may spawn). A
 *      frame-to-frame DROP means recon lost a grunt it had a moment ago.
 *   2. Houses are static board features; they never appear or vanish mid-game. So
 *      within an episode the house count must be CONSTANT. Any change is recon
 *      flicker (the known house over-detection).
 *
 * Usage: deno run -A scripts/rampart-validate.ts <framesDir> [<framesDir> ...]
 */

import { decodeRGB } from "./rampart-phase.ts";
import { type Board, loadTemplates, reconstruct } from "./rampart-recon.ts";

type Counts = { grunts: number; houses: number; towers: number };

const frameNum = (name: string) => Number(name.match(/(\d+)/)![1]);
const pad4 = (n: number) => String(n).padStart(4, "0");

if (import.meta.main) await main();

async function main() {
  const dirs = Deno.args;
  if (!dirs.length) {
    console.error(
      "usage: deno run -A scripts/rampart-validate.ts <framesDir> [...]",
    );
    Deno.exit(2);
  }
  const templates = await loadTemplates();
  for (const dir of dirs) await validateDir(dir, templates);
}

async function validateDir(
  dir: string,
  templates: Awaited<ReturnType<typeof loadTemplates>>,
) {
  const phases = JSON.parse(await Deno.readTextFile(`${dir}/phases.json`));
  const build: number[] = phases.frames
    .filter((f: { phase: string }) => f.phase === "BUILD2D")
    .map((f: { frame: string }) => frameNum(f.frame))
    .sort((a: number, b: number) => a - b);

  const counts = new Map<number, Counts>();
  await mapPool(build, 8, async (n) => {
    try {
      const { px } = await decodeRGB(`${dir}/frame_${pad4(n)}.png`);
      counts.set(n, countOf(reconstruct(px, templates)));
    } catch {
      /* deleted frame */
    }
  });

  const present = build.filter((n) => counts.has(n));
  const episodes = toEpisodes(present);
  let gruntDrops = 0;
  let gruntDropMag = 0;
  let houseFlickerFrames = 0;
  let houseSpread = 0;
  const worstGrunt: string[] = [];
  let hMin = Infinity;
  let hMax = 0;
  for (const ep of episodes) {
    const hs = ep.map((n) => counts.get(n)!.houses);
    const epMin = Math.min(...hs);
    const epMax = Math.max(...hs);
    hMin = Math.min(hMin, epMin);
    hMax = Math.max(hMax, epMax);
    houseSpread = Math.max(houseSpread, epMax - epMin);
    for (let i = 0; i + 1 < ep.length; i++) {
      const a = counts.get(ep[i])!;
      const b = counts.get(ep[i + 1])!;
      if (b.grunts < a.grunts) {
        gruntDrops++;
        gruntDropMag += a.grunts - b.grunts;
        if (worstGrunt.length < 6) {
          worstGrunt.push(
            `f${ep[i]}->f${ep[i + 1]} grunts ${a.grunts}->${b.grunts}`,
          );
        }
      }
      if (b.houses !== a.houses) houseFlickerFrames++;
    }
  }
  const steps = present.length - episodes.length;
  console.log(`\n=== ${dir.split("/").pop()} ===`);
  console.log(
    `  frames=${present.length} episodes=${episodes.length} intra-episode steps=${steps}`,
  );
  console.log(
    `  GRUNT drops (disappearances): ${gruntDrops}/${steps} steps ` +
      `(${pctOf(gruntDrops, steps)}), total grunts lost=${gruntDropMag}`,
  );
  for (const w of worstGrunt) console.log(`      ${w}`);
  console.log(
    `  HOUSE flicker: ${houseFlickerFrames}/${steps} steps changed ` +
      `(${pctOf(houseFlickerFrames, steps)}); count range ${hMin}..${hMax}, ` +
      `worst intra-episode spread=${houseSpread}`,
  );
}

function countOf(board: Board): Counts {
  return {
    grunts: board.grunts.length,
    houses: board.houses.length,
    towers: board.towers.filter((t) => t.state === "alive").length,
  };
}

function toEpisodes(frames: number[]): number[][] {
  const episodes: number[][] = [];
  let cur: number[] = [];
  for (const n of frames) {
    if (cur.length && n !== cur[cur.length - 1] + 1) {
      episodes.push(cur);
      cur = [];
    }
    cur.push(n);
  }
  if (cur.length) episodes.push(cur);
  return episodes;
}

function pctOf(n: number, d: number): string {
  return `${d ? Math.round((100 * n) / d) : 0}%`;
}

async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (x: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}
