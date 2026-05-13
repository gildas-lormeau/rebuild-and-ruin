/**
 * Feature capability registry — pool pattern (FeatureId → FEATURE_POOL +
 * FEATURE_CONSUMERS). See `pool-def.ts` for the shared structure.
 * Consumers must add `hasFeature()` guards; types catch the registry side,
 * not the gameplay side.
 */

import type { PoolDef } from "./pool-def.ts";

export type FeatureId = "modifiers" | "upgrades" | "combos" | "catapults";

type FeatureDef = PoolDef<FeatureId>;

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
      "Environmental round modifiers (wildfire, grunt surge, frozen river)",
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
  {
    id: "catapults",
    label: "Catapults",
    description:
      "Slow tank variant that attacks towers from up to 2 tiles away",
    implemented: false,
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
  CATAPULTS: "catapults",
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
    "gate:rollModifier": "src/game/modifier-system.ts",
    "gate:clearFrozenRiver": "src/game/modifiers/frozen-river.ts",
    "gate:prepareBattleState": "src/game/phase-setup.ts",
    "stateAccess:applyBattleStartModifiers": "src/game/phase-setup.ts",
    "stateAccess:frozenTiles": "src/game/grunt-movement.ts",
    "stateAccess:detectIceThaw": "src/game/battle-system.ts",
    "stateAccess:activeModifier": "src/runtime/runtime-phase-ticks.ts",
    "serialize:fullState": "src/online/online-serialize.ts",
    "render:modifierLabel": "src/render/render-ui-overlays.ts",
    "render:frozenTiles": "src/render/render-ui-overlays.ts",
    "render:bannerPrevScene": "src/render/render-map.ts",
    "ai:frozenAwareness": "src/ai/ai-strategy-battle.ts",
    "ai:modifierThresholds": "src/ai/ai-strategy-battle.ts",
  },
  upgrades: {
    "gate:generateUpgradeOffers": "src/game/phase-setup.ts",
    "gate:masterBuilder": "src/game/upgrades/master-builder.ts",
    "stateAccess:pendingOffers": "src/game/upgrade-system.ts",
    "stateAccess:masterBuilderOwners": "src/online/online-host-promotion.ts",
    "stateAccess:pendingUpgradeOffers":
      "src/online/online-phase-transitions.ts",
    "stateAccess:runtimePending": "src/runtime/runtime-phase-ticks.ts",
    "stateAccess:lockoutOverlay": "src/runtime/runtime-render.ts",
    "serialize:fullState": "src/online/online-serialize.ts",
    "render:lockoutTimer": "src/runtime/runtime-render.ts",
  },
  combos: {
    "gate:prepareBattleState": "src/game/phase-setup.ts",
    "stateAccess:scoreImpactCombo": "src/game/combos.ts",
    "stateAccess:tickComboTracking": "src/game/combos.ts",
    "stateAccess:awardComboBonuses": "src/game/phase-setup.ts",
    "render:comboEvents": "src/render/render-ui-overlays.ts",
  },
  catapults: {
    "data:gruntKind": "src/shared/core/battle-types.ts",
    "serialize:gruntKind": "src/online/online-serialize.ts",
  },
} as const satisfies Record<FeatureId, Readonly<Record<string, string>>>;

void poolComplete;
