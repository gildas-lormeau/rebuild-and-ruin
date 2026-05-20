/**
 * Single ai/ entrypoint for assembling the default AI: bundles
 * DefaultStrategy + the default AiBrain so callers (controller-factory,
 * test runtimes) only import one symbol from ai/ instead of three. Lets
 * controllers/ stay agnostic about the strategy↔brain internal split.
 */

import type { AiPersonality } from "../shared/core/ai-personality.ts";
import type { Rng } from "../shared/platform/rng.ts";
import { createDefaultAiBrain } from "./ai-brain.ts";
import type { AiBrain } from "./ai-brain-types.ts";
import { DefaultStrategy } from "./ai-strategy.ts";
import type { AiStrategy } from "./ai-strategy-types.ts";

interface AiDeps {
  strategy: AiStrategy;
  brain: AiBrain;
}

export function createDefaultAiDeps(
  rng: Rng,
  personality: AiPersonality,
): AiDeps {
  return {
    strategy: new DefaultStrategy(rng, personality),
    brain: createDefaultAiBrain(),
  };
}
