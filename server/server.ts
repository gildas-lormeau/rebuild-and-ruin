/**
 * Rebuild & Ruin — Deno Deploy server entry point.
 * Serves the /ws/play WebSocket endpoint for online play with room management.
 */

import { PLAYER_NAMES } from "../src/player-config.ts";
import { MSG } from "./protocol.ts";
import { RoomManager } from "./room-manager.ts";

const rooms = new RoomManager();

/** Reject messages larger than 64 KB (full_state worst case is ~30 KB). */
const MAX_MESSAGE_SIZE = 65_536;

const PORT = parseInt(Deno.env.get("PORT") ?? "8001");

Deno.serve({ port: PORT }, (req) => {
  const url = new URL(req.url);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" },
    });
  }

  if (url.pathname === "/api/rooms") {
    return new Response(JSON.stringify(rooms.listRooms()), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
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
      rooms.removeSocket(socket);
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

// deno-lint-ignore no-explicit-any
function handleMessage(socket: WebSocket, msg: Record<string, any>, rawJson: string): void {
  switch (msg.type) {
    case MSG.CREATE_ROOM: {
      const code = rooms.createRoom(msg.settings, socket);
      if (!code) {
        send(socket, { type: MSG.ROOM_ERROR, message: "Server full, try again later" });
        return;
      }
      const entry = rooms.getEntry(socket)!;
      // No slot assigned yet — player clicks a panel to pick their color
      send(socket, {
        type: MSG.ROOM_CREATED,
        code,
        settings: entry.room.settings,
        seed: entry.room.seed,
      });
      console.log(`[server] Room ${code} created`);
      break;
    }

    case MSG.JOIN_ROOM: {
      if (typeof msg.code !== "string") break;
      const entry = rooms.joinRoom(msg.code, socket);
      if (!entry) {
        send(socket, { type: MSG.ROOM_ERROR, message: "Room not found or already started" });
        return;
      }
      // No slot assigned yet — player clicks a panel to pick their color
      send(socket, {
        type: MSG.ROOM_JOINED,
        code: entry.code,
        players: rooms.getRoomPlayers(entry),
        settings: entry.room.settings,
        hostId: rooms.getHostId(entry),
        seed: entry.room.seed,
        elapsedSec: rooms.getElapsedSec(entry),
      });
      console.log(`[server] Player joined room ${entry.code}`);
      break;
    }

    case MSG.SELECT_SLOT: {
      const slotId = rooms.selectSlot(socket, msg.slotId);
      if (slotId < 0) break;
      const entry = rooms.getEntry(socket);
      if (!entry) break;
      send(socket, { type: MSG.JOINED, playerId: slotId });
      // Notify all in room about the updated slot assignments
      rooms.broadcastToRoom(entry, {
        type: MSG.PLAYER_JOINED,
        playerId: slotId,
        name: PLAYER_NAMES[slotId] ?? `P${slotId + 1}`,
      });
      break;
    }

    case MSG.PING:
      break;

    default:
      // In-game messages: route to the player's room
      rooms.handleMessage(socket, msg, rawJson);
      break;
  }
}

function send(socket: WebSocket, msg: import("./protocol.ts").ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

console.log(`[server] Listening on http://localhost:${PORT}`);
