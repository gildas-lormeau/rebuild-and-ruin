/**
 * fog_of_war progressive reveal: per-tick opacity verification.
 *
 * Plays the game until the fog_of_war modifier rolls, subscribes to the
 * per-frame TICK event, and samples `sc.overlay()?.battle?.fogRevealOpacity`
 * every tick. After the run, prints the post-banner curve as a bar graph
 * (so a human can scan it) and asserts the curve matches the expected
 * formula in `deriveFogRevealOpacity`:
 *
 *   - First post-sweep tick: REVEAL_FLOOR (0.2)
 *   - Subsequent ticks: linear ramp 0.2 → 1.0 + damped sine wave
 *   - Final tick before release: very close to 1
 *   - After release: undefined (no override; fog renders at full)
 *
 * Run with: deno test --no-check test/fog-reveal.test.ts
 */

import { assert, assertAlmostEquals } from "@std/assert";
import {
  FOG_REVEAL_FLOOR,
  FOG_REVEAL_RAMP_DURATION_MS,
  FOG_REVEAL_WAVE_PEAK_AMPLITUDE,
  FOG_REVEAL_WAVE_PERIOD_MS,
} from "../src/runtime/fog-reveal-overlay.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { loadSeed } from "./scenario.ts";

interface Sample {
  /** ms since the banner sweep ended (`BANNER_SWEEP_END` event time). */
  elapsed: number;
  /** Value read from `overlay.battle.fogRevealOpacity` this tick. */
  value: number | undefined;
}

const MAX_TIMEOUT_MS = 1_200_000;

Deno.test("fog_of_war reveal: opacity multiplier per tick after banner", async () => {
  using sc = await loadSeed("modifier:fog_of_war");

  let bannerSweptAt: number | undefined;
  let fogApplied = false;
  const samples: Sample[] = [];

  // Multiple modifiers can roll before fog_of_war hits — `loadSeed` only
  // guarantees fog_of_war eventually fires, not that it's first. Watch
  // MODIFIER_APPLIED for the fog_of_war specifically, then capture the
  // matching banner-sweep-end (the orchestrator transitions from
  // holding at the floor into the ramp on this beat).
  sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
    if (ev.modifierId === "fog_of_war") fogApplied = true;
  });
  sc.bus.on(GAME_EVENT.BANNER_SWEEP_END, (ev) => {
    if (
      fogApplied &&
      ev.bannerKind === "modifier-reveal" &&
      bannerSweptAt === undefined
    ) {
      bannerSweptAt = sc.now();
    }
  });

  // Sample fogRevealOpacity every tick once the sweep has ended.
  // Stop sampling once we've collected the whole ramp + a couple of
  // post-release ticks (caps the run length so the test doesn't drift
  // into the next phase).
  let stopSamplingAt: number | undefined;
  sc.bus.on(GAME_EVENT.TICK, () => {
    if (bannerSweptAt === undefined) return;
    const elapsed = sc.now() - bannerSweptAt;
    if (stopSamplingAt !== undefined && sc.now() > stopSamplingAt) return;
    samples.push({
      elapsed,
      value: sc.overlay()?.battle?.fogRevealOpacity,
    });
    if (
      stopSamplingAt === undefined &&
      elapsed >= FOG_REVEAL_RAMP_DURATION_MS + 100
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

  assert(bannerSweptAt !== undefined, "modifier banner should have swept");
  assert(samples.length > 0, "should have collected ticks after sweep");

  // ----- Visual dump (read by humans) -----
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
      actual === undefined ? "  (undef → renders at 1)" : actual.toFixed(4);
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

  // ----- Per-tick assertions -----
  // First post-sweep tick: should be at floor (linear ramp at t≈0,
  // sin(0)=0 → no wave contribution).
  const first = samples[0]!;
  assert(
    first.value !== undefined,
    `first post-sweep tick must define a value, got undefined`,
  );
  assertAlmostEquals(
    first.value,
    FOG_REVEAL_FLOOR,
    0.05,
    `first tick at elapsed=${first.elapsed}ms should ≈ FOG_REVEAL_FLOOR (${FOG_REVEAL_FLOOR})`,
  );

  // Every defined tick within the ramp window must match the spec
  // (within floating-point + tick-quantization tolerance).
  for (const s of samples) {
    if (s.elapsed >= FOG_REVEAL_RAMP_DURATION_MS) continue; // post-release
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

  // After ramp duration: value should be undefined (released — fog
  // manager treats undefined as "no override → full opacity").
  const postRelease = samples.filter(
    (s) => s.elapsed >= FOG_REVEAL_RAMP_DURATION_MS + 50,
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
  }
});

/** Re-implement the formula from `deriveFogRevealOpacity` as the test's
 *  expected value source. Not an oracle in disguise — keeping this here
 *  documents the spec the test enforces. */
function expectedFromSpec(elapsed: number): number | undefined {
  if (elapsed < 0) return FOG_REVEAL_FLOOR;
  if (elapsed >= FOG_REVEAL_RAMP_DURATION_MS) return undefined;
  const t = elapsed / FOG_REVEAL_RAMP_DURATION_MS;
  const baseRamp = FOG_REVEAL_FLOOR + (1 - FOG_REVEAL_FLOOR) * t;
  const amplitude = FOG_REVEAL_WAVE_PEAK_AMPLITUDE * (1 - t);
  const oscillation = Math.sin(
    (elapsed / FOG_REVEAL_WAVE_PERIOD_MS) * Math.PI * 2,
  );
  return clamp01(baseRamp + amplitude * oscillation);
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
