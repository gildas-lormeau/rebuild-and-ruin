/**
 * Host promotion orchestration for online play.
 *
 * Called when this client is promoted from watcher to host after the
 * previous host disconnects. Resets networking state, rebuilds controllers,
 * syncs accumulators, and broadcasts the authoritative full state.
 *
 * Does NOT import online-runtime-game.ts — the GameRuntime reference is
 * injected via initPromote() to avoid initialization coupling.
 *
 * ORDERING INVARIANT — initPromote() is the second of three init calls from
 * online-runtime-game.ts:initOnlineRuntime(). The required order is:
 *    1. initWs   (online-runtime-ws.ts)
 *    2. initPromote (this file)
 *    3. initDeps (online-runtime-deps.ts)
 * Calling promoteToHost() before initPromote() throws. Do not reorder the
 * call sequence in initOnlineRuntime without updating all three modules.
 */

import { createAiController } from "../runtime/runtime-bootstrap.ts";
import { setMode } from "../runtime/runtime-state.ts";
import type { GameRuntime } from "../runtime/runtime-types.ts";
import { assertNever } from "../shared/platform/utils.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
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

/** Bind the GameRuntime reference. Called once from online-runtime-game.ts
 *  after the GameRuntime is created. */
export function initPromote(runtime: GameRuntime, client: OnlineClient): void {
  _runtime = runtime;
  _client = client;
}

/** Promote this client to host. Order matters:
 *  1. Reset networking (clear stale watcher/dedup state)
 *  2. Rebuild controllers (create AI for vacant slots in current phase)
 *  3. Sync accumulators (align timing with game state timers)
 *  4. Skip pending UI animations (banner/balloon left over from old host)
 *  5. Broadcast full state (must be last — state must be coherent first)
 */
export async function promoteToHost(): Promise<void> {
  if (!_runtime) throw new Error("promoteToHost() called before initPromote()");
  _client.devLog("PROMOTING TO HOST");
  _client.ctx.session.isHost = true; // eslint-disable-line no-restricted-syntax -- host promotion

  _client.resetNetworking(RESET_SCOPE_HOST_PROMOTION);
  _runtime.runtimeState.controllers = await rebuildControllersForPhase(
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
 * Delegates mode-specific cleanup to clearAnimationState, then sets Mode.GAME.
 */
function skipPendingAnimations(): void {
  const description = clearAnimationState(_runtime.runtimeState.mode);
  if (description) {
    setMode(_runtime.runtimeState, Mode.GAME);
    _client.devLog(description);
  }
}

/** Clear mode-specific animation/dialog state left over from the old host.
 *  Returns a log description if state was cleared, null if no action was needed.
 *  Exhaustive switch ensures adding a new Mode is a compile error until handled. */
function clearAnimationState(mode: Mode): string | null {
  switch (mode) {
    case Mode.CASTLE_BUILD:
      _runtime.runtimeState.selection.castleBuilds = [];
      skipCastleBuildAnimation(_runtime.runtimeState.state);
      _runtime.phaseTicks.startCannonPhase();
      return "Skipped castle build animation → cannon phase";
    case Mode.LIFE_LOST:
      _runtime.lifeLost.set(null);
      return "Cleared life-lost dialog → game mode";
    case Mode.TRANSITION:
    case Mode.BANNER:
    case Mode.BALLOON_ANIM:
      return "Skipped phase transition/animation → game mode";
    case Mode.UPGRADE_PICK:
      // Match the phase-transition + lifecycle paths — go through the
      // upgrade-pick subsystem boundary instead of mutating dialog state
      // directly. Same effect, single audited mutation site.
      _runtime.upgradePick.set(null);
      return "Cleared upgrade pick dialog → game mode";
    case Mode.GAME:
    case Mode.LOBBY:
    case Mode.OPTIONS:
    case Mode.CONTROLS:
    case Mode.SELECTION:
    case Mode.STOPPED:
      return null;
    default:
      assertNever(mode);
  }
}
