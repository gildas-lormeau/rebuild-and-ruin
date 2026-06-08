/**
 * Controller factory — the canonical AI seam for non-AI code. Owns all
 * dynamic imports into `src/ai/`, so runtime/online/bootstrap only need
 * the factory + personality roll here plus the type-only `*-types.ts`
 * files. AI chunks are loaded lazily so human-only games stay slim.
 */

import type { AiPersonality } from "../shared/core/ai-personality.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type {
  AimResolver,
  PlayerController,
} from "../shared/core/system-interfaces.ts";
import type { Rng } from "../shared/platform/rng.ts";
import type { KeyBindings } from "../shared/ui/player-config.ts";
import { HumanController } from "./controller-human.ts";

let cachedRollPersonality:
  | ((rng: Rng, difficulty?: number) => AiPersonality)
  | undefined;
let cachedAiControllerBuilder:
  | ((
      id: ValidPlayerId,
      rng: Rng,
      personality: AiPersonality,
    ) => PlayerController)
  | undefined;
let aiModulesPromise: Promise<void> | undefined;

/** Sync personality roll. Caller MUST await `ensureAiModulesLoaded()`
 *  first — this is the rule that keeps state.rng draws synchronous
 *  inside the bootstrap slot loop (ordering matters for determinism
 *  fixtures: privateSeed must draw before personality, both off the
 *  shared `state.rng`). */
export function rollAiPersonality(
  rng: Rng,
  difficulty?: number,
): AiPersonality {
  if (!cachedRollPersonality) {
    throw new Error(
      "rollAiPersonality: ensureAiModulesLoaded() must be awaited first",
    );
  }
  return cachedRollPersonality(rng, difficulty);
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
  // Camera-backed aim resolver, threaded from the composition root (where the
  // camera exists). AI controllers ignore it — they build their own sim-only
  // resolver internally for cross-peer parity; only humans need the camera one.
  humanAimResolver?: AimResolver,
): Promise<PlayerController> {
  if (isAi) {
    if (!sharedRng) throw new Error("sharedRng required for AI controller");
    if (!personality) throw new Error("personality required for AI controller");
    await ensureAiModulesLoaded();
    return cachedAiControllerBuilder!(playerId, sharedRng, personality);
  }
  if (!keys) throw new Error("KeyBindings required for human controller");
  if (!humanAimResolver)
    throw new Error("humanAimResolver required for human controller");
  return new HumanController(playerId, keys, humanAimResolver);
}

/** Ensure AI chunks are cached. Awaited by bootstrapGame + host-promotion
 *  before creating controllers OR rolling personalities. */
export function ensureAiModulesLoaded(): Promise<void> {
  if (!aiModulesPromise) aiModulesPromise = loadAiModules();
  return aiModulesPromise;
}

async function loadAiModules(): Promise<void> {
  const [{ AiController }, { createDefaultAiDeps }, { rollPersonality }] =
    await Promise.all([
      import("./controller-ai.ts"),
      import("../ai/ai-defaults.ts"),
      import("../ai/ai-personality-roll.ts"),
    ]);
  cachedRollPersonality = rollPersonality;
  cachedAiControllerBuilder = (id, rng, personality) => {
    const { strategy, brain } = createDefaultAiDeps(rng, personality);
    return new AiController(id, strategy, brain);
  };
}
