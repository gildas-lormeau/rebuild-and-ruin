/**
 * E2E example: simple game lifecycle assertions.
 *
 * Demonstrates the createE2EScenario API — same pattern as headless
 * createScenario, just async.
 *
 * Run: deno test --no-check -A test/e2e-example.ts
 * Requires: npm run dev (vite on port 5173)
 * Online test also requires: deno task server (port 8001)
 */

import { assert, assertEquals, assertGreater } from "@std/assert";
import {
  createE2EScenario,
  GAME_EVENT,
  waitForPhase,
} from "./e2e-scenario.ts";
import { Phase } from "../src/shared/core/game-phase.ts";

Deno.test("e2e: full game plays to completion with banners", async () => {
  // `await using` pairs with the E2EScenario's Symbol.asyncDispose —
  // the browser is closed when the binding goes out of scope, even if
  // an assertion throws. Same ergonomics as `using sc = ...` in
  // headless tests.
  await using sc = await createE2EScenario({
    seed: 42,
    humans: 0,
    headless: true,
    rounds: 1,
  });

  const bannerTexts: string[] = [];
  sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
    bannerTexts.push(ev.text);
  });

  await sc.runGame();

  assertGreater(bannerTexts.length, 0, "expected at least one banner");
  assert(
    bannerTexts.some((text) => text.includes("Cannon")),
    `expected a cannon banner, got: ${bannerTexts.join(", ")}`,
  );
});

Deno.test("e2e: runUntil stops at first battle phase", async () => {
  await using sc = await createE2EScenario({
    seed: 42,
    humans: 0,
    headless: true,
    rounds: 3,
  });

  const phases: string[] = [];
  sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
    phases.push(ev.phase);
  });

  await waitForPhase(sc, Phase.BATTLE);

  const currentPhase = await sc.phase();
  assertEquals(currentPhase, Phase.BATTLE);
  assertGreater(phases.length, 0, "expected phaseStart events before battle");

  // gameState() returns the full GameState with Sets/Maps converted —
  // agents read player.lives / grunts.length / etc. the same way
  // headless tests do via `sc.state.*`.
  const game = await sc.gameState();
  assert(game !== null, "expected gameState once BATTLE starts");
  assertEquals(game.phase, Phase.BATTLE);
  assertGreater(game.players.length, 0, "expected players array populated");
});

Deno.test("e2e: asciiSnapshot has coordinate margins by default", async () => {
  await using sc = await createE2EScenario({
    seed: 42,
    humans: 0,
    headless: true,
    rounds: 1,
  });

  await waitForPhase(sc, Phase.BATTLE);

  // Default E2E format: coord margins on. Every body row is wrapped in
  // `  NN |…|` so agents can cite tiles by index, and a `+----…----+`
  // border sits above the grid.
  const withCoords = await sc.asciiSnapshot();
  assert(withCoords !== null, "expected snapshot once battle starts");
  const lines = withCoords.split("\n");
  assert(
    lines.some((line) => /^\s*\d+\s\|.*\|$/.test(line)),
    "expected at least one row wrapped in `  NN |…|` margins",
  );
  assert(
    lines.some((line) => /^\s*\+-+\+$/.test(line)),
    "expected a top border line",
  );

  // Opt out — output matches the headless AsciiRenderer (no margins,
  // no border).
  const plain = await sc.asciiSnapshot({ coords: false });
  assert(plain !== null);
  assert(
    !plain.split("\n").some((line) => /^\s*\+-+\+$/.test(line)),
    "plain snapshot should not contain a border line",
  );
});

Deno.test("e2e: two browsers play online with AI", async () => {
  // Host creates a room
  await using host = await createE2EScenario({
    headless: true,
    humans: 0,
    rounds: 1,
    online: "host",
  });

  const code = await host.roomCode();
  console.log(`  Room code: ${code}`);

  // Client joins the same room
  await using client = await createE2EScenario({
    headless: true,
    humans: 0,
    rounds: 1,
    online: "join",
    roomCode: code,
  });

  // Both observe game events
  const hostBanners: string[] = [];
  const clientBanners: string[] = [];
  host.bus.on(GAME_EVENT.BANNER_START, (ev) => hostBanners.push(ev.text));
  client.bus.on(GAME_EVENT.BANNER_START, (ev) => clientBanners.push(ev.text));

  // Both wait for game to finish
  await Promise.all([host.runGame(), client.runGame()]);

  assertGreater(hostBanners.length, 0, "host saw banners");
  assertGreater(clientBanners.length, 0, "client saw banners");
  console.log(`  Host banners: ${hostBanners.join(", ")}`);
  console.log(`  Client banners: ${clientBanners.join(", ")}`);
});
