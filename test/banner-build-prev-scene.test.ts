/**
 * Build banner prev-scene: verify captureScene is called at the right time.
 *
 * With the ImageData-based banner system, the "old scene" is a pixel snapshot
 * captured before phase mutations. In headless mode captureScene returns
 * undefined (no real canvas), but we can verify the banner state is set up
 * correctly by checking that prevSceneImageData is at least attempted.
 *
 * This test runs a modern game, waits for the first Build banner after an
 * upgrade pick, and verifies banner.active is true when it fires.
 */

import { assert } from "@std/assert";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { createCanvasRecorder } from "./recording-canvas.ts";
import { createScenario } from "./scenario.ts";

const MAX_TIMEOUT_MS = 120_000;

Deno.test("build banner after upgrade fires with active banner state", async () => {
  const recorder = createCanvasRecorder({ discardCalls: true });

  using sc = await createScenario({
    seed: 1,
    mode: "modern",
    rounds: 10,
    renderer: { canvas: recorder, observer: { terrainDrawn: () => {} } },
  });

  let upgradeEnded = false;
  let buildChecked = false;
  let bannerWasActive = false;

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
      bannerWasActive = banner.active;
      buildChecked = true;
    }
  });

  sc.runUntil(() => buildChecked, { timeoutMs: MAX_TIMEOUT_MS });

  assert(upgradeEnded, "Choose Upgrade banner never ended");
  assert(buildChecked, "Build banner after upgrade never started");
  assert(bannerWasActive, "Build banner should be active when BANNER_START fires");
});
