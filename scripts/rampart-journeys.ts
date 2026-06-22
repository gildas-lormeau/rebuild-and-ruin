/**
 * Cross-episode grunt journey stitcher (gives every grunt a stable id).
 *
 * Grunts are frozen during BATTLE (game rule: they tick only in WALL_BUILD), so
 * a grunt's position at the LAST build frame of an episode equals its position at
 * the FIRST build frame of the next. We take the within-episode tracks from
 * rampart-track.ts (grunt-trajectories.json) and bridge those battle gaps by
 * near-exact position match, producing full-lifetime journeys with a stable id,
 * the episodes they span, and birth/death frames.
 *
 * Usage: deno run -A scripts/rampart-journeys.ts <framesDir> [<framesDir> ...]
 * Writes <dir>/grunt-journeys.json per dir.
 */

type Traj = { frames: number[]; pts: [number, number][]; dirs: string[] };

type Journey = {
  id: number;
  frames: number[];
  pts: [number, number][];
  dirs: string[];
  episodes: number[];
  birthFrame: number;
  deathFrame: number;
  spans: number; // # of build episodes the journey touches
};

const STITCH_GATE = 1;
// frozen across the battle => near-exact position
const frameNum = (name: string) => Number(name.match(/(\d+)/)![1]);
const manh = (a: [number, number], b: [number, number]) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

if (import.meta.main) await main();

async function main() {
  const dirs = Deno.args;
  if (!dirs.length) {
    console.error(
      "usage: deno run -A scripts/rampart-journeys.ts <framesDir> [...]",
    );
    Deno.exit(2);
  }
  for (const dir of dirs) await processDir(dir);
}

async function processDir(dir: string) {
  const phases = JSON.parse(await Deno.readTextFile(`${dir}/phases.json`));
  const build: number[] = phases.frames
    .filter((f: { phase: string }) => f.phase === "BUILD2D")
    .map((f: { frame: string }) => frameNum(f.frame))
    .sort((a: number, b: number) => a - b);
  const episodes = toEpisodes(build);
  const epOf = new Map<number, number>();
  episodes.forEach((ep, e) => ep.forEach((n) => epOf.set(n, e)));
  const firstOf = episodes.map((ep) => ep[0]);
  const lastOf = episodes.map((ep) => ep[ep.length - 1]);

  const trajs: Traj[] = JSON.parse(
    await Deno.readTextFile(`${dir}/grunt-trajectories.json`),
  );
  const trajEp = trajs.map((t) => epOf.get(t.frames[0]) ?? -1);

  // union-find over trajectory indices; bridges connect episodes
  const parent = trajs.map((_, i) => i);
  const find = (x: number): number =>
    parent[x] === x ? x : (parent[x] = find(parent[x]));
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };

  let bridges = 0;
  for (let e = 0; e + 1 < episodes.length; e++) {
    const enders: number[] = [];
    const starters: number[] = [];
    trajs.forEach((t, i) => {
      if (trajEp[i] === e && t.frames[t.frames.length - 1] === lastOf[e]) {
        enders.push(i);
      }
      if (trajEp[i] === e + 1 && t.frames[0] === firstOf[e + 1]) {
        starters.push(i);
      }
    });
    const endPos = enders.map((i) => trajs[i].pts[trajs[i].pts.length - 1]);
    const startPos = starters.map((i) => trajs[i].pts[0]);
    for (const [ai, bi] of matchByPos(endPos, startPos)) {
      union(enders[ai], starters[bi]);
      bridges++;
    }
  }

  // group trajectory segments by journey root, concat in frame order
  const groups = new Map<number, number[]>();
  for (let i = 0; i < trajs.length; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }

  const journeys: Journey[] = [];
  let id = 0;
  for (const idxs of groups.values()) {
    const segs = idxs
      .map((i) => trajs[i])
      .sort((a, b) => a.frames[0] - b.frames[0]);
    const frames: number[] = [];
    const pts: [number, number][] = [];
    const dirs: string[] = [];
    for (const s of segs) {
      frames.push(...s.frames);
      pts.push(...s.pts);
      dirs.push(...s.dirs);
    }
    const eps = [...new Set(idxs.map((i) => trajEp[i]))].sort((a, b) => a - b);
    journeys.push({
      id: id++,
      frames,
      pts,
      dirs,
      episodes: eps,
      birthFrame: frames[0],
      deathFrame: frames[frames.length - 1],
      spans: eps.length,
    });
  }

  await Deno.writeTextFile(
    `${dir}/grunt-journeys.json`,
    JSON.stringify(journeys),
  );
  report(dir, episodes.length, trajs.length, bridges, journeys);
}

function toEpisodes(build: number[]): number[][] {
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
  return episodes;
}

// min-cost greedy matching of end positions to start positions (each used once)
function matchByPos(
  a: [number, number][],
  b: [number, number][],
): [number, number][] {
  const pairs: [number, number, number][] = [];
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const d = manh(a[i], b[j]);
      if (d <= STITCH_GATE) pairs.push([d, i, j]);
    }
  }
  pairs.sort((x, y) => x[0] - y[0]);
  const ua = new Set<number>();
  const ub = new Set<number>();
  const out: [number, number][] = [];
  for (const [, i, j] of pairs) {
    if (!ua.has(i) && !ub.has(j)) {
      ua.add(i);
      ub.add(j);
      out.push([i, j]);
    }
  }
  return out;
}

function report(
  dir: string,
  episodes: number,
  trajCount: number,
  bridges: number,
  journeys: Journey[],
) {
  const multi = journeys.filter((j) => j.spans > 1);
  const longest = [...journeys]
    .sort((a, b) => b.frames.length - a.frames.length)
    .slice(0, 5);
  console.log(`\n# ${dir}`);
  console.log(
    `  episodes=${episodes} segments=${trajCount} bridges=${bridges} ` +
      `=> journeys=${journeys.length} (multi-episode=${multi.length})`,
  );
  console.log(`  longest journeys (frames spanning episodes):`);
  for (const j of longest) {
    const a = j.pts[0];
    const z = j.pts[j.pts.length - 1];
    console.log(
      `    #${j.id} eps[${j.episodes.join(",")}] f${j.birthFrame}..${j.deathFrame} ` +
        `len=${j.frames.length} (${a[0]},${a[1]})->(${z[0]},${z[1]})`,
    );
  }
}
