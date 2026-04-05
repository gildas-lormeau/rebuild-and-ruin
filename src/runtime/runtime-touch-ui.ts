/**
 * Touch UI update logic — loupe, d-pad, zoom/quit buttons, floating actions.
 *
 * Extracted from runtime.ts render() to keep it high-level.
 */

import { isPlacementPhase, Mode, Phase } from "../shared/game-phase.ts";
import { TILE_SIZE } from "../shared/grid.ts";
import type { LoupeHandle } from "../shared/overlay-types.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import type {
  InputReceiver,
  PlayerController,
} from "../shared/system-interfaces.ts";

type TouchBtnRule = boolean | "interactive";

interface TouchButtonState {
  dpad: TouchBtnRule;
  confirm: TouchBtnRule;
  rotate: TouchBtnRule;
  placementValidity: TouchBtnRule;
  zoom: TouchBtnRule;
  quit: boolean;
}

export interface Dpad {
  update(phase: Phase | null, disableRotate?: boolean): void;
  setConfirmValid(valid: boolean): void;
}

export interface FloatingActions {
  update(
    visible: boolean,
    x: number,
    y: number,
    nearTop: boolean,
    leftHanded: boolean,
  ): void;
  setConfirmValid(valid: boolean): void;
}

export interface ZoomButton {
  update(active: boolean): void;
}

export interface QuitButton {
  update(phase: Phase | null): void;
}

interface TouchControlsDeps {
  mode: Mode;
  state: { phase: Phase };
  phantoms: {
    piecePhantoms?: { playerId: ValidPlayerSlot; valid: boolean }[];
    cannonPhantoms?: { playerId: ValidPlayerSlot; valid: boolean }[];
  };
  directTouchActive: boolean;
  clearDirectTouch: () => void;
  leftHanded: boolean;
  pointerPlayer: () => (PlayerController & InputReceiver) | null;
  dpad: Dpad | null;
  floatingActions: FloatingActions | null;
  homeZoomButton: ZoomButton | null;
  enemyZoomButton: ZoomButton | null;
  quitButton: QuitButton | null;
  loupeHandle: LoupeHandle | null;
  worldToScreen: (wx: number, wy: number) => { sx: number; sy: number };
  screenToContainerCSS: (sx: number, sy: number) => { x: number; y: number };
  containerHeight: number;
}

const NEAR_TOP_THRESHOLD = 0.15;
const INTERACTIVE = "interactive";
const TOUCH_BUTTON_STATES: Record<Mode, TouchButtonState> = {
  [Mode.LOBBY]: {
    dpad: false,
    confirm: true,
    rotate: false,
    placementValidity: false,
    zoom: false,
    quit: false,
  },
  [Mode.OPTIONS]: {
    dpad: true,
    confirm: true,
    rotate: true,
    placementValidity: false,
    zoom: false,
    quit: false,
  },
  [Mode.CONTROLS]: {
    dpad: false,
    confirm: false,
    rotate: false,
    placementValidity: false,
    zoom: false,
    quit: false,
  },
  [Mode.SELECTION]: {
    dpad: INTERACTIVE,
    confirm: INTERACTIVE,
    rotate: false,
    placementValidity: false,
    zoom: INTERACTIVE,
    quit: true,
  },
  [Mode.BANNER]: {
    dpad: false,
    confirm: false,
    rotate: false,
    placementValidity: false,
    zoom: INTERACTIVE,
    quit: true,
  },
  [Mode.BALLOON_ANIM]: {
    dpad: false,
    confirm: false,
    rotate: false,
    placementValidity: false,
    zoom: INTERACTIVE,
    quit: true,
  },
  [Mode.CASTLE_BUILD]: {
    dpad: false,
    confirm: false,
    rotate: false,
    placementValidity: false,
    zoom: INTERACTIVE,
    quit: true,
  },
  [Mode.LIFE_LOST]: {
    dpad: INTERACTIVE,
    confirm: INTERACTIVE,
    rotate: false,
    placementValidity: false,
    zoom: INTERACTIVE,
    quit: true,
  },
  [Mode.UPGRADE_PICK]: {
    dpad: INTERACTIVE,
    confirm: INTERACTIVE,
    rotate: false,
    placementValidity: false,
    zoom: false,
    quit: true,
  },
  [Mode.GAME]: {
    dpad: INTERACTIVE,
    confirm: INTERACTIVE,
    rotate: INTERACTIVE,
    placementValidity: INTERACTIVE,
    zoom: INTERACTIVE,
    quit: true,
  },
  [Mode.STOPPED]: {
    dpad: INTERACTIVE,
    confirm: INTERACTIVE,
    rotate: false,
    placementValidity: false,
    zoom: false,
    quit: false,
  },
};

/** Update all touch UI controls after rendering a frame. */
export function updateTouchControls(deps: TouchControlsDeps): void {
  updateLoupe(deps);
  updateButtons(deps);
  updateFloatingActions(deps);
}

function updateLoupe(deps: TouchControlsDeps): void {
  if (!deps.loupeHandle) return;
  const phase = deps.state.phase;
  const loupeVisible =
    deps.mode === Mode.GAME &&
    (isPlacementPhase(phase) || phase === Phase.BATTLE);
  const human = deps.pointerPlayer();
  let wx = 0;
  let wy = 0;
  if (human && phase === Phase.BATTLE) {
    const ch = human.getCrosshair();
    wx = ch.x;
    wy = ch.y;
  } else if (human) {
    const cursor =
      phase === Phase.WALL_BUILD ? human.buildCursor : human.cannonCursor;
    const piece = phase === Phase.WALL_BUILD ? human.getCurrentPiece() : null;
    const pivotR = piece ? piece.pivot[0] : 0;
    const pivotC = piece ? piece.pivot[1] : 0;
    wx = (cursor.col + pivotC + 0.5) * TILE_SIZE;
    wy = (cursor.row + pivotR + 0.5) * TILE_SIZE;
  }
  deps.loupeHandle.update(loupeVisible && human !== null, wx, wy);
}

function updateButtons(deps: TouchControlsDeps): void {
  const hasPointerPlayer = deps.pointerPlayer() !== null;
  const bs = TOUCH_BUTTON_STATES[deps.mode];
  const on = (rule: TouchBtnRule) =>
    rule === true || (rule === INTERACTIVE && hasPointerPlayer);

  // D-pad, rotate, confirm — pass current phase to dpad so it can decide
  // which buttons to show (e.g. rotate is hidden during selection).
  deps.dpad?.update(on(bs.dpad) ? deps.state.phase : null, !on(bs.rotate));
  if (deps.dpad) {
    if (!on(bs.confirm)) {
      deps.dpad.setConfirmValid(false);
    } else if (
      deps.state &&
      isPlacementPhase(deps.state.phase) &&
      on(bs.placementValidity)
    ) {
      deps.dpad.setConfirmValid(
        pointerPhantomValid(
          deps.state.phase,
          deps.pointerPlayer(),
          deps.phantoms,
        ) ?? true,
      );
    } else {
      deps.dpad.setConfirmValid(true);
    }
  }

  // Zoom, quit
  deps.homeZoomButton?.update(on(bs.zoom));
  deps.enemyZoomButton?.update(on(bs.zoom));
  deps.quitButton?.update(bs.quit ? deps.state.phase : null);
}

function updateFloatingActions(deps: TouchControlsDeps): void {
  if (!deps.floatingActions) return;
  const phase = deps.state.phase;
  const human = deps.pointerPlayer();
  const phantomValid = pointerPhantomValid(phase, human, deps.phantoms);
  // Reset direct-touch flag when leaving placement phases so it doesn't
  // carry over into the next placement phase.
  if (!isPlacementPhase(phase) && deps.directTouchActive) {
    deps.clearDirectTouch();
  }
  const visible =
    deps.directTouchActive &&
    human !== null &&
    deps.mode === Mode.GAME &&
    isPlacementPhase(phase) &&
    phantomValid !== undefined;
  if (!visible) {
    deps.floatingActions.update(false, 0, 0, false, false);
    return;
  }

  // Phantom center in world-pixel (tile-pixel) coordinates
  let wx: number;
  let wy: number;
  if (phase === Phase.WALL_BUILD) {
    const cursor = human.buildCursor;
    const piece = human.getCurrentPiece();
    const pc = piece ? piece.pivot[1] : 0;
    wx = (cursor.col + pc + 0.5) * TILE_SIZE;
    wy = cursor.row * TILE_SIZE;
  } else {
    const cursor = human.cannonCursor;
    wx = (cursor.col + 1) * TILE_SIZE;
    wy = cursor.row * TILE_SIZE;
  }

  // World-pixel → screen-pixel (camera), then → CSS relative to container
  const { sx, sy } = deps.worldToScreen(wx, wy);
  const { x: cssX, y: cssY } = deps.screenToContainerCSS(sx, sy);
  const nearTop = cssY < deps.containerHeight * NEAR_TOP_THRESHOLD;
  deps.floatingActions.update(true, cssX, cssY, nearTop, deps.leftHanded);
  deps.floatingActions.setConfirmValid(phantomValid ?? false);
}

/** @returns true if phantom valid, false if invalid, undefined if no phantom for this phase. */
function pointerPhantomValid(
  phase: Phase | undefined,
  human: PlayerController | null,
  phantoms: {
    piecePhantoms?: { playerId: ValidPlayerSlot; valid: boolean }[];
    cannonPhantoms?: { playerId: ValidPlayerSlot; valid: boolean }[];
  },
): boolean | undefined {
  if (!human) return undefined;
  if (phase === Phase.WALL_BUILD) {
    return phantoms.piecePhantoms?.find(
      (phantom) => phantom.playerId === human.playerId,
    )?.valid;
  }
  return phantoms.cannonPhantoms?.find(
    (phantom) => phantom.playerId === human.playerId,
  )?.valid;
}
