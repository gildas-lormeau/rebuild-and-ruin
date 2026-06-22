/**
 * Grunt movement-logic analyzer (v2: stable ids + fixed target + anomaly log).
 *
 * Reads full-lifetime journeys (grunt-journeys.json from rampart-journeys.ts) and
 * per-frame boards (grunt-boards.json from rampart-track.ts). For each journey it
 * INFERS a single fixed target (the tower/home the grunt actually walked to,
 * primarily from where the journey ends), then scores every move against the
 * shortest-path field to THAT fixed target — not the nearest-each-frame tower the
 * old model assumed. Moves that go away from the fixed target (and aren't a 2-tile
 * pacing bounce) are dumped to an anomaly log with a local ASCII crop, because the
 * real pathing rule is hiding in exactly those exceptions.
 *
 * Usage: deno run -A scripts/rampart-analyze.ts <framesDir> [<framesDir> ...]
 * Writes tmp/rampart-anomalies.txt (the disagreement dump).
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
  episodes: number[];
  birthFrame: number;
  deathFrame: number;
  spans: number;
};

type Cand = { key: string; r: number; c: number; kind: string };

type Target = Cand & { method: string; score: number };

type Anomaly = {
  game: string;
  id: number;
  frame: number;
  a: [number, number];
  b: [number, number];
  facing: string;
  target: Target;
  da: number;
  db: number;
  shortest: string;
  actual: string;
  cause: "axisAlign" | "wallFollow" | "openJitter";
  crop: string;
};

type Counts = {
  toward: number;
  away: number;
  side: number;
  enclosed: number;
  pacingAway: number;
  // greedy Manhattan model (ignores walls): does the move cut |row|+|col| to target?
  gToward: number;
  gAway: number;
  gSame: number;
  // anomaly causes (subset of `away`)
  axisAlign: number;
  wallFollow: number;
  openJitter: number;
};

const COLS = 40;
const ROWS = 25;
const CROP_R = 4;
const ANOMALY_FILE = "tmp/rampart-anomalies.txt";
const N4 = [
  [-1, 0, "N"],
  [1, 0, "S"],
  [0, -1, "W"],
  [0, 1, "E"],
] as const;
const inb = (r: number, c: number) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
const key2 = (r: number, c: number) => `${r},${c}`;
const manh = (a: [number, number], b: [number, number]) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
const fp2x2 = (r: number, c: number) =>
  [
    [r, c],
    [r, c + 1],
    [r + 1, c],
    [r + 1, c + 1],
  ].filter(([y, x]) => inb(y, x)) as [number, number][];
const dirOf = (dr: number, dc: number) =>
  dr === -1 ? "N" : dr === 1 ? "S" : dc === -1 ? "W" : dc === 1 ? "E" : "?";

if (import.meta.main) await main();

async function main() {
  const interestingOnly = Deno.args.includes("--interesting");
  const dirs = Deno.args.filter((a) => !a.startsWith("--"));
  if (!dirs.length) {
    console.error(
      "usage: deno run -A scripts/rampart-analyze.ts [--interesting] <framesDir> [...]",
    );
    Deno.exit(2);
  }
  const acc: Counts = {
    toward: 0,
    away: 0,
    side: 0,
    enclosed: 0,
    pacingAway: 0,
    gToward: 0,
    gAway: 0,
    gSame: 0,
    axisAlign: 0,
    wallFollow: 0,
    openJitter: 0,
  };
  const anomalies: Anomaly[] = [];
  let journeyCount = 0;
  let targeted = 0;
  let nearestMatch = 0;
  const nonNearest: string[] = [];

  for (const dir of dirs) {
    const game = dir.split("/").pop() ?? dir;
    const boards: Record<string, Board> = JSON.parse(
      await Deno.readTextFile(`${dir}/grunt-boards.json`),
    );
    const journeys: Journey[] = JSON.parse(
      await Deno.readTextFile(`${dir}/grunt-journeys.json`),
    );
    const occupancy = gruntIndex(journeys);
    const fieldCache = new Map<string, number[][]>();
    const fieldFor = (frame: number, t: Cand) => {
      const ck = `${frame}|${t.r},${t.c}`;
      let f = fieldCache.get(ck);
      if (!f) {
        f = distFieldTo(passOf(boards[frame]), fp2x2(t.r, t.c));
        fieldCache.set(ck, f);
      }
      return f;
    };

    for (const j of journeys) {
      if (j.pts.length < 2) continue;
      if (interestingOnly && !isInteresting(j)) continue;
      journeyCount++;
      const target = inferTarget(j, boards, fieldFor);
      if (!target) continue;
      if (target.method === "endpoint") {
        targeted++;
        const near = nearestCand(j.pts[0], boards[String(j.birthFrame)]);
        if (near && near.key === target.key) nearestMatch++;
        else if (near) {
          nonNearest.push(
            `${game}#${j.id} f${j.birthFrame} @(${j.pts[0]}) chose ${target.kind}@(${target.r},${target.c}) ` +
              `dist=${manh(j.pts[0], [target.r, target.c])} not nearest ${near.kind}@(${near.r},${near.c}) dist=${manh(j.pts[0], [near.r, near.c])}`,
          );
        }
      }
      classify(j, target, boards, fieldFor, occupancy, game, acc, anomalies);
    }
  }

  await writeAnomalies(anomalies);
  printReport(
    dirs.length,
    journeyCount,
    targeted,
    nearestMatch,
    acc,
    anomalies,
    nonNearest,
  );
}

// frame -> list of grunt positions (for "other grunts" in crops)
function gruntIndex(journeys: Journey[]): Map<number, [number, number][]> {
  const m = new Map<number, [number, number][]>();
  for (const j of journeys) {
    for (let i = 0; i < j.frames.length; i++) {
      const arr = m.get(j.frames[i]);
      if (arr) arr.push(j.pts[i]);
      else m.set(j.frames[i], [j.pts[i]]);
    }
  }
  return m;
}

// "interesting" = traveler or drifter (see rampart-traits.ts): a grunt that
// actually goes somewhere, vs frozen/idle/pacer noise that swamps the path rule.
function isInteresting(j: Journey): boolean {
  let moves = 0;
  for (let i = 0; i + 1 < j.pts.length; i++) {
    if (j.pts[i][0] !== j.pts[i + 1][0] || j.pts[i][1] !== j.pts[i + 1][1]) {
      moves++;
    }
  }
  const net = manh(j.pts[0], j.pts[j.pts.length - 1]);
  if (moves === 0) return false; // frozen
  if (net >= 6) return true; // traveler
  if (net <= 3 && moves >= 8) return false; // pacer
  if (net <= 2) return false; // idle
  return true; // drifter
}

function nearestCand(
  pos: [number, number],
  board: Board | undefined,
): Cand | null {
  if (!board) return null;
  let best: Cand | null = null;
  let bd = Infinity;
  for (const cand of candidates(board)) {
    const d = manh(pos, [cand.r, cand.c]);
    if (d < bd) {
      bd = d;
      best = cand;
    }
  }
  return best;
}

// union of alive towers + homes across the journey, then pick the one the journey
// best heads toward; endpoint-adjacency wins outright when present.
function inferTarget(
  j: Journey,
  boards: Record<string, Board>,
  fieldFor: (frame: number, t: Cand) => number[][],
): Target | null {
  const cmap = new Map<string, Cand>();
  for (const fr of j.frames) {
    const b = boards[String(fr)];
    if (b) for (const cand of candidates(b)) cmap.set(cand.key, cand);
  }
  const cands = [...cmap.values()];
  if (!cands.length) return null;
  const end = j.pts[j.pts.length - 1];
  const adj = cands.filter((cn) =>
    fp2x2(cn.r, cn.c).some((f) => manh(f, end) === 1),
  );
  const pool = adj.length ? adj : cands;
  const method = adj.length ? "endpoint" : "pathscore";
  let best: Target | null = null;
  for (const cn of pool) {
    let score = 0;
    let moves = 0;
    for (let i = 0; i + 1 < j.frames.length; i++) {
      const a = j.pts[i];
      const b = j.pts[i + 1];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      const f = fieldFor(j.frames[i], cn);
      const da = f[a[0]][a[1]];
      const db = f[b[0]][b[1]];
      if (!isFinite(da) || !isFinite(db)) continue;
      score += da - db;
      moves++;
    }
    const norm = moves ? score / moves : 0;
    if (!best || norm > best.score) best = { ...cn, method, score: norm };
  }
  return best;
}

function candidates(board: Board): Cand[] {
  const out: Cand[] = [];
  for (const t of board.towers) {
    if (t.state === "alive")
      out.push({ key: `t${t.r},${t.c}`, r: t.r, c: t.c, kind: "tower" });
  }
  for (const [color, [r, c]] of Object.entries(board.homes)) {
    out.push({ key: `h${color}`, r, c, kind: `home:${color}` });
  }
  return out;
}

function classify(
  j: Journey,
  target: Target,
  boards: Record<string, Board>,
  fieldFor: (frame: number, t: Cand) => number[][],
  occupancy: Map<number, [number, number][]>,
  game: string,
  acc: Counts,
  anomalies: Anomaly[],
): void {
  const tfp = fp2x2(target.r, target.c);
  const manhT = (p: [number, number]) =>
    Math.min(...tfp.map((t) => manh(p, t)));
  const recent: string[] = [];
  for (let i = 0; i + 1 < j.frames.length; i++) {
    const a = j.pts[i];
    const b = j.pts[i + 1];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    const frame = j.frames[i];
    const f = fieldFor(frame, target);
    const da = f[a[0]][a[1]];
    const db = f[b[0]][b[1]];
    // greedy Manhattan model (walls ignored): is the step reducing row+col gap?
    const gd = manhT(b) - manhT(a);
    if (gd < 0) acc.gToward++;
    else if (gd > 0) acc.gAway++;
    else acc.gSame++;
    const oscillating = recent.includes(key2(b[0], b[1]));
    recent.push(key2(a[0], a[1]));
    if (recent.length > 3) recent.shift();
    if (!isFinite(da)) {
      acc.enclosed++;
    } else if (db < da) {
      acc.toward++;
    } else if (db === da) {
      acc.side++;
    } else if (oscillating) {
      acc.pacingAway++;
    } else {
      acc.away++;
      const an = makeAnomaly(
        game,
        j,
        i,
        target,
        boards[String(frame)],
        f,
        occupancy,
        gd < 0,
      );
      acc[an.cause]++;
      anomalies.push(an);
    }
  }
}

function makeAnomaly(
  game: string,
  j: Journey,
  i: number,
  target: Target,
  board: Board,
  field: number[][],
  occupancy: Map<number, [number, number][]>,
  greedyToward: boolean,
): Anomaly {
  const a = j.pts[i];
  const b = j.pts[i + 1];
  const da = field[a[0]][a[1]];
  const shortest = N4.filter(([dr, dc]) => {
    const nr = a[0] + dr;
    const nc = a[1] + dc;
    return inb(nr, nc) && field[nr][nc] < da;
  })
    .map(([, , name]) => name)
    .join("");
  // cause: axis-align (greedy Manhattan progress despite BFS-away), else
  // wall-follow (a wall sits orthogonally adjacent), else open jitter.
  const pass = passOf(board);
  const wallAdj = N4.some(
    ([dr, dc]) => inb(a[0] + dr, a[1] + dc) && !pass[a[0] + dr][a[1] + dc],
  );
  const cause = greedyToward
    ? "axisAlign"
    : wallAdj
      ? "wallFollow"
      : "openJitter";
  return {
    game,
    id: j.id,
    frame: j.frames[i],
    a,
    b,
    facing: j.dirs[i],
    target,
    da,
    db: field[b[0]][b[1]],
    shortest,
    actual: dirOf(b[0] - a[0], b[1] - a[1]),
    cause,
    crop: makeCrop(board, a, b, target, occupancy.get(j.frames[i]) ?? []),
  };
}

// 9x9 ascii window around the grunt: @ from, * to, T target, t tower, H home,
// h house, # wall/water, o other grunt, . passable
function makeCrop(
  board: Board,
  a: [number, number],
  b: [number, number],
  target: Target,
  others: [number, number][],
): string {
  const blocked = new Set(board.blocked.map(([r, c]) => key2(r, c)));
  const house = new Set(board.houses.map(([r, c]) => key2(r, c)));
  const tFp = new Set(fp2x2(target.r, target.c).map(([r, c]) => key2(r, c)));
  const towerFp = new Set<string>();
  for (const t of board.towers) {
    for (const [r, c] of fp2x2(t.r, t.c)) towerFp.add(key2(r, c));
  }
  const homeFp = new Set<string>();
  for (const [r, c] of Object.values(board.homes)) {
    for (const [y, x] of fp2x2(r, c)) homeFp.add(key2(y, x));
  }
  const oth = new Set(others.map(([r, c]) => key2(r, c)));
  const lines: string[] = [];
  for (let r = a[0] - CROP_R; r <= a[0] + CROP_R; r++) {
    let line = "";
    for (let c = a[1] - CROP_R; c <= a[1] + CROP_R; c++) {
      const k = key2(r, c);
      if (!inb(r, c)) line += " ";
      else if (r === a[0] && c === a[1]) line += "@";
      else if (r === b[0] && c === b[1]) line += "*";
      else if (tFp.has(k)) line += "T";
      else if (homeFp.has(k)) line += "H";
      else if (towerFp.has(k)) line += "t";
      else if (house.has(k)) line += "h";
      else if (blocked.has(k)) line += "#";
      else if (oth.has(k)) line += "o";
      else line += ".";
    }
    lines.push(line);
  }
  return lines.join("\n");
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

// passable = not water/wall, not a house, and not any tower footprint. Houses are
// static board obstacles grunts must path around (their count grows as territory
// develops, which is expected).
function passOf(board: Board): boolean[][] {
  const p = Array.from({ length: ROWS }, () => Array<boolean>(COLS).fill(true));
  for (const [r, c] of board.blocked) if (inb(r, c)) p[r][c] = false;
  for (const [r, c] of board.houses) if (inb(r, c)) p[r][c] = false;
  for (const t of board.towers) {
    for (const [r, c] of fp2x2(t.r, t.c)) p[r][c] = false;
  }
  return p;
}

async function writeAnomalies(anomalies: Anomaly[]): Promise<void> {
  const out: string[] = [
    `# ${anomalies.length} anomalous moves (away from fixed target, not a pacing bounce)`,
    `# legend: @ grunt-from  * grunt-to  T target  t tower  H home  h house  # wall/water  o other-grunt  . open`,
    "",
  ];
  for (const an of anomalies) {
    out.push(
      `${an.game} #${an.id} f${an.frame}  ${an.target.kind}@(${an.target.r},${an.target.c}) [${an.target.method}]`,
    );
    out.push(
      `  @(${an.a}) -> (${an.b})  facing=${an.facing} moved=${an.actual}  ` +
        `dist ${an.da}->${an.db}  shortest-path move(s)=[${an.shortest}]  cause=${an.cause}`,
    );
    out.push(...an.crop.split("\n").map((l) => `    ${l}`));
    out.push("");
  }
  await Deno.writeTextFile(ANOMALY_FILE, out.join("\n"));
}

function printReport(
  dirCount: number,
  journeyCount: number,
  targeted: number,
  nearestMatch: number,
  acc: Counts,
  anomalies: Anomaly[],
  nonNearest: string[],
): void {
  const tot = acc.toward + acc.away + acc.side + acc.enclosed + acc.pacingAway;
  const pct = (n: number) => `${n} (${tot ? Math.round((100 * n) / tot) : 0}%)`;
  console.log(`# games=${dirCount} journeys=${journeyCount}`);
  console.log(
    `\n# FIXED-TARGET PATH MODEL (each move vs shortest path to the journey's own target, ${tot}):`,
  );
  console.log(`  toward (shortest-path step):        ${pct(acc.toward)}`);
  console.log(`  away (genuine, logged):             ${pct(acc.away)}`);
  console.log(`  away (2-tile pacing bounce):        ${pct(acc.pacingAway)}`);
  console.log(`  sideways (equal distance):          ${pct(acc.side)}`);
  console.log(`  target currently walled off:        ${pct(acc.enclosed)}`);
  const gtot = acc.gToward + acc.gAway + acc.gSame;
  const gp = (n: number) =>
    `${n} (${gtot ? Math.round((100 * n) / gtot) : 0}%)`;
  console.log(
    `\n# GREEDY MANHATTAN MODEL (walls ignored: does the step cut row+col gap to target?, ${gtot}):`,
  );
  console.log(`  toward (cuts the gap):              ${gp(acc.gToward)}`);
  console.log(`  away (widens the gap):              ${gp(acc.gAway)}`);
  console.log(`  same (slides at equal gap):         ${gp(acc.gSame)}`);
  console.log(`\n# ANOMALY CAUSES (of ${acc.away} genuine away-moves):`);
  console.log(`  axis-align (greedy, BFS-detour):    ${acc.axisAlign}`);
  console.log(`  wall-follow (wall adjacent):        ${acc.wallFollow}`);
  console.log(`  open jitter (likely recon noise):   ${acc.openJitter}`);
  console.log(
    `\n# TARGET SELECTION (journeys that ended adjacent to a target: ${targeted}):`,
  );
  console.log(
    `  chose the nearest target at spawn:  ${nearestMatch}/${targeted} ` +
      `(${targeted ? Math.round((100 * nearestMatch) / targeted) : 0}%)`,
  );
  for (const line of nonNearest.slice(0, 12)) console.log(`    - ${line}`);
  if (nonNearest.length > 12)
    console.log(`    ... +${nonNearest.length - 12} more non-nearest`);
  console.log(`\n# ANOMALY LOG: ${anomalies.length} moves -> ${ANOMALY_FILE}`);
}
