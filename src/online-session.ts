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
import { GAME_MODE_CLASSIC, LOBBY_TIMER } from "./game-constants.ts";
import { dedupChanged } from "./phantom-types.ts";
import type { LifeLostChoice } from "./types.ts";

export interface OnlineSession {
  socket: WebSocket | null;
  /** This player's slot id. -1 = watcher/spectator (not an active player). */
  myPlayerId: number;
  /** Whether this client is the current host.
   *  VOLATILE: Can flip from false to true during host promotion (see online-host-promotion.ts).
   *  Never cache across tick boundaries, awaits, or phase transitions — always re-read from session.
   *  Host promotion triggers: original host disconnects → server sends HOST_MIGRATION → this flips. */
  isHost: boolean;
  hostMigrationSeq: number;
  occupiedSlots: Set<number>;
  remoteHumanSlots: Set<number>;
  lobbyWaitTimer: number;
  roomSeed: number;
  roomBattleLength: number;
  roomCannonMaxHp: number;
  roomGameMode: string;
  keepaliveTimer: ReturnType<typeof setInterval> | null;
  lobbyStartTime: number;
  earlyLifeLostChoices: Map<number, LifeLostChoice>;
  earlyUpgradePickChoices: Map<number, string>;
}

/** Network deduplication maps — tracks the last-sent value per player for each
 *  message type. If the new value matches, the send is skipped to reduce bandwidth.
 *  Cleared on session reset and host promotion.
 *
 *  Dedup invariant: always use `dedupChanged(map, id, key)` before sending.
 *  That function both checks AND updates the map atomically — see phantom-types.ts. */
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
    roomGameMode: GAME_MODE_CLASSIC,
    keepaliveTimer: null,
    lobbyStartTime: 0,
    earlyLifeLostChoices: new Map(),
    earlyUpgradePickChoices: new Map(),
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
  session.earlyUpgradePickChoices.clear();
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
  if (!dedupChanged(dedup.aimTarget, pid, key)) return;
  sendMessage(session, { type: MESSAGE.AIM_UPDATE, playerId: pid, x, y });
}

export function sendMessage(session: OnlineSession, msg: GameMessage): void {
  if (canSend(session)) {
    session.socket!.send(JSON.stringify(msg));
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
  if (!shouldReconnect(session)) return;
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
      if (canSend(session)) {
        session.socket!.send(JSON.stringify({ type: MESSAGE.PING }));
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

/** True when the socket is fully connected and can transmit.
 *  Use for send guards. Contrast with `shouldReconnect()`. */
function canSend(session: OnlineSession): boolean {
  return session.socket?.readyState === WebSocket.OPEN;
}

/** True when the socket is closed/closing and a reconnect attempt is appropriate.
 *  readyState > OPEN means CLOSING(2) or CLOSED(3).
 *  Contrast with `canSend()` which checks === OPEN only. */
function shouldReconnect(session: OnlineSession): boolean {
  return !session.socket || session.socket.readyState > WebSocket.OPEN;
}
