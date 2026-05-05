import { assert } from "@std/assert";
import { SELECT_ANNOUNCEMENT_DURATION } from "../src/shared/core/game-constants.ts";
import { MAP_PX_W } from "../src/shared/core/grid.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import type { ValidPlayerSlot } from "../src/shared/core/player-slot.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";
import { createScenario } from "./scenario.ts";

Deno.test(
  "selection zoom: mobile auto-zoom engages once the selection announcement ends",
  async () => {
    using sc = await createScenario({
      seed: 42,
      assistedSlots: [0 as ValidPlayerSlot],
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

    // Drive past the "Select your home castle" announcement, plus a small
    // margin so handleSelectionZoom + viewport lerp have a chance to fire.
    const framesToDrive = Math.ceil(
      (SELECT_ANNOUNCEMENT_DURATION + 1) * 60,
    );
    sc.tick(framesToDrive);

    const vp = sc.camera.getViewport();
    assert(
      vp !== undefined && vp.w < MAP_PX_W,
      `expected a cropped viewport (w < ${MAP_PX_W}) after announcement, got ${JSON.stringify(vp)}`,
    );
  },
);
