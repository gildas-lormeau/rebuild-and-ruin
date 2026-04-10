/**
 * Touch input test — verifies the production touch handlers
 * (`registerTouchHandlers` in `src/input/input-touch-canvas.ts`) run
 * end-to-end in headless against polyfilled `TouchEvent` / `Touch`
 * instances dispatched at the canvas event target.
 *
 * The flow mirrors `input-lobby.test.ts` but drives the lobby through
 * touch instead of mouse: a tap on slot 0 fires the same
 * `dispatchModeTap → lobby.click` chain that a mouse click would, then
 * spam-taps drain the timer the same way spam-clicks do. If the touch
 * pipeline regresses (or the polyfill drifts from what the handlers
 * read), this test fails on the first tap.
 */

import { assert, assertEquals, assertGreater } from "@std/assert";
import { computeLobbyLayout } from "../src/render/render-composition.ts";
import {
  LOBBY_SKIP_LOCKOUT,
  LOBBY_TIMER,
} from "../src/shared/game-constants.ts";
import { MAP_PX_H, MAP_PX_W, SCALE } from "../src/shared/grid.ts";
import { MAX_PLAYERS } from "../src/shared/player-config.ts";
import { Mode } from "../src/shared/ui-mode.ts";
import { createScenario } from "./scenario.ts";

/** Center of slot N in canvas-space pixels. Identical to the helper in
 *  `input-lobby.test.ts` — see that file for the SCALE-conversion notes. */
function slotCenterCanvas(slotIndex: number): { x: number; y: number } {
  const layout = computeLobbyLayout(MAP_PX_W, MAP_PX_H, MAX_PLAYERS);
  const tileX = layout.gap + slotIndex * (layout.rectW + layout.gap) +
    layout.rectW / 2;
  const tileY = layout.rectY + layout.rectH / 2;
  return { x: tileX * SCALE, y: tileY * SCALE };
}

Deno.test(
  "lobby touch: tapping a slot joins it and starts the game before the 15s timeout",
  async () => {
    using sc = await createScenario({ seed: 42, autoStartGame: false });

    assertEquals(sc.mode(), Mode.LOBBY, "expected to start in LOBBY mode");
    assert(sc.lobbyActive(), "expected lobby.active=true");

    // First tap — joins slot 0 via the touch handler chain:
    //   TouchEvent → eventTarget(canvas) → registerTouchHandlers
    //   → handleTouchStart (records start position)
    //   → handleTouchEnd (tap detected → dispatchModeTap → lobby.click
    //   → onLobbyJoin → inputTracking.mouseJoinedSlot = 0)
    // Subsequent taps at the same slot follow the
    // `mouseJoinedSlot !== null` branch and call `lobbySkipStep`.
    const slot0 = slotCenterCanvas(0);
    sc.input.tap(slot0.x, slot0.y);

    // Spam-tap to skip the timer down to LOBBY_SKIP_LOCKOUT. Same
    // accounting as the mouse + keyboard tests in `input-lobby.test.ts`:
    // each skip adds 1s to `timerAccum` until the lockout (3s remaining).
    // Tick a frame between taps so `tickLobby` runs and each next tap
    // is evaluated against the latest `timerAccum`.
    for (let i = 0; i < LOBBY_TIMER; i++) {
      sc.input.tap(slot0.x, slot0.y);
      sc.runUntil(() => false, 1);
    }

    // Stage 1 — drive sync frames until `tickLobby` flips
    // `lobby.active=false`. With spam-skipping the lobby should drain
    // in about LOBBY_SKIP_LOCKOUT seconds (the floor below which
    // skipping has no effect).
    const startedAt = sc.now();
    const FRAMES_PER_SEC = 1000 / 16;
    const maxFrames = Math.ceil(LOBBY_TIMER * FRAMES_PER_SEC);
    const framesToInactive = sc.runUntil(() => !sc.lobbyActive(), maxFrames);
    const elapsedSec = (sc.now() - startedAt) / 1000;
    assert(
      framesToInactive >= 0,
      `lobby never deactivated after ${maxFrames} frames (${elapsedSec}s)`,
    );
    assert(
      elapsedSec <= LOBBY_SKIP_LOCKOUT + 0.5,
      `lobby took ${elapsedSec.toFixed(2)}s to drain after spam-tap (expected ≈${LOBBY_SKIP_LOCKOUT}s)`,
    );

    // Stage 2 — drain microtasks so `onTickLobbyExpired` (await
    // startGame → bootstrapNewGame → ensureAiModulesLoaded) settles.
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    sc.runUntil(() => sc.mode() !== Mode.LOBBY, 10);

    assertEquals(
      sc.lobbyActive(),
      false,
      "lobby.active should be false after exit",
    );
    assertGreater(
      sc.state.players.length,
      0,
      "expected players after game start",
    );
    assert(
      sc.mode() !== Mode.LOBBY,
      `expected to leave LOBBY mode, still in ${Mode[sc.mode()]}`,
    );
  },
);
