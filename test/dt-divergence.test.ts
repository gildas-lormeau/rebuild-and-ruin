/**
 * Frame-rate determinism test.
 *
 * Runs the same seed through the headless runtime at two different dt
 * values (16ms and 100ms) and compares event logs. Any divergence proves
 * the simulation is dt-sensitive.
 *
 * Run: npm run test:dt-divergence
 */

import { assertEquals, assertGreater } from "@std/assert";
import { createScenario } from "./scenario.ts";

interface EventEntry {
  type: string;
  [key: string]: unknown;
}

const SEED = 25129;
const ROUNDS = 7;
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

Deno.test("dt-divergence: event streams match at 16ms and 100ms", async () => {
  const events16 = await collectEvents(16);
  const events100 = await collectEvents(100);

  assertGreater(events16.length, 0, "no events at 16ms");
  assertGreater(events100.length, 0, "no events at 100ms");

  const maxLen = Math.max(events16.length, events100.length);
  let firstDivergence = -1;
  for (let idx = 0; idx < maxLen; idx++) {
    const fp16 = idx < events16.length ? fingerprint(events16[idx]!) : "(end)";
    const fp100 =
      idx < events100.length ? fingerprint(events100[idx]!) : "(end)";
    if (fp16 !== fp100) {
      firstDivergence = idx;
      break;
    }
  }

  assertEquals(
    firstDivergence,
    -1,
    firstDivergence >= 0
      ? `first divergence at event[${firstDivergence}]: ` +
        `@16ms=${firstDivergence < events16.length ? fingerprint(events16[firstDivergence]!) : "(end)"} ` +
        `@100ms=${firstDivergence < events100.length ? fingerprint(events100[firstDivergence]!) : "(end)"}`
      : "",
  );
});

function fingerprint(ev: EventEntry): string {
  const parts = [ev.type];
  if (ev.round !== undefined) parts.push(`r${ev.round}`);
  if (ev.phase !== undefined) parts.push(`p${ev.phase}`);
  if (ev.modifierId !== undefined) parts.push(String(ev.modifierId));
  if (ev.upgradeId !== undefined) parts.push(String(ev.upgradeId));
  if (ev.playerId !== undefined) parts.push(`pid${ev.playerId}`);
  if (ev.text !== undefined) parts.push(`"${ev.text}"`);
  return parts.join("|");
}

async function collectEvents(dtMs: number): Promise<EventEntry[]> {
  const sc = await createScenario({ seed: SEED, mode: "modern", rounds: ROUNDS });
  const events: EventEntry[] = [];
  sc.bus.onAny((type, event) => {
    if (DETERMINISTIC_TYPES.has(type)) {
      events.push({ ...(event as Record<string, unknown>), type });
    }
  });
  sc.runUntil(() => sc.state.round > ROUNDS - 1, 80000, dtMs);
  return events;
}
