/**
 * Options / Controls / Pause sub-system factory.
 *
 * Extracted from runtime.ts. Follows the same factory-with-deps
 * pattern as runtime-camera.ts and runtime-lobby.ts.
 */

import type { UIContext } from "./game-ui-screens.ts";
import {
  closeControls as closeControlsShared,
  closeOptions as closeOptionsShared,
  createControlsOverlay,
  createOptionsOverlay,
  OPTION_CONTROLS,
  showControls as showControlsShared,
  showOptions as showOptionsShared,
  togglePause as togglePauseShared,
  visibleOptions,
} from "./game-ui-screens.ts";
import { cycleOption } from "./game-ui-settings.ts";
import { GRID_COLS, GRID_ROWS, SCALE, TILE_SIZE } from "./grid.ts";
import type { HapticsSystem } from "./haptics-system.ts";
import { CURSOR_DEFAULT, CURSOR_POINTER } from "./platform.ts";
import { ACTION_KEYS, MAX_PLAYERS } from "./player-config.ts";
import type { MapData, RenderOverlay, Viewport } from "./render-types.ts";
import {
  controlsScreenHitTest,
  HIT_ARROW,
  HIT_CLOSE,
  optionsScreenHitTest,
} from "./render-ui.ts";
import { type RuntimeState, safeState } from "./runtime-state.ts";
import type { SoundSystem } from "./sound-system.ts";

interface OptionsSystemDeps {
  runtimeState: RuntimeState;
  uiCtx: UIContext;
  renderFrame: (
    map: MapData,
    overlay: RenderOverlay | undefined,
    viewport?: Viewport | null,
  ) => void;
  /** Enable/disable the d-pad (true = enabled with navigation, false = disabled). */
  updateDpad: (enabled: boolean) => void;
  setDpadLeftHanded: (left: boolean) => void;
  refreshLobbySeed: () => void;
  sound: Pick<SoundSystem, "setLevel">;
  haptics: Pick<HapticsSystem, "setLevel">;
  isOnline: boolean;
  getRemoteHumanSlots: () => ReadonlySet<number>;
  onCloseOptions?: () => void;
}

export interface OptionsSystem {
  realOptionIdx: () => number;
  changeOption: (dir: number) => void;
  clickOptions: (canvasX: number, canvasY: number) => void;
  clickControls: (canvasX: number, canvasY: number) => void;
  /** Returns CSS cursor for the given canvas coordinate (pointer over interactive elements). */
  cursorAt: (canvasX: number, canvasY: number) => string;
  /** Returns CSS cursor for controls screen (pointer over cells and close button). */
  controlsCursorAt: (canvasX: number, canvasY: number) => string;
  renderOptions: () => void;
  showOptions: () => void;
  closeOptions: () => void;
  renderControls: () => void;
  showControls: () => void;
  closeControls: () => void;
  togglePause: () => boolean;
}

export function createOptionsSystem(deps: OptionsSystemDeps): OptionsSystem {
  const { runtimeState, uiCtx } = deps;

  function visibleOptionsForCtx(): number[] {
    return visibleOptions(uiCtx);
  }

  /** Map cursor row to real option index. */
  function realOptionIdx(): number {
    return (
      visibleOptionsForCtx()[runtimeState.optionsCursor] ??
      runtimeState.optionsCursor
    );
  }

  function changeOption(dir: number): void {
    cycleOption(
      dir,
      realOptionIdx(),
      runtimeState.settings,
      runtimeState.optionsReturnMode,
      safeState(runtimeState) ?? null,
      deps.isOnline,
    );
    deps.haptics.setLevel(runtimeState.settings.haptics);
    deps.sound.setLevel(runtimeState.settings.sound);
    deps.setDpadLeftHanded(runtimeState.settings.leftHanded);
  }

  function renderOptions(): void {
    const { map, overlay } = createOptionsOverlay(uiCtx);
    deps.renderFrame(map, overlay);
  }

  function showOptions(): void {
    showOptionsShared(uiCtx);
    deps.updateDpad(true);
  }

  function closeOptions(): void {
    const wasInGame = runtimeState.optionsReturnMode !== null;
    closeOptionsShared(uiCtx);
    if (wasInGame) {
      runtimeState.lastTime = performance.now(); // avoid huge dt on first frame back
    } else {
      deps.refreshLobbySeed(); // regenerate map preview with (possibly changed) seed
      deps.updateDpad(false); // back to lobby — disable d-pad
    }
    deps.onCloseOptions?.();
  }

  function renderControls(): void {
    const { map, overlay } = createControlsOverlay(uiCtx);
    deps.renderFrame(map, overlay);
  }

  function showControls(): void {
    showControlsShared(uiCtx);
    deps.updateDpad(true);
  }

  function closeControls(): void {
    if (runtimeState.optionsReturnMode !== null) {
      for (const ctrl of runtimeState.controllers) {
        const kb = runtimeState.settings.keyBindings[ctrl.playerId];
        if (kb) ctrl.updateBindings(kb);
      }
    }
    closeControlsShared(uiCtx);
  }

  function clickOptions(canvasX: number, canvasY: number): void {
    const W = GRID_COLS * TILE_SIZE;
    const H = GRID_ROWS * TILE_SIZE;
    const visible = visibleOptionsForCtx();
    const hit = optionsScreenHitTest(
      canvasX / SCALE,
      canvasY / SCALE,
      W,
      H,
      visible.length,
    );
    if (!hit) return;
    if (hit.type === HIT_CLOSE) {
      closeOptions();
      return;
    }
    // Move cursor to the tapped row
    runtimeState.optionsCursor = hit.index;
    const realIdx = visible[hit.index] ?? hit.index;
    if (realIdx === OPTION_CONTROLS) {
      showControls();
    } else if (hit.type === HIT_ARROW) {
      changeOption(hit.dir);
    }
  }

  function cursorAt(canvasX: number, canvasY: number): string {
    const W = GRID_COLS * TILE_SIZE;
    const H = GRID_ROWS * TILE_SIZE;
    const hit = optionsScreenHitTest(
      canvasX / SCALE,
      canvasY / SCALE,
      W,
      H,
      visibleOptionsForCtx().length,
    );
    return hit ? CURSOR_POINTER : CURSOR_DEFAULT;
  }

  function controlsHitTest(canvasX: number, canvasY: number) {
    const W = GRID_COLS * TILE_SIZE;
    const H = GRID_ROWS * TILE_SIZE;
    return controlsScreenHitTest(
      canvasX / SCALE,
      canvasY / SCALE,
      W,
      H,
      MAX_PLAYERS,
      ACTION_KEYS.length,
    );
  }

  function clickControls(canvasX: number, canvasY: number): void {
    const hit = controlsHitTest(canvasX, canvasY);
    if (!hit) return;
    if (hit.type === HIT_CLOSE) {
      if (!runtimeState.controlsState.rebinding) closeControls();
      return;
    }
    const cs = runtimeState.controlsState;
    if (cs.rebinding) return; // ignore taps while waiting for key press
    cs.playerIdx = hit.playerIdx;
    cs.actionIdx = hit.actionIdx;
    cs.rebinding = true;
  }

  function controlsCursorAt(canvasX: number, canvasY: number): string {
    return controlsHitTest(canvasX, canvasY) ? CURSOR_POINTER : CURSOR_DEFAULT;
  }

  function togglePause(): boolean {
    // Disable pause when other human players are connected
    if (deps.getRemoteHumanSlots().size > 0) return false;
    return togglePauseShared(uiCtx);
  }

  return {
    realOptionIdx,
    changeOption,
    clickOptions,
    clickControls,
    cursorAt,
    controlsCursorAt,
    renderOptions,
    showOptions,
    closeOptions,
    renderControls,
    showControls,
    closeControls,
    togglePause,
  };
}
