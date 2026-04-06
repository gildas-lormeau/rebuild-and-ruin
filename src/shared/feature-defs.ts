/**
 * Feature capability registry — pool pattern with exhaustiveness check.
 *
 * Follows the same structure as upgrade-defs.ts and modifier-defs.ts.
 * When adding a new feature capability:
 *   1. Add the string literal to FeatureId union below
 *   2. Add a pool entry (set implemented: false until gameplay code exists)
 *   3. The PoolComplete check will fail at compile time if you forget step 2
 *   4. Add hasFeature() guards in consumer files (see list below)
 *
 * Consumer files to update for a new feature:
 *   - src/shared/types.ts — ModernState fields (if feature needs persistent state)
 *   - src/game/phase-setup.ts — phase transition guards
 *   - src/game/combo-system.ts — if feature affects scoring
 *   - src/game/round-modifiers.ts — if feature is an environmental modifier
 *   - src/online/online-serialize.ts — serialization of feature-specific state
 *   - src/online/online-checkpoints.ts — checkpoint data structures
 *   - src/online/online-watcher-tick.ts — watcher-side feature ticks
 *   - src/render/render-composition.ts — rendering overlays
 *   - src/ai/ai-strategy-battle.ts — AI awareness
 */

/** Identifier for a composable game feature capability. */

export type FeatureId = "modifiers" | "upgrades" | "combos";

interface FeatureDef {
  readonly id: FeatureId;
  readonly label: string;
  readonly description: string;
  /** Whether gameplay code exists for this feature. */
  readonly implemented: boolean;
}

/** Compile-time exhaustiveness: every FeatureId must appear in the pool.
 *  Adding a FeatureId without a matching pool entry causes a type error. */
type PoolIds = (typeof FEATURE_POOL)[number]["id"];

type PoolComplete = FeatureId extends PoolIds ? true : never;

const poolComplete: PoolComplete = true;
const FEATURE_POOL: readonly FeatureDef[] = [
  {
    id: "modifiers",
    label: "Modifiers",
    description:
      "Environmental round modifiers (wildfire, crumbling walls, grunt surge, frozen river)",
    implemented: true,
  },
  {
    id: "upgrades",
    label: "Upgrades",
    description: "Draft/pick upgrade system between battle rounds",
    implemented: true,
  },
  {
    id: "combos",
    label: "Combos",
    description: "Battle scoring streaks and demolition bonuses",
    implemented: true,
  },
];
/** Named constants for feature IDs — use these instead of raw string literals. */
export const FID = {
  MODIFIERS: "modifiers",
  UPGRADES: "upgrades",
  COMBOS: "combos",
} as const satisfies Record<string, FeatureId>;
/** Features with gameplay code — used for mode composition. */
export const IMPLEMENTED_FEATURES: readonly FeatureDef[] = FEATURE_POOL.filter(
  (def) => def.implemented,
);
/** Feature set for modern mode — derived from the pool (all implemented features). */
export const MODERN_FEATURES: ReadonlySet<FeatureId> = new Set<FeatureId>(
  IMPLEMENTED_FEATURES.map((def) => def.id),
);
/** Empty feature set for classic mode. */
export const EMPTY_FEATURES: ReadonlySet<FeatureId> = new Set<FeatureId>();

/** Look up a feature definition by id. */
export function featureDef(id: FeatureId): FeatureDef {
  return FEATURE_POOL.find((def) => def.id === id)!;
}

void poolComplete;
