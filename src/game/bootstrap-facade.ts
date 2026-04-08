/**
 * Bootstrap facade — explicit contract boundary between game/ and runtime/
 * for game initialization (state creation, config application).
 *
 * Separated from selection-facade because bootstrap functions serve a
 * different concern (game setup) than selection/castle-building.
 */

import { applyGameConfig, createGameFromSeed } from "./game-engine.ts";
import { generateMap } from "./map-generation.ts";

export const bootstrapFacade = {
  createGameFromSeed,
  applyGameConfig,
  generateMap,
};
