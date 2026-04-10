/**
 * Scenario test API — the ONE primitive for writing tests.
 *
 * Three rules:
 *   1. Pick a seed.
 *   2. Run the game.
 *   3. Listen on the bus.
 *
 * That's it. There are no methods to mutate game state, no methods to
 * scripted-place pieces, no methods to skip phases. The AI plays the game
 * end-to-end, exactly as it would in a browser. Tests observe what happens
 * via `sc.bus.on(GAME_EVENT.X, …)` and assert on `sc.state` reads.
 *
 * If you find yourself wanting to mutate state to "set up a condition", the
 * answer is: search for a seed that produces that condition naturally
 * (`scripts/find-seed.ts`) and use it.
 *
 * Usage:
 *
 *     import { createScenario, waitForPhase } from "./scenario.ts";
 *     import { Phase } from "../src/shared/game-phase.ts";
 *     import { GAME_EVENT } from "../src/shared/game-event-bus.ts";
 *
 *     Deno.test("first battle reaches BATTLE phase", async () => {
 *       const sc = await createScenario({ seed: 42 });
 *       waitForPhase(sc, Phase.BATTLE);
 *     });
 *
 *     Deno.test("modifier banner carries tile diff", async () => {
 *       const sc = await createScenario({ seed: 7, mode: "modern" });
 *       const banner = waitForModifier(sc);
 *       assert(banner.changedTiles !== undefined);
 *     });
 */

import {
  createHeadlessRuntime,
  type HeadlessRuntime,
} from "../src/runtime/runtime-headless.ts";
import {
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
  type ModifierId,
} from "../src/shared/game-constants.ts";
import {
  GAME_EVENT,
  type GameEventBus,
  type GameEventMap,
} from "../src/shared/game-event-bus.ts";
import type { Phase } from "../src/shared/game-phase.ts";
import type { GameState } from "../src/shared/types.ts";

export interface ScenarioOptions {
  /** Map seed — controls map, AI, and modifier rolls. Defaults to 42. */
  seed?: number;
  /** Game mode. Defaults to "classic". */
  mode?: "classic" | "modern";
  /** Number of rounds before the game ends. Defaults to 3. */
  rounds?: number;
  /** When true, runs the runtime in "online host" mode with no-op
   *  network broadcasts. Used by host-vs-local sync tests to verify that
   *  the online code path produces the same state as the local one. The
   *  runtime never receives any messages because there are no peers. */
  hostMode?: boolean;
}

export interface Scenario {
  /** Game state — read for assertions, NEVER mutate. */
  readonly state: GameState;
  /** Typed event bus — `sc.bus.on(GAME_EVENT.X, handler)`. */
  readonly bus: GameEventBus;
  /** Current simulated time (ms). */
  readonly now: () => number;
  /** Drive the game until `predicate` returns true. Returns the frame count
   *  taken, or -1 if the predicate never fired before `maxFrames`. Tests
   *  observe via the bus and assert on `state` reads — never advance the
   *  simulation manually frame-by-frame. */
  runUntil(
    predicate: () => boolean,
    maxFrames?: number,
    dtMs?: number,
  ): number;
  /** Drive the game until it ends (mode reaches STOPPED). */
  runGame(maxFrames?: number, dtMs?: number): void;
}

export async function createScenario(
  opts: ScenarioOptions = {},
): Promise<Scenario> {
  const headless = await createHeadlessRuntime({
    seed: opts.seed ?? 42,
    gameMode: opts.mode === "modern" ? GAME_MODE_MODERN : GAME_MODE_CLASSIC,
    rounds: opts.rounds ?? 3,
    hostMode: opts.hostMode ?? false,
  });
  return wrap(headless);
}

function wrap(headless: HeadlessRuntime): Scenario {
  return {
    get state() {
      return headless.runtime.runtimeState.state;
    },
    get bus() {
      return headless.runtime.runtimeState.state.bus;
    },
    now: headless.now,
    runUntil: headless.runUntil,
    runGame: headless.runGame,
  };
}

// ─── Wait helpers ──────────────────────────────────────────────────
// Sync wrappers around `runUntil` that capture an event payload along
// the way. Throw on timeout so test failures point at the missing event,
// not at a downstream assertion.

const DEFAULT_MAX_TICKS = 5000;

/** Tick until a `phaseStart` event for `phase` fires. Returns the event. */
export function waitForPhase(
  sc: Scenario,
  phase: Phase,
  maxTicks = DEFAULT_MAX_TICKS,
): GameEventMap["phaseStart"] {
  let captured: GameEventMap["phaseStart"] | null = null;
  const handler = (ev: GameEventMap["phaseStart"]) => {
    if (ev.phase === phase && captured === null) captured = ev;
  };
  sc.bus.on(GAME_EVENT.PHASE_START, handler);
  try {
    sc.runUntil(() => captured !== null, maxTicks);
  } finally {
    sc.bus.off(GAME_EVENT.PHASE_START, handler);
  }
  if (captured === null) {
    throw new Error(
      `waitForPhase(${phase}) timed out after ${maxTicks} ticks`,
    );
  }
  return captured;
}

/** Tick until a `bannerStart` event matching `predicate` fires. */
export function waitForBanner(
  sc: Scenario,
  predicate: (ev: GameEventMap["bannerStart"]) => boolean,
  maxTicks = DEFAULT_MAX_TICKS,
): GameEventMap["bannerStart"] {
  let captured: GameEventMap["bannerStart"] | null = null;
  const handler = (ev: GameEventMap["bannerStart"]) => {
    if (captured === null && predicate(ev)) captured = ev;
  };
  sc.bus.on(GAME_EVENT.BANNER_START, handler);
  try {
    sc.runUntil(() => captured !== null, maxTicks);
  } finally {
    sc.bus.off(GAME_EVENT.BANNER_START, handler);
  }
  if (captured === null) {
    throw new Error(`waitForBanner timed out after ${maxTicks} ticks`);
  }
  return captured;
}

/** Tick until a modifier banner fires. Filter by `modifierId` if provided. */
export function waitForModifier(
  sc: Scenario,
  modifierId?: ModifierId,
  maxTicks = DEFAULT_MAX_TICKS,
): GameEventMap["bannerStart"] {
  return waitForBanner(
    sc,
    (ev) =>
      ev.modifierId !== undefined &&
      (modifierId === undefined || ev.modifierId === modifierId),
    maxTicks,
  );
}

// ─── Determinism recording ─────────────────────────────────────────
// `recordEvents` subscribes to ALL bus events and returns an append-only
// log. The log is a deterministic projection of "what happened in this run":
// if the runtime is deterministic, replaying the same scenario with the
// same seed must produce a byte-identical log.
//
// Used by:
//   - scripts/record-determinism.ts to write fixtures to disk
//   - test/determinism.test.ts to verify replay matches the saved fixture

export interface RecordedEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

/** Subscribe to every bus event and accumulate them in order.
 *  Call BEFORE driving the runtime so no events are missed. */
export function recordEvents(sc: Scenario): RecordedEvent[] {
  const events: RecordedEvent[] = [];
  sc.bus.onAny((type, ev) => {
    events.push(normalizeEvent(type as string, ev));
  });
  return events;
}

function normalizeEvent(type: string, ev: unknown): RecordedEvent {
  const record = ev as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  // Sort keys for stable JSON output. Drop `type` (it's the parent key)
  // and `undefined` values (JSON.stringify drops them, so the saved fixture
  // wouldn't match a live replay otherwise).
  for (const key of Object.keys(record).sort()) {
    if (key === "type") continue;
    if (record[key] === undefined) continue;
    payload[key] = record[key];
  }
  return { type, payload };
}
