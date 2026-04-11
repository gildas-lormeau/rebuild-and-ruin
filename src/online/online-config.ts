/** Default server host for online play (Deno Deploy). */

import { WS_PLAY_PATH } from "../protocol/routes.ts";

const DEFAULT_SERVER_HOST = "rebuild-and-ruin.gildas-lormeau.deno.net";
/** Hosts that should use plain ws:/http: instead of wss:/https:. */
const LOCAL_HOST_PATTERN = /^(?:localhost|127\.|192\.|10\.|0\.0\.0\.0)/;

/** Get the full WebSocket URL for the game server. */
export function computeWsUrl(): string {
  const host = getServerHost();
  const proto = LOCAL_HOST_PATTERN.test(host) ? "ws:" : "wss:";
  return `${proto}//${host}${WS_PLAY_PATH}`;
}

/** Get the HTTP base URL for the game server API. */
export function computeApiUrl(path: string): string {
  const host = getServerHost();
  const proto = LOCAL_HOST_PATTERN.test(host) ? "http:" : "https:";
  return `${proto}//${host}${path}`;
}

/** Get the server host — from URL param, localStorage, or Deno Deploy default. */
function getServerHost(): string {
  const param = new URLSearchParams(location.search).get("server");
  if (param) return stripProtocol(param);
  const saved = localStorage.getItem("castles99_server");
  if (saved) return stripProtocol(saved);
  return DEFAULT_SERVER_HOST;
}

/** Strip protocol prefix (http://, https://, ws://, wss://) and trailing slash from a host string. */
function stripProtocol(host: string): string {
  return host.replace(/^(?:https?|wss?):\/\//, "").replace(/\/+$/, "");
}
