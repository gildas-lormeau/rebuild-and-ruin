/**
 * Minimal hash-based SPA router with native back/forward support.
 *
 * Pages are `<main class="page" data-route="/path">` elements.
 * Only the page matching the current hash is visible.
 *
 * Route handlers registered via `onRoute()` are called when a route
 * activates — deduped so repeat navigations to the same route are ignored.
 */

type RouteHandler = () => void;

const handlers = new Map<string, RouteHandler>();

let currentRoute = "";

/** Register a handler that runs when `path` becomes the active route. */
export function onRoute(path: string, handler: RouteHandler): void {
  handlers.set(path, handler);
}

/** Navigate to a hash route, optionally replacing the current history entry. */
export function navigateTo(path: string, replace = false): void {
  const url = `#${path}`;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  applyRoute();
}

/** Attach popstate + hashchange listeners and apply the initial route. */
export function initRouter(): void {
  addEventListener("popstate", applyRoute);
  addEventListener("hashchange", applyRoute);
  applyRoute();
}

/** Show the page matching the current hash, hide all others.
 *  Calls the registered route handler when the route changes. */
function applyRoute(): void {
  const route = getRoute();
  for (const el of document.querySelectorAll<HTMLElement>(".page")) {
    el.hidden = el.dataset.route !== route;
  }
  if (route !== currentRoute) {
    currentRoute = route;
    handlers.get(route)?.();
  }
}

/** Read the current route from `location.hash`. Defaults to `"/"`. */
function getRoute(): string {
  return location.hash.replace(/^#/, "") || "/";
}
