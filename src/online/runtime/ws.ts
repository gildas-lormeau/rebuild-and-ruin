/**
 * WebSocket connection lifecycle and reconnection. Runtime injected via
 * `initWs()` (first of three `initOnlineRuntime` init calls, before
 * `initPromote` and `initDeps`); `connect()` throws if called first.
 */

import { MESSAGE, type ServerMessage } from "../../protocol/protocol.ts";
import { isHostInContext } from "../../runtime/tick-context.ts";
import { SPECTATOR_SLOT } from "../../shared/core/player-slot.ts";
import { Mode } from "../../shared/ui/ui-mode.ts";
import { computeWsUrl } from "../online-config.ts";
import { connectWebSocket, rollbackRejoinSession } from "../online-session.ts";
import {
  MAX_RECONNECT_ATTEMPTS,
  type OnlineClient,
  RECONNECT_BASE_DELAY_MS,
} from "../online-stores.ts";

// ── Types ──────────────────────────────────────────────────────────
interface WsRuntimeDeps {
  readonly getMode: () => Mode;
  readonly setMode: (mode: Mode) => void;
  readonly setAnnouncement: (text: string | undefined) => void;
  readonly render: () => void;
  /** Fan out an incoming server message to NetworkApi.onMessage subscribers.
   *  Wired by the composition root to the same bus that backs network.onMessage —
   *  the WS layer no longer knows about handleServerMessage directly. */
  readonly deliverIncoming: (msg: ServerMessage) => void | Promise<void>;
}

// ── Constants ──────────────────────────────────────────────────────
const ANNOUNCEMENT_RECONNECTING = "Reconnecting\u2026";
// \u2026 = ellipsis (…)
const ANNOUNCEMENT_DISCONNECTED = "Disconnected from server";
const ANNOUNCEMENT_AWAY = "Disconnected — away too long";
const ANNOUNCEMENT_LAG = "Disconnected — connection too unstable";

// ── Late-bound state ───────────────────────────────────────────────
let _rt: WsRuntimeDeps;
let _client: OnlineClient;

/** Bind runtime-dependent callbacks. Called once from online/runtime/game.ts
 *  after the GameRuntime is created. */
export function initWs(deps: WsRuntimeDeps, client: OnlineClient): void {
  _rt = deps;
  _client = client;
}

/** Deliberate self-disconnect for a seated peer hidden past the away
 *  threshold (see `online-away-watchdog.ts`). Mode flips to STOPPED
 *  BEFORE the socket closes so the `onClose` handler below sees a
 *  terminal mode and never starts the reconnect loop. The server reacts
 *  to the close with its normal PLAYER_LEFT / HOST_LEFT flow — opponents
 *  get the lockstep AI seat takeover (or host migration) they already
 *  have for real leavers. */
export function disconnectAway(): void {
  deliberateLeave(ANNOUNCEMENT_AWAY);
}

/** Deliberate self-disconnect for a peer whose link has fallen too far past
 *  the lockstep SAFETY window to stay in sync — a sustained burst of stale
 *  wire stamps (see `online-lag-detector.ts`, wired through `warnIfStaleWireStamp`
 *  in `deps.ts`). Tells the player plainly instead of letting them play a
 *  silently-forked board. Unlike `disconnectAway` there is NO auto-rejoin: the
 *  link is actively too laggy, so an immediate rejoin would just fork again —
 *  the player re-enters once their connection recovers. The socket close drives
 *  the server's PLAYER_LEFT / HOST_LEFT flow, so opponents get the lockstep AI
 *  takeover / host migration that heals the room. */
export function disconnectTooMuchLag(): void {
  deliberateLeave(ANNOUNCEMENT_LAG);
}

/** Auto-rejoin on tab-return after an away-disconnect (online-away-watchdog.ts
 *  `rejoin`). Opens a fresh socket and presents the retained room code + rejoin
 *  token so the server re-admits this peer into the STARTED room — it replays
 *  INIT, which boots us as a SPECTATOR whose away seat is rebuilt as the same AI
 *  mirror the room already runs, and asks the host for a resync.
 *  `awaitingRejoinResync` is set BEFORE the send so the host's ROOM-WIDE resync
 *  broadcast (a no-op self-migration) is adopted through the normal migration
 *  path (`applyFullStateToRunningRuntime`, keeping those AI controllers); the
 *  rejoiner then claims its seat back (SEAT_RECLAIM).
 *  No-op when no token/code is retained (never seated, or already reset). */
export function rejoinAfterAway(): void {
  const session = _client.ctx.session;
  const token = session.myRejoinToken;
  const code = session.roomCode;
  if (!token || !code || session.myPlayerId < 0) {
    _client.devLog(
      "rejoinAfterAway: no retained token/code/seat — cannot rejoin",
    );
    return;
  }
  // Boot as a SPECTATOR: stash the seat to reclaim and drop our identity so the
  // replayed-INIT bootstrap builds our seat as the same AI mirror the room
  // already holds (the AI took it over). We adopt the host's room-wide resync
  // broadcast via the normal migration path, then claim the seat back.
  session.awaitingRejoinSeat = session.myPlayerId;
  session.myPlayerId = SPECTATOR_SLOT;
  session.awaitingRejoinResync = true;
  void connect()
    .then(() => _client.send({ type: MESSAGE.REJOIN_ROOM, code, token }))
    // Connect rejected (socket onerror) — the REJOIN_ROOM never went out.
    .catch(abortRejoin);
}

/** Open the WebSocket connection. Resolves on socket `open`, rejects on
 *  `error` (the typical connect-failed-server-unreachable case). After the
 *  Promise settles, ongoing socket events route through the handlers
 *  registered in `connectWebSocket` — `onClose` drives reconnect, etc.
 *  Reconnect attempts call this fire-and-forget via `void connect()`. */
export function connect(): Promise<void> {
  if (!_rt) throw new Error("connect() called before initWs()");
  return new Promise<void>((resolve, reject) => {
    const handlers = {
      onMessage: async (msg: ServerMessage) => {
        if (_client.isReconnecting()) {
          _client.devLog(
            `reconnected after ${_client.ctx.reconnect.count} attempt(s)`,
          );
          _client.clearReconnect();
        }
        await _rt.deliverIncoming(msg);
      },
      onClose: () => {
        const mode = _rt.getMode();
        const amHost = isHostInContext(_client.ctx.session);
        // Mode[mode] is TypeScript's reverse enum mapping (numeric → string name)
        _client.devLog(
          `WebSocket closed (mode=${Mode[mode]} isHost=${amHost})`,
        );
        if (amHost || mode === Mode.STOPPED || mode === Mode.LOBBY) return;
        if (_client.ctx.reconnect.count < MAX_RECONNECT_ATTEMPTS) {
          _client.ctx.reconnect.count++;
          // Exponential backoff: base × 2^(attempt-1) via bit-shift
          const delay =
            RECONNECT_BASE_DELAY_MS * (1 << (_client.ctx.reconnect.count - 1));
          _rt.setAnnouncement(ANNOUNCEMENT_RECONNECTING);
          _rt.render();
          _client.devLog(
            `reconnect attempt ${_client.ctx.reconnect.count}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`,
          );
          _client.ctx.reconnect.timer = setTimeout(() => {
            _client.ctx.reconnect.timer = null;
            // Reconnect path — fire-and-forget; rejections are observed via
            // the next `onClose` cycle or the announcement-disconnected fallback.
            void connect().catch(() => {});
          }, delay);
        } else {
          _client.clearReconnect();
          _rt.setAnnouncement(ANNOUNCEMENT_DISCONNECTED);
          _rt.render();
          _rt.setMode(Mode.STOPPED);
        }
      },
      onError: () => {
        console.error("[online] WebSocket connection failed");
        reject(new Error("WebSocket connection failed"));
      },
    };
    connectWebSocket(_client.ctx.session, computeWsUrl(), handlers);
    const socket = _client.ctx.session.socket;
    if (!socket) {
      // Already connected (connectWebSocket bailed early via `isSocketDisconnected`).
      resolve();
      return;
    }
    socket.addEventListener("open", () => resolve(), { once: true });
  });
}

/** Shared deliberate-leave body. Mode flips to STOPPED BEFORE the socket
 *  closes so `onClose` sees a terminal mode and never starts the reconnect
 *  loop; the announcement is rendered first so it survives the frozen frame. */
function deliberateLeave(announcement: string): void {
  _client.clearReconnect();
  _rt.setAnnouncement(announcement);
  _rt.render();
  _rt.setMode(Mode.STOPPED);
  _client.ctx.session.socket?.close();
}

/** Roll back an in-flight rejoin that failed before its resync was adopted:
 *  the connect rejected (here), or the server rejected the rejoin with a
 *  ROOM_ERROR — expired token / room ended / seat still live-held (called from
 *  the ROOM_ERROR handler via `deps.rejoin.abort`). Restores the stashed seat
 *  identity, disarms the resync-adopt routing (so a later unrelated FULL_STATE
 *  isn't misrouted through `adoptResync`), and surfaces the disconnect.
 *  Idempotent — a no-op once the rejoin is no longer pending. */
function abortRejoin(): void {
  if (!rollbackRejoinSession(_client.ctx.session)) return;
  _rt.setAnnouncement(ANNOUNCEMENT_DISCONNECTED);
  _rt.render();
}
