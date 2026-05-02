/**
 * Linear ramp + damped sine wave — the shared shape used by both
 * `deriveFogRevealOpacity` (fog reveal) and `deriveRubbleClearingFade`
 * (rubble fade-out). Same recipe, different `start` / `end` endpoints.
 *
 * The base motion is a linear lerp from `start` to `end` over
 * `durationMs`. A sine wave is added on top with peak amplitude at
 * `t = 0` shrinking linearly to zero at `t = 1`, so the curve always
 * lands cleanly on the endpoint regardless of the wave phase. The
 * wave's frequency is `1 / wavePeriodMs`.
 *
 * Returns a value clamped to `[0, 1]` — meant for opacity / alpha
 * multipliers. Caller is responsible for stopping the ramp when
 * `elapsed >= durationMs`; this helper does NOT short-circuit.
 */

export function wavedRamp(opts: {
  /** ms since the ramp started. */
  readonly elapsed: number;
  /** Total ramp duration in ms. */
  readonly durationMs: number;
  /** Start value (at elapsed = 0). */
  readonly start: number;
  /** End value (at elapsed = durationMs). */
  readonly end: number;
  /** Wave full-cycle period in ms. */
  readonly wavePeriodMs: number;
  /** Peak wave amplitude at `elapsed = 0`; decays linearly to 0 as
   *  the ramp completes so the curve converges on `end`. */
  readonly wavePeakAmplitude: number;
}): number {
  const t = opts.elapsed / opts.durationMs;
  const baseRamp = opts.start + (opts.end - opts.start) * t;
  const amplitude = opts.wavePeakAmplitude * (1 - t);
  const oscillation = Math.sin(
    (opts.elapsed / opts.wavePeriodMs) * Math.PI * 2,
  );
  return clamp01(baseRamp + amplitude * oscillation);
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
