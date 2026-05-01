// ---------------------------------------------------------------------------
// Network protocol — lobby, checkpoints, build/cannon events, host migration.
// Battle event types live in battle-events.ts (game-domain, lower layer).
// ---------------------------------------------------------------------------

import {
  BATTLE_MESSAGE,
  type CannonDamagedMessage,
  type CannonFiredMessage,
  type GruntChippedMessage,
  type GruntKilledMessage,
  type GruntSpawnedMessage,
  type HouseDestroyedMessage,
  type IceThawedMessage,
  type PitCreatedMessage,
  type TowerKilledMessage,
  type WallAbsorbedMessage,
  type WallDestroyedMessage,
  type WallShieldedMessage,
} from "../shared/core/battle-events.ts";
import type { CannonMode } from "../shared/core/battle-types.ts";
import { GAME_MODE_MODERN } from "../shared/core/game-constants.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type { ResolvedChoice } from "../shared/ui/interaction-types.ts";
// Serialized sub-types and checkpoint data — defined in the game layer
// (src/checkpoint-data.ts). Import here for local use in message types.
import type {
  SerializedBonusSquare,
  SerializedBurningPit,
  SerializedGrunt,
  SerializedHouse,
  SerializedPlayer,
} from "./checkpoint-data.ts";

export interface RoomSettings {
  maxRounds: number; // 0 (unlimited), 1 (e2e testing), 3, 5, 8, or 12
  cannonMaxHp: number; // 3, 6, 9, or 12
  waitTimerSec: number; // lobby wait duration before auto-start (seconds)
  seed?: number; // optional map seed (server generates random if omitted)
  gameMode?: string; // "classic" or "modern" (default "modern")
}

export type ClientMessage =
  // Lobby (pre-game)
  | { type: "createRoom"; settings: RoomSettings }
  | { type: "joinRoom"; code: string }
  // Lobby (in room)
  | { type: "selectSlot"; playerId: ValidPlayerSlot }
  // In-game
  | { type: "lifeLostChoice"; choice: ResolvedChoice; playerId?: number }
  | { type: "upgradePick"; playerId: ValidPlayerSlot; choice: string }
  | { type: "ping" };

/** Sent once when a client connects. All clients derive map/houses/zones from the seed. */
export interface InitMessage {
  type: "init";
  seed: number;
  playerCount: number;
  settings: {
    maxRounds: number;
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
  playerId: ValidPlayerSlot;
  /** Slot the player occupied before this selection, or undefined if this is
   *  their first slot pick. Set to undefined in broadcasts when the player
   *  reselected the same slot (avoids UI thrashing on no-op reselections). */
  previousPlayerId?: ValidPlayerSlot;
}

/** Room was created successfully. */
export interface RoomCreatedMessage {
  type: "roomCreated";
  code: string;
  settings: RoomSettings;
  seed: number;
}

/** Player successfully joined a room. */
export interface RoomJoinedMessage {
  type: "roomJoined";
  code: string;
  players: { playerId: ValidPlayerSlot; name: string }[];
  settings: RoomSettings;
  /** PlayerId of the host, or null if the host hasn't selected a slot yet. */
  hostId: number | null;
  seed: number;
  /** Seconds elapsed since room creation (for lobby timer sync). */
  elapsedSec: number;
}

/** Another player joined the room. */
export interface PlayerJoinedMessage {
  type: "playerJoined";
  playerId: ValidPlayerSlot;
  name: string;
  /** Slot the player occupied before this selection, or undefined if this is
   *  their first slot pick. Undefined when reselecting the same slot. */
  previousPlayerId?: ValidPlayerSlot;
}

/** A player left the room. */
export interface PlayerLeftMessage {
  type: "playerLeft";
  playerId: ValidPlayerSlot;
}

/** Lobby error (room not found, full, etc.). */
export interface RoomErrorMessage {
  type: "roomError";
  message: string;
}

/** Start tower selection (first round or reselection after life loss). */
export interface SelectStartMessage {
  type: "selectStart";
  timer: number;
}

/** Start of cannon placement phase — phase-marker signal. Watcher runs the
 *  source-phase prefix + `enterCannonPhase` locally on receipt; no payload.
 *  See `CANNON_ENTRY_WATCHER_STEP` in `runtime-phase-machine.ts`. */
export interface CannonStartMessage {
  type: "cannonStart";
}

/** Start of battle — phase-marker signal. Watcher runs
 *  `enterBattlePhase` locally on receipt; no payload. */
export interface BattleStartMessage {
  type: "battleStart";
}

/** Start of build phase — phase-marker signal. Watcher runs
 *  `finalizeBattle` + `prepareNextRound` locally on receipt; no payload. */
export interface BuildStartMessage {
  type: "buildStart";
}

/** End of build phase — phase-marker signal. Also marks the round-end
 *  barrier under the post-2026-04-29 round-numbering: WALL_BUILD-end is when
 *  state.round++ fires (in `startNextRound`). The wire-message name stays
 *  `buildEnd` because that's still phase-accurate (the WALL_BUILD phase has
 *  ended) and renaming would churn every serializer / handler / online-compat
 *  check; semantically it's also the round-end barrier.
 *
 *  Watcher runs `finalizeRound` (score + life penalties + ROUND_END emit)
 *  followed by `startNextRound` (state.round++ + ROUND_START emit) locally
 *  on receipt; no payload. */
export interface BuildEndMessage {
  type: "buildEnd";
}

/** Game over. */
export interface GameOverMessage {
  type: "gameOver";
  winner: string;
  scores: { name: string; score: number; eliminated: boolean }[];
}

/** Host disconnected — server tells all clients who the new host is. */
export interface HostLeftMessage {
  type: "hostLeft";
  /** PlayerId of the promoted player, or null if no human available (watcher fallback). */
  newHostPlayerId: ValidPlayerSlot | null;
  /** PlayerId of the departed host, or null if the host never selected a slot. */
  disconnectedPlayerId: ValidPlayerSlot | null;
}

/** Full game state snapshot sent by new host after promotion for watcher reconciliation. */
export interface FullStateMessage {
  type: "fullState";
  /** Monotonic host-migration sequence used to reject stale snapshots. */
  migrationSeq?: number;
  phase: string;
  round: number;
  timer: number;
  battleCountdown: number;
  maxRounds: number;
  shotsFired: number;
  rngState: number;
  /** Monotonic logical-tick counter (state.simTick). Carried so a peer
   *  joining mid-game or a post-migration host picks up the
   *  authoritative tick count for the lockstep action-queue. */
  simTick: number;
  players: SerializedPlayer[];
  grunts: SerializedGrunt[];
  houses: SerializedHouse[];
  bonusSquares: SerializedBonusSquare[];
  towerAlive: boolean[];
  burningPits: SerializedBurningPit[];
  cannonLimits: number[];
  /** Per-slot CANNON_PLACE done flags (slot ids of finished controllers).
   *  Drives the phase-exit predicate so a peer joining mid-CANNON_PLACE
   *  sees the same done set as the host. */
  cannonPlaceDone: number[];
  salvageSlots?: number[];
  playerZones: number[];
  gameMode: string;
  activeModifier: string | null;
  /** Tile keys changed by the active modifier. Empty array when no
   *  modifier is active or the modifier touched nothing. */
  activeModifierChangedTiles: number[];
  lastModifierId: string | null;
  pendingUpgradeOffers?: [number, [string, string, string]][] | null;
  /** AI's precomputed upgrade pick per player, drawn from `state.rng` at
   *  battle-done.mutate. Late-joiners and host-migration receivers need
   *  this — they restore the post-precompute `state.rng` state, so they
   *  can't recompute the picks themselves without drifting RNG. */
  precomputedUpgradePicks?: [number, string][] | null;
  masterBuilderLockout?: number;
  masterBuilderOwners?: number[] | null;
  frozenTiles: number[] | null;
  highTideTiles?: number[] | null;
  sinkholeTiles?: number[] | null;
  towerPendingRevive: number[];
  capturedCannons: {
    victimId: ValidPlayerSlot;
    capturerId: number;
    cannonIdx: number;
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
    playerId: ValidPlayerSlot;
    scoringPlayerId?: ValidPlayerSlot;
    incendiary?: boolean;
    launchX: number;
    launchY: number;
    launchAltitude: number;
    impactX: number;
    impactY: number;
    impactRow: number;
    impactCol: number;
    impactAltitude: number;
    vy0: number;
    flightTime: number;
    elapsed: number;
    altitude: number;
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

/** An opponent (AI) placed a wall piece. */
export interface OpponentPiecePlacedMessage {
  type: "opponentPiecePlaced";
  playerId: ValidPlayerSlot;
  row: number;
  col: number;
  offsets: [number, number][];
  /** Lockstep apply tick: `senderSimTick + SAFETY`. Both originator and
   *  receiver enqueue with this stamp; the action schedule fires it at
   *  the matching tick on every peer, so order-sensitive logic
   *  (recheckTerritory → removeEnclosedGruntsAndRespawn) consumes RNG
   *  identically across peers. */
  applyAt: number;
}

/** An opponent's phantom piece position (for rendering ghost). */
export interface OpponentPhantomMessage {
  type: "opponentPhantom";
  playerId: ValidPlayerSlot;
  row: number;
  col: number;
  offsets: [number, number][];
  valid: boolean;
}

/** An opponent (AI) placed a cannon. */
export interface OpponentCannonPlacedMessage {
  type: "opponentCannonPlaced";
  playerId: ValidPlayerSlot;
  row: number;
  col: number;
  mode: CannonMode;
  /** Lockstep apply tick: `senderSimTick + SAFETY`. Both originator and
   *  receiver enqueue with this stamp; the action schedule fires it at
   *  the matching tick on every peer, so cannon-slot occupancy and the
   *  consequent `cannonPlaceDone` checkpointing align. */
  applyAt: number;
}

/** An opponent's phantom cannon position (for rendering ghost). */
export interface OpponentCannonPhantomMessage {
  type: "opponentCannonPhantom";
  playerId: ValidPlayerSlot;
  row: number;
  col: number;
  mode: CannonMode;
  valid: boolean;
}

/** An opponent confirmed their tower selection. */
export interface OpponentTowerSelectedMessage {
  type: "opponentTowerSelected";
  playerId: ValidPlayerSlot;
  towerIdx: number;
  confirmed?: boolean;
  /** Lockstep apply tick: `senderSimTick + SAFETY`. Only set when
   *  `confirmed=true` — highlight-only messages are cosmetic and apply
   *  immediately on receipt. Both originator and receiver enqueue the
   *  `confirmTowerSelection + startPlayerCastleBuild` work for this stamp,
   *  so castle wall generation (which consumes `state.rng` via
   *  `prepareCastleWallsForPlayer`) and `selectionStates.confirmed`
   *  transitions fire at the same logical sim tick on every peer. */
  applyAt?: number;
}

/** A remote-driven slot has finished placing cannons (final placement may be
 *  zero or more `OPPONENT_CANNON_PLACED` messages earlier this phase). The
 *  watcher uses this to know when slot-N has stopped placing so the phase
 *  exit predicate doesn't trigger before the host's final wire messages
 *  arrive. Broadcast only for `kind: "human"` controllers — AI controllers
 *  produce identical placements deterministically on every peer.
 *
 *  Lockstep `applyAt`: both originator and receiver schedule the
 *  `state.cannonPlaceDone.add(playerId)` for the same logical sim tick,
 *  so the phase-exit predicate (`allCannonPlaceDone`) fires at the same
 *  simTick on every peer. Without `applyAt` the originator marks the
 *  slot done at simTick=N while the receiver marks it at simTick=N+
 *  wireDelay, opening a window where one peer exits CANNON_PLACE while
 *  the other is still in it — drifting subsequent RNG draws (modifier
 *  roll, AI upgrade-pick, grunt spawn) by exactly that gap. */
export interface OpponentCannonPhaseDoneMessage {
  type: "opponentCannonPhaseDone";
  playerId: ValidPlayerSlot;
  applyAt: number;
}

/** Life-lost choice forwarded from a non-host client to the host. */
export interface LifeLostChoiceForwardedMessage {
  type: "lifeLostChoice";
  playerId: ValidPlayerSlot;
  choice: ResolvedChoice;
}

/** Upgrade pick choice forwarded from a non-host client to the host. */
export interface UpgradePickForwardedMessage {
  type: "upgradePick";
  playerId: ValidPlayerSlot;
  choice: string;
}

/** Crosshair position update (for spectator rendering, not validated). */
export interface AimUpdateMessage {
  type: "aimUpdate";
  playerId: ValidPlayerSlot;
  x: number;
  y: number;
}

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
  | OpponentCannonPhaseDoneMessage
  // Battle events
  | CannonFiredMessage
  | WallDestroyedMessage
  | CannonDamagedMessage
  | GruntKilledMessage
  | GruntChippedMessage
  | HouseDestroyedMessage
  | GruntSpawnedMessage
  | PitCreatedMessage
  | IceThawedMessage
  | WallAbsorbedMessage
  | WallShieldedMessage
  | TowerKilledMessage
  | AimUpdateMessage
  // Forwarded client messages
  | LifeLostChoiceForwardedMessage
  | UpgradePickForwardedMessage
  // Host migration
  | HostLeftMessage
  | FullStateMessage;

/** Any message sent over the wire (client or server). */
export type GameMessage = ClientMessage | ServerMessage;

/** Union of every protocol message `type` string. Used by server validation
 *  tables (HOST_ONLY, RATE_LIMITED_TYPES, PHASE_GATES in server/game-room.ts)
 *  so a typo or rename of a MESSAGE constant becomes a compile error there. */
export type MessageType = (typeof MESSAGE)[keyof typeof MESSAGE];

const VALID_MAX_ROUNDS = [0, 1, 3, 5, 8, 12];
const VALID_CANNON_HP = [3, 6, 9, 12];
const MAX_WAIT_TIMER_SEC = 120;
const DEFAULT_WAIT_TIMER_SEC = 60;
const VALID_GAME_MODES = ["classic", "modern"];
export const MESSAGE = {
  ...BATTLE_MESSAGE,
  // Client → Server
  CREATE_ROOM: "createRoom",
  JOIN_ROOM: "joinRoom",
  SELECT_SLOT: "selectSlot",
  LIFE_LOST_CHOICE: "lifeLostChoice",
  UPGRADE_PICK: "upgradePick",
  PING: "ping",
  // Lobby
  ROOM_CREATED: "roomCreated",
  ROOM_JOINED: "roomJoined",
  ROOM_ERROR: "roomError",
  JOINED: "joined",
  PLAYER_JOINED: "playerJoined",
  PLAYER_LEFT: "playerLeft",
  // Checkpoints
  INIT: "init",
  SELECT_START: "selectStart",
  BUILD_START: "buildStart",
  CANNON_START: "cannonStart",
  BATTLE_START: "battleStart",
  BUILD_END: "buildEnd",
  GAME_OVER: "gameOver",
  FULL_STATE: "fullState",
  // Build/Cannon events
  OPPONENT_PIECE_PLACED: "opponentPiecePlaced",
  OPPONENT_PHANTOM: "opponentPhantom",
  OPPONENT_CANNON_PLACED: "opponentCannonPlaced",
  OPPONENT_CANNON_PHANTOM: "opponentCannonPhantom",
  OPPONENT_TOWER_SELECTED: "opponentTowerSelected",
  OPPONENT_CANNON_PHASE_DONE: "opponentCannonPhaseDone",
  AIM_UPDATE: "aimUpdate",
  // Host migration
  HOST_LEFT: "hostLeft",
} as const;
export const DEFAULT_CANNON_HP = 3;

/** Clamp untrusted client settings to valid ranges. */
export function sanitizeRoomSettings(raw: Partial<RoomSettings>): RoomSettings {
  const maxRounds = Number(raw.maxRounds);
  const cannonMaxHp = Number(raw.cannonMaxHp);
  const wait = Number(raw.waitTimerSec);
  const seed = raw.seed != null ? Math.floor(Number(raw.seed)) : undefined;
  const gameMode = String(raw.gameMode ?? GAME_MODE_MODERN);
  return {
    maxRounds: VALID_MAX_ROUNDS.includes(maxRounds) ? maxRounds : 0,
    cannonMaxHp: VALID_CANNON_HP.includes(cannonMaxHp)
      ? cannonMaxHp
      : DEFAULT_CANNON_HP,
    waitTimerSec:
      Number.isFinite(wait) && wait >= 0
        ? Math.min(wait, MAX_WAIT_TIMER_SEC)
        : DEFAULT_WAIT_TIMER_SEC,
    seed: Number.isFinite(seed) ? seed : undefined,
    gameMode: VALID_GAME_MODES.includes(gameMode) ? gameMode : GAME_MODE_MODERN,
  };
}
