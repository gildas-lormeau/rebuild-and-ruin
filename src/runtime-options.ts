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
import { setHapticsLevel } from "./input-haptics.ts";
import type { MapData, RenderOverlay, Viewport } from "./render-types.ts";
import type { RuntimeState } from "./runtime-state.ts";
import { setSoundLevel } from "./sound-system.ts";
import { Mode, Phase } from "./types.ts";

interface OptionsSystemDeps {
  rs: RuntimeState;
  uiCtx: UIContext;
  renderFrame: (
    map: MapData,
    overlay: RenderOverlay | undefined,
    viewport?: Viewport | null,
  ) => void;
  updateDpad: (phase: Phase | null) => void;
  setDpadLeftHanded: (left: boolean) => void;
  refreshLobbySeed: () => void;
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
  const { rs, uiCtx } = deps;

  function visibleOptionsForCtx(): number[] {
    return visibleOptions(uiCtx);
  }

  /** Map cursor row to real option index. */
  function realOptionIdx(): number {
    return visibleOptionsForCtx()[rs.optionsCursor] ?? rs.optionsCursor;
  }

  function changeOption(dir: number): void {
    cycleOption(
      dir,
      realOptionIdx(),
      rs.settings,
      rs.optionsReturnMode,
      rs.state ?? null,
      deps.isOnline,
    );
    setHapticsLevel(rs.settings.haptics);
    setSoundLevel(rs.settings.sound);
    deps.setDpadLeftHanded(rs.settings.leftHanded);
  }

  function renderOptions(): void {
    const { map, overlay } = createOptionsOverlay(uiCtx);
    deps.renderFrame(map, overlay);
  }

  function showOptions(): void {
    showOptionsShared(uiCtx, { OPTIONS: Mode.OPTIONS });
    deps.updateDpad(Phase.WALL_BUILD); // enable d-pad for options navigation
  }

  function closeOptions(): void {
    const wasInGame = rs.optionsReturnMode !== null;
    closeOptionsShared(uiCtx, { LOBBY: Mode.LOBBY, GAME: Mode.GAME });
    if (wasInGame) {
      rs.lastTime = performance.now(); // avoid huge dt on first frame back
    } else {
      deps.refreshLobbySeed(); // regenerate map preview with (possibly changed) seed
      deps.updateDpad(null); // back to lobby — disable d-pad
    }
    deps.onCloseOptions?.();
  }

  function renderControls(): void {
    const { map, overlay } = createControlsOverlay(uiCtx);
    deps.renderFrame(map, overlay);
  }

  function showControls(): void {
    showControlsShared(uiCtx, { CONTROLS: Mode.CONTROLS });
    deps.updateDpad(Phase.WALL_BUILD); // enable d-pad for controls navigation
  }

  function closeControls(): void {
    if (rs.optionsReturnMode !== null) {
      for (const ctrl of rs.controllers) {
        const kb = rs.settings.keyBindings[ctrl.playerId];
        if (kb) ctrl.updateBindings(kb);
      }
    }
    closeControlsShared(uiCtx, { OPTIONS: Mode.OPTIONS });
  }

  function togglePause(): boolean {
    // Disable pause when other human players are connected
    if (deps.getRemoteHumanSlots().size > 0) return false;
    return togglePauseShared(uiCtx, {
      GAME: Mode.GAME,
      SELECTION: Mode.SELECTION,
    });
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
