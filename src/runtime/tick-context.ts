/**
 * Shared types/utilities for phase+battle ticks (split from phase-ticks).
 * Per-frame mutation order is APPLY (remote msgs, 0..N) → TICK (sim, once)
 * → CHECKPOINT (phase-change reset, at most once); reordering = silent
 * bugs. Phase terms are distinct: "done" = query (isXPhaseDone), "finalize"
 * = cleanup action, "ended" = callback signal. Composite finalize fns own
 * sub-step ordering — never call sub-steps directly.
 */

import { GRUNT_TICK_INTERVAL } from "../shared/core/game-constants.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import {
  isPlayerEliminated,
  type Player,
} from "../shared/core/player-types.ts";
import type { ControllerIdentity } from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";

/** Base networking context shared by all phase ticks.
 *  VOLATILE: `isHost` can flip mid-session during host promotion.
 *  Always read inline — never cache in a local variable across ticks. */
interface HostNetContext {
  /** Non-local player slots. See OnlineSession.remotePlayerSlots for full docs. */
  remotePlayerSlots: ReadonlySet<ValidPlayerId>;
  isHost: boolean;
}

/** True if this client is the host. Defaults to true when net is omitted (local play).
 *  VOLATILE: result can change between frames (host promotion). Never cache. */
export function isHostInContext(net?: Pick<HostNetContext, "isHost">): boolean {
  // eslint-disable-next-line no-restricted-syntax -- canonical implementation
  return net?.isHost ?? true;
}

/** Decay a persistent-announcement timer and surface its text into the frame.
 *
 *  Two announcement channels co-exist:
 *    1. `frame.announcement` — general-purpose, set directly per-frame
 *       (battle countdown, "Reconnecting…"). Cleared each frame by
 *       clearFrameData().
 *    2. A persistent `{ timer, text }` slot — survives frame clears, used
 *       for messages that must remain on screen for a fixed duration
 *       (e.g. host-migration announcement).
 *
 *  This helper bridges (2) → (1) without overwriting an existing per-frame
 *  announcement (so a Ready/Aim/Fire countdown beats the persistent text).
 *  When the timer expires, the slot self-clears. */
export function tickPersistentAnnouncement(
  banner: { timer: number; text: string },
  frame: { announcement?: string },
  dt: number,
): void {
  if (banner.timer <= 0) return;
  banner.timer -= dt;
  if (banner.timer > 0) {
    if (!frame.announcement) {
      frame.announcement = banner.text;
    }
  } else {
    banner.timer = 0;
    banner.text = "";
  }
}

/** Advance a phase timer: accum += dt, state.timer = max - accum.
 *  INVARIANT: All phase timers MUST use this function. Never manually write `accum.X += dt`.
 *
 *  This is the ONLY correct way to advance phase timers. It mutates both
 *  `accum` and `state.timer` atomically so they can't drift out of sync.
 *  Separate mutations silently break the `timer = max - elapsed` invariant
 *  with no compile error.
 *  @param dt — Delta time in SECONDS (not ms). All tick functions use seconds. */
export function advancePhaseTimer<K extends string>(
  accum: Record<K, number>,
  key: K,
  state: { timer: number },
  dt: number,
  max: number,
): void {
  const elapsed = (accum[key] += dt);
  state.timer = Math.max(0, max - elapsed);
}

/** Advance grunt accumulator and step grunts when the interval elapses.
 *  Used by the build-phase tick (which runs identically on every peer
 *  under clone-everywhere); the accumulator carries the sub-interval
 *  remainder to prevent interval drift.
 *
 *  lint:allow-callback-inversion -- scheduler: moveGrunts is invoked on
 *  interval; receiver doesn't read return value to drive its logic. */
export function tickGruntsIfDue(
  accum: { grunt: number },
  dt: number,
  state: GameState,
  moveGrunts: (state: GameState) => void,
): void {
  accum.grunt += dt;
  if (accum.grunt >= GRUNT_TICK_INTERVAL) {
    accum.grunt -= GRUNT_TICK_INTERVAL;
    moveGrunts(state);
  }
}

/** Filter controllers to only local (non-remote) players.
 *  Does NOT filter eliminated players — game systems (fire, placePiece, etc.)
 *  self-guard against eliminated players at the mutation boundary. */
export function localControllers<
  T extends ControllerIdentity = ControllerIdentity,
>(
  controllers: readonly T[],
  remotePlayerSlots: ReadonlySet<ValidPlayerId>,
): T[] {
  return controllers.filter(
    (ctrl) => !isRemotePlayer(ctrl.playerId, remotePlayerSlots),
  );
}

/** Filter controllers to local (non-remote) players that are NOT
 *  eliminated — the upfront-skip variant of `localControllers` for the
 *  phase ticks that must never drive a dead slot's controller. Unlike
 *  `localControllers` (which deliberately keeps eliminated slots so game
 *  systems self-guard at the mutation boundary), callers of this helper
 *  want both predicates rolled into one place. */
export function localActiveControllers<
  T extends ControllerIdentity = ControllerIdentity,
>(
  controllers: readonly T[],
  remotePlayerSlots: ReadonlySet<ValidPlayerId>,
  players: readonly Player[],
): T[] {
  return controllers.filter(
    (ctrl) =>
      !isRemotePlayer(ctrl.playerId, remotePlayerSlots) &&
      !isPlayerEliminated(players[ctrl.playerId]),
  );
}

/** True if this player slot is controlled by a remote human (not local).
 *  Use this instead of inline `remotePlayerSlots.has(pid)` to make intent explicit. */
export function isRemotePlayer(
  playerId: ValidPlayerId,
  remotePlayerSlots: ReadonlySet<ValidPlayerId>,
): boolean {
  return remotePlayerSlots.has(playerId);
}
