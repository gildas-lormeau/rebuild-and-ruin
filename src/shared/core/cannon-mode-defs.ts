/**
 * Cannon mode registry — pool pattern (CannonMode → CANNON_MODE_POOL +
 * CANNON_MODE_CONSUMERS). See `pool-def.ts` for the shared structure.
 */

import { CannonMode } from "./battle-types.ts";
import type { PoolDef } from "./pool-def.ts";

interface CannonModeDef extends PoolDef<CannonMode> {
  /** Footprint size in tiles (e.g. 2 for 2×2, 3 for 3×3). */
  readonly size: number;
  /** Cannon slots consumed when placing this mode. */
  readonly slotCost: number;
  /** Whether this mode is only available in modern game mode. */
  readonly modernOnly?: true;
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
      "3×3 cannon, fires heavy incendiary cannonballs (2 HP) that create burning pits",
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
const IMPLEMENTED_CANNON_MODES: readonly CannonModeDef[] =
  CANNON_MODE_POOL.filter((def) => def.implemented);
/** Set of all valid CannonMode values — derived from the pool.
 *  Replaces the manually maintained CANNON_MODES set in battle-types.ts. */
export const CANNON_MODE_IDS: ReadonlySet<CannonMode> = new Set(
  CANNON_MODE_POOL.map((def) => def.id),
);
/** Consumer files for each cannon mode, keyed by the role the file plays.
 *  See FEATURE_CONSUMERS in feature-defs.ts for the pattern rationale. */
export const CANNON_MODE_CONSUMERS = {
  [CannonMode.NORMAL]: {
    placement: "src/game/cannon-system.ts",
    firing: "src/game/battle-system.ts",
    render: "src/render/3d/entities/cannons.ts",
    phantom: "src/render/3d/entities/phantoms.ts",
    aiStrategy: "src/ai/ai-strategy-cannon.ts",
    uiCycle: "src/controllers/controller-human.ts",
    serialize: "src/online/online-types.ts",
  },
  [CannonMode.SUPER]: {
    placement: "src/game/cannon-system.ts",
    firing: "src/game/battle-system.ts",
    impact: "src/game/battle-system.ts",
    render: "src/render/3d/entities/cannons.ts",
    phantom: "src/render/3d/entities/phantoms.ts",
    aiStrategy: "src/ai/ai-strategy-cannon.ts",
    uiCycle: "src/controllers/controller-human.ts",
    serialize: "src/online/online-types.ts",
  },
  [CannonMode.BALLOON]: {
    placement: "src/game/cannon-system.ts",
    firing: "src/game/battle-system.ts",
    impact: "src/game/battle-system.ts",
    lifecycle: "src/game/phase-setup.ts",
    render: "src/render/3d/entities/cannons.ts",
    phantom: "src/render/3d/entities/phantoms.ts",
    aiStrategy: "src/ai/ai-strategy-cannon.ts",
    uiCycle: "src/controllers/controller-human.ts",
    serialize: "src/online/online-types.ts",
  },
  [CannonMode.RAMPART]: {
    placement: "src/game/cannon-system.ts",
    firing: "src/game/battle-system.ts",
    render: "src/render/3d/entities/cannons.ts",
    phantom: "src/render/3d/entities/phantoms.ts",
    aiStrategy: "src/ai/ai-strategy-cannon.ts",
    uiCycle: "src/controllers/controller-human.ts",
    serialize: "src/online/online-types.ts",
  },
} as const satisfies Record<CannonMode, Readonly<Record<string, string>>>;

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

/** Parse a string as a CannonMode, defaulting to NORMAL if invalid. */
export function toCannonMode(value: string | undefined): CannonMode {
  if (value && (CANNON_MODE_IDS as ReadonlySet<string>).has(value))
    return value as CannonMode;
  return CannonMode.NORMAL;
}

void poolComplete;
