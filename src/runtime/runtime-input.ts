import type { RegisterOnlineInputDeps } from "../input/input.ts";
import type { DispatchPointerMoveFn } from "../input/input-dispatch.ts";
import type { RegisterKeyboardHandlersFn } from "../input/input-keyboard.ts";
import type { RegisterMouseHandlersFn } from "../input/input-mouse.ts";
import type { RegisterTouchHandlersFn } from "../input/input-touch-canvas.ts";
import type {
  CreateDpadFn,
  CreateEnemyZoomButtonFn,
  CreateFloatingActionsFn,
  CreateHomeZoomButtonFn,
  CreateQuitButtonFn,
  FloatingActionsHandle,
} from "../input/input-touch-ui.ts";
import {
  FOCUS_MENU,
  FOCUS_REMATCH,
  type GameOverFocus,
  type ResolvedChoice,
} from "../shared/dialog-types.ts";
import { Action, Mode } from "../shared/game-phase.ts";
import type {
  LoupeHandle,
  RendererInterface,
} from "../shared/overlay-types.ts";
import { IS_TOUCH_DEVICE } from "../shared/platform.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import { OPT_CONTROLS } from "../shared/settings-defs.ts";
import { towerCenterPx } from "../shared/spatial.ts";
import {
  type HapticsSystem,
  type InputReceiver,
  isHuman,
  type PlayerController,
  type SoundSystem,
} from "../shared/system-interfaces.ts";
import { type GameState } from "../shared/types.ts";
import { type RuntimeState, safeState, setMode } from "./runtime-state.ts";
import type { CameraSystem } from "./runtime-types.ts";

type DpadHandle = ReturnType<CreateDpadFn>;

type ZoomButtonHandle = ReturnType<CreateHomeZoomButtonFn>;

type QuitButtonHandle = ReturnType<CreateQuitButtonFn>;

interface TouchHandles {
  dpad: DpadHandle | null;
  floatingActions: FloatingActionsHandle | null;
  homeZoomButton: ZoomButtonHandle | null;
  enemyZoomButton: ZoomButtonHandle | null;
  quitButton: QuitButtonHandle | null;
  loupeHandle: LoupeHandle | null;
}

interface InputSystemDeps {
  readonly runtimeState: RuntimeState;
  readonly renderer: RendererInterface;
  readonly gameContainer: HTMLElement;

  // Render-layer hit tests (injected from composition root, not imported directly)
  readonly hitTests: {
    readonly lifeLostDialogClick: (
      screenX: number,
      screenY: number,
    ) => { playerId: ValidPlayerSlot; choice: ResolvedChoice } | null;
    readonly upgradePickClick: (
      screenX: number,
      screenY: number,
    ) => { playerId: ValidPlayerSlot; cardIdx: number } | null;
    readonly visibleOptionCount: () => number;
  };

  // Config / networking
  readonly network: {
    readonly isOnline?: boolean;
    readonly maybeSendAimUpdate?: (x: number, y: number) => void;
    readonly tryPlaceCannonAndSend?: (
      ctrl: PlayerController & InputReceiver,
      gs: GameState,
      max: number,
    ) => boolean;
    readonly tryPlacePieceAndSend?: (
      ctrl: PlayerController & InputReceiver,
      gs: GameState,
    ) => boolean;
    readonly fireAndSend?: (ctrl: PlayerController, gs: GameState) => void;
    readonly getIsHost: () => boolean;
  };

  // Sub-systems (inline signatures to avoid cross-sub-system imports)
  readonly lobby: {
    lobbyKeyJoin: (key: string) => boolean;
    lobbyClick: (x: number, y: number) => boolean;
    cursorAt: (x: number, y: number) => string;
  };
  readonly options: {
    showOptions: () => void;
    clickOptions: (canvasX: number, canvasY: number) => void;
    clickControls: (canvasX: number, canvasY: number) => void;
    cursorAt: (canvasX: number, canvasY: number) => string;
    controlsCursorAt: (canvasX: number, canvasY: number) => string;
    closeOptions: () => void;
    showControls: () => void;
    closeControls: () => void;
    changeOption: (dir: number) => void;
    visibleToActualOptionIdx: () => number;
    togglePause: () => boolean;
  };
  readonly lifeLost: {
    sendLifeLostChoice: (
      choice: ResolvedChoice,
      playerId: ValidPlayerSlot,
    ) => void;
    toggleFocus: (playerId: ValidPlayerSlot) => void;
    confirmChoice: (playerId: ValidPlayerSlot) => void;
    applyChoice: (playerId: ValidPlayerSlot, choice: ResolvedChoice) => void;
  };
  readonly upgradePick: {
    moveFocus: (playerId: ValidPlayerSlot, dir: number) => void;
    confirmChoice: (playerId: ValidPlayerSlot) => void;
    pickDirect: (playerId: ValidPlayerSlot, cardIdx: number) => void;
  };
  readonly selection: {
    highlight: (idx: number, zone: number, pid: ValidPlayerSlot) => void;
    confirmAndStartBuild: (
      pid: ValidPlayerSlot,
      isReselect?: boolean,
    ) => boolean;
    isReady: () => boolean;
  };
  readonly camera: Pick<
    CameraSystem,
    | "pixelToTile"
    | "screenToWorld"
    | "onPinchStart"
    | "onPinchUpdate"
    | "onPinchEnd"
    | "povPlayerId"
    | "getEnemyZones"
    | "getCameraZone"
    | "setCameraZone"
    | "enableMobileZoom"
  >;
  readonly sound: Pick<
    SoundSystem,
    "pieceRotated" | "piecePlaced" | "pieceFailed" | "cannonPlaced"
  >;
  readonly haptics: Pick<HapticsSystem, "tap">;

  // Input handler registration + pointer dispatch
  readonly inputHandlers: {
    readonly dispatchPointerMove: DispatchPointerMoveFn;
    readonly registerKeyboard: RegisterKeyboardHandlersFn;
    readonly registerMouse: RegisterMouseHandlersFn;
    readonly registerTouch: RegisterTouchHandlersFn;
  };

  // Touch UI element factories (only consumed when IS_TOUCH_DEVICE)
  readonly touchFactories: {
    readonly createDpad: CreateDpadFn;
    readonly createQuitButton: CreateQuitButtonFn;
    readonly createHomeZoomButton: CreateHomeZoomButtonFn;
    readonly createEnemyZoomButton: CreateEnemyZoomButtonFn;
    readonly createFloatingActions: CreateFloatingActionsFn;
  };

  // Lifecycle / navigation callbacks
  readonly lifecycle: {
    readonly render: () => void;
    readonly rematch: () => void;
    readonly returnToLobby: () => void;
    readonly gameOverClick: (canvasX: number, canvasY: number) => void;
  };

  // Sibling callbacks
  readonly pointerPlayer: () => (PlayerController & InputReceiver) | null;
  readonly withPointerPlayer: (
    action: (human: PlayerController & InputReceiver) => void,
  ) => void;
}

type PlacePieceFn = (
  ctrl: PlayerController & InputReceiver,
  gs: GameState,
) => boolean;

type PlaceCannonFn = (
  ctrl: PlayerController & InputReceiver,
  gs: GameState,
  max: number,
) => boolean;

interface InputSystem {
  register(deps: InputSystemDeps): void;
  getTouch(): TouchHandles;
  resetForLobby(runtimeState: RuntimeState): void;
}

const NOOP = () => {};

export function createInputSystem(): InputSystem {
  // Touch handles are owned by the input system. They start null and are
  // populated during register() when the DOM is wired up.
  const touch: TouchHandles = {
    dpad: null,
    floatingActions: null,
    homeZoomButton: null,
    enemyZoomButton: null,
    quitButton: null,
    loupeHandle: null,
  };

  function register(deps: InputSystemDeps): void {
    const rs = deps.runtimeState;
    const { camera, sound, lobby, selection } = deps;

    // ── Wrapped placement handlers ──
    const placeCannon = wrapCannonPlace(
      deps.network.tryPlaceCannonAndSend ??
        ((ctrl, gs, max) => ctrl.tryPlaceCannon(gs, max)),
      sound,
    );
    const placePieceWrapped = wrapPiecePlace(
      deps.network.tryPlacePieceAndSend ??
        ((ctrl, gs) => ctrl.tryPlacePiece(gs)),
      sound,
    );

    const coordsDeps: RegisterOnlineInputDeps["coords"] = {
      pixelToTile: camera.pixelToTile,
      screenToWorld: camera.screenToWorld,
      onPinchStart: camera.onPinchStart,
      onPinchUpdate: camera.onPinchUpdate,
      onPinchEnd: camera.onPinchEnd,
    };
    const lobbyDeps: RegisterOnlineInputDeps["lobby"] = {
      isActive: () => rs.lobby.active,
      keyJoin: lobby.lobbyKeyJoin,
      click: lobby.lobbyClick,
      cursorAt: lobby.cursorAt,
    };
    const gameActionDeps = buildGameActionDeps(
      rs,
      selection,
      placeCannon,
      placePieceWrapped,
      sound,
      deps.network.fireAndSend,
    );

    // ── Combined input deps: assembles all subsystem deps ──
    const inputDeps = buildInputDeps(
      deps,
      coordsDeps,
      lobbyDeps,
      gameActionDeps,
    );

    deps.inputHandlers.registerMouse(inputDeps);
    deps.inputHandlers.registerKeyboard(inputDeps);
    deps.inputHandlers.registerTouch(inputDeps);

    // Touch controls: wire static DOM elements from index.html
    if (IS_TOUCH_DEVICE) {
      setupTouchControls(inputDeps, touch, deps);
    }
  }

  function getTouch(): TouchHandles {
    return touch;
  }

  function resetForLobby(runtimeState: RuntimeState): void {
    runtimeState.inputTracking.mouseJoinedSlot = null;
    runtimeState.inputTracking.directTouchActive = false;
    touch.floatingActions?.update(false, 0, 0, false, false);
    touch.dpad?.update(null);
    touch.quitButton?.update(null);
    touch.homeZoomButton?.update(false);
    touch.enemyZoomButton?.update(false);
    touch.loupeHandle?.update(false, 0, 0);
  }

  return { register, getTouch, resetForLobby };
}

function setupTouchControls(
  inputDeps: RegisterOnlineInputDeps,
  touch: TouchHandles,
  deps: InputSystemDeps,
): void {
  const { gameContainer, renderer, camera } = deps;

  gameContainer.classList.add("has-touch-panels");

  setupDpadAndActions(inputDeps, touch, deps);
  setupZoomButtons(touch, deps);
  setupFloatingActions(inputDeps, touch, deps);

  touch.loupeHandle = renderer.createLoupe?.(gameContainer) ?? null;
  camera.enableMobileZoom();
}

function buildInputDeps(
  deps: InputSystemDeps,
  coordsDeps: RegisterOnlineInputDeps["coords"],
  lobbyDeps: RegisterOnlineInputDeps["lobby"],
  gameActionDeps: RegisterOnlineInputDeps["gameAction"],
): RegisterOnlineInputDeps {
  const { runtimeState, renderer, withPointerPlayer } = deps;
  return {
    renderer,
    getState: () => safeState(runtimeState),
    getMode: () => runtimeState.mode,
    setMode: (mode) => {
      setMode(runtimeState, mode);
    },
    isOnline: deps.network.isOnline,
    settings: runtimeState.settings,
    getControllers: () => runtimeState.controllers,
    isHuman,
    withPointerPlayer,
    showLobby: deps.lifecycle.returnToLobby,
    rematch: deps.lifecycle.rematch,
    maybeSendAimUpdate: deps.network.maybeSendAimUpdate ?? NOOP,
    setDirectTouchActive: (active) => {
      runtimeState.inputTracking.directTouchActive = active;
    },
    isDirectTouchActive: () => runtimeState.inputTracking.directTouchActive,
    coords: coordsDeps,
    lobby: lobbyDeps,
    options: buildOptionsDeps(
      runtimeState,
      deps.options,
      deps.hitTests.visibleOptionCount,
    ),
    dialogAction: buildDialogActionHandler(
      runtimeState,
      deps.lifeLost,
      deps.upgradePick,
    ),
    lifeLost: buildLifeLostClickDeps(
      runtimeState,
      deps.pointerPlayer,
      deps.lifeLost,
      deps.hitTests.lifeLostDialogClick,
    ),
    upgradePick: buildUpgradePickClickDeps(
      runtimeState,
      deps.pointerPlayer,
      deps.upgradePick,
      deps.hitTests.upgradePickClick,
    ),
    gameOver: buildGameOverDeps(
      runtimeState,
      deps.lifecycle.render,
      deps.lifecycle.gameOverClick,
    ),
    gameAction: gameActionDeps,
    quit: buildQuitDeps(runtimeState),
  };
}

function buildOptionsDeps(
  runtimeState: RuntimeState,
  options: InputSystemDeps["options"],
  visibleOptionCount: () => number,
): RegisterOnlineInputDeps["options"] {
  return {
    show: options.showOptions,
    click: options.clickOptions,
    clickControls: options.clickControls,
    cursorAt: options.cursorAt,
    controlsCursorAt: options.controlsCursorAt,
    close: options.closeOptions,
    showControls: options.showControls,
    closeControls: options.closeControls,
    getCursor: () => runtimeState.optionsUI.cursor,
    setCursor: (cursor: number) => {
      runtimeState.optionsUI.cursor = cursor;
    },
    getCount: visibleOptionCount,
    getRealIdx: options.visibleToActualOptionIdx,
    confirmOption: () => {
      if (options.visibleToActualOptionIdx() === OPT_CONTROLS)
        options.showControls();
      else options.closeOptions();
    },
    getReturnMode: () => runtimeState.optionsUI.returnMode,
    setReturnMode: (mode: number | null) => {
      runtimeState.optionsUI.returnMode = mode as Mode | null;
    },
    changeValue: options.changeOption,
    togglePause: options.togglePause,
    getControlsState: () => runtimeState.controlsState,
  };
}

function buildDialogActionHandler(
  runtimeState: RuntimeState,
  lifeLost: InputSystemDeps["lifeLost"],
  upgradePick: InputSystemDeps["upgradePick"],
): RegisterOnlineInputDeps["dialogAction"] {
  return (playerId: ValidPlayerSlot, action: Action) => {
    if (runtimeState.mode === Mode.LIFE_LOST && runtimeState.lifeLostDialog) {
      if (action === Action.LEFT || action === Action.RIGHT) {
        lifeLost.toggleFocus(playerId);
        return true;
      }
      if (action === Action.CONFIRM) {
        lifeLost.confirmChoice(playerId);
        return true;
      }
    }
    if (
      runtimeState.mode === Mode.UPGRADE_PICK &&
      runtimeState.upgradePickDialog
    ) {
      if (action === Action.LEFT) {
        upgradePick.moveFocus(playerId, -1);
        return true;
      }
      if (action === Action.RIGHT) {
        upgradePick.moveFocus(playerId, 1);
        return true;
      }
      if (action === Action.CONFIRM) {
        upgradePick.confirmChoice(playerId);
        return true;
      }
    }
    return false;
  };
}

function buildLifeLostClickDeps(
  runtimeState: RuntimeState,
  pointerPlayer: InputSystemDeps["pointerPlayer"],
  lifeLost: InputSystemDeps["lifeLost"],
  hitTest: InputSystemDeps["hitTests"]["lifeLostDialogClick"],
): RegisterOnlineInputDeps["lifeLost"] {
  return {
    get: () => runtimeState.lifeLostDialog,
    click: (x: number, y: number) => {
      const hit = hitTest(x, y);
      if (!hit) return;
      const pp = pointerPlayer();
      if (pp && hit.playerId !== pp.playerId) return;
      lifeLost.applyChoice(hit.playerId, hit.choice);
    },
  };
}

function buildUpgradePickClickDeps(
  runtimeState: RuntimeState,
  pointerPlayer: InputSystemDeps["pointerPlayer"],
  upgradePick: InputSystemDeps["upgradePick"],
  hitTest: InputSystemDeps["hitTests"]["upgradePickClick"],
): RegisterOnlineInputDeps["upgradePick"] {
  return {
    get: () => runtimeState.upgradePickDialog,
    click: (x: number, y: number) => {
      const hit = hitTest(x, y);
      if (!hit) return;
      const pp = pointerPlayer();
      if (pp && hit.playerId !== pp.playerId) return;
      upgradePick.pickDirect(hit.playerId, hit.cardIdx);
    },
  };
}

function buildGameOverDeps(
  runtimeState: RuntimeState,
  render: () => void,
  gameOverClick: (canvasX: number, canvasY: number) => void,
): RegisterOnlineInputDeps["gameOver"] {
  return {
    getFocused: () => runtimeState.frame.gameOver?.focused ?? FOCUS_REMATCH,
    setFocused: (focused: GameOverFocus) => {
      if (runtimeState.frame.gameOver) {
        runtimeState.frame.gameOver.focused = focused;
        render();
      }
    },
    click: gameOverClick,
  };
}

function buildQuitDeps(
  runtimeState: RuntimeState,
): RegisterOnlineInputDeps["quit"] {
  return {
    getPending: () => runtimeState.quit.pending,
    setPending: (quitPending: boolean) => {
      runtimeState.quit.pending = quitPending;
    },
    setTimer: (quitTimer: number) => {
      runtimeState.quit.timer = quitTimer;
    },
    setMessage: (quitMessage: string) => {
      runtimeState.quit.message = quitMessage;
    },
  };
}

function buildGameActionDeps(
  runtimeState: RuntimeState,
  selection: InputSystemDeps["selection"],
  placeCannon: PlaceCannonFn,
  placePiece: PlacePieceFn,
  sound: InputSystemDeps["sound"],
  fireAndSend: InputSystemDeps["network"]["fireAndSend"],
) {
  return {
    getSelectionStates: () => runtimeState.selectionStates,
    highlightTowerForPlayer: selection.highlight,
    confirmSelectionAndStartBuild: selection.confirmAndStartBuild,
    isSelectionReady: selection.isReady,
    tryPlaceCannonAndSend: placeCannon,
    tryPlacePieceAndSend: placePiece,
    onPieceRotated: sound.pieceRotated,
    fireAndSend:
      fireAndSend ??
      ((ctrl: PlayerController, gameState: GameState) => ctrl.fire(gameState)),
  };
}

function setupDpadAndActions(
  inputDeps: RegisterOnlineInputDeps,
  touch: TouchHandles,
  deps: InputSystemDeps,
): void {
  const {
    runtimeState,
    gameContainer,
    sound,
    haptics,
    lobby,
    selection,
    withPointerPlayer,
  } = deps;
  const {
    tryPlacePieceAndSend: placePieceAction,
    tryPlaceCannonAndSend: placeCannonAction,
  } = inputDeps.gameAction;

  const overlayActionDeps = buildOverlayActionDeps(deps, inputDeps);

  touch.dpad = deps.touchFactories.createDpad(
    {
      getState: () => safeState(runtimeState),
      getMode: () => runtimeState.mode,
      withPointerPlayer,
      onHapticTap: haptics.tap,
      isHost: deps.network.getIsHost,
      lobbyAction: () =>
        lobby.lobbyKeyJoin(runtimeState.settings.keyBindings[0]!.confirm),
      getLeftHanded: () => runtimeState.settings.leftHanded,
      clearDirectTouch: () => {
        runtimeState.inputTracking.directTouchActive = false;
      },
      gameAction: {
        getSelectionStates: () => runtimeState.selectionStates,
        highlightTowerForPlayer: selection.highlight,
        confirmSelectionAndStartBuild: selection.confirmAndStartBuild,
        isSelectionReady: selection.isReady,
        tryPlacePieceAndSend: placePieceAction,
        tryPlaceCannonAndSend: placeCannonAction,
        onPieceRotated: sound.pieceRotated,
        fireAndSend: inputDeps.gameAction.fireAndSend,
      },
      overlay: overlayActionDeps,
    },
    gameContainer,
  );
  touch.dpad.update(null); // initial state: d-pad + rotate disabled
}

/** Build overlay action deps for touch d-pad (options, dialogs, game-over).
 *  Per-player dialogs (life-lost, upgrade pick) route through dialogAction
 *  with the pointer player's id — same path as keyboard dispatch. */
function buildOverlayActionDeps(
  deps: InputSystemDeps,
  inputDeps: RegisterOnlineInputDeps,
) {
  const { runtimeState, options } = deps;
  const { render, rematch, returnToLobby } = deps.lifecycle;
  const pointerPlayer = deps.pointerPlayer;
  return {
    options: {
      isActive: () => runtimeState.mode === Mode.OPTIONS,
      moveCursor: (dir: -1 | 1) => {
        const count = deps.hitTests.visibleOptionCount();
        runtimeState.optionsUI.cursor =
          (runtimeState.optionsUI.cursor + dir + count) % count;
      },
      changeValue: (dir: -1 | 1) => options.changeOption(dir),
      confirm: () => {
        if (options.visibleToActualOptionIdx() === OPT_CONTROLS)
          options.showControls();
        else options.closeOptions();
      },
    },
    dialogAction: (action: Action) => {
      const pp = pointerPlayer();
      if (!pp) return false;
      return inputDeps.dialogAction(pp.playerId, action);
    },
    gameOver: {
      isActive: () =>
        runtimeState.mode === Mode.STOPPED &&
        runtimeState.frame.gameOver !== undefined,
      toggleFocus: () => {
        if (!runtimeState.frame.gameOver) return;
        runtimeState.frame.gameOver.focused =
          runtimeState.frame.gameOver.focused === FOCUS_REMATCH
            ? FOCUS_MENU
            : FOCUS_REMATCH;
        render();
      },
      confirm: () => {
        if (!runtimeState.frame.gameOver) return;
        if (runtimeState.frame.gameOver.focused === FOCUS_REMATCH) rematch();
        else returnToLobby();
      },
    },
  };
}

function setupZoomButtons(touch: TouchHandles, deps: InputSystemDeps): void {
  const { runtimeState, gameContainer } = deps;
  const zoomDeps = buildZoomDeps(deps);

  touch.quitButton = deps.touchFactories.createQuitButton(
    {
      getQuitPending: () => runtimeState.quit.pending,
      setQuitPending: (quitPending: boolean) => {
        runtimeState.quit.pending = quitPending;
      },
      setQuitTimer: (quitTimer: number) => {
        runtimeState.quit.timer = quitTimer;
      },
      setQuitMessage: (msg: string) => {
        runtimeState.quit.message = msg;
      },
      showLobby: deps.lifecycle.returnToLobby,
      getControllers: () => runtimeState.controllers,
      isHuman,
    },
    gameContainer,
  );
  touch.quitButton.update(null); // initial state: hidden
  touch.homeZoomButton = deps.touchFactories.createHomeZoomButton(
    zoomDeps,
    gameContainer,
  );
  touch.enemyZoomButton = deps.touchFactories.createEnemyZoomButton(
    zoomDeps,
    gameContainer,
  );
  touch.homeZoomButton.update(false); // initial state: disabled
  touch.enemyZoomButton.update(false);
}

/** Build zoom button deps for touch controls (home/enemy zone zoom). */
function buildZoomDeps(deps: InputSystemDeps) {
  const { runtimeState, camera } = deps;
  const pointerPlayer = deps.pointerPlayer;
  return {
    getState: () => safeState(runtimeState),
    getCameraZone: camera.getCameraZone,
    setCameraZone: camera.setCameraZone,
    povPlayerId: camera.povPlayerId,
    getEnemyZones: camera.getEnemyZones,
    aimAtZone: (zone: number) => {
      const state = safeState(runtimeState);
      if (!state) return;
      const human = pointerPlayer();
      if (!human) return;
      const pid = state.playerZones.indexOf(zone);
      const tower = pid >= 0 ? state.players[pid]?.homeTower : null;
      if (!tower) return;
      const px = towerCenterPx(tower);
      human.setCrosshair(px.x, px.y);
    },
  };
}

function setupFloatingActions(
  inputDeps: RegisterOnlineInputDeps,
  touch: TouchHandles,
  deps: InputSystemDeps,
): void {
  const {
    runtimeState,
    renderer,
    gameContainer,
    sound,
    haptics,
    withPointerPlayer,
  } = deps;
  const {
    tryPlacePieceAndSend: placePieceAction,
    tryPlaceCannonAndSend: placeCannonAction,
  } = inputDeps.gameAction;

  const floatingEl =
    gameContainer.querySelector<HTMLElement>("#floating-actions");
  if (floatingEl) {
    touch.floatingActions = deps.touchFactories.createFloatingActions(
      {
        getState: () => safeState(runtimeState),
        getMode: () => runtimeState.mode,
        withPointerPlayer,
        tryPlacePieceAndSend: placePieceAction,
        tryPlaceCannonAndSend: placeCannonAction,
        onPieceRotated: sound.pieceRotated,
        onHapticTap: haptics.tap,
        onDrag: (clientX, clientY) => {
          const state = safeState(runtimeState);
          if (!state) return;
          const { x, y } = renderer.clientToSurface(clientX, clientY);
          deps.inputHandlers.dispatchPointerMove(x, y, state, inputDeps);
        },
      },
      floatingEl,
    );
  }
}

function wrapPiecePlace(
  inner: PlacePieceFn,
  sound: Pick<SoundSystem, "piecePlaced" | "pieceFailed">,
): PlacePieceFn {
  return (ctrl, gs) => {
    const ok = inner(ctrl, gs);
    if (ok) sound.piecePlaced();
    else sound.pieceFailed();
    return ok;
  };
}

function wrapCannonPlace(
  inner: PlaceCannonFn,
  sound: Pick<SoundSystem, "cannonPlaced">,
): PlaceCannonFn {
  return (ctrl, gs, max) => {
    const ok = inner(ctrl, gs, max);
    if (ok) sound.cannonPlaced();
    return ok;
  };
}
