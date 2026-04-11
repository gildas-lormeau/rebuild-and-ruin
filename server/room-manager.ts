import {
  MESSAGE,
  type RoomSettings,
  type ServerMessage,
} from "../src/protocol/protocol.ts";
import type { ValidPlayerSlot } from "../src/shared/core/player-slot.ts";
import { MAX_PLAYERS, PLAYER_NAMES } from "../src/shared/ui/player-config.ts";
import { GameRoom } from "./game-room.ts";
import { safeSendRaw } from "./send-utils.ts";

const MAX_ROOMS = 50;
/** Grace period before destroying a room after game over — allows clients to see final screen. */
const ROOM_CLEANUP_DELAY_MS = 60_000; // 60s: allow clients to fetch final screen state before cleanup
/** Uppercase letters excluding I and O to avoid confusion with 1 and 0. */
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
/** 4 chars from 24-letter alphabet ≈ 330K combinations — sufficient for concurrent rooms. */
const ROOM_CODE_LENGTH = 4; // 24^4 = 331,776 combinations

interface RoomEntry {
  room: GameRoom;
  code: string;
  hostSocket: WebSocket;
  connectedSockets: Set<WebSocket>;
  /** socket → playerId. A player's slot choice (color/position, 0-indexed)
   *  determines their playerId for the entire session. Only set for sockets
   *  that have picked a slot; spectators are in connectedSockets but not here. */
  slotAssignments: Map<WebSocket, ValidPlayerSlot>;
  /** True once the game has started (wait timer fired or manual start).
   *  No new players can join after this point. */
  started: boolean;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  autoStartTimer: ReturnType<typeof setTimeout> | null;
  createdAt: number;
}

interface SlotSelectionResult {
  playerId: ValidPlayerSlot;
  /** The slot this socket previously occupied, or null if this is their first
   *  slot selection (new player joining). Used by the caller to broadcast
   *  a previousPlayerId so clients can clean up the vacated slot's UI. */
  previousPlayerId: ValidPlayerSlot | null;
}

export class RoomManager {
  private rooms = new Map<string, RoomEntry>();
  private socketToRoom = new Map<WebSocket, RoomEntry>();

  // ---------------------------------------------------------------------------
  // Room lifecycle
  // ---------------------------------------------------------------------------

  /** Create a new room with the given host socket.
   *  Initialization order matters — each step depends on the previous:
   *  1. Detach socket from any existing room
   *  2. Create GameRoom + RoomEntry (entry holds all room state)
   *  3. Register entry in lookup maps (rooms, socketToRoom)
   *  4. Register host socket in GameRoom (addSocket + setHost)
   *  5. Start wait timer (auto-starts game after timeout) */
  createRoom(settings: RoomSettings, hostSocket: WebSocket): string | null {
    this.disconnectSocketFromRoom(hostSocket); // Step 1
    if (this.rooms.size >= MAX_ROOMS) return null;

    // Step 2: Create room + entry (shared maps passed to GameRoom)
    const code = this.generateCode();
    const connectedSockets = new Set([hostSocket]);
    const slotAssignments = new Map<WebSocket, ValidPlayerSlot>();
    const room = new GameRoom(
      slotAssignments,
      connectedSockets,
      settings,
      settings.seed,
    );
    const entry: RoomEntry = {
      room,
      code,
      hostSocket,
      connectedSockets,
      slotAssignments,
      started: false,
      cleanupTimer: null,
      autoStartTimer: null,
      createdAt: Date.now(),
    };
    // Step 3: Register in lookup maps
    this.rooms.set(code, entry);
    this.socketToRoom.set(hostSocket, entry);
    // Step 4: Set host in GameRoom (socket already in connectedSockets)
    room.setHost(hostSocket);

    // Step 5: Start wait timer
    const waitSec = room.settings.waitTimerSec;
    entry.autoStartTimer = setTimeout(() => {
      if (!entry.started) this.doStartGame(entry);
    }, waitSec * 1000);

    return code;
  }

  joinRoom(code: string, socket: WebSocket): RoomEntry | null {
    this.disconnectSocketFromRoom(socket);
    const entry = this.rooms.get(code.toUpperCase());
    if (!entry || entry.started) return null;

    entry.connectedSockets.add(socket);
    this.socketToRoom.set(socket, entry);
    return entry;
  }

  /** Player selects a color/position slot, which becomes their playerId.
   *  playerId = 0-indexed player position used as the player's identity
   *  for the entire session across all game messages.
   *  Updates slotAssignments (shared with GameRoom for identity enforcement).
   *  Returns null if: slot taken by another player, invalid playerId, or game already started. */
  selectSlot(
    socket: WebSocket,
    playerId: ValidPlayerSlot,
  ): SlotSelectionResult | null {
    const entry = this.socketToRoom.get(socket);
    if (!entry || entry.started) return null;
    if (playerId < 0 || playerId >= MAX_PLAYERS) return null;

    // Check if slot is already taken by another socket
    for (const [otherSocket, otherId] of entry.slotAssignments) {
      if (otherId === playerId && otherSocket !== socket) return null;
    }

    const previousPlayerId = entry.slotAssignments.get(socket) ?? null;
    // Release previous slot if this socket had one
    entry.slotAssignments.delete(socket);
    // Assign new slot (shared map — GameRoom sees this immediately)
    entry.slotAssignments.set(socket, playerId);

    return { playerId, previousPlayerId };
  }

  /** Mark room as started: stop wait timer, add spectators. Game init is driven by host client. */
  private doStartGame(entry: RoomEntry): void {
    if (entry.started) return;
    entry.started = true;
    if (entry.autoStartTimer) {
      clearTimeout(entry.autoStartTimer);
      entry.autoStartTimer = null;
    }
    // All sockets are already spectators (added on join/create)
    console.log(
      `[rooms] Room ${entry.code} started with ${entry.slotAssignments.size} human(s)`,
    );
  }

  // ---------------------------------------------------------------------------
  // Message routing
  // ---------------------------------------------------------------------------

  handleMessage(
    socket: WebSocket,
    msg: Record<string, unknown>,
    rawJson: string,
  ): void {
    const entry = this.socketToRoom.get(socket);
    if (!entry) return;
    entry.room.handleMessage(socket, msg, rawJson);
  }

  // ---------------------------------------------------------------------------
  // Disconnection
  // ---------------------------------------------------------------------------

  /** Full disconnect handler — two distinct paths:
   *
   *  **Pre-start** (host leaves before game begins):
   *  → teardownUnstartedRoom() — room deleted immediately, all sockets detached.
   *
   *  **Mid-game** (any socket leaves after game started):
   *  → handlePlayerLeftMidGame() — broadcasts PLAYER_LEFT, migrates host if needed.
   *  → If room is now empty, schedules delayed cleanup.
   *
   *  RoomManager owns all socket/player tracking (connectedSockets, slotAssignments).
   *  GameRoom only owns rate limit state, cleaned up via clearRateLimits(). */
  handleSocketDisconnect(socket: WebSocket): void {
    const entry = this.socketToRoom.get(socket);
    if (!entry) return;

    const playerId = entry.slotAssignments.get(socket);
    const wasHost = socket === entry.hostSocket;

    // RoomManager-level cleanup (always)
    entry.connectedSockets.delete(socket);
    entry.slotAssignments.delete(socket);
    this.socketToRoom.delete(socket);

    // Path 1: Host left before game start — tear down immediately
    if (wasHost && !entry.started) {
      this.teardownUnstartedRoom(entry);
      return;
    }

    // Path 2: Socket left during active game
    if (entry.started) {
      this.handlePlayerLeftMidGame(entry, socket, playerId, wasHost);
    }

    if (entry.connectedSockets.size === 0) {
      this.scheduleCleanup(entry);
    }
  }

  /** Host left before game start — delete the room immediately. */
  private teardownUnstartedRoom(entry: RoomEntry): void {
    if (entry.autoStartTimer) {
      clearTimeout(entry.autoStartTimer);
      entry.autoStartTimer = null;
    }
    for (const s of entry.connectedSockets) {
      this.socketToRoom.delete(s);
    }
    entry.connectedSockets.clear();
    this.rooms.delete(entry.code);
    console.log(`[rooms] Room ${entry.code} deleted (host left before start)`);
  }

  /** Handle a player (or host) disconnecting during an active game.
   *  @param playerId — The disconnected socket's slot, or undefined if the
   *  socket never selected a slot (spectator/watcher). When undefined,
   *  no PLAYER_LEFT is broadcast (spectators are invisible to clients). */
  private handlePlayerLeftMidGame(
    entry: RoomEntry,
    socket: WebSocket,
    playerId: ValidPlayerSlot | undefined,
    wasHost: boolean,
  ): void {
    entry.room.clearRateLimits(socket);
    if (playerId !== undefined && playerId >= 0) {
      this.broadcastToRoom(entry, { type: MESSAGE.PLAYER_LEFT, playerId });
    }
    if (wasHost) {
      this.migrateHost(entry, playerId);
    }
  }

  /** Promote the lowest-slot player to host; falls back to any open socket. */
  private migrateHost(
    entry: RoomEntry,
    disconnectedPlayerId: ValidPlayerSlot | undefined,
  ): void {
    let newHostSocket: WebSocket | undefined;
    let newHostPlayerId: ValidPlayerSlot | undefined;

    // Prefer lowest-playerId player
    for (const [sock, sid] of entry.slotAssignments) {
      if (
        sock.readyState === WebSocket.OPEN &&
        (newHostPlayerId === undefined || sid < newHostPlayerId)
      ) {
        newHostSocket = sock;
        newHostPlayerId = sid;
      }
    }
    // Fallback: any connected socket (watcher becomes relay host, all players AI)
    if (!newHostSocket) {
      for (const sock of entry.connectedSockets) {
        if (sock.readyState === WebSocket.OPEN) {
          newHostSocket = sock;
          break;
        }
      }
    }

    if (newHostSocket) {
      entry.hostSocket = newHostSocket;
      entry.room.setHost(newHostSocket);
      this.broadcastToRoom(entry, {
        type: MESSAGE.HOST_LEFT,
        newHostPlayerId: newHostPlayerId ?? null,
        disconnectedPlayerId: disconnectedPlayerId ?? null,
      });
      console.log(
        `[rooms] Room ${entry.code}: host migrated to P${newHostPlayerId}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Lobby queries
  // ---------------------------------------------------------------------------

  getEntry(socket: WebSocket): RoomEntry | undefined {
    return this.socketToRoom.get(socket);
  }

  /** Get list of players who have selected a slot. */
  getSlottedPlayers(
    entry: RoomEntry,
  ): { playerId: ValidPlayerSlot; name: string }[] {
    const result: { playerId: ValidPlayerSlot; name: string }[] = [];
    for (const [, pid] of entry.slotAssignments) {
      if (pid >= 0) {
        result.push({
          playerId: pid,
          name: PLAYER_NAMES[pid] ?? `P${pid + 1}`,
        });
      }
    }
    return result;
  }

  /** Get the slot occupied by the host, or null if host hasn't selected a slot. */
  getHostId(entry: RoomEntry): number | null {
    return entry.slotAssignments.get(entry.hostSocket) ?? null;
  }

  /** Seconds elapsed since room creation. */
  getElapsedSec(entry: RoomEntry): number {
    return (Date.now() - entry.createdAt) / 1000;
  }

  /** List rooms available to join (not started, not empty). */
  listRooms(): {
    code: string;
    players: number;
    settings: RoomSettings;
    elapsedSec: number;
  }[] {
    const result: {
      code: string;
      players: number;
      settings: RoomSettings;
      elapsedSec: number;
    }[] = [];
    for (const entry of this.rooms.values()) {
      if (entry.started) continue;
      result.push({
        code: entry.code,
        players: entry.slotAssignments.size,
        settings: entry.room.settings,
        elapsedSec: Math.round(this.getElapsedSec(entry)),
      });
    }
    return result;
  }

  /** Get the list of occupied slot IDs. */
  getOccupiedSlots(entry: RoomEntry): number[] {
    return [...entry.slotAssignments.values()];
  }

  // ---------------------------------------------------------------------------
  // Broadcasting
  // ---------------------------------------------------------------------------

  broadcastToRoom(entry: RoomEntry, msg: ServerMessage): void {
    const json = JSON.stringify(msg);
    for (const sock of entry.connectedSockets) {
      safeSendRaw(sock, json);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private generateCode(): string {
    let code: string;
    do {
      code = "";
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code +=
          ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
      }
    } while (this.rooms.has(code));
    return code;
  }

  private disconnectSocketFromRoom(socket: WebSocket): void {
    if (this.socketToRoom.has(socket)) {
      this.handleSocketDisconnect(socket);
    }
  }

  private scheduleCleanup(entry: RoomEntry): void {
    if (entry.cleanupTimer) return;
    entry.cleanupTimer = setTimeout(() => {
      this.rooms.delete(entry.code);
      console.log(`[rooms] Room ${entry.code} cleaned up`);
    }, ROOM_CLEANUP_DELAY_MS);
  }
}
