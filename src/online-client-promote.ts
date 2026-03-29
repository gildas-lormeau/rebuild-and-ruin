/**
 * Host promotion orchestration for online play.
 *
 * Called when this client is promoted from watcher to host after the
 * previous host disconnects. Resets networking state, rebuilds controllers,
 * syncs accumulators, and broadcasts the authoritative full state.
 */

import { createController } from "./controller-factory.ts";
import {
  enterCannonPlacePhase,
  finalizeCastleConstruction,
} from "./game-engine.ts";
import { runtime } from "./online-client-runtime.ts";
import {
  devLog,
  resetForHostPromotion,
  send,
  session,
} from "./online-client-stores.ts";
import {
  rebuildControllersForPhase,
  syncAccumulatorsFromTimer,
} from "./online-host-promotion.ts";
import { createFullStateMessage } from "./online-serialize.ts";
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
  session.isHost = true;

  resetForHostPromotion();
  rebuildControllersForPhase(
    runtime.rs.state,
    runtime.rs.controllers,
    session.myPlayerId,
    (id, seed) => createController(id, true, undefined, seed),
  );
  syncAccumulatorsFromTimer(runtime.rs.state, runtime.rs.accum);
  skipPendingAnimations();

  send(
    createFullStateMessage(
      runtime.rs.state,
      session.hostMigrationSeq,
      runtime.rs.battleAnim.flights,
    ),
  );
  devLog("Promotion complete, now running as host");
}

/**
 * Skip any animations or dialogs that depend on the old host's state.
 * Exhaustive switch ensures adding a new Mode is a compile error until handled.
 */
function skipPendingAnimations(): void {
  const state = runtime.rs.state;
  const mode = runtime.rs.mode;
  switch (mode) {
    case Mode.CASTLE_BUILD:
      runtime.rs.castleBuilds = [];
      finalizeCastleConstruction(state);
      enterCannonPlacePhase(state);
      runtime.phaseTicks.startCannonPhase();
      runtime.rs.mode = Mode.GAME;
      devLog("Skipped castle build animation → cannon phase");
      break;
    case Mode.LIFE_LOST:
      runtime.lifeLost.set(null);
      runtime.rs.mode = Mode.GAME;
      devLog("Cleared life-lost dialog → game mode");
      break;
    case Mode.BANNER:
    case Mode.BALLOON_ANIM:
      runtime.rs.mode = Mode.GAME;
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
