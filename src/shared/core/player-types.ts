/**
 * Player entity types and helpers.
 *
 * Extracted from types.ts to break the coupling chain:
 * system-interfaces.ts → types.ts (GameState) → all consumers.
 * Modules that only need Player no longer transitively depend on GameState.
 */

import type { Cannon } from "./battle-types.ts";
import type { Tower, TowerIdx } from "./geometry-types.ts";
import type { TileKey } from "./grid.ts";
import type { BagState, PieceShape } from "./pieces.ts";
import type { ValidPlayerId } from "./player-slot.ts";
import type { UpgradeId } from "./upgrade-defs.ts";

/** Branded ReadonlySet<TileKey> proving that interior was recomputed after the
 *  last wall mutation. Only produced by:
 *  - `recomputeInterior()` in board-occupancy.ts (after wall mutations)
 *  - `emptyFreshInterior()` below (initial player creation)
 *  - `markInteriorFresh()` in player-interior.ts (recheck output / trusted data)
 *  Consumers can read `.has()` / `.size` / iterate freely — the brand carries
 *  through because FreshInterior extends ReadonlySet<TileKey>. */
export type FreshInterior = ReadonlySet<TileKey> & {
  readonly __brand: "FreshInterior";
};

/** Game-owned scalar brand: a value only the game domain can mint, via a
 *  producer. Reads flow freely — comparison and arithmetic collapse a branded
 *  value back to its plain base type — but writing a branded *field* requires
 *  a producer, so no other domain (notably runtime) can poke game-rule state
 *  inline (`player.lives--` no longer type-checks). Mirrors the FreshInterior
 *  pattern, generalized to scalars. Shared vocabulary: GameState-level rule
 *  fields (e.g. `Round` in types.ts) brand off this same helper. */
export type GameOwned<T, Brand extends string> = T & {
  readonly __owned: Brand;
};

/** Lives remaining — game-owned. The field is `readonly` so `=`, `+=`, AND
 *  `--` are all compile errors (branding alone misses `--`); writes go through
 *  `loseLife` / `eliminatePlayer` / `restoreLives` / creation via
 *  `initialLives`. */
export type Lives = GameOwned<number, "Lives">;

/** In-match flag (false = still playing) — game-owned. `readonly`; set via
 *  `eliminatePlayer` / `restoreEliminated` / creation via `notEliminated`. */
export type Eliminated = GameOwned<boolean, "Eliminated">;

/** Accumulated territory score — game-owned. `readonly`; add via `addScore`,
 *  restore via `restoreScore`, creation via `initialScore`. */
export type Score = GameOwned<number, "Score">;

export interface Player {
  id: ValidPlayerId;
  /** The tower this player selected as home castle. */
  homeTower: Tower | null;
  /** All towers currently enclosed by this player's walls.
   *  Dual role: (1) hot-path cache for SFX, scoring, and grunt-spawn
   *  eligibility; (2) snapshot source for `TOWER_ENCLOSED` event diffing
   *  in `updateEnclosedTowers` — the prior list is captured before rebuild,
   *  so towers absent from the snapshot but present after fire a one-shot
   *  enclosure event. Replacing this field with a lazy getter over
   *  `interior` would silently break the diff. */
  enclosedTowers: Tower[];
  /** Wall tiles owned by this player (row,col pairs encoded as row*COLS+col).
   *  ReadonlySet at the type level — mutations must go through board-occupancy
   *  helpers (addPlayerWall, clearPlayerWalls, etc.) which maintain epoch tracking. */
  walls: ReadonlySet<TileKey>;
  /** All tiles fully enclosed by walls (flood-fill). Used for territory scoring,
   *  cannon placement eligibility, and grunt blocking. Encoded as row*COLS+col.
   *  Branded as FreshInterior — only recomputeInterior(), resetCastle(),
   *  and checkpoint deserialization may write to it. */
  interior: FreshInterior;
  /** Cannon positions (top-left tile of 2x2 cannon). */
  cannons: Cannon[];
  /** Lives remaining (starts at 3, lose 1 when failing to enclose any tower). */
  readonly lives: Lives;
  /** Whether the player is eliminated (lives reached 0 and didn't continue). */
  readonly eliminated: Eliminated;
  /** Accumulated territory points (scoring). */
  readonly score: Score;
  /** Default cannon facing (radians, 0 = up) — toward enemies, set at castle creation. */
  defaultFacing: number;
  /** Wall tiles forming the home castle perimeter (from castle construction).
   *  Used for tower revival and rebuild. Distinct from interior — these are wall
   *  tiles, not enclosed grass. Includes clumsy extras; protected from debris sweep. */
  castleWallTiles: ReadonlySet<TileKey>;
  /** Active upgrades for this player (modern mode only). Key = upgrade id, value = stack count. */
  upgrades: Map<UpgradeId, number>;
  /** Wall tiles that have absorbed one hit (reinforced walls upgrade).
   *  Cleared at build phase start. Second hit destroys normally. */
  damagedWalls: Set<TileKey>;
  /** True for one battle after the player's castle is freshly (re)built.
   *  Modifiers still apply to this player's zone, but tile-placing effects
   *  (wildfire, dry lightning, sinkhole) skip the castle tower + wall ring via
   *  getProtectedCastleTiles. Cleared in finalizeBattle. */
  inGracePeriod: boolean;
  /** Build-phase piece bag (deterministic from upcomingRound + rng + smallPieces;
   *  seeded with `state.round + 1` because initPlayerBag runs in prepareNextRound
   *  at battle-done, well before state.round advances in resolveAfterLifeLost).
   *  Not serialized — regenerated on each peer at build-phase start. */
  bag: BagState | undefined;
  /** Current piece drawn from the bag (may be rotated by player input). */
  currentPiece: PieceShape | undefined;
  /** Round-robin index into the combined cannon list (own + captured) of the
   *  last cannon this player fired; `undefined` = no cannon fired yet this
   *  round. The deterministic selector `nextReadyCannon` advances from here.
   *  Lives on GameState (not the controller) so every peer advances it in
   *  lockstep — the engine writes it (`fireNextReadyCannon` for the immediate
   *  path, `applyCannonFired` from the wired `rotationIdx` for the lockstep
   *  path) and reset each battle in `prepareBattleState`. */
  cannonRotationIdx: number | undefined;
}

/** Create a branded empty interior set. Use at Player creation. */
export function emptyFreshInterior(): FreshInterior {
  return new Set<TileKey>() as unknown as FreshInterior;
}

/** Type guard: player exists and is not eliminated — narrows to `Player`, so
 *  it lives here (L4) with the struct it narrows to. Its plain-boolean inverse
 *  `isPlayerEliminated` lives in `player-slot.ts` (L0): that one works on the
 *  minimal `{ eliminated? }` slot shape, so low-layer code (e.g. zone math)
 *  can call it without depending on the full `Player` type. Want the
 *  narrowing → use this; just want a boolean at any layer → use that. */
export function isPlayerAlive(
  player: Player | null | undefined,
): player is Player {
  return !!player && !player.eliminated;
}

/** Find which player currently owns the tower at the given index, or
 *  `undefined` when no seated player has enclosed it. Linear scan over
 *  at most four players × a handful of owned towers — call sites that
 *  need this in a hot loop should cache their own inverse map. */
export function findTowerOwner(
  players: readonly Player[],
  towerIdx: TowerIdx,
): ValidPlayerId | undefined {
  for (const player of players) {
    if (player.enclosedTowers.some((tower) => tower.index === towerIdx)) {
      return player.id;
    }
  }
  return undefined;
}

/** True when a player has selected a castle and can actively participate. */
export function isPlayerSeated(
  player: Player | null | undefined,
): player is Player & { homeTower: Tower } {
  return !!player && !player.eliminated && !!player.homeTower;
}
