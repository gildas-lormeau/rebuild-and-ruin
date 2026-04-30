/**
 * WebSocket connection lifecycle and reconnection for online play.
 *
 * Does NOT import online-runtime-game.ts — runtime access is injected
 * via initWs() to avoid initialization coupling with the composition root.
 *
 * ORDERING INVARIANT — initWs() is the first of three init calls from
 * online-runtime-game.ts:initOnlineRuntime(). The required order is:
 *    1. initWs (this file)
 *    2. initPromote (online-runtime-promote.ts)
 *    3. initDeps (online-runtime-deps.ts)
 * Calling connect() before initWs() throws. Do not reorder the call sequence
 * in initOnlineRuntime without updating all three modules.
 */

import type { ServerMessage } from "../protocol/protocol.ts";
import { isHostInContext } from "../runtime/runtime-tick-context.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import { computeWsUrl } from "./online-config.ts";
import { connectWebSocket } from "./online-session.ts";
import {
  MAX_RECONNECT_ATTEMPTS,
  type OnlineClient,
  RECONNECT_BASE_DELAY_MS,
} from "./online-stores.ts";

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

// ── Late-bound state ───────────────────────────────────────────────
let _rt: WsRuntimeDeps;
let _client: OnlineClient;

/** Bind runtime-dependent callbacks. Called once from online-runtime-game.ts
 *  after the GameRuntime is created. */
export function initWs(deps: WsRuntimeDeps, client: OnlineClient): void {
  _rt = deps;
  _client = client;
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
