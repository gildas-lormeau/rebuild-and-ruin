/**
 * Controller factory — creates AI or Human controllers.
 * Separated from player-controller.ts to avoid circular dependencies
 * (base class ↔ concrete subclass).
 */

import { DefaultStrategy } from "./ai-strategy.ts";
import { AiController } from "./controller-ai.ts";
import { HumanController } from "./controller-human.ts";
import type { PlayerController } from "./controller-interfaces.ts";
import type { ValidPlayerSlot } from "./game-constants.ts";
import type { KeyBindings } from "./player-config.ts";

export function createController(
  playerId: ValidPlayerSlot,
  isAi: boolean,
  keys?: KeyBindings,
  strategySeed?: number,
  difficulty?: number,
): PlayerController {
  if (isAi) {
    return new AiController(
      playerId,
      new DefaultStrategy(undefined, strategySeed, difficulty),
    );
  }
  if (!keys) throw new Error("KeyBindings required for human controller");
  return new HumanController(playerId, keys);
}
