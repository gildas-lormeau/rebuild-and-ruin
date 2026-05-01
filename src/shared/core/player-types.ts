/**
 * Player entity types and helpers.
 *
 * Extracted from types.ts to break the coupling chain:
 * system-interfaces.ts → types.ts (GameState) → all consumers.
 * Modules that only need Player no longer transitively depend on GameState.
 */

import type { Rng } from "../platform/rng.ts";
import type { Cannon } from "./battle-types.ts";
import { STARTING_LIVES } from "./game-constants.ts";
import type { Castle, Tower } from "./geometry-types.ts";
import {
  type BagState,
  createBag,
  nextPiece,
  type PieceShape,
} from "./pieces.ts";
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
  /** All towers currently enclosed by this player's walls.
   *  Dual role: (1) hot-path cache for SFX, scoring, and grunt-spawn
   *  eligibility; (2) snapshot source for `TOWER_ENCLOSED` event diffing
   *  in `updateOwnedTowers` — the prior list is captured before rebuild,
   *  so towers absent from the snapshot but present after fire a one-shot
   *  enclosure event. Replacing this field with a lazy getter over
   *  `interior` would silently break the diff. */
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
  /** True for one battle after the player's castle is freshly (re)built.
   *  Modifiers still apply to this player's zone, but tile-placing effects
   *  (wildfire, dry lightning, sinkhole) skip the castle tower + wall ring via
   *  getProtectedCastleTiles. Cleared in finalizeBattle. */
  freshCastle: boolean;
  /** Build-phase piece bag (deterministic from upcomingRound + rng + smallPieces;
   *  seeded with `state.round + 1` because initPlayerBag runs in prepareNextRound
   *  at battle-done, well before state.round advances in resolveAfterLifeLost).
   *  Not serialized — regenerated on each peer at build-phase start. */
  bag: BagState | undefined;
  /** Current piece drawn from the bag (may be rotated by player input). */
  currentPiece: PieceShape | undefined;
}

/** Create a new piece bag on a player and draw the first piece. */
export function initPlayerBag(
  player: Player,
  round: number,
  rng?: Rng,
  smallPieces?: boolean,
): void {
  player.bag = createBag(round, rng, smallPieces);
  player.currentPiece = nextPiece(player.bag);
}

/** Advance the piece bag after a successful placement.
 *  @param _placed — must be literal `true` (compile-time guard ensuring
 *  callers advance only after verified placement, never speculatively). */
export function advancePlayerBag(player: Player, _placed: true): void {
  if (!player.bag) {
    console.warn("advancePlayerBag called with null bag — likely a desync");
    return;
  }
  player.currentPiece = nextPiece(player.bag);
}

/** Clear every player's piece bag at end-of-build (round-end transition).
 *  Must run on every peer at the same logical sim tick — bags live on
 *  GameState, so a per-local-controller clear would let late-arriving
 *  piece-place actions drain on one peer (advancing + potentially shuffling
 *  the bag, drawing `state.rng`) while no-op'ing on the other (bag null
 *  → `advancePlayerBag` returns early). That asymmetry drifts `state.rng`
 *  cross-peer; symmetric clear closes the window. */
export function clearAllPlayerBags(state: {
  players: readonly Player[];
}): void {
  for (const player of state.players) clearPlayerBag(player);
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

/** Cannon tier for a player, derived from lives lost. Tier 1 at full lives,
 *  tier 2 after one life lost, tier 3 after two (the post-continue tier for
 *  a player on their last life). Clamped to [1, 3] so test maps or custom
 *  starting-lives values can't produce tier 4+. Used by ball-speed and the
 *  3D cannon sprite selection. */
export function cannonTier(player: { readonly lives: number }): 1 | 2 | 3 {
  const lost = STARTING_LIVES - player.lives;
  if (lost >= 2) return 3;
  if (lost === 1) return 2;
  return 1;
}

/** Set a player's home tower. Called during selection / reselection
 *  phase when a player picks or changes their highlighted tower.
 *
 *  Deliberately does NOT touch `ownedTowers` — that list is derived
 *  state, maintained by `updateOwnedTowers` in build-system.ts via the
 *  territory flood-fill. Seeding it here would create a "ghost"
 *  enclosure at the moment of highlight (before any walls exist), which
 *  misleads consumers that treat `ownedTowers` as "towers actually
 *  enclosed by my territory" — notably the SFX layer, which uses the
 *  list to decide whether a player deserves the fanfare. */
export function selectPlayerTower(player: Player, tower: Tower): void {
  player.homeTower = tower;
}

/** Find which player currently owns the tower at the given index, or
 *  `undefined` when no seated player has enclosed it. Linear scan over
 *  at most four players × a handful of owned towers — call sites that
 *  need this in a hot loop should cache their own inverse map. */
export function findTowerOwner(
  players: readonly Player[],
  towerIdx: number,
): ValidPlayerSlot | undefined {
  for (const player of players) {
    if (player.ownedTowers.some((tower) => tower.index === towerIdx)) {
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

/** Clear the piece bag (end of build phase / life lost / reset).
 *  File-private — callers should use `clearAllPlayerBags` to clear every
 *  player's bag at the same logical sim tick (see its docstring). */
function clearPlayerBag(player: Player): void {
  player.bag = undefined;
  player.currentPiece = undefined;
}
