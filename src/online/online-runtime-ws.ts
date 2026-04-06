/**
 * WebSocket connection lifecycle and reconnection for online play.
 *
 * Does NOT import online-runtime-game.ts — runtime access is injected
 * via initWs() to avoid initialization coupling with the composition root.
 */

import { isHostInContext } from "../shared/tick-context.ts";
import { Mode } from "../shared/ui-mode.ts";
import { computeWsUrl } from "./online-config.ts";
import { handleServerMessage } from "./online-runtime-deps.ts";
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
}

// ── Constants ──────────────────────────────────────────────────────
const ANNOUNCEMENT_RECONNECTING = "Reconnecting\u2026";
// \u2026 = ellipsis (…)
const ANNOUNCEMENT_DISCONNECTED = "Disconnected from server";

// ── Late-bound state ───────────────────────────────────────────────
let _rt: WsRuntimeDeps;
let _client: OnlineClient;
/** Stashed from the first call so reconnect retries reuse it. */
let _onConnectError: (() => void) | undefined;

/** Bind runtime-dependent callbacks. Called once from online-runtime-game.ts
 *  after the GameRuntime is created. */
export function initWs(deps: WsRuntimeDeps, client: OnlineClient): void {
  _rt = deps;
  _client = client;
}

export function connect(onConnectError?: () => void): void {
  if (!_rt) throw new Error("connect() called before initWs()");
  if (onConnectError) _onConnectError = onConnectError;
  connectWebSocket(_client.ctx.session, computeWsUrl(), {
    onMessage: async (msg) => {
      if (_client.isReconnecting()) {
        _client.devLog(
          `reconnected after ${_client.ctx.reconnect.count} attempt(s)`,
        );
        _client.clearReconnect();
      }
      await handleServerMessage(msg);
    },
    onClose: () => {
      const mode = _rt.getMode();
      // Mode[mode] is TypeScript's reverse enum mapping (numeric → string name)
      _client.devLog(
        // eslint-disable-next-line no-restricted-syntax -- diagnostic logging
        `WebSocket closed (mode=${Mode[mode]} isHost=${_client.ctx.session.isHost})`,
      );
      if (
        isHostInContext(_client.ctx.session) ||
        mode === Mode.STOPPED ||
        mode === Mode.LOBBY
      )
        return;
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
          connect();
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
      _onConnectError?.();
    },
  });
}
