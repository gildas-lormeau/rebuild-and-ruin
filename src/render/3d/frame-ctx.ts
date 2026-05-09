/**
 * Per-frame context passed to every 3D manager's `update()`. One shared
 * shape replaces what used to be bespoke positional signatures per
 * manager (`(overlay)`, `(map, overlay, now)`, etc.); each manager
 * unpacks what it needs at the top of its update. Built once per frame
 * by `renderer.ts` and forwarded verbatim. `ensureBuilt(map)` on the
 * terrain is a lifecycle call and stays outside this contract.
 */

import type { GameMap } from "../../shared/core/geometry-types.ts";
import type { RenderOverlay } from "../../shared/ui/overlay-types.ts";

export interface FrameCtx {
  readonly overlay: RenderOverlay | undefined;
  readonly map: GameMap | undefined;
  readonly now: number;
  readonly pitch: number;
  /** Battle-progress sun parameter ∈ [0, 1]. Defined only during the
   *  BATTLE phase (the runtime computes it as `1 − state.timer /
   *  BATTLE_TIMER`); `undefined` in every other phase, which switches
   *  the lighting rig to its "inactive / no shadow" stance. Drives the
   *  directional sun's arc — see `updateSunDirection` in `lights.ts`. */
  readonly sunT: number | undefined;
}
