/**
 * Upgrade definitions — pure data, no game-type dependencies.
 * L0 (leaf utilities) so every layer can import.
 */

/** Unique identifier for a player upgrade. */

export type UpgradeId =
  | "scatter_shot"
  | "mortar"
  | "rapid_fire"
  | "flaming_walls"
  | "reinforced_walls"
  | "master_builder"
  | "large_pieces"
  | "foundations"
  | "scout_tower"
  | "mercenaries"
  | "fortify"
  | "salvage"
  | "earthquake"
  | "ceasefire"
  | "supply_drop";

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
export const UID = {
  SCATTER_SHOT: "scatter_shot",
  MORTAR: "mortar",
  RAPID_FIRE: "rapid_fire",
  FLAMING_WALLS: "flaming_walls",
  REINFORCED_WALLS: "reinforced_walls",
  MASTER_BUILDER: "master_builder",
  LARGE_PIECES: "large_pieces",
  FOUNDATIONS: "foundations",
  SCOUT_TOWER: "scout_tower",
  MERCENARIES: "mercenaries",
  FORTIFY: "fortify",
  SALVAGE: "salvage",
  EARTHQUAKE: "earthquake",
  CEASEFIRE: "ceasefire",
  SUPPLY_DROP: "supply_drop",
} as const satisfies Record<string, UpgradeId>;
export const UPGRADE_POOL: readonly UpgradeDef[] = [
  // Battle
  {
    id: "scatter_shot",
    label: "Scatter Shot",
    description: "Cannons fire 3 weaker balls in a cone",
    category: BATTLE,
    weight: WEIGHT_COMMON,
    oneUse: false,
    implemented: false,
  },
  {
    id: "mortar",
    label: "Mortar",
    description: "Slow cannon, 3×3 splash, creates burning pits",
    category: BATTLE,
    weight: WEIGHT_UNCOMMON,
    oneUse: false,
    implemented: false,
  },
  {
    id: "rapid_fire",
    label: "Rapid Fire",
    description: "Cannonballs travel 2× faster",
    category: BATTLE,
    weight: WEIGHT_COMMON,
    oneUse: false,
    implemented: true,
  },
  {
    id: "flaming_walls",
    label: "Flaming Walls",
    description: "Your destroyed walls leave burning pits",
    category: BATTLE,
    weight: WEIGHT_COMMON,
    oneUse: false,
    implemented: false,
  },
  // Build
  {
    id: "reinforced_walls",
    label: "Reinforced Walls",
    description: "Walls take 2 hits to destroy (one battle)",
    category: BUILD,
    weight: WEIGHT_COMMON,
    oneUse: true,
    implemented: true,
  },
  {
    id: "master_builder",
    label: "Master Builder",
    description: "+5 seconds build timer",
    category: BUILD,
    weight: WEIGHT_COMMON,
    oneUse: false,
    implemented: true,
  },
  {
    id: "large_pieces",
    label: "Large Pieces",
    description: "Unlock extra large tetromino shapes",
    category: BUILD,
    weight: WEIGHT_UNCOMMON,
    oneUse: false,
    implemented: false,
  },
  {
    id: "foundations",
    label: "Foundations",
    description: "Walls can be placed on burning pits",
    category: BUILD,
    weight: WEIGHT_UNCOMMON,
    oneUse: false,
    implemented: false,
  },
  // Strategic
  {
    id: "scout_tower",
    label: "Scout Tower",
    description: "See enemy cannon placements",
    category: STRATEGIC,
    weight: WEIGHT_UNCOMMON,
    oneUse: false,
    implemented: false,
  },
  {
    id: "mercenaries",
    label: "Mercenaries",
    description: "Spawn 3 grunts on a chosen enemy zone",
    category: STRATEGIC,
    weight: WEIGHT_UNCOMMON,
    oneUse: false,
    implemented: false,
  },
  {
    id: "fortify",
    label: "Fortify",
    description: "One tower immune to grunts for 2 rounds",
    category: STRATEGIC,
    weight: WEIGHT_UNCOMMON,
    oneUse: false,
    implemented: false,
  },
  {
    id: "salvage",
    label: "Salvage",
    description: "Destroying enemy cannons gives +1 slot",
    category: STRATEGIC,
    weight: WEIGHT_UNCOMMON,
    oneUse: false,
    implemented: false,
  },
  // One-use
  {
    id: "earthquake",
    label: "Earthquake",
    description: "Crumble one enemy's outer walls",
    category: ONE_USE,
    weight: WEIGHT_RARE,
    oneUse: true,
    implemented: false,
  },
  {
    id: "ceasefire",
    label: "Ceasefire",
    description: "Skip the next battle phase",
    category: ONE_USE,
    weight: WEIGHT_RARE,
    oneUse: true,
    implemented: false,
  },
  {
    id: "supply_drop",
    label: "Supply Drop",
    description: "2 free cannons bypassing slot limit",
    category: ONE_USE,
    weight: WEIGHT_RARE,
    oneUse: true,
    implemented: false,
  },
];
/** Draft-eligible upgrades — only those with gameplay code. */
export const IMPLEMENTED_UPGRADES: readonly UpgradeDef[] = UPGRADE_POOL.filter(
  (def) => def.implemented,
);

void poolComplete;
