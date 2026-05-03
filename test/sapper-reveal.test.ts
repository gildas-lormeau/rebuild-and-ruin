/**
 * sapper reveal: per-tick tint-pulse verification.
 *
 * Plays the game until sapper rolls, subscribes to TICK, samples
 * `sc.overlay()?.battle?.sapperRevealIntensity` (and the targeted-wall
 * set) every tick post-sweep. After the run, prints the pulse curve as
 * a bar graph and asserts each value matches the formula in
 * `deriveSapperRevealIntensity` (bell envelope × pulse wave).
 *
 * Run with: deno test --no-check test/sapper-reveal.test.ts
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  SAPPER_REVEAL_PEAK_INTENSITY,
  SAPPER_REVEAL_PULSE_PERIOD_MS,
  SAPPER_REVEAL_RAMP_DURATION_MS,
} from "../src/runtime/sapper-reveal-overlay.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { loadSeed } from "./scenario.ts";

interface Sample {
  elapsed: number;
  value: number | undefined;
  targetedWalls: number;
}

const MAX_TIMEOUT_MS = 1_200_000;

Deno.test("sapper reveal: tint pulse per tick after banner", async () => {
  using sc = await loadSeed("modifier:sapper");

  let bannerSweptAt: number | undefined;
  let sapperApplied = false;
  let targetedAtSweep = 0;
  const samples: Sample[] = [];

  sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
    if (ev.modifierId === "sapper") sapperApplied = true;
  });
  sc.bus.on(GAME_EVENT.BANNER_SWEEP_END, (ev) => {
    if (
      sapperApplied &&
      ev.bannerKind === "modifier-reveal" &&
      bannerSweptAt === undefined
    ) {
      bannerSweptAt = sc.now();
      targetedAtSweep =
        sc.overlay()?.battle?.sapperTargetedWalls?.length ?? 0;
    }
  });

  let stopSamplingAt: number | undefined;
  sc.bus.on(GAME_EVENT.TICK, () => {
    if (bannerSweptAt === undefined) return;
    const elapsed = sc.now() - bannerSweptAt;
    if (stopSamplingAt !== undefined && sc.now() > stopSamplingAt) return;
    const overlay = sc.overlay();
    samples.push({
      elapsed,
      value: overlay?.battle?.sapperRevealIntensity,
      targetedWalls: overlay?.battle?.sapperTargetedWalls?.length ?? 0,
    });
    if (
      stopSamplingAt === undefined &&
      elapsed >= SAPPER_REVEAL_RAMP_DURATION_MS + 100
    ) {
      stopSamplingAt = sc.now() + 50;
    }
  });

  sc.runUntil(
    () =>
      stopSamplingAt !== undefined &&
      sc.now() > stopSamplingAt &&
      samples.length > 0,
    { timeoutMs: MAX_TIMEOUT_MS },
  );

  assert(sapperApplied, "sapper modifier should have applied");
  assert(bannerSweptAt !== undefined, "modifier banner should have swept");
  assert(samples.length > 0, "should have collected ticks after sweep");
  assert(
    targetedAtSweep > 0,
    `targeted-wall count must be > 0 to make the test meaningful (got ${targetedAtSweep})`,
  );

  // ----- Visual dump -----
  console.log(
    `\n  sapper marked ${targetedAtSweep} walls for attack at sweep\n`,
  );
  console.log(
    "  elapsed   value     expected   delta     targeted   bar (40 chars = 1.0)",
  );
  console.log(
    "  -------   ------    --------   ------    --------   ----------------------------------------",
  );
  for (const s of samples) {
    const expected = expectedFromSpec(s.elapsed);
    const actual = s.value;
    const renderedActual = actual ?? 0;
    const barLen = Math.round(renderedActual * 40);
    const bar = "█".repeat(barLen);
    const valueStr =
      actual === undefined ? "  (undef → no tint)" : actual.toFixed(4);
    const expectedStr =
      expected === undefined ? "(undef)" : expected.toFixed(4);
    const delta =
      actual === undefined || expected === undefined
        ? "      "
        : `${actual - expected >= 0 ? "+" : ""}${(actual - expected).toFixed(4)}`;
    console.log(
      `  ${String(s.elapsed).padStart(7)}   ${valueStr.padEnd(7)}   ${expectedStr.padEnd(7)}   ${delta.padEnd(8)}   ${String(s.targetedWalls).padStart(8)}   ${bar}`,
    );
  }

  // ----- Assertions -----
  for (const s of samples) {
    if (s.elapsed >= SAPPER_REVEAL_RAMP_DURATION_MS) continue;
    if (s.value === undefined) continue;
    const expected = expectedFromSpec(s.elapsed);
    assert(
      expected !== undefined,
      `mid-ramp expected must be defined for elapsed=${s.elapsed}ms`,
    );
    assertAlmostEquals(
      s.value,
      expected,
      1e-6,
      `tick at elapsed=${s.elapsed}ms: got ${s.value.toFixed(4)} expected ${expected.toFixed(4)}`,
    );
  }

  // First post-sweep tick: targeted walls exposed.
  const first = samples[0]!;
  assertEquals(
    first.targetedWalls,
    targetedAtSweep,
    "first post-sweep tick should expose all targeted walls",
  );

  // Post-release: intensity undefined.
  const postRelease = samples.filter(
    (s) => s.elapsed >= SAPPER_REVEAL_RAMP_DURATION_MS + 50,
  );
  assert(
    postRelease.length > 0,
    "should have at least one post-release sample",
  );
  for (const s of postRelease) {
    assertEquals(
      s.value,
      undefined,
      `post-release tick at elapsed=${s.elapsed}ms should be undefined, got ${s.value}`,
    );
  }
});

function expectedFromSpec(elapsed: number): number | undefined {
  if (elapsed < 0) return 0;
  if (elapsed >= SAPPER_REVEAL_RAMP_DURATION_MS) return undefined;
  const t = elapsed / SAPPER_REVEAL_RAMP_DURATION_MS;
  const envelope = Math.sin(t * Math.PI);
  const pulse =
    0.5 +
    0.5 * Math.sin((elapsed / SAPPER_REVEAL_PULSE_PERIOD_MS) * Math.PI * 2);
  return SAPPER_REVEAL_PEAK_INTENSITY * envelope * pulse;
}
