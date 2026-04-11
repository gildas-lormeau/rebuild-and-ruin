import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { zoneTowerCenterPx } from "../shared/core/spatial.ts";
import {
  type BattleViewState,
  type BuildViewState,
  type CannonViewState,
  type HapticsSystem,
  type InputReceiver,
  isHuman,
  type PlayerController,
  type SoundSystem,
} from "../shared/core/system-interfaces.ts";
import { IS_TOUCH_DEVICE } from "../shared/platform/platform.ts";
import { Action } from "../shared/ui/input-action.ts";
import {
  FOCUS_MENU,
  FOCUS_REMATCH,
  type GameOverFocus,
  type ResolvedChoice,
} from "../shared/ui/interaction-types.ts";
import type {
  LoupeHandle,
  RendererInterface,
} from "../shared/ui/overlay-types.ts";
import { OPT_CONTROLS } from "../shared/ui/settings-defs.ts";
import type {
  CreateDpadFn,
  CreateEnemyZoomButtonFn,
  CreateFloatingActionsFn,
  CreateHomeZoomButtonFn,
  CreateQuitButtonFn,
  DispatchPointerMoveFn,
  FloatingActionsHandle,
  RegisterKeyboardHandlersFn,
  RegisterMouseHandlersFn,
  RegisterOnlineInputDeps,
  RegisterTouchHandlersFn,
} from "../shared/ui/ui-contracts.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import { type RuntimeState, safeState, setMode } from "./runtime-state.ts";
import type { CameraSystem, NetworkApi } from "./runtime-types.ts";

type DpadHandle = ReturnType<CreateDpadFn>;

type ZoomButtonHandle = ReturnType<CreateHomeZoomButtonFn>;

type QuitButtonHandle = ReturnType<CreateQuitButtonFn>;

interface InputSystemDeps {
  readonly touchHandles: TouchHandles;
  readonly runtimeState: RuntimeState;
  readonly renderer: RendererInterface;
  readonly gameContainer: HTMLElement;
  /** DOM event source for keyboard listeners — forwarded to the keyboard handler
   *  module so nothing below the runtime layer touches `document` directly. */
  readonly keyboardEventSource: Pick<
    Document,
    "addEventListener" | "removeEventListener"
  >;

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

  /** Whether this runtime instance was constructed in online mode.
   *  Stable for the lifetime of the runtime — set at composition time. */
  readonly isOnline: boolean;
  /** Network seam — the input system reads `amHost` from here, the
   *  same NetworkApi the rest of the runtime uses. No duplication. */
  readonly network: Pick<NetworkApi, "amHost">;

  // Action surface (online action wrappers + local fallbacks).
  // NOT NetworkApi — see RuntimeInputAdapters in assembly.ts for why
  // this is named `actions` rather than `network`.
  readonly actions: {
    readonly maybeSendAimUpdate?: (x: number, y: number) => void;
    readonly tryPlaceCannonAndSend?: (
      ctrl: PlayerController & InputReceiver,
      gameState: CannonViewState,
      max: number,
    ) => boolean;
    readonly tryPlacePieceAndSend: (
      ctrl: PlayerController & InputReceiver,
      gameState: BuildViewState,
    ) => boolean;
    readonly fireAndSend: (
      ctrl: PlayerController,
      gameState: BattleViewState,
    ) => void;
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

  /** The element for floating action buttons (pre-existing in the HTML). */
  readonly floatingActionsEl: HTMLElement | null;
  /** Mark the game container for touch panel CSS layout. */
  readonly markTouchPanels: () => void;

  // Lifecycle / navigation callbacks
  readonly lifecycle: {
    readonly render: () => void;
    readonly rematch: () => void | Promise<void>;
    readonly returnToLobby: () => void;
    readonly gameOverClick: (canvasX: number, canvasY: number) => void;
  };

  // Sibling callbacks
  readonly pointerPlayer: () => (PlayerController & InputReceiver) | null;
  /** Run `action` with the pointer (local human) controller. Returns `true`
   *  if it actually ran, `false` when there is no human to receive the input. */
  readonly withPointerPlayer: (
    action: (human: PlayerController & InputReceiver) => void,
  ) => boolean;
}

type PlacePieceFn = (
  ctrl: PlayerController & InputReceiver,
  gameState: BuildViewState,
) => boolean;

type PlaceCannonFn = (
  ctrl: PlayerController & InputReceiver,
  gameState: CannonViewState,
  max: number,
) => boolean;

export interface TouchHandles {
  readonly dpad: DpadHandle | null;
  readonly floatingActions: FloatingActionsHandle | null;
  readonly homeZoomButton: ZoomButtonHandle | null;
  readonly enemyZoomButton: ZoomButtonHandle | null;
  readonly quitButton: QuitButtonHandle | null;
  readonly loupeHandle: LoupeHandle | null;
}

/** Mutable during initial wiring inside createInputSystem; frozen afterward. */
type MutableTouchHandles = {
  -readonly [K in keyof TouchHandles]: TouchHandles[K];
};

interface InputSystem {
  resetForLobby(runtimeState: RuntimeState): void;
}

export function createInputSystem(deps: InputSystemDeps): InputSystem {
  const touch = deps.touchHandles as MutableTouchHandles;
  const runtimeState = deps.runtimeState;
  const { camera, sound, lobby, selection } = deps;

  // ── Placement handlers (raw — sound feedback via dispatch callbacks) ──
  const placeCannon =
    deps.actions.tryPlaceCannonAndSend ??
    ((
      ctrl: PlayerController & InputReceiver,
      gameState: CannonViewState,
      max: number,
    ) => ctrl.tryPlaceCannon(gameState, max));
  const placePieceRaw = deps.actions.tryPlacePieceAndSend;

  const coordsDeps: RegisterOnlineInputDeps["coords"] = {
    pixelToTile: camera.pixelToTile,
    screenToWorld: camera.screenToWorld,
    onPinchStart: camera.onPinchStart,
    onPinchUpdate: camera.onPinchUpdate,
    onPinchEnd: camera.onPinchEnd,
  };
  const lobbyDeps: RegisterOnlineInputDeps["lobby"] = {
    isActive: () => runtimeState.lobby.active,
    keyJoin: lobby.lobbyKeyJoin,
    click: lobby.lobbyClick,
    cursorAt: lobby.cursorAt,
  };
  const gameActionDeps = buildGameActionDeps(
    runtimeState,
    selection,
    placeCannon,
    placePieceRaw,
    sound,
    deps.actions.fireAndSend,
  );

  // ── Combined input deps: assembles all subsystem deps ──
  const inputDeps = buildInputDeps(deps, coordsDeps, lobbyDeps, gameActionDeps);

  deps.inputHandlers.registerMouse(inputDeps);
  deps.inputHandlers.registerKeyboard(inputDeps);
  deps.inputHandlers.registerTouch(inputDeps);

  // Touch controls: wire static DOM elements from index.html
  if (IS_TOUCH_DEVICE) {
    setupTouchControls(inputDeps, touch, deps);
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

  return { resetForLobby };
}

function setupTouchControls(
  inputDeps: RegisterOnlineInputDeps,
  touch: MutableTouchHandles,
  deps: InputSystemDeps,
): void {
  const { gameContainer, renderer, camera } = deps;

  deps.markTouchPanels();

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
  const { runtimeState, renderer, withPointerPlayer, keyboardEventSource } =
    deps;
  return {
    renderer,
    keyboardEventSource,
    getState: () => safeState(runtimeState),
    getMode: () => runtimeState.mode,
    setMode: (mode) => {
      setMode(runtimeState, mode);
    },
    isOnline: deps.isOnline,
    settings: runtimeState.settings,
    getControllers: () => runtimeState.controllers,
    isHuman,
    withPointerPlayer,
    showLobby: deps.lifecycle.returnToLobby,
    rematch: deps.lifecycle.rematch,
    maybeSendAimUpdate: deps.actions.maybeSendAimUpdate ?? (() => {}),
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
    confirmOption: () => confirmCurrentOption(options),
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
    if (runtimeState.mode === Mode.LIFE_LOST && runtimeState.dialogs.lifeLost) {
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
      runtimeState.dialogs.upgradePick
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
    get: () => runtimeState.dialogs.lifeLost,
    click: guardedDialogClick(pointerPlayer, hitTest, (hit) =>
      lifeLost.applyChoice(hit.playerId, hit.choice),
    ),
  };
}

function buildUpgradePickClickDeps(
  runtimeState: RuntimeState,
  pointerPlayer: InputSystemDeps["pointerPlayer"],
  upgradePick: InputSystemDeps["upgradePick"],
  hitTest: InputSystemDeps["hitTests"]["upgradePickClick"],
): RegisterOnlineInputDeps["upgradePick"] {
  return {
    get: () => runtimeState.dialogs.upgradePick,
    click: guardedDialogClick(pointerPlayer, hitTest, (hit) =>
      upgradePick.pickDirect(hit.playerId, hit.cardIdx),
    ),
  };
}

function guardedDialogClick<TH extends { playerId: ValidPlayerSlot }>(
  pointerPlayer: InputSystemDeps["pointerPlayer"],
  hitTest: (x: number, y: number) => TH | null,
  onHit: (hit: TH) => void,
): (x: number, y: number) => void {
  return (x, y) => {
    const hit = hitTest(x, y);
    if (!hit) return;
    const active = pointerPlayer();
    if (active && hit.playerId !== active.playerId) return;
    onHit(hit);
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
  fireAndSend: InputSystemDeps["actions"]["fireAndSend"],
) {
  return {
    getSelectionStates: () => runtimeState.selection.states,
    highlightTowerForPlayer: selection.highlight,
    confirmSelectionAndStartBuild: selection.confirmAndStartBuild,
    isSelectionReady: selection.isReady,
    tryPlaceCannonAndSend: placeCannon,
    tryPlacePieceAndSend: placePiece,
    onPieceRotated: sound.pieceRotated,
    onPiecePlaced: sound.piecePlaced,
    onPieceFailed: sound.pieceFailed,
    onCannonPlaced: sound.cannonPlaced,
    fireAndSend,
  };
}

function setupDpadAndActions(
  inputDeps: RegisterOnlineInputDeps,
  touch: MutableTouchHandles,
  deps: InputSystemDeps,
): void {
  const { runtimeState, gameContainer, haptics, lobby, withPointerPlayer } =
    deps;

  const overlayActionDeps = buildOverlayActionDeps(deps, inputDeps);

  touch.dpad = deps.touchFactories.createDpad(
    {
      getState: () => safeState(runtimeState),
      getMode: () => runtimeState.mode,
      withPointerPlayer,
      onHapticTap: haptics.tap,
      isHost: deps.network.amHost,
      lobbyAction: () =>
        lobby.lobbyKeyJoin(runtimeState.settings.keyBindings[0]!.confirm),
      getLeftHanded: () => runtimeState.settings.leftHanded,
      clearDirectTouch: () => {
        runtimeState.inputTracking.directTouchActive = false;
      },
      gameAction: inputDeps.gameAction,
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
      confirm: () => confirmCurrentOption(options),
    },
    dialogAction: (action: Action) => {
      const active = pointerPlayer();
      if (!active) return false;
      return inputDeps.dialogAction(active.playerId, action);
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
      confirm: async () => {
        if (!runtimeState.frame.gameOver) return;
        if (runtimeState.frame.gameOver.focused === FOCUS_REMATCH)
          await rematch();
        else returnToLobby();
      },
    },
  };
}

/** Confirm the currently focused option (open controls or close options). */
function confirmCurrentOption(options: InputSystemDeps["options"]): void {
  if (options.visibleToActualOptionIdx() === OPT_CONTROLS)
    options.showControls();
  else options.closeOptions();
}

function setupZoomButtons(
  touch: MutableTouchHandles,
  deps: InputSystemDeps,
): void {
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
      const px = zoneTowerCenterPx(state.playerZones, state.players, zone);
      if (!px) return;
      const human = pointerPlayer();
      if (human) human.setCrosshair(px.x, px.y);
    },
  };
}

function setupFloatingActions(
  inputDeps: RegisterOnlineInputDeps,
  touch: MutableTouchHandles,
  deps: InputSystemDeps,
): void {
  const { runtimeState, renderer, sound, haptics, withPointerPlayer } = deps;
  const {
    tryPlacePieceAndSend: placePieceAction,
    tryPlaceCannonAndSend: placeCannonAction,
  } = inputDeps.gameAction;

  const floatingEl = deps.floatingActionsEl;
  if (floatingEl) {
    touch.floatingActions = deps.touchFactories.createFloatingActions(
      {
        getState: () => safeState(runtimeState),
        getMode: () => runtimeState.mode,
        withPointerPlayer,
        tryPlacePieceAndSend: placePieceAction,
        tryPlaceCannonAndSend: placeCannonAction,
        onPieceRotated: sound.pieceRotated,
        onPiecePlaced: sound.piecePlaced,
        onPieceFailed: sound.pieceFailed,
        onCannonPlaced: sound.cannonPlaced,
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
