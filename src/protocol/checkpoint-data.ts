/**
 * Checkpoint data — network wire format for phase synchronization.
 *
 * These types are intentionally loose (strings, number arrays) for JSON
 * compatibility. Key differences from in-memory types:
 *  - `SerializedCannon.mode` is `string` (vs `CannonMode` enum in battle-types.ts)
 *  - `SerializedPlayer.upgrades` is `[string, number][]` (vs `Map<UpgradeId, number>`)
 *  - All tile key arrays (`walls`, `castleWallTiles`, `sinkholeTiles`, etc.) use
 *    packed tile indices: row * GRID_COLS + col (see grid.ts).
 *
 * Deserialization + validation happens in online-serialize.ts (restoreFullStateSnapshot).
 * Checkpoint apply functions (online-checkpoints.ts) trust host-provided data.
 */

import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";

export interface SerializedCannon {
  row: number;
  col: number;
  hp: number;
  mode: string;
  facing?: number;
  mortar?: true;
  shielded?: true;
  /** Shield HP for rampart mode (omitted when 0 or non-rampart). */
  shieldHp?: number;
  /** Cumulative balloon hits toward capture (omitted when 0). */
  balloonHits?: number;
  /** Players who contributed balloon hits this battle (omitted when empty). */
  balloonCapturerIds?: number[];
}

export interface SerializedHouse {
  row: number;
  col: number;
  zone: number;
  alive: boolean;
}

export interface SerializedGrunt {
  row: number;
  col: number;
  victimPlayerId: ValidPlayerSlot;
  targetTowerIdx?: number;
  attackCountdown?: number;
  blockedRounds?: number;
  attackingWall?: boolean;
  facing?: number;
}

export interface SerializedPlayer {
  id: number;
  walls: number[];
  cannons: SerializedCannon[];
  /** Home tower index — immutable after selection. Omitted in checkpoint messages;
   *  present only in full-state (join/reconnect). */
  homeTowerIdx?: number | null;
  /** Castle wall tiles protected from debris sweep (includes clumsy extras).
   *  Immutable after selection. Omitted in checkpoint messages. */
  castleWallTiles?: number[];
  lives: number;
  eliminated: boolean;
  score: number;
  /** Active upgrades: [upgradeId, stackCount][] (modern mode). */
  upgrades?: [string, number][];
  /** Wall tiles that absorbed one hit (reinforced walls). */
  damagedWalls?: number[];
  /** True during the grace-period battle after a reselect auto-build. */
  freshCastle?: boolean;
}

export interface SerializedBurningPit {
  row: number;
  col: number;
  roundsLeft: number;
}

export interface SerializedBonusSquare {
  row: number;
  col: number;
  zone: number;
}

/** Data needed to sync state at cannon phase start. */
export interface CannonStartData {
  timer: number;
  limits: number[];
  players: SerializedPlayer[];
  grunts: SerializedGrunt[];
  bonusSquares: SerializedBonusSquare[];
  towerAlive: boolean[];
  burningPits: SerializedBurningPit[];
  houses: SerializedHouse[];
  /** Bonus cannon slots from Salvage upgrade (cannon kills). */
  salvageSlots?: number[];
  /** High tide tiles (packed keys) — temporarily flooded river banks. null = no high tide. */
  highTideTiles?: number[] | null;
  /** Sinkhole tiles (packed keys) — permanent grass→water mutations. null = none. */
  sinkholeTiles?: number[] | null;
}

/** BATTLE_START wire payload — once-per-round RNG resync point.
 *  Host captures `state.rng.getState()` BEFORE running `enterBattlePhase`
 *  (which consumes RNG via `recheckTerritory` / `rollModifier` /
 *  `applyBattleStartModifiers` / `rollGruntWallAttacks` /
 *  `resolveBalloonCaptures`). Watcher applies the same `setState(rngState)`
 *  and runs `enterBattlePhase` locally — both sides advance RNG
 *  identically and produce byte-identical post-prep state.
 *
 *  No other fields: every battle-start mutation (modifier tiles,
 *  captured cannons, grunt wall-attack flags, balloon flights, combo
 *  tracker, etc.) is derived locally on both sides from synced state +
 *  synced RNG. Defense-in-depth is provided by the rngState round-trip:
 *  if the watcher's local `state.rng` already matches `rngState` before
 *  setState, no drift occurred since the previous `BATTLE_START`. */
export interface BattleStartData {
  rngState: number;
}

/** Data needed to sync state at build phase start. */
export interface BuildStartData {
  round: number;
  timer: number;
  players: SerializedPlayer[];
  houses: SerializedHouse[];
  grunts: SerializedGrunt[];
  bonusSquares: SerializedBonusSquare[];
  towerAlive: boolean[];
  burningPits: SerializedBurningPit[];
  rngSeed: number;
  pendingUpgradeOffers?: [number, [string, string, string]][] | null;
  /** Master Builder lockout seconds remaining (0 = no lockout). */
  masterBuilderLockout?: number;
  /** Player slots who own Master Builder this round. null = nobody. */
  masterBuilderOwners?: number[] | null;
  /** Frozen river tiles persisting from previous battle (packed keys). null = no frozen river. */
  frozenTiles: number[] | null;
  /** High tide tiles (packed keys) — temporarily flooded river banks. null = no high tide. */
  highTideTiles?: number[] | null;
  /** Sinkhole tiles (packed keys) — permanent grass→water mutations. null = none. */
  sinkholeTiles?: number[] | null;
  /** Frostbite chipped grunt tile keys — grunts that have absorbed one hit.
   *  null = no frostbite carrying over from the prior battle. */
  chippedGrunts?: number[] | null;
}

/** Data needed to sync state at build phase end. */
export interface BuildEndData {
  players: readonly SerializedPlayer[];
  scores: readonly number[];
}
