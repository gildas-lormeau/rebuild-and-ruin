/**
 * Run a headless game to completion.
 * Usage: deno run --no-check test/run-headless.ts [seed]
 */
import { createScenario } from "./scenario-helpers.ts";
import { GAME_MODE_MODERN } from "../src/shared/game-constants.ts";
import { createGameLogger, GAME_EVENT } from "../src/shared/game-event-bus.ts";
import { setGameMode } from "../src/shared/types.ts";

const seed = Number(Deno.args[0]) || 42;
const sc = await createScenario(seed);
setGameMode(sc.state, GAME_MODE_MODERN);

const log = createGameLogger(sc.state.bus, () => sc.state.round);
sc.runGame();

const spawns = log.filter(GAME_EVENT.GRUNT_SPAWNED);
console.log(`seed=${seed} rounds=${sc.state.round} grunts=${sc.state.grunts.length} spawns=${spawns.length}`);
