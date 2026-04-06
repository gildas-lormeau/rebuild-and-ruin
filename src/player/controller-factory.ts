/**
 * Controller factory — creates AI or Human controllers.
 * Separated from player-controller.ts to avoid circular dependencies
 * (base class ↔ concrete subclass).
 *
 * AI modules are dynamically imported so they can be code-split into a
 * separate chunk and only loaded when an AI controller is actually needed.
 */

import type { KeyBindings } from "../shared/player-config.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import type { PlayerController } from "../shared/system-interfaces.ts";
import { HumanController } from "./controller-human.ts";

/** Ensure AI chunks are cached. Awaited by bootstrapGame before creating controllers. */
export function ensureAiModulesLoaded(): Promise<unknown> {
  return Promise.all([
    import("../ai/controller-ai.ts"),
    import("../ai/ai-strategy.ts"),
  ]);
}

export async function createController(
  playerId: ValidPlayerSlot,
  isAi: boolean,
  keys?: KeyBindings,
  strategySeed?: number,
  difficulty?: number,
): Promise<PlayerController> {
  if (isAi) {
    const [{ AiController }, { DefaultStrategy }] = await Promise.all([
      import("../ai/controller-ai.ts"),
      import("../ai/ai-strategy.ts"),
    ]);
    return new AiController(
      playerId,
      new DefaultStrategy(undefined, strategySeed, difficulty),
    );
  }
  if (!keys) throw new Error("KeyBindings required for human controller");
  return new HumanController(playerId, keys);
}
