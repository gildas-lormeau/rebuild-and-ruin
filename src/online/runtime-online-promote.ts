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

import { createAiController } from "../runtime/runtime-bootstrap.ts";
import { setMode } from "../runtime/runtime-state.ts";
import type { GameRuntime } from "../runtime/runtime-types.ts";
import { Mode } from "../shared/game-phase.ts";
import { assertNever } from "../shared/utils.ts";
import {
  rebuildControllersForPhase,
  skipCastleBuildAnimation,
  syncAccumulatorsFromTimer,
} from "./online-host-promotion.ts";
import { createFullStateMessage } from "./online-serialize.ts";
import {
  type OnlineClient,
  RESET_SCOPE_HOST_PROMOTION,
} from "./online-stores.ts";

// ── Late-bound state ───────────────────────────────────────────────
let _runtime: GameRuntime;
let _client: OnlineClient;

/** Bind the GameRuntime reference. Called once from runtime-online-game.ts
 *  after the GameRuntime is created. */
export function initPromote(rt: GameRuntime, client: OnlineClient): void {
  _runtime = rt;
  _client = client;
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
  _client.devLog("PROMOTING TO HOST");
  _client.ctx.session.isHost = true; // eslint-disable-line no-restricted-syntax -- host promotion

  _client.resetNetworking(RESET_SCOPE_HOST_PROMOTION);
  rebuildControllersForPhase(
    _runtime.runtimeState.state,
    _runtime.runtimeState.controllers,
    _client.ctx.session.myPlayerId,
    (id, seed) =>
      createAiController(id, seed, _runtime.runtimeState.settings.difficulty),
  );
  syncAccumulatorsFromTimer(
    _runtime.runtimeState.state,
    _runtime.runtimeState.accum,
  );
  skipPendingAnimations();

  _client.send(
    createFullStateMessage(
      _runtime.runtimeState.state,
      _client.ctx.session.hostMigrationSeq,
      _runtime.runtimeState.battleAnim.flights,
    ),
  );
  _client.devLog("Promotion complete, now running as host");
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
      setMode(_runtime.runtimeState, Mode.GAME);
      _client.devLog("Skipped castle build animation → cannon phase");
      break;
    case Mode.LIFE_LOST:
      _runtime.lifeLost.set(null);
      setMode(_runtime.runtimeState, Mode.GAME);
      _client.devLog("Cleared life-lost dialog → game mode");
      break;
    case Mode.BANNER:
    case Mode.BALLOON_ANIM:
      setMode(_runtime.runtimeState, Mode.GAME);
      _client.devLog("Skipped banner/animation → game mode");
      break;
    case Mode.UPGRADE_PICK:
      _runtime.runtimeState.upgradePickDialog = null;
      setMode(_runtime.runtimeState, Mode.GAME);
      _client.devLog("Cleared upgrade pick dialog → game mode");
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
