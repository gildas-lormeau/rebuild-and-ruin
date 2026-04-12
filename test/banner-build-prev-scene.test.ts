/**
 * Build banner prev-scene: known bug documentation.
 *
 * The Build banner after Choose Upgrade auto-captures its prev-scene from
 * current state. In the browser, upgrade picks (clear_the_field, demolition)
 * and wall sweep can change walls/entities between the last rendered frame
 * and the auto-capture, causing a visual discontinuity.
 *
 * The headless runtime processes picks and banner transitions on the same
 * tick, so walls match. The e2e test (e2e-build-banner-bug.ts) catches
 * the pixel-level diff in the browser.
 *
 * This test verifies the auto-capture runs correctly (prevTerritory is
 * undefined for build-phase banners — battle territory should NOT appear).
 */

import { assert } from "@std/assert";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { createCanvasRecorder } from "./recording-canvas.ts";
import { createScenario } from "./scenario.ts";

const MAX_TICKS = 120_000;

Deno.test("build banner after upgrade has no battle territory in prev-scene", async () => {
  const recorder = createCanvasRecorder({ discardCalls: true });

  using sc = await createScenario({
    seed: 1,
    mode: "modern",
    rounds: 10,
    recorder,
    renderObserver: { terrainDrawn: () => {} },
  });

  let upgradeEnded = false;
  let buildChecked = false;
  let hasPrevCastles = false;
  let hasPrevTerritory = false;

  sc.bus.on(GAME_EVENT.BANNER_END, (ev) => {
    if (ev.text === "Choose Upgrade" && !upgradeEnded) {
      upgradeEnded = true;
    }
  });

  sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
    if (
      upgradeEnded &&
      !buildChecked &&
      ev.phase === Phase.WALL_BUILD &&
      ev.text.includes("Build")
    ) {
      const banner = sc.banner();
      hasPrevCastles = banner.prevCastles !== undefined;
      hasPrevTerritory =
        banner.prevTerritory !== undefined && banner.prevTerritory.length > 0;
      buildChecked = true;
    }
  });

  sc.runUntil(() => buildChecked, MAX_TICKS);

  assert(upgradeEnded, "Choose Upgrade banner never ended");
  assert(buildChecked, "Build banner after upgrade never started");
  assert(hasPrevCastles, "Build banner should have prevCastles (auto-captured)");
  assert(
    !hasPrevTerritory,
    "Build banner should NOT have battle territory — it causes battle-mode rendering in the build phase",
  );
});
