/**
 * Away watchdog — step 2 of the hidden-tab recovery story. Step 1
 * (lockstep debt, `runtime/main-loop.ts`) makes short hides safe; this
 * bounds long ones: a SEATED peer hidden past `AWAY_DISCONNECT_MS`
 * leaves cleanly, and the socket close drives the server's existing
 * PLAYER_LEFT / HOST_LEFT flow — opponents get a live AI seat (or a
 * migrated host) instead of an idle castle and stalled phase gates.
 */

import type { TimingApi } from "../runtime/timing-api.ts";

interface AwayWatchdogDeps {
  timing: Pick<TimingApi, "now" | "setTimeout" | "clearTimeout">;
  /** True when this peer currently holds a player seat in a live online
   *  match (session live AND myPlayerId is an active slot). Re-evaluated
   *  at fire/unhide time, never captured at hide time — a player hidden
   *  in the waiting room whose match starts over the socket while hidden
   *  is seated by fire time and must still be covered. Watchers stay
   *  false and are exempt: nobody waits on a watcher, their catch-up
   *  replay is bounded by match length, and a GAME_OVER received while
   *  hidden terminal-paints at receive time with no replay at all. */
  isSeatedLiveMatch: () => boolean;
  /** Clean self-disconnect (announcement + Mode.STOPPED + socket close).
   *  After it runs, `isSeatedLiveMatch` returns false, which is what
   *  re-arms the watchdog for the next match. */
  leave: () => void;
  /** Auto-rejoin on tab-return after an away-disconnect: reconnect +
   *  `rejoinRoom` (the seat the AI took over is handed back via the resync
   *  → SEAT_RECLAIM flow). Called once per away→return cycle, only when
   *  THIS watchdog drove the `leave()`. No-op-safe if rejoin is impossible
   *  (no retained token/code). */
  rejoin: () => void;
}

/** Hidden time after which a seated peer abandons its seat. Aligned with
 *  "opponents should not wait minutes": one minute of idle castle is
 *  already a degraded match; an AI takeover is strictly better. */
export const AWAY_DISCONNECT_MS = 60_000;

/** Hidden-tab timers are throttled, not dropped — worst case (1/min
 *  intensive throttling) the hidden-side leave lands a few tens of
 *  seconds late. If the tab's JS was suspended outright (mobile
 *  background) the timer never ran at all; the unhide branch backstops
 *  it, and because `visibilitychange` is delivered before the first rAF,
 *  that leave preempts what would otherwise be a giant catch-up replay. */
export function createAwayWatchdog(deps: AwayWatchdogDeps): {
  onVisibilityChange: (hidden: boolean) => void;
} {
  let hiddenAtMs: number | undefined;
  let timer: number | undefined;
  /** Set when THIS watchdog abandoned the seat (timer fire or unhide
   *  backstop). Cleared when the matching tab-return fires the rejoin —
   *  so a return after an away-disconnect re-enters exactly once. */
  let leftWhileAway = false;

  function clearTimer(): void {
    if (timer === undefined) return;
    deps.timing.clearTimeout(timer);
    timer = undefined;
  }

  function leaveAway(): void {
    leftWhileAway = true;
    deps.leave();
  }

  function fireWhileHidden(): void {
    timer = undefined;
    if (!deps.isSeatedLiveMatch()) return;
    leaveAway();
  }

  return {
    onVisibilityChange(hidden: boolean): void {
      if (hidden) {
        if (hiddenAtMs !== undefined) return;
        hiddenAtMs = deps.timing.now();
        timer = deps.timing.setTimeout(fireWhileHidden, AWAY_DISCONNECT_MS);
        return;
      }
      const hiddenForMs =
        hiddenAtMs === undefined ? 0 : deps.timing.now() - hiddenAtMs;
      hiddenAtMs = undefined;
      clearTimer();
      // Suspended-JS backstop — the hidden-side timer never got to run.
      if (hiddenForMs >= AWAY_DISCONNECT_MS && deps.isSeatedLiveMatch()) {
        leaveAway();
      }
      // Auto-rejoin (user-locked decision): a return after we abandoned the
      // seat re-enters the started room rather than sitting disconnected.
      if (leftWhileAway) {
        leftWhileAway = false;
        deps.rejoin();
      }
    },
  };
}
