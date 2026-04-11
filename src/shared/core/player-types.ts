/**
 * Player entity types and helpers.
 *
 * Extracted from types.ts to break the coupling chain:
 * system-interfaces.ts → types.ts (GameState) → all consumers.
 * Modules that only need Player no longer transitively depend on GameState.
 */

import type { Cannon } from "./battle-types.ts";
import type { Castle, Tower } from "./geometry-types.ts";
import type { ValidPlayerSlot } from "./player-slot.ts";
import type { UpgradeId } from "./upgrade-defs.ts";

/** Branded ReadonlySet<number> proving that interior was recomputed after the
 *  last wall mutation. Only produced by:
 *  - `recomputeInterior()` in board-occupancy.ts (after wall mutations)
 *  - `emptyFreshInterior()` below (initial player creation)
 *  - `brandFreshInterior()` below (checkpoint deserialization of trusted data)
 *  Consumers can read `.has()` / `.size` / iterate freely — the brand carries
 *  through because FreshInterior extends ReadonlySet<number>. */
export type FreshInterior = ReadonlySet<number> & {
  readonly __brand: "FreshInterior";
};

export interface Player {
  id: ValidPlayerSlot;
  /** The tower this player selected as home castle. */
  homeTower: Tower | null;
  /** The castle built around the home tower. */
  castle: Castle | null;
  /** All towers currently enclosed by this player's walls. */
  ownedTowers: Tower[];
  /** Wall tiles owned by this player (row,col pairs encoded as row*COLS+col).
   *  ReadonlySet at the type level — mutations must go through board-occupancy
   *  helpers (addPlayerWall, clearPlayerWalls, etc.) which maintain epoch tracking. */
  walls: ReadonlySet<number>;
  /** All tiles fully enclosed by walls (flood-fill). Used for territory scoring,
   *  cannon placement eligibility, and grunt blocking. Encoded as row*COLS+col.
   *  Branded as FreshInterior — only recomputeInterior(), resetCastle(),
   *  and checkpoint deserialization may write to it. */
  interior: FreshInterior;
  /** Cannon positions (top-left tile of 2x2 cannon). */
  cannons: Cannon[];
  /** Lives remaining (starts at 3, lose 1 when failing to enclose any tower). */
  lives: number;
  /** Whether the player is eliminated (lives reached 0 and didn't continue). */
  eliminated: boolean;
  /** Accumulated territory points (scoring). */
  score: number;
  /** Default cannon facing (radians, 0 = up) — toward enemies, set at castle creation. */
  defaultFacing: number;
  /** Wall tiles forming the home castle perimeter (from castle construction).
   *  Used for tower revival and rebuild. Distinct from interior — these are wall
   *  tiles, not enclosed grass. Includes clumsy extras; protected from debris sweep. */
  castleWallTiles: ReadonlySet<number>;
  /** Active upgrades for this player (modern mode only). Key = upgrade id, value = stack count. */
  upgrades: Map<UpgradeId, number>;
  /** Wall tiles that have absorbed one hit (reinforced walls upgrade).
   *  Cleared at build phase start. Second hit destroys normally. */
  damagedWalls: Set<number>;
}

/** Create a branded empty interior set. Use at Player creation. */
export function emptyFreshInterior(): FreshInterior {
  return new Set<number>() as unknown as FreshInterior;
}

/** Brand an existing set as fresh interior. Use at checkpoint
 *  deserialization where the set is constructed from trusted data. */
export function brandFreshInterior(set: ReadonlySet<number>): FreshInterior {
  return set as FreshInterior;
}

/** Type guard: player exists and is not eliminated.
 *  Use this instead of the `!player || player.eliminated` pattern. */
export function isPlayerAlive(
  player: Player | null | undefined,
): player is Player {
  return !!player && !player.eliminated;
}

/** Check if a player is eliminated (or absent). Works with Player and structural types.
 *  Returns true for null/undefined — a missing player is effectively eliminated. */
export function isPlayerEliminated(
  player: { readonly eliminated?: boolean } | null | undefined,
): boolean {
  return !player || player.eliminated === true;
}

/** Mark a player as eliminated (lives = 0, eliminated = true). */
export function eliminatePlayer(player: Player): void {
  player.eliminated = true;
  player.lives = 0;
}

/** Set a player's home tower and initialize their owned towers list.
 *  Called during selection / reselection phase when a player picks or
 *  changes their highlighted tower. */
export function selectPlayerTower(player: Player, tower: Tower): void {
  player.homeTower = tower;
  player.ownedTowers = [tower];
}

/** True when a player has selected a castle and can actively participate. */
export function isPlayerSeated(
  player: Player | null | undefined,
): player is Player & { homeTower: Tower } {
  return !!player && !player.eliminated && !!player.homeTower;
}
