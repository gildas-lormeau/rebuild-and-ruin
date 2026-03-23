/**
 * Rebuild & Ruin — Deno Deploy server entry point.
 * Serves the /ws/play WebSocket endpoint for online play with room management.
 */

import { RoomManager } from "./room-manager.ts";
import { PLAYER_NAMES } from "../src/player-config.ts";

const rooms = new RoomManager();

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
        const rawJson: string = event.data;
        const msg = JSON.parse(rawJson);
        handleMessage(socket, msg, rawJson);
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
    case "create_room": {
      const code = rooms.createRoom(msg.settings, socket);
      if (!code) {
        send(socket, { type: "room_error", message: "Server full, try again later" });
        return;
      }
      const entry = rooms.getEntry(socket)!;
      // No slot assigned yet — player clicks a panel to pick their color
      send(socket, {
        type: "room_created",
        code,
        settings: entry.room.settings,
        seed: entry.room.seed,
      });
      console.log(`[server] Room ${code} created`);
      break;
    }

    case "join_room": {
      const entry = rooms.joinRoom(msg.code, socket);
      if (!entry) {
        send(socket, { type: "room_error", message: "Room not found or already started" });
        return;
      }
      // No slot assigned yet — player clicks a panel to pick their color
      send(socket, {
        type: "room_joined",
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

    case "select_slot": {
      const slotId = rooms.selectSlot(socket, msg.slotId);
      if (slotId < 0) break;
      const entry = rooms.getEntry(socket);
      if (!entry) break;
      send(socket, { type: "joined", playerId: slotId });
      // Notify all in room about the updated slot assignments
      rooms.broadcastToRoom(entry, {
        type: "player_joined",
        playerId: slotId,
        name: PLAYER_NAMES[slotId] ?? `P${slotId + 1}`,
      });
      break;
    }

    case "ping":
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
