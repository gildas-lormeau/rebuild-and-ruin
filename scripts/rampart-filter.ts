/**
 * Classify every frame in a folder and discard the "invalid" (non-analyzable)
 * ones, keeping only the build/cannon phase (BUILD2D) used for board analysis.
 *
 * "Extracts the data": writes <dir>/phases.json with the phase of EVERY frame
 * (the full phase timeline is preserved even after the invalid PNGs are deleted,
 * so nothing is lost). "Discards invalid frames": removes the PNGs that are not
 * the keep-phase (battle, transition, game-over, menu, high-score).
 *
 * Operates purely on the frame files via ffmpeg decode — never reads the screen.
 *
 * Usage:
 *   deno run -A scripts/rampart-filter.ts <framesDir> [keepPhase=BUILD2D]
 */

import { classify, decodeRGB, type Phase } from "./rampart-phase.ts";

if (import.meta.main) await main();

async function main() {
  const dir = Deno.args[0];
  const keep = (Deno.args[1] as Phase) ?? "BUILD2D";
  if (!dir) {
    console.error(
      "usage: deno run -A scripts/rampart-filter.ts <framesDir> [keepPhase=BUILD2D]",
    );
    Deno.exit(2);
  }

  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".png")) files.push(entry.name);
  }
  files.sort();
  if (files.length === 0) {
    console.error(`no .png frames in ${dir}`);
    Deno.exit(1);
  }

  const phases = await mapPool(files, 8, async (name) => {
    const { px, width, height } = await decodeRGB(`${dir}/${name}`);
    return classify(px, width, height);
  });

  // extracted data: phase of every frame (preserved before any deletion)
  const counts: Record<string, number> = {};
  for (const phase of phases) counts[phase] = (counts[phase] ?? 0) + 1;
  const records = files.map((frame, i) => ({ frame, phase: phases[i] }));
  await Deno.writeTextFile(
    `${dir}/phases.json`,
    JSON.stringify(
      { keep, total: files.length, counts, frames: records },
      null,
      2,
    ),
  );

  // discard invalid frames (everything that isn't the keep-phase)
  let discarded = 0;
  for (let i = 0; i < files.length; i++) {
    if (phases[i] !== keep) {
      await Deno.remove(`${dir}/${files[i]}`);
      discarded++;
    }
  }

  console.log(`classified ${files.length} frames: ${JSON.stringify(counts)}`);
  console.log(
    `kept ${files.length - discarded} ${keep}, discarded ${discarded} invalid -> ${dir}/`,
  );
  console.log(`data: ${dir}/phases.json`);
}

/** Run `fn` over `items` with at most `limit` concurrent in flight. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}
