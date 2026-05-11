/**
 * Modifier registry — pool pattern (ModifierId → MODIFIER_POOL +
 * MODIFIER_CONSUMERS). See `pool-def.ts` for the shared structure;
 * `ModifierId` + labels live in `game-constants.ts`.
 */

import type { BurningPit, CannonMode } from "./battle-types.ts";
import type { ModifierId } from "./game-constants.ts";
import type { ValidPlayerSlot } from "./player-slot.ts";
import type { PoolDef } from "./pool-def.ts";

/** Wire payload for tile-mutating modifier state — packed `row * GRID_COLS +
 *  col` keys per active modifier, or null when inactive. Single source of
 *  truth: emitted by `serializeModifierTileSets` (host) and consumed by
 *  modifier `restore` impls (watcher). Lives in shared/ so both protocol/
 *  (wire payload) and game/ (restorers) can import it; adding a new
 *  tile-mutating modifier trips the compiler on both sides at once. */
export interface SerializedModifierTiles {
  frozenTiles: number[] | null;
  highTideTiles: number[] | null;
  sinkholeTiles: number[] | null;
  lowWaterTiles: number[] | null;
}

/** Pre-removal snapshot for the rubble_clearing modifier — the entities
 *  that were on the map at battle-start, captured by `rubbleClearingImpl.apply`
 *  before the live entities were filtered out. The runtime fades them out
 *  post-banner via `overlay.battle.rubbleClearingFade`. Used as both the
 *  in-memory `ModernState.rubbleClearingHeld` shape and the wire payload
 *  (`FullStateMessage.rubbleClearingHeld`) so a host migration during the
 *  reveal window preserves the fade on the new host. */
export interface RubbleClearingHeld {
  readonly pits: readonly BurningPit[];
  readonly deadCannons: readonly {
    readonly ownerId: ValidPlayerSlot;
    readonly col: number;
    readonly row: number;
    readonly mode: CannonMode;
    /** Mortar flag at capture time — drives debris-variant choice
     *  (mortar_debris vs tier_n_debris). */
    readonly mortar?: true;
    /** Owner's cannon tier at capture time — drives the tier_n_debris
     *  variant for non-special cannons. */
    readonly tier: 1 | 2 | 3;
  }[];
}

/** One-round bonus a supply ship can carry. Hidden until the ship is
 *  sunk; the last-hitter's player receives it for the following round
 *  (lifecycle parallels Master Builder / Rapid Fire). */
export type SupplyBonusId =
  | "extra_cannon"
  | "extra_build_time"
  | "mortar_shot"
  | "small_pieces_bias";

/** A neutral supply ship sailing along the Y-river during battle.
 *  Three ships spawn at the river-mouth of each arm and sail toward
 *  the central junction; sinking one awards `bonus` to the last-hitter.
 *  Survivors at battle end are swept away by the battle-end banner. */
export interface SupplyShip {
  readonly id: number;
  /** Which of the three Y-river arms this ship enters from. */
  readonly spawnArm: 0 | 1 | 2;
  /** Sub-tile position (col, row as floats). */
  position: { col: number; row: number };
  /** Facing direction in radians; 0 = +col axis. */
  headingRad: number;
  /** Remaining hit points. Starts at 2; 0 triggers the sink animation. */
  hp: number;
  /** Hidden bonus revealed on sink. */
  readonly bonus: SupplyBonusId;
  /** Sink animation progress (0 → 1). Undefined while alive. */
  sinking?: { progress: number };
}

interface ModifierDef extends PoolDef<ModifierId> {
  /** Pool weight for random selection (higher = more likely). */
  readonly weight: number;
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
   *  `drawBannerSnapshot`. Adding a new modifier that mutates terrain to
   *  a non-Grass tile (e.g. Grass→Road, Water→Grass) only requires
   *  setting the right value here — no renderer changes. */
  readonly tileMutationPrev: number | null;
}

/** Compile-time exhaustiveness: every ModifierId must appear in the pool.
 *  Adding a ModifierId without a matching pool entry causes a type error. */
type PoolIds = (typeof MODIFIER_POOL)[number]["id"];

type PoolComplete = ModifierId extends PoolIds ? true : never;

const poolComplete: PoolComplete = true;
// `as const satisfies` (not a `readonly ModifierDef[]` annotation) so the
// element `id` types stay as their string literals — that's what makes
// `PoolIds` narrow and `PoolComplete` catch missing entries at compile
// time. A plain annotation widens each id to `ModifierId` and PoolComplete
// becomes vacuously `true` — that's how wildfire's pool entry vanished
// silently in commit 4868af14 and only got caught by inspection later.
const MODIFIER_POOL = [
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
  {
    id: "fog_of_war",
    label: "Fog of War",
    description:
      "Thick fog covers every merged castle during battle — players must aim from memory",
    weight: 2,
    implemented: true,
    needsCheckpoint: false,
    // Visual-only overlay drawn over castle walls + interior. No tile mutation.
    tileMutationPrev: null,
  },
  {
    id: "frostbite",
    label: "Frostbite",
    description:
      "Grunts spawn as ice cubes — fully immobile and require two hits to break",
    weight: 2,
    implemented: true,
    // Chip state rides on `grunt.chipped`, which is already serialized as part
    // of each grunt's wire fields — no separate modifier-owned checkpoint.
    needsCheckpoint: false,
    tileMutationPrev: null,
  },
  {
    id: "sapper",
    label: "Sapper",
    description:
      "Grunts attack any adjacent wall on sight — no blocked-rounds requirement, no random roll",
    weight: 2,
    implemented: true,
    needsCheckpoint: false,
    tileMutationPrev: null,
  },
  {
    id: "supply_ship",
    label: "Supply Ship",
    description:
      "Three neutral cargo ships sail the Y-river — sink one for a hidden one-round bonus",
    weight: 2,
    // Gameplay impl + bonus award + wire payload land in follow-up commits;
    // flip to true once the modifier is online-safe end-to-end.
    implemented: false,
    needsCheckpoint: false,
    // Ships are entity-layer; no tile mutation to revert in the banner snapshot.
    tileMutationPrev: null,
  },
] as const satisfies readonly ModifierDef[];
/** Modifiers with gameplay code — used for random selection. */
export const IMPLEMENTED_MODIFIERS: readonly ModifierDef[] =
  MODIFIER_POOL.filter((def) => def.implemented);
/** Consumer files for each modifier, keyed by the role the file plays.
 *  See FEATURE_CONSUMERS in feature-defs.ts for the pattern rationale.
 *
 *  Role conventions (all values are paths from repo root):
 *   - `impl`            modifier's apply/clear/restore lives here
 *   - `serialize`       wire-state read/write for host migration
 *   - `behavior_*`      gameplay code outside the impl file (multiple
 *                       allowed — suffix names the system it lives in)
 *   - `render`          primary 3D effect (overlay or persistent)
 *   - `render_burst`    modifier-reveal-burst factory (per-tile reveal)
 *   - `render_thaw`     extra event-driven render (frozen-river only)
 *   - `reveal`          runtime-side reveal-overlay scalar deriver
 *   - `aiStrategy`      ai-strategy code that branches on this modifier
 *   - `chipFlag`        per-grunt state field (frostbite only) */
export const MODIFIER_CONSUMERS = {
  wildfire: {
    impl: "src/game/modifiers/fire.ts",
    render_burst: "src/render/3d/effects/wildfire-burst.ts",
  },
  grunt_surge: {
    impl: "src/game/modifiers/grunt-surge.ts",
    behavior_spawn: "src/game/grunt-system.ts",
    reveal: "src/runtime/grunt-surge-reveal-overlay.ts",
    aiStrategy: "src/ai/ai-strategy-battle.ts",
  },
  frozen_river: {
    impl: "src/game/modifiers/frozen-river.ts",
    serialize: "src/online/online-serialize.ts",
    behavior_movement: "src/game/grunt-movement.ts",
    behavior_battle: "src/game/battle-system.ts",
    render_burst: "src/render/3d/effects/ice-formation.ts",
    render_thaw: "src/render/3d/effects/thawing.ts",
    aiStrategy: "src/ai/ai-strategy-battle.ts",
  },
  sinkhole: {
    impl: "src/game/modifiers/sinkhole.ts",
    serialize: "src/online/online-serialize.ts",
    render_burst: "src/render/3d/effects/ground-collapse.ts",
  },
  high_tide: {
    impl: "src/game/modifiers/high-tide.ts",
    serialize: "src/online/online-serialize.ts",
    render_burst: "src/render/3d/effects/water-surge.ts",
  },
  dust_storm: {
    impl: "src/game/modifiers/dust-storm.ts",
    behavior_battle: "src/game/battle-system.ts",
    render: "src/render/3d/effects/dust-storm.ts",
    reveal: "src/runtime/dust-storm-reveal-overlay.ts",
  },
  rubble_clearing: {
    impl: "src/game/modifiers/rubble-clearing.ts",
    reveal: "src/runtime/rubble-clearing-overlay.ts",
  },
  low_water: {
    impl: "src/game/modifiers/low-water.ts",
    serialize: "src/online/online-serialize.ts",
    render_burst: "src/render/3d/effects/grass-emergence.ts",
  },
  dry_lightning: {
    impl: "src/game/modifiers/fire.ts",
    render_burst: "src/render/3d/effects/lightning-burst.ts",
  },
  fog_of_war: {
    impl: "src/game/modifiers/fog-of-war.ts",
    render: "src/render/3d/effects/fog.ts",
    reveal: "src/runtime/fog-reveal-overlay.ts",
  },
  frostbite: {
    impl: "src/game/modifiers/frostbite.ts",
    chipFlag: "src/shared/core/battle-types.ts",
    behavior_movement: "src/game/grunt-movement.ts",
    behavior_attack: "src/game/grunt-system.ts",
    behavior_battle: "src/game/battle-system.ts",
    reveal: "src/runtime/frostbite-reveal-overlay.ts",
  },
  sapper: {
    impl: "src/game/modifiers/sapper.ts",
    behavior_attack: "src/game/grunt-system.ts",
    reveal: "src/runtime/sapper-reveal-overlay.ts",
  },
  // AI ignores supply ships by design — no aiStrategy entry. The modifier
  // favors human players (free bonus when AI skips the moving target).
  supply_ship: {
    impl: "src/game/modifiers/supply-ship.ts",
    behavior_battle: "src/game/battle-system.ts",
    render: "src/render/3d/effects/supply-ship.ts",
  },
} as const satisfies Record<ModifierId, Readonly<Record<string, string>>>;

/** Look up a modifier definition by id. */
export function modifierDef(id: ModifierId): ModifierDef {
  return MODIFIER_POOL.find((def) => def.id === id)!;
}

void poolComplete;
