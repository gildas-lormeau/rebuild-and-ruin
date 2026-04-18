/**
 * Online play entry point — barrel re-export.
 *
 * The implementation is split across focused modules:
 *   online-stores.ts          — mutable singletons, send/devLog utilities
 *   online-runtime-game.ts    — GameRuntime creation and online callbacks
 *   online-runtime-deps.ts    — server message dispatch, dep-object builders
 *   online-runtime-promote.ts — host promotion orchestration
 *   online-runtime-ws.ts      — WebSocket lifecycle and reconnection
 *   online-runtime-lobby.ts   — lobby DOM and lobbyReady promise
 */

import { initOnlineRuntime } from "./online/online-runtime-game.ts";

export { activateAudio } from "./online/online-runtime-game.ts";
export { lobbyReady } from "./online/online-runtime-lobby.ts";

initOnlineRuntime();
