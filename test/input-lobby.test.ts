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
import { MESSAGE, type ServerMessage } from "../src/protocol/protocol.ts";
import { DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS } from "../src/shared/core/action-schedule.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";
import {
  clickAndSettle,
  createScenario,
  pressKeyAndSettle,
  settleLobbyExit,
  waitForPhase,
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

// ── route-level exit must reset mouse-join tracking ──────────────────
// `runtime.shutdown` (GAME_EXIT_EVENT — back-button navigation away from
// /play) used to skip the input reset that `returnToLobby` performs. The
// stale `inputTracking.mouseJoinedSlot` made `lobbyClick` route EVERY
// slot click in the next lobby through the "hurry up" skip branch — the
// mouse could never join again, and the spam-skipped lobby drained into
// an all-AI demo.
Deno.test(
  "lobby input: mouse can join again after a route-level shutdown",
  async () => {
    using sc = await createScenario({ seed: 42, autoStartGame: false });
    const slot0 = slotCenterCanvas(0);

    // First lobby: join slot 0 by mouse and start the game. This half
    // proves the click coordinates land (slot 0 human) — without it the
    // second half could pass vacuously if the lobby layout shifts.
    sc.input.click(slot0.x, slot0.y);
    for (let i = 0; i < LOBBY_TIMER; i++) {
      await clickAndSettle(sc, slot0.x, slot0.y);
    }
    sc.runUntil(() => !sc.lobbyActive(), { timeoutMs: LOBBY_TIMER * 1000 });
    await settleLobbyExit(sc);
    assertEquals(
      sc.aiArchetypes()[0],
      undefined,
      "precondition: the mouse click joined slot 0 (human slots carry no archetype)",
    );

    // Route-level exit + re-entry.
    sc.shutdown();
    assertEquals(sc.mode(), Mode.STOPPED, "shutdown parks the runtime");
    sc.showLobby();
    assert(sc.lobbyActive(), "re-entry shows a fresh lobby");

    // Second lobby: the identical click sequence must join again.
    sc.input.click(slot0.x, slot0.y);
    for (let i = 0; i < LOBBY_TIMER; i++) {
      await clickAndSettle(sc, slot0.x, slot0.y);
    }
    sc.runUntil(() => !sc.lobbyActive(), { timeoutMs: LOBBY_TIMER * 1000 });
    await settleLobbyExit(sc);
    assertEquals(
      sc.aiArchetypes()[0],
      undefined,
      "slot 0 must be human-joined after a shutdown→re-entry round trip",
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

// ── F1 options entry is gated while online ───────────────────────────
// Mode.OPTIONS is not a ticking mode: opening mid-game options freezes
// the local sim. Fine locally — but online every other peer keeps
// mirror-ticking: their life-lost grace backstop force-ABANDONs the
// frozen player's pending dialog entry, and the frozen peer later
// resolves CONTINUE: a permanent cross-peer dialog fork. F1's gameplay
// branch shares togglePause's rule (subsystems/options.ts): no
// sim-freezing UI while online at all — seated-humans checks can't
// stand in, because unseated spectators are invisible to clients and
// mirror-tick too.
Deno.test(
  "keyboard: F1 mid-game is consumed without opening options while online",
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
      "F1 must not freeze the local sim while online " +
        "(Mode.OPTIONS stops the sim; the peers keep ticking and fork the dialogs)",
    );
  },
);

Deno.test(
  "keyboard: F1 mid-game is consumed for an online host with no seated remote humans",
  async () => {
    // The spectator hole: unseated watchers are invisible to clients
    // (the server broadcasts no join/leave for them), so a host alone
    // with AI cannot prove nobody is mirror-ticking. The gate must key
    // on being online at all, not on seated remote humans.
    using sc = await createScenario({
      seed: 42,
      mode: "classic",
      rounds: 3,
      online: "host",
    });
    assertEquals(sc.mode(), Mode.SELECTION);

    sc.input.pressKey("F1");
    sc.tick(2);
    assertEquals(
      sc.mode(),
      Mode.SELECTION,
      "an online host must not freeze its sim in mid-game options — " +
        "an unseated spectator may be mirror-ticking",
    );
  },
);

Deno.test(
  "keyboard: pause is refused for an online host with no seated remote humans",
  async () => {
    using sc = await createScenario({
      seed: 42,
      mode: "classic",
      rounds: 3,
      online: "host",
    });
    assertEquals(sc.mode(), Mode.SELECTION);

    await pressKeyAndSettle(sc, "p");
    // An engaged pause would freeze tickMode and the game would never
    // leave CASTLE_SELECT; a refused pause lets the all-AI selection
    // run to the next phase.
    waitForPhase(sc, Phase.CANNON_PLACE, { timeoutMs: 60_000 });
  },
);

Deno.test("keyboard: local pause freezes simTick with the sim", async () => {
  using sc = await createScenario({ seed: 42, mode: "classic", rounds: 3 });
  assertEquals(sc.mode(), Mode.SELECTION);

  await pressKeyAndSettle(sc, "p");
  const pausedAt = sc.state.simTick;
  sc.tick(10);
  assertEquals(
    sc.state.simTick,
    pausedAt,
    "paused substeps skip tickMode and must not count — simTick is the " +
      "applyAt basis and must track actual game ticks",
  );

  await pressKeyAndSettle(sc, "p");
  sc.tick(10);
  assertGreater(sc.state.simTick, pausedAt, "unpausing resumes the counter");
});

Deno.test(
  "keyboard: F1 mid-game still opens options in local play",
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

// ── a confirm commits the tower it broadcast, not the drain-time one ──
// Human confirms are lockstep-scheduled: the press broadcasts a captured
// `towerIdx` and defers the apply by DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS.
// Highlight input stays open during that window (`highlightTowerSelection`
// rejects only `confirmed`, which flips at drain) — so the apply must
// commit the CAPTURED tower. Committing the live highlight instead means
// a post-confirm hover flips the castle offline, and online the originator
// and receivers can commit DIFFERENT towers (a hover message crossing the
// drain boundary), forking homeTower, the castle ring, and state.rng.
Deno.test(
  "selection: a hover inside the confirm's lockstep window must not flip the committed tower",
  async () => {
    using sc = await createScenario({ seed: 42, autoStartGame: false });
    const bindings = PLAYER_KEY_BINDINGS[0]!;
    for (let i = 0; i <= LOBBY_TIMER; i++) {
      await pressKeyAndSettle(sc, bindings.confirm);
    }
    sc.runUntil(() => !sc.lobbyActive(), { timeoutMs: LOBBY_TIMER * 1000 });
    await settleLobbyExit(sc);
    assertEquals(sc.mode(), Mode.SELECTION, "precondition: in selection");

    const placedAt: { row: number; col: number }[] = [];
    sc.bus.on(GAME_EVENT.CASTLE_PLACED, (ev) => {
      if (ev.playerId === 0) placedAt.push({ row: ev.row, col: ev.col });
    });

    // Past the announcement window, browse once (deterministic non-initial
    // tower), then confirm — the press captures + broadcasts this tower.
    sc.tick(90);
    await pressKeyAndSettle(sc, bindings.up);
    const confirmedTower = sc.state.players[0]!.homeTower!;
    await pressKeyAndSettle(sc, bindings.confirm);

    // Still inside the safety window: keep browsing. The highlight (and
    // player.homeTower with it) moves — that's the open window.
    await pressKeyAndSettle(sc, bindings.up);
    const hoverTower = sc.state.players[0]!.homeTower!;
    assert(
      hoverTower !== confirmedTower,
      "precondition: the post-confirm hover moved the highlight " +
        "(zone needs >1 tower for this seed/slot)",
    );

    sc.tick(DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS + 5);
    assertEquals(placedAt.length, 1, "exactly one castle placed for slot 0");
    assertEquals(
      placedAt[0],
      { row: confirmedTower.row, col: confirmedTower.col },
      "the committed castle must sit on the tower captured at the confirm " +
        "press (the broadcast towerIdx), not the drain-time highlight",
    );
  },
);

// Receiver side of the same window: a watcher receives the confirm
// (towerIdx captured by the originator) and schedules it for `applyAt`,
// but applies hover messages at RECEIVE time. A hover crossing the drain
// boundary must not flip what the scheduled confirm commits — the wire
// towerIdx is the cross-peer contract.
Deno.test(
  "selection: a hover crossing the drain boundary must not flip a remote confirm (receiver)",
  async () => {
    using sc = await createScenario({
      seed: 42,
      mode: "classic",
      rounds: 3,
      online: "watcher",
      assistedSlots: [1 as ValidPlayerId],
    });
    assertEquals(sc.mode(), Mode.SELECTION, "precondition: in selection");

    const zone = sc.state.playerZones[1];
    const zoneTowers = sc.state.map.towers.filter(
      (tower) => tower.zone === zone,
    );
    assertGreater(
      zoneTowers.length,
      1,
      "precondition: slot 1's zone needs two towers for this seed",
    );
    const towerA = zoneTowers[0]!;
    const towerB = zoneTowers[1]!;

    const placedAt: { row: number; col: number }[] = [];
    sc.bus.on(GAME_EVENT.CASTLE_PLACED, (ev) => {
      if (ev.playerId === 1) placedAt.push({ row: ev.row, col: ev.col });
    });

    // The remote human confirms tower A (lockstep-scheduled), then a
    // hover for tower B lands before the drain — receive-time highlight
    // application is immediate by design.
    await sc.deliverMessage({
      type: MESSAGE.OPPONENT_TOWER_SELECTED,
      playerId: 1,
      towerIdx: towerA.index,
      confirmed: true,
      applyAt: sc.state.simTick + DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS,
    } as ServerMessage);
    await sc.deliverMessage({
      type: MESSAGE.OPPONENT_TOWER_SELECTED,
      playerId: 1,
      towerIdx: towerB.index,
      confirmed: false,
    } as ServerMessage);

    sc.tick(DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS + 5);
    assertEquals(placedAt.length, 1, "exactly one castle placed for slot 1");
    assertEquals(
      placedAt[0],
      { row: towerA.row, col: towerA.col },
      "the scheduled confirm must commit the wire towerIdx, not the " +
        "highlight a later hover moved",
    );
  },
);

// ── the options freeze must halt the round-end score overlay ─────────
// The score-overlay timer used to tick before the main loop's freeze
// gates (pause check + non-ticking modes), so opening mid-game options
// during the round-end overlay let it expire under the menu — its
// continuation then advanced the round-end chain (life-lost dialog pop
// or the full route into the next phase), yanking the mode out from
// under the frozen OPTIONS screen. The overlay must freeze and resume
// exactly like every other display-chain element.
Deno.test(
  "keyboard: F1 options freeze halts the round-end score overlay",
  async () => {
    using sc = await createScenario({ seed: 42, mode: "classic", rounds: 3 });
    let overlayStarted = false;
    let overlayEnded = false;
    sc.bus.on(GAME_EVENT.SCORE_OVERLAY_START, () => {
      overlayStarted = true;
    });
    sc.bus.on(GAME_EVENT.SCORE_OVERLAY_END, () => {
      overlayEnded = true;
    });

    // Round 1's closing WALL_BUILD ends in round-end → score overlay.
    sc.runUntil(() => overlayStarted, { timeoutMs: 240_000 });
    await pressKeyAndSettle(sc, "F1");
    assertEquals(sc.mode(), Mode.OPTIONS, "precondition: options opened");

    // Sit in the menu far past SCORE_DELTA_DISPLAY_TIME (2s ≈ 120 frames).
    sc.tick(360);
    assertEquals(
      sc.mode(),
      Mode.OPTIONS,
      "the round-end chain must not advance while the sim is frozen",
    );
    assertEquals(
      overlayEnded,
      false,
      "the score overlay must freeze with the rest of the sim",
    );
    assertEquals(Phase[sc.state.phase], Phase[Phase.WALL_BUILD]);

    // Close the menu: the overlay resumes and the chain routes onward.
    await pressKeyAndSettle(sc, "F1");
    sc.runUntil(() => overlayEnded, { timeoutMs: 30_000 });
    sc.runUntil(() => sc.state.phase !== Phase.WALL_BUILD, {
      timeoutMs: 60_000,
    });
  },
);
