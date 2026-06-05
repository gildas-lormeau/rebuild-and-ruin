/**
 * Deno worker for `scripts/ai-intelligence.ts`. Receives one (seed, rounds,
 * mode) request, runs `runSeed`, and posts the SeedMetrics back. Mirrors the
 * pool pattern in `test/survival/worker.ts`.
 */

import { runSeed, type SeedMetrics } from "./ai-intelligence-runner.ts";

export interface WorkerRequest {
  seed: number;
  rounds: number;
  mode: "classic" | "modern";
}

export type WorkerResponse =
  | { ok: true; result: SeedMetrics }
  | { ok: false; seed: number; error: string };

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { seed, rounds, mode } = event.data;
  try {
    const result = await runSeed(seed, rounds, mode);
    const response: WorkerResponse = { ok: true, result };
    self.postMessage(response);
  } catch (e) {
    const errStr = e instanceof Error ? (e.stack ?? e.message) : String(e);
    const response: WorkerResponse = { ok: false, seed, error: errStr };
    self.postMessage(response);
  }
};
