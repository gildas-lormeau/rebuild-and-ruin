/**
 * Shared driver for runtime-side modifier-reveal ramps.
 *
 * Per-modifier overlay files (fog, rubble_clearing, frostbite, crumbling
 * walls, sapper, grunt_surge, ...) declare a curve `compute(elapsedMs)` and
 * a `durationMs` budget. This helper turns the runtime-supplied
 * `revealTimeMs` (see `modifier-reveal-time.ts` — the single banner-aware
 * site) into a per-frame value:
 *
 *   revealTimeMs === undefined  → undefined  (release; manager pins or
 *                                              falls back to steady state)
 *   revealTimeMs === 0          → compute(0) (snapshot capture window)
 *   0 < revealTimeMs < duration → compute(revealTimeMs)
 *   revealTimeMs >= duration    → undefined
 *
 * Continuity guarantee: the snapshot frame and the first playing frame
 * both call `compute(0)`, so the rendered value is identical across the
 * sweep boundary by construction. There is no separate "sweep value" to
 * drift from `compute(0)`.
 *
 * This file imports nothing about the banner.
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
