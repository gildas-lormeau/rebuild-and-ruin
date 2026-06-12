/**
 * Lobby input tests — verify the production input pipeline runs end-to-end
 * in headless. The runtime registers the same `registerKeyboardHandlers`
 * and `registerMouseHandlers` from `src/input/` that a browser session uses;
 * tests dispatch real `KeyboardEvent` / `MouseEvent` instances at the same
 * `EventTarget` the browser uses (`document` for keys, the canvas for
 * mouse), via `sc.input.*`.
 *
 * If these tests pass, the wiring proves we can drive any browser-only
 * input path from a deno test without mocking the input system.
 *
 * Lobby timer rules (see `subsystems/lobby.ts`):
 *   - First click on a slot joins it (sets `mouseJoinedSlot`).
 *   - Subsequent clicks call `lobbySkipStep`, which adds `LOBBY_SKIP_STEP`
 *     (1 second) to `timerAccum` per click — but only down to
 *     `LOBBY_SKIP_LOCKOUT` (3 seconds) remaining.
 *   - When `getLobbyRemaining() <= 0` OR every joined slot is full, the
 *     lobby exits and `onTickLobbyExpired` bootstraps the game.
 *
 * Mouse coordinate math: `lobbyClickHitTest` converts canvas pixels back to
 * tile-space by dividing by `SCALE` (canvas = `MAP_PX * SCALE`). To click
 * at tile-space coordinate `t`, dispatch the click at canvas-space `t * SCALE`.
 */

import { assert, assertEquals, assertGreater } from "@std/assert";
import { computeLobbyLayout } from "../src/render/render-ui-overlays.ts";
import {
  LOBBY_SKIP_LOCKOUT,
  LOBBY_TIMER,
} from "../src/shared/core/game-constants.ts";
import { MAP_PX_H, MAP_PX_W, SCALE } from "../src/shared/core/grid.ts";
import {
  MAX_PLAYERS,
  PLAYER_KEY_BINDINGS,
} from "../src/shared/ui/player-config.ts";
import { DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS } from "../src/shared/core/action-schedule.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";
import {
  clickAndSettle,
  createScenario,
  pressKeyAndSettle,
  settleLobbyExit,
} from "./scenario.ts";

Deno.test(
  "lobby input: clicking a slot joins it and starts the game before the 15s timeout",
  async () => {
    using sc = await createScenario({ seed: 42, autoStartGame: false });

    // Sanity: we're sitting in the lobby. `state` is the sentinel until
    // `startGame` runs, so we can't read `state.players` here yet.
    assertEquals(sc.mode(), Mode.LOBBY, "expected to start in LOBBY mode");
    assert(sc.lobbyActive(), "expected lobby.active=true");

    // First click — joins slot 0. The path:
    //   MouseEvent → eventTarget(canvas) → registerMouseHandlers click
    //   → dispatchModeTap → lobby.click → lobbyClickHitTest → onLobbyJoin
    //   → inputTracking.mouseJoinedSlot = 0
    // Subsequent clicks at the same slot go through the
    // `mouseJoinedSlot !== null` branch and call `lobbySkipStep` instead.
    const slot0 = slotCenterCanvas(0);
    sc.input.click(slot0.x, slot0.y);

    // Spam-click to skip the timer down to LOBBY_SKIP_LOCKOUT (3s remaining).
    // Each skip click adds 1s to `timerAccum`; we need to drop the timer
    // from 15s to below the lockout, so click ~15 times. Excess clicks
    // beyond the lockout are silently ignored by `lobbySkipStep`, so a
    // few extras are harmless. `clickAndSettle` ticks a frame between clicks
    // so the intermediate `tickLobby` runs and the next click is evaluated
    // against the latest `timerAccum`.
    for (let i = 0; i < LOBBY_TIMER; i++) {
      await clickAndSettle(sc, slot0.x, slot0.y);
    }

    // Stage 1 — sync frames until `tickLobby` notices `getLobbyRemaining()
    // <= 0` and flips `lobby.active=false`. After spam-skipping there
    // should be ≤ LOBBY_SKIP_LOCKOUT seconds left, so this loop drains in
    // a few hundred frames at most. The cap is generous (`LOBBY_TIMER`
    // worth of frames) so the assertion below points at the real bug,
    // not a tight cap.
    const startedAt = sc.now();
    const timeoutMs = LOBBY_TIMER * 1000;
    // runUntil throws ScenarioTimeoutError if the lobby never deactivates —
    // the resulting stack points at the real bug.
    sc.runUntil(() => !sc.lobbyActive(), { timeoutMs });
    const elapsedSec = (sc.now() - startedAt) / 1000;
    // After spam-skipping the lobby should drain in roughly LOBBY_SKIP_LOCKOUT
    // seconds (the floor below which skipping has no effect). A tiny margin
    // covers rounding from per-frame dt accumulation.
    assert(
      elapsedSec <= LOBBY_SKIP_LOCKOUT + 0.5,
      `lobby took ${elapsedSec.toFixed(2)}s to drain after spam-skip (expected ≈${LOBBY_SKIP_LOCKOUT}s)`,
    );

    // Stage 2 — yield the event loop so the queued `onTickLobbyExpired`
    // body (await startGame → bootstrapNewGame → ensureAiModulesLoaded)
    // actually runs to completion, then drive a few frames so the
    // runtime sees the new mode.
    await settleLobbyExit(sc);

    assertEquals(
      sc.lobbyActive(),
      false,
      "lobby.active should be false after exit",
    );

    // After lobby exit, onTickLobbyExpired bootstrapped the game → players
    // exist and the runtime is no longer in LOBBY mode.
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

/** Center of slot N in canvas-space pixels — what the test dispatches as
 *  the `clientX/Y` of a `MouseEvent`. The hit-tester divides by SCALE to
 *  get back to tile-space. */
function slotCenterCanvas(slotIndex: number): { x: number; y: number } {
  const layout = computeLobbyLayout(MAP_PX_W, MAP_PX_H, MAX_PLAYERS);
  const tileX = layout.gap + slotIndex * (layout.rectW + layout.gap) +
    layout.rectW / 2;
  const tileY = layout.rectY + layout.rectH / 2;
  return { x: tileX * SCALE, y: tileY * SCALE };
}

Deno.test(
  "lobby input: pressing the confirm key joins a slot and starts the game before the 15s timeout",
  async () => {
    using sc = await createScenario({ seed: 42, autoStartGame: false });

    assertEquals(sc.mode(), Mode.LOBBY, "expected to start in LOBBY mode");
    assert(sc.lobbyActive(), "expected lobby.active=true");

    // Slot 0's confirm key from the default bindings (player_config.ts:97).
    // The path:
    //   KeyboardEvent → keyboardEventSource(document) → registerKeyboardHandlers
    //   keydown → deps.lobby.keyJoin → lobbyKeyJoin → onLobbyJoin
    //   → lobby.joined[0] = true
    // The first press joins slot 0; subsequent presses go through the
    // `lobby.joined[pid]` branch in `lobbyKeyJoin` and call `lobbySkipStep`.
    //
    // The keyboard handler is `async` (it `await`s `handleKeyF1`), so the
    // body that calls `lobby.keyJoin` runs in a microtask. `pressKeyAndSettle`
    // drains that microtask + advances a frame after every press — otherwise
    // all 16 events queue up sync but only the first handler's body actually
    // runs before the timer assertion checks `lobby.active`.
    const slot0Confirm = PLAYER_KEY_BINDINGS[0]!.confirm;
    for (let i = 0; i <= LOBBY_TIMER; i++) {
      await pressKeyAndSettle(sc, slot0Confirm);
    }

    const startedAt = sc.now();
    const timeoutMs = LOBBY_TIMER * 1000;
    sc.runUntil(() => !sc.lobbyActive(), { timeoutMs });
    const elapsedSec = (sc.now() - startedAt) / 1000;
    assert(
      elapsedSec <= LOBBY_SKIP_LOCKOUT + 0.5,
      `lobby took ${elapsedSec.toFixed(2)}s to drain after key spam (expected ≈${LOBBY_SKIP_LOCKOUT}s)`,
    );

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

// ── F1 options entry is gated while remote humans are connected ──────
// Mode.OPTIONS is not a ticking mode: opening mid-game options freezes
// the local sim. Fine locally — but with remote humans connected the
// other peers keep ticking, their life-lost grace backstop
// force-ABANDONs the frozen player's pending dialog entry, and the
// frozen peer later resolves CONTINUE: a permanent cross-peer dialog
// fork. F1's gameplay branch now shares togglePause's rule
// (subsystems/options.ts): no sim-freezing UI while remote humans are
// connected.
Deno.test(
  "keyboard: F1 mid-game is consumed without opening options while remote humans are connected",
  async () => {
    // Watcher runtime with slot 1 driven by a remote human — the same
    // remotePlayerSlots wiring production uses (network-setup.ts).
    using sc = await createScenario({
      seed: 42,
      mode: "classic",
      rounds: 3,
      online: "watcher",
      assistedSlots: [1 as ValidPlayerId],
    });
    assertEquals(
      sc.mode(),
      Mode.SELECTION,
      "precondition: watcher booted into a gameplay mode",
    );

    sc.input.pressKey("F1");
    sc.tick(2);
    assertEquals(
      sc.mode(),
      Mode.SELECTION,
      "F1 must not freeze the local sim while remote humans are connected " +
        "(Mode.OPTIONS stops simTick; the peers keep ticking and fork the dialogs)",
    );
  },
);

Deno.test(
  "keyboard: F1 mid-game still opens options without remote humans",
  async () => {
    using sc = await createScenario({ seed: 42, mode: "classic", rounds: 3 });
    assertEquals(sc.mode(), Mode.SELECTION);

    sc.input.pressKey("F1");
    sc.tick(2);
    assertEquals(
      sc.mode(),
      Mode.OPTIONS,
      "local play keeps mid-game options on F1",
    );
  },
);

// ── selection input is gated until the announcement window ends ──────
// Round 1 enters CASTLE_SELECT behind a 1s announcement
// (SELECT_ANNOUNCEMENT_DURATION) during which syncSelectionOverlay hides
// every human highlight. The input adapters share the same `isReady`
// gate: without it, arrow keys retarget and the confirm key lands on a
// highlight the player cannot see — a blind confirm of whichever tower
// the cursor happened to start on. (AI selection and the remote-peer
// wire path bypass the adapters, so determinism is untouched.)
Deno.test(
  "keyboard: selection input during the announcement window is ignored",
  async () => {
    using sc = await createScenario({ seed: 42, autoStartGame: false });
    const bindings = PLAYER_KEY_BINDINGS[0]!;
    for (let i = 0; i <= LOBBY_TIMER; i++) {
      await pressKeyAndSettle(sc, bindings.confirm);
    }
    sc.runUntil(() => !sc.lobbyActive(), { timeoutMs: LOBBY_TIMER * 1000 });
    await settleLobbyExit(sc);
    assertEquals(
      sc.mode(),
      Mode.SELECTION,
      "precondition: round 1 starts in selection",
    );

    let placed = 0;
    sc.bus.on(GAME_EVENT.CASTLE_PLACED, (ev) => {
      if (ev.playerId === 0) placed += 1;
    });

    // Inside the announcement window — the accumulator armed at 0 on
    // selection entry; the window is 1s (60 ticks) of sim time. Human
    // confirms are lockstep-SCHEDULED (applyAt = simTick + safety), so
    // drain past the safety window before asserting — the ungated bug's
    // CASTLE_PLACED fires ticks after the press, not on it.
    await pressKeyAndSettle(sc, bindings.up);
    await pressKeyAndSettle(sc, bindings.confirm);
    sc.tick(DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS + 5);
    assertEquals(
      placed,
      0,
      "confirm while every highlight is hidden must be ignored",
    );

    // Past the window: the same keys highlight + confirm normally.
    sc.tick(90);
    await pressKeyAndSettle(sc, bindings.up);
    await pressKeyAndSettle(sc, bindings.confirm);
    sc.tick(DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS + 5);
    assertEquals(placed, 1, "confirm works once the announcement ends");
  },
);
