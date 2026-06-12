import { assert, assertEquals } from "@std/assert";
import { computeLobbyLayout } from "../src/render/render-ui-overlays.ts";
import {
  LOBBY_TIMER,
  SELECT_ANNOUNCEMENT_DURATION,
} from "../src/shared/core/game-constants.ts";
import { MAP_PX_H, MAP_PX_W, SCALE } from "../src/shared/core/grid.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";
import { MAX_PLAYERS } from "../src/shared/ui/player-config.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";
import {
  clickAndSettle,
  createScenario,
  pressKeyAndSettle,
  waitForPhase,
} from "./scenario.ts";

Deno.test(
  "selection zoom: mobile auto-zoom engages once the selection announcement ends",
  async () => {
    using sc = await createScenario({
      seed: 42,
      assistedSlots: [0 as ValidPlayerId],
      mobileZoomEnabled: true,
    });

    assert(
      sc.state.phase === Phase.CASTLE_SELECT,
      `expected CASTLE_SELECT, got ${Phase[sc.state.phase]}`,
    );
    assert(sc.mode() === Mode.SELECTION, `expected SELECTION mode`);
    assert(
      sc.camera.isMobileAutoZoom(),
      "mobile auto-zoom must be active (assistedSlots[0] is human + mobileZoomEnabled)",
    );

    // Wait for the auto-zoom to crop the viewport once the "Select your
    // home castle" announcement ends and handleSelectionZoom + the viewport
    // lerp engage. Budget covers the announcement plus a margin.
    sc.runUntil(
      () => {
        const vp = sc.camera.getViewport();
        return vp !== undefined && vp.w < MAP_PX_W;
      },
      { timeoutMs: (SELECT_ANNOUNCEMENT_DURATION + 2) * 1000 },
    );

    const vp = sc.camera.getViewport();
    assert(
      vp !== undefined && vp.w < MAP_PX_W,
      `expected a cropped viewport (w < ${MAP_PX_W}) after announcement, got ${JSON.stringify(vp)}`,
    );
  },
);

// Round-1 cold-start regression: in production the game starts from the
// LOBBY, and rAF keeps firing during bootstrapGame's awaits (AI chunk
// load, controller construction). Each of those lobby substeps refreshes
// the pointer-player per-frame cache while the session is not yet live;
// `enterTowerSelection` then runs BETWEEN frames, after setState +
// setMode(SELECTION) made it live. When the lookup memoized the lobby
// tick's not-live null, selection read a stale null pointer player and
// never parked the round-1 selection viewport — mobile auto-zoom
// silently skipped. The direct-boot test above can't catch this
// (createScenario's awaits run no substeps), so this one drives the
// lobby path and interleaves single microtask turns with single ticks: a
// poisoning substep is guaranteed to land between bootstrap's awaits.
Deno.test(
  "selection zoom: round-1 auto-zoom survives lobby substeps during bootstrap",
  async () => {
    using sc = await createScenario({
      seed: 42,
      autoStartGame: false,
      mobileZoomEnabled: true,
    });
    assertEquals(sc.mode(), Mode.LOBBY, "expected to start in LOBBY mode");

    // Join slot 0 as the mouse-driven human, then spam-skip the lobby
    // timer down to the lockout (same incantation as input-lobby.test.ts).
    const slot0 = slotCenterCanvas(0);
    sc.input.click(slot0.x, slot0.y);
    for (let i = 0; i < LOBBY_TIMER; i++) {
      await clickAndSettle(sc, slot0.x, slot0.y);
    }
    sc.runUntil(() => !sc.lobbyActive(), { timeoutMs: LOBBY_TIMER * 1000 });

    // Bootstrap is now in flight (fired by the lobby-expiry tick).
    // One microtask turn per iteration interleaves my tick with exactly
    // one bootstrap await-hop (microtask FIFO), so a tick lands between
    // hops when the AI modules are already cached; the periodic
    // macrotask turn lets a cold dynamic import settle while the ticks
    // keep refreshing the frame cache.
    for (let i = 0; i < 300 && sc.mode() !== Mode.SELECTION; i++) {
      if (i % 5 === 4) await new Promise((resolve) => setTimeout(resolve, 0));
      else await Promise.resolve();
      sc.tick(1);
    }
    assertEquals(sc.mode(), Mode.SELECTION, "bootstrap should have finished");
    assert(
      sc.camera.isMobileAutoZoom(),
      "mobile auto-zoom must be active (joined human + mobileZoomEnabled)",
    );

    // Pre-fix, the stale null skipped the viewport park and this wait
    // times out — the announcement ends but no crop ever engages.
    sc.runUntil(
      () => {
        const vp = sc.camera.getViewport();
        return vp !== undefined && vp.w < MAP_PX_W;
      },
      { timeoutMs: (SELECT_ANNOUNCEMENT_DURATION + 2) * 1000 },
    );
  },
);

// Teardown regression: quitting (or game-over) mid-battle previously left
// `pitch.current` at the battle tilt — `clearAllZoomState` deliberately
// preserved rendered-frame state, but the lobby and game-over screens
// render `getPitch()` unconditionally and nothing ever eases it back
// (Mode.STOPPED never ticks the anim; the lobby has no untilt owner), so
// the board drew at the 30° battle tilt indefinitely.
Deno.test(
  "camera: quitting mid-battle snaps the pitch flat for the lobby",
  async () => {
    using sc = await createScenario({ seed: 42, mode: "classic", rounds: 3 });
    waitForPhase(sc, Phase.BATTLE);
    sc.runUntil(() => sc.camera.getPitchState() === "tilted", {
      timeoutMs: 30_000,
    });

    // Double-ESC: arm the quit countdown, then confirm — routes through
    // lifecycle.returnToLobby → teardownSession → clearAllZoomState.
    await pressKeyAndSettle(sc, "Escape");
    await pressKeyAndSettle(sc, "Escape");
    assertEquals(sc.mode(), Mode.LOBBY, "double-ESC should quit to the lobby");
    assertEquals(
      sc.camera.getPitch(),
      0,
      "teardown must snap the battle tilt flat — nothing eases it after " +
        "the session dies",
    );
  },
);

function slotCenterCanvas(slotIndex: number): { x: number; y: number } {
  const layout = computeLobbyLayout(MAP_PX_W, MAP_PX_H, MAX_PLAYERS);
  const tileX =
    layout.gap + slotIndex * (layout.rectW + layout.gap) + layout.rectW / 2;
  const tileY = layout.rectY + layout.rectH / 2;
  return { x: tileX * SCALE, y: tileY * SCALE };
}
