/**
 * E2E test: frame-rate determinism.
 *
 * Runs the same seed through the headless runtime at two different dt
 * values (16ms and 100ms) and compares event logs. Any divergence proves
 * the simulation is dt-sensitive.
 *
 * Run: deno run -A test/e2e-dt-divergence.ts
 */

import type { E2EBusEntry } from "../src/runtime/runtime-e2e-bridge.ts";
import { E2ETest } from "./e2e-helpers.ts";
import { createScenario } from "./scenario.ts";

const SEED = 25129;
const ROUNDS = 7;
/** Determinism-relevant event types. */
const DETERMINISTIC_TYPES = new Set([
  "gameStart",
  "roundStart",
  "roundEnd",
  "gameEnd",
  "phaseStart",
  "phaseEnd",
  "bannerStart",
  "bannerEnd",
  "modifierApplied",
  "upgradePicked",
  "wallPlaced",
  "cannonPlaced",
  "playerEliminated",
  "lifeLost",
  "gruntSpawn",
  "gruntSpawnBlocked",
]);

run();

async function run() {
  const test = new E2ETest("dt-divergence (seed 25129)");

  const events16 = await collectEvents("Headless @16ms", 16);
  const events100 = await collectEvents("Headless @100ms", 100);

  console.log("\n--- Event-by-event comparison ---\n");

  const maxLen = Math.max(events16.length, events100.length);
  let firstDivergence = -1;
  let contextStart = 0;
  for (let idx = 0; idx < maxLen; idx++) {
    const fp16 = idx < events16.length ? fingerprint(events16[idx]!) : "(end)";
    const fp100 =
      idx < events100.length ? fingerprint(events100[idx]!) : "(end)";
    if (fp16 !== fp100 && firstDivergence === -1) {
      firstDivergence = idx;
      contextStart = Math.max(0, idx - 3);
    }
  }

  const printEnd =
    firstDivergence >= 0
      ? Math.min(maxLen, firstDivergence + 10)
      : Math.min(maxLen, 20);
  for (let idx = contextStart; idx < printEnd; idx++) {
    const fp16 = idx < events16.length ? fingerprint(events16[idx]!) : "(end)";
    const fp100 =
      idx < events100.length ? fingerprint(events100[idx]!) : "(end)";
    const match = fp16 === fp100;
    const marker = !match ? " <<< DIVERGE" : "";
    const prefix = match ? "  " : ">>";
    console.log(
      `${prefix} [${String(idx).padStart(3)}]  @16ms: ${fp16.padEnd(55)} @100ms: ${fp100}${marker}`,
    );
  }

  if (firstDivergence === -1) {
    console.log(
      `\nAll ${maxLen} deterministic events match between dt=16ms and dt=100ms.`,
    );
  } else {
    console.log(
      `\nFirst divergence at event index ${firstDivergence} of ${maxLen}`,
    );
    console.log(`@16ms: ${events16.length} events`);
    console.log(`@100ms: ${events100.length} events`);
  }

  test.check(
    "deterministic event streams match across frame rates",
    firstDivergence === -1,
    firstDivergence >= 0
      ? `first divergence at event[${firstDivergence}]`
      : undefined,
  );

  test.done();
}

function fingerprint(ev: { type: string; [k: string]: unknown }): string {
  const parts = [ev.type];
  if (ev.round !== undefined) parts.push(`r${ev.round}`);
  if (ev.phase !== undefined) parts.push(`p${ev.phase}`);
  if (ev.modifierId !== undefined) parts.push(String(ev.modifierId));
  if (ev.upgradeId !== undefined) parts.push(String(ev.upgradeId));
  if (ev.playerId !== undefined) parts.push(`pid${ev.playerId}`);
  if (ev.text !== undefined) parts.push(`"${ev.text}"`);
  return parts.join("|");
}

function collectEvents(label: string, dtMs: number): Promise<E2EBusEntry[]> {
  return createScenario({ seed: SEED, mode: "modern", rounds: ROUNDS }).then(
    (sc) => {
      const events: E2EBusEntry[] = [];
      sc.bus.onAny((type, event) => {
        if (DETERMINISTIC_TYPES.has(type)) {
          events.push({
            ...(event as Record<string, unknown>),
            type,
            _seq: events.length,
          });
        }
      });
      sc.runUntil(() => sc.state.round > ROUNDS - 1, 80000, dtMs);
      console.log(`${label} (dt=${dtMs}ms): ${events.length} events`);
      return events;
    },
  );
}
