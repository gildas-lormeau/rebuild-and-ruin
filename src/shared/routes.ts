/** Centralized route constants shared between client and server.
 *
 *  SPA routes are hash-based (`#/online`, `#/play`) but stored without
 *  the hash prefix — the router in router.ts handles the `#` mapping. */

/** SPA (client-side) routes. */

export const ROUTE_HOME = "/";
export const ROUTE_ONLINE = "/online";
export const ROUTE_PLAY = "/play";
/** Server endpoint paths (shared between client, server, and dev proxy). */
export const WS_PLAY_PATH = "/ws/play";
export const API_ROOMS_PATH = "/api/rooms";
export const HEALTH_PATH = "/health";
