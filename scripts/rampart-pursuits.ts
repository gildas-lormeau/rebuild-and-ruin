/**
 * Per-pursuit pathing analysis, anchored on confirmed kills.
 *
 * The whole-journey "one fixed target" model is wrong: a grunt lives many rounds
 * and chases several towers in turn. So instead of guessing the target, we use the
 * ground truth: a tower's alive->dead transition is a KILL, the grunt adjacent at
 * that moment is the KILLER, and the target of its final approach is certain. Each
 * killer journey is split into pursuits (birth->kill1->kill2...), and every step of
 * each approach is scored against its KNOWN target tower:
 *   - greedy: does the step cut the Manhattan gap to the target?
 *   - bfs:    does the step follow the shortest obstacle-aware path?
 * This is the clean signal for reading the actual step-by-step movement rule.
 *
 * Usage: deno run -A scripts/rampart-pursuits.ts <framesDir> [<framesDir> ...]
 * Writes tmp/rampart-pursuits.txt (the per-pursuit route dump).
 */

type Board = {
  towers: { r: number; c: number; state: string }[];
  homes: Record<string, [number, number]>;
  blocked: [number, number][];
  houses: [number, number][];
};

type Journey = {
  id: number;
  frames: number[];
  pts: [number, number][];
  dirs: string[];
};

type Kill = { tr: number; tc: number; aliveFrame: number; deathFrame: number };

type Pursuit = {
  game: string;
  jid: number;
  target: [number, number];
  frames: number[];
  pts: [number, number][];
  dirs: string[];
};

const COLS = 40;
const ROWS = 25;
const PURSUIT_FILE = "tmp/rampart-pursuits.txt";
const N4 = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;
const inb = (r: number, c: number) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
const manh = (a: [number, number], b: [number, number]) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
const fp2x2 = (r: number, c: number): [number, number][] =>
  [
    [r, c],
    [r, c + 1],
    [r + 1, c],
    [r + 1, c + 1],
  ] as [number, number][];
const dirOf = (dr: number, dc: number) =>
  dr === -1 ? "N" : dr === 1 ? "S" : dc === -1 ? "W" : dc === 1 ? "E" : ".";

if (import.meta.main) await main();

async function main() {
  const dirs = Deno.args.filter((a) => !a.startsWith("--"));
  if (!dirs.length) {
    console.error(
      "usage: deno run -A scripts/rampart-pursuits.ts <framesDir> [...]",
    );
    Deno.exit(2);
  }
  const all: Pursuit[] = [];
  const occ = new Map<string, Map<number, Set<string>>>(); // game -> frame -> grunt tiles
  let kills = 0;
  let attributed = 0;
  for (const dir of dirs) {
    const game = dir.split("/").pop() ?? dir;
    const boards: Record<string, Board> = JSON.parse(
      await Deno.readTextFile(`${dir}/grunt-boards.json`),
    );
    const journeys: Journey[] = JSON.parse(
      await Deno.readTextFile(`${dir}/grunt-journeys.json`),
    );
    const fmap = new Map<number, Set<string>>();
    for (const j of journeys) {
      for (let i = 0; i < j.frames.length; i++) {
        const s = fmap.get(j.frames[i]) ?? new Set<string>();
        s.add(`${j.pts[i][0]},${j.pts[i][1]}`);
        fmap.set(j.frames[i], s);
      }
    }
    occ.set(game, fmap);
    const ks = detectKills(boards);
    kills += ks.length;
    const byJourney = attributeKillers(ks, journeys);
    for (const [jid, jkills] of byJourney) {
      attributed += jkills.length;
      const j = journeys.find((x) => x.id === jid)!;
      all.push(...segment(game, j, jkills));
    }
  }
  scoreAndReport(all, kills, attributed, boardsByGame(dirs), occ);
}

// load boards lazily again for BFS during scoring (kept simple: re-read)
function boardsByGame(
  dirs: string[],
): Map<string, Promise<Record<string, Board>>> {
  const m = new Map<string, Promise<Record<string, Board>>>();
  for (const dir of dirs) {
    const game = dir.split("/").pop() ?? dir;
    m.set(game, Deno.readTextFile(`${dir}/grunt-boards.json`).then(JSON.parse));
  }
  return m;
}

// a kill = a tower position that is alive in one build frame and dead (and stays
// dead) in a later one. Towers are static so they key by exact (r,c).
function detectKills(boards: Record<string, Board>): Kill[] {
  const frames = Object.keys(boards)
    .map(Number)
    .sort((a, b) => a - b);
  const seen = new Map<string, { lastAlive: number; dead: boolean }>();
  const kills: Kill[] = [];
  for (const f of frames) {
    for (const t of boards[String(f)].towers) {
      const k = `${t.r},${t.c}`;
      const rec = seen.get(k) ?? { lastAlive: -1, dead: false };
      if (t.state === "alive") {
        rec.lastAlive = f;
        rec.dead = false;
      } else if (!rec.dead && rec.lastAlive >= 0) {
        kills.push({
          tr: t.r,
          tc: t.c,
          aliveFrame: rec.lastAlive,
          deathFrame: f,
        });
        rec.dead = true;
      }
      seen.set(k, rec);
    }
  }
  return kills;
}

// attribute each kill to the journey adjacent to the tower at its last-alive
// frame; group kills per killer journey, ordered by death.
function attributeKillers(
  kills: Kill[],
  journeys: Journey[],
): Map<number, Kill[]> {
  const out = new Map<number, Kill[]>();
  for (const kill of kills) {
    const fp = fp2x2(kill.tr, kill.tc);
    const adj: number[] = [];
    for (const j of journeys) {
      const i = j.frames.indexOf(kill.aliveFrame);
      if (i < 0) continue;
      if (fp.some((t) => manh(t, j.pts[i]) <= 1)) adj.push(j.id);
    }
    if (adj.length !== 1) continue; // skip ambiguous (0 or >1 adjacent)
    const arr = out.get(adj[0]) ?? [];
    arr.push(kill);
    out.set(adj[0], arr);
  }
  for (const arr of out.values())
    arr.sort((a, b) => a.deathFrame - b.deathFrame);
  return out;
}

// split a killer journey into pursuits: each kill ends a pursuit; the pursuit
// starts at the previous kill (or the journey's max-distance point to this target,
// whichever is later) — i.e. the run where the grunt closed in on this tower.
function segment(game: string, j: Journey, kills: Kill[]): Pursuit[] {
  const out: Pursuit[] = [];
  let prevEnd = 0;
  for (const kill of kills) {
    const target: [number, number] = [kill.tr, kill.tc];
    const fp = fp2x2(kill.tr, kill.tc);
    const distTo = (p: [number, number]) =>
      Math.min(...fp.map((t) => manh(t, p)));
    const killIdx = j.frames.indexOf(kill.aliveFrame);
    if (killIdx <= prevEnd) {
      prevEnd = Math.max(prevEnd, killIdx);
      continue;
    }
    // start = farthest-from-target index in [prevEnd, killIdx] (the closing-in run)
    let start = prevEnd;
    let far = -1;
    for (let i = prevEnd; i <= killIdx; i++) {
      const d = distTo(j.pts[i]);
      if (d > far) {
        far = d;
        start = i;
      }
    }
    if (killIdx - start >= 2) {
      out.push({
        game,
        jid: j.id,
        target,
        frames: j.frames.slice(start, killIdx + 1),
        pts: j.pts.slice(start, killIdx + 1),
        dirs: j.dirs.slice(start, killIdx + 1),
      });
    }
    prevEnd = killIdx;
  }
  return out;
}

async function scoreAndReport(
  pursuits: Pursuit[],
  kills: number,
  attributed: number,
  boardsP: Map<string, Promise<Record<string, Board>>>,
  occ: Map<string, Map<number, Set<string>>>,
): Promise<void> {
  const boardsByGameResolved = new Map<string, Record<string, Board>>();
  for (const [g, p] of boardsP) boardsByGameResolved.set(g, await p);

  let gToward = 0,
    gAway = 0,
    gSame = 0,
    bToward = 0,
    bAway = 0,
    bSame = 0,
    bUnreach = 0,
    steps = 0;
  // tie-break: when both axes still need closing, does it move the larger-delta
  // axis? and inertia: does it keep its previous heading?
  let choseLarger = 0,
    choseSmaller = 0,
    tieEqual = 0,
    inertiaSame = 0,
    inertiaTotal = 0,
    // non-forward moves: pace = returned to a recent tile (oscillation/lock);
    // skirt = stepped to a NEW tile. A skirt is "legit" if a forward (toward)
    // tile was blocked by terrain or another grunt; "unexplained" if a forward
    // tile was free yet the grunt still went sideways/away.
    pace = 0,
    skirtTerrain = 0,
    skirtGrunt = 0,
    skirtUnexplained = 0;
  const unexplained: string[] = [];
  const lines: string[] = [
    "# per-pursuit routes (target tower confirmed by kill)",
    "",
  ];
  for (const p of pursuits) {
    const boards = boardsByGameResolved.get(p.game)!;
    const fp = fp2x2(p.target[0], p.target[1]);
    const distTo = (q: [number, number]) =>
      Math.min(...fp.map((t) => manh(t, q)));
    const route: string[] = [];
    let prevDir = "";
    const recent: string[] = [];
    for (let i = 0; i + 1 < p.pts.length; i++) {
      const a = p.pts[i];
      const b = p.pts[i + 1];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      steps++;
      const gd = distTo(b) - distTo(a);
      if (gd < 0) gToward++;
      else if (gd > 0) gAway++;
      else gSame++;
      // skirt vs pace: classify non-forward moves; for skirts, find WHY the
      // grunt didn't just go forward (terrain block / grunt block / unexplained)
      if (gd >= 0) {
        if (recent.includes(`${b[0]},${b[1]}`)) {
          pace++;
        } else {
          const pass = passOf(boards[String(p.frames[i])]);
          const others = occ.get(p.game)?.get(p.frames[i]);
          let terrain = false;
          let grunt = false;
          for (const [dr, dc] of N4) {
            const nr = a[0] + dr;
            const nc = a[1] + dc;
            if (!inb(nr, nc) || distTo([nr, nc]) >= distTo(a)) continue; // not a forward tile
            if (!pass[nr][nc]) terrain = true;
            else if (others?.has(`${nr},${nc}`)) grunt = true;
          }
          if (terrain) skirtTerrain++;
          else if (grunt) skirtGrunt++;
          else {
            skirtUnexplained++;
            if (unexplained.length < 40) {
              unexplained.push(
                `${p.game}#${p.jid} f${p.frames[i]} @(${a}) -> (${b}) ` +
                  `dir=${dirOf(b[0] - a[0], b[1] - a[1])} target(${p.target}) ` +
                  `dist ${distTo(a)}->${distTo(b)}`,
              );
            }
          }
        }
      }
      recent.push(`${a[0]},${a[1]}`);
      if (recent.length > 4) recent.shift();
      const field = distFieldTo(passOf(boards[String(p.frames[i])]), fp);
      const da = field[a[0]][a[1]];
      const db = field[b[0]][b[1]];
      if (!isFinite(da) || !isFinite(db)) bUnreach++;
      else if (db < da) bToward++;
      else if (db > da) bAway++;
      else bSame++;
      // tie-break (only on genuine toward moves with both axes still open)
      const drNeed =
        a[0] < p.target[0]
          ? p.target[0] - a[0]
          : a[0] > p.target[0] + 1
            ? a[0] - (p.target[0] + 1)
            : 0;
      const dcNeed =
        a[1] < p.target[1]
          ? p.target[1] - a[1]
          : a[1] > p.target[1] + 1
            ? a[1] - (p.target[1] + 1)
            : 0;
      if (gd < 0 && drNeed > 0 && dcNeed > 0) {
        const movedRow = b[0] !== a[0];
        if (drNeed === dcNeed) tieEqual++;
        else if (movedRow === drNeed > dcNeed) choseLarger++;
        else choseSmaller++;
      }
      const dir = dirOf(b[0] - a[0], b[1] - a[1]);
      if (prevDir) {
        inertiaTotal++;
        if (dir === prevDir) inertiaSame++;
      }
      prevDir = dir;
      route.push(dir);
    }
    lines.push(
      `${p.game}#${p.jid} -> tower(${p.target}) len=${p.pts.length} ` +
        `(${p.pts[0]})..(${p.pts.at(-1)})  route=${route.join("")}`,
    );
  }
  await Deno.writeTextFile(PURSUIT_FILE, lines.join("\n"));

  const gt = gToward + gAway + gSame;
  const bt = bToward + bAway + bSame + bUnreach;
  const pc = (n: number, d: number) =>
    `${n} (${d ? Math.round((100 * n) / d) : 0}%)`;
  console.log(
    `# kills detected=${kills}  attributed to a single killer=${attributed}`,
  );
  console.log(
    `# pursuits (approach >=2 steps)=${pursuits.length}  scored steps=${steps}`,
  );
  console.log(`\n# GREEDY MANHATTAN (to the confirmed target tower):`);
  console.log(`  toward (cuts gap):  ${pc(gToward, gt)}`);
  console.log(`  away (widens gap):  ${pc(gAway, gt)}`);
  console.log(`  same:               ${pc(gSame, gt)}`);
  console.log(
    `\n# BFS SHORTEST-PATH (obstacle-aware, to the confirmed target):`,
  );
  console.log(`  toward:             ${pc(bToward, bt)}`);
  console.log(`  away:               ${pc(bAway, bt)}`);
  console.log(`  same:               ${pc(bSame, bt)}`);
  console.log(`  target unreachable: ${pc(bUnreach, bt)}`);
  const tieTot = choseLarger + choseSmaller + tieEqual;
  console.log(
    `\n# TIE-BREAK (toward-steps with both axes still open, ${tieTot}):`,
  );
  console.log(`  moved the LARGER-delta axis:  ${pc(choseLarger, tieTot)}`);
  console.log(`  moved the smaller-delta axis: ${pc(choseSmaller, tieTot)}`);
  console.log(`  axes equal (free tie):        ${pc(tieEqual, tieTot)}`);
  console.log(
    `\n# INERTIA: kept previous heading on ${pc(inertiaSame, inertiaTotal)} of consecutive steps`,
  );
  const skirt = skirtTerrain + skirtGrunt + skirtUnexplained;
  const nonFwd = skirt + pace;
  console.log(
    `\n# NON-FORWARD MOVES (${nonFwd} of ${steps} steps) — pace vs skirt:`,
  );
  console.log(
    `  PACE (returned to a recent tile, oscillation/lock): ${pc(pace, nonFwd)}`,
  );
  console.log(
    `  SKIRT (stepped to a NEW tile): ${pc(skirt, nonFwd)}, of which:`,
  );
  console.log(`    legit, terrain blocked the forward tile: ${skirtTerrain}`);
  console.log(`    legit, another GRUNT blocked it (group):  ${skirtGrunt}`);
  console.log(
    `    UNEXPLAINED (a forward tile was free):    ${skirtUnexplained}`,
  );
  if (unexplained.length) {
    console.log(
      `\n  # unexplained skirts (forward was open, yet went sideways/away):`,
    );
    for (const u of unexplained) console.log(`    ${u}`);
  }
  console.log(`\n# routes -> ${PURSUIT_FILE}`);
}

function distFieldTo(pass: boolean[][], fp: [number, number][]): number[][] {
  const d = Array.from({ length: ROWS }, () =>
    Array<number>(COLS).fill(Infinity),
  );
  const q: [number, number][] = [];
  for (const [tr, tc] of fp) {
    for (const [dr, dc] of N4) {
      const r = tr + dr;
      const c = tc + dc;
      if (inb(r, c) && pass[r][c] && d[r][c] === Infinity) {
        d[r][c] = 0;
        q.push([r, c]);
      }
    }
  }
  for (let h = 0; h < q.length; h++) {
    const [r, c] = q[h];
    for (const [dr, dc] of N4) {
      const nr = r + dr;
      const nc = c + dc;
      if (inb(nr, nc) && pass[nr][nc] && d[nr][nc] === Infinity) {
        d[nr][nc] = d[r][c] + 1;
        q.push([nr, nc]);
      }
    }
  }
  return d;
}

function passOf(board: Board): boolean[][] {
  const p = Array.from({ length: ROWS }, () => Array<boolean>(COLS).fill(true));
  for (const [r, c] of board.blocked) if (inb(r, c)) p[r][c] = false;
  for (const [r, c] of board.houses) if (inb(r, c)) p[r][c] = false;
  for (const t of board.towers) {
    for (const [r, c] of fp2x2(t.r, t.c)) if (inb(r, c)) p[r][c] = false;
  }
  return p;
}
