/**
 * Controller factory — creates AI or Human controllers.
 * Separated from player-controller.ts to avoid circular dependencies
 * (base class ↔ concrete subclass).
 */

import { DefaultStrategy } from "../ai/ai-strategy.ts";
import { AiController } from "../ai/controller-ai.ts";
import type { KeyBindings } from "../shared/player-config.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import type { PlayerController } from "../shared/system-interfaces.ts";
import { HumanController } from "./controller-human.ts";

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
