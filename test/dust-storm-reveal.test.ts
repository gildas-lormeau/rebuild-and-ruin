/**
 * dust_storm progressive reveal: per-tick sway-amplitude verification.
 *
 * Plays the game until the dust_storm modifier rolls, then samples
 * `sc.overlay()?.battle?.dustStormSwayAmplitude` (and the matching phase)
 * every tick for the full MODIFIER_REVEAL phase — from PHASE_START to
 * PHASE_END. Each sample is checked against the runtime derivers
 * (`deriveDustStormSway*`) for the reconstructed `revealTimeMs`, so the
 * test tracks the deriver instead of hard-coding a formula that drifts.
 *
 * Three regimes (see `reveal-time.ts` + `dust-storm.ts`):
 *
 *   1. Banner-sweep portion (revealTimeMs held at 0): amp = the breeze
 *      FLOOR (`compute(0)` of the waved ramp), phase = 0. The snapshot is
 *      held stable; phase 0 means zero *visible* displacement (sin(0)=0).
 *   2. Post-sweep envelope (0 ≤ revealTimeMs < DURATION): amp follows the
 *      waved ramp from FLOOR up to PEAK; phase ramps at the battle
 *      angular speed so the reveal ends mid-cycle with amp near peak.
 *   3. Post-envelope tail (revealTimeMs ≥ DURATION): released → undefined.
 *
 * Prints the per-tick curve as a bar graph (so a human can scan it) and
 * asserts (a) every sample matches the deriver, (b) the breeze floor holds
 * with zero phase during the sweep, (c) the envelope ramps up to ≥ 90% of
 * PEAK near its end with a strictly rising phase and a single sway
 * direction (composite sin(phase)·amp never goes negative), and (d) the
 * tail releases to undefined.
 *
 * Run with: deno test --no-check test/dust-storm-reveal.test.ts
 */

import { assert, assertAlmostEquals } from "@std/assert";
import {
  deriveDustStormSwayAmplitude,
  deriveDustStormSwayPhaseRad,
  DUST_STORM_REVEAL_DURATION_MS,
  DUST_STORM_REVEAL_PEAK_AMPLITUDE,
} from "../src/runtime/modifier-effects/dust-storm.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { loadSeed } from "./scenario.ts";

interface Sample {
  /** ms since `PHASE_START(MODIFIER_REVEAL)` for the dust_storm round. */
  elapsedFromPhaseStart: number;
  /** ms since `BANNER_SWEEP_END` for the modifier-reveal banner. Negative
   *  during the sweep portion of the phase (revealTimeMs held at 0 here). */
  elapsedFromSweepEnd: number;
  /** Value read from `overlay.battle.dustStormSwayAmplitude` this tick. */
  amp: number | undefined;
  /** Value read from `overlay.battle.dustStormSwayPhaseRad` this tick. */
  phase: number | undefined;
}

const MAX_TIMEOUT_MS = 1_200_000;
/** Reconstructed-vs-actual `revealTimeMs` can differ by up to one tick of
 *  curve movement; tolerate that rather than asserting sub-ms alignment. */
const AMP_TOLERANCE = 0.03;
const PHASE_TOLERANCE = 0.05;

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
    const { amp: expectedAmp, phase: expectedPhase } = expectedFor(
      s.elapsedFromSweepEnd,
    );
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

  // ----- Per-tick assertions: every sample matches the deriver -----
  for (const s of samples) {
    const { amp: expectedAmp, phase: expectedPhase } = expectedFor(
      s.elapsedFromSweepEnd,
    );
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
        AMP_TOLERANCE,
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
        PHASE_TOLERANCE,
        `phase+${s.elapsedFromPhaseStart}ms sweep+${s.elapsedFromSweepEnd}ms phase: got ${s.phase.toFixed(4)} expected ${expectedPhase.toFixed(4)}`,
      );
    }
  }

  // ----- Regime 1: banner sweep holds the breeze floor at zero phase -----
  // revealTimeMs is pinned to 0 during the sweep, so amp = compute(0) (the
  // FLOOR) and phase = 0 → no *visible* displacement (sin(0)·amp = 0).
  const floorAmp = deriveDustStormSwayAmplitude(0);
  assert(floorAmp !== undefined, "floor amp should be defined at revealTime=0");
  const preSweep = samples.filter((s) => s.elapsedFromSweepEnd < 0);
  assert(
    preSweep.length > 0,
    "should have at least one sample during the modifier-reveal banner sweep",
  );
  for (const s of preSweep) {
    assert(
      s.amp !== undefined,
      `pre-sweep tick at phase+${s.elapsedFromPhaseStart}ms: amp should be the breeze floor, got undefined`,
    );
    assertAlmostEquals(
      s.amp,
      floorAmp,
      AMP_TOLERANCE,
      `pre-sweep tick at phase+${s.elapsedFromPhaseStart}ms: amp should hold the breeze floor (${floorAmp.toFixed(4)}), got ${s.amp.toFixed(4)}`,
    );
    assert(
      s.phase === 0,
      `pre-sweep tick at phase+${s.elapsedFromPhaseStart}ms: phase should be 0 (no visible motion during sweep), got ${s.phase}`,
    );
  }

  // ----- Regime 2: post-sweep envelope -----
  const envelope = samples.filter(
    (s) =>
      s.elapsedFromSweepEnd >= 0 &&
      s.elapsedFromSweepEnd < DUST_STORM_REVEAL_DURATION_MS &&
      s.amp !== undefined &&
      s.phase !== undefined,
  );
  assert(envelope.length > 0, "should have envelope-window samples");

  // Continuity across the sweep→play boundary: the first envelope sample
  // matches the held breeze floor (both call compute(0)), so there's no
  // jump when the banner finishes sweeping.
  assertAlmostEquals(
    envelope[0]!.amp!,
    floorAmp,
    AMP_TOLERANCE,
    `envelope should start at the breeze floor (continuity), got ${envelope[0]!.amp}`,
  );

  // Phase ramps strictly upward (linear angular sweep) and stays in the
  // first half-cycle so sin(phase) — the visible direction — never flips.
  for (let i = 1; i < envelope.length; i++) {
    assert(
      envelope[i]!.phase! >= envelope[i - 1]!.phase! - 1e-9,
      `phase must ramp upward; sweep+${envelope[i - 1]!.elapsedFromSweepEnd}ms (${envelope[i - 1]!.phase}) → sweep+${envelope[i]!.elapsedFromSweepEnd}ms (${envelope[i]!.phase})`,
    );
  }
  for (const s of envelope) {
    const composite = Math.sin(s.phase!) * s.amp!;
    assert(
      composite >= -1e-9,
      `composite sin(phase)·amp must stay non-negative across the envelope (single sway direction). Got ${composite.toFixed(6)} at sweep+${s.elapsedFromSweepEnd}ms`,
    );
  }

  // Amplitude ramps up to near PEAK, and the peak lands near the END of
  // the window (the waved ramp climbs floor→peak; it is not a mid-window
  // bell). ≥ 90% of PEAK by the time the reveal hands off to battle.
  const peakSample = envelope.reduce((max, s) =>
    (s.amp ?? -Infinity) > (max.amp ?? -Infinity) ? s : max,
  );
  assert(
    peakSample.amp! >= DUST_STORM_REVEAL_PEAK_AMPLITUDE * 0.9,
    `peak sample amp (${peakSample.amp}) should reach ≥ 90% of PEAK (${DUST_STORM_REVEAL_PEAK_AMPLITUDE})`,
  );
  const peakT = peakSample.elapsedFromSweepEnd / DUST_STORM_REVEAL_DURATION_MS;
  assert(
    peakT > 0.7,
    `amp peak should land near the END of the envelope (ramp, not bell), got t=${peakT.toFixed(3)} at elapsed=${peakSample.elapsedFromSweepEnd}ms`,
  );

  // ----- Regime 3: post-envelope tail releases to undefined -----
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

/** Expected reveal scalars for a sample, taken straight from the runtime
 *  derivers so the test tracks them instead of a drift-prone formula. The
 *  runtime holds `revealTimeMs` at 0 during the banner sweep (negative
 *  `elapsedFromSweepEnd`), then counts ms since `BANNER_SWEEP_END`. */
function expectedFor(elapsedFromSweepEnd: number): {
  amp: number | undefined;
  phase: number | undefined;
} {
  const revealMs = elapsedFromSweepEnd < 0 ? 0 : elapsedFromSweepEnd;
  return {
    amp: deriveDustStormSwayAmplitude(revealMs),
    phase: deriveDustStormSwayPhaseRad(revealMs),
  };
}
