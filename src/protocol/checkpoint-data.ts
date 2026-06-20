/**
 * Checkpoint data — JSON wire format for phase sync. Types are loose vs
 * in-memory: enums become `string` (e.g. `SerializedCannon.mode`), Maps
 * become `[k, v][]` (e.g. `SerializedPlayer.upgrades`), tile sets become
 * packed `row * GRID_COLS + col` indices (see grid.ts). Deserialization +
 * validation lives in online-serialize.ts; online-rehydrate.ts trusts
 * host-provided data on apply.
 */

import type { TowerIdx } from "../shared/core/geometry-types.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";

interface SerializedCannon {
  row: number;
  col: number;
  hp: number;
  mode: string;
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
  zone: ZoneId;
  alive: boolean;
}

export interface SerializedGrunt {
  row: number;
  col: number;
  targetTowerIdx?: TowerIdx;
  attackCountdown?: number;
  blockedRounds?: number;
  attackingWall?: true;
  /** Action point spent this battle (omitted when unspent). */
  attackDone?: true;
  chipped?: true;
  /** Variant tag — omitted for regular grunts. */
  kind?: "catapult";
  /** Catapult skip-tick toggle — omitted when absent. */
  slowSkip?: true;
}

export interface SerializedPlayer {
  id: number;
  walls: number[];
  cannons: SerializedCannon[];
  /** Home tower index — immutable after selection. Omitted in checkpoint messages;
   *  present only in full-state (join/reconnect). */
  homeTowerIdx?: TowerIdx | null;
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
  /** Round-robin index of the last cannon fired this battle (combined own +
   *  captured list). Carried so a mid-battle join/migration resumes the
   *  selector where it left off — it can't be re-derived. Omitted when
   *  undefined (no fire yet / outside battle); `0` is a valid index. */
  cannonRotationIdx?: number;
}

export interface SerializedBurningPit {
  row: number;
  col: number;
  roundsLeft: number;
}

export interface SerializedBonusSquare {
  row: number;
  col: number;
  zone: ZoneId;
}
