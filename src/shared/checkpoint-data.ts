import type { ModifierId } from "./game-constants.ts";
import type { ValidPlayerSlot } from "./player-slot.ts";

export interface SerializedCannon {
  row: number;
  col: number;
  hp: number;
  mode: string;
  facing?: number;
  mortar?: true;
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
  houses: SerializedHouse[];
  /** Grunts queued to spawn through wall breaches (persists across phases). */
  gruntSpawnQueue?: SerializedBreachSpawnEntry[];
  /** Bonus cannon slots from Salvage upgrade (cannon kills). */
  salvageSlots?: number[];
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
  /** Modifier visual diff for the reveal banner. null = no modifier this round. */
  modifierDiff: {
    id: ModifierId;
    label: string;
    changedTiles: readonly number[];
    gruntsSpawned: number;
  } | null;
  /** Grunts queued to spawn through wall breaches (persists across phases). */
  gruntSpawnQueue?: SerializedBreachSpawnEntry[];
}

/** Serialized breach spawn queue entry. */
export interface SerializedBreachSpawnEntry {
  row: number;
  col: number;
  victimPlayerId: ValidPlayerSlot;
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
  /** Grunts queued to spawn through wall breaches during build phase. */
  gruntSpawnQueue?: SerializedBreachSpawnEntry[];
}
