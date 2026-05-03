/**
 * rubble_clearing fade-out: per-tick multiplier verification.
 *
 * Plays the game until rubble_clearing rolls, subscribes to TICK,
 * and samples `sc.overlay()?.battle?.rubbleClearingFade` every tick
 * post-sweep. After the run, prints the curve as a bar graph and
 * asserts the values match the formula in `deriveRubbleClearingFade`:
 *
 *   - Sweep frames: 1 (full opacity — snapshot captures held entities)
 *   - Post-sweep: linear ramp 1 → 0 + damped sine wave
 *   - Final tick before release: very close to 0
 *   - After release: undefined (held entries no longer rendered)
 *
 * Run with: deno test --no-check test/rubble-clearing-fade.test.ts
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  RUBBLE_CLEARING_RAMP_DURATION_MS,
  RUBBLE_CLEARING_WAVE_PEAK_AMPLITUDE,
  RUBBLE_CLEARING_WAVE_PERIOD_MS,
} from "../src/runtime/rubble-clearing-overlay.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { loadSeed } from "./scenario.ts";

interface Sample {
  elapsed: number;
  value: number | undefined;
  heldPits: number;
  heldDeadCannons: number;
}

const MAX_TIMEOUT_MS = 1_200_000;

Deno.test("rubble_clearing fade: opacity multiplier per tick after banner", async () => {
  using sc = await loadSeed("modifier:rubble_clearing_nonempty");

  let bannerSweptAt: number | undefined;
  let rubbleApplied = false;
  let heldPitsAtApply = 0;
  let heldDeadCannonsAtApply = 0;
  const samples: Sample[] = [];

  sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
    if (ev.modifierId === "rubble_clearing") rubbleApplied = true;
  });
  // Snapshot the held counts at the banner sweep so the test
  // observes the same overlay shape the renderer sees.
  sc.bus.on(GAME_EVENT.BANNER_SWEEP_END, (ev) => {
    if (
      rubbleApplied &&
      ev.bannerKind === "modifier-reveal" &&
      bannerSweptAt === undefined
    ) {
      bannerSweptAt = sc.now();
      heldPitsAtApply = sc.state.modern?.rubbleClearingHeld?.pits.length ?? 0;
      heldDeadCannonsAtApply =
        sc.state.modern?.rubbleClearingHeld?.deadCannons.length ?? 0;
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
      value: overlay?.battle?.rubbleClearingFade,
      heldPits: overlay?.battle?.heldRubblePits?.length ?? 0,
      heldDeadCannons: overlay?.battle?.heldDeadCannons?.length ?? 0,
    });
    if (
      stopSamplingAt === undefined &&
      elapsed >= RUBBLE_CLEARING_RAMP_DURATION_MS + 100
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

  assert(rubbleApplied, "rubble_clearing modifier should have applied");
  assert(bannerSweptAt !== undefined, "modifier banner should have swept");
  assert(samples.length > 0, "should have collected ticks after sweep");
  assert(
    heldPitsAtApply + heldDeadCannonsAtApply > 0,
    `held entities count must be > 0 to make the test meaningful (pits=${heldPitsAtApply}, deadCannons=${heldDeadCannonsAtApply})`,
  );

  // ----- Visual dump -----
  console.log(
    `\n  modifier captured ${heldPitsAtApply} pits + ${heldDeadCannonsAtApply} dead cannons before mutating\n`,
  );
  console.log(
    "  elapsed   value     expected   delta     held(p,c)   bar (40 chars = 1.0)",
  );
  console.log(
    "  -------   ------    --------   ------    ---------   ----------------------------------------",
  );
  for (const s of samples) {
    const expected = expectedFromSpec(s.elapsed);
    const actual = s.value;
    const renderedActual = actual ?? 0;
    const barLen = Math.round(renderedActual * 40);
    const bar = "█".repeat(barLen);
    const valueStr =
      actual === undefined ? "  (undef → no fade)" : actual.toFixed(4);
    const expectedStr =
      expected === undefined ? "(undef)" : expected.toFixed(4);
    const delta =
      actual === undefined || expected === undefined
        ? "      "
        : `${(actual - expected) >= 0 ? "+" : ""}${(actual - expected).toFixed(
            4,
          )}`;
    console.log(
      `  ${String(s.elapsed).padStart(7)}   ${valueStr.padEnd(7)}   ${expectedStr.padEnd(7)}   ${delta.padEnd(8)}   (${s.heldPits},${s.heldDeadCannons})       ${bar}`,
    );
  }

  // ----- Assertions -----
  // Per-tick: every defined tick within the ramp window must match the spec.
  for (const s of samples) {
    if (s.elapsed >= RUBBLE_CLEARING_RAMP_DURATION_MS) continue;
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

  // First post-sweep tick: held entities must be exposed in overlay.
  const first = samples[0]!;
  assertEquals(
    first.heldPits,
    heldPitsAtApply,
    "first post-sweep tick should expose all held pits",
  );
  assertEquals(
    first.heldDeadCannons,
    heldDeadCannonsAtApply,
    "first post-sweep tick should expose all held dead cannons",
  );

  // Post-release: value undefined and held entries no longer exposed.
  const postRelease = samples.filter(
    (s) => s.elapsed >= RUBBLE_CLEARING_RAMP_DURATION_MS + 50,
  );
  assert(
    postRelease.length > 0,
    "should have at least one post-release sample",
  );
  for (const s of postRelease) {
    assert(
      s.value === undefined,
      `post-release tick at elapsed=${s.elapsed}ms should be undefined, got ${s.value}`,
    );
    assertEquals(
      s.heldPits,
      0,
      `post-release tick at elapsed=${s.elapsed}ms should expose 0 held pits`,
    );
    assertEquals(
      s.heldDeadCannons,
      0,
      `post-release tick at elapsed=${s.elapsed}ms should expose 0 held dead cannons`,
    );
  }
});

function expectedFromSpec(elapsed: number): number | undefined {
  if (elapsed < 0) return 1;
  if (elapsed >= RUBBLE_CLEARING_RAMP_DURATION_MS) return undefined;
  const t = elapsed / RUBBLE_CLEARING_RAMP_DURATION_MS;
  const baseRamp = 1 - t;
  const amplitude = RUBBLE_CLEARING_WAVE_PEAK_AMPLITUDE * (1 - t);
  const oscillation = Math.sin(
    (elapsed / RUBBLE_CLEARING_WAVE_PERIOD_MS) * Math.PI * 2,
  );
  return clamp01(baseRamp + amplitude * oscillation);
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
