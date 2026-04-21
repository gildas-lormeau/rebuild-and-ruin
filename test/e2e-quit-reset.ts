/**
 * E2E: quitting a mobile game must disable auto-zoom for the all-AI
 * game the lobby auto-starts ~15s later.
 *
 * Reproduces the user-reported symptom: "auto-zoom active during
 * the game played by AIs after the max. 15s on the lobby screen"
 * (after pressing ✕ / ESC in a prior game). Drives the full browser
 * stack under mobile emulation — so `IS_TOUCH_DEVICE` is true,
 * `setupTouchControls` fires, and `camera.enableMobileZoom` is
 * called the same way a real phone would call it. The headless
 * reset test (`scenario.test.ts`) covers the in-process invariants;
 * this one catches DOM-/renderer-path leaks that only appear in a
 * real browser.
 *
 * Repro (per user): play ~20s of a mobile game, press ESC twice to
 * quit, wait another 20s for the lobby to auto-start a new all-AI
 * game — at around the 40s mark, the all-AI game's camera should
 * NOT be zoomed but (before this fix) is.
 *
 * Run: `deno run -A scripts/online-e2e.ts local` with `npm run dev`
 * in another tab.
 */

import { assert } from "@std/assert";
import { createE2EScenario, waitForPhase } from "./e2e-scenario.ts";
import { Phase } from "../src/shared/core/game-phase.ts";

Deno.test(
  "e2e mobile: ESC quit disables auto-zoom for the next all-AI game",
  async () => {
    await using sc = await createE2EScenario({
      seed: 42,
      humans: 0,
      headless: true,
      rounds: 2,
      mobile: true,
    });

    // Sanity: mobile emulation flipped the touch flag, which in turn
    // ran `setupTouchControls` → `camera.enableMobileZoom()`. Without
    // this, `mobileZoomEnabled` stays false and the bug can't
    // manifest.
    const cam = await sc.camera.state();
    assert(
      cam.autoZoomOn,
      "mobile emulation should have enabled auto-zoom via setupTouchControls",
    );

    // Play the first game to battle so camera state gets mutated
    // (zone zoom during cannon/build phases, battle tilt).
    await waitForPhase(sc, Phase.BATTLE, { timeoutMs: 60_000 });

    // Quit via ESC. First press arms the "press again" warning (2s
    // grace window); the second press within that window actually
    // commits the quit. Matches both the keyboard ESC flow and the
    // touch ✕ button flow — they share `dispatchQuit`.
    await sc.input.pressKey("Escape");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await sc.input.pressKey("Escape");

    // Let the lobby's 15s countdown elapse + a little margin for the
    // new game to reach its first interactive phase. The lobby's
    // auto-start (`onTickLobbyExpired`) bootstraps a fresh all-AI
    // game because nobody joined any slot.
    await waitForPhase(sc, Phase.BATTLE, { timeoutMs: 60_000 });

    // Poll camera state across the post-quit all-AI game's battle
    // phase. A single snapshot might miss a transient zoom, so we
    // sample for a few seconds. Any cameraZone / pitch / cropped
    // viewport is a leak: no human → no zoom.
    let sawCameraZone = false;
    let sawPitch = false;
    let sawCroppedViewport = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const snap = await sc.camera.state();
      if (snap.cameraZone !== undefined) sawCameraZone = true;
      if (snap.pitch !== 0) sawPitch = true;
      if (snap.hasViewport) sawCroppedViewport = true;
      if (sawCameraZone || sawCroppedViewport) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    assert(
      !sawCameraZone,
      "no human → no cameraZone; the post-quit all-AI game must not auto-zoom",
    );
    assert(
      !sawPitch,
      "no human → no battle tilt; the post-quit all-AI game must not pitch",
    );
    assert(
      !sawCroppedViewport,
      "no human → no cropped viewport; camera must stay at fullMapVp",
    );
  },
);
