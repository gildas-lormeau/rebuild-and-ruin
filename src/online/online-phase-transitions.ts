/**
 * Game-over wire receiver.
 *
 * In the clone-everywhere model, every peer runs the same phase ticks
 * locally and dispatches phase transitions itself — there is no separate
 * watcher dispatch path for CANNON_START / BATTLE_START / BUILD_START /
 * BUILD_END (those wire messages are pure phase markers that the watcher
 * ignores; the local tick has already advanced state).
 *
 * GAME_OVER is the one exception: it carries the host's authoritative
 * scores and player names, used to paint the terminal frame. Watchers
 * may detect game-over locally too, but the wire frame is the
 * authoritative one.
 */

import { MESSAGE, type ServerMessage } from "../protocol/protocol.ts";
import type { GameRuntime } from "../runtime/runtime-types.ts";
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
