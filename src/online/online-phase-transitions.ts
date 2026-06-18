/**
 * Game-over wire receiver. Phase-marker messages (cannonStart/battleStart/
 * buildStart/buildEnd) are ignored by watchers under the clone-everywhere
 * model; GAME_OVER is the one exception — it carries authoritative scores +
 * names from the host and overrides any locally-detected outcome.
 */

import { MESSAGE, type ServerMessage } from "../protocol/protocol.ts";
import type { GameRuntime } from "../runtime/handle.ts";
import { FOCUS_MENU } from "../shared/ui/interaction-types.ts";
import { PLAYER_COLORS } from "../shared/ui/player-config.ts";

export function handleGameOverTransition(
  msg: ServerMessage,
  runtime: GameRuntime,
): void {
  if (msg.type !== MESSAGE.GAME_OVER) return;
  // finalizeGameOver emits GAME_END (once) for `winnerId` — so a watcher whose
  // own local round-end was preempted by this message still emits it. If this
  // peer already finalized locally (mode STOPPED), the emit is skipped there.
  runtime.lifecycle.finalizeGameOver({ id: msg.winnerId }, () => {
    runtime.runtimeState.frame.gameOver = {
      winner: msg.winner,
      scores: msg.scores.map((score, idx) => ({
        ...score,
        color: PLAYER_COLORS[idx % PLAYER_COLORS.length]!.wall,
      })),
      focused: FOCUS_MENU,
      showRematch: false,
    };
  });
}
