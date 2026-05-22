/**
 * Game-over wire receiver. Phase-marker messages (cannonStart/battleStart/
 * buildStart/buildEnd) are ignored by watchers under the clone-everywhere
 * model; GAME_OVER is the one exception — it carries authoritative scores +
 * names from the host and overrides any locally-detected outcome.
 */

import { MESSAGE, type ServerMessage } from "../protocol/protocol.ts";
import type { GameRuntime } from "../runtime/runtime-handle.ts";
import { FOCUS_REMATCH } from "../shared/ui/interaction-types.ts";
import { PLAYER_COLORS } from "../shared/ui/player-config.ts";

export function handleGameOverTransition(
  msg: ServerMessage,
  runtime: GameRuntime,
): void {
  if (msg.type !== MESSAGE.GAME_OVER) return;
  runtime.lifecycle.finalizeGameOver(() => {
    runtime.runtimeState.frame.gameOver = {
      winner: msg.winner,
      scores: msg.scores.map((score, idx) => ({
        ...score,
        color: PLAYER_COLORS[idx % PLAYER_COLORS.length]!.wall,
      })),
      focused: FOCUS_REMATCH,
    };
  });
}
