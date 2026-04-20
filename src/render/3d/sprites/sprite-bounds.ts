// sprite-bounds.ts — shared frustum / bounds helpers for *-scene.ts
// `variantReport` implementations.
//
// Every sprite in this design folder renders to the same orthographic
// ±1 frustum in X and Z regardless of canvasPx (the pixel resolution
// only affects the downsample target). Several scene reports previously
// open-coded `> 1 + 1e-4` with inconsistent epsilon and prose. This
// module is the single source of truth.
//
// Scope: pure math + tiny formatting helpers. No THREE, no scene
// geometry. Patterns used by only ONE scene stay inline in that scene;
// only checks that repeat across ≥2 scenes live here.

/** Orthographic frustum half-width in world units. Every sprite
 *  ±1 on both X and Z regardless of canvasPx. */

export const FRUSTUM_HALF = 1;
/** Numerical slack when comparing against FRUSTUM_HALF. Floating-point
 *  rounding in computed extents (radii + offsets) is well under 1e-4. */
export const BOUND_EPS = 1e-4;

/**
 * Predicate: is the scalar `v` inside the ±FRUSTUM_HALF window?
 * Uses BOUND_EPS so a value exactly equal to the bound counts as inside.
 */
export function insideFrustum(v: number): boolean {
  return Math.abs(v) <= FRUSTUM_HALF + BOUND_EPS;
}

/**
 * Reach of a circular feature at (x,z) with radius r, measured as
 * Euclidean distance from the origin to the outer edge. Useful for
 * verifying decorations / flames / puffs stay inside the frustum disc.
 */
export function radialReach(x: number, z: number, radius: number): number {
  return Math.hypot(x, z) + radius;
}

/**
 * Standard "<part> extends past ±<limit> (<value>)" warning phrasing.
 * Used by several scenes that previously hand-formatted the same shape.
 */
export function fmtBound(
  part: string,
  value: number,
  limit: number = FRUSTUM_HALF,
): string {
  return `${part} extends past ±${limit} (${value.toFixed(3)})`;
}
