/** Online play entry point — barrel re-export over `online/` modules. */

import { initOnlineRuntime } from "./online/online-runtime-game.ts";

export { activateAudio } from "./online/online-runtime-game.ts";
export { lobbyReady } from "./online/online-runtime-lobby.ts";

initOnlineRuntime();
