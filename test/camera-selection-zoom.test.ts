import { assert } from "@std/assert";
import { SELECT_ANNOUNCEMENT_DURATION } from "../src/shared/core/game-constants.ts";
import { MAP_PX_W } from "../src/shared/core/grid.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";
import { createScenario } from "./scenario.ts";

Deno.test(
  "selection zoom: mobile auto-zoom engages once the selection announcement ends",
  async () => {
    using sc = await createScenario({
      seed: 42,
      assistedSlots: [0 as ValidPlayerId],
      mobileZoomEnabled: true,
    });

    assert(
      sc.state.phase === Phase.CASTLE_SELECT,
      `expected CASTLE_SELECT, got ${Phase[sc.state.phase]}`,
    );
    assert(sc.mode() === Mode.SELECTION, `expected SELECTION mode`);
    assert(
      sc.camera.isMobileAutoZoom(),
      "mobile auto-zoom must be active (assistedSlots[0] is human + mobileZoomEnabled)",
    );

    // Wait for the auto-zoom to crop the viewport once the "Select your
    // home castle" announcement ends and handleSelectionZoom + the viewport
    // lerp engage. Budget covers the announcement plus a margin.
    sc.runUntil(
      () => {
        const vp = sc.camera.getViewport();
        return vp !== undefined && vp.w < MAP_PX_W;
      },
      { timeoutMs: (SELECT_ANNOUNCEMENT_DURATION + 2) * 1000 },
    );

    const vp = sc.camera.getViewport();
    assert(
      vp !== undefined && vp.w < MAP_PX_W,
      `expected a cropped viewport (w < ${MAP_PX_W}) after announcement, got ${JSON.stringify(vp)}`,
    );
  },
);
