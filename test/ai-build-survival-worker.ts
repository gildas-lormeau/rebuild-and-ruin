/**
 * Deno worker for ai-build-survival. Receives one seed at a time, runs the
 * full simulation + analysis on a background thread, and posts the structured
 * result back.
 *
 * When `WorkerRequest.logDir` is set, every console.log/console.error during
 * the seed's run (including any AI-strategy instrumentation that writes to
 * those streams) is captured and written to `${logDir}/seed-{N}.log` —
 * non-interleaved by construction (single writer per file). When unset, the
 * worker writes to its own stdout, which the parent terminal interleaves
 * across workers as before.
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
  /** Absolute path of an already-existing directory. When set, the worker
   *  captures its console.log/error output and writes
   *  `${logDir}/seed-${seed}.log` instead of streaming to stdout. */
  logDir?: string;
}

export type WorkerResponse =
  | { ok: true; result: SeedResult }
  | { ok: false; seed: number; error: string };

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { seed, logDir } = event.data;
  const capture = logDir ? installLogCapture() : undefined;
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
    if (capture && logDir) {
      await Deno.writeTextFile(
        `${logDir}/seed-${seed}.log`,
        `${capture.flush().join("\n")}\n`,
      );
    }
    const response: WorkerResponse = { ok: true, result };
    self.postMessage(response);
  } catch (e) {
    const errStr = e instanceof Error ? (e.stack ?? e.message) : String(e);
    if (capture && logDir) {
      capture.push(`[error] ${errStr}`);
      await Deno.writeTextFile(
        `${logDir}/seed-${seed}.log`,
        `${capture.flush().join("\n")}\n`,
      );
    }
    const response: WorkerResponse = {
      ok: false,
      seed,
      error: errStr,
    };
    self.postMessage(response);
  } finally {
    capture?.restore();
  }
};

/** Override console.log/error to buffer lines instead of writing to stdout/
 *  stderr. `restore` puts the originals back so subsequent seeds in the same
 *  worker (if ever — current pool dispatches one seed at a time) aren't
 *  affected. */
function installLogCapture(): {
  push: (line: string) => void;
  flush: () => readonly string[];
  restore: () => void;
} {
  const lines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const fmt = (args: unknown[]): string =>
    args
      .map((arg) =>
        typeof arg === "string"
          ? arg
          : (() => {
              try {
                return JSON.stringify(arg);
              } catch {
                return String(arg);
              }
            })(),
      )
      .join(" ");
  console.log = (...args: unknown[]) => lines.push(fmt(args));
  console.error = (...args: unknown[]) => lines.push(`[err] ${fmt(args)}`);
  return {
    push: (line: string) => lines.push(line),
    flush: () => lines,
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}
