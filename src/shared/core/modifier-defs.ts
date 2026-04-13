/**
 * Modifier registry — pool pattern with exhaustiveness check.
 *
 * Follows the same structure as upgrade-defs.ts (UpgradeId → UPGRADE_POOL).
 * When adding a new environmental modifier:
 *   1. Add the string literal to ModifierId union in game-constants.ts
 *   2. Add a MODIFIER_ID entry and MODIFIER_LABELS entry in game-constants.ts
 *   3. Add a pool entry here (set implemented: false until gameplay code exists)
 *   4. The PoolComplete check will fail at compile time if you forget step 3
 *   5. Add an entry to MODIFIER_CONSUMERS listing the files that implement
 *      the modifier (the `satisfies` clause enforces exhaustiveness)
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
  /** Tile value the renderer should use for the banner snapshot map at
   *  every position in `ModifierDiff.changedTiles`. Set to the modifier's
   *  pre-mutation tile (e.g. `Tile.Grass` for sinkhole/high_tide which
   *  flood grass into water) so the banner sweep reveals the OLD terrain.
   *  Set to `null` for modifiers that DON'T mutate `state.map.tiles` —
   *  the snapshot map is then skipped entirely (the visual change comes
   *  from a separate overlay layer like `drawFrozenTiles`).
   *
   *  This is the single source of truth for the snapshot revert tile,
   *  consumed by `buildModifierSnapshotMap` via the renderer in
   *  `drawBannerPrevScene`. Adding a new modifier that mutates terrain to
   *  a non-Grass tile (e.g. Grass→Road, Water→Grass) only requires
   *  setting the right value here — no renderer changes. */
  readonly tileMutationPrev: number | null;
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
    // Burn scars don't change the underlying tile (it's still grass, just
    // covered in burning pits drawn as an overlay). No snapshot needed.
    tileMutationPrev: null,
  },
  {
    id: "crumbling_walls",
    label: "Crumbling Walls",
    description: "Destroys 15-20% of outer walls, protects castle walls",
    weight: 3,
    implemented: true,
    needsCheckpoint: false,
    // Walls are entity-layer, not tile-layer. No terrain mutation.
    tileMutationPrev: null,
  },
  {
    id: "grunt_surge",
    label: "Grunt Surge",
    description: "Spawns 6-10 extra grunts distributed across alive towers",
    weight: 2,
    implemented: true,
    needsCheckpoint: false,
    tileMutationPrev: null,
  },
  {
    id: "frozen_river",
    label: "Frozen River",
    description:
      "Water tiles become traversable by grunts, thawed by cannonball impact",
    weight: 2,
    implemented: true,
    needsCheckpoint: true,
    // Tiles stay Water — the freeze is drawn as an overlay by drawFrozenTiles.
    tileMutationPrev: null,
  },
  {
    id: "sinkhole",
    label: "Sinkhole",
    description:
      "Cluster of grass tiles permanently collapses into water, destroying structures",
    weight: 2,
    implemented: true,
    needsCheckpoint: true,
    // Sinkhole tiles flood from grass to water — banner snapshot reverts.
    tileMutationPrev: 0, // Tile.Grass — value import of Tile is restricted
  },
  {
    id: "high_tide",
    label: "High Tide",
    description:
      "River widens 1 tile, flooding banks and destroying structures. Recedes next round",
    weight: 2,
    implemented: true,
    needsCheckpoint: true,
    // Same as sinkhole — flooded river banks were grass before.
    tileMutationPrev: 0, // Tile.Grass — value import of Tile is restricted
  },
  {
    id: "dust_storm",
    label: "Dust Storm",
    description:
      "All cannonballs gain ±15° angle jitter on launch, reducing accuracy",
    weight: 2,
    implemented: true,
    needsCheckpoint: false,
    tileMutationPrev: null,
  },
  {
    id: "rubble_clearing",
    label: "Rubble Clearing",
    description:
      "All dead cannon debris and burning pits are removed from the map",
    weight: 3,
    implemented: true,
    needsCheckpoint: false,
    // Dead cannons + burning pits are entity-layer. No tile mutation.
    tileMutationPrev: null,
  },
  {
    id: "low_water",
    label: "Low Water",
    description:
      "Shallow river-edge tiles become grass for one round, expanding buildable land",
    weight: 2,
    implemented: true,
    needsCheckpoint: true,
    // River bank tiles were water before — banner snapshot reverts to water.
    tileMutationPrev: 1, // Tile.Water — value import of Tile is restricted
  },
  {
    id: "dry_lightning",
    label: "Dry Lightning",
    description:
      "Random grass tiles ignite as burning pits without needing wall destruction",
    weight: 2,
    implemented: true,
    needsCheckpoint: false,
    // Burning pits are entity-layer overlays, not tile mutations.
    tileMutationPrev: null,
  },
];
/** Modifiers with gameplay code — used for random selection. */
export const IMPLEMENTED_MODIFIERS: readonly ModifierDef[] =
  MODIFIER_POOL.filter((def) => def.implemented);
/** Consumer files for each modifier, keyed by the role the file plays.
 *  See FEATURE_CONSUMERS in feature-defs.ts for the pattern rationale. */
export const MODIFIER_CONSUMERS = {
  wildfire: {
    impl: "src/game/modifiers/wildfire.ts",
  },
  crumbling_walls: {
    impl: "src/game/modifiers/crumbling-walls.ts",
  },
  grunt_surge: {
    impl: "src/game/modifiers/grunt-surge.ts",
  },
  frozen_river: {
    impl: "src/game/modifiers/frozen-river.ts",
    serialize: "src/online/online-serialize.ts",
  },
  sinkhole: {
    impl: "src/game/modifiers/sinkhole.ts",
    serialize: "src/online/online-serialize.ts",
  },
  high_tide: {
    impl: "src/game/modifiers/high-tide.ts",
    serialize: "src/online/online-serialize.ts",
  },
  dust_storm: {
    impl: "src/game/modifiers/dust-storm.ts",
    jitter: "src/game/battle-system.ts",
  },
  rubble_clearing: {
    impl: "src/game/modifiers/rubble-clearing.ts",
  },
  low_water: {
    impl: "src/game/modifiers/low-water.ts",
    serialize: "src/online/online-serialize.ts",
  },
  dry_lightning: {
    impl: "src/game/modifiers/dry-lightning.ts",
  },
} as const satisfies Record<ModifierId, Readonly<Record<string, string>>>;

/** Look up a modifier definition by id. */
export function modifierDef(id: ModifierId): ModifierDef {
  return MODIFIER_POOL.find((def) => def.id === id)!;
}

void poolComplete;
