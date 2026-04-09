/**
 * Run a headless game to completion.
 * Usage: deno run --no-check test/run-headless.ts [seed]
 */
import { createScenario } from "./scenario-helpers.ts";
import { GAME_MODE_MODERN } from "../src/shared/game-constants.ts";
import { createBusLog, createGameLogger, GAME_EVENT } from "../src/shared/game-event-bus.ts";
import { setGameMode } from "../src/shared/types.ts";

const seed = Number(Deno.args[0]) || 42;
const sc = await createScenario(seed);
setGameMode(sc.state, GAME_MODE_MODERN);

const log = createGameLogger(sc.state.bus, () => sc.state.round);
const detachLog = createBusLog(sc.state.bus, console.log, new Set([
  GAME_EVENT.PHASE_START, GAME_EVENT.ROUND_START, GAME_EVENT.LIFE_LOST,
  GAME_EVENT.PLAYER_ELIMINATED, GAME_EVENT.MODIFIER_APPLIED,
]));
sc.runGame();
detachLog();

const spawns = log.filter(GAME_EVENT.GRUNT_SPAWNED);
console.log(`seed=${seed} rounds=${sc.state.round} grunts=${sc.state.grunts.length} spawns=${spawns.length}`);
