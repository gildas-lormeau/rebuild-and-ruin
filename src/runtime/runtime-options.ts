/**
 * Options / Controls / Pause sub-system factory.
 *
 * Extracted from runtime.ts. Follows the same factory-with-deps
 * pattern as runtime-camera.ts and runtime-lobby.ts.
 */

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
  MAX_SEED_LENGTH,
  SEED_CUSTOM,
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
import type {
  CloseControlsFn,
  CloseOptionsFn,
  CreateControlsOverlayFn,
  CreateOptionsOverlayFn,
  ShowControlsFn,
  ShowOptionsFn,
  TogglePauseFn,
  UIContext,
  VisibleOptionsFn,
} from "./runtime-screen-builders.ts";
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

  // Render-domain functions (injected from composition root)
  controlsScreenHitTest: ControlsScreenHitTestFn;
  optionsScreenHitTest: OptionsScreenHitTestFn;
  closeControlsShared: CloseControlsFn;
  closeOptionsShared: CloseOptionsFn;
  createControlsOverlay: CreateControlsOverlayFn;
  createOptionsOverlay: CreateOptionsOverlayFn;
  showControlsShared: ShowControlsFn;
  showOptionsShared: ShowOptionsFn;
  togglePauseShared: TogglePauseFn;
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
  showOptions: () => Promise<void>;
  closeOptions: () => void;
  renderControls: () => void;
  showControls: () => Promise<void>;
  closeControls: () => void;
  togglePause: () => boolean;
}

const HIDDEN_INPUT_STYLE: Partial<CSSStyleDeclaration> = {
  position: "fixed",
  top: "0",
  left: "0",
  opacity: "0",
  width: "1px",
  height: "1px",
  border: "none",
  padding: "0",
  pointerEvents: "none",
};

export function createOptionsSystem(deps: OptionsSystemDeps): OptionsSystem {
  const { runtimeState, uiCtx } = deps;

  // ── Hidden input for mobile virtual keyboard (seed entry) ──
  let seedInput: HTMLInputElement | undefined;

  function ensureSeedInput(): HTMLInputElement {
    if (seedInput) return seedInput;
    const el = document.createElement("input");
    el.type = "text";
    el.inputMode = "numeric";
    el.pattern = "[0-9]*";
    el.maxLength = MAX_SEED_LENGTH;
    el.autocomplete = "off";
    Object.assign(el.style, HIDDEN_INPUT_STYLE);
    el.addEventListener("input", () => {
      // Sync input value → settings.seed (strip non-digits, cap length)
      const digits = el.value.replace(/\D/g, "").slice(0, MAX_SEED_LENGTH);
      el.value = digits;
      runtimeState.settings.seedMode = SEED_CUSTOM;
      runtimeState.settings.seed = digits;
    });
    document.body.appendChild(el);
    seedInput = el;
    return el;
  }

  function focusSeedInput(): void {
    if (!IS_TOUCH_DEVICE || deps.isOnline) return;
    if (runtimeState.optionsUI.returnMode !== null) return; // read-only in-game
    const el = ensureSeedInput();
    el.value = runtimeState.settings.seed;
    runtimeState.settings.seedMode = SEED_CUSTOM;
    el.focus({ preventScroll: true });
  }

  function blurSeedInput(): void {
    seedInput?.blur();
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

  async function showOptions(): Promise<void> {
    await deps.showOptionsShared(uiCtx);
    deps.updateDpad(true);
  }

  function closeOptions(): void {
    blurSeedInput();
    const wasInGame = runtimeState.optionsUI.returnMode !== null;
    deps.closeOptionsShared(uiCtx);
    if (wasInGame) {
      runtimeState.lastTime = performance.now(); // avoid huge dt on first frame back
    } else {
      deps.refreshLobbySeed(); // regenerate map preview with (possibly changed) seed
      deps.updateDpad(false); // back to lobby — disable d-pad
    }
    deps.onCloseOptions?.();
  }

  function renderControls(): void {
    const { map, overlay } = deps.createControlsOverlay(uiCtx);
    deps.renderFrame(map, overlay);
  }

  async function showControls(): Promise<void> {
    await deps.showControlsShared(uiCtx);
    deps.updateDpad(true);
  }

  function closeControls(): void {
    if (runtimeState.optionsUI.returnMode !== null) {
      for (const ctrl of runtimeState.controllers) {
        const kb = runtimeState.settings.keyBindings[ctrl.playerId];
        if (kb) ctrl.updateBindings(kb);
      }
    }
    deps.closeControlsShared(uiCtx);
  }

  // Coordinate space: canvasX/canvasY are CSS pixels (from getBoundingClientRect).
  // Hit-test functions expect backing-store pixels, so divide by SCALE here.
  // CONTRAST with runtime-lobby.ts which passes raw canvas coords — lobby hit-tests
  // handle TILE_SIZE internally and expect CSS-pixel input directly.

  async function clickOptions(canvasX: number, canvasY: number): Promise<void> {
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
      await showControls();
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
    return deps.togglePauseShared(uiCtx);
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
