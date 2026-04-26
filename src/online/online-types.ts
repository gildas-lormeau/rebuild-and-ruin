/** Shared types and utilities for online multiplayer sub-modules. */

import { CannonMode } from "../shared/core/battle-types.ts";
import { CANNON_MODE_IDS } from "../shared/core/cannon-mode-defs.ts";
import type { PixelPos } from "../shared/core/geometry-types.ts";

/** Subset of watcher state containing network-received data (crosshairs).
 *  Phantoms are written directly onto each remote-controlled slot's
 *  controller (`current{Build,Cannon}Phantom(s)`) by the inbound network
 *  handler, so they don't need a parallel slot here.
 *  Defined here (L10) so both "online infrastructure" and "online logic" consumers
 *  can reference it without importing from the higher-layer watcher module. */
export interface WatcherNetworkState {
  remoteCrosshairs: Map<number, PixelPos>;
}

/** Parse a string as a CannonMode, defaulting to NORMAL if invalid. */
export function toCannonMode(value: string | undefined): CannonMode {
  if (value && (CANNON_MODE_IDS as ReadonlySet<string>).has(value))
    return value as CannonMode;
  return CannonMode.NORMAL;
}
