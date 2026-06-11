import { assert, assertEquals, assertGreater } from "@std/assert";
import {
  createScenario,
  loadSeed,
  pressKeyAndSettle,
  settleLobbyExit,
  waitForModifier,
  waitForPhase,
  waitUntilRound,
} from "./scenario.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { LOBBY_TIMER } from "../src/shared/core/game-constants.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { isPlayerAlive } from "../src/shared/core/player-types.ts";
import { PLAYER_KEY_BINDINGS } from "../src/shared/ui/player-config.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";
import { packTile, unpackTile } from "../src/shared/core/spatial.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  type TileKey,
} from "../src/shared/core/grid.ts";
import { diffAsciiSnapshots } from "../dev/dev-console-grid.ts";
import { MESSAGE } from "../src/protocol/protocol.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";

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
  // BANNER_HIDDEN + BANNER_REPLACED together cover every way a banner
  // leaves the screen (explicit hide vs overwrite by next banner).
  sc.bus.on(GAME_EVENT.BANNER_HIDDEN, (ev) => {
    ends.push({ text: ev.text, phase: ev.phase });
  });
  sc.bus.on(GAME_EVENT.BANNER_REPLACED, (ev) => {
    ends.push({ text: ev.prevText, phase: ev.phase });
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

Deno.test("scenario: asciiSnapshot supports playerFilter + cropTo for compact agent snapshots", async () => {
  const sc = await createScenario({ seed: 42, rounds: 3, renderer: "ascii" });
  const ascii = sc.renderer!;
  waitForPhase(sc, Phase.BATTLE);

  const player = sc.state.players.find(
    (p) => p.walls.size > 0 && p.interior.size > 0,
  );
  assert(player !== undefined, "expected a player with walls + interior");

  const otherWalls = sc.state.players
    .filter((current) => current.id !== player.id)
    .reduce((sum, current) => sum + current.walls.size, 0);
  assertGreater(otherWalls, 0, "test needs at least one other player with walls");

  // Compare grid-body '#' counts before/after filtering. Filtering by
  // player should drop exactly the OTHER players' wall chars; the legend
  // also contains a literal '#', so we compare the diff rather than
  // absolute totals.
  const full = ascii.snapshot({ layer: "walls" });
  const filtered = ascii.snapshot({ layer: "walls", playerFilter: player.id });
  const fullWallChars = (full.match(/#/g) ?? []).length;
  const filteredWallChars = (filtered.match(/#/g) ?? []).length;
  assertEquals(
    fullWallChars - filteredWallChars,
    otherWalls,
    "playerFilter should drop exactly the OTHER players' wall chars",
  );

  // cropTo: token-savings goal. The cropped snapshot is strictly smaller
  // and still preserves absolute row indices in coord mode so agents can
  // cite tiles by position.
  const cropped = ascii.snapshot({
    layer: "walls",
    coords: true,
    playerFilter: player.id,
    cropTo: player.id,
  });
  assert(
    cropped.length < full.length,
    `cropTo should shrink the snapshot (cropped=${cropped.length}, full=${full.length})`,
  );
  const wallTileKey = player.walls.values().next().value as TileKey;
  const { row } = unpackTile(wallTileKey);
  assert(
    new RegExp(`(^|\\n)\\s*${row} \\S`).test(cropped),
    `cropped snapshot should retain absolute row label for row ${row}`,
  );
});

Deno.test("scenario: cropTo Rect clamps to grid bounds (no whitespace padding past edges)", async () => {
  // Regression: previously a cropTo rect with maxCol >= GRID_COLS or maxRow >=
  // GRID_ROWS rendered out-of-bounds cells as whitespace and produced a coord
  // header with digits for nonexistent tile positions. resolveCropRect now
  // clamps to [0, GRID-1] before formatting.
  const sc = await createScenario({ seed: 42, rounds: 2, renderer: "ascii" });
  const ascii = sc.renderer!;
  waitForPhase(sc, Phase.BATTLE);
  const out = ascii.snapshot({
    coords: true,
    cropTo: {
      minRow: 0,
      maxRow: GRID_ROWS - 1 + 5,
      minCol: 0,
      maxCol: GRID_COLS - 1 + 5,
    },
  });
  // After clamping, every body row should be exactly GRID_COLS chars of
  // grid content following the `<row-label> ` prefix (no trailing
  // whitespace from out-of-bounds columns).
  const bodyRows = out
    .split("\n")
    .filter((line) => /^\s*\d+ [^\d\s]/.test(line));
  assertGreater(bodyRows.length, 0, "expected body rows in coord-mode output");
  for (const row of bodyRows) {
    const inner = row.replace(/^\s*\d+ /, "");
    assertEquals(
      inner.length,
      GRID_COLS,
      `body row "${row}" should be exactly GRID_COLS=${GRID_COLS} chars after clamp`,
    );
  }
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
  const { row: wallRow, col: wallCol } = unpackTile(wallKey);
  const wallInspect = sc.tileAt(wallRow, wallCol);
  assert(
    wallInspect.wall?.playerId === player.id,
    `wall owner mismatch: expected ${player.id}, got ${wallInspect.wall?.playerId}`,
  );

  // Sample an interior tile — inspection should report interior ownership
  // and a valid zone id.
  const interiorKey = player.interior.values().next().value!;
  const { row: interiorRow, col: interiorCol } = unpackTile(interiorKey);
  const interiorInspect = sc.tileAt(interiorRow, interiorCol);
  assert(
    interiorInspect.interior.includes(player.id),
    `interior owner missing: ${interiorInspect.interior.join(",")}`,
  );
  assert(interiorInspect.zone !== null, "expected non-null zone");
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
  "scenario: piece on house spawns grunt at house tile, no wall on that tile",
  async () => {
    // Original-Rampart parity: when a piece is placed on a house, the
    // house tile becomes a grunt (no wall is laid on that exact tile —
    // the grunt sits there). Other tiles of the piece still become walls.
    const sc = await createScenario({ seed: 42, rounds: 5 });

    const crushedTiles = new Set<TileKey>();
    const wallOnCrushedTile: TileKey[] = [];
    const gruntSpawnsAtCrushedTile = new Set<TileKey>();

    sc.bus.on(GAME_EVENT.HOUSE_CRUSHED, (ev) => {
      const key = packTile(ev.row, ev.col);
      crushedTiles.add(key);
      // The HOUSE_CRUSHED event fires inside applyPiecePlacement AFTER
      // addPlayerWalls. After the fix the placement code excludes the
      // house tile from the wall set, so no player should have a wall
      // at that key when this listener runs.
      if (sc.state.players.some((player) => player.walls.has(key))) {
        wallOnCrushedTile.push(key);
      }
    });

    sc.bus.on(GAME_EVENT.GRUNT_SPAWN, (ev) => {
      const key = packTile(ev.row, ev.col);
      if (crushedTiles.has(key)) {
        gruntSpawnsAtCrushedTile.add(key);
      }
    });

    try {
      waitUntilRound(sc, 5, { timeoutMs: 480_000 });
    } catch (_e) {
      // Game-over before round 5 is fine — we just need enough crushes.
    }

    assertGreater(
      crushedTiles.size,
      0,
      "expected at least one HOUSE_CRUSHED across rounds 1–4",
    );
    assertEquals(
      wallOnCrushedTile.length,
      0,
      `walls should NOT be placed on crushed-house tiles (got ${wallOnCrushedTile.length})`,
    );
    assertEquals(
      gruntSpawnsAtCrushedTile.size,
      crushedTiles.size,
      `every crushed-house tile should get a grunt at that exact tile (${gruntSpawnsAtCrushedTile.size}/${crushedTiles.size})`,
    );
  },
);

Deno.test(
  "scenario: enclosing grunts emits gruntsEnclosed once per sealed pocket",
  async () => {
    // The `woodcrus` SFX is driven by `gruntsEnclosed`, one per connected
    // enclosed region that holds grunts. Multiple grunts in the same
    // pocket → one event with count > 1; two disjoint pockets sealed by
    // a single placement → two events.
    const sc = await createScenario({ seed: 42, rounds: 5 });

    const events: { playerId: number; count: number }[] = [];
    sc.bus.on(GAME_EVENT.GRUNTS_ENCLOSED, (ev) => {
      events.push({ playerId: ev.playerId, count: ev.count });
    });

    try {
      waitUntilRound(sc, 5, { timeoutMs: 480_000 });
    } catch (_e) {
      // Game-over before round 5 is fine.
    }

    assertGreater(
      events.length,
      0,
      "expected at least one gruntsEnclosed event across rounds 1–4",
    );
    for (const ev of events) {
      assertGreater(ev.count, 0, `gruntsEnclosed count must be ≥ 1, got ${ev.count}`);
    }
    // Seed 42 produces a multi-grunt pocket — proves grouping packs
    // peers into one event instead of splitting them into N count=1
    // events.
    assert(
      events.some((ev) => ev.count >= 2),
      `expected at least one multi-grunt pocket; counts=${events.map((event) => event.count).join(",")}`,
    );
  },
);

Deno.test(
  "scenario: assisted controller broadcasts placements through network.send",
  async () => {
    const sc = await createScenario({
      seed: 42,
      rounds: 3,
      assistedSlots: [1 as ValidPlayerId],
    });

    // Round 1 auto-builds castles in CASTLE_SELECT. The first player-driven
    // build phase is round 1's CLOSING WALL_BUILD (after BATTLE_1, before
    // round-end). Wait until round 2 starts (i.e. round-end of round 1
    // finalized) so the assisted slot's piece-placement broadcasts from
    // round 1's WALL_BUILD have all been emitted before assertions.
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
    // Simulate mobile — the reported bug ("auto-zoom still on after
    // quit") only reproduces when mobile auto-zoom was enabled during
    // the first game. Tests don't go through `setupTouchControls`, so
    // we enable the capability explicitly.
    sc.camera.enableMobileZoom();

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
      banner: (() => {
        const banner = sc.banner();
        return banner === null
          ? { active: false as const, progress: 0, text: "" }
          : { active: true as const, progress: banner.progress, text: banner.text };
      })(),
      camera: {
        cameraZone: sc.camera.getCameraZone(),
        pitch: sc.camera.getPitch(),
        pitchState: sc.camera.getPitchState(),
        // Viewport changes on zone zoom; compare only "is there a
        // cropped viewport" (truthy) rather than the exact rect,
        // which legitimately shifts with player positions.
        hasViewport: sc.camera.getViewport() !== undefined,
        autoZoomOn: sc.camera.isMobileAutoZoom(),
      },
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

    // Auto-zoom contract during the post-quit all-AI game: even though
    // `mobileZoomEnabled` is still true from earlier and `zoomActivated`
    // is re-armed by `resetCamera`, none of the zoom-engagement paths
    // should fire a zone zoom — `hasPointerPlayer` is false (nobody
    // joined the lobby, every controller is an AI), and every
    // zoom-engaging helper is supposed to gate on that.
    //
    // The user's reported symptom ("auto-zoom active during the game
    // played by AIs after the max. 15s on the lobby screen") is
    // exactly this contract being violated. Drive the post-rematch
    // all-AI game to battle and assert the camera never engaged a
    // cropped viewport nor picked a cameraZone.
    let sawCameraZone = false;
    let sawPitch = false;
    let sawCroppedViewport = false;
    sc.runUntil(
      () => {
        if (sc.camera.getCameraZone() !== undefined) sawCameraZone = true;
        if (sc.camera.getPitch() !== 0) sawPitch = true;
        if (sc.camera.getViewport() !== undefined) sawCroppedViewport = true;
        return sc.state.phase === Phase.BATTLE;
      },
      { timeoutMs: 120_000 },
    );

    assert(
      !sawCameraZone,
      "all-AI game must never set a cameraZone (no human to follow)",
    );
    assert(
      !sawPitch,
      "all-AI game must never pitch the camera (battle tilt is a human-viewer cue)",
    );
    assert(
      !sawCroppedViewport,
      "all-AI game must stay at fullMapVp throughout (no cropped viewport)",
    );
  },
);

Deno.test("scenario: ai-build-diag wall-placed hook fires", async () => {
  // Smoke test for commit 3 of the build-phase diagnostic instrumentation.
  // Confirms the wall-placed event reaches a subscribed handler with non-empty
  // cells + a piece-shape name during a real build phase. Doesn't assert
  // gap-hit rates or counts — those vary per seed; this is a wiring check.
  const { setAiBuildDiagHook } = await import("../src/ai/ai-build-diag.ts");
  // Need rounds ≥ 2 so the second round's WALL_BUILD enters; default is 3.
  const sc = await createScenario({ seed: 42, rounds: 3 });
  let wallPlaced = 0;
  let cellsSeen = 0;
  let sawPieceName = false;
  setAiBuildDiagHook((event) => {
    if (event.kind !== "wall-placed") return;
    wallPlaced++;
    cellsSeen += event.cells.length;
    if (event.pieceShapeName.length > 0) sawPieceName = true;
  });
  try {
    // First WALL_BUILD fires at end of round 1 (after the auto-castle +
    // cannon-place + battle); skip past it to CANNON_PLACE of round 2 to
    // be sure we observed the entire phase's AI placements.
    waitForPhase(sc, Phase.WALL_BUILD);
    waitForPhase(sc, Phase.CANNON_PLACE);
  } finally {
    setAiBuildDiagHook(undefined);
  }
  assertGreater(wallPlaced, 0, "wall-placed events should fire during build");
  assertGreater(cellsSeen, 0, "wall-placed events should carry cell tiles");
  assert(sawPieceName, "wall-placed events should carry piece shape name");
});

Deno.test(
  "scenario: life-lost ABANDON that leaves one player alive ends the game immediately",
  async () => {
    // Two keyboard humans + one AI, joined through the real lobby input
    // path. The humans idle through every phase, so battle damage breaks
    // their auto-built castles and each eventually gets a life-lost
    // dialog; the test ABANDONs every dialog through the keyboard path.
    // When an abandon drops the alive count to one, the post-dialog
    // recheck in routeLifeLostResolution must end the game right there —
    // not after the surviving AI plays a full pointless solo round.
    using sc = await createScenario({
      seed: 42,
      rounds: 15,
      autoStartGame: false,
    });

    const p0 = PLAYER_KEY_BINDINGS[0]!;
    const p1 = PLAYER_KEY_BINDINGS[1]!;

    // Join P0 + P1 via their confirm keys, then spam P0's to skip the
    // lobby timer (same path as the input-lobby key-join test).
    await pressKeyAndSettle(sc, p0.confirm);
    await pressKeyAndSettle(sc, p1.confirm);
    for (let i = 0; i <= LOBBY_TIMER; i++) {
      await pressKeyAndSettle(sc, p0.confirm);
    }
    sc.runUntil(() => !sc.lobbyActive(), { timeoutMs: LOBBY_TIMER * 1000 });
    await settleLobbyExit(sc);

    let winner = -1;
    sc.bus.on(GAME_EVENT.GAME_END, (ev) => {
      winner = ev.winner;
    });
    const gameEnded = () => winner !== -1;
    const aliveIds = () =>
      sc.state.players.filter(isPlayerAlive).map((p) => p.id);

    // Abandon every life-lost dialog until one of them is terminal. Keys
    // for a player with no pending entry are no-ops, so both humans'
    // ABANDON sequences are sent at every dialog regardless of whose
    // life was lost; AI entries auto-resolve CONTINUE on their own.
    for (let dialogs = 0; dialogs < 20 && !gameEnded(); dialogs++) {
      sc.runUntil(() => sc.mode() === Mode.LIFE_LOST || gameEnded(), {
        timeoutMs: 600_000,
      });
      if (gameEnded()) break;
      await pressKeyAndSettle(sc, p0.left);
      await pressKeyAndSettle(sc, p0.confirm);
      await pressKeyAndSettle(sc, p1.left);
      await pressKeyAndSettle(sc, p1.confirm);
      sc.runUntil(() => sc.mode() !== Mode.LIFE_LOST || gameEnded(), {
        timeoutMs: 60_000,
      });
      if (aliveIds().length <= 1) {
        // Terminal dialog: the recheck must end the game before any
        // further phase — without it the lone AI plays a full solo
        // round (cannon → battle → build) before the next round-end
        // notices last-player-standing.
        sc.runUntil(
          () => gameEnded() || sc.state.phase === Phase.CANNON_PLACE,
          { timeoutMs: 60_000 },
        );
        assert(
          gameEnded(),
          "GAME_END must fire directly after the eliminating dialog",
        );
        assert(
          sc.state.phase !== Phase.CANNON_PLACE,
          "the lone survivor must not play another round",
        );
        assertEquals(
          winner,
          aliveIds()[0],
          "the sole alive player wins last-player-standing",
        );
        return;
      }
    }
    assert(
      false,
      `expected an eliminating ABANDON dialog before game end (winner=${winner})`,
    );
  },
);

Deno.test("scenario: select announcement plays at game start and is skipped on reselect", async () => {
  const sc = await loadSeed("selection:reselect-cycle");

  // Game-start cycle: the BANNER_SELECT announcement window holds the
  // phase timer at 0 before the countdown starts (tickSelection stage A).
  assertEquals(sc.state.phase, Phase.CASTLE_SELECT);
  assertEquals(sc.state.round, 1);
  sc.tick(2);
  assertEquals(
    sc.state.timer,
    0,
    "game-start selection holds the timer at 0 during the announcement window",
  );

  // Reach a reselect cycle: a player lost a life (CONTINUE) and re-picks
  // a castle at round > 1 — the seed condition guarantees one occurs.
  sc.runUntil(
    () => sc.state.phase === Phase.CASTLE_SELECT && sc.state.round > 1,
    { timeoutMs: 1_200_000 },
  );
  // The countdown must start immediately: reselect cycles skip the
  // announcement (armed consumed at entry). A replayed announcement
  // would hold the timer at 0 for a full window, offsetting this peer's
  // selection ticks from every other peer online.
  sc.tick(2);
  assertGreater(
    sc.state.timer,
    0,
    "reselect skips the announcement; the selection countdown starts immediately",
  );
});
