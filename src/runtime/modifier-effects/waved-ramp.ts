/**
 * Linear ramp + damped sine wave shared by fog/rubble overlay derivations.
 * Linear lerp from `start` to `end` over `durationMs`; a sine wave
 * (frequency `1 / wavePeriodMs`) layers on top with peak amplitude at
 * `t = 0`, decaying linearly to zero at `t = 1` so the curve always lands
 * cleanly on the endpoint. Returns a `[0, 1]`-clamped opacity multiplier.
 * Caller stops the ramp at `elapsed >= durationMs` — no short-circuit.
 */

export function wavedRamp(opts: {
  /** ms since the ramp started. */
  readonly elapsed: number;
  /** Total ramp duration in ms. */
  readonly durationMs: number;
  /** Initial endpoint of the linear lerp. */
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
