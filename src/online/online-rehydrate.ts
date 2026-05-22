/**
 * Mid-game checkpoint rehydration — drop a captured `FullStateMessage`
 * into a freshly-booted runtime so it can continue ticking from that
 * moment. Used by phase-test fixtures past round 1, where AI replay
 * would be too slow to be useful.
 */

import type { FullStateMessage } from "../protocol/protocol.ts";
import {
  createAiController,
  ensureAiModulesLoaded,
  rollAiPersonality,
} from "../runtime/runtime-bootstrap.ts";
import type { GameRuntime } from "../runtime/runtime-handle.ts";
import { setMode } from "../runtime/runtime-state.ts";
import type { BalloonFlight } from "../shared/core/battle-types.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { PlayerId } from "../shared/core/player-slot.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import {
  rebuildControllersForPhase,
  syncAccumulatorsFromTimer,
} from "./online-host-promotion.ts";
import { restoreFullStateSnapshot } from "./online-serialize.ts";

interface MidGameApplyResult {
  balloonFlights: { flight: BalloonFlight; progress: number }[];
}

/** Out-of-range slot id passed to `rebuildControllersForPhase` so every
 *  player slot is rebuilt as AI (no human gets to "keep" its controller).
 *  Headless tests have no human player; if a future caller needs to keep a
 *  human slot, extend with an `opts.myPlayerId` parameter. */
const ALL_SLOTS_AI = -1 as PlayerId;

/** Apply a `FullStateMessage` to a freshly-booted runtime. Composes the
 *  four steps that together make the runtime tickable from the captured
 *  moment:
 *    1. `restoreFullStateSnapshot` — lossless data restore (GameState,
 *       RNG, players' homeTower + castleWallTiles, modifier tiles).
 *    2. `rebuildControllersForPhase` — controllers from the fresh
 *       bootstrap are primed for round-1 selection; the captured phase
 *       needs different priming.
 *    3. `syncAccumulatorsFromTimer` — phase-timer accumulators ride
 *       from boot at zero, but `state.timer` is now mid-round; without
 *       resync the next tick would overwrite `state.timer`.
 *    4. `setMode` — `tick()` dispatches on `Mode`; staying at LOBBY/
 *       SELECTION blocks game ticks.
 *
 *  Returns null when validation rejects the message (no mutation). */
export async function applyMidGameCheckpoint(
  runtime: GameRuntime,
  msg: FullStateMessage,
): Promise<MidGameApplyResult | null> {
  const state = runtime.runtimeState.state;

  const result = restoreFullStateSnapshot(state, msg);
  if (!result) return null;

  runtime.runtimeState.controllers = await rebuildControllersForPhase(
    state,
    runtime.runtimeState.controllers,
    ALL_SLOTS_AI,
    {
      ensureLoaded: ensureAiModulesLoaded,
      rollPersonality: rollAiPersonality,
      create: createAiController,
    },
    undefined,
  );

  syncAccumulatorsFromTimer(state, runtime.runtimeState.accum);

  const balloonFlights = result.balloonFlights ?? [];
  setMode(
    runtime.runtimeState,
    resolveModeAfterFullState(state.phase, balloonFlights.length > 0),
  );

  return { balloonFlights };
}

/** Map a restored phase to the runtime Mode the main loop should dispatch.
 *  Exported so the watcher path (`online-runtime-session.ts:restoreFullState`)
 *  uses the same logic without duplicating it. */
export function resolveModeAfterFullState(
  phase: Phase,
  hasBalloons: boolean,
): Mode {
  if (phase === Phase.CASTLE_SELECT) return Mode.SELECTION;
  if (phase === Phase.BATTLE && hasBalloons) return Mode.BALLOON_ANIM;
  return Mode.GAME;
}
