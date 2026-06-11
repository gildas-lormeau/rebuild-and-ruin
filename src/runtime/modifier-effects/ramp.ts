/**
 * Shared driver for runtime-side modifier-reveal ramps. Per-modifier
 * overlay files declare a curve `compute(elapsedMs)` + `durationMs`. Map:
 * undefined → undefined (release); inside → compute(elapsed); past
 * duration → undefined. Continuity: snapshot and first playing frame both
 * call compute(0), so the value is identical across the sweep boundary
 * by construction. No banner imports here.
 */

interface ModifierRampConfig {
  readonly revealTimeMs: number | undefined;
  readonly durationMs: number;
  readonly compute: (elapsedMs: number) => number;
}

/** Uniform reveal-window tuning shared by every modifier's 2D overlay
 *  ramp — the reveal must read as one beat regardless of which modifier
 *  rolled. Per-modifier files bind these to their own exported names
 *  (their tests' oracle surface); a modifier that should deliberately
 *  diverge replaces the reference with its own literal. */
export const MODIFIER_REVEAL_RAMP_DURATION_MS = 1100;
/** Rolling-in wave period for the soft overlays (fog/frostbite/rubble/dust). */
export const MODIFIER_REVEAL_WAVE_PERIOD_MS = 320;
/** Peak wave amplitude at t=0 for the soft overlays. */
export const MODIFIER_REVEAL_WAVE_PEAK_AMPLITUDE = 0.3;
/** Fast threat-pulse period for the tint overlays (sapper/grunt-surge). */
export const MODIFIER_REVEAL_THREAT_PULSE_PERIOD_MS = 280;
/** Peak tint mix for the threat overlays. */
export const MODIFIER_REVEAL_THREAT_PEAK_INTENSITY = 0.85;

export function deriveModifierRamp(
  cfg: ModifierRampConfig,
): number | undefined {
  const elapsed = cfg.revealTimeMs;
  if (elapsed === undefined) return undefined;
  if (elapsed >= cfg.durationMs) return undefined;
  return cfg.compute(elapsed);
}
