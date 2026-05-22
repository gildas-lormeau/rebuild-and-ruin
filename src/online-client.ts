/** Online play entry point — barrel re-export over `online/` modules. */

import { initOnlineRuntime } from "./online/runtime/game.ts";

export { activateAudio } from "./online/runtime/game.ts";
export { lobbyReady } from "./online/runtime/lobby.ts";

initOnlineRuntime();
