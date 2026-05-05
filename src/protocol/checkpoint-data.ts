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
  /** True during the grace-period battle after a fresh castle build
   *  (round 1 auto-build or mid-game reselect). */
  inGracePeriod?: boolean;
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
