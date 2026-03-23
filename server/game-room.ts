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

import type { RoomSettings } from "./protocol.ts";

// Rate limit: max messages per second per type
// Rate limits are generous — AI can act very fast.
// These only block obvious abuse, not normal gameplay.
const RATE_LIMITS: Record<string, number> = {
  aim_update: 30,
  life_lost_choice: 5,
};

// Messages only the host socket can send
const HOST_ONLY = new Set([
  "init", "select_start", "castle_walls",
  "cannon_start", "battle_start", "build_start", "build_end",
  "game_over", "full_state",
]);

// Phase gating: which message types are valid in which phases
const PHASE_GATES: Record<string, Set<string>> = {
  cannon_fired: new Set(["BATTLE"]),
  opponent_piece_placed: new Set(["WALL_BUILD"]),
  opponent_phantom: new Set(["WALL_BUILD"]),
  opponent_cannon_placed: new Set(["CANNON_PLACE"]),
  opponent_cannon_phantom: new Set(["CANNON_PLACE"]),
  opponent_tower_selected: new Set(["SELECTION"]),
  aim_update: new Set(["BATTLE"]),
};

export class GameRoom {
  private players = new Map<WebSocket, number>();      // socket → playerId
  private spectators = new Set<WebSocket>();
  private hostSocket: WebSocket | null = null;

  /** Current phase, tracked from checkpoint messages. */
  private phase = "LOBBY";

  /** Rate limit tracking: socket → type → timestamps. */
  private rateLimits = new Map<WebSocket, Map<string, number[]>>();

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
  handleMessage(senderSocket: WebSocket, msg: Record<string, any>): void {
    const type = msg.type as string;
    if (!type) return;

    // --- Host-only messages ---
    if (HOST_ONLY.has(type)) {
      if (senderSocket !== this.hostSocket) {
        console.log(`[room] REJECTED ${type} from non-host`);
        return;
      }
      // Track phase from checkpoint messages
      if (type === "cannon_start") this.phase = "CANNON_PLACE";
      else if (type === "battle_start") this.phase = "BATTLE";
      else if (type === "build_start") this.phase = "WALL_BUILD";
      else if (type === "select_start") this.phase = "SELECTION";
      else if (type === "castle_walls") this.phase = "CASTLE_BUILD";
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

    // --- Rate limiting ---
    const maxPerSec = RATE_LIMITS[type];
    if (maxPerSec !== undefined) {
      if (!this.rateLimits.has(senderSocket)) {
        this.rateLimits.set(senderSocket, new Map());
      }
      const socketLimits = this.rateLimits.get(senderSocket)!;
      const now = Date.now();
      const cutoff = now - 1000;
      let timestamps = socketLimits.get(type);
      if (!timestamps) {
        timestamps = [];
        socketLimits.set(type, timestamps);
      }
      // Prune old timestamps
      while (timestamps.length > 0 && timestamps[0]! < cutoff) {
        timestamps.shift();
      }
      if (timestamps.length >= maxPerSec) {
        // Silently drop — no log to avoid spam
        return;
      }
      timestamps.push(now);
    }

    // --- Relay ---
    const json = JSON.stringify(msg);
    for (const socket of this.spectators) {
      if (socket === senderSocket) continue;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(json);
      }
    }
  }
}
