/**
 * Online play entry point — barrel re-export.
 *
 * The implementation is split across focused modules:
 *   online-client-stores.ts   — mutable singletons, send/devLog utilities
 *   online-client-runtime.ts  — GameRuntime creation and online callbacks
 *   online-client-deps.ts     — server message dispatch, dep-object builders
 *   online-client-promote.ts     — host promotion orchestration
 *   online-client-ws.ts       — WebSocket lifecycle and reconnection
 *   online-client-lobby.ts    — lobby DOM and lobbyReady promise
 */

export { lobbyReady } from "./online-client-lobby.ts";
