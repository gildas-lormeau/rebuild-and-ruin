/**
 * Debug-only ASCII renderer. Activates when `?renderer=ascii` is set
 * in the URL — main.ts swaps it in place of `createRender3d` and
 * hides the canvases. Paints `buildGrid` into a `<pre>` each frame;
 * 3D-only concerns (loupe, perf-hud, scene captures) are stubbed.
 * State getter is late-bound after `createGameRuntime` returns.
 */

import {
  buildGrid,
  buildLegend,
  formatGrid,
} from "../src/runtime/dev-console-grid.ts";
import type { GameState } from "../src/shared/core/types.ts";
import type { RendererInterface } from "../src/shared/ui/overlay-types.ts";

export interface AsciiRendererInternal extends RendererInterface {
  setStateGetter(getter: () => GameState): void;
}

export function createAsciiRenderer(
  target: HTMLPreElement,
): AsciiRendererInternal {
  let getState: (() => GameState) | undefined;

  // `container` is the top-level game container (`#game-container`).
  // The runtime adds `.active` to it to show the game area. Mirrors
  // render-canvas.ts; closest() tolerates intermediate wrappers.
  const container =
    (target.closest("#game-container") as HTMLElement | null) ??
    (target.parentElement as HTMLElement);

  // Style the <pre> so the grid is legible and the renderer can swap
  // in cleanly without leaning on the production canvas CSS.
  target.style.fontFamily =
    "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  target.style.whiteSpace = "pre";
  target.style.background = "#000";
  target.style.color = "#eee";
  target.style.padding = "8px";
  target.style.margin = "0";
  target.style.fontSize = "12px";
  target.style.lineHeight = "1.05";
  target.style.minHeight = "100vh";
  target.textContent = "(waiting for game state...)";

  return {
    drawFrame: () => {
      if (!getState) return;
      const state = getState();
      // Pre-game phases (lobby, mode-select) keep `state` itself as
      // null on the runtime — buildGrid dereferences `state.map.tiles`
      // unconditionally, so skip rendering until a game is in flight.
      if (!state || !state.map) {
        target.textContent = "(lobby — game not started)";
        return;
      }
      const grid = buildGrid(state, "all", undefined);
      target.textContent = formatGrid(grid, buildLegend(state), {
        coords: false,
      });
    },
    warmMapCache: () => {},
    captureScene: () => undefined,
    captureSceneOffscreen: () => undefined,
    clientToSurface: (clientX: number, clientY: number) => ({
      x: clientX,
      y: clientY,
    }),
    screenToContainerCSS: (sx: number, sy: number) => ({ x: sx, y: sy }),
    eventTarget: target,
    container,
    setStateGetter(getter: () => GameState): void {
      getState = getter;
    },
  };
}
