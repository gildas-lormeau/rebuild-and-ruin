/**
 * Shared engine for the AI build-survival suite. Imported by both the test
 * file (which registers one Deno.test per seed) and the worker (which actually
 * runs `runSeed` on a background thread). See ai-build-survival.test.ts for
 * the stall-fingerprint background and the rationale for the 26-seed set.
 */

import { createScenario, waitForEvent } from "./scenario.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { setSelectTargetPathHook } from "../src/ai/ai-build-target.ts";
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
}

export interface RoundRow {
  walls: number;
  enclosures: number;
  unownedAliveZoneTowers: number;
  lostLifeThisRound: boolean;
  livesAtRoundEnd: number;
  pathCounts: PathCounts;
  trajectory: TrajectoryTick[];
}

export interface PlayerSummary {
  enclosures: number;
  livesEnd: number;
  activeRounds: number;
}

export interface SeedFindings {
  stalls: string[];
  perPlayer: PlayerSummary[];
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
        }),
      );
      perRound.set(round, row);
    }
    return row;
  };

  setSelectTargetPathHook((playerId, round, path, result) => {
    const row = getRow(round)[playerId]!;
    row.pathCounts[path]++;
    const rect = result?.targetRect;
    row.trajectory.push({
      path,
      rectKey: rect
        ? `${rect.top},${rect.left}-${rect.bottom},${rect.right}`
        : "",
      gaps: result?.targetGaps?.size ?? 0,
    });
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
    setSelectTargetPathHook(undefined);
  }
  return perRound;
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
        stalls.push(
          `seed=${seed} r${round} ${PLAYER_NAMES[pid]}: ${row.walls} walls placed, 0 enclosures fired, ${row.unownedAliveZoneTowers} alive unowned tower(s) available, lives=${row.livesAtRoundEnd} | paths H=${pc.HOME} S=${pc.SEC} E=${pc.EXP} SR=${pc.STRAT_RECT} SN=${pc.STRAT_NONE} → ${cls.kind} (${cls.detail}) | sub-mode ${sub.kind} (${sub.detail})`,
        );
      }
    }
  }
  return { stalls, perPlayer };
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
