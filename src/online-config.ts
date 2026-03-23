/** Default server host for online play (Deno Deploy). */
export const DEFAULT_SERVER_HOST = "rebuild-and-ruin.gildas-lormeau.deno.net";

/** Strip protocol prefix (http://, https://, ws://, wss://) and trailing slash from a host string. */
function stripProtocol(host: string): string {
  return host.replace(/^(?:https?|wss?):\/\//, "").replace(/\/+$/, "");
}

/** Get the server host — from URL param, localStorage, or Deno Deploy default. */
function getServerHost(): string {
  const param = new URLSearchParams(location.search).get("server");
  if (param) return stripProtocol(param);
  const saved = localStorage.getItem("castles99_server");
  if (saved) return stripProtocol(saved);
  return DEFAULT_SERVER_HOST;
}

/** Get the full WebSocket URL for the game server. */
export function getWsUrl(): string {
  const host = getServerHost();
  const proto = host.includes("localhost") || host.match(/^192\./) ? "ws:" : "wss:";
  return `${proto}//${host}/ws/play`;
}

/** Get the HTTP base URL for the game server API. */
export function getApiUrl(path: string): string {
  const host = getServerHost();
  const proto = host.includes("localhost") || host.match(/^192\./) ? "http:" : "https:";
  return `${proto}//${host}${path}`;
}
