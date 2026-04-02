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
import { createDedupChannel, type DedupChannel } from "./phantom-types.ts";
import type { LifeLostChoice } from "./types.ts";

export interface OnlineSession {
  socket: WebSocket | null;
  /** This player's slot id. -1 = watcher/spectator (not an active player). */
  onlinePlayerId: number;
  /** Whether this client is the current host.
   *  VOLATILE: Can flip from false to true during host promotion (see online-host-promotion.ts).
   *  Never cache across tick boundaries, awaits, or phase transitions.
   *  Host promotion triggers: original host disconnects → server sends HOST_MIGRATION → this flips.
   *
   *  READ via `isHostInContext(session)` from tick-context.ts (enforced by ESLint).
   *  WRITE only in session init/reset/promotion (with eslint-disable). */
  isHost: boolean;
  hostMigrationSeq: number;
  occupiedSlots: Set<number>;
  remoteHumanSlots: Set<number>;
  roomWaitTimerSec: number;
  roomSeed: number;
  roomMaxRounds: number;
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
 *  Each channel is an opaque DedupChannel (see phantom-types.ts) — the raw Map is
 *  hidden so callers must use `channel.changed(id, key)` to check + update atomically. */
export interface DedupMaps {
  aimTarget: DedupChannel;
  piecePhantom: DedupChannel;
  cannonPhantom: DedupChannel;
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
    onlinePlayerId: -1,
    isHost: false,
    hostMigrationSeq: 0,
    occupiedSlots: new Set(),
    remoteHumanSlots: new Set(),
    roomWaitTimerSec: LOBBY_TIMER,
    roomSeed: 0,
    roomMaxRounds: 0,
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
    aimTarget: createDedupChannel(),
    piecePhantom: createDedupChannel(),
    cannonPhantom: createDedupChannel(),
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
  session.isHost = false; // eslint-disable-line no-restricted-syntax -- session reset
  session.hostMigrationSeq = 0;
  session.onlinePlayerId = -1;
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
  const pid = playerId ?? session.onlinePlayerId;
  const value = `${Math.round(x)},${Math.round(y)}`;
  if (!dedup.aimTarget.changed(pid, value)) return;
  sendMessage(session, {
    type: MESSAGE.AIM_UPDATE,
    playerId: pid,
    x,
    y,
  });
}

export function sendMessage(session: OnlineSession, msg: GameMessage): void {
  if (isSocketOpen(session)) {
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
  if (!isSocketDisconnected(session)) return;
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
      if (isSocketOpen(session)) {
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
 *  Use for send guards. Contrast with `isSocketDisconnected()`. */
function isSocketOpen(session: OnlineSession): boolean {
  return session.socket?.readyState === WebSocket.OPEN;
}

/** True when the socket is closed/closing and a reconnect attempt is appropriate.
 *  readyState > OPEN means CLOSING(2) or CLOSED(3).
 *  Contrast with `isSocketOpen()` which checks === OPEN only. */
function isSocketDisconnected(session: OnlineSession): boolean {
  return !session.socket || session.socket.readyState > WebSocket.OPEN;
}
