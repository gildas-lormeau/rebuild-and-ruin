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
import { computeLobbyLayout } from "../src/render/render-ui-overlays.ts";
import {
  LOBBY_SKIP_LOCKOUT,
  LOBBY_TIMER,
} from "../src/shared/core/game-constants.ts";
import { MAP_PX_H, MAP_PX_W, SCALE } from "../src/shared/core/grid.ts";
import { MAX_PLAYERS } from "../src/shared/ui/player-config.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";
import { dispatchModeTap } from "../src/input/input-dispatch.ts";
import { createScenario, settleLobbyExit, tapAndSettle } from "./scenario.ts";

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
    // `tapAndSettle` ticks a frame between taps so `tickLobby` runs and each
    // next tap is evaluated against the latest `timerAccum`.
    for (let i = 0; i < LOBBY_TIMER; i++) {
      await tapAndSettle(sc, slot0.x, slot0.y);
    }

    // Stage 1 — drive sync frames until `tickLobby` flips
    // `lobby.active=false`. With spam-skipping the lobby should drain
    // in about LOBBY_SKIP_LOCKOUT seconds (the floor below which
    // skipping has no effect).
    const startedAt = sc.now();
    const timeoutMs = LOBBY_TIMER * 1000;
    sc.runUntil(() => !sc.lobbyActive(), { timeoutMs });
    const elapsedSec = (sc.now() - startedAt) / 1000;
    assert(
      elapsedSec <= LOBBY_SKIP_LOCKOUT + 0.5,
      `lobby took ${elapsedSec.toFixed(2)}s to drain after spam-tap (expected ≈${LOBBY_SKIP_LOCKOUT}s)`,
    );

    // Stage 2 — settle the async lobby-exit bootstrap (runs off the sim loop).
    await settleLobbyExit(sc);

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

/** Center of slot N in canvas-space pixels. Identical to the helper in
 *  `input-lobby.test.ts` — see that file for the SCALE-conversion notes. */
function slotCenterCanvas(slotIndex: number): { x: number; y: number } {
  const layout = computeLobbyLayout(MAP_PX_W, MAP_PX_H, MAX_PLAYERS);
  const tileX = layout.gap + slotIndex * (layout.rectW + layout.gap) +
    layout.rectW / 2;
  const tileY = layout.rectY + layout.rectH / 2;
  return { x: tileX * SCALE, y: tileY * SCALE };
}

// ── STOPPED taps require a visible game-over overlay ─────────────────
// Mirror of handleKeyStopped's gate (input-keyboard.ts, b5c304e7):
// Mode.STOPPED without an overlay is a torn-down session (route-level
// shutdown, online disconnect announcement). The tap router used to call
// gameOver.click unconditionally — on touch devices, gameOverClick's
// tap-anywhere fallback then EXECUTES the no-overlay FOCUS_MENU default
// (returnToLobby), opening a lobby over whatever UI replaced the game.
// The headless platform reads as non-touch, so the full-pipeline flavor
// of this bug can't reproduce here; the gate's contract is asserted at
// the router seam (same shape as online-unit.test.ts's dispatcher tests).
Deno.test("dispatchModeTap: STOPPED tap is consumed but not forwarded without a game-over overlay", () => {
  const clicks: { x: number; y: number }[] = [];
  const never = () => {
    throw new Error("non-game-over dep must not be touched in STOPPED");
  };
  const makeDeps = (overlayVisible: boolean) => ({
    gameOver: {
      isActive: () => overlayVisible,
      click: (x: number, y: number) => {
        clicks.push({ x, y });
      },
    },
    options: {
      click: never,
      clickControls: never,
      close: never,
      closeControls: never,
      getControlsState: never,
    },
    lifeLost: { get: () => null, click: never },
    upgradePick: { get: () => null, click: never },
    lobby: { isActive: () => false, click: never },
  });

  // No overlay: the tap must still be consumed (STOPPED never leaks taps
  // into game handlers) but gameOver.click must NOT fire.
  assert(
    dispatchModeTap(10, 20, Mode.STOPPED, makeDeps(false)),
    "STOPPED tap must be consumed",
  );
  assertEquals(
    clicks.length,
    0,
    "no overlay → the tap router must not forward to gameOver.click " +
      "(on touch, the tap-anywhere fallback would execute returnToLobby)",
  );

  // Overlay visible: forwarding works as before.
  assert(dispatchModeTap(10, 20, Mode.STOPPED, makeDeps(true)));
  assertEquals(clicks, [{ x: 10, y: 20 }]);
});
