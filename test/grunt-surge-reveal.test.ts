/**
 * grunt_surge reveal: per-tick tint-pulse verification.
 *
 * Plays the game until grunt_surge rolls, subscribes to TICK, samples
 * `sc.overlay()?.battle?.gruntSurgeRevealIntensity` (and the spawn-tile
 * set) every tick post-sweep. Asserts each value matches the formula
 * in `deriveGruntSurgeRevealIntensity` (bell envelope × pulse wave).
 *
 * Run with: deno test --no-check test/grunt-surge-reveal.test.ts
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  GRUNT_SURGE_REVEAL_PEAK_INTENSITY,
  GRUNT_SURGE_REVEAL_PULSE_PERIOD_MS,
  GRUNT_SURGE_REVEAL_RAMP_DURATION_MS,
} from "../src/runtime/grunt-surge-reveal-overlay.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { loadSeed } from "./scenario.ts";

interface Sample {
  elapsed: number;
  value: number | undefined;
  spawnTiles: number;
}

const MAX_TIMEOUT_MS = 1_200_000;

Deno.test("grunt_surge reveal: tint pulse per tick after banner", async () => {
  using sc = await loadSeed("modifier:grunt_surge");

  let bannerSweptAt: number | undefined;
  let surgeApplied = false;
  let spawnTilesAtSweep = 0;
  const samples: Sample[] = [];

  sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
    if (ev.modifierId === "grunt_surge") surgeApplied = true;
  });
  sc.bus.on(GAME_EVENT.BANNER_SWEEP_END, (ev) => {
    if (
      surgeApplied &&
      ev.bannerKind === "modifier-reveal" &&
      bannerSweptAt === undefined
    ) {
      bannerSweptAt = sc.now();
      spawnTilesAtSweep =
        sc.overlay()?.battle?.gruntSurgeSpawnTiles?.length ?? 0;
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
      value: overlay?.battle?.gruntSurgeRevealIntensity,
      spawnTiles: overlay?.battle?.gruntSurgeSpawnTiles?.length ?? 0,
    });
    if (
      stopSamplingAt === undefined &&
      elapsed >= GRUNT_SURGE_REVEAL_RAMP_DURATION_MS + 100
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

  assert(surgeApplied, "grunt_surge modifier should have applied");
  assert(bannerSweptAt !== undefined, "modifier banner should have swept");
  assert(samples.length > 0, "should have collected ticks after sweep");
  assert(
    spawnTilesAtSweep > 0,
    `spawn-tile count must be > 0 to make the test meaningful (got ${spawnTilesAtSweep})`,
  );

  // ----- Visual dump -----
  console.log(
    `\n  grunt_surge spawned ${spawnTilesAtSweep} fresh grunts at sweep\n`,
  );
  console.log(
    "  elapsed   value     expected   delta     spawns   bar (40 chars = 1.0)",
  );
  console.log(
    "  -------   ------    --------   ------    ------   ----------------------------------------",
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
      `  ${String(s.elapsed).padStart(7)}   ${valueStr.padEnd(7)}   ${expectedStr.padEnd(7)}   ${delta.padEnd(8)}   ${String(s.spawnTiles).padStart(6)}   ${bar}`,
    );
  }

  // ----- Assertions -----
  for (const s of samples) {
    if (s.elapsed >= GRUNT_SURGE_REVEAL_RAMP_DURATION_MS) continue;
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

  // First post-sweep tick: spawn tiles exposed.
  const first = samples[0]!;
  assertEquals(
    first.spawnTiles,
    spawnTilesAtSweep,
    "first post-sweep tick should expose all spawn tiles",
  );

  // Post-release: intensity undefined.
  const postRelease = samples.filter(
    (s) => s.elapsed >= GRUNT_SURGE_REVEAL_RAMP_DURATION_MS + 50,
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
  if (elapsed >= GRUNT_SURGE_REVEAL_RAMP_DURATION_MS) return undefined;
  const t = elapsed / GRUNT_SURGE_REVEAL_RAMP_DURATION_MS;
  const envelope = Math.sin(t * Math.PI);
  const pulse =
    0.5 +
    0.5 *
      Math.sin((elapsed / GRUNT_SURGE_REVEAL_PULSE_PERIOD_MS) * Math.PI * 2);
  return GRUNT_SURGE_REVEAL_PEAK_INTENSITY * envelope * pulse;
}
