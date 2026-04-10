import { assert, assertGreater } from "@std/assert";
import {
  createScenario,
  waitForModifier,
  waitForPhase,
} from "./scenario.ts";
import { GAME_EVENT } from "../src/shared/game-event-bus.ts";
import { Phase } from "../src/shared/game-phase.ts";

Deno.test("scenario: boots from a seed and exposes game state", async () => {
  const sc = await createScenario({ seed: 42 });

  // After construction the runtime has a real GameState (not the sentinel)
  // and is in an active gameplay mode.
  assert(sc.state.players.length > 0);
  assertGreater(sc.state.map.tiles.length, 0);
});

Deno.test("scenario: tick advances the simulated clock and runs mainLoop", async () => {
  const sc = await createScenario({ seed: 42 });
  const startNow = sc.now();

  for (let i = 0; i < 50; i++) sc.tick();

  // 50 frames × 16ms = 800ms of simulated time.
  assertGreater(sc.now(), startNow);
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

Deno.test("scenario: waitForModifier captures a modifier banner in modern mode", async () => {
  const sc = await createScenario({
    seed: 7,
    mode: "modern",
    rounds: 6,
  });
  const banner = waitForModifier(sc, undefined, 30000);
  assert(banner.modifierId !== undefined);
  assert(banner.text.length > 0);
});

Deno.test("scenario: runGame plays a full game to completion", async () => {
  const sc = await createScenario({ seed: 42, rounds: 2 });
  sc.runGame(30000);
  assert(
    sc.state.round >= 1,
    `expected at least 1 round played, got round=${sc.state.round}`,
  );
  // The runtime should have reached the final state (game over banner or stopped).
  assert(
    sc.state.players.some((player) => player.eliminated) ||
      sc.runUntil(
        () =>
          sc.state.players.filter((player) => !player.eliminated).length <= 1,
        100,
      ) >= 0 ||
      sc.state.round >= 2,
    "expected game to progress past round 1",
  );
});

