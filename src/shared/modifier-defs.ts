/**
 * Modifier registry — pool pattern with exhaustiveness check.
 *
 * Follows the same structure as upgrade-defs.ts (UpgradeId → UPGRADE_POOL).
 * When adding a new environmental modifier:
 *   1. Add the string literal to ModifierId union in game-constants.ts
 *   2. Add a MODIFIER_ID entry and MODIFIER_LABELS entry in game-constants.ts
 *   3. Add a pool entry here (set implemented: false until gameplay code exists)
 *   4. The PoolComplete check will fail at compile time if you forget step 3
 *
 * Consumer files to update for a new modifier:
 *   - src/game/round-modifiers.ts — apply function (core mutation logic)
 *   - src/game/phase-setup.ts — applyBattleStartModifiers() dispatch
 *   - src/runtime/runtime-transition-steps.ts — banner display
 *   - src/online/online-serialize.ts — serialization of modifier-specific state
 *   - src/online/online-checkpoints.ts — checkpoint data structures
 *   - src/online/online-phase-transitions.ts — watcher-side handling
 *   - src/shared/checkpoint-data.ts — serialized data types
 *   - src/render/render-composition.ts — modifier overlay rendering
 *   - src/ai/ai-strategy-battle.ts — AI awareness (if modifier affects grunts)
 *   - src/shared/types.ts — ModernState fields (if modifier needs persistent state)
 *   - src/shared/system-interfaces.ts — BattleViewState (if modifier affects controllers)
 */

import type { ModifierId } from "./game-constants.ts";

interface ModifierDef {
  readonly id: ModifierId;
  readonly label: string;
  readonly description: string;
  /** Pool weight for random selection (higher = more likely). */
  readonly weight: number;
  /** Whether gameplay code exists for this modifier. */
  readonly implemented: boolean;
  /** Whether this modifier stores tile state that must be serialized in
   *  checkpoints, restored via reapply on join/reconnect, and reverted
   *  on zone reset. When true, ensure matching entries in:
   *  online-checkpoints.ts (restore), online-serialize.ts (serialize),
   *  phase-setup.ts resetZoneState (cleanup). */
  readonly needsCheckpoint: boolean;
}

/** Compile-time exhaustiveness: every ModifierId must appear in the pool.
 *  Adding a ModifierId without a matching pool entry causes a type error. */
type PoolIds = (typeof MODIFIER_POOL)[number]["id"];

type PoolComplete = ModifierId extends PoolIds ? true : never;

const poolComplete: PoolComplete = true;
const MODIFIER_POOL: readonly ModifierDef[] = [
  {
    id: "wildfire",
    label: "Wildfire",
    description:
      "Elongated burn scar (~10 tiles), destroys walls/grunts/houses/bonus squares",
    weight: 3,
    implemented: true,
    needsCheckpoint: false,
  },
  {
    id: "crumbling_walls",
    label: "Crumbling Walls",
    description: "Destroys 15-20% of outer walls, protects castle walls",
    weight: 3,
    implemented: true,
    needsCheckpoint: false,
  },
  {
    id: "grunt_surge",
    label: "Grunt Surge",
    description: "Spawns 6-10 extra grunts distributed across alive towers",
    weight: 2,
    implemented: true,
    needsCheckpoint: false,
  },
  {
    id: "frozen_river",
    label: "Frozen River",
    description:
      "Water tiles become traversable by grunts, thawed by cannonball impact",
    weight: 2,
    implemented: true,
    needsCheckpoint: true,
  },
  {
    id: "sinkhole",
    label: "Sinkhole",
    description:
      "Cluster of grass tiles permanently collapses into water, destroying structures",
    weight: 2,
    implemented: true,
    needsCheckpoint: true,
  },
  {
    id: "high_tide",
    label: "High Tide",
    description:
      "River widens 1 tile, flooding banks and destroying structures. Recedes next round",
    weight: 2,
    implemented: true,
    needsCheckpoint: true,
  },
  {
    id: "dust_storm",
    label: "Dust Storm",
    description:
      "All cannonballs gain ±15° angle jitter on launch, reducing accuracy",
    weight: 2,
    implemented: true,
    needsCheckpoint: false,
  },
];
/** Modifiers with gameplay code — used for random selection. */
export const IMPLEMENTED_MODIFIERS: readonly ModifierDef[] =
  MODIFIER_POOL.filter((def) => def.implemented);

/** Look up a modifier definition by id. */
export function modifierDef(id: ModifierId): ModifierDef {
  return MODIFIER_POOL.find((def) => def.id === id)!;
}

void poolComplete;
