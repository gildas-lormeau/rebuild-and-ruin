/**
 * Headless: a human joins (mobile emulation), plays through round 1 —
 * castles auto-built, cannons auto-placed — until BATTLE starts, then
 * ESC-twice quits. The lobby auto-restart timer fires and starts a fresh
 * "demo" game where every slot is AI. CAMERA_TARGET events fire on every
 * gameplay-phase enter (build/cannon/battle), so the trace shows the
 * runtime's intentional camera moves across both games — the same signal
 * the e2e mobile-zoom-leak repro (`test/e2e-quit-reset.ts`) watches for.
 *
 * Pre-req: `runtime-headless.ts::showLobby` must mirror `main.ts::showLobby`
 * (re-arms `lobby.active`, resets `timerAccum`, regenerates the map,
 * sets `Mode.LOBBY`). Without that, ESC quit tears down the game but
 * the runtime never re-enters the lobby and the demo restart never
 * fires.
 */

import { assert, assertEquals } from "@std/assert";
import {
  GAME_EVENT,
  type GameEventMap,
} from "../src/shared/core/game-event-bus.ts";
import { LOBBY_TIMER } from "../src/shared/core/game-constants.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { PLAYER_KEY_BINDINGS } from "../src/shared/ui/player-config.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";
import { createScenario, type Scenario } from "./scenario.ts";

interface CameraTrace {
  game: string;
  simMs: number;
  phase: Phase;
  event: GameEventMap["cameraTarget"];
}

Deno.test(
  "headless: ESC-quit at BATTLE → lobby auto-restarts as all-AI demo (mobile)",
  async () => {
    using sc = await createScenario({
      seed: 42,
      autoStartGame: false,
      // Mobile emulation: enables auto-zoom, per-phase pinch memory,
      // edge-pan, follow-crosshair, and CAMERA_TARGET event emission —
      // the same path `setupTouchControls` triggers from a real phone.
      // Keyboard still works in mobile mode, so the join + ESC flow
      // below runs unchanged.
      mobileZoomEnabled: true,
    });

    // CAMERA_TARGET fires whenever the runtime intentionally moves the
    // camera (zone change, pinch viewport, fullmap reset). The bus is a
    // per-game EventBus instance (created inside `bootstrapNewGame`), so
    // we subscribe twice — once after each bootstrap. `currentGame` is
    // captured by both listeners so each event lands tagged with the game
    // that emitted it.
    const trace: CameraTrace[] = [];
    let currentGame = "first";

    // Sanity: parked in lobby, no game yet.
    assertEquals(sc.mode(), Mode.LOBBY, "expected to start in LOBBY mode");
    assert(sc.lobbyActive(), "expected lobby.active=true");

    // 1. Press slot-0's confirm key to join. Same path as the lobby input
    //    test — the keyboard handler is async, so drain microtasks before
    //    the next sim tick reads `lobby.joined`.
    sc.input.pressKey(PLAYER_KEY_BINDINGS[0]!.confirm);
    await Promise.resolve();

    // 2. Wait for the lobby timer to expire. `tickLobby` flips
    //    `lobby.active=false` synchronously when the timer hits zero, then
    //    fires `onTickLobbyExpired` (async — awaits bootstrap). Drive sim
    //    until the sync flag flips, then drain microtasks so bootstrap
    //    completes and the runtime enters SELECTION mode.
    sc.runUntil(() => !sc.lobbyActive(), {
      timeoutMs: (LOBBY_TIMER + 2) * 1000,
    });
    await settleLobbyExit(sc);
    assertEquals(
      sc.mode(),
      Mode.SELECTION,
      "first game should reach SELECTION",
    );
    assertEquals(
      sc.state.phase,
      Phase.CASTLE_SELECT,
      "first game should be in CASTLE_SELECT",
    );
    // With slot 0 joined as human, the pointer-player gate flips and
    // auto-zoom should now register as active.
    assert(
      sc.camera.isMobileAutoZoom(),
      "mobile auto-zoom should be active in the human-joined first game",
    );

    // First-game bus subscription. Each new game has its own EventBus
    // instance (created inside `bootstrapNewGame`), so this listener only
    // hears the first game — we add a second subscription after the demo
    // bootstrap below.
    sc.bus.on(GAME_EVENT.CAMERA_TARGET, (event) =>
      trace.push({
        game: currentGame,
        simMs: Math.round(sc.now()),
        phase: sc.state.phase,
        event,
      }),
    );

    // 3. Drive the game until BATTLE settles. Round 1 castles are auto-built
    //    (WALL_BUILD is skipped on round 1) and round-1 cannons are
    //    auto-placed, so even a human-joined slot reaches BATTLE without
    //    any input. Wait for `mode === GAME` (not just `phase === BATTLE`)
    //    so the phase-transition animation is complete — the camera's
    //    `applyPhaseCameraOnEnter` no-ops during transitions and only
    //    fires once the new phase has settled.
    sc.runUntil(
      () => sc.state.phase === Phase.BATTLE && sc.mode() === Mode.GAME,
      { timeoutMs: 60_000 },
    );

    // 4. ESC twice to quit. First press arms `quit.pending` + a 2s timer;
    //    second press inside that window calls `showLobby()`. We tick a
    //    sim step between presses so the input handler's async body settles.
    sc.input.pressKey("Escape");
    await Promise.resolve();
    sc.tick(1);
    assert(
      sc.mode() !== Mode.LOBBY && sc.mode() !== Mode.STOPPED,
      `first ESC arms the warning but doesn't quit; got mode=${Mode[sc.mode()]}`,
    );
    sc.input.pressKey("Escape");
    await Promise.resolve();

    // 5. After the second ESC, returnToLobby → showLobby flips us back to
    //    LOBBY mode with `lobby.active=true` and `joined` cleared.
    sc.runUntil(() => sc.mode() === Mode.LOBBY, { timeoutMs: 2_000 });
    assert(sc.lobbyActive(), "lobby should be re-armed after quit");

    // 6. Wait for the lobby timer to expire a second time. Nobody pressed
    //    a join key, so this is the demo-restart path: fresh game with
    //    every slot AI-controlled. Same sync-flag-then-drain dance as
    //    step 2.
    sc.runUntil(() => !sc.lobbyActive(), {
      timeoutMs: (LOBBY_TIMER + 2) * 1000,
    });
    currentGame = "demo";
    await settleLobbyExit(sc);
    assertEquals(
      sc.mode(),
      Mode.SELECTION,
      "demo restart should reach SELECTION",
    );

    // Demo-game bus subscription. `bootstrapNewGame` installed a fresh
    // EventBus on the new state, so the first-game listener can't see
    // emissions on it — subscribe explicitly to the new bus.
    sc.bus.on(GAME_EVENT.CAMERA_TARGET, (event) =>
      trace.push({
        game: currentGame,
        simMs: Math.round(sc.now()),
        phase: sc.state.phase,
        event,
      }),
    );

    // 7. Drive the demo game to BATTLE too — same behavior the lobby's
    //    background demo plays out. Reaching BATTLE end-to-end proves the
    //    all-AI path runs cleanly. Note: the demo has NO human player, so
    //    `mobileAutoZoomActive()` returns false (gated on `hasPointerPlayer`)
    //    and `applyPhaseCameraOnEnter` no-ops — the demo contributes ZERO
    //    CAMERA_TARGET events to the trace, which is the desired behavior
    //    (the lobby-zoom-leak bug was the demo emitting them).
    sc.runUntil(
      () => sc.state.phase === Phase.BATTLE && sc.mode() === Mode.GAME,
      { timeoutMs: 60_000 },
    );

    dumpCameraTrace(trace);

    // 8. Mobile-zoom-leak invariant (the bug `e2e-quit-reset.ts` repros
    //    over Playwright): the demo game has no pointer player, so
    //    `mobileAutoZoomActive` reads false and `applyPhaseCameraOnEnter`
    //    must NOT emit. Any demo-tagged event in the trace would mean
    //    auto-zoom leaked across the quit boundary.
    const demoEvents = trace.filter((row) => row.game === "demo");
    assertEquals(
      demoEvents.length,
      0,
      `demo game must not emit CAMERA_TARGET events (mobile-zoom-leak); ` +
        `got: ${JSON.stringify(demoEvents)}`,
    );
    const firstGameEvents = trace.filter((row) => row.game === "first");
    assert(
      firstGameEvents.length > 0,
      "first game should have emitted at least one CAMERA_TARGET event",
    );
  },
);

function dumpCameraTrace(trace: readonly CameraTrace[]): void {
  console.log(`\nCAMERA_TARGET trace (${trace.length} events):`);
  if (trace.length === 0) {
    console.log("  (no camera moves recorded)");
    return;
  }
  for (const row of trace) {
    const detail =
      row.event.kind === "zone"
        ? `zone=${row.event.zone}`
        : row.event.kind === "pinch"
          ? `pinch viewport`
          : "fullmap";
    console.log(
      `  [${row.game.padEnd(5)}] +${String(row.simMs).padStart(6)}ms  ${row.phase.padEnd(13)}  ${detail.padEnd(16)}  src=${row.event.source}`,
    );
  }
}

/** Drain microtasks + tasks so the queued `onTickLobbyExpired` body
 *  (await startGame → bootstrapNewGame → ensureAiModulesLoaded) runs
 *  to completion, then drive a few more frames so the runtime sees the
 *  new mode. Same pattern as `test/input-lobby.test.ts::settleLobbyExit`.
 *  Necessary because `runUntil` is sync — it never yields to the JS event
 *  loop, so async bootstrap microtasks won't settle inside it. */
async function settleLobbyExit(sc: Scenario): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 10; i++) await Promise.resolve();
  sc.runUntil(() => sc.mode() !== Mode.LOBBY, { timeoutMs: 500 });
}
