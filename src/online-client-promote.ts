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
  log,
  resetDedup,
  send,
  session,
  watcher,
} from "./online-client-stores.ts";
import {
  rebuildControllersForPhase,
  syncAccumulatorsFromTimer,
} from "./online-host-promotion.ts";
import { createFullStateMessage } from "./online-serialize.ts";
import { resetWatcherForHost } from "./online-watcher-tick.ts";
import { Mode } from "./types.ts";

export function promoteToHost(): void {
  log("PROMOTING TO HOST");
  session.isHost = true;

  resetNetworkingForHost();
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
  log("Promotion complete, now running as host");
}

/** Clear networking state the host doesn't carry over from the watcher phase. */
function resetNetworkingForHost(): void {
  resetDedup();
  resetWatcherForHost(watcher);
}

/**
 * Skip any animations or dialogs that depend on the old host's state.
 * NOTE: when adding new Mode values, check if they need handling here.
 */
function skipPendingAnimations(): void {
  const state = runtime.rs.state;
  const mode = runtime.rs.mode;
  if (mode === Mode.CASTLE_BUILD) {
    runtime.rs.castleBuilds = [];
    finalizeCastleConstruction(state);
    enterCannonPlacePhase(state);
    runtime.phaseTicks.startCannonPhase();
    runtime.rs.mode = Mode.GAME;
    log("Skipped castle build animation → cannon phase");
  } else if (mode === Mode.LIFE_LOST) {
    runtime.lifeLost.set(null);
    runtime.rs.mode = Mode.GAME;
    log("Cleared life-lost dialog → game mode");
  } else if (mode === Mode.BANNER || mode === Mode.BALLOON_ANIM) {
    runtime.rs.mode = Mode.GAME;
    log("Skipped banner/animation → game mode");
  }
  // GAME, LOBBY, OPTIONS, CONTROLS, SELECTION, STOPPED — no action needed
}
