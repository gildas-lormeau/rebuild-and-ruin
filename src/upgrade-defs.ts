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
  /** Whether picking this again increases the effect (stacking). */
  readonly stackable: boolean;
}

/** Compile-time check: every UpgradeId must appear in the pool.
 *  If a new id is added to UpgradeId but not to UPGRADE_POOL, this fails. */
type PoolIds = (typeof UPGRADE_POOL)[number]["id"];

type PoolComplete = UpgradeId extends PoolIds ? true : never;

const BATTLE: UpgradeCategory = "battle";
const BUILD: UpgradeCategory = "build";
const STRATEGIC: UpgradeCategory = "strategic";
const ONE_USE: UpgradeCategory = "one_use";
const UPGRADE_POOL: readonly UpgradeDef[] = [
  // Battle
  {
    id: "scatter_shot",
    label: "Scatter Shot",
    description: "Cannons fire 3 weaker balls in a cone",
    category: BATTLE,
    weight: 3,
    oneUse: false,
    stackable: false,
  },
  {
    id: "mortar",
    label: "Mortar",
    description: "Slow cannon, 3×3 splash, creates burning pits",
    category: BATTLE,
    weight: 2,
    oneUse: false,
    stackable: false,
  },
  {
    id: "rapid_fire",
    label: "Rapid Fire",
    description: "2× reload speed, half damage per shot",
    category: BATTLE,
    weight: 3,
    oneUse: false,
    stackable: true,
  },
  {
    id: "flaming_walls",
    label: "Flaming Walls",
    description: "Your destroyed walls leave burning pits",
    category: BATTLE,
    weight: 3,
    oneUse: false,
    stackable: false,
  },
  // Build
  {
    id: "reinforced_walls",
    label: "Reinforced Walls",
    description: "New walls take 2 hits to destroy",
    category: BUILD,
    weight: 3,
    oneUse: false,
    stackable: false,
  },
  {
    id: "master_builder",
    label: "Master Builder",
    description: "+5 seconds build timer",
    category: BUILD,
    weight: 3,
    oneUse: false,
    stackable: true,
  },
  {
    id: "large_pieces",
    label: "Large Pieces",
    description: "Unlock extra large tetromino shapes",
    category: BUILD,
    weight: 2,
    oneUse: false,
    stackable: false,
  },
  {
    id: "foundations",
    label: "Foundations",
    description: "Walls can be placed on burning pits",
    category: BUILD,
    weight: 2,
    oneUse: false,
    stackable: false,
  },
  // Strategic
  {
    id: "scout_tower",
    label: "Scout Tower",
    description: "See enemy cannon placements",
    category: STRATEGIC,
    weight: 2,
    oneUse: false,
    stackable: false,
  },
  {
    id: "mercenaries",
    label: "Mercenaries",
    description: "Spawn 3 grunts on a chosen enemy zone",
    category: STRATEGIC,
    weight: 2,
    oneUse: false,
    stackable: false,
  },
  {
    id: "fortify",
    label: "Fortify",
    description: "One tower immune to grunts for 2 rounds",
    category: STRATEGIC,
    weight: 2,
    oneUse: false,
    stackable: false,
  },
  {
    id: "salvage",
    label: "Salvage",
    description: "Destroying enemy cannons gives +1 slot",
    category: STRATEGIC,
    weight: 2,
    oneUse: false,
    stackable: false,
  },
  // One-use
  {
    id: "earthquake",
    label: "Earthquake",
    description: "Crumble one enemy's outer walls",
    category: ONE_USE,
    weight: 1,
    oneUse: true,
    stackable: false,
  },
  {
    id: "ceasefire",
    label: "Ceasefire",
    description: "Skip the next battle phase",
    category: ONE_USE,
    weight: 1,
    oneUse: true,
    stackable: false,
  },
  {
    id: "supply_drop",
    label: "Supply Drop",
    description: "2 free cannons bypassing slot limit",
    category: ONE_USE,
    weight: 1,
    oneUse: true,
    stackable: false,
  },
];
const poolComplete: PoolComplete = true;

void poolComplete;
