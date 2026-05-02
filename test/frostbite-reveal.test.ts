/**
 * frostbite reveal: per-tick tint-intensity verification.
 *
 * Plays the game until frostbite rolls, subscribes to TICK,
 * and samples `sc.overlay()?.battle?.frostbiteRevealProgress`
 * every tick post-sweep. Asserts the values match the formula
 * in `deriveFrostbiteRevealProgress`:
 *
 *   - Sweep frames: REVEAL_FLOOR (snapshot captures grunts already
 *     faintly cooling)
 *   - Post-sweep: linear ramp FLOOR → 1 + damped sine wave
 *   - Final tick before release: very close to 1
 *   - After release: undefined (manager pins to 1 via the binary flag)
 *
 * Run with: deno test --no-check test/frostbite-reveal.test.ts
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  FROSTBITE_REVEAL_FLOOR,
  FROSTBITE_REVEAL_RAMP_DURATION_MS,
  FROSTBITE_REVEAL_WAVE_PEAK_AMPLITUDE,
  FROSTBITE_REVEAL_WAVE_PERIOD_MS,
} from "../src/runtime/frostbite-reveal-overlay.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { loadSeed } from "./scenario.ts";

interface Sample {
  elapsed: number;
  value: number | undefined;
}

const MAX_TIMEOUT_MS = 1_200_000;

Deno.test("frostbite reveal: tint multiplier per tick after banner", async () => {
  using sc = await loadSeed("modifier:frostbite");

  let bannerSweptAt: number | undefined;
  let frostbiteApplied = false;
  const samples: Sample[] = [];

  sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
    if (ev.modifierId === "frostbite") frostbiteApplied = true;
  });
  sc.bus.on(GAME_EVENT.BANNER_SWEEP_END, (ev) => {
    if (
      frostbiteApplied &&
      ev.bannerKind === "modifier-reveal" &&
      bannerSweptAt === undefined
    ) {
      bannerSweptAt = sc.now();
    }
  });

  let stopSamplingAt: number | undefined;
  sc.bus.on(GAME_EVENT.TICK, () => {
    if (bannerSweptAt === undefined) return;
    const elapsed = sc.now() - bannerSweptAt;
    if (stopSamplingAt !== undefined && sc.now() > stopSamplingAt) return;
    samples.push({
      elapsed,
      value: sc.overlay()?.battle?.frostbiteRevealProgress,
    });
    if (
      stopSamplingAt === undefined &&
      elapsed >= FROSTBITE_REVEAL_RAMP_DURATION_MS + 100
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

  assert(frostbiteApplied, "frostbite modifier should have applied");
  assert(bannerSweptAt !== undefined, "modifier banner should have swept");
  assert(samples.length > 0, "should have collected ticks after sweep");

  // ----- Visual dump -----
  console.log(
    "\n  elapsed   value     expected   delta     bar (40 chars = 1.0)",
  );
  console.log(
    "  -------   ------    --------   ------    ----------------------------------------",
  );
  for (const s of samples) {
    const expected = expectedFromSpec(s.elapsed);
    const actual = s.value;
    const renderedActual = actual ?? 1;
    const barLen = Math.round(renderedActual * 40);
    const bar = "█".repeat(barLen);
    const valueStr =
      actual === undefined
        ? "  (undef → renders at 1)"
        : actual.toFixed(4);
    const expectedStr =
      expected === undefined ? "(undef)" : expected.toFixed(4);
    const delta =
      actual === undefined || expected === undefined
        ? "      "
        : `${(actual - expected) >= 0 ? "+" : ""}${(actual - expected).toFixed(
            4,
          )}`;
    console.log(
      `  ${String(s.elapsed).padStart(7)}   ${valueStr.padEnd(7)}   ${expectedStr.padEnd(7)}   ${delta.padEnd(8)}   ${bar}`,
    );
  }

  // ----- Assertions -----
  for (const s of samples) {
    if (s.elapsed >= FROSTBITE_REVEAL_RAMP_DURATION_MS) continue;
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

  // First post-sweep tick: at floor (linear ramp at t≈0, wave is sin(0)=0).
  const first = samples[0]!;
  assert(first.value !== undefined, "first post-sweep tick must define a value");
  assertAlmostEquals(
    first.value,
    FROSTBITE_REVEAL_FLOOR,
    0.05,
    `first tick at elapsed=${first.elapsed}ms should ≈ FLOOR (${FROSTBITE_REVEAL_FLOOR})`,
  );

  // Post-release: value undefined (manager pins to 1 via flag).
  const postRelease = samples.filter(
    (s) => s.elapsed >= FROSTBITE_REVEAL_RAMP_DURATION_MS + 50,
  );
  assert(postRelease.length > 0, "should have at least one post-release sample");
  for (const s of postRelease) {
    assertEquals(
      s.value,
      undefined,
      `post-release tick at elapsed=${s.elapsed}ms should be undefined, got ${s.value}`,
    );
  }
});

function expectedFromSpec(elapsed: number): number | undefined {
  if (elapsed < 0) return FROSTBITE_REVEAL_FLOOR;
  if (elapsed >= FROSTBITE_REVEAL_RAMP_DURATION_MS) return undefined;
  const t = elapsed / FROSTBITE_REVEAL_RAMP_DURATION_MS;
  const baseRamp =
    FROSTBITE_REVEAL_FLOOR + (1 - FROSTBITE_REVEAL_FLOOR) * t;
  const amplitude = FROSTBITE_REVEAL_WAVE_PEAK_AMPLITUDE * (1 - t);
  const oscillation = Math.sin(
    (elapsed / FROSTBITE_REVEAL_WAVE_PERIOD_MS) * Math.PI * 2,
  );
  return clamp01(baseRamp + amplitude * oscillation);
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
