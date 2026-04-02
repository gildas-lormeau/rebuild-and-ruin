/**
 * WebSocket connection lifecycle and reconnection for online play.
 *
 * Does NOT import runtime-online-game.ts — runtime access is injected
 * via initWs() to avoid initialization coupling with the composition root.
 */

import { computeWsUrl } from "./online-config.ts";
import { connectWebSocket } from "./online-session.ts";
import {
  clearReconnect,
  ctx,
  devLog,
  isReconnecting,
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_BASE_DELAY_MS,
} from "./online-stores.ts";
import { handleServerMessage } from "./runtime-online-deps.ts";
import { isHostInContext } from "./tick-context.ts";
import { Mode } from "./types.ts";

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
/** Stashed from the first call so reconnect retries reuse it. */
let _onConnectError: (() => void) | undefined;

/** Bind runtime-dependent callbacks. Called once from runtime-online-game.ts
 *  after the GameRuntime is created. */
export function initWs(deps: WsRuntimeDeps): void {
  _rt = deps;
}

export function connect(onConnectError?: () => void): void {
  if (!_rt) throw new Error("connect() called before initWs()");
  if (onConnectError) _onConnectError = onConnectError;
  connectWebSocket(ctx.session, computeWsUrl(), {
    onMessage: (msg) => {
      if (isReconnecting()) {
        devLog(`reconnected after ${ctx.reconnect.count} attempt(s)`);
        clearReconnect();
      }
      handleServerMessage(msg);
    },
    onClose: () => {
      const mode = _rt.getMode();
      // Mode[mode] is TypeScript's reverse enum mapping (numeric → string name)
      devLog(
        // eslint-disable-next-line no-restricted-syntax -- diagnostic logging
        `WebSocket closed (mode=${Mode[mode]} isHost=${ctx.session.isHost})`,
      );
      if (
        isHostInContext(ctx.session) ||
        mode === Mode.STOPPED ||
        mode === Mode.LOBBY
      )
        return;
      if (ctx.reconnect.count < MAX_RECONNECT_ATTEMPTS) {
        ctx.reconnect.count++;
        // Exponential backoff: base × 2^(attempt-1) via bit-shift
        const delay =
          RECONNECT_BASE_DELAY_MS * (1 << (ctx.reconnect.count - 1));
        _rt.setAnnouncement(ANNOUNCEMENT_RECONNECTING);
        _rt.render();
        devLog(
          `reconnect attempt ${ctx.reconnect.count}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`,
        );
        ctx.reconnect.timer = setTimeout(() => {
          ctx.reconnect.timer = null;
          connect();
        }, delay);
      } else {
        clearReconnect();
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
