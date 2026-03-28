/**
 * WebSocket connection lifecycle and reconnection for online play.
 */

import { handleServerMessage } from "./online-client-deps.ts";
import { runtime } from "./online-client-runtime.ts";
import { clearReconnect, log, MAX_RECONNECT_ATTEMPTS, RECONNECT_BASE_DELAY_MS, reconnect, session } from "./online-client-stores.ts";
import { computeWsUrl } from "./online-config.ts";
import { connectWebSocket } from "./online-session.ts";
import { Mode } from "./types.ts";

/** Stashed from the first call so reconnect retries reuse it. */
let _onConnectError: (() => void) | undefined;

export function connect(onConnectError?: () => void): void {
  if (onConnectError) _onConnectError = onConnectError;
  connectWebSocket(session, computeWsUrl(), {
    onMessage: (msg) => {
      if (reconnect.attempt > 0) {
        log(`reconnected after ${reconnect.attempt} attempt(s)`);
        clearReconnect();
      }
      handleServerMessage(msg);
    },
    onClose: () => {
      const m = runtime.rs.mode;
      log(`WebSocket closed (mode=${Mode[m]} isHost=${session.isHost})`);
      if (session.isHost || m === Mode.STOPPED || m === Mode.LOBBY) return;
      if (reconnect.attempt < MAX_RECONNECT_ATTEMPTS) {
        reconnect.attempt++;
        const delay = RECONNECT_BASE_DELAY_MS * (1 << (reconnect.attempt - 1));
        runtime.rs.frame.announcement = "Reconnecting\u2026";
        runtime.render();
        log(`reconnect attempt ${reconnect.attempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
        reconnect.timer = setTimeout(() => { reconnect.timer = null; connect(); }, delay);
      } else {
        clearReconnect();
        runtime.rs.frame.announcement = "Disconnected from server";
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
