/**
 * Upgrade definitions — pure data, no game-type dependencies.
 * L0 (leaf modules) so every layer can import.
 */

/** Unique identifier for a player upgrade. */

export type UpgradeId =
  | "mortar"
  | "rapid_fire"
  | "reinforced_walls"
  | "master_builder"
  | "small_pieces"
  | "foundations"
  | "salvage"
  | "ceasefire"
  | "supply_drop"
  | "second_wind"
  | "clear_the_field"
  | "ricochet"
  | "shield_battery"
  | "architect"
  | "double_time"
  | "conscription"
  | "territorial_ambition";

type UpgradeCategory = "battle" | "build" | "strategic" | "one_use";

interface UpgradeDef {
  readonly id: UpgradeId;
  readonly label: string;
  readonly description: string;
  readonly category: UpgradeCategory;
  /** Weight for draft pool selection (higher = more likely to appear). */
  readonly weight: number;
  /** Whether this upgrade is consumed after one use. */
  readonly oneUse: boolean;
  /** Whether the effect applies to all players when any single player picks it.
   *  When false, only the player who picked it benefits. */
  readonly global: boolean;
  /** Whether gameplay code exists for this upgrade.
   *  Unimplemented upgrades are kept in the pool type system but excluded
   *  from draft offers so players never pick a no-op upgrade. */
  readonly implemented: boolean;
}

/** Compile-time exhaustiveness check: every UpgradeId must appear in UPGRADE_POOL.
 *  PoolIds extracts all ids from the pool; PoolComplete resolves to `true` only if
 *  UpgradeId ⊆ PoolIds. Adding an UpgradeId without a matching pool entry causes a
 *  type error on `const poolComplete: PoolComplete = true`. The `void poolComplete`
 *  at the end of the file suppresses the unused-variable lint warning. */
type PoolIds = (typeof UPGRADE_POOL)[number]["id"];

type PoolComplete = UpgradeId extends PoolIds ? true : never;

/** Draft pool weights: higher = more likely to appear in offers. */
const WEIGHT_COMMON = 3;
const WEIGHT_UNCOMMON = 2;
const WEIGHT_RARE = 1;
const BATTLE: UpgradeCategory = "battle";
const BUILD: UpgradeCategory = "build";
const STRATEGIC: UpgradeCategory = "strategic";
const ONE_USE: UpgradeCategory = "one_use";
const poolComplete: PoolComplete = true;
/** Named constants for upgrade IDs — use these instead of raw string literals. */
export const UID: { readonly [K in string]: UpgradeId } & Record<
  Uppercase<UpgradeId>,
  UpgradeId
> = {
  MORTAR: "mortar",
  RAPID_FIRE: "rapid_fire",
  REINFORCED_WALLS: "reinforced_walls",
  MASTER_BUILDER: "master_builder",
  SMALL_PIECES: "small_pieces",
  FOUNDATIONS: "foundations",
  SALVAGE: "salvage",
  CEASEFIRE: "ceasefire",
  SUPPLY_DROP: "supply_drop",
  SECOND_WIND: "second_wind",
  CLEAR_THE_FIELD: "clear_the_field",
  RICOCHET: "ricochet",
  SHIELD_BATTERY: "shield_battery",
  ARCHITECT: "architect",
  DOUBLE_TIME: "double_time",
  CONSCRIPTION: "conscription",
  TERRITORIAL_AMBITION: "territorial_ambition",
};
export const UPGRADE_POOL: readonly UpgradeDef[] = [
  // Battle
  {
    id: "mortar",
    label: "Mortar",
    description: "Slow cannon, 3×3 splash, creates burning pits",
    category: BATTLE,
    weight: WEIGHT_UNCOMMON,
    oneUse: false,
    global: false,
    implemented: true,
  },
  {
    id: "rapid_fire",
    label: "Rapid Fire",
    description: "Cannonballs travel 2× faster",
    category: BATTLE,
    weight: WEIGHT_UNCOMMON,
    oneUse: false,
    global: false,
    implemented: true,
  },
  {
    id: "ricochet",
    label: "Ricochet",
    description: "Cannonballs bounce twice after impact",
    category: BATTLE,
    weight: WEIGHT_UNCOMMON,
    oneUse: false,
    global: false,
    implemented: true,
  },
  {
    id: "shield_battery",
    label: "Shield Battery",
    description: "Cannons in home castle region are immune for one battle",
    category: BATTLE,
    weight: WEIGHT_RARE,
    oneUse: true,
    global: false,
    implemented: true,
  },
  // Build
  {
    id: "reinforced_walls",
    label: "Reinforced Walls",
    description: "Walls take 2 hits to destroy (one battle)",
    category: BUILD,
    weight: WEIGHT_COMMON,
    oneUse: true,
    global: false,
    implemented: true,
  },
  {
    id: "master_builder",
    label: "Master Builder",
    description: "+5s exclusive build time",
    category: BUILD,
    weight: WEIGHT_COMMON,
    oneUse: false,
    global: false,
    implemented: true,
  },
  {
    id: "small_pieces",
    label: "Small Pieces",
    description: "Only simple pieces (1×1, 1×2, 1×3, corner)",
    category: BUILD,
    weight: WEIGHT_UNCOMMON,
    oneUse: false,
    global: false,
    implemented: true,
  },
  {
    id: "double_time",
    label: "Double Time",
    description: "+10s build time for all players",
    category: BUILD,
    weight: WEIGHT_COMMON,
    oneUse: false,
    global: true,
    implemented: true,
  },
  {
    id: "architect",
    label: "Architect",
    description: "Pieces can overlap 1 own wall tile",
    category: BUILD,
    weight: WEIGHT_UNCOMMON,
    oneUse: false,
    global: false,
    implemented: true,
  },
  {
    id: "foundations",
    label: "Foundations",
    description: "Walls can be placed on burning pits",
    category: BUILD,
    weight: WEIGHT_UNCOMMON,
    oneUse: false,
    global: false,
    implemented: true,
  },
  // Strategic
  {
    id: "territorial_ambition",
    label: "Territorial Ambition",
    description: "Territory points doubled at end of build",
    category: STRATEGIC,
    weight: WEIGHT_UNCOMMON,
    oneUse: false,
    global: false,
    implemented: true,
  },
  {
    id: "conscription",
    label: "Conscription",
    description: "Killed grunts have 75% chance to respawn on an enemy zone",
    category: STRATEGIC,
    weight: WEIGHT_UNCOMMON,
    oneUse: false,
    global: false,
    implemented: true,
  },
  {
    id: "salvage",
    label: "Salvage",
    description: "Destroying enemy cannons gives +1 slot (max +2)",
    category: STRATEGIC,
    weight: WEIGHT_UNCOMMON,
    oneUse: false,
    global: true,
    implemented: true,
  },
  // One-use
  {
    id: "ceasefire",
    label: "Ceasefire",
    description: "Skip the next battle phase",
    category: ONE_USE,
    weight: WEIGHT_RARE,
    oneUse: true,
    global: true,
    implemented: true,
  },
  {
    id: "supply_drop",
    label: "Supply Drop",
    description: "2 free cannons bypassing slot limit",
    category: ONE_USE,
    weight: WEIGHT_RARE,
    oneUse: true,
    global: false,
    implemented: true,
  },
  {
    id: "second_wind",
    label: "Second Wind",
    description: "Revive all towers for all players",
    category: ONE_USE,
    weight: WEIGHT_RARE,
    oneUse: true,
    global: true,
    implemented: true,
  },
  {
    id: "clear_the_field",
    label: "Clear the Field",
    description: "Remove all grunts from the map",
    category: ONE_USE,
    weight: WEIGHT_RARE,
    oneUse: true,
    global: true,
    implemented: true,
  },
];
/** Draft-eligible upgrades — only those with gameplay code. */
export const IMPLEMENTED_UPGRADES: readonly UpgradeDef[] = UPGRADE_POOL.filter(
  (def) => def.implemented,
);

/** Check if a global upgrade is active (any non-eliminated player has it). */
export function isGlobalUpgradeActive(
  players: readonly {
    readonly eliminated: boolean;
    readonly upgrades: ReadonlyMap<UpgradeId, number>;
  }[],
  id: UpgradeId,
): boolean {
  return players.some(
    (player) => !player.eliminated && player.upgrades.get(id),
  );
}

void poolComplete;
