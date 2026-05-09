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

export function deriveModifierRamp(
  cfg: ModifierRampConfig,
): number | undefined {
  const elapsed = cfg.revealTimeMs;
  if (elapsed === undefined) return undefined;
  if (elapsed >= cfg.durationMs) return undefined;
  return cfg.compute(elapsed);
}
