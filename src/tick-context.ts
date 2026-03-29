/**
 * Shared types and utilities for phase/battle tick functions.
 *
 * Extracted from phase-ticks.ts so that battle-ticks.ts can import
 * without creating a peer dependency on phase-ticks.
 */

import type { PlayerController } from "./controller-interfaces.ts";
import { EMPTY_TILE_SET } from "./spatial.ts";
import type { GameState } from "./types.ts";

/** Base networking context shared by all phase ticks. */
export interface HostNetContext {
  remoteHumanSlots: ReadonlySet<number>;
  isHost: boolean;
}

/** Empty set used as default when no remote players exist (local play).
 *  Reuses the frozen EMPTY_TILE_SET sentinel from spatial.ts (both are Set<number>). */
const NO_REMOTE_SLOTS: ReadonlySet<number> = EMPTY_TILE_SET;

/** True if this client is the host. Defaults to true when net is omitted (local play). */
export function isHostInContext(net?: Pick<HostNetContext, "isHost">): boolean {
  return net?.isHost ?? true;
}

/** Extract remote human slots from optional net context, defaulting to empty for local play. */
export function getRemoteSlots(
  net?: Pick<HostNetContext, "remoteHumanSlots">,
): ReadonlySet<number> {
  return net?.remoteHumanSlots ?? NO_REMOTE_SLOTS;
}

/** Advance an accumulator timer: adds dt, returns the new accumulator value
 *  and clamped countdown timer (`max - elapsed`, clamped to 0).
 *  Callers destructure as: `({ accum: accum.X, timer: state.timer } = tickTimer(...))`.
 *  The returned `timer` counts DOWN — 0 means phase time expired. */
export function tickTimer(
  accum: number,
  dt: number,
  max: number,
): { accum: number; timer: number } {
  const newAccum = accum + dt;
  return { accum: newAccum, timer: Math.max(0, max - newAccum) };
}

/** Filter controllers to only local (non-remote) players that are still alive. */
export function localActiveControllers(
  controllers: readonly PlayerController[],
  remoteHumanSlots: ReadonlySet<number>,
  state: GameState,
): PlayerController[] {
  return controllers.filter(
    (ctrl) =>
      !remoteHumanSlots.has(ctrl.playerId) &&
      !state.players[ctrl.playerId]?.eliminated,
  );
}
