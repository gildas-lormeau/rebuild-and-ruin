/**
 * Behavioral suite for AI build-phase placement: 26 seeds × 30 rounds each,
 * one Deno.test per seed so failures are individually diagnosable. The seed
 * set is the original 11 (hand-picked over earlier debugging) plus 15 random
 * seeds added to increase mode-frequency confidence — at 11-seed scale GOLD
 * looked over-represented in stalls (~33%), but at 26-seed scale it normalizes
 * to ~30% and Mode #2 (per-tick target churn) dominates at ~73% of stalls.
 *
 * Background: pre-fix to the selectTarget strategic fallback +
 * scoreTopCandidates hard-reject escape (ai-strategy-build.ts /
 * ai-build-target.ts), the AI could fall into a "build walls but never close
 * a ring" pattern when every selectTarget phase bailed on canFillAfterPlugging
 * or every gap-filler hit a SCORING_RULES hard-reject.
 *
 * Stall fingerprint: the player built ≥STALL_WALL_THRESHOLD wall tiles AND
 * fired zero `towerEnclosed` events this round AND has ≥1 alive unowned
 * tower in its zone at round end AND did not lose a life this round. The
 * earlier "ownedAtRoundEnd === 0" gate was too narrow — it missed cases where
 * the AI maintained a previously-enclosed castle but failed to expand to
 * alive unenclosed secondaries despite heavy building (seed 523357 r36
 * pattern).
 *
 * The life-lost filter survives the new metric: when a player loses a life,
 * applyLifePenalties resets the zone — that's a separate concern, not a
 * build-strategy stall.
 *
 * Parallelism: each seed is independent CPU-bound work, so the suite fans out
 * across a Deno worker pool (size = navigator.hardwareConcurrency, override
 * via AI_SURVIVAL_WORKERS env). Workers are spawned eagerly at module load;
 * each Deno.test just awaits its seed's pre-dispatched result. Per-seed
 * Deno.test entries are preserved so `--filter "seed 42"` still works and
 * failures are individually named.
 */

import { assert } from "@std/assert";
import { SEEDS, type SeedResult } from "./ai-build-survival-runner.ts";
import type {
  WorkerRequest,
  WorkerResponse,
} from "./ai-build-survival-worker.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const POOL_SIZE = Math.max(
  1,
  Number(Deno.env.get("AI_SURVIVAL_WORKERS")) ||
    (navigator.hardwareConcurrency ?? 4),
);
const seedDeferreds = new Map<number, Deferred<SeedResult>>();
const pendingSeeds: number[] = [...SEEDS];
const poolCount = Math.min(POOL_SIZE, SEEDS.length);

for (const seed of SEEDS) seedDeferreds.set(seed, defer<SeedResult>());

for (let i = 0; i < poolCount; i++) startWorker();

for (const seed of SEEDS) {
  Deno.test(`AI build survival: seed ${seed}`, async () => {
    const result = await seedDeferreds.get(seed)!.promise;
    assert(
      result.findings.stalls.length === 0,
      `Detected ${result.findings.stalls.length} stall round(s) for seed ${seed}. See log for details.`,
    );
  });
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function startWorker(): void {
  const worker = new Worker(
    import.meta.resolve("./ai-build-survival-worker.ts"),
    { type: "module" },
  );

  let currentSeed: number | null = null;

  const dispatchNext = (): void => {
    const next = pendingSeeds.shift();
    if (next === undefined) {
      currentSeed = null;
      worker.terminate();
      return;
    }
    currentSeed = next;
    const request: WorkerRequest = { seed: next };
    worker.postMessage(request);
  };

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const seed = response.ok ? response.result.seed : response.seed;
    const deferred = seedDeferreds.get(seed);
    if (deferred) {
      if (response.ok) deferred.resolve(response.result);
      else
        deferred.reject(
          new Error(`worker error (seed=${seed}): ${response.error}`),
        );
    }
    dispatchNext();
  };

  worker.onerror = (event) => {
    if (currentSeed !== null) {
      const deferred = seedDeferreds.get(currentSeed);
      deferred?.reject(
        new Error(`worker crashed (seed=${currentSeed}): ${event.message}`),
      );
    }
    worker.terminate();
  };

  dispatchNext();
}
