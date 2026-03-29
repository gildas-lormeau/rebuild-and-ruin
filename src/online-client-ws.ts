/**
 * WebSocket connection lifecycle and reconnection for online play.
 */

import { handleServerMessage } from "./online-client-deps.ts";
import { runtime } from "./online-client-runtime.ts";
import {
  clearReconnect,
  devLog,
  isReconnecting,
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_BASE_DELAY_MS,
  reconnect,
  session,
} from "./online-client-stores.ts";
import { computeWsUrl } from "./online-config.ts";
import { connectWebSocket } from "./online-session.ts";
import { Mode } from "./types.ts";

const ANNOUNCEMENT_RECONNECTING = "Reconnecting\u2026";
const ANNOUNCEMENT_DISCONNECTED = "Disconnected from server";

/** Stashed from the first call so reconnect retries reuse it. */
let _onConnectError: (() => void) | undefined;

export function connect(onConnectError?: () => void): void {
  if (onConnectError) _onConnectError = onConnectError;
  connectWebSocket(session, computeWsUrl(), {
    onMessage: (msg) => {
      if (isReconnecting()) {
        devLog(`reconnected after ${reconnect.count} attempt(s)`);
        clearReconnect();
      }
      handleServerMessage(msg);
    },
    onClose: () => {
      const mode = runtime.rs.mode;
      // Mode[mode] is TypeScript's reverse enum mapping (numeric → string name)
      devLog(`WebSocket closed (mode=${Mode[mode]} isHost=${session.isHost})`);
      if (session.isHost || mode === Mode.STOPPED || mode === Mode.LOBBY)
        return;
      if (reconnect.count < MAX_RECONNECT_ATTEMPTS) {
        reconnect.count++;
        // Exponential backoff: base × 2^(attempt-1) via bit-shift
        const delay = RECONNECT_BASE_DELAY_MS * (1 << (reconnect.count - 1));
        runtime.rs.frame.announcement = ANNOUNCEMENT_RECONNECTING;
        runtime.render();
        devLog(
          `reconnect attempt ${reconnect.count}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`,
        );
        reconnect.timer = setTimeout(() => {
          reconnect.timer = null;
          connect();
        }, delay);
      } else {
        clearReconnect();
        runtime.rs.frame.announcement = ANNOUNCEMENT_DISCONNECTED;
        runtime.render();
        runtime.rs.mode = Mode.STOPPED;
      }
    },
    onError: () => {
      console.error("[online] WebSocket connection failed");
      _onConnectError?.();
    },
  });
}
