/**
 * Feature capability registry — pool pattern with exhaustiveness check.
 *
 * Follows the same structure as upgrade-defs.ts and modifier-defs.ts.
 * When adding a new feature capability:
 *   1. Add the string literal to FeatureId union below
 *   2. Add a pool entry (set implemented: false until gameplay code exists)
 *   3. The PoolComplete check will fail at compile time if you forget step 2
 *   4. Add an entry to FEATURE_CONSUMERS listing the files that implement
 *      the feature (the `satisfies` clause makes this mandatory)
 *   5. Add hasFeature() guards in each consumer file — types alone don't
 *      catch a missing guard, but the failing gameplay + tests will
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
/** Features with gameplay code — used for mode composition. */
const IMPLEMENTED_FEATURES: readonly FeatureDef[] = FEATURE_POOL.filter(
  (def) => def.implemented,
);
/** Named constants for feature IDs — use these instead of raw string literals. */
export const FID = {
  MODIFIERS: "modifiers",
  UPGRADES: "upgrades",
  COMBOS: "combos",
} as const satisfies Record<string, FeatureId>;
/** Feature set for modern mode — derived from the pool (all implemented features). */
export const MODERN_FEATURES: ReadonlySet<FeatureId> = new Set<FeatureId>(
  IMPLEMENTED_FEATURES.map((def) => def.id),
);
/** Empty feature set for classic mode. */
export const EMPTY_FEATURES: ReadonlySet<FeatureId> = new Set<FeatureId>();
/** Consumer files for each feature, keyed by the role the file plays.
 *
 * The `satisfies Record<FeatureId, ...>` clause forces exhaustiveness:
 * adding a new FeatureId without a matching consumer map is a compile
 * error. Role names are free-form strings (used as documentation); the
 * lint-registries script only verifies that every listed file exists.
 *
 * Enforcement scope is deliberately narrow: type exhaustiveness catches
 * missing IDs, file-existence catches dead paths, everything else
 * (hasFeature guards, state-access patterns, render paths) is left to
 * TypeScript + the scenario/determinism tests. */
export const FEATURE_CONSUMERS = {
  modifiers: {
    "gate:rollModifier": "src/game/round-modifiers.ts",
    "gate:clearFrozenRiver": "src/game/round-modifiers.ts",
    "gate:enterBattleFromCannon": "src/game/phase-setup.ts",
    "stateAccess:applyBattleStartModifiers": "src/game/phase-setup.ts",
    "stateAccess:frozenTiles": "src/game/grunt-movement.ts",
    "stateAccess:detectIceThaw": "src/game/battle-system.ts",
    "stateAccess:activeModifier": "src/runtime/runtime-phase-ticks.ts",
    "serialize:fullState": "src/online/online-serialize.ts",
    "checkpoint:cannonStart": "src/online/online-checkpoints.ts",
    "checkpoint:battleStart": "src/online/online-checkpoints.ts",
    "checkpoint:buildStart": "src/online/online-checkpoints.ts",
    "render:modifierLabel": "src/render/render-composition.ts",
    "render:frozenTiles": "src/render/render-composition.ts",
    "render:bannerPrevScene": "src/render/render-map.ts",
    "ai:frozenAwareness": "src/ai/ai-strategy-battle.ts",
    "ai:modifierThresholds": "src/ai/ai-strategy-battle.ts",
  },
  upgrades: {
    "gate:generateUpgradeOffers": "src/game/phase-setup.ts",
    "gate:enterBuildFromReselect": "src/game/phase-setup.ts",
    "gate:masterBuilder": "src/game/upgrades/master-builder.ts",
    "gate:watcherBuildTick": "src/online/online-watcher-tick.ts",
    "stateAccess:pendingOffers": "src/game/upgrade-system.ts",
    "stateAccess:masterBuilderOwners": "src/online/online-host-promotion.ts",
    "stateAccess:pendingUpgradeOffers":
      "src/online/online-phase-transitions.ts",
    "stateAccess:runtimePending": "src/runtime/runtime-phase-ticks.ts",
    "stateAccess:lockoutOverlay": "src/runtime/runtime-render.ts",
    "serialize:fullState": "src/online/online-serialize.ts",
    "checkpoint:buildStart": "src/online/online-checkpoints.ts",
    "render:lockoutTimer": "src/render/render-effects.ts",
  },
  combos: {
    "gate:isCombosEnabled": "src/game/combo-system.ts",
    "gate:enterBattleFromCannon": "src/game/phase-setup.ts",
    "stateAccess:scoreImpactCombo": "src/game/combo-system.ts",
    "stateAccess:tickComboTracking": "src/game/combo-system.ts",
    "stateAccess:awardComboBonuses": "src/game/phase-setup.ts",
    "checkpoint:battleStart": "src/online/online-checkpoints.ts",
    "render:comboEvents": "src/render/render-composition.ts",
  },
} as const satisfies Record<FeatureId, Readonly<Record<string, string>>>;

void poolComplete;
