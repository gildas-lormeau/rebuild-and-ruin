/**
 * Host promotion orchestration for online play.
 *
 * Called when this client is promoted from watcher to host after the
 * previous host disconnects. Resets networking state, rebuilds controllers,
 * syncs accumulators, and broadcasts the authoritative full state.
 */

import {
  rebuildControllersForPhase,
  skipCastleBuildAnimation,
  syncAccumulatorsFromTimer,
} from "./online-host-promotion.ts";
import { createFullStateMessage } from "./online-serialize.ts";
import { createAiController } from "./runtime-bootstrap.ts";
import { runtime } from "./runtime-online-game.ts";
import {
  devLog,
  resetNetworking,
  send,
  session,
} from "./runtime-online-stores.ts";
import { assertNever, Mode } from "./types.ts";

/** Promote this client to host. Order matters:
 *  1. Reset networking (clear stale watcher/dedup state)
 *  2. Rebuild controllers (create AI for vacant slots in current phase)
 *  3. Sync accumulators (align timing with game state timers)
 *  4. Skip pending UI animations (banner/balloon left over from old host)
 *  5. Broadcast full state (must be last — state must be coherent first)
 */
export function promoteToHost(): void {
  devLog("PROMOTING TO HOST");
  // Re-read isHost (volatile — can flip during host promotion)
  session.isHost = true;

  resetNetworking("host-promotion");
  rebuildControllersForPhase(
    runtime.runtimeState.state,
    runtime.runtimeState.controllers,
    session.myPlayerId,
    (id, seed) =>
      createAiController(id, seed, runtime.runtimeState.settings.difficulty),
  );
  syncAccumulatorsFromTimer(
    runtime.runtimeState.state,
    runtime.runtimeState.accum,
  );
  skipPendingAnimations();

  send(
    createFullStateMessage(
      runtime.runtimeState.state,
      session.hostMigrationSeq,
      runtime.runtimeState.battleAnim.flights,
    ),
  );
  devLog("Promotion complete, now running as host");
}

/**
 * Skip any animations or dialogs that depend on the old host's state.
 * Exhaustive switch ensures adding a new Mode is a compile error until handled.
 */
function skipPendingAnimations(): void {
  const state = runtime.runtimeState.state;
  const mode = runtime.runtimeState.mode;
  switch (mode) {
    case Mode.CASTLE_BUILD:
      runtime.runtimeState.castleBuilds = [];
      skipCastleBuildAnimation(state);
      runtime.phaseTicks.startCannonPhase();
      runtime.runtimeState.mode = Mode.GAME;
      devLog("Skipped castle build animation → cannon phase");
      break;
    case Mode.LIFE_LOST:
      runtime.lifeLost.set(null);
      runtime.runtimeState.mode = Mode.GAME;
      devLog("Cleared life-lost dialog → game mode");
      break;
    case Mode.BANNER:
    case Mode.BALLOON_ANIM:
      runtime.runtimeState.mode = Mode.GAME;
      devLog("Skipped banner/animation → game mode");
      break;
    case Mode.GAME:
    case Mode.LOBBY:
    case Mode.OPTIONS:
    case Mode.CONTROLS:
    case Mode.SELECTION:
    case Mode.STOPPED:
      break; // no action needed
    default:
      assertNever(mode);
  }
}
