/**
 * Deno worker for `scripts/cannon-efficiency.ts`. Receives one (seed, rounds)
 * request, runs `measureSeed`, and posts the Agg back. Mirrors the pool
 * pattern in `scripts/ai-intelligence-worker.ts`.
 */

import { type Agg, measureSeed } from "./cannon-efficiency-runner.ts";

export interface WorkerRequest {
  seed: number;
  rounds: number;
}

export type WorkerResponse =
  | { ok: true; seed: number; result: Agg }
  | { ok: false; seed: number; error: string };

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { seed, rounds } = event.data;
  try {
    const result = await measureSeed(seed, rounds);
    const response: WorkerResponse = { ok: true, seed, result };
    self.postMessage(response);
  } catch (e) {
    const errStr = e instanceof Error ? (e.stack ?? e.message) : String(e);
    const response: WorkerResponse = { ok: false, seed, error: errStr };
    self.postMessage(response);
  }
};
