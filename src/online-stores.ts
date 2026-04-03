/**
 * Online mutable state — owned by a single OnlineClient instance.
 *
 * All mutable online state (session, dedup, watcher, reconnect) is bundled
 * into one context object so that ownership is explicit and visible.
 *
 * `createOnlineClient()` builds a fully isolated client — each instance owns
 * its own OnlineContext and utility closures.  A default instance is created
 * at module scope; the thin bridge exports (`ctx`, `send`, `devLog`, ...)
 * delegate to it so that existing consumers work unchanged (Phase 1).
 *
 * NOTE: devLog() and devLogThrottled() are dev-only (gated by IS_DEV).
 * They produce no output in production builds. Do not rely on them
 * for user-visible feedback or error handling.
 */

import type { GameMessage } from "../server/protocol.ts";
import { isActivePlayer, type ValidPlayerSlot } from "./game-constants.ts";
import {
  createDedupMaps,
  createSession,
  type DedupMaps,
  type OnlineSession,
  resetDedupMaps,
  sendAimUpdate,
  sendMessage,
} from "./online-session.ts";
import {
  createWatcherState,
  resetWatcherState,
  resetWatcherTimingForHostPromotion,
  type WatcherState,
} from "./online-watcher-tick.ts";
import { IS_DEV } from "./platform.ts";
import { isHostInContext } from "./tick-context.ts";

type ResetScope =
  | typeof RESET_SCOPE_DEDUP
  | typeof RESET_SCOPE_NEW_GAME
  | typeof RESET_SCOPE_HOST_PROMOTION;

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
}

// ── Constants ──────────────────────────────────────────────────────
const DEV = IS_DEV;
const LOG_THROTTLE_MS = 1000;
// ── Default instance & module-scope bridge ─────────────────────────
// Consumers still `import { ctx, send, ... } from "./online-stores.ts"`.
// Phase 2 will inject the client directly; Phase 3 removes this bridge.
export const defaultClient = createOnlineClient();
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
export const RESET_SCOPE_DEDUP = "dedup" as const;
export const RESET_SCOPE_NEW_GAME = "new-game" as const;
export const RESET_SCOPE_HOST_PROMOTION = "host-promotion" as const;
export const MAX_RECONNECT_ATTEMPTS = 3;
export const RECONNECT_BASE_DELAY_MS = 1000;
export const ctx = defaultClient.ctx;

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

  return {
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
  };
}

export function isReconnecting(): boolean {
  return defaultClient.isReconnecting();
}

export function devLogThrottled(key: string, msg: string): void {
  defaultClient.devLogThrottled(key, msg);
}

export function devLog(msg: string): void {
  defaultClient.devLog(msg);
}

export function send(msg: GameMessage): void {
  defaultClient.send(msg);
}

export function maybeSendAimUpdate(
  x: number,
  y: number,
  playerId?: number,
): void {
  defaultClient.maybeSendAimUpdate(x, y, playerId);
}

/** Reset networking state for the given scope. */
export function resetNetworking(scope: ResetScope): void {
  defaultClient.resetNetworking(scope);
}

/** Zero out reconnect state — call after successful reconnect or when giving up. */
export function clearReconnect(): void {
  defaultClient.clearReconnect();
}
