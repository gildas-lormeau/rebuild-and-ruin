/**
 * Minimal hash-based SPA router with native back/forward support.
 *
 * Pages are `<main class="page" data-route="/path">` elements.
 * Only the page matching the current hash is visible.
 */

/** Navigate to a hash route, optionally replacing the current history entry. */

export function navigateTo(path: string, replace = false): void {
  const url = `#${path}`;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  applyRoute();
}

/** Attach popstate + hashchange listeners and apply the initial route. */
export function initRouter(): void {
  window.addEventListener("popstate", applyRoute);
  window.addEventListener("hashchange", applyRoute);
  applyRoute();
}

/** Show the page matching the current hash, hide all others.
 *  Also hides the game container when a page route is matched. */
function applyRoute(): void {
  const route = getRoute();
  let matched = false;
  for (const el of document.querySelectorAll<HTMLElement>(".page")) {
    const show = el.dataset.route === route;
    el.hidden = !show;
    if (show) matched = true;
  }
  if (matched) {
    const gc = document.getElementById("game-container");
    if (gc?.classList.contains("active")) {
      gc.classList.remove("active");
      document.dispatchEvent(new Event("game-exit"));
    }
  }
}

/** Read the current route from `location.hash`. Defaults to `"/"`. */
export function getRoute(): string {
  return location.hash.replace(/^#/, "") || "/";
}
