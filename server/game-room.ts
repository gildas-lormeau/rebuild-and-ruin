/**
 * Game room — relay with basic anti-cheat.
 *
 * The host client runs ALL game logic. The server forwards messages
 * between connected sockets with validation:
 * - Identity: players can only send messages for their own playerId
 * - Phase gating: actions rejected outside their valid phase
 * - Rate limiting: caps on message frequency per player
 * - Host-only: only the host can send checkpoints and phase transitions
 *
 * Zero game state.
 */

import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "../src/grid.ts";
import { MAX_PLAYERS } from "../src/player-config.ts";
import { CANNON_MODES, LifeLostChoice, Phase } from "../src/types.ts";
import {
  MESSAGE,
  type RoomSettings,
  sanitizeRoomSettings,
} from "./protocol.ts";
import { safeSendRaw } from "./send-utils.ts";

/** Phase values the server tracks. Extends the game Phase enum with server-only
 *  states that have no Phase enum equivalent. Used only for phase gating. */
type ServerPhase = Phase | "LOBBY" | "CASTLE_BUILD";

// ---------------------------------------------------------------------------
// Rate limiting — cosmetic/display messages only
// ---------------------------------------------------------------------------
// Only high-frequency display messages (phantoms, aim updates) are rate-limited.
// Game-state messages (piece_placed, cannon_placed, fired, tower_selected,
// life_lost_choice) are NEVER rate-limited — they are low-frequency, must
// never be silently dropped, and the host sends AI-player actions through a
// single socket so a shared per-type bucket would starve AI messages.
const RATE_LIMIT_PER_SEC = 100;
const RATE_LIMIT_WINDOW_MS = 1000;
/** Exhaustive set of message types subject to rate limiting.
 *  All other types pass through without rate checks. */
const RATE_LIMITED_TYPES: ReadonlySet<string> = new Set([
  MESSAGE.OPPONENT_PHANTOM,
  MESSAGE.OPPONENT_CANNON_PHANTOM,
  MESSAGE.AIM_UPDATE,
]);

// Messages only the host socket can send
const HOST_ONLY: Set<string> = new Set([
  MESSAGE.INIT,
  MESSAGE.SELECT_START,
  MESSAGE.CASTLE_WALLS,
  MESSAGE.CANNON_START,
  MESSAGE.BATTLE_START,
  MESSAGE.BUILD_START,
  MESSAGE.BUILD_END,
  MESSAGE.GAME_OVER,
  MESSAGE.FULL_STATE,
  MESSAGE.WALL_DESTROYED,
  MESSAGE.CANNON_DAMAGED,
  MESSAGE.HOUSE_DESTROYED,
  MESSAGE.GRUNT_KILLED,
  MESSAGE.GRUNT_SPAWNED,
  MESSAGE.PIT_CREATED,
  MESSAGE.TOWER_KILLED,
]);

// ---------------------------------------------------------------------------
// Payload validation — reject obviously malformed values before relaying
// ---------------------------------------------------------------------------

const MAX_PLAYER_ID = MAX_PLAYERS - 1;
const MAX_TOWER_IDX = 30;
const MAX_CANNON_IDX = 30;
const MAX_PIECE_TILES = 50;
const MAX_PIXEL = Math.max(GRID_COLS, GRID_ROWS) * TILE_SIZE + 100;
const VALID_CHOICES: ReadonlySet<string> = new Set([
  LifeLostChoice.CONTINUE,
  LifeLostChoice.ABANDON,
]);

function isInt(val: unknown, min: number, max: number): boolean {
  return (
    typeof val === "number" && Number.isInteger(val) && val >= min && val <= max
  );
}
function isFinite(val: unknown): boolean {
  return typeof val === "number" && Number.isFinite(val);
}
function isFiniteRange(val: unknown, min: number, max: number): boolean {
  return (
    typeof val === "number" && Number.isFinite(val) && val >= min && val <= max
  );
}

/** Max offset in a piece phantom preview (piece-relative coordinates). */
const MAX_PHANTOM_OFFSET = 4;

function hasValidPlayer(msg: Record<string, unknown>): boolean {
  return isInt(msg.playerId, 0, MAX_PLAYER_ID);
}

function hasValidGridPos(msg: Record<string, unknown>): boolean {
  return isInt(msg.row, 0, GRID_ROWS - 1) && isInt(msg.col, 0, GRID_COLS - 1);
}

function hasValidOffsets(
  msg: Record<string, unknown>,
  minOffset: number,
  maxOffset: number,
): boolean {
  return (
    Array.isArray(msg.offsets) &&
    msg.offsets.length >= 1 &&
    msg.offsets.length <= MAX_PIECE_TILES &&
    msg.offsets.every(
      (o: unknown) =>
        Array.isArray(o) &&
        o.length === 2 &&
        isInt(o[0], minOffset, maxOffset) &&
        isInt(o[1], minOffset, maxOffset),
    )
  );
}

function hasValidCannonMode(msg: Record<string, unknown>): boolean {
  return (CANNON_MODES as ReadonlySet<string>).has(msg.mode as string);
}

function validatePayload(msg: Record<string, unknown>): boolean {
  switch (msg.type) {
    case MESSAGE.OPPONENT_TOWER_SELECTED:
      return hasValidPlayer(msg) && isInt(msg.towerIdx, 0, MAX_TOWER_IDX);
    case MESSAGE.OPPONENT_PIECE_PLACED:
      // Offsets can be piece-relative (humans) or absolute grid coords (AI host)
      return (
        hasValidPlayer(msg) &&
        hasValidGridPos(msg) &&
        hasValidOffsets(msg, -(GRID_ROWS - 1), GRID_ROWS - 1)
      );
    case MESSAGE.OPPONENT_CANNON_PLACED:
      return (
        hasValidPlayer(msg) && hasValidGridPos(msg) && hasValidCannonMode(msg)
      );
    case MESSAGE.CANNON_FIRED:
      return (
        hasValidPlayer(msg) &&
        isInt(msg.cannonIdx, 0, MAX_CANNON_IDX) &&
        isFiniteRange(msg.startX, -MAX_PIXEL, MAX_PIXEL) &&
        isFiniteRange(msg.startY, -MAX_PIXEL, MAX_PIXEL) &&
        isFiniteRange(msg.targetX, -MAX_PIXEL, MAX_PIXEL) &&
        isFiniteRange(msg.targetY, -MAX_PIXEL, MAX_PIXEL) &&
        isFiniteRange(msg.speed, 1, 1000)
      );
    case MESSAGE.LIFE_LOST_CHOICE:
      return hasValidPlayer(msg) && VALID_CHOICES.has(msg.choice as string);
    case MESSAGE.AIM_UPDATE:
      return hasValidPlayer(msg) && isFinite(msg.x) && isFinite(msg.y);
    case MESSAGE.OPPONENT_PHANTOM:
      return (
        hasValidPlayer(msg) &&
        hasValidGridPos(msg) &&
        hasValidOffsets(msg, -MAX_PHANTOM_OFFSET, MAX_PHANTOM_OFFSET)
      );
    case MESSAGE.OPPONENT_CANNON_PHANTOM:
      return (
        hasValidPlayer(msg) && hasValidGridPos(msg) && hasValidCannonMode(msg)
      );
    default:
      // Unknown types pass through: host-only messages are already gated by the
      // HOST_ONLY set check in handleMessage(); remaining unknowns are relayed
      // game-state messages with no field-level validation needed. If adding a
      // new message type with user-supplied fields, add a case above.
      return true;
  }
}

// Phase gating: which message types are valid in which phases
const PHASE_GATES: Record<string, Set<ServerPhase>> = {
  [MESSAGE.CANNON_FIRED]: new Set([Phase.BATTLE]),
  [MESSAGE.OPPONENT_PIECE_PLACED]: new Set([Phase.WALL_BUILD]),
  [MESSAGE.OPPONENT_PHANTOM]: new Set([Phase.WALL_BUILD]),
  [MESSAGE.OPPONENT_CANNON_PLACED]: new Set([Phase.CANNON_PLACE]),
  [MESSAGE.OPPONENT_CANNON_PHANTOM]: new Set([Phase.CANNON_PLACE]),
  [MESSAGE.OPPONENT_TOWER_SELECTED]: new Set([Phase.CASTLE_SELECT]),
  [MESSAGE.AIM_UPDATE]: new Set([Phase.BATTLE]),
};

export class GameRoom {
  private players = new Map<WebSocket, number>(); // socket → playerId
  /** All connected sockets (players + observers). Used for broadcast relay. */
  private broadcastRecipients = new Set<WebSocket>();
  /** Current host socket. Can change mid-game due to host migration (see RoomManager.migrateHost). */
  private hostSocket: WebSocket | null = null;

  /** Current phase, tracked from checkpoint messages.
   * Uses Phase enum values for game phases + server-only string literals:
   * - "LOBBY" — before game starts (no Phase enum equivalent)
   * - "CASTLE_BUILD" — castle wall construction animation (UI-only state)
   * See updatePhaseFromMessage() for all transitions. */
  private phase: ServerPhase = "LOBBY";

  /** Rate limit tracking: socket → type → { count, windowStart }. */
  private rateLimits = new Map<
    WebSocket,
    Map<string, { count: number; windowStart: number }>
  >();

  readonly seed: number;
  readonly settings: RoomSettings;

  constructor(settings?: Partial<RoomSettings>, seed?: number) {
    this.seed = seed ?? Math.floor(Math.random() * 1000000);
    this.settings = sanitizeRoomSettings(settings ?? {});
  }

  // ---------------------------------------------------------------------------
  // Player management
  // ---------------------------------------------------------------------------

  addSocket(socket: WebSocket): void {
    this.broadcastRecipients.add(socket);
  }

  /** Remove socket from GameRoom-owned tracking (players, broadcast, rate limits).
   *  Called by RoomManager.handlePlayerLeftMidGame() which owns the higher-level
   *  cleanup (slot assignments, host migration, room deletion scheduling).
   *  Do NOT call directly — use RoomManager.handleSocketDisconnect(). */
  removePlayer(socket: WebSocket): void {
    this.players.delete(socket);
    this.broadcastRecipients.delete(socket);
    this.rateLimits.delete(socket);
  }

  /** Register a player socket with their playerId (determined by slot choice, 0-indexed).
   *  Also adds to broadcastRecipients so players receive relayed messages. */
  registerPlayer(socket: WebSocket, playerId: number): void {
    this.players.set(socket, playerId);
    this.broadcastRecipients.add(socket);
  }

  setHost(socket: WebSocket): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    this.hostSocket = socket;
  }

  /** Should the identity check (playerId === sender's slot) be skipped?
   *  True for the host on non-host-only messages: the host sends actions on
   *  behalf of AI players whose playerId differs from its own slot. */
  private shouldSkipIdentityCheck(
    senderSocket: WebSocket,
    type: string,
  ): boolean {
    return senderSocket === this.hostSocket && !HOST_ONLY.has(type);
  }

  // ---------------------------------------------------------------------------
  // Phase tracking
  // ---------------------------------------------------------------------------

  /** Update tracked phase from a host checkpoint message.
   *  If adding a new phase-changing message type, add its transition here
   *  AND add phase gating to PHASE_GATES below if the new phase restricts messages. */
  private updatePhaseFromMessage(type: string): void {
    if (type === MESSAGE.CANNON_START) this.phase = Phase.CANNON_PLACE;
    else if (type === MESSAGE.BATTLE_START) this.phase = Phase.BATTLE;
    else if (type === MESSAGE.BUILD_START) this.phase = Phase.WALL_BUILD;
    else if (type === MESSAGE.SELECT_START) this.phase = Phase.CASTLE_SELECT;
    else if (type === MESSAGE.CASTLE_WALLS) this.phase = "CASTLE_BUILD";
  }

  // ---------------------------------------------------------------------------
  // Message relay with validation
  // ---------------------------------------------------------------------------

  /** Validate and relay an in-game message.
   *  Validation pipeline (order matters — each stage may early-return):
   *  1. Host-only gate — reject non-host senders for checkpoint/transition messages
   *  2. Identity check — non-host sockets may only send their own playerId
   *  3. Phase gate — reject messages outside their valid phase
   *  4. Payload validation — reject malformed field values
   *  5. Rate limiting — cap high-frequency display messages
   *  6. Relay — forward raw JSON to all other sockets */
  handleMessage(
    senderSocket: WebSocket,
    msg: Record<string, unknown>,
    rawJson: string,
  ): void {
    const type = msg.type as string;
    if (!type) return;

    // --- 1. Host-only messages (phase transitions, checkpoints, etc.) ---
    // Only the host socket may send these. Adding a new host-only message
    // type requires adding it to the HOST_ONLY set above.
    if (HOST_ONLY.has(type)) {
      if (senderSocket !== this.hostSocket) return;
      this.updatePhaseFromMessage(type);
    }

    // --- 2. Identity enforcement (for messages with playerId) ---
    // Host is exempt: it sends actions on behalf of AI players.
    // Non-host sockets may only send messages for their own playerId.
    if (
      "playerId" in msg &&
      !this.shouldSkipIdentityCheck(senderSocket, type)
    ) {
      const senderPid = this.players.get(senderSocket);
      if (senderPid === undefined) return;
      if (msg.playerId !== senderPid) return;
    }

    // --- 3. Phase gating ---
    const validPhases = PHASE_GATES[type];
    if (validPhases && !validPhases.has(this.phase)) return;

    // --- 4. Payload validation ---
    if (!validatePayload(msg)) return;

    // --- 5. Rate limiting (sliding window counter) ---
    if (RATE_LIMITED_TYPES.has(type)) {
      if (!this.rateLimits.has(senderSocket)) {
        this.rateLimits.set(senderSocket, new Map());
      }
      const socketLimits = this.rateLimits.get(senderSocket)!;
      const now = Date.now();
      let bucket = socketLimits.get(type);
      if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
        bucket = { count: 0, windowStart: now };
        socketLimits.set(type, bucket);
      }
      if (bucket.count >= RATE_LIMIT_PER_SEC) return;
      bucket.count++;
    }

    // --- 6. Relay (forward raw string to avoid re-serialization) ---
    for (const socket of this.broadcastRecipients) {
      if (socket === senderSocket) continue;
      safeSendRaw(socket, rawJson);
    }
  }
}
