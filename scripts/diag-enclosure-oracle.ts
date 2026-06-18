/**
 * Enclosure-disagreement oracle (measurement only — changes no behavior).
 *
 * Quantifies the `findReachableRingGaps` under-count that drives the AI
 * build-phase failures (the idle rounds AND the over-build stalls): the AI
 * commits to closing a tower, fills every gap the function reports, yet the
 * tower never encloses — the reported gap-set, fully filled, doesn't actually
 * seal the ring (dropped-unfillable tiles or diagonal leaks leave a hole).
 *
 * Outcome-based and faithful: it does NOT reconstruct the AI's rect pipeline
 * (which applies expandRectAroundBlockers / clampRectOffPits — easy to get
 * wrong). Instead it observes the AI's REAL decisions via the build diag hook
 * (`target-selected` carries the actual expanded targetRect + targetGaps) and
 * the REAL outcome via the `TOWER_ENCLOSED` bus event.
 *
 * For each (round, player, tower) the AI committed to closing (HOME or SEC
 * path), using the LAST target-selected snapshot that round:
 *   gapEncloses = trulyEncloses(W ∪ targetGaps)   ← would filling the AI's own
 *                                                    final gap-set close it?
 *   cfgEncloses = trulyEncloses(W ∪ computeFillableGaps(targetRect, W, bank=t))
 *                                                  ← does the plug-sealed set?
 *   trulyEncloses = footprint ∉ computeOutside(walls)  (8-dir, scoring's notion)
 *
 * Buckets (a tower the AI committed to but did NOT enclose by round end):
 *   closed     — enclosed that round → success, no leak.
 *   timing     — not enclosed, but its final gap-set WOULD have enclosed →
 *                ran out of ticks, NOT a gap-function bug.
 *   plug_fixes — leak the plug-seal (computeFillableGaps) would have closed →
 *                the cheap "#1" fix recovers it.
 *   boxed      — leak, but terrain genuinely can't seal it (!isTowerEnclosable).
 *   predictive — leak on sealable terrain that neither the AI's gap-set nor the
 *                plug-seal closes → needs rect expansion / a predictive
 *                enclosure check (the reverted, high-risk fix).
 *
 * The plug_fixes vs predictive split among leaks is the decision input: high
 * plug_fixes ⇒ the cheap fix recovers most of the loss; high predictive ⇒ only
 * the deep fix moves the needle.
 *
 *   deno run -A scripts/diag-enclosure-oracle.ts [seed ...]
 *
 * Default = the 6 idle-flagged seeds + 4 stall/representative seeds. Runs
 * sequentially (~14s/seed); pass fewer/specific seeds to focus.
 */

import { setAiBuildDiagHook } from "../src/ai/ai-build-diag.ts";
import {
  computeFillableGaps,
  isTowerEnclosable,
} from "../src/ai/ai-castle-rect.ts";
import { TOWER_SIZE } from "../src/shared/core/game-constants.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import type { Tower } from "../src/shared/core/geometry-types.ts";
import type { TileKey } from "../src/shared/core/grid.ts";
import { getInterior } from "../src/shared/sim/player-interior.ts";
import { computeOutside, packTile } from "../src/shared/core/spatial.ts";
import { createScenario, waitForEvent } from "../test/scenario.ts";

type Verdict = "closed" | "timing" | "plugFixes" | "boxed" | "predictive";

interface Buckets {
  committed: number;
  closed: number;
  timing: number;
  plugFixes: number;
  boxed: number;
  predictive: number;
}

interface CommitSnapshot {
  round: number;
  pid: number;
  towerIdx: number;
  pos: string;
  gapEncloses: boolean;
  cfgEncloses: boolean;
  enclosable: boolean;
}

interface Example {
  seed: number;
  round: number;
  player: string;
  tower: number;
  pos: string;
  bucket: Verdict;
}

const DEFAULT_SEEDS = [
  // 6 idle-flagged seeds
  100, 147323, 314159, 409946, 6959185, 9142064,
  // 4 stall/representative seeds
  42, 555555, 921118, 7082653,
];
const PLAYER_NAMES = ["RED", "BLUE", "GOLD"] as const;
const ROUNDS = 30;

main();

async function main(): Promise<void> {
  const seeds = Deno.args.length > 0 ? Deno.args.map(Number) : DEFAULT_SEEDS;
  const totals = emptyBuckets();
  const examples: Example[] = [];

  console.log(
    `enclosure-oracle: ${seeds.length} seeds × ${ROUNDS} rounds, modern\n`,
  );
  for (const seed of seeds) {
    const b = await runSeed(seed, totals, examples);
    const leaks = b.plugFixes + b.predictive;
    console.log(
      `  seed=${String(seed).padStart(8)}: ${String(b.committed).padStart(4)} committed | closed ${b.closed} | timing ${b.timing} | plug ${b.plugFixes} | predictive ${b.predictive} | boxed ${b.boxed}  (leaks=${leaks})`,
    );
  }

  const leaks = totals.plugFixes + totals.predictive;
  console.log(`\n=== TOTALS (${seeds.length} seeds) ===`);
  console.log(`tower-close commitments (HOME/SEC):   ${totals.committed}`);
  console.log(
    `  closed     (enclosed that round):  ${totals.closed}  (${pct(totals.closed, totals.committed)})`,
  );
  console.log(
    `  timing     (gap-set ok, ran out):  ${totals.timing}  (${pct(totals.timing, totals.committed)})`,
  );
  console.log(
    `  plug_fixes (#1 plug-seal closes):  ${totals.plugFixes}  (${pct(totals.plugFixes, totals.committed)})`,
  );
  console.log(
    `  predictive (needs deeper fix):     ${totals.predictive}  (${pct(totals.predictive, totals.committed)})`,
  );
  console.log(
    `  boxed      (terrain-unenclosable): ${totals.boxed}  (${pct(totals.boxed, totals.committed)})`,
  );
  console.log(
    `\nleaks (gap-set fully filled still doesn't enclose a sealable tower) = ${leaks}  (${pct(leaks, totals.committed)} of commitments)`,
  );
  if (leaks > 0) {
    console.log(
      `  of leaks: ${pct(totals.plugFixes, leaks)} fixable by plug-seal (#1), ${pct(totals.predictive, leaks)} need the predictive/rect-expansion fix`,
    );
  }

  if (examples.length > 0) {
    console.log(`\n=== leak/boxed examples (first 24) ===`);
    for (const ex of examples.slice(0, 24)) {
      console.log(
        `  ${ex.bucket.padEnd(10)} seed=${ex.seed} r${ex.round} ${ex.player} T${ex.tower}${ex.pos}`,
      );
    }
  }
}

async function runSeed(
  seed: number,
  totals: Buckets,
  examples: Example[],
): Promise<Buckets> {
  const seedBuckets = emptyBuckets();
  // Latest commit snapshot per (round, pid, towerIdx); the AI's final word.
  const commits = new Map<string, CommitSnapshot>();
  const enclosed = new Set<string>();
  using sc = await createScenario({ seed, mode: "modern", rounds: ROUNDS + 1 });

  setAiBuildDiagHook((event) => {
    if (event.kind !== "target-selected") return;
    if (event.path !== "HOME" && event.path !== "SEC") return;
    if (event.targetRect === null || event.targetGaps.size === 0) return;
    const state = sc.state;
    const player = state.players[event.playerId];
    if (!player) return;
    const tower =
      event.path === "HOME"
        ? player.homeTower
        : event.chosenTowerIndex !== undefined
          ? state.map.towers[event.chosenTowerIndex]
          : undefined;
    if (!tower) return;
    const walls = player.walls;
    const gapEncloses = trulyEncloses(
      tower,
      unionWalls(walls, event.targetGaps),
    );
    const cfg = computeFillableGaps(
      event.targetRect,
      walls,
      getInterior(player),
      state,
      true,
    );
    const cfgEncloses = trulyEncloses(tower, unionWalls(walls, cfg));
    commits.set(`${event.round}:${event.playerId}:${tower.index}`, {
      round: event.round,
      pid: event.playerId,
      towerIdx: tower.index,
      pos: `(${tower.row},${tower.col})`,
      gapEncloses,
      cfgEncloses,
      enclosable: isTowerEnclosable(tower, state),
    });
  });
  sc.bus.on(GAME_EVENT.TOWER_ENCLOSED, (ev) => {
    enclosed.add(`${sc.state.round}:${ev.playerId}:${ev.towerIndex}`);
  });

  waitForEvent(
    sc,
    GAME_EVENT.PHASE_START,
    (ev) => ev.phase === Phase.WALL_BUILD && sc.state.round === ROUNDS,
    { timeoutMs: 200_000 * (ROUNDS + 1), label: `seed=${seed} r${ROUNDS} WB` },
  );
  waitForEvent(sc, GAME_EVENT.ROUND_END, (ev) => ev.round === ROUNDS, {
    timeoutMs: 90_000,
    label: `seed=${seed} r${ROUNDS} end`,
  });
  setAiBuildDiagHook(undefined);

  for (const [key, snap] of commits) {
    const verdict = classify(snap, enclosed, key);
    seedBuckets.committed++;
    seedBuckets[verdict]++;
    if (
      verdict === "plugFixes" ||
      verdict === "boxed" ||
      verdict === "predictive"
    ) {
      examples.push({
        seed,
        round: snap.round,
        player: PLAYER_NAMES[snap.pid]!,
        tower: snap.towerIdx,
        pos: snap.pos,
        bucket: verdict,
      });
    }
  }

  totals.committed += seedBuckets.committed;
  totals.closed += seedBuckets.closed;
  totals.timing += seedBuckets.timing;
  totals.plugFixes += seedBuckets.plugFixes;
  totals.boxed += seedBuckets.boxed;
  totals.predictive += seedBuckets.predictive;
  return seedBuckets;
}

function emptyBuckets(): Buckets {
  return {
    committed: 0,
    closed: 0,
    timing: 0,
    plugFixes: 0,
    boxed: 0,
    predictive: 0,
  };
}

/** Ground truth: with wall set `walls`, is the tower enclosed? True iff no
 *  footprint tile is reachable from the map border under the 8-dir flood —
 *  the same notion territory scoring uses (interior = not outside). */
function trulyEncloses(tower: Tower, walls: ReadonlySet<TileKey>): boolean {
  const outside = computeOutside(walls);
  return footprintKeys(tower).every((key) => !outside.has(key));
}

function footprintKeys(tower: Tower): TileKey[] {
  const keys: TileKey[] = [];
  for (let r = tower.row; r < tower.row + TOWER_SIZE; r++) {
    for (let c = tower.col; c < tower.col + TOWER_SIZE; c++) {
      keys.push(packTile(r, c));
    }
  }
  return keys;
}

function unionWalls(
  walls: ReadonlySet<TileKey>,
  gaps: ReadonlySet<TileKey>,
): Set<TileKey> {
  const union = new Set<TileKey>(walls);
  for (const key of gaps) union.add(key);
  return union;
}

function classify(
  snap: CommitSnapshot,
  enclosed: Set<string>,
  key: string,
): Verdict {
  if (enclosed.has(key)) return "closed";
  if (snap.gapEncloses) return "timing";
  if (snap.cfgEncloses) return "plugFixes";
  if (!snap.enclosable) return "boxed";
  return "predictive";
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "—" : `${((100 * part) / whole).toFixed(1)}%`;
}
