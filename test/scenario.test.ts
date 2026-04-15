import { assert, assertGreater } from "@std/assert";
import {
  createScenario,
  waitForModifier,
  waitForPhase,
  waitUntilRound,
} from "./scenario.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { packTile, unpackTile } from "../src/shared/core/spatial.ts";
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

Deno.test("scenario: house destroyed by wall placement spawns grunt nearby", async () => {
  const sc = await createScenario({ seed: 1, rounds: 3 });

  // Track house positions and grunt spawns during build phases.
  const houseGruntDistances: number[] = [];
  let liveHouseKeys = new Map<number, { row: number; col: number }>();
  let pendingHouses: { row: number; col: number }[] = [];
  let inBuild = false;

  sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
    inBuild = ev.phase === Phase.WALL_BUILD;
    if (inBuild) {
      liveHouseKeys = new Map(
        sc.state.map.houses
          .filter((h) => h.alive)
          .map((h) => [packTile(h.row, h.col), { row: h.row, col: h.col }]),
      );
      pendingHouses = [];
    }
  });

  sc.bus.on(GAME_EVENT.WALL_PLACED, (ev) => {
    if (!inBuild) return;
    for (const key of ev.tileKeys) {
      const house = liveHouseKeys.get(key);
      if (house) {
        pendingHouses.push(house);
        liveHouseKeys.delete(key);
      }
    }
  });

  sc.bus.on(GAME_EVENT.GRUNT_SPAWN, (ev) => {
    if (!inBuild || pendingHouses.length === 0) return;
    const house = pendingHouses.shift()!;
    const dist = Math.abs(ev.row - house.row) + Math.abs(ev.col - house.col);
    houseGruntDistances.push(dist);
  });

  sc.runGame({ timeoutMs: 600_000 });

  assertGreater(
    houseGruntDistances.length,
    0,
    "expected at least one house destroyed by wall placement",
  );
  for (const dist of houseGruntDistances) {
    assert(
      dist <= 8,
      `grunt spawned ${dist} tiles from destroyed house (max 8)`,
    );
  }
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
