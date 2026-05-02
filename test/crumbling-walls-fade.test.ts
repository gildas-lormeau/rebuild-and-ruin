/**
 * crumbling_walls fade-out: per-tick multiplier verification.
 *
 * Plays the game until crumbling_walls rolls, subscribes to TICK,
 * and samples `sc.overlay()?.battle?.crumblingWallsFade` every tick
 * post-sweep. After the run, prints the curve as a bar graph and
 * asserts the values match the formula in `deriveCrumblingWallsFade`:
 *
 *   - Sweep frames: 1 (full opacity — snapshot captures held walls)
 *   - Post-sweep: linear ramp 1 → 0 + damped sine wave
 *   - Final tick before release: very close to 0
 *   - After release: undefined (held walls no longer rendered)
 *
 * Run with: deno test --no-check test/crumbling-walls-fade.test.ts
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  CRUMBLING_WALLS_RAMP_DURATION_MS,
  CRUMBLING_WALLS_WAVE_PEAK_AMPLITUDE,
  CRUMBLING_WALLS_WAVE_PERIOD_MS,
} from "../src/runtime/crumbling-walls-overlay.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { loadSeed } from "./scenario.ts";

interface Sample {
  elapsed: number;
  value: number | undefined;
  heldWalls: number;
}

const MAX_TIMEOUT_MS = 1_200_000;

Deno.test("crumbling_walls fade: opacity multiplier per tick after banner", async () => {
  using sc = await loadSeed("modifier:crumbling_walls");

  let bannerSweptAt: number | undefined;
  let crumblingApplied = false;
  let heldWallsAtApply = 0;
  const samples: Sample[] = [];

  sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
    if (ev.modifierId === "crumbling_walls") crumblingApplied = true;
  });
  // MODIFIER_APPLIED fires at modifier-roll time, BEFORE apply()
  // populates `crumblingWallsHeld`. Snapshot the held count at the
  // banner sweep — by then apply() has run and the held set is in place.
  sc.bus.on(GAME_EVENT.BANNER_SWEEP_END, (ev) => {
    if (
      crumblingApplied &&
      ev.bannerKind === "modifier-reveal" &&
      bannerSweptAt === undefined
    ) {
      bannerSweptAt = sc.now();
      heldWallsAtApply = sc.state.modern?.crumblingWallsHeld?.length ?? 0;
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
      value: overlay?.battle?.crumblingWallsFade,
      heldWalls: overlay?.battle?.heldDestroyedWalls?.length ?? 0,
    });
    if (
      stopSamplingAt === undefined &&
      elapsed >= CRUMBLING_WALLS_RAMP_DURATION_MS + 100
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

  assert(crumblingApplied, "crumbling_walls modifier should have applied");
  assert(bannerSweptAt !== undefined, "modifier banner should have swept");
  assert(samples.length > 0, "should have collected ticks after sweep");
  assert(
    heldWallsAtApply > 0,
    `held walls count must be > 0 to make the test meaningful (got ${heldWallsAtApply})`,
  );

  // ----- Visual dump -----
  console.log(
    `\n  modifier captured ${heldWallsAtApply} destroyed walls before mutating\n`,
  );
  console.log(
    "  elapsed   value     expected   delta     held    bar (40 chars = 1.0)",
  );
  console.log(
    "  -------   ------    --------   ------    ----    ----------------------------------------",
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
      `  ${String(s.elapsed).padStart(7)}   ${valueStr.padEnd(7)}   ${expectedStr.padEnd(7)}   ${delta.padEnd(8)}   ${String(s.heldWalls).padStart(4)}    ${bar}`,
    );
  }

  // ----- Assertions -----
  // Per-tick: every defined tick within the ramp window must match the spec.
  for (const s of samples) {
    if (s.elapsed >= CRUMBLING_WALLS_RAMP_DURATION_MS) continue;
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

  // First post-sweep tick: held walls must be exposed in overlay.
  const first = samples[0]!;
  assertEquals(
    first.heldWalls,
    heldWallsAtApply,
    "first post-sweep tick should expose all held walls",
  );

  // Post-release: fade value is undefined (so the walls manager stops
  // rendering held walls), but held walls REMAIN exposed in the
  // overlay for the rest of the MODIFIER_REVEAL phase. The debris
  // manager keeps the rubble visible at full opacity through this
  // bridge window so the tiles don't flash to grass before battle
  // starts (where `battleWalls` then takes over via the
  // `snapshotAllWalls` held union).
  const postRelease = samples.filter(
    (s) => s.elapsed >= CRUMBLING_WALLS_RAMP_DURATION_MS + 50,
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
      s.heldWalls,
      heldWallsAtApply,
      `post-release tick at elapsed=${s.elapsed}ms should still expose all held walls (debris bridge until BATTLE entry)`,
    );
  }
});

function expectedFromSpec(elapsed: number): number | undefined {
  if (elapsed < 0) return 1;
  if (elapsed >= CRUMBLING_WALLS_RAMP_DURATION_MS) return undefined;
  const t = elapsed / CRUMBLING_WALLS_RAMP_DURATION_MS;
  const baseRamp = 1 - t;
  const amplitude = CRUMBLING_WALLS_WAVE_PEAK_AMPLITUDE * (1 - t);
  const oscillation = Math.sin(
    (elapsed / CRUMBLING_WALLS_WAVE_PERIOD_MS) * Math.PI * 2,
  );
  return clamp01(baseRamp + amplitude * oscillation);
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
