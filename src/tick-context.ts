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

/** Extract remote human slots from optional net context, defaulting to empty for local play. */
export function getRemoteSlots(net?: Pick<HostNetContext, "remoteHumanSlots">): ReadonlySet<number> {
  return net?.remoteHumanSlots ?? EMPTY_TILE_SET;
}

/** Filter controllers to only local (non-remote) players that are still alive. */
export function localActiveControllers(
  controllers: readonly PlayerController[],
  remoteHumanSlots: ReadonlySet<number>,
  state: GameState,
): PlayerController[] {
  return controllers.filter(
    ctrl => !remoteHumanSlots.has(ctrl.playerId) && !state.players[ctrl.playerId]?.eliminated,
  );
}
