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
 * Zero game state, zero game imports.
 */

import { MSG, type RoomSettings } from "./protocol.ts";

// Rate limit: max messages per second per type
// Rate limits are generous — AI can act very fast.
// These only block obvious abuse, not normal gameplay.
const RATE_LIMITS: Record<string, number> = {
  [MSG.AIM_UPDATE]: 30,
  [MSG.LIFE_LOST_CHOICE]: 5,
};

// Messages only the host socket can send
const HOST_ONLY: Set<string> = new Set([
  MSG.INIT, MSG.SELECT_START, MSG.CASTLE_WALLS,
  MSG.CANNON_START, MSG.BATTLE_START, MSG.BUILD_START, MSG.BUILD_END,
  MSG.GAME_OVER, MSG.FULL_STATE,
]);

// Phase gating: which message types are valid in which phases
const PHASE_GATES: Record<string, Set<string>> = {
  [MSG.CANNON_FIRED]: new Set(["BATTLE"]),
  [MSG.OPPONENT_PIECE_PLACED]: new Set(["WALL_BUILD"]),
  [MSG.OPPONENT_PHANTOM]: new Set(["WALL_BUILD"]),
  [MSG.OPPONENT_CANNON_PLACED]: new Set(["CANNON_PLACE"]),
  [MSG.OPPONENT_CANNON_PHANTOM]: new Set(["CANNON_PLACE"]),
  [MSG.OPPONENT_TOWER_SELECTED]: new Set(["SELECTION"]),
  [MSG.AIM_UPDATE]: new Set(["BATTLE"]),
};

export class GameRoom {
  private players = new Map<WebSocket, number>();      // socket → playerId
  private spectators = new Set<WebSocket>();
  private hostSocket: WebSocket | null = null;

  /** Current phase, tracked from checkpoint messages. */
  private phase = "LOBBY";

  /** Rate limit tracking: socket → type → { count, windowStart }. */
  private rateLimits = new Map<WebSocket, Map<string, { count: number; windowStart: number }>>();

  readonly seed: number;
  readonly settings: RoomSettings;

  constructor(settings?: Partial<RoomSettings>, seed?: number) {
    this.seed = seed ?? Math.floor(Math.random() * 1000000);
    this.settings = {
      battleLength: settings?.battleLength ?? 0,
      cannonMaxHp: settings?.cannonMaxHp ?? 3,
      waitTimerSec: settings?.waitTimerSec ?? 60,
    };
  }

  // ---------------------------------------------------------------------------
  // Player management
  // ---------------------------------------------------------------------------

  addSpectator(socket: WebSocket): void {
    this.spectators.add(socket);
  }

  removePlayer(socket: WebSocket): void {
    this.players.delete(socket);
    this.spectators.delete(socket);
    this.rateLimits.delete(socket);
  }

  registerPlayer(socket: WebSocket, playerId: number): void {
    this.players.set(socket, playerId);
    this.spectators.add(socket);
  }

  setHost(socket: WebSocket): void {
    this.hostSocket = socket;
  }

  // ---------------------------------------------------------------------------
  // Message relay with validation
  // ---------------------------------------------------------------------------

  // deno-lint-ignore no-explicit-any
  handleMessage(senderSocket: WebSocket, msg: Record<string, any>, rawJson: string): void {
    const type = msg.type as string;
    if (!type) return;

    // --- Host-only messages ---
    if (HOST_ONLY.has(type)) {
      if (senderSocket !== this.hostSocket) {
        console.log(`[room] REJECTED ${type} from non-host`);
        return;
      }
      // Track phase from checkpoint messages
      if (type === MSG.CANNON_START) this.phase = "CANNON_PLACE";
      else if (type === MSG.BATTLE_START) this.phase = "BATTLE";
      else if (type === MSG.BUILD_START) this.phase = "WALL_BUILD";
      else if (type === MSG.SELECT_START) this.phase = "SELECTION";
      else if (type === MSG.CASTLE_WALLS) this.phase = "CASTLE_BUILD";
    }

    // --- Identity enforcement (for messages with playerId) ---
    if ("playerId" in msg && !HOST_ONLY.has(type)) {
      const senderPid = this.players.get(senderSocket);
      if (senderPid !== undefined && msg.playerId !== senderPid) {
        console.log(`[room] REJECTED ${type}: P${senderPid} spoofing P${msg.playerId}`);
        return;
      }
    }

    // --- Phase gating ---
    const validPhases = PHASE_GATES[type];
    if (validPhases && !validPhases.has(this.phase)) {
      console.log(`[room] REJECTED ${type} in phase ${this.phase}`);
      return;
    }

    // --- Rate limiting (sliding window counter) ---
    const maxPerSec = RATE_LIMITS[type];
    if (maxPerSec !== undefined) {
      if (!this.rateLimits.has(senderSocket)) {
        this.rateLimits.set(senderSocket, new Map());
      }
      const socketLimits = this.rateLimits.get(senderSocket)!;
      const now = Date.now();
      let bucket = socketLimits.get(type);
      if (!bucket || now - bucket.windowStart >= 1000) {
        bucket = { count: 0, windowStart: now };
        socketLimits.set(type, bucket);
      }
      if (bucket.count >= maxPerSec) {
        // Silently drop — no log to avoid spam
        return;
      }
      bucket.count++;
    }

    // --- Relay (forward raw string to avoid re-serialization) ---
    for (const socket of this.spectators) {
      if (socket === senderSocket) continue;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(rawJson);
      }
    }
  }
}
