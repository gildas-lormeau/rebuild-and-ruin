/**
 * Controller factory — creates AI or Human controllers.
 * Separated from player-controller.ts to avoid circular dependencies
 * (base class ↔ concrete subclass).
 */

import { DefaultStrategy } from "./ai-strategy.ts";
import { AiController } from "./controller-ai.ts";
import { HumanController } from "./controller-human.ts";
import type { PlayerController } from "./controller-interfaces.ts";
import type { KeyBindings } from "./player-config.ts";

export function createController(
  playerId: number,
  isAi: boolean,
  keys?: KeyBindings,
  strategySeed?: number,
  difficulty?: number,
): PlayerController {
  return isAi
    ? new AiController(
        playerId,
        new DefaultStrategy(undefined, strategySeed, difficulty),
      )
    : new HumanController(playerId, keys!);
}
