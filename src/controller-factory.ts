/**
 * Controller factory — creates AI or Human controllers.
 * Separated from player-controller.ts to avoid circular dependencies
 * (base class ↔ concrete subclass).
 */

import { AiController } from "./ai-controller.ts";
import { DefaultStrategy } from "./ai-strategy.ts";
import { HumanController } from "./controller-human.ts";
import type { AiAnimatable, InputReceiver, PlayerController } from "./controller-interfaces.ts";
import type { KeyBindings } from "./player-config.ts";

export function createController(
  playerId: number,
  isAi: boolean,
  keys?: KeyBindings,
  strategySeed?: number,
  difficulty?: number,
): PlayerController {
  return isAi
    ? new AiController(playerId, new DefaultStrategy(undefined, strategySeed, difficulty))
    : new HumanController(playerId, keys!);
}

/** Type guard for HumanController (InputReceiver). */
export function isHuman(ctrl: PlayerController): ctrl is PlayerController & InputReceiver {
  return ctrl instanceof HumanController;
}

/** Type guard for AiController (AiAnimatable). */
export function isAiAnimatable(ctrl: PlayerController): ctrl is PlayerController & AiAnimatable {
  return ctrl instanceof AiController;
}
