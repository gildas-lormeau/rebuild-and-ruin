import {
  type InputReceiver,
  isHuman,
  type PlayerController,
} from "./controller-interfaces.ts";
import {
  FOCUS_MENU,
  FOCUS_REMATCH,
  type GameOverFocus,
  type ResolvedChoice,
} from "./dialog-types.ts";
import { Action, Mode } from "./game-phase.ts";
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "./grid.ts";
import type { HapticsSystem } from "./haptics-system.ts";
import type { RegisterOnlineInputDeps } from "./input.ts";
import { dispatchPointerMove } from "./input-dispatch.ts";
import { registerKeyboardHandlers } from "./input-keyboard.ts";
import { registerMouseHandlers } from "./input-mouse.ts";
import { registerTouchHandlers } from "./input-touch-canvas.ts";
import {
  createDpad,
  createEnemyZoomButton,
  createFloatingActions,
  createHomeZoomButton,
  createQuitButton,
  type FloatingActionsHandle,
} from "./input-touch-ui.ts";
import type { LoupeHandle, RendererInterface } from "./overlay-types.ts";
import { IS_TOUCH_DEVICE } from "./platform.ts";
import type { ValidPlayerSlot } from "./player-slot.ts";
import {
  handleLifeLostDialogClick,
  handleUpgradePickClick,
} from "./render-composition.ts";
import { type RuntimeState, safeState } from "./runtime-state.ts";
import type { CameraSystem } from "./runtime-types.ts";
import { type UIContext, visibleOptions } from "./screen-builders.ts";
import { OPT_CONTROLS } from "./settings-defs.ts";
import type { SoundSystem } from "./sound-system.ts";
import { towerCenterPx } from "./spatial.ts";
import { type GameState } from "./types.ts";

type DpadHandle = ReturnType<typeof createDpad>;

type ZoomButtonHandle = ReturnType<typeof createHomeZoomButton>;

type QuitButtonHandle = ReturnType<typeof createQuitButton>;

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
  readonly uiCtx: UIContext;

  // Config / networking
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

  // Sibling callbacks
  readonly pointerPlayer: () => (PlayerController & InputReceiver) | null;
  readonly withPointerPlayer: (
    action: (human: PlayerController & InputReceiver) => void,
  ) => void;
  readonly isSelectionReady: () => boolean;
  readonly render: () => void;
  readonly rematch: () => void;
  readonly returnToLobby: () => void;
  readonly gameOverClick: (canvasX: number, canvasY: number) => void;
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
  register(): void;
  readonly touch: TouchHandles;
}

export function createInputSystem(deps: InputSystemDeps): InputSystem {
  const { runtimeState, camera, sound, lobby, selection, isSelectionReady } =
    deps;

  const touch: TouchHandles = {
    dpad: null,
    floatingActions: null,
    homeZoomButton: null,
    enemyZoomButton: null,
    quitButton: null,
    loupeHandle: null,
  };

  function register(): void {
    // ── Wrapped placement handlers ──
    const placeCannon = wrapCannonPlace(
      deps.tryPlaceCannonAndSend ??
        ((ctrl, gs, max) => ctrl.tryPlaceCannon(gs, max)),
      sound,
    );
    const placePieceWrapped = wrapPiecePlace(
      deps.tryPlacePieceAndSend ?? ((ctrl, gs) => ctrl.tryPlacePiece(gs)),
      sound,
    );

    const coordsDeps = buildCoordsDeps(camera);
    const lobbyDeps = buildLobbyDeps(runtimeState, lobby);
    const gameActionDeps = buildGameActionDeps(
      runtimeState,
      selection,
      isSelectionReady,
      placeCannon,
      placePieceWrapped,
      sound,
      deps.fireAndSend,
    );

    // ── Combined input deps: assembles all subsystem deps ──
    const inputDeps = buildInputDeps(
      deps,
      coordsDeps,
      lobbyDeps,
      gameActionDeps,
    );

    registerMouseHandlers(inputDeps);
    registerKeyboardHandlers(inputDeps);
    registerTouchHandlers({
      ...inputDeps,
      lobby: { ...inputDeps.lobby, keyJoin: undefined },
    });

    // Touch controls: wire static DOM elements from index.html
    if (IS_TOUCH_DEVICE) {
      setupTouchControls(inputDeps, touch, deps);
    }
  }

  return { register, touch };
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
  coordsDeps: ReturnType<typeof buildCoordsDeps>,
  lobbyDeps: ReturnType<typeof buildLobbyDeps>,
  gameActionDeps: ReturnType<typeof buildGameActionDeps>,
): RegisterOnlineInputDeps {
  const { runtimeState, renderer, withPointerPlayer } = deps;
  return {
    renderer,
    getState: () => safeState(runtimeState),
    getMode: () => runtimeState.mode,
    setMode: (mode) => {
      runtimeState.mode = mode;
    },
    isOnline: deps.isOnline,
    settings: runtimeState.settings,
    getControllers: () => runtimeState.controllers,
    isHuman,
    withPointerPlayer,
    showLobby: deps.returnToLobby,
    rematch: deps.rematch,
    maybeSendAimUpdate: deps.maybeSendAimUpdate ?? (() => {}),
    setDirectTouchActive: (active) => {
      runtimeState.directTouchActive = active;
    },
    isDirectTouchActive: () => runtimeState.directTouchActive,
    coords: coordsDeps,
    lobby: lobbyDeps,
    options: buildOptionsDeps(runtimeState, deps.options, deps.uiCtx),
    dialogAction: buildDialogActionHandler(
      runtimeState,
      deps.lifeLost,
      deps.upgradePick,
    ),
    lifeLost: buildLifeLostClickDeps(
      runtimeState,
      deps.pointerPlayer,
      deps.lifeLost,
    ),
    upgradePick: buildUpgradePickClickDeps(
      runtimeState,
      deps.pointerPlayer,
      deps.upgradePick,
    ),
    gameOver: buildGameOverDeps(runtimeState, deps.render, deps.gameOverClick),
    gameAction: gameActionDeps,
    quit: buildQuitDeps(runtimeState),
  };
}

function buildOptionsDeps(
  runtimeState: RuntimeState,
  options: InputSystemDeps["options"],
  uiCtx: UIContext,
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
    getCursor: () => runtimeState.optionsCursor,
    setCursor: (cursor: number) => {
      runtimeState.optionsCursor = cursor;
    },
    getCount: () => visibleOptions(uiCtx).length,
    getRealIdx: options.visibleToActualOptionIdx,
    confirmOption: () => {
      if (options.visibleToActualOptionIdx() === OPT_CONTROLS)
        options.showControls();
      else options.closeOptions();
    },
    getReturnMode: () => runtimeState.optionsReturnMode,
    setReturnMode: (mode: unknown) => {
      runtimeState.optionsReturnMode = mode as Mode | null;
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
): RegisterOnlineInputDeps["lifeLost"] {
  return {
    get: () => runtimeState.lifeLostDialog,
    click: (x: number, y: number) => {
      if (!runtimeState.lifeLostDialog) return;
      const hit = handleLifeLostDialogClick({
        state: runtimeState.state,
        lifeLostDialog: runtimeState.lifeLostDialog,
        screenX: x,
        screenY: y,
      });
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
): RegisterOnlineInputDeps["upgradePick"] {
  return {
    get: () => runtimeState.upgradePickDialog,
    click: (x: number, y: number) => {
      if (!runtimeState.upgradePickDialog) return;
      const hit = handleUpgradePickClick({
        W: GRID_COLS * TILE_SIZE,
        H: GRID_ROWS * TILE_SIZE,
        dialog: runtimeState.upgradePickDialog,
        screenX: x,
        screenY: y,
      });
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
    getPending: () => runtimeState.quitPending,
    setPending: (quitPending: boolean) => {
      runtimeState.quitPending = quitPending;
    },
    setTimer: (quitTimer: number) => {
      runtimeState.quitTimer = quitTimer;
    },
    setMessage: (quitMessage: string) => {
      runtimeState.quitMessage = quitMessage;
    },
  };
}

function buildCoordsDeps(camera: InputSystemDeps["camera"]) {
  return {
    pixelToTile: camera.pixelToTile,
    screenToWorld: camera.screenToWorld,
    onPinchStart: camera.onPinchStart,
    onPinchUpdate: camera.onPinchUpdate,
    onPinchEnd: camera.onPinchEnd,
  };
}

function buildLobbyDeps(
  runtimeState: RuntimeState,
  lobby: InputSystemDeps["lobby"],
) {
  return {
    isActive: () => runtimeState.lobby.active,
    keyJoin: (key: string) => lobby.lobbyKeyJoin(key),
    click: (x: number, y: number) => lobby.lobbyClick(x, y),
    cursorAt: (x: number, y: number) => lobby.cursorAt(x, y),
  };
}

function buildGameActionDeps(
  runtimeState: RuntimeState,
  selection: InputSystemDeps["selection"],
  isSelectionReady: () => boolean,
  placeCannon: PlaceCannonFn,
  placePiece: PlacePieceFn,
  sound: InputSystemDeps["sound"],
  fireAndSend: InputSystemDeps["fireAndSend"],
) {
  return {
    getSelectionStates: () => runtimeState.selectionStates,
    highlightTowerForPlayer: selection.highlight,
    confirmSelectionAndStartBuild: selection.confirmAndStartBuild,
    isSelectionReady,
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
    isSelectionReady,
  } = deps;
  const {
    tryPlacePieceAndSend: placePieceAction,
    tryPlaceCannonAndSend: placeCannonAction,
  } = inputDeps.gameAction;

  const overlayActionDeps = buildOverlayActionDeps(deps, inputDeps);

  touch.dpad = createDpad(
    {
      getState: () => safeState(runtimeState),
      getMode: () => runtimeState.mode,
      withPointerPlayer,
      onHapticTap: haptics.tap,
      isHost: deps.getIsHost,
      lobbyAction: () =>
        lobby.lobbyKeyJoin(runtimeState.settings.keyBindings[0]!.confirm),
      getLeftHanded: () => runtimeState.settings.leftHanded,
      clearDirectTouch: () => {
        runtimeState.directTouchActive = false;
      },
      gameAction: {
        getSelectionStates: () => runtimeState.selectionStates,
        highlightTowerForPlayer: selection.highlight,
        confirmSelectionAndStartBuild: selection.confirmAndStartBuild,
        isSelectionReady,
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
  const { runtimeState, uiCtx, options, render, rematch, returnToLobby } = deps;
  const pointerPlayer = deps.pointerPlayer;
  return {
    options: {
      isActive: () => runtimeState.mode === Mode.OPTIONS,
      moveCursor: (dir: -1 | 1) => {
        const count = visibleOptions(uiCtx).length;
        runtimeState.optionsCursor =
          (runtimeState.optionsCursor + dir + count) % count;
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
  const { runtimeState, gameContainer, returnToLobby } = deps;
  const zoomDeps = buildZoomDeps(deps);

  touch.quitButton = createQuitButton(
    {
      getQuitPending: () => runtimeState.quitPending,
      setQuitPending: (quitPending: boolean) => {
        runtimeState.quitPending = quitPending;
      },
      setQuitTimer: (quitTimer: number) => {
        runtimeState.quitTimer = quitTimer;
      },
      setQuitMessage: (msg: string) => {
        runtimeState.quitMessage = msg;
      },
      showLobby: returnToLobby,
      getControllers: () => runtimeState.controllers,
      isHuman,
    },
    gameContainer,
  );
  touch.quitButton.update(null); // initial state: hidden
  touch.homeZoomButton = createHomeZoomButton(zoomDeps, gameContainer);
  touch.enemyZoomButton = createEnemyZoomButton(zoomDeps, gameContainer);
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
      if (!runtimeState.state) return;
      const human = pointerPlayer();
      if (!human) return;
      const pid = runtimeState.state.playerZones.indexOf(zone);
      const tower =
        pid >= 0 ? runtimeState.state.players[pid]?.homeTower : null;
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
    touch.floatingActions = createFloatingActions(
      {
        getState: () => safeState(runtimeState),
        getMode: () => runtimeState.mode,
        withPointerPlayer,
        tryPlacePieceAndSend: placePieceAction,
        tryPlaceCannonAndSend: placeCannonAction,
        onPieceRotated: sound.pieceRotated,
        onHapticTap: haptics.tap,
        onDrag: (clientX, clientY) => {
          const state = runtimeState.state;
          if (!state) return;
          const { x, y } = renderer.clientToSurface(clientX, clientY);
          dispatchPointerMove(x, y, state, inputDeps);
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
