/**
 * WebSocket protocol — event-based message types.
 * No runtime code, only type definitions.
 *
 * Architecture:
 * - Checkpoints at phase transitions (full state for reconciliation)
 * - Events during phases (incremental updates)
 * - Local execution on client for build/cannon (zero-latency input)
 */

import type { CannonMode, ResolvedChoice } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Message type constants
// ---------------------------------------------------------------------------

export const MESSAGE = {
  // Client → Server
  CREATE_ROOM: "create_room",
  JOIN_ROOM: "join_room",
  SELECT_SLOT: "select_slot",
  LIFE_LOST_CHOICE: "life_lost_choice",
  PING: "ping",
  // Lobby
  ROOM_CREATED: "room_created",
  ROOM_JOINED: "room_joined",
  ROOM_ERROR: "room_error",
  JOINED: "joined",
  PLAYER_JOINED: "player_joined",
  PLAYER_LEFT: "player_left",
  // Checkpoints
  INIT: "init",
  SELECT_START: "select_start",
  BUILD_START: "build_start",
  CANNON_START: "cannon_start",
  BATTLE_START: "battle_start",
  BUILD_END: "build_end",
  GAME_OVER: "game_over",
  FULL_STATE: "full_state",
  // Build/Cannon events
  OPPONENT_PIECE_PLACED: "opponent_piece_placed",
  OPPONENT_PHANTOM: "opponent_phantom",
  OPPONENT_CANNON_PLACED: "opponent_cannon_placed",
  OPPONENT_CANNON_PHANTOM: "opponent_cannon_phantom",
  OPPONENT_TOWER_SELECTED: "opponent_tower_selected",
  // Animation
  CASTLE_WALLS: "castle_walls",
  // Battle events
  CANNON_FIRED: "cannon_fired",
  WALL_DESTROYED: "wall_destroyed",
  CANNON_DAMAGED: "cannon_damaged",
  GRUNT_KILLED: "grunt_killed",
  HOUSE_DESTROYED: "house_destroyed",
  GRUNT_SPAWNED: "grunt_spawned",
  PIT_CREATED: "pit_created",
  TOWER_KILLED: "tower_killed",
  AIM_UPDATE: "aim_update",
  // Host migration
  HOST_LEFT: "host_left",
} as const;

// Serialized sub-types and checkpoint data — defined in the game layer
// (src/checkpoint-data.ts). Import here for local use in message types.
import type {
  BattleStartData,
  BuildStartData,
  CannonStartData,
  SerializedBonusSquare,
  SerializedBurningPit,
  SerializedGrunt,
  SerializedPlayer,
} from "../src/checkpoint-data.ts";

// ---------------------------------------------------------------------------
// Room settings
// ---------------------------------------------------------------------------

export interface RoomSettings {
  battleLength: number; // 0 (unlimited), 3, 5, 8, or 12
  cannonMaxHp: number; // 3, 6, 9, or 12
  waitTimerSec: number; // lobby wait duration before auto-start (seconds)
  seed?: number; // optional map seed (server generates random if omitted)
  gameMode?: string; // "classic" or "modern" (default "classic")
}

const VALID_BATTLE_LENGTHS = [0, 3, 5, 8, 12];
const VALID_CANNON_HP = [3, 6, 9, 12];
const MAX_WAIT_TIMER_SEC = 120;
const DEFAULT_WAIT_TIMER_SEC = 60;

const VALID_GAME_MODES = ["classic", "modern"];

/** Clamp untrusted client settings to valid ranges. */
export function sanitizeRoomSettings(raw: Partial<RoomSettings>): RoomSettings {
  const bl = Number(raw.battleLength);
  const hp = Number(raw.cannonMaxHp);
  const wait = Number(raw.waitTimerSec);
  const seed = raw.seed != null ? Math.floor(Number(raw.seed)) : undefined;
  const gm = String(raw.gameMode ?? "classic");
  return {
    battleLength: VALID_BATTLE_LENGTHS.includes(bl) ? bl : 0,
    cannonMaxHp: VALID_CANNON_HP.includes(hp) ? hp : 3,
    waitTimerSec:
      Number.isFinite(wait) && wait >= 0
        ? Math.min(wait, MAX_WAIT_TIMER_SEC)
        : DEFAULT_WAIT_TIMER_SEC,
    seed: Number.isFinite(seed) ? seed : undefined,
    gameMode: VALID_GAME_MODES.includes(gm) ? gm : "classic",
  };
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
  | { type: "life_lost_choice"; choice: ResolvedChoice; playerId?: number }
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
    firstRoundCannons: number;
    gameMode: string;
  };
}

/** Sent when a player joins and is assigned a slot. */
export interface JoinedMessage {
  type: "joined";
  playerId: number;
  previousPlayerId?: number;
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
  /** PlayerId of the host, or null if the host hasn't selected a slot yet. */
  hostId: number | null;
  seed: number;
  /** Seconds elapsed since room creation (for lobby timer sync). */
  elapsedSec: number;
}

/** Another player joined the room. */
export interface PlayerJoinedMessage {
  type: "player_joined";
  playerId: number;
  name: string;
  previousPlayerId?: number;
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

// ---------------------------------------------------------------------------
// Protocol messages — add wire-format `type` discriminant to data payloads.
// Data types (CannonStartData, etc.) are defined in src/checkpoint-data.ts.
// ---------------------------------------------------------------------------

/** Start of cannon placement phase. */
export interface CannonStartMessage extends CannonStartData {
  type: "cannon_start";
}

/** Start of battle (after balloon resolution, grunt spawning, wall sweep). */
export interface BattleStartMessage extends BattleStartData {
  type: "battle_start";
}

/** Start of build phase — full reconciliation point. */
export interface BuildStartMessage extends BuildStartData {
  type: "build_start";
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
  winner: string;
  scores: { name: string; score: number; eliminated: boolean }[];
}

// ---------------------------------------------------------------------------
// Host migration
// ---------------------------------------------------------------------------

/** Host disconnected — server tells all clients who the new host is. */
export interface HostLeftMessage {
  type: "host_left";
  /** PlayerId of the promoted player, or null if no human available (watcher fallback). */
  newHostPlayerId: number | null;
  /** PlayerId of the departed host, or null if the host never selected a slot. */
  previousHostPlayerId: number | null;
}

/** Full game state snapshot sent by new host after promotion for watcher reconciliation. */
export interface FullStateMessage {
  type: "full_state";
  /** Monotonic host-migration sequence used to reject stale snapshots. */
  migrationSeq?: number;
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
  gameMode: string;
  activeModifier: string | null;
  lastModifierId: string | null;
  towerPendingRevive: number[];
  capturedCannons: {
    victimId: number;
    capturerId: number;
    cannonIdx: number;
  }[];
  balloonHits: {
    playerId: number;
    cannonIdx: number;
    count: number;
    capturerIds: number[];
  }[];
  cannonballs: {
    cannonIdx: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    targetX: number;
    targetY: number;
    speed: number;
    playerId: number;
    scoringPlayerId?: number;
    incendiary?: boolean;
  }[];
  /** In-flight balloon animations (present only during BALLOON_ANIM mode). */
  balloonFlights?: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    progress: number;
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
  mode: CannonMode;
}

/** An opponent's phantom cannon position (for rendering ghost). */
export interface OpponentCannonPhantomMessage {
  type: "opponent_cannon_phantom";
  playerId: number;
  row: number;
  col: number;
  mode: CannonMode;
  valid: boolean;
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
  incendiary?: true;
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

/** Life-lost choice forwarded from a non-host client to the host. */
export interface LifeLostChoiceForwardedMessage {
  type: "life_lost_choice";
  playerId: number;
  choice: ResolvedChoice;
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
// Battle event unions (used by game engine, sound, haptics)
// ---------------------------------------------------------------------------

/** Impact events — effects from cannonball/grunt interactions. */
export type ImpactEvent =
  | WallDestroyedMessage
  | CannonDamagedMessage
  | HouseDestroyedMessage
  | GruntKilledMessage
  | GruntSpawnedMessage
  | PitCreatedMessage;

/** All events emitted during battle — fire, tower kill, and impact.
 *  Discriminated on `type` (MESSAGE.* string literal). */
export type BattleEvent = CannonFiredMessage | TowerKilledMessage | ImpactEvent;

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
  // Forwarded client messages
  | LifeLostChoiceForwardedMessage
  // Host migration
  | HostLeftMessage
  | FullStateMessage;

/** Any message sent over the wire (client or server). */
export type GameMessage = ClientMessage | ServerMessage;
