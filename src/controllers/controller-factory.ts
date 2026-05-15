/**
 * Controller factory — creates AI or Human controllers.
 * Separated from player-controller.ts to avoid circular dependencies
 * (base class ↔ concrete subclass).
 *
 * AI modules are dynamically imported so they can be code-split into a
 * separate chunk and only loaded when an AI controller is actually needed.
 */

import type { AiPersonality } from "../shared/core/ai-personality.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { PlayerController } from "../shared/core/system-interfaces.ts";
import type { Rng } from "../shared/platform/rng.ts";
import type { KeyBindings } from "../shared/ui/player-config.ts";
import { HumanController } from "./controller-human.ts";

/** Ensure AI chunks are cached. Awaited by bootstrapGame before creating controllers. */
export function ensureAiModulesLoaded(): Promise<unknown> {
  return Promise.all([
    import("./controller-ai.ts"),
    import("../ai/ai-defaults.ts"),
  ]);
}

export async function createController(
  playerId: ValidPlayerId,
  isAi: boolean,
  keys?: KeyBindings,
  sharedRng?: Rng,
  // _privateSeed is unused by the default factory; pure-AI strategies use
  // sharedRng for runtime decision draws. The AssistedHuman factory in
  // test/runtime-headless.ts uses _privateSeed to construct a per-slot
  // private Rng. The bootstrap pulls one int per AI slot regardless so
  // host/watcher remain symmetric.
  _privateSeed?: number,
  personality?: AiPersonality,
): Promise<PlayerController> {
  if (isAi) {
    if (!sharedRng) throw new Error("sharedRng required for AI controller");
    if (!personality) throw new Error("personality required for AI controller");
    const [{ AiController }, { createDefaultAiDeps }] = await Promise.all([
      import("./controller-ai.ts"),
      import("../ai/ai-defaults.ts"),
    ]);
    const { strategy, brain } = createDefaultAiDeps(sharedRng, personality);
    return new AiController(playerId, strategy, brain);
  }
  if (!keys) throw new Error("KeyBindings required for human controller");
  return new HumanController(playerId, keys);
}
