import { createScenario } from "./scenario.ts";

const SEED = 42;
const ROUNDS = 8;
// Default budget targets a 3-round run; 8 rounds need ~3x the sim-ms budget.
const TIMEOUT_MS = 1_800_000;

Deno.bench("full game — classic, 8 rounds", async () => {
  const sc = await createScenario({ seed: SEED, mode: "classic", rounds: ROUNDS });
  sc.runGame({ timeoutMs: TIMEOUT_MS });
});

Deno.bench("full game — modern, 8 rounds", async () => {
  const sc = await createScenario({ seed: SEED, mode: "modern", rounds: ROUNDS });
  sc.runGame({ timeoutMs: TIMEOUT_MS });
});
