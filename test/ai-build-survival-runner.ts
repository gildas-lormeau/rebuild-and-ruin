/**
 * Shared engine for the AI build-survival suite. Imported by both the test
 * file (which registers one Deno.test per seed) and the worker (which actually
 * runs `runSeed` on a background thread). See ai-build-survival.test.ts for
 * the stall-fingerprint background and the rationale for the 26-seed set.
 */

import { createScenario, waitForEvent } from "./scenario.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { GRID_COLS, GRID_ROWS, type TileKey } from "../src/shared/core/grid.ts";
import { DIRS_4, packTile, unpackTile } from "../src/shared/core/spatial.ts";
import { setAiBuildDiagHook } from "../src/ai/ai-build-diag.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";

export interface PathCounts {
  HOME: number;
  SEC: number;
  EXP: number;
  STRAT_RECT: number;
  STRAT_NONE: number;
}

/** One selectTarget call captured from the per-player trajectory: which path
 *  fired, which rect was returned (key is a compact "t,l-b,r" string), and
 *  how many gaps the result asked the AI to close. Used post-round to
 *  classify the stall sub-mode (PLATEAU / SWITCH / PROGRESS / etc.). */
export interface TrajectoryTick {
  path: "HOME" | "SEC" | "EXP" | "STRAT_RECT" | "STRAT_NONE";
  rectKey: string;
  gaps: number;
  /** Piece-shape name from the target-selected event — drives flip-cause
   *  derivation (piece-changed vs score-rerank). */
  pieceShapeName: string;
}

/** Per-stall flip-cause record. A flip = a tick where the target rect
 *  differs from the previous tick. Cause classification:
 *  - phase-switch: prev OR current path was STRAT_NONE (no target either way)
 *  - piece-changed: piece shape rolled in this tick triggered the re-decision
 *  - score-rerank: same piece, different rect — proximity scoring re-ranked
 *    towers (classic Mode #2 churn signal). */
export type FlipCause = "piece-changed" | "score-rerank" | "phase-switch";

export interface FlipEvent {
  tick: number;
  cause: FlipCause;
  from: string;
  to: string;
}

/** Per-placement record sampled from the wall-placed diag event. cellsInGap
 *  + adjToExistingWall + isolated split the placement into three buckets that
 *  shouldn't overlap when summed correctly: a placement either contributes to
 *  a target gap, sits next to an existing wall, or scatters (none of the
 *  above). Used in the per-stall continuation line to surface the
 *  "where do fallback walls actually go?" diagnostic. */
export interface PlacementRecord {
  cellCount: number;
  hitTargetGap: boolean;
  cellsInGap: number;
  adjToExistingWall: boolean;
  isolated: boolean;
  /** True if at least one placement cell lay on the target rect's wall-ring
   *  perimeter. Distinguishes "wall extends the committed ring" from
   *  "wall lands wall-adjacent elsewhere on the player's wall set" — the
   *  existing adjToExistingWall conflates them. */
  onRingPerimeter: boolean;
  pieceShapeName: string;
}

export interface RoundRow {
  walls: number;
  enclosures: number;
  unownedAliveZoneTowers: number;
  lostLifeThisRound: boolean;
  livesAtRoundEnd: number;
  pathCounts: PathCounts;
  trajectory: TrajectoryTick[];
  /** Aggregator for the upcoming-piece × target-fit signal. Each tick adds
   *  the count of upcoming pieces that COULD fill the current target to
   *  the numerator, and the total upcoming-piece count to the denominator.
   *  Round-level fit fraction = numerator / denominator. Zero
   *  denominator = no upcoming pieces ever peeked this round (target was
   *  null/empty every tick, or bag was empty). Distinguishes "the bag will
   *  solve this ring eventually" (high fit) from "no near-term piece can
   *  help" (low fit, NEAR_MISS signature). */
  upcomingFitNumerator: number;
  upcomingFitDenominator: number;
  placements: PlacementRecord[];
  /** Per-tick comparison: did any alternative secondary-tower candidate have a
   *  strictly higher bag-fit than the chosen tower? Captured only on ticks
   *  where chosenTowerIndex is set AND alternatives is non-empty (i.e. SEC
   *  path with a real candidate enumeration). Each entry records the chosen
   *  tower's bag-fit ratio and the best alternative's bag-fit ratio. Lets the
   *  analyzer answer: "of stall ticks where the AI committed to a tower, how
   *  often was a better-fit alternative available?" */
  altCompare: { chosenBagFit: number; bestAltBagFit: number; denom: number }[];
}

export interface PlayerSummary {
  enclosures: number;
  livesEnd: number;
  activeRounds: number;
}

export interface SeedFindings {
  stalls: string[];
  perPlayer: PlayerSummary[];
  /** One-line aggregate per seed for eyeball-diff between runs. Sums + medians
   *  of the diagnostic signals across this seed's stalls. Empty when no
   *  stalls — the aggregates are uninteresting for clean seeds. */
  diagSummary: string;
}

export interface SeedResult {
  seed: number;
  findings: SeedFindings;
  /** Highest round number for which any per-round data was recorded. */
  lastRound: number;
  /** Number of rounds for which data was recorded (≤ ROUNDS_TO_PLAY). */
  roundsRecorded: number;
}

const DEFAULT_SEEDS = [
  42, 100, 147323, 203607, 314159, 409946, 510296, 550021, 555555, 634446,
  677242, 700000, 833681, 921118, 1234567, 1364287, 1992148, 2468171, 3020266,
  3391887, 3480269, 4514090, 4778786, 5923908, 6959185, 7082653, 7126930,
  7260128, 7414600, 7777777, 8055250, 8114943, 8815892, 9083713, 9142064,
  9364665, 9468552, 9634092, 9862896, 9974133,
] as const;
/** Active seed set. Overridable via `AI_SURVIVAL_SEEDS=42,100,9142064` —
 *  restricts BOTH the worker dispatch and the Deno.test registration, so
 *  filter-style runs (`AI_SURVIVAL_SEEDS=9142064 npm test`) actually skip the
 *  other seeds rather than running them and discarding results. Necessary
 *  for capturing trace logs without multi-seed interleaving. */
export const SEEDS: readonly number[] = parseSeedsFromEnv() ?? DEFAULT_SEEDS;
export const ROUNDS_TO_PLAY = 30;
/** Wall-placement volume that signals the AI was actively building (~one
 *  full piece bag for a round). */
export const STALL_WALL_THRESHOLD = 25;
/** Sim-ms budget for 30 rounds (~70s/round × safety margin). */
export const RUN_BUDGET_MS = 5_500_000;
export const PLAYER_NAMES = ["RED", "BLUE", "GOLD"] as const;

export async function runAndAnalyze(seed: number): Promise<SeedResult> {
  const perRound = await runSeed(seed);
  const findings = analyzeSeed(seed, perRound);
  const rounds = [...perRound.keys()].sort((a, b) => a - b);
  const lastRound = rounds[rounds.length - 1] ?? 0;
  return { seed, findings, lastRound, roundsRecorded: rounds.length };
}

export function formatSummaryLine(result: SeedResult): string {
  const { seed, findings, lastRound, roundsRecorded } = result;
  const perPlayer = PLAYER_NAMES.map(
    (name, i) =>
      `${name}:enc=${findings.perPlayer[i]!.enclosures} lives=${findings.perPlayer[i]!.livesEnd} active=${findings.perPlayer[i]!.activeRounds}`,
  ).join(" | ");
  return `seed=${seed} rounds=${roundsRecorded}/${ROUNDS_TO_PLAY} (last=r${lastRound}) ${perPlayer}`;
}

function parseSeedsFromEnv(): readonly number[] | null {
  const env = Deno.env.get("AI_SURVIVAL_SEEDS");
  if (!env || env.trim() === "") return null;
  const seeds = env
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const n = Number(s);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        throw new Error(`Invalid seed in AI_SURVIVAL_SEEDS: "${s}"`);
      }
      return n;
    });
  return seeds.length > 0 ? seeds : null;
}

async function runSeed(seed: number): Promise<Map<number, RoundRow[]>> {
  const sc = await createScenario({
    seed,
    mode: "modern",
    rounds: ROUNDS_TO_PLAY + 1,
  });

  const perRound = new Map<number, RoundRow[]>();
  const getRow = (round: number): RoundRow[] => {
    let row = perRound.get(round);
    if (!row) {
      row = [0, 1, 2].map(
        (): RoundRow => ({
          walls: 0,
          enclosures: 0,
          unownedAliveZoneTowers: 0,
          lostLifeThisRound: false,
          livesAtRoundEnd: 0,
          pathCounts: { HOME: 0, SEC: 0, EXP: 0, STRAT_RECT: 0, STRAT_NONE: 0 },
          trajectory: [],
          upcomingFitNumerator: 0,
          upcomingFitDenominator: 0,
          placements: [],
          altCompare: [],
        }),
      );
      perRound.set(round, row);
    }
    return row;
  };

  setAiBuildDiagHook((event) => {
    if (event.kind === "target-selected") {
      const row = getRow(event.round)[event.playerId]!;
      row.pathCounts[event.path]++;
      const rect = event.targetRect;
      row.trajectory.push({
        path: event.path,
        rectKey: rect
          ? `${rect.top},${rect.left}-${rect.bottom},${rect.right}`
          : "",
        gaps: event.targetGaps.size,
        pieceShapeName: event.currentPieceShapeName,
      });
      if (event.upcomingPieceFitsTarget.length > 0) {
        const fits = event.upcomingPieceFitsTarget.filter((b) => b).length;
        row.upcomingFitNumerator += fits;
        row.upcomingFitDenominator += event.upcomingPieceFitsTarget.length;
      }
      // Per-tick chosen-vs-alternatives capture. Only meaningful when the AI
      // actually committed to a secondary (chosenTowerIndex set) AND the
      // alternatives snapshot is non-empty. The best alternative excludes
      // the chosen tower itself so the comparison answers "could a different
      // tower have done better?" rather than self-comparison.
      if (
        event.chosenTowerIndex !== undefined &&
        event.alternatives.length > 0
      ) {
        const chosenAlt = event.alternatives.find(
          (a) => a.towerIdx === event.chosenTowerIndex,
        );
        const denom = chosenAlt?.bagFitDenom ?? 0;
        if (chosenAlt && denom > 0 && chosenAlt.bagFit >= 0) {
          let bestAlt = -1;
          for (const a of event.alternatives) {
            if (a.towerIdx === event.chosenTowerIndex) continue;
            if (a.bagFitDenom !== denom) continue;
            if (a.bagFit > bestAlt) bestAlt = a.bagFit;
          }
          if (bestAlt >= 0) {
            row.altCompare.push({
              chosenBagFit: chosenAlt.bagFit,
              bestAltBagFit: bestAlt,
              denom,
            });
          }
        }
      }
      return;
    }
    if (event.kind === "wall-placed") {
      const row = getRow(event.round)[event.playerId]!;
      const walls = sc.state.players[event.playerId]?.walls ?? new Set();
      row.placements.push(
        classifyPlacement(
          event.cells,
          event.targetGaps,
          walls,
          event.cellsOnRingPerimeter,
          event.pieceShapeName,
        ),
      );
      return;
    }
  });

  sc.bus.on(GAME_EVENT.WALL_PLACED, (ev) => {
    getRow(sc.state.round)[ev.playerId]!.walls += ev.tileKeys.length;
  });
  sc.bus.on(GAME_EVENT.TOWER_ENCLOSED, (ev) => {
    getRow(sc.state.round)[ev.playerId]!.enclosures += 1;
  });
  sc.bus.on(GAME_EVENT.LIFE_LOST, (ev) => {
    getRow(ev.round)[ev.playerId]!.lostLifeThisRound = true;
  });
  // ROUND_END fires inside finalizeRound, AFTER finalizeTerritoryWithScoring
  // but also AFTER applyLifePenalties — so for life-losing players the zone
  // has already been reset and ownedTowers is empty. Capture unowned-alive
  // count here; the analyzer filters life-lost rounds separately.
  sc.bus.on(GAME_EVENT.ROUND_END, (ev) => {
    const row = getRow(ev.round);
    for (let pid = 0 as ValidPlayerId; pid < 3; pid = (pid + 1) as ValidPlayerId) {
      const player = sc.state.players[pid];
      if (!player) continue;
      row[pid]!.livesAtRoundEnd = player.lives;
      const home = player.homeTower;
      if (!home) {
        row[pid]!.unownedAliveZoneTowers = 0;
        continue;
      }
      const ownedSet = new Set(player.ownedTowers.map((tower) => tower.index));
      let unownedAlive = 0;
      for (const tower of sc.state.map.towers) {
        if (tower.zone !== home.zone) continue;
        if (!sc.state.towerAlive[tower.index]) continue;
        if (ownedSet.has(tower.index)) continue;
        unownedAlive++;
      }
      row[pid]!.unownedAliveZoneTowers = unownedAlive;
    }
  });

  try {
    waitForEvent(
      sc,
      GAME_EVENT.PHASE_START,
      (ev) =>
        ev.phase === Phase.WALL_BUILD && sc.state.round === ROUNDS_TO_PLAY,
      { timeoutMs: RUN_BUDGET_MS, label: `seed=${seed} r${ROUNDS_TO_PLAY} WB` },
    );
    waitForEvent(
      sc,
      GAME_EVENT.ROUND_END,
      (ev) => ev.round === ROUNDS_TO_PLAY,
      { timeoutMs: 90_000, label: `seed=${seed} r${ROUNDS_TO_PLAY} end` },
    );
  } catch {
    // Game may have ended early via last-player-standing — partial data fine.
  } finally {
    setAiBuildDiagHook(undefined);
  }
  return perRound;
}

/** Classify an AI placement against the active targetGaps + existing walls.
 *  hitTargetGap + adjToExistingWall together expose the "where do fallback
 *  walls actually go?" diagnostic — a high isolated% on NEAR_MISS stalls
 *  would point at scatter, while high adj-wall% with low gap-hit% would
 *  point at scoring chasing existing walls without closing the ring. */
function classifyPlacement(
  cells: readonly TileKey[],
  targetGaps: ReadonlySet<TileKey>,
  walls: ReadonlySet<TileKey>,
  cellsOnRingPerimeter: number,
  pieceShapeName: string,
): PlacementRecord {
  let cellsInGap = 0;
  let adjToExistingWall = false;
  let adjToTargetGap = false;
  for (const cell of cells) {
    if (targetGaps.has(cell)) cellsInGap++;
    const { row, col } = unpackTile(cell);
    for (const [dr, dc] of DIRS_4) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
      const nkey = packTile(nr, nc);
      if (walls.has(nkey)) adjToExistingWall = true;
      if (targetGaps.has(nkey)) adjToTargetGap = true;
    }
  }
  return {
    cellCount: cells.length,
    hitTargetGap: cellsInGap > 0,
    cellsInGap,
    adjToExistingWall,
    isolated: !adjToExistingWall && !adjToTargetGap && cellsInGap === 0,
    onRingPerimeter: cellsOnRingPerimeter > 0,
    pieceShapeName,
  };
}

function analyzeSeed(
  seed: number,
  perRound: Map<number, RoundRow[]>,
): SeedFindings {
  const rounds = [...perRound.keys()].sort((a, b) => a - b);
  const stalls: string[] = [];
  const perPlayer: PlayerSummary[] = [0, 1, 2].map(() => ({
    enclosures: 0,
    livesEnd: 0,
    activeRounds: 0,
  }));
  // Per-stall aggregates for the seed-level diag summary line.
  const gapHitPcts: number[] = [];
  const bagFitPcts: number[] = [];
  const altBetterPcts: number[] = [];
  let totalFlips = 0;
  for (let pid = 0; pid < 3; pid++) {
    for (const round of rounds) {
      const row = perRound.get(round)![pid]!;
      perPlayer[pid]!.enclosures += row.enclosures;
      if (row.walls > 0) perPlayer[pid]!.activeRounds += 1;
      perPlayer[pid]!.livesEnd = row.livesAtRoundEnd;
      // Stall: built actively, fired no enclosure this round despite having
      // ≥1 alive unowned tower available to enclose, didn't lose a life
      // (zone reset would clear ownedTowers and confuse the metric).
      if (
        row.walls >= STALL_WALL_THRESHOLD &&
        row.enclosures === 0 &&
        row.unownedAliveZoneTowers >= 1 &&
        !row.lostLifeThisRound &&
        row.livesAtRoundEnd > 0
      ) {
        const cls = classifyStall(row.pathCounts);
        const sub = classifySubMode(row.trajectory);
        const pc = row.pathCounts;
        const walls = formatPlacementSummary(row.placements);
        const flips = deriveFlips(row.trajectory);
        const flipStr = formatFlipSummary(flips);
        const bagFitPct =
          row.upcomingFitDenominator > 0
            ? Math.round(
                (100 * row.upcomingFitNumerator) / row.upcomingFitDenominator,
              )
            : -1;
        const bagFitStr = bagFitPct >= 0 ? ` | bag-fit=${bagFitPct}%` : "";
        const altStr = formatAltCompareSummary(row.altCompare);
        const altBetterPct = computeAltBetterPct(row.altCompare);
        stalls.push(
          `seed=${seed} r${round} ${PLAYER_NAMES[pid]}: ${row.walls} walls placed, 0 enclosures fired, ${row.unownedAliveZoneTowers} alive unowned tower(s) available, lives=${row.livesAtRoundEnd} | paths H=${pc.HOME} S=${pc.SEC} E=${pc.EXP} SR=${pc.STRAT_RECT} SN=${pc.STRAT_NONE} → ${cls.kind} (${cls.detail}) | sub-mode ${sub.kind} (${sub.detail})\n  diag: walls ${walls}${bagFitStr}${altStr} | flips ${flipStr}`,
        );
        if (row.placements.length > 0) {
          const hits = row.placements.filter((p) => p.hitTargetGap).length;
          gapHitPcts.push(Math.round((100 * hits) / row.placements.length));
        }
        totalFlips += flips.length;
        if (bagFitPct >= 0) bagFitPcts.push(bagFitPct);
        if (altBetterPct >= 0) altBetterPcts.push(altBetterPct);
      }
    }
  }
  const bagFitMedianStr =
    bagFitPcts.length > 0 ? ` | bag-fit median ${median(bagFitPcts)}%` : "";
  const diagSummary =
    stalls.length > 0
      ? `DIAG seed=${seed}: ${stalls.length} stalls | gap-hit median ${median(gapHitPcts)}% | flips total ${totalFlips}${bagFitMedianStr}${altBetterPcts.length > 0 ? ` | alt-better median ${median(altBetterPcts)}%` : ""}`
      : "";
  return { stalls, perPlayer, diagSummary };
}

/** Format the per-stall alt-compare aggregator into a continuation-line
 *  fragment: `| alt: chosen-bf=X% best-alt-bf=Y% better=Z/N`. Empty when no
 *  per-tick alt comparisons were captured (no chosenTowerIndex set during
 *  this stall, or alternatives were empty every tick — e.g. a stall that
 *  spent all ticks in STRATEGIC_RECT path without committing to a SEC tower).
 *  X = median chosen bag-fit% across compared ticks. Y = median best-alt
 *  bag-fit% across compared ticks. Z = number of ticks where best-alt
 *  strictly beat chosen. N = total compared ticks. */
function formatAltCompareSummary(
  compares: readonly {
    chosenBagFit: number;
    bestAltBagFit: number;
    denom: number;
  }[],
): string {
  if (compares.length === 0) return "";
  const chosenPcts: number[] = [];
  const bestAltPcts: number[] = [];
  let betterCount = 0;
  for (const c of compares) {
    chosenPcts.push(Math.round((100 * c.chosenBagFit) / c.denom));
    bestAltPcts.push(Math.round((100 * c.bestAltBagFit) / c.denom));
    if (c.bestAltBagFit > c.chosenBagFit) betterCount++;
  }
  return ` | alt: chosen-bf=${median(chosenPcts)}% best-alt-bf=${median(bestAltPcts)}% better=${betterCount}/${compares.length}`;
}

/** Per-stall "what fraction of compared ticks had a strictly better
 *  alternative?" as a percentage. -1 when no compared ticks (no chosen-vs-
 *  alternatives data for this stall). */
function computeAltBetterPct(
  compares: readonly {
    chosenBagFit: number;
    bestAltBagFit: number;
    denom: number;
  }[],
): number {
  if (compares.length === 0) return -1;
  let better = 0;
  for (const c of compares) {
    if (c.bestAltBagFit > c.chosenBagFit) better++;
  }
  return Math.round((100 * better) / compares.length);
}

/** Sample median across an array. Empty array → 0 (the diagSummary line
 *  only includes the median when stalls exist, so an empty array means the
 *  caller didn't collect any samples). */
function median(arr: readonly number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

/** Derive the flip-event list from a trajectory. A flip is any tick whose
 *  rectKey differs from the previous tick's. Cause classification follows
 *  the priority order specified in the design: phase-switch (no target on
 *  either side) → piece-changed (new bag piece this tick) → score-rerank
 *  (same piece, different rect — Mode #2 churn). */
function deriveFlips(traj: readonly TrajectoryTick[]): FlipEvent[] {
  const flips: FlipEvent[] = [];
  for (let i = 1; i < traj.length; i++) {
    const prev = traj[i - 1]!;
    const cur = traj[i]!;
    if (prev.rectKey === cur.rectKey) continue;
    let cause: FlipCause;
    if (prev.path === "STRAT_NONE" || cur.path === "STRAT_NONE") {
      cause = "phase-switch";
    } else if (prev.pieceShapeName !== cur.pieceShapeName) {
      cause = "piece-changed";
    } else {
      cause = "score-rerank";
    }
    flips.push({ tick: i, cause, from: prev.rectKey, to: cur.rectKey });
  }
  return flips;
}

function formatFlipSummary(flips: readonly FlipEvent[]): string {
  if (flips.length === 0) return "no-flips";
  let piece = 0;
  let rerank = 0;
  let phase = 0;
  for (const flip of flips) {
    if (flip.cause === "piece-changed") piece++;
    else if (flip.cause === "score-rerank") rerank++;
    else phase++;
  }
  return `${flips.length} (piece=${piece} rerank=${rerank} phase=${phase})`;
}

/** Wall-placement distribution as a "X%/Y%/Z% (gap/adj/iso) on-ring=W%" string.
 *  Sums may exceed 100% because a single placement can both hit a gap AND be
 *  adjacent to a wall — buckets are NOT mutually exclusive. The isolated
 *  bucket IS exclusive (gap-hit=0 AND adj=0 AND no gap-neighbor). `on-ring`
 *  is an independent dimension: count of placements with ≥1 cell on the
 *  target rect's wall-ring perimeter, distinguishing "wall extends the
 *  committed ring" from "wall lands adjacent elsewhere on the player's wall
 *  set." */
function formatPlacementSummary(records: readonly PlacementRecord[]): string {
  if (records.length === 0) return "no-placements";
  const n = records.length;
  let hitGap = 0;
  let adjWall = 0;
  let isolated = 0;
  let onRing = 0;
  for (const record of records) {
    if (record.hitTargetGap) hitGap++;
    if (record.adjToExistingWall) adjWall++;
    if (record.isolated) isolated++;
    if (record.onRingPerimeter) onRing++;
  }
  const pct = (count: number, denom: number = n): string =>
    `${Math.round((100 * count) / denom)}%`;
  return `${pct(hitGap)}/${pct(adjWall)}/${pct(isolated)} (gap/adj/iso, n=${n}) on-ring=${pct(onRing)}`;
}

/** Classify a stall round by its gap-trajectory shape — distinct from
 *  `classifyStall` which only looks at the path-mix histogram. The trajectory
 *  view exposes plateaus (rect picked tick after tick with no gap drop) vs
 *  near-misses (a rect dropped to ≤5 gaps then got abandoned) vs progress
 *  timeouts. The labels are deliberately granular so a fix attempt's effect
 *  on each sub-mode is visible in the suite diff. Thresholds picked by
 *  inspecting 12 manually-traced stalls (see project_ai_build_stall_-
 *  investigation memory); raise them if the suite starts under-classifying. */
function classifySubMode(traj: readonly TrajectoryTick[]): {
  kind:
    | "PLATEAU"
    | "LATE_PLATEAU"
    | "MID_PLATEAU"
    | "NEAR_MISS"
    | "PROGRESS"
    | "SWITCH"
    | "OTHER"
    | "NO_DATA";
  detail: string;
} {
  if (traj.length === 0) return { kind: "NO_DATA", detail: "" };
  let longestStuck = 0;
  let endStuck = 0;
  for (let i = 1; i < traj.length; i++) {
    const sameRect = traj[i]!.rectKey === traj[i - 1]!.rectKey;
    const gapDropped = traj[i]!.gaps < traj[i - 1]!.gaps;
    if (sameRect && !gapDropped) {
      endStuck++;
      if (endStuck > longestStuck) longestStuck = endStuck;
    } else {
      endStuck = 0;
    }
  }
  // Per-rect gap range — sum of (max-min) across rects gives "total closing
  // work done", deduplicated across re-visits to the same rect.
  const rectGaps = new Map<string, { min: number; max: number }>();
  for (const tick of traj) {
    const cur = rectGaps.get(tick.rectKey);
    if (!cur) rectGaps.set(tick.rectKey, { min: tick.gaps, max: tick.gaps });
    else {
      if (tick.gaps < cur.min) cur.min = tick.gaps;
      if (tick.gaps > cur.max) cur.max = tick.gaps;
    }
  }
  let totalProgress = 0;
  for (const v of rectGaps.values()) totalProgress += v.max - v.min;
  const endRect = traj[traj.length - 1]!.rectKey;
  const endGap = traj[traj.length - 1]!.gaps;
  const ticks = traj.length;

  if (endStuck >= 8) {
    if (totalProgress >= 5)
      return {
        kind: "LATE_PLATEAU",
        detail: `${endStuck}t@${endGap}g, prior ${totalProgress}g drop`,
      };
    return { kind: "PLATEAU", detail: `${endStuck}t@${endGap}g` };
  }
  if (longestStuck >= 8)
    return { kind: "MID_PLATEAU", detail: `${longestStuck}t stuck mid-round` };
  // Near-miss abandonment: some rect reached ≤5 gaps but is not the current
  // rect — AI walked away from a nearly-closed ring. Surface the abandoned
  // gap count so the seed is easy to find in subsequent investigations.
  for (const [rectKey, gaps] of rectGaps) {
    if (rectKey !== endRect && gaps.min <= 5) {
      return {
        kind: "NEAR_MISS",
        detail: `abandoned rect at ${gaps.min}g, now on ${endRect || "?"}@${endGap}g`,
      };
    }
  }
  if (totalProgress >= 10 && longestStuck < 5)
    return {
      kind: "PROGRESS",
      detail: `${totalProgress}g closed over ${ticks}t (timeout)`,
    };
  if (rectGaps.size >= 2)
    return {
      kind: "SWITCH",
      detail: `${rectGaps.size} rects, ${totalProgress}g progress`,
    };
  return {
    kind: "OTHER",
    detail: `${ticks}t, ${totalProgress}g, stuck=${longestStuck}`,
  };
}

/** Classify a stall round by its selectTarget path-mix:
 *  - LOCK: one path took >70% of calls (AI was committed to one rect type).
 *  - CHURN: EXP fired >10% (state oscillated around fully-enclosed, AI flipped modes).
 *  - HYBRID: neither — multiple paths fire but EXP didn't get much.
 *  Reflects the lock-vs-churn taxonomy from the v4-A architectural investigation. */
function classifyStall(counts: PathCounts): {
  kind: "LOCK" | "CHURN" | "HYBRID";
  detail: string;
} {
  const total =
    counts.HOME +
    counts.SEC +
    counts.EXP +
    counts.STRAT_RECT +
    counts.STRAT_NONE;
  if (total === 0) return { kind: "HYBRID", detail: "no calls" };
  const entries = (
    ["HOME", "SEC", "EXP", "STRAT_RECT", "STRAT_NONE"] as const
  ).map((k) => ({ key: k, count: counts[k], pct: (counts[k] * 100) / total }));
  const top = entries.reduce((a, b) => (a.count > b.count ? a : b));
  if (top.pct > 70)
    return { kind: "LOCK", detail: `${top.key} ${top.pct.toFixed(0)}%` };
  const expPct = (counts.EXP * 100) / total;
  if (expPct > 10)
    return { kind: "CHURN", detail: `EXP ${expPct.toFixed(0)}%` };
  return {
    kind: "HYBRID",
    detail: entries
      .filter((e) => e.count > 0)
      .map((e) => `${e.key}=${e.count}`)
      .join("+"),
  };
}
