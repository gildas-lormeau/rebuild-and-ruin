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
import type { Tower, TowerIdx } from "./geometry-types.ts";
import type { TileKey } from "./grid.ts";
import {
  type BagState,
  createBag,
  nextPiece,
  type PieceShape,
} from "./pieces.ts";
import type { ValidPlayerId } from "./player-slot.ts";
import type { UpgradeId } from "./upgrade-defs.ts";
import type { ZoneId } from "./zone-id.ts";

/** Branded ReadonlySet<TileKey> proving that interior was recomputed after the
 *  last wall mutation. Only produced by:
 *  - `recomputeInterior()` in board-occupancy.ts (after wall mutations)
 *  - `emptyFreshInterior()` below (initial player creation)
 *  - `brandFreshInterior()` below (checkpoint deserialization of trusted data)
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

/** Writable view of the game-owned Player rule fields. The producers below
 *  cast through it to perform the one blessed write — mirrors `MutableAccums`
 *  for the timer accumulators. Nothing else may mutate these fields. */
type WritableRuleFields = {
  -readonly [K in "lives" | "eliminated" | "score"]: Player[K];
};

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
}

/** Create a new piece bag on a player and draw the first piece. */
export function initPlayerBag(
  player: Player,
  round: number,
  rng: Rng,
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
    throw new Error(
      `advancePlayerBag: player ${player.id} bag is null — late-arriving ` +
        `placement after clearAllPlayerBags. state.rng will drift cross-peer.`,
    );
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
  return new Set<TileKey>() as unknown as FreshInterior;
}

/** Brand an existing set as fresh interior. Use at checkpoint
 *  deserialization where the set is constructed from trusted data. */
export function brandFreshInterior(set: ReadonlySet<TileKey>): FreshInterior {
  return set as FreshInterior;
}

/** Type guard: player exists and is not eliminated.
 *  Use this instead of the `!player || player.eliminated` pattern. */
export function isPlayerAlive(
  player: Player | null | undefined,
): player is Player {
  return !!player && !player.eliminated;
}

/** Decrement a player's lives by one (failed to enclose any tower this round).
 *  The sole in-game producer of a reduced `Lives` value. */
export function loseLife(player: Player): void {
  (player as WritableRuleFields).lives = brandLives(player.lives - 1);
}

/** Mark a player as eliminated (lives = 0, eliminated = true). */
export function eliminatePlayer(player: Player): void {
  const writable = player as WritableRuleFields;
  writable.eliminated = brandEliminated(true);
  writable.lives = brandLives(0);
}

/** Starting lives for a freshly created player. Creation-time producer —
 *  keeps the `STARTING_LIVES` knowledge next to the `Lives` type, mirroring
 *  `emptyFreshInterior()` for the interior brand. */
export function initialLives(): Lives {
  return brandLives(STARTING_LIVES);
}

/** The not-yet-eliminated flag for a freshly created player. Creation-time
 *  producer — mirrors `initialLives()`. */
export function notEliminated(): Eliminated {
  return brandEliminated(false);
}

/** Restore a player's lives from trusted checkpoint data (post-construction
 *  write at the deserialize boundary — the field is `readonly`, so even a
 *  branded value can't be assigned inline). Takes a plain number so
 *  `shared/core` stays free of protocol wire shapes. */
export function restoreLives(player: Player, value: number): void {
  (player as WritableRuleFields).lives = brandLives(value);
}

/** Restore a player's eliminated flag from trusted checkpoint data. */
export function restoreEliminated(player: Player, value: boolean): void {
  (player as WritableRuleFields).eliminated = brandEliminated(value);
}

/** Add territory points to a player's score. The sole in-game producer of an
 *  increased `Score` (every scoring site is additive). */
export function addScore(player: Player, points: number): void {
  (player as WritableRuleFields).score = brandScore(player.score + points);
}

/** Starting score for a freshly created player (0). Creation-time producer —
 *  mirrors `initialLives()`. */
export function initialScore(): Score {
  return brandScore(0);
}

/** Restore a player's score from trusted checkpoint data. */
export function restoreScore(player: Player, value: number): void {
  (player as WritableRuleFields).score = brandScore(value);
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

/** Set a player's home tower. Called during selection phase when a player
 *  picks or changes their highlighted tower.
 *
 *  Deliberately does NOT touch `enclosedTowers` — that list is derived
 *  state, maintained by `updateEnclosedTowers` in build-system.ts via the
 *  territory flood-fill. Seeding it here would create a "ghost"
 *  enclosure at the moment of highlight (before any walls exist), which
 *  misleads consumers that treat `enclosedTowers` as "towers actually
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

/** Return the player slot whose zone matches `zone`, or `undefined` if no
 *  player is assigned to that zone. Encodes the data-model invariant that
 *  zones are exclusive: at most one player per zone (river isolation).
 *  Use this in place of `playerZones.indexOf(zone)`. */
export function playerByZone(
  playerZones: readonly ZoneId[],
  zone: ZoneId,
): number | undefined {
  const pid = playerZones.indexOf(zone);
  return pid >= 0 ? pid : undefined;
}

/** Return the zone owned by player `pid`, or `null` when state is absent or
 *  the slot has no assigned zone. Pure helper consumed by camera and touch-UI
 *  to derive the local human's home zone from a frame snapshot. */
export function zoneByPlayer(
  state: { readonly playerZones: readonly ZoneId[] } | null | undefined,
  pid: number,
): ZoneId | null {
  if (!state) return null;
  return state.playerZones[pid] ?? null;
}

/** Return the distinct zones of all non-eliminated enemies. */
export function enemyZones(
  players: readonly { eliminated: boolean }[],
  playerZones: readonly ZoneId[],
  myPid: number,
): ZoneId[] {
  const zones: ZoneId[] = [];
  for (let i = 0; i < players.length; i++) {
    if (i === myPid || isPlayerEliminated(players[i])) continue;
    const zone = playerZones[i];
    if (zone !== undefined && !zones.includes(zone)) zones.push(zone);
  }
  return zones;
}

/** Return the zone of the highest-scoring non-eliminated enemy, or null. */
export function bestEnemyZone(
  players: readonly { eliminated: boolean; score: number }[],
  playerZones: readonly ZoneId[],
  myPid: number,
): ZoneId | null {
  let bestPid = -1;
  let bestScore = -1;
  for (let i = 0; i < players.length; i++) {
    if (i === myPid || isPlayerEliminated(players[i])) continue;
    if (players[i]!.score > bestScore) {
      bestScore = players[i]!.score;
      bestPid = i;
    }
  }
  if (bestPid < 0) return null;
  return playerZones[bestPid] ?? null;
}

/** Check if a player is eliminated (or absent). Works with Player and structural types.
 *  Returns true for null/undefined — a missing player is effectively eliminated. */
export function isPlayerEliminated(
  player: { readonly eliminated?: boolean } | null | undefined,
): boolean {
  return !player || player.eliminated === true;
}

/** Mint a `Lives` — module-private; all field writes go through the producers
 *  above (the field is `readonly`, so a minted value can't be assigned
 *  except via the blessed `WritableRuleFields` cast). */
function brandLives(value: number): Lives {
  return value as Lives;
}

/** Mint an `Eliminated` — module-private (see `brandLives`). */
function brandEliminated(value: boolean): Eliminated {
  return value as Eliminated;
}

/** Mint a `Score` — module-private (see `brandLives`). */
function brandScore(value: number): Score {
  return value as Score;
}

/** Clear the piece bag (end of build phase / life lost / reset).
 *  File-private — callers should use `clearAllPlayerBags` to clear every
 *  player's bag at the same logical sim tick (see its docstring). */
function clearPlayerBag(player: Player): void {
  player.bag = undefined;
  player.currentPiece = undefined;
}
