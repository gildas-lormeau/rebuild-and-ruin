/**
 * Room manager — creates, tracks, and cleans up game rooms.
 */

import { MAX_PLAYERS, PLAYER_NAMES } from "../src/player-config.ts";
import { GameRoom } from "./game-room.ts";
import { MSG, type RoomSettings, type ServerMessage } from "./protocol.ts";

const MAX_ROOMS = 50;
const ROOM_CLEANUP_DELAY_MS = 60_000; // 60s after game over

export interface RoomEntry {
  room: GameRoom;
  code: string;
  hostSocket: WebSocket;
  connectedSockets: Set<WebSocket>; // all connected sockets
  slotAssignments: Map<WebSocket, number>; // socket → slotId (only for those who picked a slot)
  started: boolean;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  waitTimer: ReturnType<typeof setTimeout> | null;
  createdAt: number; // Date.now() when room was created
}

interface SlotSelectionResult {
  slotId: number;
  previousSlotId: number | null;
}

export class RoomManager {
  private rooms = new Map<string, RoomEntry>();
  private socketToRoom = new Map<WebSocket, RoomEntry>();

  // ---------------------------------------------------------------------------
  // Room lifecycle
  // ---------------------------------------------------------------------------

  createRoom(settings: RoomSettings, hostSocket: WebSocket): string | null {
    this.detachExistingSocket(hostSocket);
    if (this.rooms.size >= MAX_ROOMS) return null;

    const code = this.generateCode();
    const room = new GameRoom(settings);
    const entry: RoomEntry = {
      room,
      code,
      hostSocket,
      connectedSockets: new Set([hostSocket]),
      slotAssignments: new Map(),
      started: false,
      cleanupTimer: null,
      waitTimer: null,
      createdAt: Date.now(),
    };
    this.rooms.set(code, entry);
    this.socketToRoom.set(hostSocket, entry);
    room.addSpectator(hostSocket);
    room.setHost(hostSocket);

    // Start wait timer
    const waitSec = room.settings.waitTimerSec;
    entry.waitTimer = setTimeout(() => {
      if (!entry.started) this.doStartGame(entry);
    }, waitSec * 1000);

    return code;
  }

  joinRoom(code: string, socket: WebSocket): RoomEntry | null {
    this.detachExistingSocket(socket);
    const entry = this.rooms.get(code.toUpperCase());
    if (!entry || entry.started) return null;

    entry.connectedSockets.add(socket);
    entry.room.addSpectator(socket);
    this.socketToRoom.set(socket, entry);
    return entry;
  }

  /** Player selects a slot (color). Returns the slotId or -1 if taken. */
  selectSlot(socket: WebSocket, slotId: number): SlotSelectionResult | null {
    const entry = this.socketToRoom.get(socket);
    if (!entry || entry.started) return null;
    if (slotId < 0 || slotId >= MAX_PLAYERS) return null;

    // Check if slot is already taken by another socket
    for (const [otherSocket, otherId] of entry.slotAssignments) {
      if (otherId === slotId && otherSocket !== socket) return null;
    }

    const previousSlotId = entry.slotAssignments.get(socket) ?? null;
    // Release previous slot if this socket had one
    entry.slotAssignments.delete(socket);
    // Assign new slot
    entry.slotAssignments.set(socket, slotId);

    // Register with game room
    entry.room.registerPlayer(socket, slotId);

    return { slotId, previousSlotId };
  }

  /** Mark room as started: stop wait timer, add spectators. Game init is driven by host client. */
  private doStartGame(entry: RoomEntry): void {
    if (entry.started) return;
    entry.started = true;
    if (entry.waitTimer) {
      clearTimeout(entry.waitTimer);
      entry.waitTimer = null;
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
    // deno-lint-ignore no-explicit-any
    msg: Record<string, any>,
    rawJson: string,
  ): void {
    const entry = this.socketToRoom.get(socket);
    if (!entry) return;
    entry.room.handleMessage(socket, msg, rawJson);
  }

  // ---------------------------------------------------------------------------
  // Disconnection
  // ---------------------------------------------------------------------------

  removeSocket(socket: WebSocket): void {
    const entry = this.socketToRoom.get(socket);
    if (!entry) return;

    const playerId = entry.slotAssignments.get(socket);
    const wasHost = socket === entry.hostSocket;
    entry.connectedSockets.delete(socket);
    entry.slotAssignments.delete(socket);
    this.socketToRoom.delete(socket);

    // Host left before game start — delete the room immediately
    if (wasHost && !entry.started) {
      if (entry.waitTimer) {
        clearTimeout(entry.waitTimer);
        entry.waitTimer = null;
      }
      for (const s of entry.connectedSockets) {
        this.socketToRoom.delete(s);
      }
      entry.connectedSockets.clear();
      this.rooms.delete(entry.code);
      console.log(
        `[rooms] Room ${entry.code} deleted (host left before start)`,
      );
      return;
    }

    if (entry.started) {
      entry.room.removePlayer(socket);
      if (playerId !== undefined && playerId >= 0) {
        this.broadcastToRoom(entry, { type: MSG.PLAYER_LEFT, playerId });
      }

      // Host left mid-game — promote another player
      if (wasHost) {
        const previousHostPlayerId = playerId ?? -1;
        let newHostSocket: WebSocket | null = null;
        let newHostPlayerId = -1;

        // Prefer lowest-slotId player
        for (const [sock, sid] of entry.slotAssignments) {
          if (
            sock.readyState === WebSocket.OPEN &&
            (newHostPlayerId < 0 || sid < newHostPlayerId)
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
            type: MSG.HOST_LEFT,
            newHostPlayerId,
            previousHostPlayerId,
          });
          console.log(
            `[rooms] Room ${entry.code}: host migrated to P${newHostPlayerId}`,
          );
        }
      }
    }

    if (entry.connectedSockets.size === 0) {
      this.scheduleCleanup(entry);
    }
  }

  // ---------------------------------------------------------------------------
  // Lobby queries
  // ---------------------------------------------------------------------------

  getEntry(socket: WebSocket): RoomEntry | undefined {
    return this.socketToRoom.get(socket);
  }

  /** Get list of players who have selected a slot. */
  getRoomPlayers(entry: RoomEntry): { playerId: number; name: string }[] {
    const result: { playerId: number; name: string }[] = [];
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

  /** Get the slot occupied by the host, or -1 if host hasn't selected a slot. */
  getHostId(entry: RoomEntry): number {
    return entry.slotAssignments.get(entry.hostSocket) ?? -1;
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
      if (sock.readyState === WebSocket.OPEN) {
        sock.send(json);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private generateCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, O (avoid confusion with 1, 0)
    let code: string;
    do {
      code = "";
      for (let i = 0; i < 4; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
      }
    } while (this.rooms.has(code));
    return code;
  }

  private detachExistingSocket(socket: WebSocket): void {
    if (this.socketToRoom.has(socket)) {
      this.removeSocket(socket);
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
