/**
 * Bell envelope modulated by a fast pulse — a "warning siren" curve
 * that builds, oscillates, and fades. Shared by sapper / grunt-surge
 * reveal intensities. Returns `peak · sin(π·t) · pulseWave` where the
 * pulse rides in `[0, 1]` (no negative phase) so the result stays in
 * `[0, peak]`. Caller stops the ramp at `elapsed >= durationMs` — no
 * short-circuit.
 */

export function bellPulse(opts: {
  /** ms since the ramp started. */
  readonly elapsed: number;
  /** Total ramp duration in ms. The bell peaks at `elapsed = durationMs / 2`. */
  readonly durationMs: number;
  /** Pulse full-cycle period in ms. Shorter = more rapid flashes within
   *  the bell window. */
  readonly pulsePeriodMs: number;
  /** Peak value reached at the bell's apex when the pulse is at 1. */
  readonly peak: number;
}): number {
  const progress = opts.elapsed / opts.durationMs;
  const envelope = Math.sin(progress * Math.PI);
  const pulse =
    0.5 + 0.5 * Math.sin((opts.elapsed / opts.pulsePeriodMs) * Math.PI * 2);
  return opts.peak * envelope * pulse;
}
