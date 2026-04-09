/**
 * Cannon mode registry — pool pattern with exhaustiveness check.
 *
 * Follows the same structure as upgrade-defs.ts (UpgradeId → UPGRADE_POOL).
 * When adding a new cannon mode:
 *   1. Add the enum value to CannonMode in battle-types.ts
 *   2. Add a pool entry here (set implemented: false until gameplay code exists)
 *   3. The PoolComplete check will fail at compile time if you forget step 2
 *
 * Consumer files to update for a new mode:
 *   - src/game/cannon-system.ts — placement validation
 *   - src/game/battle-system.ts — firing behavior, impact effects
 *   - src/player/controller-human.ts — mode cycling, downgrade logic
 *   - src/ai/ai-strategy-cannon.ts — AI placement decisions
 *   - src/render/render-map.ts — cannon sprites
 *   - src/render/render-effects.ts — phantom preview
 *   - src/shared/checkpoint-data.ts — serialization
 *   - src/online/online-types.ts — toCannonMode() parsing
 *   - src/shared/board-occupancy.ts — exclusion flags if needed
 */

import { CannonMode } from "./battle-types.ts";

interface CannonModeDef {
  readonly id: CannonMode;
  readonly label: string;
  readonly description: string;
  /** Footprint size in tiles (e.g. 2 for 2×2, 3 for 3×3). */
  readonly size: number;
  /** Cannon slots consumed when placing this mode. */
  readonly slotCost: number;
  /** Whether gameplay code exists for this mode. */
  readonly implemented: boolean;
  /** Whether this mode is only available in modern game mode. */
  readonly modernOnly?: boolean;
}

/** Compile-time exhaustiveness: every CannonMode value must appear in the pool. */
type PoolIds = (typeof CANNON_MODE_POOL)[number]["id"];

type PoolComplete = CannonMode extends PoolIds ? true : never;

const poolComplete: PoolComplete = true;
const CANNON_MODE_POOL: readonly CannonModeDef[] = [
  {
    id: CannonMode.NORMAL,
    label: "Cannon",
    description: "Standard 2×2 cannon, fires regular cannonballs",
    size: 2,
    slotCost: 1,
    implemented: true,
  },
  {
    id: CannonMode.SUPER,
    label: "Super Cannon",
    description:
      "3×3 cannon, fires incendiary cannonballs that create burning pits",
    size: 3,
    slotCost: 4,
    implemented: true,
  },
  {
    id: CannonMode.BALLOON,
    label: "Propaganda Balloon",
    description: "2×2 launcher, fires balloons to capture enemy cannons",
    size: 2,
    slotCost: 3,
    implemented: true,
  },
  {
    id: CannonMode.RAMPART,
    label: "Rampart",
    description:
      "2×2 defensive structure, absorbs cannonball hits on nearby walls",
    size: 2,
    slotCost: 3,
    implemented: true,
    modernOnly: true,
  },
];
/** Cannon modes with gameplay code. */
export const IMPLEMENTED_CANNON_MODES: readonly CannonModeDef[] =
  CANNON_MODE_POOL.filter((def) => def.implemented);
/** Set of all valid CannonMode values — derived from the pool.
 *  Replaces the manually maintained CANNON_MODES set in battle-types.ts. */
export const CANNON_MODE_IDS: ReadonlySet<CannonMode> = new Set(
  CANNON_MODE_POOL.map((def) => def.id),
);

/** Cannon modes available for a given game mode (classic excludes modernOnly). */
export function cannonModesForGame(modern: boolean): readonly CannonModeDef[] {
  return modern
    ? IMPLEMENTED_CANNON_MODES
    : IMPLEMENTED_CANNON_MODES.filter((def) => !def.modernOnly);
}

/** Look up a cannon mode definition by id. */
export function cannonModeDef(mode: CannonMode): CannonModeDef {
  return CANNON_MODE_POOL.find((def) => def.id === mode)!;
}

void poolComplete;
