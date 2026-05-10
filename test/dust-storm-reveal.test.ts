/**
 * dust_storm progressive reveal: per-tick sway-amplitude verification.
 *
 * Plays the game until the dust_storm modifier rolls, then samples
 * `sc.overlay()?.battle?.dustStormSwayAmplitude` every tick for the
 * full 2-second MODIFIER_REVEAL phase — from PHASE_START to PHASE_END.
 * That window covers three regimes:
 *
 *   1. Banner-sweep portion (revealTimeMs = 0): deriver returns 0.
 *   2. Post-sweep envelope (0 ≤ revealTimeMs < DURATION):
 *      amp(t) = PEAK · sin²(t · π), t = elapsed / DURATION.
 *   3. Post-envelope tail (revealTimeMs ≥ DURATION): undefined (released).
 *
 * Prints the per-tick curve as a bar graph (so a human can scan it) and
 * asserts every sample matches the spec formula. Also asserts the
 * cosine bell hits its peak (≥ 90% of PEAK_AMPLITUDE) symmetrically in
 * the middle of the envelope window so a flat / wrong-shape regression
 * is caught.
 *
 * Run with: deno test --no-check test/dust-storm-reveal.test.ts
 */

import { assert, assertAlmostEquals } from "@std/assert";
import {
  DUST_STORM_REVEAL_DURATION_MS,
  DUST_STORM_REVEAL_PEAK_AMPLITUDE,
} from "../src/runtime/dust-storm-reveal-overlay.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { loadSeed } from "./scenario.ts";

interface Sample {
  /** ms since `PHASE_START(MODIFIER_REVEAL)` for the dust_storm round. */
  elapsedFromPhaseStart: number;
  /** ms since `BANNER_SWEEP_END` for the modifier-reveal banner. Negative
   *  during the sweep portion of the phase (derivers return 0 / 0 here). */
  elapsedFromSweepEnd: number;
  /** Value read from `overlay.battle.dustStormSwayAmplitude` this tick. */
  amp: number | undefined;
  /** Value read from `overlay.battle.dustStormSwayPhaseRad` this tick. */
  phase: number | undefined;
}

const MAX_TIMEOUT_MS = 1_200_000;

Deno.test("dust_storm reveal: sway amplitude per tick across the full 2s phase", async () => {
  using sc = await loadSeed("modifier:dust_storm");

  let dustApplied = false;
  let phaseStartedAt: number | undefined;
  let phaseEndedAt: number | undefined;
  let bannerSweptAt: number | undefined;
  const samples: Sample[] = [];

  // Multiple modifiers can roll before dust_storm hits — `loadSeed` only
  // guarantees dust_storm eventually fires, not that it's first. Latch
  // on the MODIFIER_APPLIED event for dust_storm specifically, then
  // capture the matching PHASE_START / BANNER_SWEEP_END / PHASE_END.
  sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
    if (ev.modifierId === "dust_storm") dustApplied = true;
  });
  sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
    if (
      dustApplied &&
      ev.phase === Phase.MODIFIER_REVEAL &&
      phaseStartedAt === undefined
    ) {
      phaseStartedAt = sc.now();
    }
  });
  sc.bus.on(GAME_EVENT.BANNER_SWEEP_END, (ev) => {
    if (
      phaseStartedAt !== undefined &&
      ev.bannerKind === "modifier-reveal" &&
      bannerSweptAt === undefined
    ) {
      bannerSweptAt = sc.now();
    }
  });
  sc.bus.on(GAME_EVENT.PHASE_END, (ev) => {
    if (
      phaseStartedAt !== undefined &&
      ev.phase === Phase.MODIFIER_REVEAL &&
      phaseEndedAt === undefined
    ) {
      phaseEndedAt = sc.now();
    }
  });

  // Sample both reveal scalars every tick from PHASE_START to PHASE_END.
  sc.bus.on(GAME_EVENT.TICK, () => {
    if (phaseStartedAt === undefined) return;
    if (phaseEndedAt !== undefined) return;
    const overlayBattle = sc.overlay()?.battle;
    samples.push({
      elapsedFromPhaseStart: sc.now() - phaseStartedAt,
      elapsedFromSweepEnd:
        bannerSweptAt === undefined ? -1 : sc.now() - bannerSweptAt,
      amp: overlayBattle?.dustStormSwayAmplitude,
      phase: overlayBattle?.dustStormSwayPhaseRad,
    });
  });

  sc.runUntil(() => phaseEndedAt !== undefined, { timeoutMs: MAX_TIMEOUT_MS });

  assert(phaseStartedAt !== undefined, "MODIFIER_REVEAL phase should start");
  assert(bannerSweptAt !== undefined, "modifier banner should sweep");
  assert(phaseEndedAt !== undefined, "MODIFIER_REVEAL phase should end");
  assert(samples.length > 0, "should have collected ticks");

  // ----- Visual dump (read by humans): both scalars + the
  //       composite shader displacement they drive -----
  console.log(
    "\n  phase   sweep    amp      ampExp   phase   phsExp   sin·amp  bar (40 chars = 1.0)",
  );
  console.log(
    "  -----   ------   ------   ------   -----   ------   -------  ----------------------------------------",
  );
  for (const s of samples) {
    const expectedAmp = expectedAmpFromSpec(s.elapsedFromSweepEnd);
    const expectedPhase = expectedPhaseFromSpec(s.elapsedFromSweepEnd);
    const composite =
      s.amp === undefined || s.phase === undefined
        ? undefined
        : Math.sin(s.phase) * s.amp;
    const ampStr = s.amp === undefined ? "(undef)" : s.amp.toFixed(4);
    const phaseStr = s.phase === undefined ? "(undef)" : s.phase.toFixed(3);
    const ampExpStr =
      expectedAmp === undefined ? "(undef)" : expectedAmp.toFixed(4);
    const phaseExpStr =
      expectedPhase === undefined ? "(undef)" : expectedPhase.toFixed(3);
    const compStr =
      composite === undefined
        ? "(undef)"
        : `${composite >= 0 ? "+" : ""}${composite.toFixed(4)}`;
    const renderedComposite = composite ?? 0;
    // sin·amp ∈ [-PEAK, +PEAK]; map [-1, 1] band to [0, 40] cells, with
    // 20 = neutral. Lets the reader spot direction reversals.
    const barLen = Math.max(0, Math.round(20 + renderedComposite * 20));
    const bar = "█".repeat(Math.min(40, barLen));
    const sweepStr =
      s.elapsedFromSweepEnd < 0
        ? "  pre"
        : String(s.elapsedFromSweepEnd).padStart(6);
    console.log(
      `  ${String(s.elapsedFromPhaseStart).padStart(5)}   ${sweepStr}   ${ampStr.padEnd(7)}  ${ampExpStr.padEnd(7)}  ${phaseStr.padEnd(6)}  ${phaseExpStr.padEnd(7)}  ${compStr.padEnd(7)}  ${bar}`,
    );
  }

  // ----- Per-tick assertions: every sample matches the spec exactly -----
  for (const s of samples) {
    const expectedAmp = expectedAmpFromSpec(s.elapsedFromSweepEnd);
    const expectedPhase = expectedPhaseFromSpec(s.elapsedFromSweepEnd);
    if (expectedAmp === undefined) {
      assert(
        s.amp === undefined,
        `phase+${s.elapsedFromPhaseStart}ms sweep+${s.elapsedFromSweepEnd}ms: amp expected undefined, got ${s.amp}`,
      );
    } else {
      assert(
        s.amp !== undefined,
        `phase+${s.elapsedFromPhaseStart}ms sweep+${s.elapsedFromSweepEnd}ms: amp expected ${expectedAmp.toFixed(4)}, got undefined`,
      );
      assertAlmostEquals(
        s.amp,
        expectedAmp,
        1e-6,
        `phase+${s.elapsedFromPhaseStart}ms sweep+${s.elapsedFromSweepEnd}ms amp: got ${s.amp.toFixed(4)} expected ${expectedAmp.toFixed(4)}`,
      );
    }
    if (expectedPhase === undefined) {
      assert(
        s.phase === undefined,
        `phase+${s.elapsedFromPhaseStart}ms sweep+${s.elapsedFromSweepEnd}ms: phase expected undefined, got ${s.phase}`,
      );
    } else {
      assert(
        s.phase !== undefined,
        `phase+${s.elapsedFromPhaseStart}ms sweep+${s.elapsedFromSweepEnd}ms: phase expected ${expectedPhase.toFixed(4)}, got undefined`,
      );
      assertAlmostEquals(
        s.phase,
        expectedPhase,
        1e-6,
        `phase+${s.elapsedFromPhaseStart}ms sweep+${s.elapsedFromSweepEnd}ms phase: got ${s.phase.toFixed(4)} expected ${expectedPhase.toFixed(4)}`,
      );
    }
  }

  // ----- Shape assertions: prove the envelope is a cosine bell AND
  //       the composite displacement is monotonic up-then-down (no
  //       direction reversals during reveal). The composite is what
  //       actually drives `swayOffsetPx` in the shader, so this is
  //       the user-visible motion the test guards. -----

  // Pre-sweep portion exists and both scalars are zero.
  const preSweep = samples.filter((s) => s.elapsedFromSweepEnd < 0);
  assert(
    preSweep.length > 0,
    "should have at least one sample during the modifier-reveal banner sweep",
  );
  for (const s of preSweep) {
    assert(
      s.amp === 0,
      `pre-sweep tick at phase+${s.elapsedFromPhaseStart}ms: amp should be 0 (revealTimeMs=0), got ${s.amp}`,
    );
    assert(
      s.phase === 0,
      `pre-sweep tick at phase+${s.elapsedFromPhaseStart}ms: phase should be 0 (revealTimeMs=0), got ${s.phase}`,
    );
  }

  // Composite displacement (sin(phase) · amp — what the shader draws):
  // strictly non-negative across the envelope and monotonic up to the
  // peak, monotonic down after. Catches direction-reversal regressions.
  const envelopeSamplesForShape = samples.filter(
    (s) =>
      s.elapsedFromSweepEnd >= 0 &&
      s.elapsedFromSweepEnd < DUST_STORM_REVEAL_DURATION_MS &&
      s.amp !== undefined &&
      s.phase !== undefined,
  );
  let peakIdx = 0;
  let peakComposite = -Infinity;
  for (let i = 0; i < envelopeSamplesForShape.length; i++) {
    const s = envelopeSamplesForShape[i]!;
    const c = Math.sin(s.phase!) * s.amp!;
    assert(
      c >= -1e-9,
      `composite sin(phase)·amp must stay non-negative across the envelope (no L↔R reversal). Got ${c.toFixed(6)} at sweep+${s.elapsedFromSweepEnd}ms`,
    );
    if (c > peakComposite) {
      peakComposite = c;
      peakIdx = i;
    }
  }
  // Strictly increasing up to peak (within sample-rate tolerance).
  for (let i = 1; i <= peakIdx; i++) {
    const prev = envelopeSamplesForShape[i - 1]!;
    const cur = envelopeSamplesForShape[i]!;
    const cPrev = Math.sin(prev.phase!) * prev.amp!;
    const cCur = Math.sin(cur.phase!) * cur.amp!;
    assert(
      cCur >= cPrev - 1e-9,
      `composite must be monotonic-non-decreasing up to peak; sweep+${prev.elapsedFromSweepEnd}ms (${cPrev.toFixed(6)}) → sweep+${cur.elapsedFromSweepEnd}ms (${cCur.toFixed(6)})`,
    );
  }
  // Strictly decreasing after peak.
  for (let i = peakIdx + 1; i < envelopeSamplesForShape.length; i++) {
    const prev = envelopeSamplesForShape[i - 1]!;
    const cur = envelopeSamplesForShape[i]!;
    const cPrev = Math.sin(prev.phase!) * prev.amp!;
    const cCur = Math.sin(cur.phase!) * cur.amp!;
    assert(
      cCur <= cPrev + 1e-9,
      `composite must be monotonic-non-increasing after peak; sweep+${prev.elapsedFromSweepEnd}ms (${cPrev.toFixed(6)}) → sweep+${cur.elapsedFromSweepEnd}ms (${cCur.toFixed(6)})`,
    );
  }

  // Envelope window peak: must hit ≥ 90% of PEAK_AMPLITUDE somewhere.
  const envelopeSamples = samples.filter(
    (s) =>
      s.elapsedFromSweepEnd >= 0 &&
      s.elapsedFromSweepEnd < DUST_STORM_REVEAL_DURATION_MS &&
      s.amp !== undefined,
  );
  assert(
    envelopeSamples.length > 0,
    "should have envelope-window samples",
  );
  const peakSample = envelopeSamples.reduce((max, s) =>
    (s.amp ?? -Infinity) > (max.amp ?? -Infinity) ? s : max,
  );
  assert(
    peakSample.amp !== undefined &&
      peakSample.amp >= DUST_STORM_REVEAL_PEAK_AMPLITUDE * 0.9,
    `peak sample amp (${peakSample.amp}) should reach ≥ 90% of PEAK_AMPLITUDE (${DUST_STORM_REVEAL_PEAK_AMPLITUDE})`,
  );

  // Peak lands near the middle of the envelope (cosine bell symmetric).
  const peakT = peakSample.elapsedFromSweepEnd / DUST_STORM_REVEAL_DURATION_MS;
  assert(
    peakT > 0.3 && peakT < 0.7,
    `peak should land near middle of envelope, got t=${peakT.toFixed(3)} at elapsed=${peakSample.elapsedFromSweepEnd}ms`,
  );

  // Post-envelope tail (still in MODIFIER_REVEAL phase, but past
  // DURATION_MS): deriver releases → both scalars undefined.
  const postEnvelope = samples.filter(
    (s) => s.elapsedFromSweepEnd >= DUST_STORM_REVEAL_DURATION_MS,
  );
  assert(
    postEnvelope.length > 0,
    "phase should outlast the envelope window (post-envelope tail must exist)",
  );
  for (const s of postEnvelope) {
    assert(
      s.amp === undefined,
      `post-envelope tick at sweep+${s.elapsedFromSweepEnd}ms: amp should be undefined, got ${s.amp}`,
    );
    assert(
      s.phase === undefined,
      `post-envelope tick at sweep+${s.elapsedFromSweepEnd}ms: phase should be undefined, got ${s.phase}`,
    );
  }
});

/** Re-implement the amplitude formula from `deriveDustStormSwayAmplitude`
 *  as the test's expected value source. Cosine bell `PEAK · sin²(t·π)`
 *  with zero slope at t=0 and t=1. */
function expectedAmpFromSpec(elapsedFromSweepEnd: number): number | undefined {
  if (elapsedFromSweepEnd < 0) return 0;
  if (elapsedFromSweepEnd >= DUST_STORM_REVEAL_DURATION_MS) return undefined;
  const t = elapsedFromSweepEnd / DUST_STORM_REVEAL_DURATION_MS;
  const bell = Math.sin(t * Math.PI);
  return DUST_STORM_REVEAL_PEAK_AMPLITUDE * bell * bell;
}

/** Re-implement the phase formula from `deriveDustStormSwayPhaseRad`.
 *  Linear ramp 0 → π across the reveal window — same `revealTimeMs`
 *  source as the amplitude, so the two stay synchronized. */
function expectedPhaseFromSpec(
  elapsedFromSweepEnd: number,
): number | undefined {
  if (elapsedFromSweepEnd < 0) return 0;
  if (elapsedFromSweepEnd >= DUST_STORM_REVEAL_DURATION_MS) return undefined;
  return (elapsedFromSweepEnd * Math.PI) / DUST_STORM_REVEAL_DURATION_MS;
}
