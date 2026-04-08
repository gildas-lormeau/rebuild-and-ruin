/**
 * Online session state management.
 *
 * Types and lifecycle utilities for the WebSocket session, dedup maps,
 * and connection management. Extracted from online-client.ts to provide
 * typed state and reusable networking plumbing.
 */

import {
  DEFAULT_CANNON_HP,
  type GameMessage,
  MESSAGE,
  type ServerMessage,
} from "../../server/protocol.ts";
import {
  GAME_MODE_CLASSIC,
  type GameMode,
  LOBBY_TIMER,
} from "../shared/game-constants.ts";
import type { LifeLostChoice } from "../shared/interaction-types.ts";
import {
  createDedupChannel,
  type DedupChannel,
} from "../shared/phantom-types.ts";
import {
  type PlayerSlotId,
  SPECTATOR_SLOT,
  type ValidPlayerSlot,
} from "../shared/player-slot.ts";

export interface OnlineSession {
  socket: WebSocket | null;
  /** This player's slot id. SPECTATOR_SLOT (-1) = watcher/spectator.
   *  Use `isActivePlayer(myPlayerId)` to check, not raw comparisons. */
  myPlayerId: PlayerSlotId;
  /** Whether this client is the current host.
   *  VOLATILE: Can flip from false to true during host promotion (see online-host-promotion.ts).
   *  Never cache across tick boundaries, awaits, or phase transitions.
   *  Host promotion triggers: original host disconnects → server sends HOST_MIGRATION → this flips.
   *
   *  READ via `isHostInContext(session)` from tick-context.ts (enforced by ESLint).
   *  WRITE only in session init/reset/promotion (with eslint-disable). */
  isHost: boolean;
  hostMigrationSeq: number;
  /** All player slots with a connected client (includes self + remote humans + AI slots).
   *  INVARIANT: remoteHumanSlots ⊆ occupiedSlots (every remote human is also occupied).
   *  Both sets are maintained atomically by clearLobbySlot/occupyLobbySlot in
   *  online-server-lifecycle.ts — never mutate one without the other. */
  occupiedSlots: Set<number>;
  /** Remote human player slots only (excludes self and AI-controlled slots).
   *  INVARIANT: remoteHumanSlots ⊆ occupiedSlots. */
  remoteHumanSlots: Set<number>;
  roomWaitTimerSec: number;
  roomSeed: number;
  roomMaxRounds: number;
  roomCannonMaxHp: number;
  roomGameMode: GameMode;
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
 *  hidden so callers must use `channel.shouldSend(id, key)` to check + update atomically. */
export interface DedupMaps {
  aimTarget: DedupChannel;
  piecePhantom: DedupChannel;
  cannonPhantom: DedupChannel;
}

interface ConnectHandlers {
  onMessage: (msg: ServerMessage) => void | Promise<void>;
  onClose: () => void;
  onError: () => void;
}

const KEEPALIVE_MS = 30_000;

export function createSession(): OnlineSession {
  return {
    socket: null,
    myPlayerId: SPECTATOR_SLOT,
    isHost: false,
    hostMigrationSeq: 0,
    occupiedSlots: new Set(),
    remoteHumanSlots: new Set(),
    roomWaitTimerSec: LOBBY_TIMER,
    roomSeed: 0,
    roomMaxRounds: 0,
    roomCannonMaxHp: DEFAULT_CANNON_HP,
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
  session.myPlayerId = SPECTATOR_SLOT;
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
  playerId?: ValidPlayerSlot,
): void {
  const pid = playerId ?? (session.myPlayerId as ValidPlayerSlot);
  const value = `${Math.round(x)},${Math.round(y)}`;
  if (!dedup.aimTarget.shouldSend(pid, value)) return;
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
      void handlers.onMessage(JSON.parse(e.data as string) as ServerMessage);
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
