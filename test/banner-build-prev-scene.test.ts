/**
 * Build banner prev-scene: verify the banner becomes active during the
 * build-banner-after-upgrade chain (smoke test — headless runs return
 * undefined from captureScene, so we can only verify state plumbing,
 * not pixels). The tick-fenced `SceneCapture` contract is exercised at
 * runtime wherever a renderer is present.
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

  // The "Choose Upgrade" banner is cleared when the "Build & Repair"
  // banner overwrites it → fires BANNER_REPLACED, not BANNER_HIDDEN.
  sc.bus.on(GAME_EVENT.BANNER_REPLACED, (ev) => {
    if (ev.prevText === "Choose Upgrade" && !upgradeEnded) {
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
      bannerWasActive = banner.status !== "hidden";
      buildChecked = true;
    }
  });

  sc.runUntil(() => buildChecked, { timeoutMs: MAX_TIMEOUT_MS });

  assert(upgradeEnded, "Choose Upgrade banner never ended");
  assert(buildChecked, "Build banner after upgrade never started");
  assert(bannerWasActive, "Build banner should be active when BANNER_START fires");
});
