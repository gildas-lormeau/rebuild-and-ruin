/**
 * Online play entry point — barrel re-export.
 *
 * The implementation is split across focused modules:
 *   runtime-online-stores.ts   — mutable singletons, send/devLog utilities
 *   runtime-online-game.ts     — GameRuntime creation and online callbacks
 *   runtime-online-deps.ts     — server message dispatch, dep-object builders
 *   runtime-online-promote.ts  — host promotion orchestration
 *   runtime-online-ws.ts       — WebSocket lifecycle and reconnection
 *   runtime-online-lobby.ts    — lobby DOM and lobbyReady promise
 */

export { lobbyReady } from "./runtime-online-lobby.ts";
