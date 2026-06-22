/**
 * Grunt tracker — follows grunts across consecutive build frames and produces:
 *   1) the step-vector histogram (empirical movement-direction constraints),
 *   2) full per-grunt trajectories (the routes), and
 *   3) a per-step transition dataset + per-frame boards, saved to disk, for the
 *      path-rule scorer (which board each move reacted to is what cracks pathing).
 *
 * Input is the BUILD2D frame set from rampart-filter.ts; its phases.json gives
 * the original frame numbering, so consecutive numbers = same build episode and a
 * gap = a battle in between (we never track a "move" across a gap).
 *
 * Usage: deno run -A scripts/rampart-track.ts <framesDir>
 */

import { decodeRGB } from "./rampart-phase.ts";
import {
  type Board,
  type Grunt,
  loadTemplates,
  reconstruct,
  type Tower,
} from "./rampart-recon.ts";

interface Transition {
  frame: number;
  from: [number, number];
  to: [number, number];
  facing: Grunt["dir"];
}

const GATE = 4;
const frameNum = (name: string) => Number(name.match(/(\d+)/)![1]);
const pad4 = (n: number) => String(n).padStart(4, "0");

if (import.meta.main) await main();

async function main() {
  const dir = Deno.args[0];
  if (!dir) {
    console.error("usage: deno run -A scripts/rampart-track.ts <framesDir>");
    Deno.exit(2);
  }
  const phases = JSON.parse(await Deno.readTextFile(`${dir}/phases.json`));
  const labeled: number[] = phases.frames
    .filter((f: { phase: string }) => f.phase === "BUILD2D")
    .map((f: { frame: string }) => frameNum(f.frame))
    .sort((x: number, y: number) => x - y);

  // reconstruct every build frame (concurrent decode+recon); a frame whose PNG
  // was deleted is skipped (it drops out of the build set, splitting its episode).
  const templates = await loadTemplates();
  const boards = new Map<number, Board>();
  const missing = new Set<number>();
  await mapPool(labeled, 8, async (n) => {
    try {
      const { px } = await decodeRGB(`${dir}/frame_${pad4(n)}.png`);
      boards.set(n, reconstruct(px, templates));
    } catch {
      missing.add(n);
    }
  });
  const build = labeled.filter((n) => !missing.has(n));
  if (missing.size) {
    console.log(
      `# skipped ${missing.size} BUILD2D frames with no decodable PNG`,
    );
  }

  // build episodes = runs of consecutive frame numbers
  const episodes: number[][] = [];
  let cur: number[] = [];
  for (const n of build) {
    if (cur.length && n !== cur[cur.length - 1] + 1) {
      episodes.push(cur);
      cur = [];
    }
    cur.push(n);
  }
  if (cur.length) episodes.push(cur);

  // track within episodes -> transitions + trajectories + step histogram
  const hist = new Map<string, number>();
  const transitions: Transition[] = [];
  const trajectories: {
    frames: number[];
    pts: [number, number][];
    dirs: string[];
  }[] = [];

  for (const ep of episodes) {
    // active tracks indexed into `trajectories`
    let active: { idx: number; gruntIdx: number }[] = [];
    const gruntsAt = (n: number) => boards.get(n)!.grunts;
    // seed from first frame
    for (let j = 0; j < gruntsAt(ep[0]).length; j++) {
      const g = gruntsAt(ep[0])[j];
      trajectories.push({ frames: [ep[0]], pts: [[g.r, g.c]], dirs: [g.dir] });
      active.push({ idx: trajectories.length - 1, gruntIdx: j });
    }
    for (let i = 0; i + 1 < ep.length; i++) {
      const a = gruntsAt(ep[i]),
        b = gruntsAt(ep[i + 1]);
      const matches = matchGrunts(a, b);
      const matchByA = new Map(matches.map(([ai, bi]) => [ai, bi]));
      const nextActive: { idx: number; gruntIdx: number }[] = [];
      const matchedB = new Set<number>();
      for (const t of active) {
        const bi = matchByA.get(t.gruntIdx);
        if (bi === undefined) continue; // track ends
        const ga = a[t.gruntIdx],
          gb = b[bi];
        const dr = gb.r - ga.r,
          dc = gb.c - ga.c;
        hist.set(`${dr},${dc}`, (hist.get(`${dr},${dc}`) ?? 0) + 1);
        transitions.push({
          frame: ep[i],
          from: [ga.r, ga.c],
          to: [gb.r, gb.c],
          facing: ga.dir,
        });
        const traj = trajectories[t.idx];
        traj.frames.push(ep[i + 1]);
        traj.pts.push([gb.r, gb.c]);
        traj.dirs.push(gb.dir);
        nextActive.push({ idx: t.idx, gruntIdx: bi });
        matchedB.add(bi);
      }
      // new grunts appearing mid-episode start fresh tracks
      for (let j = 0; j < b.length; j++) {
        if (matchedB.has(j)) continue;
        const g = b[j];
        trajectories.push({
          frames: [ep[i + 1]],
          pts: [[g.r, g.c]],
          dirs: [g.dir],
        });
        nextActive.push({ idx: trajectories.length - 1, gruntIdx: j });
      }
      active = nextActive;
    }
  }

  // ---- report ----
  const detections = build.reduce(
    (s, n) => s + boards.get(n)!.grunts.length,
    0,
  );
  console.log(
    `# frames=${build.length} episodes=${episodes.length} grunt-detections=${detections}`,
  );
  console.log(
    `# transitions (consecutive-frame grunt moves)=${transitions.length}`,
  );

  const classify = (dr: number, dc: number) =>
    dr === 0 && dc === 0
      ? "still"
      : dr === 0 || dc === 0
        ? "orthogonal"
        : Math.abs(dr) === Math.abs(dc)
          ? "diagonal45"
          : "shallow";
  const classCount: Record<string, number> = {};
  let maxDr = 0,
    maxDc = 0;
  console.log("\n# step-vector histogram (Δrow,Δcol : count : class)");
  for (const [k, n] of [...hist.entries()].sort((x, y) => y[1] - x[1])) {
    const [dr, dc] = k.split(",").map(Number);
    const cls = classify(dr, dc);
    classCount[cls] = (classCount[cls] ?? 0) + n;
    maxDr = Math.max(maxDr, Math.abs(dr));
    maxDc = Math.max(maxDc, Math.abs(dc));
    console.log(`  (${dr},${dc}) : ${n} : ${cls}`);
  }
  console.log(`\n# by class: ${JSON.stringify(classCount)}`);
  console.log(`# max |Δrow|=${maxDr} |Δcol|=${maxDc} (GATE=${GATE})`);
  const moved = Object.entries(classCount)
    .filter(([c]) => c !== "still")
    .reduce((s, [, n]) => s + n, 0);
  const diag = (classCount.diagonal45 ?? 0) + (classCount.shallow ?? 0);
  console.log(
    `# of ${moved} actual moves: ${classCount.orthogonal ?? 0} orthogonal, ${diag} diagonal ` +
      `(${moved ? Math.round((100 * diag) / moved) : 0}%)`,
  );

  // longest trajectories (the routes worth studying)
  const longest = trajectories
    .map((t) => ({
      ...t,
      span:
        Math.abs(t.pts[0][0] - t.pts.at(-1)![0]) +
        Math.abs(t.pts[0][1] - t.pts.at(-1)![1]),
    }))
    .filter((t) => t.pts.length >= 3 && t.span >= 3)
    .sort((x, y) => y.span - x.span)
    .slice(0, 8);
  console.log(
    `\n# top ${longest.length} traveling grunts (net displacement >=3):`,
  );
  for (const t of longest) {
    const path = t.pts.map(([r, c]) => `(${r},${c})`).join("->");
    console.log(
      `  f${t.frames[0]}..f${t.frames.at(-1)} net=${t.span} dirs=${t.dirs.join("")}`,
    );
    console.log(`    ${path}`);
  }

  // ---- save dataset for the path-rule scorer ----
  const boardDump: Record<
    number,
    {
      towers: Tower[];
      homes: Record<string, [number, number]>;
      blocked: [number, number][];
      houses: [number, number][];
    }
  > = {};
  for (const n of build) {
    const board = boards.get(n)!;
    boardDump[n] = {
      towers: board.towers,
      homes: board.homes,
      blocked: blockedTiles(board),
      houses: board.houses,
    };
  }
  await Deno.writeTextFile(
    `${dir}/grunt-transitions.json`,
    JSON.stringify(transitions),
  );
  await Deno.writeTextFile(
    `${dir}/grunt-boards.json`,
    JSON.stringify(boardDump),
  );
  const trajOut = trajectories.filter((t) => t.pts.length >= 2);
  await Deno.writeTextFile(
    `${dir}/grunt-trajectories.json`,
    JSON.stringify(trajOut),
  );
  console.log(
    `\nsaved grunt-transitions.json (${transitions.length} moves), grunt-boards.json, ` +
      `grunt-trajectories.json (${trajOut.length} tracks) in ${dir}/`,
  );
}

async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (x: T, i: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

// min-cost greedy matching (avoids swapping adjacent grunts): pairs sorted by
// Manhattan distance, each grunt used once, within GATE.
function matchGrunts(a: Grunt[], b: Grunt[]): [number, number][] {
  const pairs: [number, number, number][] = [];
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const d = Math.abs(a[i].r - b[j].r) + Math.abs(a[i].c - b[j].c);
      if (d <= GATE) pairs.push([d, i, j]);
    }
  }
  pairs.sort((x, y) => x[0] - y[0]);
  const ua = new Set<number>(),
    ub = new Set<number>(),
    out: [number, number][] = [];
  for (const [, i, j] of pairs) {
    if (!ua.has(i) && !ub.has(j)) {
      ua.add(i);
      ub.add(j);
      out.push([i, j]);
    }
  }
  return out;
}

function blockedTiles(board: Board): [number, number][] {
  const blocked: [number, number][] = [...board.water];
  for (const ws of Object.values(board.walls)) blocked.push(...ws);
  return blocked;
}
