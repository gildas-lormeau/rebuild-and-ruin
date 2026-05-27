/**
 * Shared comparison helpers for `ai-compare.ts` (single-run) and
 * `ai-compare-multi.ts` (multi-master-seed aggregation). Owns the paired-tuple
 * matching, per-metric delta computation, and the verdict classifier.
 */

import type { SeedMetrics } from "./ai-intelligence-runner.ts";

export interface Snapshot {
  seeds: readonly number[];
  rounds: number;
  mode: "classic" | "modern";
  elapsedSec: number;
  results: readonly SeedMetrics[];
}

export interface MetricDelta {
  name: string;
  better: number;
  worse: number;
  tied: number;
  baselineMean: number;
  candidateMean: number;
  meanDelta: number;
}

export interface MatchedTuple {
  seed: number;
  slot: number;
  baselineFinalLives: number;
  candidateFinalLives: number;
  baselineFinalScore: number;
  candidateFinalScore: number;
  baselineLastAlive: number;
  candidateLastAlive: number;
  baselineMeanEnclosed: number;
  candidateMeanEnclosed: number;
  baselineMeanInterior: number;
  candidateMeanInterior: number;
}

export type Verdict = "+ better" | "- worse" | "noise" | "low-signal";

export function loadSnapshot(path: string): Snapshot {
  const text = Deno.readTextFileSync(path);
  return JSON.parse(text) as Snapshot;
}

export function matchTuples(
  baseline: Snapshot,
  candidate: Snapshot,
): MatchedTuple[] {
  const candidateBySeed = new Map<number, SeedMetrics>();
  for (const seedResult of candidate.results) {
    candidateBySeed.set(seedResult.seed, seedResult);
  }
  const out: MatchedTuple[] = [];
  for (const baselineSeed of baseline.results) {
    const candidateSeed = candidateBySeed.get(baselineSeed.seed);
    if (!candidateSeed) continue;
    for (let slot = 0; slot < 3; slot++) {
      const baselinePlayer = baselineSeed.players[slot];
      const candidatePlayer = candidateSeed.players[slot];
      if (!baselinePlayer || !candidatePlayer) continue;
      out.push({
        seed: baselineSeed.seed,
        slot,
        baselineFinalLives: baselinePlayer.finalLives,
        candidateFinalLives: candidatePlayer.finalLives,
        baselineFinalScore: baselinePlayer.finalScore,
        candidateFinalScore: candidatePlayer.finalScore,
        baselineLastAlive: baselinePlayer.lastAliveRound,
        candidateLastAlive: candidatePlayer.lastAliveRound,
        baselineMeanEnclosed: avgEnclosed(baselinePlayer.perRound),
        candidateMeanEnclosed: avgEnclosed(candidatePlayer.perRound),
        baselineMeanInterior: avgInterior(baselinePlayer.perRound),
        candidateMeanInterior: avgInterior(candidatePlayer.perRound),
      });
    }
  }
  return out;
}

export function computeDeltas(matched: readonly MatchedTuple[]): MetricDelta[] {
  return [
    delta("finalScore", matched, (t) => [
      t.baselineFinalScore,
      t.candidateFinalScore,
    ]),
    delta("finalLives", matched, (t) => [
      t.baselineFinalLives,
      t.candidateFinalLives,
    ]),
    delta("lastAliveRnd", matched, (t) => [
      t.baselineLastAlive,
      t.candidateLastAlive,
    ]),
    delta("enclosedAvg", matched, (t) => [
      t.baselineMeanEnclosed,
      t.candidateMeanEnclosed,
    ]),
    delta("interiorAvg", matched, (t) => [
      t.baselineMeanInterior,
      t.candidateMeanInterior,
    ]),
  ];
}

export function classifyVerdict(
  winPct: number,
  decided: number,
  totalTuples: number,
): Verdict {
  if (decided < totalTuples * 0.3) return "low-signal";
  if (winPct >= 60) return "+ better";
  if (winPct <= 40) return "- worse";
  return "noise";
}

export function fmtDelta(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return sign + fmt(value);
}

export function fmt(value: number): string {
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function delta(
  name: string,
  matched: readonly MatchedTuple[],
  pick: (t: MatchedTuple) => readonly [number, number],
): MetricDelta {
  let better = 0;
  let worse = 0;
  let tied = 0;
  let baselineSum = 0;
  let candidateSum = 0;
  for (const tuple of matched) {
    const [baselineVal, candidateVal] = pick(tuple);
    baselineSum += baselineVal;
    candidateSum += candidateVal;
    if (candidateVal > baselineVal) better++;
    else if (candidateVal < baselineVal) worse++;
    else tied++;
  }
  const n = Math.max(1, matched.length);
  return {
    name,
    better,
    worse,
    tied,
    baselineMean: baselineSum / n,
    candidateMean: candidateSum / n,
    meanDelta: (candidateSum - baselineSum) / n,
  };
}

function avgEnclosed(
  perRound: readonly { enclosedAlive: number; interiorSize: number }[],
): number {
  if (perRound.length === 0) return 0;
  let sum = 0;
  for (const sample of perRound) sum += sample.enclosedAlive;
  return sum / perRound.length;
}

function avgInterior(
  perRound: readonly { enclosedAlive: number; interiorSize: number }[],
): number {
  if (perRound.length === 0) return 0;
  let sum = 0;
  for (const sample of perRound) sum += sample.interiorSize;
  return sum / perRound.length;
}
