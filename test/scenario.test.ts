import { assert, assertEquals, assertGreater } from "@std/assert";
import {
  createScenario,
  waitForModifier,
  waitForPhase,
  waitUntilRound,
} from "./scenario.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { unpackTile } from "../src/shared/core/spatial.ts";
import { diffAsciiSnapshots } from "../src/runtime/dev-console-grid.ts";
import { MESSAGE } from "../src/protocol/protocol.ts";
import type { ValidPlayerSlot } from "../src/shared/core/player-slot.ts";

Deno.test("scenario: boots from a seed and exposes game state", async () => {
  const sc = await createScenario({ seed: 42 });

  // After construction the runtime has a real GameState (not the sentinel)
  // and is in an active gameplay mode.
  assert(sc.state.players.length > 0);
  assertGreater(sc.state.map.tiles.length, 0);
});

Deno.test("scenario: waitForPhase reaches BATTLE in a fresh game", async () => {
  const sc = await createScenario({ seed: 42 });
  const ev = waitForPhase(sc, Phase.BATTLE);
  assert(ev.phase === Phase.BATTLE);
  assertGreater(ev.round, 0);
});

Deno.test("scenario: bus emits banner lifecycle events", async () => {
  const sc = await createScenario({ seed: 42 });
  const starts: { text: string; phase: Phase }[] = [];
  const ends: { text: string; phase: Phase }[] = [];
  sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
    starts.push({ text: ev.text, phase: ev.phase });
  });
  sc.bus.on(GAME_EVENT.BANNER_END, (ev) => {
    ends.push({ text: ev.text, phase: ev.phase });
  });

  // Drive to first battle so multiple banners play out.
  waitForPhase(sc, Phase.BATTLE);

  assertGreater(starts.length, 0);
  // Every start must be matched by (or pending) an end.
  assert(
    starts.length >= ends.length,
    `start/end mismatch: starts=${starts.length} ends=${ends.length}`,
  );
});

Deno.test("scenario: waitForModifier captures a MODIFIER_APPLIED event in modern mode", async () => {
  const sc = await createScenario({
    seed: 7,
    mode: "modern",
    rounds: 6,
  });
  const ev = waitForModifier(sc, undefined, { timeoutMs: 480_000 });
  assert(ev.modifierId !== undefined);
  assertGreater(ev.round, 0);
});

Deno.test("scenario: diffAsciiSnapshots lists tile changes across phases", async () => {
  const sc = await createScenario({ seed: 42, rounds: 2, renderer: "ascii" });
  const ascii = sc.renderer!;

  // Snapshot at game start (no walls / cannons yet), then again once the
  // first battle begins. The diff should surface new walls, cannons, and
  // other entities introduced during round 1.
  const before = ascii.snapshot("all");
  waitForPhase(sc, Phase.BATTLE);
  const after = ascii.snapshot("all");

  const diff = diffAsciiSnapshots(before, after);
  assert(
    diff !== "(no tile differences)" && diff.includes("→"),
    `expected tile transitions in diff, got: ${diff.slice(0, 200)}`,
  );
});

Deno.test("scenario: tileAt inspects a walled-in interior tile", async () => {
  const sc = await createScenario({ seed: 42, rounds: 3 });
  waitForPhase(sc, Phase.BATTLE);

  // Pick a player that has both walls and interior after build.
  const player = sc.state.players.find(
    (p) => p.walls.size > 0 && p.interior.size > 0,
  );
  assert(player !== undefined, "expected a player with walls + interior");

  // Sample a wall tile — inspection should report the wall owner.
  const wallKey = player.walls.values().next().value!;
  const { r: wallRow, c: wallCol } = unpackTile(wallKey);
  const wallInspect = sc.tileAt(wallRow, wallCol);
  assert(
    wallInspect.wall?.playerId === player.id,
    `wall owner mismatch: expected ${player.id}, got ${wallInspect.wall?.playerId}`,
  );

  // Sample an interior tile — inspection should report interior ownership
  // and a valid zone id.
  const interiorKey = player.interior.values().next().value!;
  const { r: interiorRow, c: interiorCol } = unpackTile(interiorKey);
  const interiorInspect = sc.tileAt(interiorRow, interiorCol);
  assert(
    interiorInspect.interior.includes(player.id),
    `interior owner missing: ${interiorInspect.interior.join(",")}`,
  );
  assert(interiorInspect.zone !== null, "expected non-null zone");
});

Deno.test("scenario: entities present during banner sweeps", async () => {
  const sc = await createScenario({ seed: 42, rounds: 1 });

  let towersSeenDuringBanner = false;
  let housesSeenDuringBanner = false;
  let cannonsSeenDuringBanner = false;

  sc.bus.on(GAME_EVENT.BANNER_START, () => {
    if (sc.state.towerAlive.some(Boolean)) {
      towersSeenDuringBanner = true;
    }
    if (sc.state.map.houses.some((house) => house.alive)) {
      housesSeenDuringBanner = true;
    }
    if (sc.state.players.some((player) => player.cannons.length > 0)) {
      cannonsSeenDuringBanner = true;
    }
  });

  sc.runGame({ timeoutMs: 600_000 });

  assert(towersSeenDuringBanner, "towers should be present during at least one banner");
  assert(housesSeenDuringBanner, "houses should be present during at least one banner");
  assert(cannonsSeenDuringBanner, "cannons should be present during at least one banner");
});

Deno.test("scenario: runGame plays a full game to completion", async () => {
  const sc = await createScenario({ seed: 42, rounds: 2 });
  sc.runGame({ timeoutMs: 600_000 });
  assert(
    sc.state.round >= 1,
    `expected at least 1 round played, got round=${sc.state.round}`,
  );
  // The runtime should have reached the final state (game over banner or stopped).
  const reducedToOne =
    sc.state.players.filter((player) => !player.eliminated).length <= 1;
  assert(
    sc.state.players.some((player) => player.eliminated) ||
      reducedToOne ||
      sc.state.round >= 2,
    "expected game to progress past round 1",
  );
});

Deno.test(
  "scenario: assisted controller broadcasts placements through network.send",
  async () => {
    const sc = await createScenario({ seed: 42, rounds: 3 });
    await sc.installAssistedController(1 as ValidPlayerSlot);

    // Round 1 auto-builds castles (WALL_BUILD skipped), so drive to round 2+
    // to exercise the real build phase before checking message broadcasts.
    waitUntilRound(sc, 2, { timeoutMs: 120_000 });
    waitForPhase(sc, Phase.BATTLE, { timeoutMs: 120_000 });

    const placedByPlayer = new Map<number, number>();
    const cannonByPlayer = new Map<number, number>();
    for (const msg of sc.sentMessages) {
      if (msg.type === MESSAGE.OPPONENT_PIECE_PLACED) {
        placedByPlayer.set(
          msg.playerId,
          (placedByPlayer.get(msg.playerId) ?? 0) + 1,
        );
      } else if (msg.type === MESSAGE.OPPONENT_CANNON_PLACED) {
        cannonByPlayer.set(
          msg.playerId,
          (cannonByPlayer.get(msg.playerId) ?? 0) + 1,
        );
      }
    }

    // Slot 1 is assisted → broadcasts per-intent (one message per placement,
    // with the piece's real row/col). Slot 0 (pure AI) also produces some
    // OPPONENT_PIECE_PLACED traffic but via a different mechanism
    // (host-side wall diff after buildTick, with dummy row/col=0).
    assertGreater(
      placedByPlayer.get(1) ?? 0,
      0,
      "assisted slot should broadcast OPPONENT_PIECE_PLACED",
    );
    assertGreater(
      cannonByPlayer.get(1) ?? 0,
      0,
      "assisted slot should broadcast OPPONENT_CANNON_PLACED",
    );
    // Per-intent messages carry the real placement row/col (not 0,0 dummies
    // the AI wall-diff path uses). This distinguishes the assisted pipeline.
    const assistedPlacements = sc.sentMessages.filter(
      (msg) =>
        msg.type === MESSAGE.OPPONENT_PIECE_PLACED &&
        msg.playerId === 1 &&
        (msg.row !== 0 || msg.col !== 0),
    );
    assertGreater(
      assistedPlacements.length,
      0,
      "assisted slot should produce per-intent placement messages with real coords",
    );
  },
);

Deno.test(
  "scenario: ESC + rematch returns all transient state to initial",
  async () => {
    // Generic reset-contract test. Snapshot every piece of per-game
    // transient state observable from the Scenario API at game start,
    // drive real gameplay that DOES mutate those fields, quit via ESC,
    // start a fresh game, snapshot again, assert equal.
    //
    // Any field that leaks across match boundaries — banner, dialogs,
    // score deltas, phase/round counters, eliminated flags, map version
    // sanity — will fail this test without needing a per-field check.
    // The "towers on water" regression (mapVersion resetting to 0)
    // would have tripped the `mapVersion > first` rail below.
    const sc = await createScenario({ seed: 42 });

    const snapshot = () => ({
      phase: sc.state.phase,
      round: sc.state.round,
      timer: Math.round(sc.state.timer * 100) / 100,
      playerLives: sc.state.players.map((player) => player.lives),
      playerScores: sc.state.players.map((player) => player.score),
      playerEliminated: sc.state.players.map((player) => player.eliminated),
      playerCannonCounts: sc.state.players.map((player) =>
        player.cannons.length,
      ),
      playerWallCounts: sc.state.players.map((player) => player.walls.size),
      towerAlive: [...sc.state.towerAlive],
      houseCount: sc.state.map.houses.length,
      banner: {
        active: sc.banner().active,
        progress: sc.banner().progress,
        text: sc.banner().text,
      },
      lobbyActive: sc.lobbyActive(),
    });

    const initial = snapshot();

    // Sanity: game is at its earliest observable point.
    assert(
      initial.round === 1,
      `initial round expected 1, got ${initial.round}`,
    );
    assert(
      initial.phase === Phase.CASTLE_SELECT,
      `initial phase expected CASTLE_SELECT, got ${initial.phase}`,
    );

    // Drive far enough to mutate many fields the reset path must wipe —
    // banners fired, cannons placed, a battle entered, scores moved.
    waitForPhase(sc, Phase.BATTLE);

    const mid = snapshot();
    // Cheap self-check that the snapshot actually changed so we're not
    // comparing two identical pre-play states by accident.
    assert(
      JSON.stringify(mid) !== JSON.stringify(initial),
      "precondition: snapshot should differ after reaching BATTLE",
    );

    // The regression bug this test directly protects against: the map's
    // cache-invalidation stamp must bump when a new game starts, so the
    // renderer's terrain cache rebuilds. Without it, the new game's
    // towers sit on the previous game's water — "towers on water".
    const mapVersionBeforeQuit = sc.state.map.mapVersion;
    assertGreater(
      mapVersionBeforeQuit,
      0,
      "map should carry a non-zero version by the time we reach BATTLE",
    );

    // Quit via real input path (ESC) — `dispatchQuit` → `showLobby` →
    // `lifecycle.returnToLobby`. No human controllers in headless means
    // dispatchQuit takes the immediate-quit branch (no "press again"
    // warning), same as the production touch ✕ button path.
    sc.input.pressKey("Escape");
    // The keyboard handler is async (it awaits `handleKeyF1` before
    // reaching the ESC branch), so the synchronous `pressKey` returns
    // before `returnToLobby` fires. Drain the microtask queue so the
    // ESC-triggered lifecycle work completes before we move on.
    await Promise.resolve();

    // Bootstrap a fresh game, equivalent to joining a slot in the lobby.
    await sc.rematch();

    const afterReset = snapshot();
    assertEquals(
      afterReset,
      initial,
      "snapshot must match the initial pre-play state after quit + rematch",
    );

    // Map-version specific rail: identity has changed AND version bumped.
    assertGreater(
      sc.state.map.mapVersion,
      mapVersionBeforeQuit,
      `mapVersion must advance past ${mapVersionBeforeQuit} on rematch (got ${sc.state.map.mapVersion})`,
    );
  },
);
