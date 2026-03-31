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

// ---------------------------------------------------------------------------
// Serialized sub-types
// ---------------------------------------------------------------------------

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
  targetPlayerId: number;
  targetTowerIdx?: number;
  attackTimer?: number;
  blockedBattles?: number;
  wallAttack?: boolean;
  facing?: number;
}

export interface SerializedPlayer {
  id: number;
  walls: number[];
  interior: number[];
  cannons: SerializedCannon[];
  ownedTowerIndices: number[];
  homeTowerIdx: number | null;
  /** Castle wall tiles protected from debris sweep (includes clumsy extras). */
  castleWallTiles?: number[];
  lives: number;
  eliminated: boolean;
  score: number;
}

export interface SerializedHouse {
  row: number;
  col: number;
  zone: number;
  alive: boolean;
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
}

/** Data needed to sync state at battle start. */
export interface BattleStartData {
  players: SerializedPlayer[];
  grunts: SerializedGrunt[];
  capturedCannons: {
    victimId: number;
    capturerId: number;
    cannonIdx: number;
  }[];
  burningPits: SerializedBurningPit[];
  towerAlive: boolean[];
  /** Balloon flight paths (for animation). */
  flights?: { startX: number; startY: number; endX: number; endY: number }[];
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
}
