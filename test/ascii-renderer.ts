/**
 * ASCII renderer — implements RendererInterface by rendering game state
 * as text grids via `buildGrid`. Plugs into the headless runtime through
 * the same `renderer` override the canvas recorder uses.
 *
 * Usage:
 *
 *     const ascii = createAsciiRenderer();
 *     const sc = await createScenario({ seed: 42, ascii });
 *     // after running some frames…
 *     console.log(ascii.lastFrame);
 *     console.log(ascii.frames.length);
 */

import {
  buildGrid,
  buildLegend,
  type MapLayer,
} from "../src/runtime/dev-console-grid.ts";
import type { GameMap, Viewport } from "../src/shared/core/geometry-types.ts";
import type {
  RendererInterface,
  RenderOverlay,
} from "../src/shared/ui/overlay-types.ts";
import type { GameState } from "../src/shared/core/types.ts";

export interface AsciiRenderer {
  /** All captured frames as text. */
  readonly frames: readonly string[];
  /** The most recent frame, or empty string if none captured yet. */
  readonly lastFrame: string;
  /** Render the current state on demand (outside the draw loop). */
  snapshot(layer?: MapLayer): string;
}

/** Internal type — includes RendererInterface + bind for createScenario. */
export interface AsciiRendererInternal
  extends AsciiRenderer,
    RendererInterface {
  bind(stateGetter: () => GameState): void;
}

export function createAsciiRenderer(): AsciiRendererInternal {
  const frames: string[] = [];
  const container = createStubElement();
  const eventTarget = createStubElement();
  let getState: (() => GameState) | undefined;

  function renderState(layer: MapLayer = "all"): string {
    if (!getState) throw new Error("AsciiRenderer not bound — call bind() first");
    const state = getState();
    const grid = buildGrid(state, layer, undefined);
    const lines = grid.map((row) => row.map((cell) => cell.char).join(""));
    return `${buildLegend(state)}\n${lines.join("\n")}`;
  }

  return {
    drawFrame(
      _map: GameMap,
      _overlay: RenderOverlay | undefined,
      _viewport: Viewport | null | undefined,
      _now: number,
    ) {
      if (!getState) return;
      frames.push(renderState());
    },
    warmMapCache(_map: GameMap) {},
    captureScene: () => undefined,
    clientToSurface: (clientX: number, clientY: number) => ({
      x: clientX,
      y: clientY,
    }),
    screenToContainerCSS: (sx: number, sy: number) => ({ x: sx, y: sy }),
    eventTarget,
    container,
    get frames() {
      return frames;
    },
    get lastFrame() {
      return frames.length > 0 ? frames[frames.length - 1]! : "";
    },
    snapshot(layer?: MapLayer) {
      return renderState(layer);
    },
    bind(stateGetter: () => GameState) {
      getState = stateGetter;
    },
  };
}

function createStubElement(): HTMLElement {
  const target = new EventTarget();
  const props = {
    clientHeight: 720,
    clientWidth: 1280,
    classList: {
      add: () => {},
      remove: () => {},
      contains: () => false,
      toggle: () => false,
    },
    querySelector: () => null,
    style: { cursor: "default" },
  };
  return Object.assign(target, props) as unknown as HTMLElement;
}
