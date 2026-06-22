/**
 * Grunt behavior classifier. Each full-lifetime journey is reduced to movement
 * features and bucketed into a behavior trait, so the noise (grunts that do
 * nothing — frozen, idle, or camped on the tower they already killed) can be
 * separated from the grunts whose pathing is actually worth studying. Also probes
 * whether the population splits into distinct TYPES (bimodal speed/directedness)
 * vs one AI in different situations.
 *
 *   frozen    - never moved
 *   idle      - barely moved, tiny area (often parked next to a dead tower)
 *   pacer     - lots of motion, ~zero net progress (blocked, oscillating)
 *   drifter   - modest net displacement
 *   traveler  - clear long-range travel (the interesting ones)
 *
 * Usage: deno run -A scripts/rampart-traits.ts <framesDir> [<framesDir> ...]
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
  spans: number;
  birthFrame: number;
  deathFrame: number;
};

type Trait = "frozen" | "idle" | "pacer" | "drifter" | "traveler";

type Feat = {
  game: string;
  id: number;
  life: number;
  moves: number;
  net: number;
  uniq: number;
  activity: number; // fraction of steps that moved
  straight: number; // net / moves: 1=straight line, ~0=pacing
  trait: Trait;
  endTower: "alive" | "dead" | "none"; // what the grunt ended adjacent to
};

const manh = (a: [number, number], b: [number, number]) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
const fp2x2 = (r: number, c: number): [number, number][] => [
  [r, c],
  [r, c + 1],
  [r + 1, c],
  [r + 1, c + 1],
];

if (import.meta.main) await main();

async function main() {
  const dirs = Deno.args;
  if (!dirs.length) {
    console.error(
      "usage: deno run -A scripts/rampart-traits.ts <framesDir> [...]",
    );
    Deno.exit(2);
  }
  const all: Feat[] = [];
  for (const dir of dirs) {
    const game = dir.split("/").pop() ?? dir;
    const boards: Record<string, Board> = JSON.parse(
      await Deno.readTextFile(`${dir}/grunt-boards.json`),
    );
    const journeys: Journey[] = JSON.parse(
      await Deno.readTextFile(`${dir}/grunt-journeys.json`),
    );
    for (const j of journeys) all.push(featesOf(game, j, boards));
  }
  report(all);
}

function featesOf(
  game: string,
  j: Journey,
  boards: Record<string, Board>,
): Feat {
  const life = j.frames.length;
  let moves = 0;
  const seen = new Set<string>();
  let minR = Infinity,
    maxR = -Infinity,
    minC = Infinity,
    maxC = -Infinity;
  for (let i = 0; i < j.pts.length; i++) {
    const [r, c] = j.pts[i];
    seen.add(`${r},${c}`);
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
    minC = Math.min(minC, c);
    maxC = Math.max(maxC, c);
    if (i + 1 < j.pts.length) {
      const [r2, c2] = j.pts[i + 1];
      if (r !== r2 || c !== c2) moves++;
    }
  }
  const net = manh(j.pts[0], j.pts[j.pts.length - 1]);
  const trans = Math.max(1, life - 1);
  const feat: Feat = {
    game,
    id: j.id,
    life,
    moves,
    net,
    uniq: seen.size,
    activity: +(moves / trans).toFixed(2),
    straight: +(net / Math.max(1, moves)).toFixed(2),
    trait: traitOf(moves, net),
    endTower: endTowerOf(j, boards),
  };
  return feat;
}

function traitOf(moves: number, net: number): Trait {
  if (moves === 0) return "frozen";
  if (net >= 6) return "traveler";
  if (net <= 3 && moves >= 8) return "pacer";
  if (net <= 2) return "idle";
  return "drifter";
}

// what the grunt's final tile sits next to at its death frame
function endTowerOf(
  j: Journey,
  boards: Record<string, Board>,
): Feat["endTower"] {
  const board = boards[String(j.deathFrame)];
  if (!board) return "none";
  const end = j.pts[j.pts.length - 1];
  let dead = false;
  for (const t of board.towers) {
    if (fp2x2(t.r, t.c).some((f) => manh(f, end) <= 1)) {
      if (t.state === "alive") return "alive";
      dead = true;
    }
  }
  return dead ? "dead" : "none";
}

function report(all: Feat[]): void {
  const n = all.length;
  const pct = (k: number) => `${k} (${n ? Math.round((100 * k) / n) : 0}%)`;
  const by = (t: Trait) => all.filter((f) => f.trait === t);
  console.log(`# journeys=${n}`);
  console.log(`\n# BEHAVIOR TRAITS:`);
  for (const t of [
    "traveler",
    "drifter",
    "pacer",
    "idle",
    "frozen",
  ] as Trait[]) {
    const g = by(t);
    const camp = g.filter((f) => f.endTower === "dead").length;
    const siege = g.filter((f) => f.endTower === "alive").length;
    console.log(
      `  ${t.padEnd(9)} ${pct(g.length).padEnd(11)} ` +
        `ended: ${siege} on alive-tower, ${camp} camped on dead-tower`,
    );
  }
  const interesting = all.filter(
    (f) => f.trait === "traveler" || f.trait === "drifter",
  );
  const noise = n - interesting.length;
  console.log(
    `\n# SIGNAL vs NOISE: interesting (traveler+drifter)=${pct(interesting.length)}, ` +
      `noise (pacer+idle+frozen)=${pct(noise)}`,
  );
  console.log(
    `# dead-tower campers (killed target, then sat): ` +
      `${all.filter((f) => f.endTower === "dead").length}`,
  );

  // distinct-types probe: are activity / directedness bimodal?
  console.log(
    `\n# ACTIVITY (fraction of steps that moved) — bimodal => distinct types?`,
  );
  histogram(
    all.map((f) => f.activity),
    0,
    1,
    10,
  );
  console.log(`# DIRECTEDNESS (net / moves; 1=straight, 0=pace) over movers:`);
  histogram(
    all.filter((f) => f.moves > 0).map((f) => f.straight),
    0,
    1,
    10,
  );

  console.log(`\n# top travelers:`);
  for (const f of interesting.sort((a, b) => b.net - a.net).slice(0, 10)) {
    console.log(
      `  ${f.game}#${f.id}  net=${f.net} moves=${f.moves} life=${f.life} ` +
        `activity=${f.activity} straight=${f.straight} end=${f.endTower}`,
    );
  }
}

function histogram(xs: number[], lo: number, hi: number, bins: number): void {
  const counts = new Array(bins).fill(0);
  for (const x of xs) {
    let b = Math.floor(((x - lo) / (hi - lo)) * bins);
    if (b < 0) b = 0;
    if (b >= bins) b = bins - 1;
    counts[b]++;
  }
  const max = Math.max(1, ...counts);
  for (let i = 0; i < bins; i++) {
    const a = (lo + (i / bins) * (hi - lo)).toFixed(1);
    const bar = "#".repeat(Math.round((counts[i] / max) * 40));
    console.log(
      `  ${a}-${(lo + ((i + 1) / bins) * (hi - lo)).toFixed(1)} ${String(counts[i]).padStart(4)} ${bar}`,
    );
  }
}
