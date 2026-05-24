/**
 * Deno worker for ai-build-survival. Receives one seed at a time, runs the
 * full simulation + analysis on a background thread, and posts the structured
 * result back. The per-seed log line (and any stall details) are written to
 * the worker's own stdout — they share the parent's terminal, so each line
 * shows up inline with the deno test output.
 *
 * Lifetime: the main test file controls termination via `worker.terminate()`
 * once its queue is drained. The worker itself never closes.
 */

import {
  formatSummaryLine,
  runAndAnalyze,
  type SeedResult,
} from "./ai-build-survival-runner.ts";

export interface WorkerRequest {
  seed: number;
}

export type WorkerResponse =
  | { ok: true; result: SeedResult }
  | { ok: false; seed: number; error: string };

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { seed } = event.data;
  try {
    const result = await runAndAnalyze(seed);
    console.log(formatSummaryLine(result));
    if (result.findings.stalls.length > 0) {
      console.log(`Stalls (seed=${seed}):`);
      for (const stall of result.findings.stalls) console.log(`  ${stall}`);
      if (result.findings.diagSummary) {
        console.log(result.findings.diagSummary);
      }
    }
    const response: WorkerResponse = { ok: true, result };
    self.postMessage(response);
  } catch (e) {
    const response: WorkerResponse = {
      ok: false,
      seed,
      error: e instanceof Error ? (e.stack ?? e.message) : String(e),
    };
    self.postMessage(response);
  }
};
