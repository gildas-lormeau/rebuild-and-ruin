/** Shared types and utilities for online multiplayer sub-modules. */

import type { PixelPos } from "../shared/core/geometry-types.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";

/** Latest aim-update target per remote-human player (raw, not smoothed).
 *  Phantoms are written directly onto each remote-controlled slot's
 *  controller (`current{Build,Cannon}Phantom(s)`) by the inbound network
 *  handler, so they don't need a parallel slot here.
 *  Defined here (lower layer) so both "online infrastructure" and "online
 *  logic" consumers can reference it without importing the higher-layer
 *  presence module. */
export interface RemoteCrosshairTargets {
  remoteCrosshairs: Map<ValidPlayerId, PixelPos>;
}
