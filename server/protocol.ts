/**
 * WebSocket protocol — event-based message types.
 * No runtime code, only type definitions.
 *
 * Architecture:
 * - Checkpoints at phase transitions (full state for reconciliation)
 * - Events during phases (incremental updates)
 * - Local execution on client for build/cannon (zero-latency input)
 */

// ---------------------------------------------------------------------------
// Serialized sub-types
// ---------------------------------------------------------------------------

export interface SerializedCannon {
  row: number;
  col: number;
  hp: number;
  super?: boolean;
  balloon?: boolean;
  facing?: number;
}

export interface SerializedGrunt {
  row: number;
  col: number;
}

export interface SerializedPlayer {
  id: number;
  walls: number[];
  interior: number[];
  cannons: SerializedCannon[];
  ownedTowerIndices: number[];
  homeTowerIdx: number | null;
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

export interface SerializedTower {
  row: number;
  col: number;
  zone: number;
  index: number;
}

// ---------------------------------------------------------------------------
// Room settings
// ---------------------------------------------------------------------------

export interface RoomSettings {
  battleLength: number;   // 3, 5, 8, 12, or Infinity
  cannonMaxHp: number;    // 3, 6, 9, or 12
  waitTimerSec: number;   // lobby wait duration before auto-start (30–120)
}

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export type ClientMessage =
  // Lobby (pre-game)
  | { type: "create_room"; settings: RoomSettings }
  | { type: "join_room"; code: string }
  // Lobby (in room)
  | { type: "select_slot"; slotId: number }
  // In-game
  | { type: "life_lost_choice"; choice: "continue" | "abandon"; playerId?: number }
  | { type: "ping" };

// ---------------------------------------------------------------------------
// Server → Client: Connection
// ---------------------------------------------------------------------------

/** Sent once when a client connects. All clients derive map/houses/zones from the seed. */
export interface InitMessage {
  type: "init";
  seed: number;
  playerCount: number;
  settings: {
    battleLength: number;
    cannonMaxHp: number;
    buildTimer: number;
    cannonPlaceTimer: number;
  };
}

/** Sent when a player joins and is assigned a slot. */
export interface JoinedMessage {
  type: "joined";
  playerId: number;
}


// ---------------------------------------------------------------------------
// Server → Client: Lobby
// ---------------------------------------------------------------------------

/** Room was created successfully. */
export interface RoomCreatedMessage {
  type: "room_created";
  code: string;
  settings: RoomSettings;
  seed: number;
}

/** Player successfully joined a room. */
export interface RoomJoinedMessage {
  type: "room_joined";
  code: string;
  players: { playerId: number; name: string }[];
  settings: RoomSettings;
  hostId: number;
  seed: number;
  /** Seconds elapsed since room creation (for lobby timer sync). */
  elapsedSec: number;
}

/** Another player joined the room. */
export interface PlayerJoinedMessage {
  type: "player_joined";
  playerId: number;
  name: string;
}

/** A player left the room. */
export interface PlayerLeftMessage {
  type: "player_left";
  playerId: number;
}

/** Lobby error (room not found, full, etc.). */
export interface RoomErrorMessage {
  type: "room_error";
  message: string;
}

// ---------------------------------------------------------------------------
// Server → Client: Checkpoints (full state for reconciliation)
// ---------------------------------------------------------------------------

/** Start tower selection (first round or reselection after life loss). */
export interface SelectStartMessage {
  type: "select_start";
  timer: number;
}

/** Start of build phase — full reconciliation point. */
export interface BuildStartMessage {
  type: "build_start";
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

/** Start of cannon placement phase. */
export interface CannonStartMessage {
  type: "cannon_start";
  timer: number;
  limits: number[];
  players: SerializedPlayer[];
  grunts: SerializedGrunt[];
  bonusSquares: SerializedBonusSquare[];
  towerAlive: boolean[];
  burningPits: SerializedBurningPit[];
  houses: SerializedHouse[];
}

/** Start of battle (after balloon resolution, grunt spawning, wall sweep). */
export interface BattleStartMessage {
  type: "battle_start";
  players: SerializedPlayer[];
  grunts: SerializedGrunt[];
  capturedCannons: { victimId: number; capturerId: number; cannonIdx: number }[];
  burningPits: SerializedBurningPit[];
  towerAlive: boolean[];
  /** Balloon flight paths (for animation). */
  flights?: { startX: number; startY: number; endX: number; endY: number }[];
}

/** End of build phase — results of wall sweep, territory claim, life check. */
export interface BuildEndMessage {
  type: "build_end";
  needsReselect: number[];
  eliminated: number[];
  scores: number[];
  players: SerializedPlayer[];
}

/** Game over. */
export interface GameOverMessage {
  type: "game_over";
  winner: string | null;
  scores: { name: string; score: number; eliminated: boolean }[];
}

// ---------------------------------------------------------------------------
// Host migration
// ---------------------------------------------------------------------------

/** Host disconnected — server tells all clients who the new host is. */
export interface HostLeftMessage {
  type: "host_left";
  /** PlayerId of the promoted player, or -1 if no human available (AI fallback). */
  newHostPlayerId: number;
  /** PlayerId of the departed host. */
  previousHostPlayerId: number;
}

/** Full game state snapshot sent by new host after promotion for watcher reconciliation. */
export interface FullStateMessage {
  type: "full_state";
  phase: string;
  round: number;
  timer: number;
  battleCountdown: number;
  battleLength: number;
  shotsFired: number;
  rngState: number;
  players: SerializedPlayer[];
  grunts: SerializedGrunt[];
  housesAlive: boolean[];
  bonusSquares: SerializedBonusSquare[];
  towerAlive: boolean[];
  burningPits: SerializedBurningPit[];
  cannonLimits: number[];
  playerZones: number[];
  activePlayer: number;
  towerPendingRevive: number[];
  capturedCannons: { victimId: number; capturerId: number; cannonIdx: number }[];
  balloonHits: { playerId: number; cannonIdx: number; count: number; capturerIds: number[] }[];
  cannonballs: {
    cannonIdx: number;
    startX: number; startY: number;
    x: number; y: number;
    targetX: number; targetY: number;
    speed: number;
    playerId: number;
    scoringPlayerId?: number;
    incendiary?: boolean;
  }[];
}

// ---------------------------------------------------------------------------
// Server → Client: Build/Cannon events (opponent activity)
// ---------------------------------------------------------------------------

/** An opponent (AI) placed a wall piece. */
export interface OpponentPiecePlacedMessage {
  type: "opponent_piece_placed";
  playerId: number;
  row: number;
  col: number;
  offsets: [number, number][];
}

/** An opponent's phantom piece position (for rendering ghost). */
export interface OpponentPhantomMessage {
  type: "opponent_phantom";
  playerId: number;
  row: number;
  col: number;
  offsets: [number, number][];
  valid: boolean;
}

/** An opponent (AI) placed a cannon. */
export interface OpponentCannonPlacedMessage {
  type: "opponent_cannon_placed";
  playerId: number;
  row: number;
  col: number;
  mode: "normal" | "super" | "balloon";
}

/** An opponent's phantom cannon position (for rendering ghost). */
export interface OpponentCannonPhantomMessage {
  type: "opponent_cannon_phantom";
  playerId: number;
  row: number;
  col: number;
  mode: "normal" | "super" | "balloon";
  valid: boolean;
  facing: number;
}

/** An opponent confirmed their tower selection. */
export interface OpponentTowerSelectedMessage {
  type: "opponent_tower_selected";
  playerId: number;
  towerIdx: number;
  confirmed?: boolean;
}

// ---------------------------------------------------------------------------
// Server → Client: Animation events
// ---------------------------------------------------------------------------

/** Ordered wall tiles for castle construction animation (round 1 / reselection). */
export interface CastleWallsMessage {
  type: "castle_walls";
  plans: { playerId: number; tiles: number[] }[];
}

// ---------------------------------------------------------------------------
// Server → Client: Battle events
// ---------------------------------------------------------------------------

/** A cannon was fired (own or opponent). Client creates local cannonball. */
export interface CannonFiredMessage {
  type: "cannon_fired";
  playerId: number;
  cannonIdx: number;
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  speed: number;
  incendiary?: boolean;
}

/** A wall tile was destroyed by impact. */
export interface WallDestroyedMessage {
  type: "wall_destroyed";
  row: number;
  col: number;
  playerId: number;
  shooterId?: number;
}

/** A cannon took damage (destroyed when newHp <= 0). */
export interface CannonDamagedMessage {
  type: "cannon_damaged";
  playerId: number;
  cannonIdx: number;
  newHp: number;
  shooterId?: number;
}

/** A grunt was killed by a cannonball. */
export interface GruntKilledMessage {
  type: "grunt_killed";
  row: number;
  col: number;
  shooterId?: number;
}

/** A house was destroyed by a cannonball. */
export interface HouseDestroyedMessage {
  type: "house_destroyed";
  row: number;
  col: number;
}

/** A grunt was spawned (from house destruction or inter-battle). */
export interface GruntSpawnedMessage {
  type: "grunt_spawned";
  row: number;
  col: number;
  targetPlayerId: number;
}

/** A burning pit was created by an incendiary cannonball. */
export interface PitCreatedMessage {
  type: "pit_created";
  row: number;
  col: number;
  roundsLeft: number;
}

/** A tower was destroyed by a grunt. */
export interface TowerKilledMessage {
  type: "tower_killed";
  towerIdx: number;
}

/** Crosshair position update (for spectator rendering, not validated). */
export interface AimUpdateMessage {
  type: "aim_update";
  playerId: number;
  x: number;
  y: number;
  /** Optional orbit parameters (sent once at countdown start). */
  orbit?: { rx: number; ry: number; speed: number; phase: number };
}

// ---------------------------------------------------------------------------
// Union types
// ---------------------------------------------------------------------------

export type ServerMessage =
  // Connection
  | InitMessage
  | JoinedMessage
  // Lobby
  | RoomCreatedMessage
  | RoomJoinedMessage
  | PlayerJoinedMessage
  | PlayerLeftMessage
  | RoomErrorMessage
  // Checkpoints
  | SelectStartMessage
  | BuildStartMessage
  | CannonStartMessage
  | BattleStartMessage
  | BuildEndMessage
  | GameOverMessage
  // Build/Cannon events
  | OpponentPiecePlacedMessage
  | OpponentPhantomMessage
  | OpponentCannonPlacedMessage
  | OpponentCannonPhantomMessage
  | OpponentTowerSelectedMessage
  // Animation events
  | CastleWallsMessage
  // Battle events
  | CannonFiredMessage
  | WallDestroyedMessage
  | CannonDamagedMessage
  | GruntKilledMessage
  | HouseDestroyedMessage
  | GruntSpawnedMessage
  | PitCreatedMessage
  | TowerKilledMessage
  | AimUpdateMessage
  // Host migration
  | HostLeftMessage
  | FullStateMessage;
