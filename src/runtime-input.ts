/**
 * Input registration sub-system — wires keyboard, mouse, touch, and
 * d-pad handlers.  Extracted from runtime.ts to keep it a pure
 * composition root.
 *
 * Follows the factory-with-deps pattern used by runtime-camera.ts,
 * runtime-selection.ts, etc.
 */

import type {
  InputReceiver,
  PlayerController,
} from "./controller-interfaces.ts";
import { isHuman } from "./controller-interfaces.ts";
import { type UIContext, visibleOptions } from "./game-ui-screens.ts";
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
} from "./input-touch-ui.ts";
import { IS_TOUCH_DEVICE } from "./platform.ts";
import type { RendererInterface } from "./render-types.ts";
import { type RuntimeState, safeState } from "./runtime-state.ts";
import type { CameraSystem } from "./runtime-types.ts";
import type { SoundSystem } from "./sound-system.ts";
import { towerCenterPx } from "./spatial.ts";
import {
  FOCUS_MENU,
  FOCUS_REMATCH,
  type GameState,
  Mode,
  type ResolvedChoice,
} from "./types.ts";

type DpadHandle = ReturnType<typeof createDpad>;

type FloatingActionsHandle = ReturnType<typeof createFloatingActions>;

type ZoomButtonHandle = ReturnType<typeof createHomeZoomButton>;

type QuitButtonHandle = ReturnType<typeof createQuitButton>;

type LoupeHandle = ReturnType<NonNullable<RendererInterface["createLoupe"]>>;

interface TouchHandles {
  dpad: DpadHandle | null;
  floatingActions: FloatingActionsHandle | null;
  homeZoomButton: ZoomButtonHandle | null;
  enemyZoomButton: ZoomButtonHandle | null;
  quitButton: QuitButtonHandle | null;
  loupeHandle: LoupeHandle | null;
}

interface InputSystemDeps {
  readonly rs: RuntimeState;
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
  };
  readonly options: {
    showOptions: () => void;
    closeOptions: () => void;
    showControls: () => void;
    closeControls: () => void;
    changeOption: (dir: number) => void;
    realOptionIdx: () => number;
    togglePause: () => boolean;
  };
  readonly lifeLost: {
    click: (canvasX: number, canvasY: number) => void;
    sendLifeLostChoice: (choice: ResolvedChoice, playerId: number) => void;
    toggleFocus: (playerId: number) => void;
    confirmChoice: (playerId: number) => void;
  };
  readonly selection: {
    highlight: (idx: number, zone: number, pid: number) => void;
    confirm: (pid: number, isReselect?: boolean) => boolean;
  };
  readonly camera: Pick<
    CameraSystem,
    | "pixelToTile"
    | "screenToWorld"
    | "onPinchStart"
    | "onPinchUpdate"
    | "onPinchEnd"
    | "myPlayerId"
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
  readonly firstHuman: () => (PlayerController & InputReceiver) | null;
  readonly withFirstHuman: (
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
  const {
    rs,
    renderer,
    gameContainer,
    uiCtx,
    camera,
    sound,
    haptics,
    lobby,
    options,
    lifeLost,
    selection,
    firstHuman,
    withFirstHuman,
    isSelectionReady,
    render,
    rematch,
    returnToLobby,
    gameOverClick,
  } = deps;

  const touch: TouchHandles = {
    dpad: null,
    floatingActions: null,
    homeZoomButton: null,
    enemyZoomButton: null,
    quitButton: null,
    loupeHandle: null,
  };

  function register(): void {
    const placeCannon = wrapCannonPlace(
      deps.tryPlaceCannonAndSend ??
        ((ctrl, gs, max) => ctrl.tryPlaceCannon(gs, max)),
      sound,
    );
    const placePieceWrapped = wrapPiecePlace(
      deps.tryPlacePieceAndSend ?? ((ctrl, gs) => ctrl.tryPlacePiece(gs)),
      sound,
    );
    const inputDeps: RegisterOnlineInputDeps = {
      renderer,
      getState: () => safeState(rs),
      getMode: () => rs.mode,
      setMode: (m) => {
        rs.mode = m as Mode;
      },
      modeValues: {
        LOBBY: Mode.LOBBY,
        OPTIONS: Mode.OPTIONS,
        CONTROLS: Mode.CONTROLS,
        SELECTION: Mode.SELECTION,
        BANNER: Mode.BANNER,
        BALLOON_ANIM: Mode.BALLOON_ANIM,
        CASTLE_BUILD: Mode.CASTLE_BUILD,
        LIFE_LOST: Mode.LIFE_LOST,
        GAME: Mode.GAME,
        STOPPED: Mode.STOPPED,
      },
      isOnline: deps.isOnline,
      settings: rs.settings,
      getControllers: () => rs.controllers,
      isHuman,
      withFirstHuman,
      showLobby: returnToLobby,
      rematch,
      maybeSendAimUpdate: deps.maybeSendAimUpdate ?? (() => {}),
      setDirectTouchActive: (v) => {
        rs.directTouchActive = v;
      },
      isDirectTouchActive: () => rs.directTouchActive,
      coords: {
        pixelToTile: camera.pixelToTile,
        screenToWorld: camera.screenToWorld,
        onPinchStart: camera.onPinchStart,
        onPinchUpdate: camera.onPinchUpdate,
        onPinchEnd: camera.onPinchEnd,
      },
      lobby: {
        isActive: () => rs.lobby.active,
        keyJoin: (key: string) => lobby.lobbyKeyJoin(key),
        click: (x: number, y: number) => lobby.lobbyClick(x, y),
      },
      options: {
        show: options.showOptions,
        close: options.closeOptions,
        showControls: options.showControls,
        closeControls: options.closeControls,
        getCursor: () => rs.optionsCursor,
        setCursor: (c) => {
          rs.optionsCursor = c;
        },
        getCount: () => visibleOptions(uiCtx).length,
        getRealIdx: options.realOptionIdx,
        getReturnMode: () => rs.optionsReturnMode,
        setReturnMode: (m) => {
          rs.optionsReturnMode = m as Mode | null;
        },
        changeValue: options.changeOption,
        togglePause: options.togglePause,
        getControlsState: () => rs.controlsState,
      },
      lifeLost: {
        get: () => rs.lifeLostDialog,
        click: lifeLost.click,
        sendChoice: lifeLost.sendLifeLostChoice,
      },
      gameOver: {
        getFocused: () => rs.frame.gameOver?.focused ?? FOCUS_REMATCH,
        setFocused: (f) => {
          if (rs.frame.gameOver) {
            rs.frame.gameOver.focused = f;
            render();
          }
        },
        click: gameOverClick,
      },
      gameAction: {
        getSelectionStates: () => rs.selectionStates,
        highlightTowerForPlayer: selection.highlight,
        confirmSelectionForPlayer: selection.confirm,
        isSelectionReady,
        tryPlaceCannonAndSend: placeCannon,
        tryPlacePieceAndSend: placePieceWrapped,
        onPieceRotated: sound.pieceRotated,
        fireAndSend:
          deps.fireAndSend ?? ((ctrl, gameState) => ctrl.fire(gameState)),
      },
      quit: {
        getPending: () => rs.quitPending,
        setPending: (v) => {
          rs.quitPending = v;
        },
        setTimer: (s) => {
          rs.quitTimer = s;
        },
        setMessage: (msg) => {
          rs.quitMessage = msg;
        },
      },
    };
    registerMouseHandlers(inputDeps);
    registerKeyboardHandlers(inputDeps);
    registerTouchHandlers({
      ...inputDeps,
      lobby: { ...inputDeps.lobby, keyJoin: undefined },
    });

    // Touch controls: wire static DOM elements from index.html
    if (IS_TOUCH_DEVICE) {
      gameContainer.classList.add("has-touch-panels");
      const {
        tryPlacePieceAndSend: placePieceAction,
        tryPlaceCannonAndSend: placeCannonAction,
      } = inputDeps.gameAction;
      const overlayActionDeps = {
        options: {
          isActive: () => rs.mode === Mode.OPTIONS,
          navigate: (dir: -1 | 1) => {
            const count = visibleOptions(uiCtx).length;
            rs.optionsCursor = (rs.optionsCursor + dir + count) % count;
          },
          changeValue: (dir: -1 | 1) => options.changeOption(dir),
          confirm: () => {
            if (options.realOptionIdx() === 5) options.showControls();
            else options.closeOptions();
          },
        },
        lifeLost: {
          isActive: () =>
            rs.mode === Mode.LIFE_LOST && rs.lifeLostDialog !== null,
          toggleFocus: () => {
            const human = firstHuman();
            if (human) lifeLost.toggleFocus(human.playerId);
          },
          confirm: () => {
            const human = firstHuman();
            if (human) lifeLost.confirmChoice(human.playerId);
          },
        },
        gameOver: {
          isActive: () =>
            rs.mode === Mode.STOPPED && rs.frame.gameOver !== undefined,
          toggleFocus: () => {
            if (!rs.frame.gameOver) return;
            rs.frame.gameOver.focused =
              rs.frame.gameOver.focused === FOCUS_REMATCH
                ? FOCUS_MENU
                : FOCUS_REMATCH;
            render();
          },
          confirm: () => {
            if (!rs.frame.gameOver) return;
            if (rs.frame.gameOver.focused === FOCUS_REMATCH) rematch();
            else returnToLobby();
          },
        },
      };
      touch.dpad = createDpad(
        {
          getState: () => safeState(rs),
          getMode: () => rs.mode,
          modeValues: {
            GAME: Mode.GAME,
            SELECTION: Mode.SELECTION,
            LOBBY: Mode.LOBBY,
          },
          withFirstHuman,
          onHapticTap: haptics.tap,
          isHost: deps.getIsHost,
          lobbyAction: () =>
            lobby.lobbyKeyJoin(rs.settings.keyBindings[0]!.confirm),
          getLeftHanded: () => rs.settings.leftHanded,
          clearDirectTouch: () => {
            rs.directTouchActive = false;
          },
          gameAction: {
            getSelectionStates: () => rs.selectionStates,
            highlightTowerForPlayer: selection.highlight,
            confirmSelectionForPlayer: selection.confirm,
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
      const zoomDeps = {
        getState: () => safeState(rs),
        getCameraZone: camera.getCameraZone,
        setCameraZone: camera.setCameraZone,
        myPlayerId: camera.myPlayerId,
        getEnemyZones: camera.getEnemyZones,
        aimAtZone: (zone: number) => {
          if (!rs.state) return;
          const human = firstHuman();
          if (!human) return;
          const pid = rs.state.playerZones.indexOf(zone);
          const tower = pid >= 0 ? rs.state.players[pid]?.homeTower : null;
          if (!tower) return;
          const px = towerCenterPx(tower);
          human.setCrosshair(px.x, px.y);
        },
      };
      touch.loupeHandle = renderer.createLoupe?.(gameContainer) ?? null;
      touch.quitButton = createQuitButton(
        {
          getQuitPending: () => rs.quitPending,
          setQuitPending: (v: boolean) => {
            rs.quitPending = v;
          },
          setQuitTimer: (v: number) => {
            rs.quitTimer = v;
          },
          setQuitMessage: (msg: string) => {
            rs.quitMessage = msg;
          },
          showLobby: returnToLobby,
          getControllers: () => rs.controllers,
          isHuman,
        },
        gameContainer,
      );
      touch.quitButton.update(null); // initial state: hidden
      touch.homeZoomButton = createHomeZoomButton(zoomDeps, gameContainer);
      touch.enemyZoomButton = createEnemyZoomButton(zoomDeps, gameContainer);
      touch.homeZoomButton.update(false); // initial state: disabled
      touch.enemyZoomButton.update(false);
      camera.enableMobileZoom();

      // Floating contextual buttons for direct-touch placement
      const floatingEl =
        gameContainer.querySelector<HTMLElement>("#floating-actions");
      if (floatingEl) {
        touch.floatingActions = createFloatingActions(
          {
            getState: () => safeState(rs),
            withFirstHuman,
            tryPlacePieceAndSend: placePieceAction,
            tryPlaceCannonAndSend: placeCannonAction,
            onPieceRotated: sound.pieceRotated,
            onHapticTap: haptics.tap,
            onDrag: (clientX, clientY) => {
              const state = rs.state;
              if (!state) return;
              const { x, y } = renderer.clientToSurface(clientX, clientY);
              dispatchPointerMove(x, y, state, inputDeps);
            },
          },
          floatingEl,
        );
      }
    }
  }

  return { register, touch };
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
