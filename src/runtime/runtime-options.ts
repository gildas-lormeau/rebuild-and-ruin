import type { GameMap, Viewport } from "../shared/core/geometry-types.ts";
import { MAP_PX_H, MAP_PX_W, SCALE } from "../shared/core/grid.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import {
  CURSOR_DEFAULT,
  CURSOR_POINTER,
  IS_TOUCH_DEVICE,
} from "../shared/platform/platform.ts";
import type { RenderOverlay } from "../shared/ui/overlay-types.ts";
import {
  ACTION_KEYS,
  MAX_PLAYERS,
  SEED_CUSTOM,
  saveSettings,
} from "../shared/ui/player-config.ts";
import {
  HIT_ARROW,
  HIT_CLOSE,
  OPT_CONTROLS,
  OPT_SEED,
  OPT_SOUND,
} from "../shared/ui/settings-defs.ts";
import type { CycleOptionFn } from "../shared/ui/settings-ui.ts";
import { isInteractiveMode, Mode } from "../shared/ui/ui-mode.ts";
import type {
  ControlsScreenHitTestFn,
  CreateControlsOverlayFn,
  CreateOptionsOverlayFn,
  OptionsScreenHitTestFn,
  SeedField,
  TimingApi,
  UIContext,
  VisibleOptionsFn,
} from "./runtime-contracts.ts";
import {
  type RuntimeState,
  resetFrameTiming,
  safeState,
} from "./runtime-state.ts";

interface OptionsSystemDeps {
  runtimeState: RuntimeState;
  /** Injected timing primitives — replaces bare `performance.now()` access
   *  needed by `resetFrameTiming` after closing the options screen mid-game. */
  timing: TimingApi;
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
  isOnline: boolean;
  remotePlayerSlots: () => ReadonlySet<ValidPlayerSlot>;
  onCloseOptions?: () => void;
  /** Open the HTML Sound modal (player-supplied Rampart file loader). */
  showSoundModal: () => void;
  /** True when player-supplied sound assets are present in IDB. */
  getSoundReady: () => boolean;
  /** Re-apply music + SFX mute state from `settings.soundEnabled` (and tab
   *  visibility). Called when the Sound row toggles. */
  applyAudioState: () => void;
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
  /** Open the HTML Sound modal (player-supplied Rampart file loader). */
  showSound: () => void;
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
    const idx = visibleToActualOptionIdx();
    if (idx === OPT_SOUND) {
      // No assets loaded → arrows act as a shortcut into the file-loader
      // modal (the only meaningful action available). Once assets are in IDB
      // the arrows toggle the soundEnabled mute flag.
      if (!deps.getSoundReady()) {
        deps.showSoundModal();
        return;
      }
      runtimeState.settings.soundEnabled = !runtimeState.settings.soundEnabled;
      saveSettings(runtimeState.settings);
      deps.applyAudioState();
      return;
    }
    deps.cycleOption(
      dir,
      idx,
      runtimeState.settings,
      runtimeState.optionsUI.returnMode,
      safeState(runtimeState) ?? null,
      deps.isOnline,
    );
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
    // Canonical source of truth is runtimeState.optionsUI.returnMode.
    // closeControls below reads the same field directly — keep both sites
    // consistent so a future reader does not infer that uiCtx getter and the
    // state field can disagree.
    const returnMode = runtimeState.optionsUI.returnMode;
    if (returnMode !== null) {
      uiCtx.setMode(returnMode);
      uiCtx.setOptionsReturnMode(null);
      resetFrameTiming(runtimeState, deps.timing.now());
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
  // Hit-test functions expect backing-store pixels — the two helpers below
  // centralise the CSS → backing-store (÷ SCALE) conversion so callers
  // always pass raw CSS coords.  (Lobby hit-tests handle scaling internally,
  // so runtime-lobby.ts passes CSS coords directly without a wrapper.)

  function optionsHitTest(
    canvasX: number,
    canvasY: number,
    optionCount?: number,
  ) {
    return deps.optionsScreenHitTest(
      canvasX / SCALE,
      canvasY / SCALE,
      MAP_PX_W,
      MAP_PX_H,
      optionCount ?? visibleOptionsForCtx().length,
    );
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

  function clickOptions(canvasX: number, canvasY: number): void {
    const visible = visibleOptionsForCtx();
    const hit = optionsHitTest(canvasX, canvasY, visible.length);
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
    } else if (realIdx === OPT_SOUND) {
      blurSeedInput();
      // Arrow tap on the Sound row toggles soundEnabled (or opens the modal
      // when no assets are loaded yet — handled inside changeOption). A tap
      // on the row label still opens the modal so the file loader stays
      // reachable even when arrows toggle.
      if (hit.type === HIT_ARROW) changeOption(hit.dir);
      else deps.showSoundModal();
    } else if (realIdx === OPT_SEED) {
      focusSeedInput();
    } else {
      blurSeedInput();
      if (hit.type === HIT_ARROW) changeOption(hit.dir);
    }
  }

  function cursorAt(canvasX: number, canvasY: number): string {
    return optionsHitTest(canvasX, canvasY) ? CURSOR_POINTER : CURSOR_DEFAULT;
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
    if (deps.remotePlayerSlots().size > 0) return false;
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
    showSound: deps.showSoundModal,
    togglePause,
  };
}
