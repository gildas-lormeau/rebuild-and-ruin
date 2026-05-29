/**
 * Shared seed-pool harness plumbing for the parallel measurement scripts
 * (`ai-intelligence.ts`, `battle-metrics.ts`, …): standard `--seeds/--random/
 * --master-seed/--rounds/--mode/--json` arg parsing, a reproducible random
 * seed draw, and a generic Deno worker pool. Keeps the per-seed metric logic
 * in each script while sharing the boilerplate.
 */

export interface SeedPoolArgs {
  seeds: number[];
  rounds: number;
  mode: "classic" | "modern";
  json: boolean;
}

/** Worker response envelope every pool worker posts back. */
export type PoolResponse<Res> =
  | { ok: true; result: Res }
  | { ok: false; seed: number; error: string };

const DEFAULT_RANDOM_COUNT = 10;
const DEFAULT_ROUNDS = 15;

/** Parse the shared seed-pool CLI flags from `Deno.args`. */
export function parseSeedPoolArgs(): SeedPoolArgs {
  const argv = Deno.args;
  let seeds: number[] | null = null;
  let randomCount: number | null = null;
  let masterSeed: number | null = null;
  let rounds = DEFAULT_ROUNDS;
  let mode: "classic" | "modern" = "modern";
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--seeds") {
      seeds = argv[++i]!.split(",").map((s) => Number.parseInt(s, 10));
    } else if (arg === "--random") {
      randomCount = Number.parseInt(argv[++i]!, 10);
    } else if (arg === "--master-seed") {
      masterSeed = Number.parseInt(argv[++i]!, 10);
    } else if (arg === "--rounds") {
      rounds = Number.parseInt(argv[++i]!, 10);
    } else if (arg === "--mode") {
      const value = argv[++i]!;
      if (value !== "classic" && value !== "modern") {
        throw new Error(`--mode must be classic|modern, got "${value}"`);
      }
      mode = value;
    } else if (arg === "--json") {
      json = true;
    }
  }

  if (!seeds) {
    seeds = drawRandomSeeds(randomCount ?? DEFAULT_RANDOM_COUNT, masterSeed);
  }
  return { seeds, rounds, mode, json };
}

/** Mulberry32 — local deterministic PRNG, only for picking the seed set.
 *  Reproducible when `masterSeed` is given; decoupled from the game RNG. */
export function drawRandomSeeds(
  count: number,
  masterSeed: number | null,
): number[] {
  let state = masterSeed ?? Date.now() & 0xffffffff;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % 10_000_000;
  };
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(next());
  return out;
}

/** Concurrency = min(jobs, cores − headroom), at least 1. */
export function poolSizeFor(jobCount: number): number {
  return Math.max(1, Math.min(jobCount, navigator.hardwareConcurrency ?? 4));
}

/** Run `requests` through a pool of `poolSize` workers at `workerUrl` (pass
 *  `import.meta.resolve("./<name>-worker.ts")` from the caller so the URL
 *  resolves against the caller). Each worker posts a `PoolResponse<Res>`.
 *  Writes a `.`/`!` progress dot per completion to stderr; returns the
 *  successful results plus any error strings (the call never rejects). */
export async function runWorkerPool<Req, Res>(
  workerUrl: string,
  requests: readonly Req[],
  poolSize: number,
): Promise<{ results: Res[]; errors: string[] }> {
  const pending = [...requests];
  const results: Res[] = [];
  const errors: string[] = [];
  const workerDone: Promise<void>[] = [];
  const encoder = new TextEncoder();

  for (let i = 0; i < poolSize; i++) {
    let resolveDone!: () => void;
    workerDone.push(new Promise<void>((resolve) => (resolveDone = resolve)));
    const worker = new Worker(workerUrl, { type: "module" });

    const dispatchNext = (): void => {
      const next = pending.shift();
      if (next === undefined) {
        worker.terminate();
        resolveDone();
        return;
      }
      worker.postMessage(next);
    };

    worker.onmessage = (event: MessageEvent<PoolResponse<Res>>) => {
      const response = event.data;
      if (response.ok) {
        results.push(response.result);
        Deno.stderr.writeSync(encoder.encode("."));
      } else {
        errors.push(`seed=${response.seed}: ${response.error}`);
        Deno.stderr.writeSync(encoder.encode("!"));
      }
      dispatchNext();
    };
    worker.onerror = (event) => {
      errors.push(`worker error: ${event.message}`);
      resolveDone();
    };
    dispatchNext();
  }

  await Promise.all(workerDone);
  Deno.stderr.writeSync(encoder.encode("\n"));
  return { results, errors };
}
