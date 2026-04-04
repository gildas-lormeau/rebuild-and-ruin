import { PLAYER_NAMES } from "../src/player-config.ts";
import type { ValidPlayerSlot } from "../src/player-slot.ts";
import { MESSAGE, type RoomSettings } from "./protocol.ts";
import { RoomManager } from "./room-manager.ts";

const rooms = new RoomManager();

/** Reject messages larger than 64 KB (full_state worst case is ~30 KB). */
const MAX_MESSAGE_SIZE = 65_536;

const DEFAULT_PORT = 8001;
const PORT = parseInt(Deno.env.get("PORT") ?? String(DEFAULT_PORT));

Deno.serve({ port: PORT }, (req) => {
  const url = new URL(req.url);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      },
    });
  }

  if (url.pathname === "/api/rooms") {
    return new Response(JSON.stringify(rooms.listRooms()), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  if (url.pathname === "/ws/play") {
    const upgrade = req.headers.get("upgrade") ?? "";
    if (upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const { socket, response } = Deno.upgradeWebSocket(req);

    socket.onmessage = (event) => {
      try {
        if (typeof event.data !== "string") return;
        if (event.data.length > MAX_MESSAGE_SIZE) return;
        const msg = JSON.parse(event.data);
        if (typeof msg.type !== "string") return;
        handleMessage(socket, msg, event.data);
      } catch {
        // Ignore malformed messages
      }
    };

    socket.onclose = () => {
      rooms.handleSocketDisconnect(socket);
    };

    socket.onerror = (e) => {
      console.error("[server] WebSocket error:", e);
    };

    return response;
  }

  if (url.pathname === "/health") {
    return new Response("ok");
  }

  return new Response("Not found", { status: 404 });
});

// Lobby/room-management message handler (simple switch dispatch).
// In-game messages are forwarded to GameRoom which uses a validation
// pipeline instead (phase gating → identity → payload → rate limit → relay).
// See game-room.ts handleMessage() for the pipeline pattern.

/** Route incoming WebSocket messages.
 *  Two-tier dispatch: this switch handles lobby/room-management messages
 *  (CREATE_ROOM, JOIN_ROOM, SELECT_SLOT, PING) that require server-side
 *  responses. All other messages fall through to RoomManager→GameRoom which
 *  validates and relays using set-based gates (HOST_ONLY, PHASE_GATES,
 *  RATE_LIMITED_TYPES).
 *
 *  Two-tier dispatch: lobby/room-management messages use this simple switch;
 *  in-game messages use game-room.ts's multi-stage validation pipeline.
 *  New game-state messages go in game-room.ts, not here. */
function handleMessage(
  socket: WebSocket,
  msg: Record<string, unknown>,
  rawJson: string,
): void {
  switch (msg.type) {
    case MESSAGE.CREATE_ROOM: {
      const code = rooms.createRoom(msg.settings as RoomSettings, socket);
      if (!code) {
        send(socket, {
          type: MESSAGE.ROOM_ERROR,
          message: "Server full, try again later",
        });
        return;
      }
      const entry = rooms.getEntry(socket)!;
      // No slot assigned yet — player clicks a panel to pick their color
      send(socket, {
        type: MESSAGE.ROOM_CREATED,
        code,
        settings: entry.room.settings,
        seed: entry.room.seed,
      });
      console.log(`[server] Room ${code} created`);
      break;
    }

    case MESSAGE.JOIN_ROOM: {
      if (typeof msg.code !== "string") break;
      const entry = rooms.joinRoom(msg.code, socket);
      if (!entry) {
        send(socket, {
          type: MESSAGE.ROOM_ERROR,
          message: "Room not found or already started",
        });
        return;
      }
      // No slot assigned yet — player clicks a panel to pick their color
      send(socket, {
        type: MESSAGE.ROOM_JOINED,
        code: entry.code,
        players: rooms.getSlottedPlayers(entry),
        settings: entry.room.settings,
        hostId: rooms.getHostId(entry),
        seed: entry.room.seed,
        elapsedSec: rooms.getElapsedSec(entry),
      });
      console.log(`[server] Player joined room ${entry.code}`);
      break;
    }

    case MESSAGE.SELECT_SLOT: {
      const selection = rooms.selectSlot(
        socket,
        msg.playerId as ValidPlayerSlot,
      );
      if (!selection) break;
      const entry = rooms.getEntry(socket);
      if (!entry) break;
      const previousPlayerId =
        selection.previousPlayerId !== null &&
        selection.previousPlayerId !== selection.playerId
          ? selection.previousPlayerId
          : undefined;
      send(socket, {
        type: MESSAGE.JOINED,
        playerId: selection.playerId,
        previousPlayerId,
      });
      // Notify all in room about the updated slot assignments
      rooms.broadcastToRoom(entry, {
        type: MESSAGE.PLAYER_JOINED,
        playerId: selection.playerId,
        name: PLAYER_NAMES[selection.playerId] ?? `P${selection.playerId + 1}`,
        previousPlayerId,
      });
      break;
    }

    case MESSAGE.PING:
      break;

    default:
      // In-game messages: route to the player's room
      rooms.handleMessage(socket, msg, rawJson);
      break;
  }
}

/** Send a server-originated message (serializes to JSON).
 *  For relaying client messages, use safeSendRaw() to avoid re-serialization. */
function send(
  socket: WebSocket,
  msg: import("./protocol.ts").ServerMessage,
): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

console.log(`[server] Listening on http://localhost:${PORT}`);
