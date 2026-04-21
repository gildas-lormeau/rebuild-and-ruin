/**
 * Per-frame context passed to every 3D manager's `update()`.
 *
 * Before V1 Phase A / task A4, each manager's `update` took a bespoke
 * positional signature — some needed `(overlay)`, some `(overlay, map)`,
 * some `(map, overlay, now)`, and the tower/house/debris managers even
 * took pre-extracted slices of the map (`readonly Tower[]` /
 * `readonly House[]`). That made `renderer.ts`'s draw loop a
 * parameter-juggling exercise and kept the call order coupled to each
 * manager's argument list.
 *
 * One shared context replaces the whole lot: every manager accepts a
 * single `FrameCtx` and unpacks what it needs at the top of its
 * update. Callers (currently only `renderer.ts`) build the ctx once per
 * frame and hand it to every manager verbatim.
 *
 * `ensureBuilt(map)` on the terrain stays outside this contract — it's a
 * lifecycle call, not a per-frame update.
 */

import type { GameMap } from "../../shared/core/geometry-types.ts";
import type { RenderOverlay } from "../../shared/ui/overlay-types.ts";

export interface FrameCtx {
  readonly overlay: RenderOverlay | undefined;
  readonly map: GameMap | undefined;
  readonly now: number;
}
