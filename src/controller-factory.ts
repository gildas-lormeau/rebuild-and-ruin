/**
 * Controller factory — creates AI or Human controllers.
 * Separated from player-controller.ts to avoid circular dependencies
 * (base class ↔ concrete subclass).
 */

import { AiController } from "./ai-controller.ts";
import { DefaultStrategy } from "./ai-strategy.ts";
import { HumanController } from "./human-controller.ts";
import type { KeyBindings } from "./player-config.ts";
import type { PlayerController } from "./player-controller.ts";

export function createController(
  playerId: number,
  isAi: boolean,
  keys?: KeyBindings,
  strategySeed?: number,
): PlayerController {
  return isAi
    ? new AiController(playerId, new DefaultStrategy(undefined, strategySeed))
    : new HumanController(playerId, keys!);
}

/** Type guard for HumanController. */
export function isHuman(ctrl: PlayerController): ctrl is HumanController {
  return ctrl instanceof HumanController;
}
