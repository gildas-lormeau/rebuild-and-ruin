/**
 * Options / Controls / Pause sub-system factory.
 *
 * Extracted from runtime.ts. Follows the same factory-with-deps
 * pattern as runtime-camera.ts and runtime-lobby.ts.
 */

import type { SeedField } from "../input/input-seed-field.ts";
import type {
  CreateControlsOverlayFn,
  CreateOptionsOverlayFn,
  UIContext,
  VisibleOptionsFn,
} from "../render/render-ui-screens.ts";
import type {
  ControlsScreenHitTestFn,
  OptionsScreenHitTestFn,
} from "../render/render-ui-settings.ts";
import type { GameMap, Viewport } from "../shared/geometry-types.ts";
import { MAP_PX_H, MAP_PX_W, SCALE } from "../shared/grid.ts";
import type { RenderOverlay } from "../shared/overlay-types.ts";
import {
  CURSOR_DEFAULT,
  CURSOR_POINTER,
  IS_TOUCH_DEVICE,
} from "../shared/platform.ts";
import {
  ACTION_KEYS,
  MAX_PLAYERS,
  SEED_CUSTOM,
  saveSettings,
} from "../shared/player-config.ts";
import {
  HIT_ARROW,
  HIT_CLOSE,
  OPT_CONTROLS,
  OPT_SEED,
} from "../shared/settings-defs.ts";
import type { CycleOptionFn } from "../shared/settings-ui.ts";
import type {
  HapticsSystem,
  SoundSystem,
} from "../shared/system-interfaces.ts";
import { isInteractiveMode, Mode } from "../shared/ui-mode.ts";
import { type RuntimeState, safeState } from "./runtime-state.ts";

interface OptionsSystemDeps {
  runtimeState: RuntimeState;
  uiCtx: UIContext;
  renderFrame: (
    map: GameMap,
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
  seedField: SeedField;

  // Render-domain functions (injected from composition root)
  controlsScreenHitTest: ControlsScreenHitTestFn;
  optionsScreenHitTest: OptionsScreenHitTestFn;
  createControlsOverlay: CreateControlsOverlayFn;
  createOptionsOverlay: CreateOptionsOverlayFn;
  visibleOptions: VisibleOptionsFn;
  cycleOption: CycleOptionFn;
}

interface OptionsSystem {
  visibleToActualOptionIdx: () => number;
  changeOption: (dir: number) => void;
  clickOptions: (canvasX: number, canvasY: number) => void | Promise<void>;
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

  function focusSeedInput(): void {
    if (!IS_TOUCH_DEVICE || deps.isOnline) return;
    if (runtimeState.optionsUI.returnMode !== null) return; // read-only in-game
    runtimeState.settings.seedMode = SEED_CUSTOM;
    deps.seedField.focus(runtimeState.settings.seed);
  }

  function blurSeedInput(): void {
    deps.seedField.blur();
  }

  function visibleOptionsForCtx(): number[] {
    return deps.visibleOptions(uiCtx);
  }

  /** Map cursor row to real option index. */
  function visibleToActualOptionIdx(): number {
    return (
      visibleOptionsForCtx()[runtimeState.optionsUI.cursor] ??
      runtimeState.optionsUI.cursor
    );
  }

  function changeOption(dir: number): void {
    deps.cycleOption(
      dir,
      visibleToActualOptionIdx(),
      runtimeState.settings,
      runtimeState.optionsUI.returnMode,
      safeState(runtimeState) ?? null,
      deps.isOnline,
    );
    deps.haptics.setLevel(runtimeState.settings.haptics);
    deps.sound.setLevel(runtimeState.settings.sound);
    deps.setDpadLeftHanded(runtimeState.settings.leftHanded);
  }

  function renderOptions(): void {
    const { map, overlay } = deps.createOptionsOverlay(uiCtx);
    deps.renderFrame(map, overlay);
  }

  function showOptions(): void {
    uiCtx.optionsCursor.value = 0;
    uiCtx.setMode(Mode.OPTIONS);
    deps.updateDpad(true);
  }

  function closeOptions(): void {
    blurSeedInput();
    const returnMode = uiCtx.getOptionsReturnMode();
    if (returnMode !== null) {
      uiCtx.setMode(returnMode);
      uiCtx.setOptionsReturnMode(null);
      runtimeState.lastTime = performance.now(); // avoid huge dt on first frame back
    } else {
      uiCtx.setMode(Mode.LOBBY);
      saveSettings(uiCtx.settings);
      deps.refreshLobbySeed(); // regenerate map preview with (possibly changed) seed
      deps.updateDpad(false); // back to lobby — disable d-pad
    }
    deps.onCloseOptions?.();
  }

  function renderControls(): void {
    const { map, overlay } = deps.createControlsOverlay(uiCtx);
    deps.renderFrame(map, overlay);
  }

  function showControls(): void {
    uiCtx.controlsState.playerIdx = 0;
    uiCtx.controlsState.actionIdx = 0;
    uiCtx.controlsState.rebinding = false;
    uiCtx.setMode(Mode.CONTROLS);
    deps.updateDpad(true);
  }

  function closeControls(): void {
    if (runtimeState.optionsUI.returnMode !== null) {
      for (const ctrl of runtimeState.controllers) {
        const keyBindings = runtimeState.settings.keyBindings[ctrl.playerId];
        if (keyBindings) ctrl.updateBindings(keyBindings);
      }
    }
    saveSettings(uiCtx.settings);
    uiCtx.setMode(Mode.OPTIONS);
  }

  // Coordinate space: canvasX/canvasY are CSS pixels (from getBoundingClientRect).
  // Hit-test functions expect backing-store pixels, so divide by SCALE here.
  // CONTRAST with runtime-lobby.ts which passes raw canvas coords — lobby hit-tests
  // handle TILE_SIZE internally and expect CSS-pixel input directly.

  function clickOptions(canvasX: number, canvasY: number): void {
    const visible = visibleOptionsForCtx();
    const hit = deps.optionsScreenHitTest(
      canvasX / SCALE,
      canvasY / SCALE,
      MAP_PX_W,
      MAP_PX_H,
      visible.length,
    );
    if (!hit) return;
    if (hit.type === HIT_CLOSE) {
      closeOptions();
      return;
    }
    // Move cursor to the tapped row
    runtimeState.optionsUI.cursor = hit.index;
    const realIdx = visible[hit.index] ?? hit.index;
    if (realIdx === OPT_CONTROLS) {
      blurSeedInput();
      showControls();
    } else if (realIdx === OPT_SEED) {
      focusSeedInput();
    } else {
      blurSeedInput();
      if (hit.type === HIT_ARROW) changeOption(hit.dir);
    }
  }

  function cursorAt(canvasX: number, canvasY: number): string {
    const hit = deps.optionsScreenHitTest(
      canvasX / SCALE,
      canvasY / SCALE,
      MAP_PX_W,
      MAP_PX_H,
      visibleOptionsForCtx().length,
    );
    return hit ? CURSOR_POINTER : CURSOR_DEFAULT;
  }

  function controlsHitTest(canvasX: number, canvasY: number) {
    return deps.controlsScreenHitTest(
      canvasX / SCALE,
      canvasY / SCALE,
      MAP_PX_W,
      MAP_PX_H,
      IS_TOUCH_DEVICE ? 1 : MAX_PLAYERS,
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
    const controlsState = runtimeState.controlsState;
    if (controlsState.rebinding) return; // ignore taps while waiting for key press
    controlsState.playerIdx = hit.playerIdx;
    controlsState.actionIdx = hit.actionIdx;
    controlsState.rebinding = true;
  }

  function controlsCursorAt(canvasX: number, canvasY: number): string {
    return controlsHitTest(canvasX, canvasY) ? CURSOR_POINTER : CURSOR_DEFAULT;
  }

  function togglePause(): boolean {
    // Disable pause when other human players are connected
    if (deps.getRemoteHumanSlots().size > 0) return false;
    if (!isInteractiveMode(uiCtx.getMode())) return false;
    const next = !uiCtx.getPaused();
    uiCtx.setPaused(next);
    uiCtx.getFrame().announcement = next ? "PAUSED" : undefined;
    return true;
  }

  return {
    visibleToActualOptionIdx,
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
