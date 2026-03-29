/**
 * Online mutable singletons and thin utilities.
 *
 * Every piece of online mutable state lives here so that ownership is
 * explicit and mutation is visible across the split online-client modules.
 *
 * NOTE: log() and logThrottled() are dev-only (gated by IS_DEV).
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
import { createWatcherState } from "./online-watcher-tick.ts";
import { IS_DEV } from "./platform.ts";

// ── Constants ───────────────────────────────────────────────────────
const DEV = IS_DEV;
const LOG_THROTTLE_MS = 1000;
// ── Private state ───────────────────────────────────────────────────
const _throttleTimestamps = new Map<string, number>();
// ── Singletons ──────────────────────────────────────────────────────
export const session: OnlineSession = createSession();
/** Network dedup maps — cleared on reset and host promotion. */
export const dedup: DedupMaps = createDedupMaps();
export const watcher = createWatcherState();
/** Reconnect bookkeeping — wrapped in an object so other modules can mutate.
 *  attempt=0 means no reconnection in progress; 1+ = number of attempts made so far. */
export const reconnect = {
  attempt: 0,
  timer: null as ReturnType<typeof setTimeout> | null,
};
export const MAX_RECONNECT_ATTEMPTS = 3;
export const RECONNECT_BASE_DELAY_MS = 1000;

export function logThrottled(key: string, msg: string): void {
  if (!DEV) return;
  const now = performance.now();
  const last = _throttleTimestamps.get(key) ?? 0;
  if (now - last < LOG_THROTTLE_MS) return;
  _throttleTimestamps.set(key, now);
  log(msg);
}

// ── Utilities ───────────────────────────────────────────────────────
export function log(msg: string): void {
  if (!DEV) return;
  const modeStr = session.isHost
    ? "host"
    : session.myPlayerId >= 0
      ? "player"
      : "watcher";
  console.log(`[online] (mode=${modeStr} pid=${session.myPlayerId}) ${msg}`);
}

export function send(msg: GameMessage): void {
  sendMessage(session, msg);
}

export function maybeSendAimUpdate(
  x: number,
  y: number,
  playerId?: number,
): void {
  sendAimUpdate(session, dedup, x, y, playerId);
}

/** Clear all last-sent dedup state.
 *
 *  Must be called whenever the "last sent" baseline is invalidated:
 *  - Game initialization (new game state, all phantoms stale)
 *  - Host promotion (new role, dedup keys from watcher state are meaningless)
 *  - Full-state recovery (state replaced wholesale)
 *  - Session reset (disconnected, all tracking invalid)
 *
 *  INVARIANT: dedup maps must always be checked BEFORE calling send() for
 *  phantom/aim messages. The pattern is: if key changed → send → update map.
 *  Sending without checking causes redundant network traffic; checking without
 *  resetting after state changes causes missed updates. */
export function resetDedup(): void {
  resetDedupMaps(dedup);
}

/** Zero out reconnect state — call after successful reconnect or when giving up. */
export function clearReconnect(): void {
  reconnect.attempt = 0;
  if (reconnect.timer) {
    clearTimeout(reconnect.timer);
    reconnect.timer = null;
  }
}
