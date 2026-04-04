/**
 * Online client factory and default instance.
 *
 * `createOnlineClient()` builds a fully isolated client — each instance owns
 * its own OnlineContext (session, dedup, watcher, reconnect) and utility
 * closures (send, devLog, etc.).  `defaultClient` is the singleton used by
 * the online runtime; consumers receive it via init injection or direct import.
 *
 * NOTE: devLog() and devLogThrottled() are dev-only (gated by IS_DEV).
 * They produce no output in production builds. Do not rely on them
 * for user-visible feedback or error handling.
 */

import type { GameMessage } from "../../server/protocol.ts";
import { IS_DEV } from "../shared/platform.ts";
import { isActivePlayer, type ValidPlayerSlot } from "../shared/player-slot.ts";
import { isHostInContext } from "../shared/tick-context.ts";
import {
  createDedupMaps,
  createSession,
  type DedupMaps,
  type OnlineSession,
  resetDedupMaps,
  resetSessionState,
  sendAimUpdate,
  sendMessage,
} from "./online-session.ts";
import {
  createWatcherState,
  resetWatcherState,
  resetWatcherTimingForHostPromotion,
  type WatcherState,
} from "./online-watcher-tick.ts";

type ResetScope = "dedup" | "new-game" | "host-promotion";

interface OnlineContext {
  readonly session: OnlineSession;
  readonly dedup: DedupMaps;
  readonly watcher: WatcherState;
  readonly reconnect: {
    count: number;
    timer: ReturnType<typeof setTimeout> | null;
  };
}

export interface OnlineClient {
  readonly ctx: OnlineContext;
  send(msg: GameMessage): void;
  maybeSendAimUpdate(x: number, y: number, playerId?: number): void;
  resetNetworking(scope: ResetScope): void;
  clearReconnect(): void;
  devLog(msg: string): void;
  devLogThrottled(key: string, msg: string): void;
  isReconnecting(): boolean;
  /** Tear down networking state: cancel reconnect timers, close the socket,
   *  and reset session + dedup maps.  Caller handles runtime-level cleanup. */
  destroy(): void;
}

// ── Constants ──────────────────────────────────────────────────────
const DEV = IS_DEV;
const LOG_THROTTLE_MS = 1000;
/** Network reset scope — forces callers to declare intent, preventing
 *  accidental use of the wrong reset level. Each scope clears a different
 *  subset of networking state:
 *  - "dedup"     — mid-game phase transitions: clears dedup maps only
 *  - "new-game"  — INIT or full-state recovery: dedup + full watcher reset
 *  - "host-promotion" — host migration: dedup + watcher timing/AI (keeps
 *      remote crosshairs & phantoms the new host still needs)
 *
 *  INVARIANT: dedup maps must always be checked BEFORE calling send() for
 *  phantom/aim messages. The pattern is: if shouldSend() -> send (map updated atomically).
 *  Sending without checking causes redundant network traffic; checking without
 *  resetting after state changes causes missed updates. */
// ── Default instance ───────────────────────────────────────────────
export const defaultClient = createOnlineClient();
export const RESET_SCOPE_NEW_GAME = "new-game";
export const RESET_SCOPE_HOST_PROMOTION = "host-promotion";
export const MAX_RECONNECT_ATTEMPTS = 3;
export const RECONNECT_BASE_DELAY_MS = 1000;

function createOnlineClient(): OnlineClient {
  const context: OnlineContext = {
    session: createSession(),
    dedup: createDedupMaps(),
    watcher: createWatcherState(),
    reconnect: { count: 0, timer: null },
  };
  const throttleTimestamps = new Map<string, number>();

  function clientDevLog(msg: string): void {
    if (!DEV) return;
    const modeStr = isHostInContext(context.session)
      ? "host"
      : isActivePlayer(context.session.myPlayerId)
        ? "player"
        : "watcher";
    console.log(
      `[online] (mode=${modeStr} pid=${context.session.myPlayerId}) ${msg}`,
    );
  }

  const client: OnlineClient = {
    ctx: context,
    send: (msg) => sendMessage(context.session, msg),
    maybeSendAimUpdate: (x, y, playerId?) =>
      sendAimUpdate(
        context.session,
        context.dedup,
        x,
        y,
        playerId as ValidPlayerSlot | undefined,
      ),
    resetNetworking: (scope) => {
      resetDedupMaps(context.dedup);
      if (scope === "new-game") {
        resetWatcherState(context.watcher);
      } else if (scope === "host-promotion") {
        resetWatcherTimingForHostPromotion(context.watcher);
      }
    },
    clearReconnect: () => {
      context.reconnect.count = 0;
      if (context.reconnect.timer) {
        clearTimeout(context.reconnect.timer);
        context.reconnect.timer = null;
      }
    },
    devLog: clientDevLog,
    devLogThrottled: (key, msg) => {
      if (!DEV) return;
      const now = performance.now();
      const last = throttleTimestamps.get(key) ?? 0;
      if (now - last < LOG_THROTTLE_MS) return;
      throttleTimestamps.set(key, now);
      clientDevLog(msg);
    },
    isReconnecting: () => context.reconnect.count > 0,
    destroy: () => {
      client.clearReconnect();
      resetSessionState(context.session);
      client.resetNetworking("new-game");
    },
  };
  return client;
}
