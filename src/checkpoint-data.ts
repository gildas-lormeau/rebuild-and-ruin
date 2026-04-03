/**
 * Game-layer checkpoint data types — protocol-free contracts for state sync.
 *
 * These interfaces define what data the game needs to synchronize at each
 * phase transition.  Protocol messages (WebSocket, NCP, etc.) extend them
 * with a `type` discriminant; checkpoint apply functions accept these types
 * so they never depend on the wire format.
 *
 * Serialized sub-types (SerializedPlayer, etc.) also live here because they
 * describe the shape of game state for sync, not protocol framing.
 */

import type { ValidPlayerSlot } from "./game-constants.ts";

export interface SerializedCannon {
  row: number;
  col: number;
  hp: number;
  mode: string;
  facing?: number;
}

export interface SerializedGrunt {
  row: number;
  col: number;
  victimPlayerId: ValidPlayerSlot;
  targetTowerIdx?: number;
  attackTimer?: number;
  blockedBattles?: number;
  wallAttack?: boolean;
  facing?: number;
}

export interface SerializedPlayer {
  id: number;
  walls: number[];
  cannons: SerializedCannon[];
  homeTowerIdx: number | null;
  /** Castle wall tiles protected from debris sweep (includes clumsy extras). */
  castleWallTiles?: number[];
  lives: number;
  eliminated: boolean;
  score: number;
  /** Active upgrades: [upgradeId, stackCount][] (modern mode). */
  upgrades?: [string, number][];
  /** Wall tiles that absorbed one hit (reinforced walls). */
  damagedWalls?: number[];
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
  housesAlive: boolean[];
}

/** Data needed to sync state at battle start. */
export interface BattleStartData {
  players: SerializedPlayer[];
  grunts: SerializedGrunt[];
  capturedCannons: {
    victimId: ValidPlayerSlot;
    capturerId: ValidPlayerSlot;
    cannonIdx: number;
  }[];
  burningPits: SerializedBurningPit[];
  towerAlive: boolean[];
  /** Balloon flight paths (for animation). null = no balloon shots this round. */
  flights:
    | { startX: number; startY: number; endX: number; endY: number }[]
    | null;
  /** Frozen river tiles (packed keys) for cross-zone grunt movement. null = no frozen river. */
  frozenTiles: number[] | null;
}

/** Data needed to sync state at build phase start. */
export interface BuildStartData {
  round: number;
  timer: number;
  players: SerializedPlayer[];
  housesAlive: boolean[];
  grunts: SerializedGrunt[];
  bonusSquares: SerializedBonusSquare[];
  towerAlive: boolean[];
  burningPits: SerializedBurningPit[];
  rngSeed: number;
  activeModifier?: string | null;
  lastModifierId?: string | null;
  pendingUpgradeOffers?: [number, [string, string, string]][] | null;
  /** Frozen river tiles persisting from previous battle (packed keys). null = no frozen river. */
  frozenTiles: number[] | null;
}
