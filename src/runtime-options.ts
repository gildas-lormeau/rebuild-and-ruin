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
  showControls as showControlsShared,
  showOptions as showOptionsShared,
  togglePause as togglePauseShared,
  visibleOptions,
} from "./game-ui-screens.ts";
import { cycleOption } from "./game-ui-settings.ts";
import type { HapticsSystem } from "./haptics-system.ts";
import type { MapData, RenderOverlay, Viewport } from "./render-types.ts";
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

  function togglePause(): boolean {
    // Disable pause when other human players are connected
    if (deps.getRemoteHumanSlots().size > 0) return false;
    return togglePauseShared(uiCtx);
  }

  return {
    realOptionIdx,
    changeOption,
    renderOptions,
    showOptions,
    closeOptions,
    renderControls,
    showControls,
    closeControls,
    togglePause,
  };
}
