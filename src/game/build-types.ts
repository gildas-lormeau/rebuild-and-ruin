/**
 * Type home for the build/repair phase contracts.
 *
 * `PlacementContext` lives here, not beside `buildPlacementContext` in
 * `build-system.ts`: six AI modules take it as a parameter type and two
 * need nothing else from that module, so homing it in the implementation
 * pinned the whole `ai-*-types` chain to build-system's import depth.
 */

import type { Player } from "../shared/core/player-types.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";

/** Per-player invariants used by `canPlacePiece`. Build once via
 *  `buildPlacementContext` outside a candidate loop and pass it into every
 *  iteration to skip the upgrade-registry walks done per call. */
export interface PlacementContext {
  readonly player: Player;
  readonly zone: ZoneId | undefined;
  readonly overlapAllowance: number;
  readonly allowPitOverlap: boolean;
  readonly allowGruntOverlap: boolean;
}
