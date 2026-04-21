/**
 * E2E: quitting a mobile game must disable auto-zoom for the all-AI
 * game the lobby auto-starts after.
 *
 * Reproduces the user-reported symptom: "auto-zoom active during
 * the game played by AIs after the max. 15s on the lobby screen"
 * (after pressing ESC / ✕ in a prior mobile game). Drives the full
 * browser stack under mobile emulation — `IS_TOUCH_DEVICE` true,
 * `setupTouchControls` fires, `camera.enableMobileZoom` fires from
 * the runtime the same way a real phone triggers it.
 *
 * Repro (per user, paraphrased):
 *   1. Launch the game with mobile emulation.
 *   2. Wait 5 s.
 *   3. Press "action" (join slot 0) — starts a human-joined game.
 *   4. Wait for a game event (a banner / phase start).
 *   5. Press ESC twice — quit to lobby.
 *   6. Wait 20 s — the lobby's 15 s timer expires and auto-starts
 *      a fresh all-AI game (nobody joined during the countdown).
 *   7. Wait for a game event in the AI-only game.
 *   8. Check the camera — it must NOT be auto-zoomed.
 *
 * Run: `deno run -A scripts/online-e2e.ts local` with `npm run dev`
 * in another tab.
 */

import { assert } from "@std/assert";
import {
  createE2EScenario,
  GAME_EVENT,
  waitForPhase,
} from "./e2e-scenario.ts";
import { Phase } from "../src/shared/core/game-phase.ts";

Deno.test(
  "e2e mobile: ESC-quit leaves camera unzoomed in the next all-AI game",
  async () => {
    await using sc = await createE2EScenario({
      seed: 42,
      humans: 0, // skip auto-join — we join manually below
      autoStartGame: false, // stay in the lobby so we can drive it
      headless: true,
      rounds: 2,
      mobile: true,
    });

    // 1. Mobile emulation should have flipped `mobileZoomEnabled` on
    //    the camera via `setupTouchControls` (touch device path).
    const initialCam = await sc.camera.state();
    assert(
      initialCam.autoZoomOn,
      "mobile emulation should have enabled auto-zoom via setupTouchControls",
    );

    // 2. Wait 5 s on the lobby screen (matches the user's repro pace —
    //    they don't tap immediately).
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    // 3. Press "action" to join slot 0. On mobile (`IS_TOUCH_DEVICE`
    //    true), `onLobbyJoin` short-circuits the lobby timer and
    //    starts the game immediately — same as tapping a slot.
    await sc.input.pressKey("n");

    // 4. Wait for the first in-game event (banner or phase start).
    await waitForPhase(sc, Phase.BATTLE, { timeoutMs: 60_000 });

    // 5. Press ESC twice to quit. First press arms the warning;
    //    second press within the 2 s window confirms. Same path as
    //    the touch ✕ button.
    await sc.input.pressKey("Escape");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await sc.input.pressKey("Escape");

    // 6. Wait 20 s for the lobby's 15 s auto-start timer + a 5 s
    //    margin to let the new game reach a deterministic phase.
    //    The user sees the bug around the 40 s mark; we reproduce
    //    the same wall-clock cadence.
    await new Promise((resolve) => setTimeout(resolve, 20_000));

    // 7. Wait for the next in-game event in the all-AI game. (The
    //    lobby auto-start bootstrapped a fresh game because nobody
    //    joined during the countdown.)
    await waitForPhase(sc, Phase.BATTLE, { timeoutMs: 60_000 });

    // 8. Poll the camera across the all-AI game's battle phase.
    //    Without a human player every zoom-engagement path is
    //    supposed to stay off (`autoZoom` gates on
    //    `hasPointerPlayer`, the zone/battle zoom helpers likewise).
    //    Any `cameraZone`, any pitch, any cropped viewport during
    //    this window means a leak.
    let sawCameraZone: number | undefined;
    let sawPitch = 0;
    let sawCroppedViewport = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const snap = await sc.camera.state();
      if (snap.cameraZone !== undefined) sawCameraZone = snap.cameraZone;
      if (snap.pitch !== 0) sawPitch = snap.pitch;
      if (snap.hasViewport) sawCroppedViewport = true;
      if (sawCameraZone !== undefined || sawCroppedViewport) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    assert(
      sawCameraZone === undefined,
      `no human → no cameraZone; the post-quit all-AI game must not ` +
        `auto-zoom (saw zone=${sawCameraZone})`,
    );
    assert(
      sawPitch === 0,
      `no human → no battle tilt; the post-quit all-AI game must not ` +
        `pitch (saw pitch=${sawPitch})`,
    );
    assert(
      !sawCroppedViewport,
      "no human → no cropped viewport; camera must stay at fullMapVp",
    );
    // Note: `autoZoomOn` reports `mobileZoomEnabled && zoomActivated`.
    // `resetCamera` on game bootstrap legitimately re-arms
    // `zoomActivated`, so this flag stays true — what matters is that
    // no concrete zoom target (cameraZone / viewport / pitch)
    // actually engaged.
    void sc.bus.events(GAME_EVENT.BANNER_START);
  },
);
