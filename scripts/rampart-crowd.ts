// Group / crowd dynamics of grunts, reverse-engineered from recorded DOS Rampart.
//
// Hypotheses under test (from observed play):
//   (A) "Group dance": when 4+ grunts pack against a wall section and start
//       blocking each other, individual grunts move AWAY from their target far
//       more often than a lone grunt does.
//   (B) Circling: a blocked grunt orbits a sealed castle rather than paces in
//       place, and the orbit has a consistent rotational sign within a jam.
//
// Inputs (per game): grunt-journeys.json (stitched lifetimes) and
// grunt-boards.json (per-frame {towers, homes, blocked, houses}). No recon here
// — we reuse the already-reconstructed boards so this stays cheap.
//
// NOTE: the whole pipeline runs inside main() on purpose — biome hoists
// top-level `const X = arr.filter(...)` above the loop that fills `arr`
// (see memory: "biome const hoist"). Keeping it in a function preserves order.

type Tower = { r: number; c: number; state: "alive" | "dead" };

type Board = {
  towers: Tower[];
  homes: Record<string, [number, number]>;
  blocked: [number, number][];
  houses: [number, number][];
};

type Journey = {
  id: number;
  frames: number[];
  pts: [number, number][];
  dirs: string[];
  birthFrame: number;
};

type Step = {
  game: string;
  id: number;
  frame: number;
  from: [number, number];
  to: [number, number];
  target: Tower;
  delta: number; // distFp(to) - distFp(from): <0 toward, >0 away, 0 lateral
  crowd: boolean;
  clusterSize: number;
  // why this move was (or wasn't) greedy-toward the target:
  //   greedy  = stepped to a tile that reduces distance
  //   terrain = all toward-tiles blocked by wall/water/house/tower
  //   grunt   = all toward-tiles blocked, >=1 by ANOTHER GRUNT (group deflection)
  //   pace    = a toward-tile was free, but it returned to a recent tile (oscillation)
  //   free    = a toward-tile was free and it went elsewhere anyway (unexplained)
  //   at-tgt  = already adjacent; no toward-tile exists
  defl: "greedy" | "terrain" | "grunt" | "pace" | "free" | "at-tgt";
};

type Orbit = {
  game: string;
  id: number;
  target: Tower;
  deg: number;
  steps: number;
  net: number;
};

// a maximal run of consecutive moves with a barrier (wall/water/house) kept
// orthogonally adjacent — the substrate of "going around" a castle.
type TurnRun = {
  game: string;
  id: number;
  len: number;
  left: number; // CCW corner turns
  right: number; // CW corner turns
  uturn: number; // 180 reversals ("turned around at the wall")
};

const ROWS = 25,
  COLS = 40;
const inb = (r: number, c: number) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
const fp = (r: number, c: number) =>
  [
    [r, c],
    [r, c + 1],
    [r + 1, c],
    [r + 1, c + 1],
  ] as [number, number][];
// distance to nearest tile of the 2x2 tower footprint (matches port spatial.ts)
const distFp = (p: [number, number], t: { r: number; c: number }) =>
  Math.min(
    ...fp(t.r, t.c).map(([y, x]) => Math.abs(p[0] - y) + Math.abs(p[1] - x)),
  );
const N4: [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];
const GAMES = [
  "003",
  "004",
  "005",
  "006",
  "007",
  "008",
  "009",
  "010",
  "011",
  "013",
  "014",
  "015",
  "016",
  "017",
];
const CROWD_MIN = 4;
// grunts to call it a crowd
const PACK_DIST = 3;
// mutual Manhattan distance to be in the same cluster
const WALL_NEAR = 2;

await main();

async function main() {
  const allSteps: Step[] = [];
  const orbits: Orbit[] = [];
  const turnRuns: TurnRun[] = [];

  for (const g of GAMES) {
    let journeys: Journey[], boards: Record<string, Board>;
    try {
      journeys = JSON.parse(
        await Deno.readTextFile(`tmp/frames/rampart_${g}/grunt-journeys.json`),
      );
      boards = JSON.parse(
        await Deno.readTextFile(`tmp/frames/rampart_${g}/grunt-boards.json`),
      );
    } catch {
      continue;
    }

    // lock each grunt's target: nearest ALIVE tower at its birth frame
    const target = new Map<number, Tower>();
    for (const j of journeys) {
      const b = boards[String(j.birthFrame)] ?? boards[String(j.frames[0])];
      if (!b) continue;
      const alive = b.towers.filter((t) => t.state === "alive");
      if (!alive.length) continue;
      let best = alive[0],
        bd = distFp(j.pts[0], best);
      for (const t of alive) {
        const d = distFp(j.pts[0], t);
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
      target.set(j.id, best);
    }

    // per-frame grunt index { id, pos } from journeys
    const frameGrunts = new Map<
      number,
      { id: number; pos: [number, number] }[]
    >();
    for (const j of journeys) {
      for (let i = 0; i < j.frames.length; i++) {
        const f = j.frames[i];
        if (!frameGrunts.has(f)) frameGrunts.set(f, []);
        frameGrunts.get(f)!.push({ id: j.id, pos: j.pts[i] });
      }
    }

    // per frame: which grunt ids sit in a wall-adjacent crowd, and the cluster size
    const crowdOf = new Map<number, Map<number, number>>();
    for (const [f, gs] of frameGrunts) {
      const b = boards[String(f)];
      if (!b) continue;
      const wallTiles = new Set(
        b.blocked.concat(b.houses).map(([r, c]) => `${r},${c}`),
      );
      const pos = gs.map((x) => x.pos);
      const m = new Map<number, number>();
      for (const cl of clusterize(pos)) {
        if (cl.length < CROWD_MIN) continue;
        const nearWall = cl.some((idx) => {
          const [r, c] = pos[idx];
          for (let dr = -WALL_NEAR; dr <= WALL_NEAR; dr++)
            for (let dc = -WALL_NEAR; dc <= WALL_NEAR; dc++)
              if (
                Math.abs(dr) + Math.abs(dc) <= WALL_NEAR &&
                wallTiles.has(`${r + dr},${c + dc}`)
              )
                return true;
          return false;
        });
        if (!nearWall) continue;
        for (const idx of cl) m.set(gs[idx].id, cl.length);
      }
      crowdOf.set(f, m);
    }

    // per-frame occupancy (all grunt tiles) + blocked-set cache for deflection
    const occ = new Map<number, Set<string>>();
    for (const [f, gs] of frameGrunts)
      occ.set(f, new Set(gs.map((x) => `${x.pos[0]},${x.pos[1]}`)));
    const blkCache = new Map<number, Set<string>>();
    const blkAt = (f: number): Set<string> | null => {
      if (blkCache.has(f)) return blkCache.get(f)!;
      const b = boards[String(f)];
      if (!b) return null;
      const s = blockedSet(b);
      blkCache.set(f, s);
      return s;
    };
    // barriers a grunt would "follow": walls + water + houses (NOT towers)
    const barrCache = new Map<number, Set<string>>();
    const barrAt = (f: number): Set<string> | null => {
      if (barrCache.has(f)) return barrCache.get(f)!;
      const b = boards[String(f)];
      if (!b) return null;
      const s = new Set<string>();
      for (const [r, c] of b.blocked) s.add(`${r},${c}`);
      for (const [r, c] of b.houses) s.add(`${r},${c}`);
      barrCache.set(f, s);
      return s;
    };
    const barrierAdj = (p: [number, number], f: number): boolean => {
      const bs = barrAt(f);
      if (!bs) return false;
      return N4.some(([dr, dc]) => bs.has(`${p[0] + dr},${p[1] + dc}`));
    };

    // build steps + orbit accumulation
    for (const j of journeys) {
      const t = target.get(j.id);
      if (!t) continue;
      let cum = 0,
        prevAng: number | null = null,
        netDelta = 0;
      const recent: string[] = []; // last few tiles, for pace/oscillation detection
      // barrier-follow run state
      let run: TurnRun | null = null;
      let prevHead: [number, number] | null = null;
      const closeRun = () => {
        if (run && run.len >= 3) turnRuns.push(run);
        run = null;
        prevHead = null;
      };
      for (let i = 0; i + 1 < j.frames.length; i++) {
        const from = j.pts[i],
          to = j.pts[i + 1];
        recent.push(`${from[0]},${from[1]}`);
        if (recent.length > 4) recent.shift();
        if (from[0] === to[0] && from[1] === to[1]) {
          closeRun();
          continue;
        } // no move this frame
        // barrier-follow turn accounting
        if (barrierAdj(from, j.frames[i])) {
          const head: [number, number] = [to[0] - from[0], to[1] - from[1]];
          if (!run)
            run = { game: g, id: j.id, len: 0, left: 0, right: 0, uturn: 0 };
          run.len++;
          if (prevHead) {
            const cross = prevHead[0] * head[1] - prevHead[1] * head[0];
            const reversed =
              prevHead[0] === -head[0] && prevHead[1] === -head[1];
            if (cross > 0) run.left++;
            else if (cross < 0) run.right++;
            else if (reversed) run.uturn++;
          }
          prevHead = head;
        } else {
          closeRun();
        }
        const delta = distFp(to, t) - distFp(from, t);
        const sz = crowdOf.get(j.frames[i])?.get(j.id) ?? 0;
        const defl = classifyDefl(
          from,
          to,
          t,
          blkAt(j.frames[i]),
          occ.get(j.frames[i]),
          recent,
        );
        allSteps.push({
          game: g,
          id: j.id,
          frame: j.frames[i],
          from,
          to,
          target: t,
          delta,
          crowd: sz >= CROWD_MIN,
          clusterSize: sz,
          defl,
        });
        netDelta += delta;
        const cy = t.r + 0.5,
          cx = t.c + 0.5;
        const ang = (Math.atan2(to[0] - cy, to[1] - cx) * 180) / Math.PI;
        if (prevAng !== null) {
          let d = ang - prevAng;
          while (d > 180) d -= 360;
          while (d < -180) d += 360;
          cum += d;
        }
        prevAng = ang;
      }
      closeRun();
      if (j.frames.length >= 6)
        orbits.push({
          game: g,
          id: j.id,
          target: t,
          deg: cum,
          steps: j.frames.length,
          net: netDelta,
        });
    }
  }

  // ---------- REPORT ----------
  const crowdSteps = allSteps.filter((s) => s.crowd);
  const soloSteps = allSteps.filter((s) => !s.crowd);
  const rc = rate(crowdSteps),
    rs = rate(soloSteps);

  console.log(
    `# GROUP / CROWD DYNAMICS  (${GAMES.length} games, ${allSteps.length} moves)\n`,
  );
  console.log(
    `crowd = >=${CROWD_MIN} grunts within Manhattan ${PACK_DIST}, cluster within ${WALL_NEAR} of a wall/water/house\n`,
  );
  console.log(`## (A) toward/away/lateral vs crowd membership`);
  console.log(
    `  CROWD steps (${rc.n}):  toward ${rc.pT}%  away ${rc.pA}%  lateral ${rc.pL}%`,
  );
  console.log(
    `  SOLO  steps (${rs.n}): toward ${rs.pT}%  away ${rs.pA}%  lateral ${rs.pL}%`,
  );
  console.log(
    `  => away-from-target rate is ${rc.pA}% in a jam vs ${rs.pA}% when uncrowded` +
      ` (${rc.pA - rs.pA >= 0 ? "+" : ""}${rc.pA - rs.pA} pts)\n`,
  );

  console.log(`## (A2) away-rate by cluster size`);
  const bySize = new Map<number, Step[]>();
  for (const s of allSteps) {
    if (!bySize.has(s.clusterSize)) bySize.set(s.clusterSize, []);
    bySize.get(s.clusterSize)!.push(s);
  }
  for (const k of [...bySize.keys()].sort((a, b) => a - b)) {
    const r = rate(bySize.get(k)!);
    const label = k === 0 ? "solo/<min" : `cluster=${k}`;
    console.log(
      `  ${label.padEnd(12)} n=${String(r.n).padStart(4)}  away ${String(r.pA).padStart(2)}%  toward ${String(r.pT).padStart(2)}%  lateral ${r.pL}%`,
    );
  }

  // (D) DEFLECTION — the direct test of "neighbor grunts push me off-target"
  console.log(`\n## (D) deflection cause for NON-greedy moves (crowd vs solo)`);
  const deflTable = (steps: Step[], label: string) => {
    const nong = steps.filter(
      (s) => s.defl !== "greedy" && s.defl !== "at-tgt",
    );
    const cnt = (d: string) => nong.filter((s) => s.defl === d).length;
    const n = nong.length || 1;
    const pct = (d: string) => `${Math.round((100 * cnt(d)) / n)}%`;
    console.log(
      `  ${label.padEnd(6)} non-greedy=${String(nong.length).padStart(4)}  ` +
        `terrain ${pct("terrain")}  grunt ${pct("grunt")}  pace ${pct("pace")}  free ${pct("free")}` +
        `   [grunt-deflected n=${cnt("grunt")}]`,
    );
  };
  deflTable(crowdSteps, "CROWD");
  deflTable(soloSteps, "SOLO");
  const greedyShare = (steps: Step[]) => {
    const g = steps.filter((s) => s.defl === "greedy").length;
    return `${Math.round((100 * g) / (steps.length || 1))}%`;
  };
  console.log(
    `  greedy-toward share: crowd ${greedyShare(crowdSteps)} vs solo ${greedyShare(soloSteps)}`,
  );
  // concrete grunt-deflection examples (the group effect, frame-level)
  const gex = allSteps.filter((s) => s.defl === "grunt").slice(0, 10);
  if (gex.length) {
    console.log(`  examples (toward-tile blocked by another grunt):`);
    for (const s of gex)
      console.log(
        `    rampart_${s.game}#${s.id} f${s.frame} (${s.from})->(${s.to}) cluster=${s.clusterSize} tgt(${s.target.r},${s.target.c})`,
      );
  }

  console.log(
    `\n## (B) circling — cumulative orbit angle around locked target`,
  );
  const obuckets: [string, (d: number) => boolean][] = [
    ["  0- 45deg", (d) => d < 45],
    [" 45- 90deg", (d) => d >= 45 && d < 90],
    [" 90-135deg", (d) => d >= 90 && d < 135],
    ["135-180deg", (d) => d >= 135 && d < 180],
    ["  >=180deg", (d) => d >= 180],
  ];
  for (const [label, pred] of obuckets) {
    const n = orbits.filter((o) => pred(Math.abs(o.deg))).length;
    console.log(`  |orbit| ${label}: ${n}`);
  }
  const circlers = orbits
    .filter((o) => Math.abs(o.deg) >= 90)
    .sort((a, b) => Math.abs(b.deg) - Math.abs(a.deg));
  const cw = circlers.filter((o) => o.deg > 0).length,
    ccw = circlers.filter((o) => o.deg < 0).length;
  console.log(
    `  >=90deg orbiters: ${circlers.length}/${orbits.length}  (${cw} CW+  ${ccw} CCW-, board coords +r down)`,
  );
  for (const o of circlers.slice(0, 8)) {
    console.log(
      `    rampart_${o.game}#${o.id}  orbit=${o.deg >= 0 ? "+" : ""}${Math.round(o.deg)}deg over ${o.steps} frames  netDist=${o.net >= 0 ? "+" : ""}${o.net}  target(${o.target.r},${o.target.c})`,
    );
  }

  // (E) barrier-following: do grunts round corners (circle) or just U-turn (pace)?
  console.log(
    `\n## (E) barrier-follow runs (>=3 consecutive wall-adjacent moves)`,
  );
  console.log(`  runs: ${turnRuns.length}`);
  const totL = turnRuns.reduce((a, r) => a + r.left, 0);
  const totR = turnRuns.reduce((a, r) => a + r.right, 0);
  const totU = turnRuns.reduce((a, r) => a + r.uturn, 0);
  console.log(
    `  turns along walls: ${totL} left(CCW)  ${totR} right(CW)  ${totU} U-turn(180)`,
  );
  // a "rounding" run rounds >=2 corners in a consistent sense => going around
  const rounders = turnRuns
    .filter((r) => Math.abs(r.left - r.right) >= 2)
    .sort((a, b) => Math.abs(b.left - b.right) - Math.abs(a.left - a.right));
  const uTurners = turnRuns.filter((r) => r.uturn >= 1).length;
  console.log(`  runs that rounded >=2 corners (circling): ${rounders.length}`);
  console.log(`  runs with >=1 U-turn (turn-around-at-wall): ${uTurners}`);
  for (const r of rounders.slice(0, 8)) {
    console.log(
      `    rampart_${r.game}#${r.id}  len=${r.len}  L=${r.left} R=${r.right} U=${r.uturn}  net=${r.left - r.right >= 0 ? "+" : ""}${r.left - r.right}`,
    );
  }

  console.log(
    `\n## (C) biggest jams (for visual check against the recordings)`,
  );
  type Jam = {
    game: string;
    frame: number;
    size: number;
    ids: number[];
    away: number;
    box: string;
  };
  const jams: Jam[] = [];
  const seen = new Set<string>();
  for (const s of crowdSteps) {
    const key = `${s.game}:${s.frame}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const members = crowdSteps.filter(
      (x) => x.game === s.game && x.frame === s.frame,
    );
    const ids = members.map((m) => m.id);
    const away = members.filter((m) => m.delta > 0).length;
    const rs2 = members.map((m) => m.from[0]),
      cs2 = members.map((m) => m.from[1]);
    const box = `r${Math.min(...rs2)}-${Math.max(...rs2)} c${Math.min(...cs2)}-${Math.max(...cs2)}`;
    jams.push({
      game: s.game,
      frame: s.frame,
      size: s.clusterSize,
      ids,
      away,
      box,
    });
  }
  jams.sort((a, b) => b.size - a.size || b.away - a.away);
  for (const jm of jams.slice(0, 15)) {
    console.log(
      `  rampart_${jm.game} f${jm.frame}  ${jm.size} grunts  away=${jm.away}/${jm.ids.length} moving  box ${jm.box}  ids[${jm.ids.join(",")}]`,
    );
  }
}

// impassable tiles: walls + water + houses + every tower footprint
function blockedSet(b: Board): Set<string> {
  const s = new Set<string>();
  for (const [r, c] of b.blocked) s.add(`${r},${c}`);
  for (const [r, c] of b.houses) s.add(`${r},${c}`);
  for (const t of b.towers)
    for (const [y, x] of fp(t.r, t.c)) if (inb(y, x)) s.add(`${y},${x}`);
  return s;
}

// classify why a move was (or wasn't) greedy-toward the target — see Step.defl
function classifyDefl(
  from: [number, number],
  to: [number, number],
  t: Tower,
  blk: Set<string> | null,
  occSet: Set<string> | undefined,
  recent: string[],
): Step["defl"] {
  const d0 = distFp(from, t);
  if (distFp(to, t) < d0) return "greedy";
  const toward: [number, number][] = [];
  for (const [dr, dc] of N4) {
    const nr = from[0] + dr,
      nc = from[1] + dc;
    if (inb(nr, nc) && distFp([nr, nc], t) < d0) toward.push([nr, nc]);
  }
  if (toward.length === 0) return "at-tgt";
  const fromKey = `${from[0]},${from[1]}`;
  let anyFree = false,
    anyGrunt = false;
  for (const [nr, nc] of toward) {
    const k = `${nr},${nc}`;
    const terr = blk?.has(k) ?? false;
    const grunted = (occSet?.has(k) ?? false) && k !== fromKey;
    if (!terr && !grunted) anyFree = true;
    else if (!terr && grunted) anyGrunt = true;
  }
  if (anyFree) return recent.includes(`${to[0]},${to[1]}`) ? "pace" : "free";
  return anyGrunt ? "grunt" : "terrain";
}

// cluster grunt indices by single-linkage Manhattan <= PACK_DIST
function clusterize(pos: [number, number][]): number[][] {
  const n = pos.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d =
        Math.abs(pos[i][0] - pos[j][0]) + Math.abs(pos[i][1] - pos[j][1]);
      if (d <= PACK_DIST) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }
  return [...groups.values()];
}

function rate(steps: Step[]) {
  const toward = steps.filter((s) => s.delta < 0).length;
  const away = steps.filter((s) => s.delta > 0).length;
  const lat = steps.filter((s) => s.delta === 0).length;
  const n = steps.length || 1;
  return {
    n: steps.length,
    toward,
    away,
    lat,
    pT: Math.round((100 * toward) / n),
    pA: Math.round((100 * away) / n),
    pL: Math.round((100 * lat) / n),
  };
}
