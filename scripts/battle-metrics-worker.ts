/**
 * Deno worker for `scripts/battle-metrics.ts`. Receives one (seed, rounds,
 * mode) request, runs `runSeed`, posts the SeedMetrics back. Mirrors
 * `scripts/ai-intelligence-worker.ts`.
 */

import { runSeed, type SeedMetrics } from "./battle-metrics-runner.ts";

export interface WorkerRequest {
  seed: number;
  rounds: number;
  mode: "classic" | "modern";
  /** Play to last-player-standing (high safety cap) instead of capping at
   *  `rounds` — the "full game" mode for last-N-rounds analysis. */
  runToEnd?: boolean;
}

export type WorkerResponse =
  | { ok: true; result: SeedMetrics }
  | { ok: false; seed: number; error: string };

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { seed, rounds, mode, runToEnd } = event.data;
  try {
    const result = await runSeed(seed, rounds, mode, runToEnd);
    const response: WorkerResponse = { ok: true, result };
    self.postMessage(response);
  } catch (e) {
    const errStr = e instanceof Error ? (e.stack ?? e.message) : String(e);
    const response: WorkerResponse = { ok: false, seed, error: errStr };
    self.postMessage(response);
  }
};
