/**
 * Online session state management.
 *
 * Types and lifecycle utilities for the WebSocket session, dedup maps,
 * and connection management. Extracted from online-client.ts to provide
 * typed state and reusable networking plumbing.
 */

import {
  type GameMessage,
  MESSAGE,
  type ServerMessage,
} from "../server/protocol.ts";
import { LOBBY_TIMER } from "./game-constants.ts";
import type { LifeLostChoice } from "./types.ts";

export interface OnlineSession {
  socket: WebSocket | null;
  /** This player's slot id. -1 = watcher/spectator (not an active player). */
  myPlayerId: number;
  /** Can flip during host promotion — always re-check before critical operations;
   *  do not cache across awaits or across tick boundaries. */
  isHost: boolean;
  hostMigrationSeq: number;
  occupiedSlots: Set<number>;
  remoteHumanSlots: Set<number>;
  lobbyWaitTimer: number;
  roomSeed: number;
  roomBattleLength: number;
  roomCannonMaxHp: number;
  keepaliveTimer: ReturnType<typeof setInterval> | null;
  lobbyStartTime: number;
  earlyLifeLostChoices: Map<number, LifeLostChoice>;
}

/** Network deduplication maps — tracks the last-sent value per player for each
 *  message type. If the new value matches, the send is skipped to reduce bandwidth.
 *  Cleared on session reset and host promotion. */
export interface DedupMaps {
  aimTarget: Map<number, string>;
  piecePhantom: Map<number, string>;
  cannonPhantom: Map<number, string>;
}

interface ConnectHandlers {
  onMessage: (msg: ServerMessage) => void;
  onClose: () => void;
  onError: () => void;
}

const KEEPALIVE_MS = 30_000;

export function createSession(): OnlineSession {
  return {
    socket: null,
    myPlayerId: -1,
    isHost: false,
    hostMigrationSeq: 0,
    occupiedSlots: new Set(),
    remoteHumanSlots: new Set(),
    lobbyWaitTimer: LOBBY_TIMER,
    roomSeed: 0,
    roomBattleLength: 0,
    roomCannonMaxHp: 3,
    keepaliveTimer: null,
    lobbyStartTime: 0,
    earlyLifeLostChoices: new Map(),
  };
}

export function createDedupMaps(): DedupMaps {
  return {
    aimTarget: new Map(),
    piecePhantom: new Map(),
    cannonPhantom: new Map(),
  };
}

export function resetDedupMaps(dedup: DedupMaps): void {
  dedup.aimTarget.clear();
  dedup.piecePhantom.clear();
  dedup.cannonPhantom.clear();
}

export function resetSessionState(session: OnlineSession): void {
  session.socket?.close();
  session.socket = null;
  session.isHost = false;
  session.hostMigrationSeq = 0;
  session.myPlayerId = -1;
  session.occupiedSlots.clear();
  session.remoteHumanSlots.clear();
  session.earlyLifeLostChoices.clear();
}

export function sendAimUpdate(
  session: OnlineSession,
  dedup: DedupMaps,
  x: number,
  y: number,
  playerId?: number,
): void {
  const pid = playerId ?? session.myPlayerId;
  const key = `${Math.round(x)},${Math.round(y)}`;
  if (dedup.aimTarget.get(pid) === key) return;
  dedup.aimTarget.set(pid, key);
  sendMessage(session, { type: MESSAGE.AIM_UPDATE, playerId: pid, x, y });
}

export function sendMessage(session: OnlineSession, msg: GameMessage): void {
  // === OPEN: only send when fully connected (not CONNECTING)
  if (session.socket?.readyState === WebSocket.OPEN) {
    session.socket.send(JSON.stringify(msg));
  }
}

/**
 * Open a WebSocket connection, wire keepalive, and delegate events
 * to the provided handlers.
 */
export function connectWebSocket(
  session: OnlineSession,
  wsUrl: string,
  handlers: ConnectHandlers,
): void {
  // <= OPEN: skip if CONNECTING (0) or OPEN (1); only connect when CLOSING/CLOSED
  if (session.socket && session.socket.readyState <= WebSocket.OPEN) return;
  session.socket = new WebSocket(wsUrl);
  session.socket.onmessage = (e) => {
    try {
      handlers.onMessage(JSON.parse(e.data as string) as ServerMessage);
    } catch (err) {
      console.warn("[ws] malformed message:", err);
    }
  };
  session.socket.onopen = () => {
    if (session.keepaliveTimer) clearInterval(session.keepaliveTimer);
    session.keepaliveTimer = setInterval(() => {
      if (session.socket?.readyState === WebSocket.OPEN) {
        session.socket.send(JSON.stringify({ type: MESSAGE.PING }));
      }
    }, KEEPALIVE_MS);
  };
  session.socket.onclose = () => {
    if (session.keepaliveTimer) {
      clearInterval(session.keepaliveTimer);
      session.keepaliveTimer = null;
    }
    handlers.onClose();
  };
  session.socket.onerror = () => {
    handlers.onError();
  };
}
