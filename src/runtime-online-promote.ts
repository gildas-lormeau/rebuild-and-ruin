/**
 * Host promotion orchestration for online play.
 *
 * Called when this client is promoted from watcher to host after the
 * previous host disconnects. Resets networking state, rebuilds controllers,
 * syncs accumulators, and broadcasts the authoritative full state.
 *
 * Does NOT import runtime-online-game.ts — the GameRuntime reference is
 * injected via initPromote() to avoid initialization coupling.
 */

import {
  rebuildControllersForPhase,
  skipCastleBuildAnimation,
  syncAccumulatorsFromTimer,
} from "./online-host-promotion.ts";
import { createFullStateMessage } from "./online-serialize.ts";
import {
  ctx,
  devLog,
  RESET_SCOPE_HOST_PROMOTION,
  resetNetworking,
  send,
} from "./online-stores.ts";
import { createAiController } from "./runtime-bootstrap.ts";
import type { GameRuntime } from "./runtime-types.ts";
import { Mode } from "./types.ts";
import { assertNever } from "./utils.ts";

// ── Late-bound state ───────────────────────────────────────────────
let _runtime: GameRuntime;

/** Bind the GameRuntime reference. Called once from runtime-online-game.ts
 *  after the GameRuntime is created. */
export function initPromote(rt: GameRuntime): void {
  _runtime = rt;
}

/** Promote this client to host. Order matters:
 *  1. Reset networking (clear stale watcher/dedup state)
 *  2. Rebuild controllers (create AI for vacant slots in current phase)
 *  3. Sync accumulators (align timing with game state timers)
 *  4. Skip pending UI animations (banner/balloon left over from old host)
 *  5. Broadcast full state (must be last — state must be coherent first)
 */
export function promoteToHost(): void {
  if (!_runtime) throw new Error("promoteToHost() called before initPromote()");
  devLog("PROMOTING TO HOST");
  ctx.session.isHost = true; // eslint-disable-line no-restricted-syntax -- host promotion

  resetNetworking(RESET_SCOPE_HOST_PROMOTION);
  rebuildControllersForPhase(
    _runtime.runtimeState.state,
    _runtime.runtimeState.controllers,
    ctx.session.onlinePlayerId,
    (id, seed) =>
      createAiController(id, seed, _runtime.runtimeState.settings.difficulty),
  );
  syncAccumulatorsFromTimer(
    _runtime.runtimeState.state,
    _runtime.runtimeState.accum,
  );
  skipPendingAnimations();

  send(
    createFullStateMessage(
      _runtime.runtimeState.state,
      ctx.session.hostMigrationSeq,
      _runtime.runtimeState.battleAnim.flights,
    ),
  );
  devLog("Promotion complete, now running as host");
}

/**
 * Skip any animations or dialogs that depend on the old host's state.
 * Exhaustive switch ensures adding a new Mode is a compile error until handled.
 */
function skipPendingAnimations(): void {
  const state = _runtime.runtimeState.state;
  const mode = _runtime.runtimeState.mode;
  switch (mode) {
    case Mode.CASTLE_BUILD:
      _runtime.runtimeState.castleBuilds = [];
      skipCastleBuildAnimation(state);
      _runtime.phaseTicks.startCannonPhase();
      _runtime.runtimeState.mode = Mode.GAME;
      devLog("Skipped castle build animation → cannon phase");
      break;
    case Mode.LIFE_LOST:
      _runtime.lifeLost.set(null);
      _runtime.runtimeState.mode = Mode.GAME;
      devLog("Cleared life-lost dialog → game mode");
      break;
    case Mode.BANNER:
    case Mode.BALLOON_ANIM:
      _runtime.runtimeState.mode = Mode.GAME;
      devLog("Skipped banner/animation → game mode");
      break;
    case Mode.UPGRADE_PICK:
      _runtime.runtimeState.upgradePickDialog = null;
      _runtime.runtimeState.mode = Mode.GAME;
      devLog("Cleared upgrade pick dialog → game mode");
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
