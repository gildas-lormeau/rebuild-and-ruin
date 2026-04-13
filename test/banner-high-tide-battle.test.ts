/**
 * High-tide battle banner: verify the banner fires after the modifier.
 *
 * With the ImageData-based banner system, the "old scene" is captured as
 * pixels before modifier tile mutations. The chained "Prepare for Battle"
 * banner inherits the same ImageData (captured before the modifier applied),
 * so it naturally shows pre-mutation terrain below the sweep line.
 *
 * This test verifies the sequencing: high_tide modifier banner fires first,
 * then the battle banner chains in, and both complete successfully.
 */

import { assert } from "@std/assert";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { createCanvasRecorder } from "./recording-canvas.ts";
import { createScenario } from "./scenario.ts";

const MAX_TICKS = 120_000;

Deno.test("battle banner chains after high_tide modifier banner", async () => {
  const recorder = createCanvasRecorder({ discardCalls: true });

  using sc = await createScenario({
    seed: 1,
    mode: "modern",
    rounds: 10,
    renderer: { canvas: recorder, observer: { terrainDrawn: () => {} } },
  });

  let highTideChangedTiles: readonly number[] = [];
  let modifierBannerText: string | null = null;
  let modifierBannerEnded = false;

  sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
    if (ev.modifierId === "high_tide" && modifierBannerText === null) {
      modifierBannerText = ev.text;
      highTideChangedTiles = ev.changedTiles ?? [];
    }
  });
  sc.bus.on(GAME_EVENT.BANNER_END, (ev) => {
    if (
      modifierBannerText !== null &&
      !modifierBannerEnded &&
      ev.text === modifierBannerText
    ) {
      modifierBannerEnded = true;
    }
  });

  let battleBannerEnded = false;

  sc.bus.on(GAME_EVENT.BANNER_END, (ev) => {
    if (
      modifierBannerEnded &&
      !battleBannerEnded &&
      ev.text.includes("Battle")
    ) {
      battleBannerEnded = true;
    }
  });

  sc.runUntil(() => battleBannerEnded, MAX_TICKS);

  assert(
    modifierBannerEnded,
    "high_tide modifier banner never fired within 10 rounds",
  );
  assert(
    highTideChangedTiles.length > 0,
    "high_tide reported no changedTiles",
  );
  assert(battleBannerEnded, "battle banner after high_tide never ended");
});
