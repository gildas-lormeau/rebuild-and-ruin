/**
 * High-tide battle banner: verify the banner fires after the modifier.
 *
 * With the ImageData-based banner system, each banner captures its own
 * prev-scene at `showBanner` time. The "Prepare for Battle" banner that
 * follows the modifier-reveal banner captures post-modifier pixels as
 * its A snapshot, then forces a render and captures its B — reflecting
 * the post-mutation terrain on both sides of its sweep.
 *
 * This test verifies the sequencing: high_tide modifier banner fires
 * first, then the battle banner runs next, and both complete successfully.
 */

import { assert } from "@std/assert";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { createCanvasRecorder } from "./recording-canvas.ts";
import { loadSeed } from "./scenario.ts";

/** Generous sim-time budget — high_tide fires on a late round for the
 *  seed registry's entry, and we need another battle cycle after it. */
const MAX_TIMEOUT_MS = 1_200_000;

Deno.test("battle banner follows high_tide modifier banner", async () => {
  const recorder = createCanvasRecorder({ discardCalls: true });

  using sc = await loadSeed("modifier:high_tide", {
    renderer: { canvas: recorder, observer: { terrainDrawn: () => {} } },
  });

  let highTideApplied = false;
  let modifierBannerText: string | null = null;
  let modifierBannerEnded = false;

  // Modifier metadata moved from BANNER_START to the dedicated
  // MODIFIER_APPLIED event. Watch that for the tile-change payload, and
  // watch BANNER_START separately to pick up the banner text.
  sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
    if (ev.modifierId === "high_tide") highTideApplied = true;
  });
  sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
    if (highTideApplied && modifierBannerText === null) {
      modifierBannerText = ev.text;
    }
  });
  // Modifier banner ends either when the next Battle banner overwrites
  // it (BANNER_REPLACED) or via BANNER_HIDDEN on a direct hideBanner
  // path. Watch both to stay robust to tuning changes.
  sc.bus.on(GAME_EVENT.BANNER_HIDDEN, (ev) => {
    if (
      modifierBannerText !== null &&
      !modifierBannerEnded &&
      ev.text === modifierBannerText
    ) {
      modifierBannerEnded = true;
    }
  });
  sc.bus.on(GAME_EVENT.BANNER_REPLACED, (ev) => {
    if (
      modifierBannerText !== null &&
      !modifierBannerEnded &&
      ev.prevText === modifierBannerText
    ) {
      modifierBannerEnded = true;
    }
  });

  let battleBannerEnded = false;

  sc.bus.on(GAME_EVENT.BANNER_HIDDEN, (ev) => {
    if (
      modifierBannerEnded &&
      !battleBannerEnded &&
      ev.text.includes("Battle")
    ) {
      battleBannerEnded = true;
    }
  });
  sc.bus.on(GAME_EVENT.BANNER_REPLACED, (ev) => {
    if (
      modifierBannerEnded &&
      !battleBannerEnded &&
      ev.prevText.includes("Battle")
    ) {
      battleBannerEnded = true;
    }
  });

  sc.runUntil(() => battleBannerEnded, { timeoutMs: MAX_TIMEOUT_MS });

  assert(
    highTideApplied,
    "high_tide modifier never fired within the budget",
  );
  assert(
    modifierBannerEnded,
    "high_tide modifier banner never ended within 10 rounds",
  );
  assert(battleBannerEnded, "battle banner after high_tide never ended");
});
