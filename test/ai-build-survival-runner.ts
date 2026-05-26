/**
 * Shared engine for the AI build-survival suite. Imported by both the test
 * file (which registers one Deno.test per seed) and the worker (which actually
 * runs `runSeed` on a background thread). See ai-build-survival.test.ts for
 * the stall-fingerprint background and the rationale for the 26-seed set.
 */

import { createScenario, waitForEvent } from "./scenario.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  Tile,
  type TileKey,
} from "../src/shared/core/grid.ts";
import { DIRS_4, packTile, unpackTile } from "../src/shared/core/spatial.ts";
import { setAiBuildDiagHook } from "../src/ai/ai-build-diag.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";
import { ALL_PIECE_SHAPES, type PieceShape } from "../src/shared/core/pieces.ts";
import type { TileRect } from "../src/shared/core/geometry-types.ts";
import {
  classifyIsolatedGapBlame,
  countIsolatedGaps,
  countNarrowPieces,
  solveWinnable,
} from "./winnability-solver.ts";

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
  /** Full rect dimensions from the target-selected event. Needed by the
   *  winnability solver to identify the plateau-start target rect and
   *  reconstruct its ring-gap set. Null when path is STRAT_NONE. */
  rect: TileRect | null;
  /** Snapshot of `event.targetGaps` at this tick — the solver consumes the
   *  plateau-start gap set directly (minus cells the focal player has
   *  already walled by plateau-start). Stored as the TileKey array form
   *  to avoid boxing a Set into structured-clone for worker postMessage. */
  gapKeys: readonly TileKey[];
  gaps: number;
  /** Piece-shape name from the target-selected event — drives flip-cause
   *  derivation (piece-changed vs score-rerank). */
  pieceShapeName: string;
  /** chosenTowerIndex from the target-selected event. Set only when
   *  trySecondaryTower committed to a tower meeting all persistence-cache
   *  invariants (alive, manageable gaps, piece-feasible); undefined for
   *  HOME/EXP/STRAT_* paths AND for SEC paths where the cache write was
   *  blocked (dead tower, > MANAGEABLE_GAP_LIMIT gaps). Used to derive
   *  cache-lifetime / invalidation aggregates per stall. */
  chosenTowerIndex: number | undefined;
  /** Monotonic event ordinal shared across target-selected + wall-placed
   *  events. Lets the solver reconstruct focal/enemy walls AS-OF plateau
   *  start: scan all placements with eventOrd < plateauTick.eventOrd. */
  eventOrd: number;
  /** Piece-shape names in the player's bag queue at this tick, in draw
   *  order (queue.reverse() applied — bag.queue is pop-ordered). Empty
   *  when the queue has no pieces left or the player slot has no bag. */
  bagQueue: readonly string[];
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
  /** Actual cells written by this placement. Needed by the winnability
   *  solver to reconstruct walls AS-OF plateau start (focal player's own
   *  walls + enemy walls placed before the plateau-tick eventOrd). */
  cells: readonly TileKey[];
  /** Monotonic event ordinal shared with TrajectoryTick.eventOrd. */
  eventOrd: number;
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
  /** Count of bus WALL_PLACED events seen this round (= actual piece commits).
   *  Pair with `placements.length` (= AI decisions captured via the diag
   *  wall-placed event from pickPlacement): `placements.length - commits` is
   *  the count of AI decisions that never reached commit, i.e. the cursor
   *  didn't arrive / dwell didn't complete before WALL_BUILD ended. Surfaces
   *  PROGRESS-mode stalls that the trajectory classifier currently buckets as
   *  LATE_PLATEAU because it only sees the next tick's re-decision. */
  commits: number;
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
  /** Count of `desperate-fired` diag events this round for this player.
   *  Surfaced inline by the diag hook (one log line per fire) so per-seed
   *  log files can identify games where the last-resort interior-discard
   *  fallback materially altered AI behavior. */
  desperateFires: number;
}

/** Per-round shared snapshot captured at WALL_BUILD entry. The winnability
 *  solver needs the focal player's wall set + a blocker set (enemy walls,
 *  towers, cannons, alive houses, pits) + the grass set (placeable tiles).
 *  Grass is map-static within a round but cannons/houses evolve across
 *  rounds, so a per-round capture keeps the cost bounded and the data fresh. */
export interface RoundSnapshot {
  initialWalls: Map<ValidPlayerId, ReadonlySet<TileKey>>;
  initialBlocked: ReadonlySet<TileKey>;
  initialGrass: ReadonlySet<TileKey>;
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
  /** Total `desperate-fired` diag events across all rounds + players for this
   *  seed. 0 when the desperate interior-discard fallback never triggered. */
  desperateFires: number;
  /** Per-player desperate-fired counts (length 3, indexed by ValidPlayerId).
   *  Lets downstream analysis attribute fires to specific players without
   *  re-walking `perRound`. */
  desperateFiresPerPlayer: number[];
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
  const { perRound, perRoundSnapshot } = await runSeed(seed);
  const findings = analyzeSeed(seed, perRound, perRoundSnapshot);
  const rounds = [...perRound.keys()].sort((a, b) => a - b);
  const lastRound = rounds[rounds.length - 1] ?? 0;
  return { seed, findings, lastRound, roundsRecorded: rounds.length };
}

export function formatSummaryLine(result: SeedResult): string {
  const { seed, findings, lastRound, roundsRecorded } = result;
  const perPlayer = PLAYER_NAMES.map(
    (name, i) => {
      const fires = findings.desperateFiresPerPlayer[i] ?? 0;
      const fireStr = fires > 0 ? ` desperate=${fires}` : "";
      return `${name}:enc=${findings.perPlayer[i]!.enclosures} lives=${findings.perPlayer[i]!.livesEnd} active=${findings.perPlayer[i]!.activeRounds}${fireStr}`;
    },
  ).join(" | ");
  const desperateTotal =
    findings.desperateFires > 0 ? ` desperate=${findings.desperateFires}` : "";
  return `seed=${seed} rounds=${roundsRecorded}/${ROUNDS_TO_PLAY} (last=r${lastRound})${desperateTotal} ${perPlayer}`;
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

async function runSeed(seed: number): Promise<{
  perRound: Map<number, RoundRow[]>;
  perRoundSnapshot: Map<number, RoundSnapshot>;
}> {
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
          commits: 0,
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
          desperateFires: 0,
        }),
      );
      perRound.set(round, row);
    }
    return row;
  };
  // Per-round shared snapshot taken at WALL_BUILD entry. Houses can die
  // across rounds and walls accumulate per player, so each round needs its
  // own snapshot to feed the offline winnability solver.
  const perRoundSnapshot = new Map<number, RoundSnapshot>();

  let eventOrd = 0;

  setAiBuildDiagHook((event) => {
    if (event.kind === "target-selected") {
      const row = getRow(event.round)[event.playerId]!;
      row.pathCounts[event.path]++;
      const rect = event.targetRect;
      // bag.queue is pop-ordered (.pop() returns last); reverse for draw
      // order so the solver sees the same sequence the AI will consume.
      const player = sc.state.players[event.playerId];
      const bagQueue = player?.bag
        ? player.bag.queue
            .slice()
            .reverse()
            .map((p) => p.name)
        : [];
      row.trajectory.push({
        path: event.path,
        rectKey: rect
          ? `${rect.top},${rect.left}-${rect.bottom},${rect.right}`
          : "",
        rect,
        gapKeys: [...event.targetGaps],
        gaps: event.targetGaps.size,
        pieceShapeName: event.currentPieceShapeName,
        chosenTowerIndex: event.chosenTowerIndex,
        eventOrd: eventOrd++,
        bagQueue,
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
          eventOrd++,
        ),
      );
      return;
    }
    if (event.kind === "desperate-fired") {
      getRow(event.round)[event.playerId]!.desperateFires++;
      console.log(
        `desperate seed=${seed} r${event.round} pid=${event.playerId} piece=${event.pieceShapeName} at=(${event.row},${event.col})`,
      );
      return;
    }
  });

  sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
    if (ev.phase !== Phase.WALL_BUILD) return;
    perRoundSnapshot.set(sc.state.round, captureRoundSnapshot(sc.state));
  });
  sc.bus.on(GAME_EVENT.WALL_PLACED, (ev) => {
    const row = getRow(sc.state.round)[ev.playerId]!;
    row.walls += ev.tileKeys.length;
    row.commits += 1;
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
  return { perRound, perRoundSnapshot };
}

function captureRoundSnapshot(state: {
  map: {
    tiles: readonly (readonly Tile[])[];
    towers: readonly { row: number; col: number }[];
    houses: readonly { row: number; col: number; alive: boolean }[];
  };
  players: readonly ({ walls: ReadonlySet<TileKey>; cannons: readonly { row: number; col: number }[] } | null)[];
  burningPits: readonly { row: number; col: number }[];
}): RoundSnapshot {
  const initialWalls = new Map<ValidPlayerId, ReadonlySet<TileKey>>();
  for (let pid = 0 as ValidPlayerId; pid < 3; pid = (pid + 1) as ValidPlayerId) {
    const player = state.players[pid];
    if (player) initialWalls.set(pid, new Set(player.walls));
  }
  const blocked = new Set<TileKey>();
  // Towers + cannons are 2x2; houses + pits are 1x1.
  for (const tower of state.map.towers) {
    for (let dr = 0; dr < 2; dr++) {
      for (let dc = 0; dc < 2; dc++) {
        blocked.add(packTile(tower.row + dr, tower.col + dc));
      }
    }
  }
  for (const house of state.map.houses) {
    if (house.alive) blocked.add(packTile(house.row, house.col));
  }
  for (let pid = 0 as ValidPlayerId; pid < 3; pid = (pid + 1) as ValidPlayerId) {
    const player = state.players[pid];
    if (!player) continue;
    for (const cannon of player.cannons) {
      for (let dr = 0; dr < 2; dr++) {
        for (let dc = 0; dc < 2; dc++) {
          blocked.add(packTile(cannon.row + dr, cannon.col + dc));
        }
      }
    }
  }
  for (const pit of state.burningPits) {
    blocked.add(packTile(pit.row, pit.col));
  }
  const grass = new Set<TileKey>();
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (state.map.tiles[r]![c] === Tile.Grass) grass.add(packTile(r, c));
    }
  }
  return { initialWalls, initialBlocked: blocked, initialGrass: grass };
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
  eventOrd: number,
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
    cells: [...cells],
    eventOrd,
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
  perRoundSnapshot: Map<number, RoundSnapshot>,
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
  let winnableCount = 0;
  let unwinnableCount = 0;
  let timeoutCount = 0;
  const desperateFiresPerPlayer = [0, 0, 0];
  for (let pid = 0; pid < 3; pid++) {
    for (const round of rounds) {
      const row = perRound.get(round)![pid]!;
      perPlayer[pid]!.enclosures += row.enclosures;
      if (row.walls > 0) perPlayer[pid]!.activeRounds += 1;
      perPlayer[pid]!.livesEnd = row.livesAtRoundEnd;
      desperateFiresPerPlayer[pid]! += row.desperateFires;
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
        const cacheStr = formatCacheSummary(row.trajectory);
        // Run the bag-coverage solver for LATE_PLATEAU stalls (the only
        // sub-mode with a well-defined plateau-start tick). The tag tells
        // future readers whether the stall was mechanically losable from
        // plateau start (UNWINNABLE — no placement sequence closes the
        // ring), recoverable (WINNABLE — addressable signal), or
        // search-budget-bound (TIMEOUT).
        const winStr = evaluateWinnability(
          row,
          perRound.get(round)!,
          pid as ValidPlayerId,
          perRoundSnapshot.get(round),
          sub.kind,
        );
        if (winStr === " | win=WINNABLE") winnableCount++;
        else if (winStr.startsWith(" | win=UNWINNABLE")) unwinnableCount++;
        else if (winStr.startsWith(" | win=TIMEOUT")) timeoutCount++;
        // decide/commit gap: AI decisions captured via diag (one per
        // pickPlacement) vs actual commits captured via bus WALL_PLACED.
        // Non-zero `dropped` = the AI decided to place but the cursor never
        // arrived / dwell never completed before WALL_BUILD ended — surfaces
        // PROGRESS-mode stalls misclassified as LATE_PLATEAU.
        const decided = row.placements.length;
        const committed = row.commits;
        const dropped = decided - committed;
        const dropStr = dropped > 0
          ? ` | decide=${decided} commit=${committed} dropped=${dropped}`
          : "";
        // Desperate-interior fires for this (round, player) — surfaced inline
        // when non-zero so a stall reader sees "AI was actively discarding
        // into closed area" attached to the failing round.
        const desperateStr = row.desperateFires > 0
          ? ` | desperate=${row.desperateFires}`
          : "";
        stalls.push(
          `seed=${seed} r${round} ${PLAYER_NAMES[pid]}: ${row.walls} walls placed, 0 enclosures fired, ${row.unownedAliveZoneTowers} alive unowned tower(s) available, lives=${row.livesAtRoundEnd} | paths H=${pc.HOME} S=${pc.SEC} E=${pc.EXP} SR=${pc.STRAT_RECT} SN=${pc.STRAT_NONE} → ${cls.kind} (${cls.detail}) | sub-mode ${sub.kind} (${sub.detail})${winStr}${dropStr}${desperateStr}\n  diag: walls ${walls}${bagFitStr}${altStr}${cacheStr} | flips ${flipStr}`,
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
  const winMedianStr =
    winnableCount + unwinnableCount + timeoutCount > 0
      ? ` | win W=${winnableCount} U=${unwinnableCount} T=${timeoutCount}`
      : "";
  const desperateFires = desperateFiresPerPlayer.reduce((a, b) => a + b, 0);
  const desperateMedianStr =
    desperateFires > 0 ? ` | desperate=${desperateFires}` : "";
  const diagSummary =
    stalls.length > 0
      ? `DIAG seed=${seed}: ${stalls.length} stalls | gap-hit median ${median(gapHitPcts)}% | flips total ${totalFlips}${bagFitMedianStr}${winMedianStr}${altBetterPcts.length > 0 ? ` | alt-better median ${median(altBetterPcts)}%` : ""}${desperateMedianStr}`
      : "";
  return {
    stalls,
    perPlayer,
    diagSummary,
    desperateFires,
    desperateFiresPerPlayer,
  };
}

/** Run the bag-coverage solver for a LATE_PLATEAU stall and format the
 *  result as a stall-message tag (` | win=WINNABLE` / ` | win=UNWINNABLE
 *  iso=N narrow=N` / ` | win=TIMEOUT`). Returns an empty string for non-
 *  LATE_PLATEAU sub-modes or when the snapshot is missing (e.g. the run
 *  ended before WALL_BUILD entered for this round). */
function evaluateWinnability(
  row: RoundRow,
  allPlayerRows: readonly RoundRow[],
  pid: ValidPlayerId,
  snapshot: RoundSnapshot | undefined,
  subModeKind: string,
): string {
  if (subModeKind !== "LATE_PLATEAU") return "";
  if (!snapshot) return "";
  const traj = row.trajectory;
  const plateauIdx = findPlateauStartIdx(traj);
  const plateauTick = traj[plateauIdx];
  if (!plateauTick || !plateauTick.rect) return "";
  const plateauEventOrd = plateauTick.eventOrd;

  // Reconstruct focal walls and enemy walls AS-OF plateau-start by replaying
  // placements with eventOrd < plateauEventOrd from the matching player row.
  const focalWalls = new Set<TileKey>(snapshot.initialWalls.get(pid) ?? []);
  const enemyWalls = new Set<TileKey>();
  for (let otherPid = 0 as ValidPlayerId; otherPid < 3; otherPid = (otherPid + 1) as ValidPlayerId) {
    if (otherPid === pid) continue;
    const initial = snapshot.initialWalls.get(otherPid);
    if (initial) for (const cell of initial) enemyWalls.add(cell);
  }
  for (let otherPid = 0 as ValidPlayerId; otherPid < 3; otherPid = (otherPid + 1) as ValidPlayerId) {
    const otherRow = allPlayerRows[otherPid];
    if (!otherRow) continue;
    for (const place of otherRow.placements) {
      if (place.eventOrd >= plateauEventOrd) continue;
      const target = otherPid === pid ? focalWalls : enemyWalls;
      for (const cell of place.cells) target.add(cell);
    }
  }

  // Remaining gaps = the plateau tick's gap set minus cells the focal player
  // has already walled (edge case: ring closed but the runner still flagged a
  // stall).
  const remainingGaps = new Set<TileKey>();
  for (const key of plateauTick.gapKeys) {
    if (!focalWalls.has(key)) remainingGaps.add(key);
  }
  if (remainingGaps.size === 0) return " | win=WINNABLE";

  // Pieces available from plateau-start onward: current piece + bag queue,
  // capped at remaining ticks (each tick consumes ≤ 1 piece).
  const ticksRemaining = traj.length - plateauIdx;
  const pieceNames = [plateauTick.pieceShapeName, ...plateauTick.bagQueue].slice(
    0,
    ticksRemaining,
  );
  const pieces = pieceNames
    .map((name) => ALL_PIECE_SHAPES.find((s) => s.name === name))
    .filter((s): s is PieceShape => s !== undefined);

  // Blocked set = static blockers + enemy walls (overlap-not-allowed in
  // modern Rampart without upgrades; the focal player's own walls live in
  // `walls` inside the solver).
  const blocked = new Set<TileKey>(snapshot.initialBlocked);
  for (const cell of enemyWalls) blocked.add(cell);

  const result = solveWinnable(
    remainingGaps,
    focalWalls,
    blocked,
    snapshot.initialGrass,
    pieces,
  );
  const initialFocalWalls = snapshot.initialWalls.get(pid) ?? new Set();
  const blame = classifyIsolatedGapBlame(
    remainingGaps,
    focalWalls,
    initialFocalWalls,
    blocked,
    snapshot.initialGrass,
  );
  const blameStr =
    blame.self + blame.mixed + blame.pre > 0
      ? ` blame=self/mix/pre=${blame.self}/${blame.mixed}/${blame.pre}`
      : "";
  if (result.result === true) return ` | win=WINNABLE${blameStr}`;
  if (result.result === "TIMEOUT")
    return ` | win=TIMEOUT nodes=${result.nodes}${blameStr}`;
  const iso = countIsolatedGaps(
    remainingGaps,
    focalWalls,
    blocked,
    snapshot.initialGrass,
  );
  const narrow = countNarrowPieces(pieceNames);
  return ` | win=UNWINNABLE iso=${iso} narrow=${narrow}${blameStr}`;
}

/** Find the plateau-start trajectory index for a LATE_PLATEAU stall — walks
 *  backwards from the end of the trajectory while consecutive ticks share
 *  the same rectKey AND don't drop in gap count. Returns the index of the
 *  tick BEFORE the stuck-tail (i.e. the last tick that made progress, OR 0
 *  if the whole trajectory plateaued). Mirrors the logic in
 *  `diag-winnability.ts::classifySubMode` but extracted here so the runner
 *  can find the plateau without re-running the full classifier. */
function findPlateauStartIdx(traj: readonly TrajectoryTick[]): number {
  if (traj.length === 0) return 0;
  let plateauStartIdx = traj.length;
  for (let i = traj.length - 1; i > 0; i--) {
    const sameRect = traj[i]!.rectKey === traj[i - 1]!.rectKey;
    const gapDropped = traj[i]!.gaps < traj[i - 1]!.gaps;
    if (sameRect && !gapDropped) {
      plateauStartIdx = i - 1;
    } else {
      break;
    }
  }
  return plateauStartIdx;
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

/** Persistence-cache lifetime summary across a stall's trajectory. Walks the
 *  per-tick `chosenTowerIndex` sequence and reports:
 *  - writes: ticks where chosenTowerIndex is set (cache wrote)
 *  - holds: max consecutive ticks the cache stayed on the same tower
 *  - invals: transitions where chosenTowerIndex went from set → undefined
 *    (cache invalidated AND the next tick didn't immediately re-commit)
 *  - swaps: transitions where chosenTowerIndex changed from one set value
 *    to a DIFFERENT set value across consecutive ticks (cache replaced
 *    target without an undefined gap — implies fresh-score picked a
 *    different tower in the same tick the cache was invalidated)
 *  Format: ` | cache writes=W/N holds=H invals=I swaps=S`. Empty when the
 *  whole stall had zero cache writes (every tick was HOME/EXP/STRAT_*). */
function formatCacheSummary(traj: readonly TrajectoryTick[]): string {
  if (traj.length === 0) return "";
  let writes = 0;
  let invals = 0;
  let swaps = 0;
  let maxHold = 0;
  let curHold = 0;
  let prev: number | undefined = undefined;
  for (const tick of traj) {
    const cur = tick.chosenTowerIndex;
    if (cur !== undefined) {
      writes++;
      if (prev === cur) {
        curHold++;
      } else {
        if (prev !== undefined) swaps++;
        curHold = 1;
      }
      if (curHold > maxHold) maxHold = curHold;
    } else {
      if (prev !== undefined) invals++;
      curHold = 0;
    }
    prev = cur;
  }
  if (writes === 0) return "";
  return ` | cache writes=${writes}/${traj.length} maxhold=${maxHold} invals=${invals} swaps=${swaps}`;
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
    | "NEAR_MISS_FLIP"
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
  // Near-miss FLIP: AI was on a rect at ≤3 gaps, then switched to a rect
  // with MORE gaps in the very next tick. The life-critical specialization
  // of NEAR_MISS — when a ring is 1-3 placements from closing, abandoning
  // it for a bigger ring is the BLUE-r3-seed-897314 signature: piece in
  // hand can't fill the 2-3 remaining gaps → canFillAfterPlugging fails →
  // trySecondaryTower drops to next-best (which has more gaps because
  // larger rings give the current piece more places to land). Captured
  // here before generic NEAR_MISS because it's the most actionable shape.
  for (let i = 1; i < traj.length; i++) {
    const prev = traj[i - 1]!;
    const cur = traj[i]!;
    if (prev.rectKey === cur.rectKey) continue;
    if (prev.gaps > 3) continue;
    if (cur.gaps <= prev.gaps) continue;
    return {
      kind: "NEAR_MISS_FLIP",
      detail: `flipped from ${prev.gaps}g rect to ${cur.gaps}g rect at tick ${i}`,
    };
  }
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
