/**
 * Online mutable state — owned by a single OnlineContext instance.
 *
 * All mutable online state (session, dedup, watcher, reconnect) is bundled
 * into one context object so that ownership is explicit and visible. Utility
 * functions (devLog, send, etc.) close over the default `ctx` instance.
 *
 * NOTE: devLog() and devLogThrottled() are dev-only (gated by IS_DEV).
 * They produce no output in production builds. Do not rely on them
 * for user-visible feedback or error handling.
 */

import type { GameMessage } from "../server/protocol.ts";
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

/** Network reset scope — forces callers to declare intent, preventing
 *  accidental use of the wrong reset level. Each scope clears a different
 *  subset of networking state:
 *  - "dedup"     — mid-game phase transitions: clears dedup maps only
 *  - "new-game"  — INIT or full-state recovery: dedup + full watcher reset
 *  - "host-promotion" — host migration: dedup + watcher timing/AI (keeps
 *      remote crosshairs & phantoms the new host still needs)
 *
 *  INVARIANT: dedup maps must always be checked BEFORE calling send() for
 *  phantom/aim messages. The pattern is: if key changed → send → update map.
 *  Sending without checking causes redundant network traffic; checking without
 *  resetting after state changes causes missed updates. */
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

// ── Constants ──────────────────────────────────────────────────────
const DEV = IS_DEV;
const LOG_THROTTLE_MS = 1000;
// ── Private state ──────────────────────────────────────────────────
const _throttleTimestamps = new Map<string, number>();
export const ctx: OnlineContext = createOnlineContext();
export const MAX_RECONNECT_ATTEMPTS = 3;
export const RECONNECT_BASE_DELAY_MS = 1000;

/** Whether a reconnect cycle is currently in progress. */
export function isReconnecting(): boolean {
  return ctx.reconnect.count > 0;
}

export function devLogThrottled(key: string, msg: string): void {
  if (!DEV) return;
  const now = performance.now();
  const last = _throttleTimestamps.get(key) ?? 0;
  if (now - last < LOG_THROTTLE_MS) return;
  _throttleTimestamps.set(key, now);
  devLog(msg);
}

export function devLog(msg: string): void {
  if (!DEV) return;
  const modeStr = ctx.session.isHost
    ? "host"
    : ctx.session.onlinePlayerId >= 0
      ? "player"
      : "watcher";
  console.log(
    `[online] (mode=${modeStr} pid=${ctx.session.onlinePlayerId}) ${msg}`,
  );
}

export function send(msg: GameMessage): void {
  sendMessage(ctx.session, msg);
}

export function maybeSendAimUpdate(
  x: number,
  y: number,
  playerId?: number,
): void {
  sendAimUpdate(ctx.session, ctx.dedup, x, y, playerId);
}

/** Reset networking state for the given scope. */
export function resetNetworking(scope: ResetScope): void {
  resetDedupMaps(ctx.dedup);
  if (scope === "new-game") {
    resetWatcherState(ctx.watcher);
  } else if (scope === "host-promotion") {
    resetWatcherTimingForHostPromotion(ctx.watcher);
  }
}

/** Zero out reconnect state — call after successful reconnect or when giving up. */
export function clearReconnect(): void {
  ctx.reconnect.count = 0;
  if (ctx.reconnect.timer) {
    clearTimeout(ctx.reconnect.timer);
    ctx.reconnect.timer = null;
  }
}

function createOnlineContext(): OnlineContext {
  return {
    session: createSession(),
    dedup: createDedupMaps(),
    watcher: createWatcherState(),
    reconnect: { count: 0, timer: null },
  };
}
