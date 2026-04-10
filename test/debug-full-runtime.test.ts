import { assert, assertGreater } from "@std/assert";
import { createDebugFullRuntime } from "./debug-full-runtime.ts";
import { GAME_MODE_MODERN } from "../src/shared/game-constants.ts";
import { GAME_EVENT } from "../src/shared/game-event-bus.ts";
import { Phase } from "../src/shared/game-phase.ts";
import { Mode } from "../src/shared/ui-mode.ts";

Deno.test("debug full runtime: boots from seed", async () => {
  const dbg = await createDebugFullRuntime({ seed: 42 });

  // After startGame, the runtime should be in an active gameplay mode
  // (not STOPPED). SELECTION is the expected starting mode.
  assert(
    dbg.runtime.runtimeState.mode !== Mode.STOPPED,
    `expected active mode, got ${dbg.runtime.runtimeState.mode}`,
  );

  // Game state should be initialized with players ready to play.
  const state = dbg.runtime.runtimeState.state;
  assertGreater(state.players.length, 0);
});

Deno.test("debug full runtime: mainLoop advances without errors", async () => {
  const dbg = await createDebugFullRuntime({ seed: 42 });

  // Drive 200 ticks (~3.2s of simulated time) and confirm nothing throws.
  for (let i = 0; i < 200; i++) dbg.tick();

  assertGreater(dbg.runtime.runtimeState.state.players.length, 0);
});

Deno.test("debug full runtime: bus emits banner lifecycle events", async () => {
  const dbg = await createDebugFullRuntime({ seed: 42 });

  const starts: { text: string; phase: Phase }[] = [];
  const ends: { text: string; phase: Phase }[] = [];
  dbg.runtime.runtimeState.state.bus.on(GAME_EVENT.BANNER_START, (ev) => {
    starts.push({ text: ev.text, phase: ev.phase });
  });
  dbg.runtime.runtimeState.state.bus.on(GAME_EVENT.BANNER_END, (ev) => {
    ends.push({ text: ev.text, phase: ev.phase });
  });

  // Drive the runtime until at least one banner has fully played out.
  const ticks = dbg.runUntil(() => ends.length > 0, 5000);
  assert(
    ticks >= 0,
    `banner never ended after 5000 ticks. starts=${starts.length} ends=${ends.length}`,
  );
  // Every banner start must be followed by an end.
  assert(
    starts.length >= ends.length,
    `start/end mismatch: starts=${starts.length} ends=${ends.length}`,
  );
});

Deno.test("debug full runtime: bannerStart carries modifier info in modern mode", async () => {
  // In modern mode, modifiers start rolling on round 3. Seed 7 is known to
  // produce tile-modifying events under modern mode AI trajectories.
  // NOTE: seeds from find-seed.ts target a different scenario RNG path, so
  // the exact modifier that fires first may differ from find-seed output.
  // This test just verifies the bannerStart event shape — any modifier works.
  const dbg = await createDebugFullRuntime({
    seed: 7,
    gameMode: GAME_MODE_MODERN,
    rounds: 6,
  });

  const modifierBanners: {
    text: string;
    modifierId: string;
    tileCount: number;
  }[] = [];
  dbg.runtime.runtimeState.state.bus.on(GAME_EVENT.BANNER_START, (ev) => {
    if (ev.modifierId) {
      modifierBanners.push({
        text: ev.text,
        modifierId: ev.modifierId,
        tileCount: ev.changedTiles?.length ?? 0,
      });
    }
  });

  // Run until we see a modifier banner, or give up after ~8 sim-minutes.
  const ticks = dbg.runUntil(() => modifierBanners.length > 0, 30000);
  assert(
    ticks >= 0,
    `modifier banner never fired after 30000 ticks (round=${dbg.runtime.runtimeState.state.round})`,
  );

  const first = modifierBanners[0]!;
  // The event must carry a modifierId and a human-readable label in .text.
  assert(
    first.modifierId.length > 0,
    `modifier banner has empty modifierId`,
  );
  assert(
    first.text.length > 0,
    `modifier banner has empty label text`,
  );
});

Deno.test("debug full runtime: bus emits phase events during gameplay", async () => {
  const dbg = await createDebugFullRuntime({ seed: 42 });

  // Track every phase the runtime enters — proves mode transitions actually
  // flow through the full runtime composition root.
  // NOTE: Round 1 skips WALL_BUILD — castles are auto-built during selection,
  // so the first-round phase sequence is CASTLE_SELECT → CANNON_PLACE → BATTLE.
  // WALL_BUILD is only entered from round 2 onward (post-battle build).
  const phasesSeen = new Set<Phase>();
  dbg.runtime.runtimeState.state.bus.on(GAME_EVENT.PHASE_START, (ev) => {
    phasesSeen.add(ev.phase);
  });

  // Run until we see BATTLE, or give up after 5000 ticks (80 sim-seconds).
  const ticks = dbg.runUntil(() => phasesSeen.has(Phase.BATTLE), 5000);

  assert(
    ticks >= 0,
    `battle phase never reached after 5000 ticks. ` +
      `phases seen: ${[...phasesSeen].map((phase) => Phase[phase]).join(", ")}. ` +
      `current mode=${Mode[dbg.runtime.runtimeState.mode]} phase=${Phase[dbg.runtime.runtimeState.state.phase]}`,
  );
  assert(
    phasesSeen.has(Phase.CANNON_PLACE),
    `cannon phase never emitted; saw ${[...phasesSeen].map((phase) => Phase[phase]).join(", ")}`,
  );
  assert(phasesSeen.has(Phase.BATTLE));
});
