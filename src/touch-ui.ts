/**
 * Touch UI — wires event handlers to the static touch controls in index.html.
 *
 * Layout is handled entirely by CSS (landscape panels / portrait bars).
 * This module only queries existing DOM elements and attaches behavior.
 *
 * Left panel : loupe + d-pad
 * Right panel: quit + zoom + rotate + confirm
 */

import { hapticTap } from "./haptics.ts";
import { dispatchPlacement, isGameInteractionMode } from "./input-dispatch.ts";
import { ACTION_CONFIRM, PLAYER_COLORS } from "./player-config.ts";
import type { InputReceiver, PlayerController } from "./player-controller.ts";
import { rgb, TOUCH_ZOOM_ENEMY_BG, TOUCH_ZOOM_HOME_BG, ZOOM_BUTTON_ALPHA } from "./render-theme.ts";
import type { SelectionState } from "./selection.ts";
import { findNearestTower } from "./spatial.ts";
import type { GameState } from "./types.ts";
import { Action, isSelectionPhase, Phase } from "./types.ts";

interface DpadDeps {
  getState: () => GameState | undefined;
  getMode: () => number;
  modeValues: { GAME: number; SELECTION: number };
  withFirstHuman: (action: (human: PlayerController & InputReceiver) => void) => void;
  tryPlacePieceAndSend: (human: PlayerController & InputReceiver, state: GameState) => void;
  tryPlaceCannonAndSend: (human: PlayerController & InputReceiver, state: GameState, max: number) => void;
  fireAndSend: (human: PlayerController & InputReceiver, state: GameState) => void;
  getSelectionStates: () => Map<number, SelectionState>;
  highlightTowerForPlayer: (idx: number, zone: number, pid: number) => void;
  confirmSelectionForPlayer: (pid: number, isReselect: boolean) => boolean;
  isHost: () => boolean;
  /** Join P1 in lobby (or skip if already joined). */
  lobbyAction: () => void;
  getLeftHanded: () => boolean;
  /** Clear the direct-touch-active flag (hides floating buttons). */
  clearDirectTouch?: () => void;
  /** True after the "Select your home castle" announcement has finished. */
  isSelectionReady?: () => boolean;
  /** Options screen navigation (optional — only wired on touch). */
  options?: {
    isActive: () => boolean;
    navigate: (dir: -1 | 1) => void;
    changeValue: (dir: -1 | 1) => void;
    confirm: () => void;
  };
}

interface QuitButtonDeps {
  getQuitPending: () => boolean;
  setQuitPending: (v: boolean) => void;
  setQuitTimer: (v: number) => void;
  setQuitMessage: (msg: string) => void;
  showLobby: () => void;
  getControllers: () => PlayerController[];
  isHuman: (ctrl: PlayerController) => boolean;
}

interface ZoomButtonDeps {
  getState: () => GameState | undefined;
  getCameraZone: () => number | null;
  setCameraZone: (zone: number | null) => void;
  myPlayerId: () => number;
  getEnemyZones: () => number[];
}

interface RotateDeps {
  getState: () => GameState | undefined;
  withFirstHuman: (action: (human: PlayerController & InputReceiver) => void) => void;
}

interface FloatingActionsDeps {
  getState: () => GameState | undefined;
  withFirstHuman: (action: (human: PlayerController & InputReceiver) => void) => void;
  tryPlacePieceAndSend: (human: PlayerController & InputReceiver, state: GameState) => void;
  tryPlaceCannonAndSend: (human: PlayerController & InputReceiver, state: GameState, max: number) => void;
  /** Forward a drag touch to the canvas pointer-move logic. */
  onDrag?: (clientX: number, clientY: number) => void;
}

interface FloatingActionsHandle {
  /** Reposition + show/hide based on current phantom screen coords. */
  update: (visible: boolean, x: number, y: number, nearTop: boolean, leftHanded: boolean) => void;
  /** Toggle the confirm button's disabled look based on placement validity. */
  setConfirmValid: (valid: boolean) => void;
}

/**
 * Wire touch controls inside the game container.
 * Finds all d-pad, action, and rotate buttons (both landscape and portrait copies)
 * and attaches event handlers.
 */
export function createDpad(deps: DpadDeps, container: HTMLElement): {
  update: (phase: Phase | null) => void;
  setLeftHanded: (lh: boolean) => void;
  setConfirmValid: (valid: boolean) => void;
} {
  // Query all duplicated elements (landscape + portrait)
  const dpads = Array.from(container.querySelectorAll<HTMLElement>(".dpad"));
  const btnsUp = queryAll(container, "up");
  const btnsDown = queryAll(container, "down");
  const btnsLeft = queryAll(container, "left");
  const btnsRight = queryAll(container, "right");
  const btnsAction = queryAll(container, ACTION_CONFIRM);
  const btnsRotate = queryAll(container, "rotate");

  // --- Key-repeat for arrows ---
  const REPEAT_DELAY = 120;
  const REPEAT_RATE = 50;
  let repeatTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPhase: Phase | null = null;

  function stopRepeat() {
    if (repeatTimer !== null) { clearTimeout(repeatTimer); repeatTimer = null; }
  }

  function startRepeat(action: Action) {
    stopRepeat();
    fireDirection(action);
    repeatTimer = setTimeout(function tick() {
      fireDirection(action);
      repeatTimer = setTimeout(tick, REPEAT_RATE);
    }, REPEAT_DELAY);
  }

  function fireDirection(action: Action) {
    hapticTap();
    if (deps.options?.isActive()) {
      if (action === Action.UP) deps.options.navigate(-1);
      else if (action === Action.DOWN) deps.options.navigate(1);
      else if (action === Action.LEFT) deps.options.changeValue(-1);
      else if (action === Action.RIGHT) deps.options.changeValue(1);
      return;
    }
    const state = deps.getState();
    if (!state || !isGameInteractionMode(deps.getMode(), deps.modeValues)) return;
    if (isSelectionPhase(state.phase)
      && (!deps.isSelectionReady || deps.isSelectionReady())) {
      deps.withFirstHuman((human) => {
        const ss = deps.getSelectionStates().get(human.playerId);
        if (!ss || ss.confirmed) return;
        const zone = state.playerZones[human.playerId] ?? 0;
        const next = findNearestTower(state.map.towers, ss.highlighted, action, zone);
        deps.highlightTowerForPlayer(next, zone, human.playerId);
      });
    } else {
      deps.withFirstHuman((human) => {
        if (state.phase === Phase.WALL_BUILD) {
          human.moveBuildCursor(action);
        } else if (state.phase === Phase.CANNON_PLACE) {
          human.moveCannonCursor(action);
        }
      });
    }
  }

  /** Battle: hold-to-move via handleKeyDown/handleKeyUp (mirrors keyboard). */
  function battleKeyDown(action: Action) {
    hapticTap();
    deps.withFirstHuman((human) => human.handleKeyDown(action));
  }

  function battleKeyUp(action: Action) {
    deps.withFirstHuman((human) => human.handleKeyUp(action));
  }

  function isBattle(): boolean {
    return deps.getState()?.phase === Phase.BATTLE;
  }

  function wireArrow(btn: HTMLButtonElement, action: Action) {
    btn.addEventListener("touchstart", (e) => {
      e.preventDefault(); e.stopPropagation(); pressDown(btn);
      deps.clearDirectTouch?.();
      if (isBattle()) battleKeyDown(action); else startRepeat(action);
    }, { passive: false });
    btn.addEventListener("touchend", (e) => {
      e.preventDefault(); e.stopPropagation(); pressUp(btn);
      if (isBattle()) battleKeyUp(action); else stopRepeat();
    }, { passive: false });
    btn.addEventListener("touchcancel", () => {
      pressUp(btn);
      if (isBattle()) battleKeyUp(action); else stopRepeat();
    });
  }

  for (const btn of btnsUp) wireArrow(btn, Action.UP);
  for (const btn of btnsDown) wireArrow(btn, Action.DOWN);
  for (const btn of btnsLeft) wireArrow(btn, Action.LEFT);
  for (const btn of btnsRight) wireArrow(btn, Action.RIGHT);

  // --- Action button: confirm selection / place piece / place cannon ---
  function handleAction() {
    hapticTap();
    if (deps.options?.isActive()) {
      deps.options.confirm();
      return;
    }
    const state = deps.getState();
    if (!state || !lastPhase) {
      deps.lobbyAction();
      return;
    }
    if (!isGameInteractionMode(deps.getMode(), deps.modeValues)) return;
    if (isSelectionPhase(state.phase)
      && (!deps.isSelectionReady || deps.isSelectionReady())) {
      const isReselect = state.phase === Phase.CASTLE_RESELECT;
      deps.withFirstHuman((human) => {
        deps.confirmSelectionForPlayer(human.playerId, isReselect);
      });
    } else if (state.phase === Phase.BATTLE) {
      if (state.battleCountdown <= 0) {
        deps.withFirstHuman((human) => deps.fireAndSend(human, state));
      }
    } else {
      dispatchPlacement(state, deps);
    }
  }

  for (const btn of btnsAction) {
    btn.addEventListener("touchstart", (e) => {
      e.preventDefault(); e.stopPropagation(); pressDown(btn); handleAction();
    }, { passive: false });
    btn.addEventListener("touchend", (e) => {
      e.preventDefault(); pressUp(btn);
    }, { passive: false });
    btn.addEventListener("touchcancel", () => pressUp(btn));
  }

  // --- Rotate button: rotate piece / cycle cannon mode / speed up crosshair ---
  function handleRotate() {
    hapticTap();
    if (deps.options?.isActive()) {
      deps.options.changeValue(1);
      return;
    }
    if (!isGameInteractionMode(deps.getMode(), deps.modeValues)) return;
    dispatchRotate(deps);
  }

  for (const btn of btnsRotate) {
    btn.addEventListener("touchstart", (e) => {
      e.preventDefault(); e.stopPropagation(); pressDown(btn);
      if (isBattle()) battleKeyDown(Action.ROTATE); else handleRotate();
    }, { passive: false });
    btn.addEventListener("touchend", (e) => {
      e.preventDefault(); pressUp(btn);
      if (isBattle()) battleKeyUp(Action.ROTATE);
    }, { passive: false });
    btn.addEventListener("touchcancel", () => {
      pressUp(btn);
      if (isBattle()) battleKeyUp(Action.ROTATE);
    });
  }

  // --- Layout: left-handed toggle ---
  container.classList.toggle("left-handed", deps.getLeftHanded());

  return {
    update(phase: Phase | null) {
      stopRepeat();
      lastPhase = phase;
      const inGame = phase !== null;
      for (const dpad of dpads) dpad.classList.toggle("disabled", !inGame);
      for (const btn of btnsRotate) btn.classList.toggle("disabled", !inGame);
    },
    setLeftHanded(lh: boolean) {
      container.classList.toggle("left-handed", lh);
    },
    setConfirmValid(valid: boolean) {
      for (const btn of btnsAction) btn.classList.toggle("disabled", !valid);
    },
  };
}

export function createQuitButton(deps: QuitButtonDeps, container: HTMLElement): {
  update: (phase?: Phase | null) => void;
} {
  const buttons = queryAll(container, "quit");

  function handleQuit() {
    const hasHumans = deps.getControllers().some((c) => deps.isHuman(c));
    if (!hasHumans || deps.getQuitPending()) {
      deps.showLobby();
    } else {
      deps.setQuitPending(true);
      deps.setQuitTimer(2);
      deps.setQuitMessage("Tap \u2715 again to quit");
    }
  }

  for (const btn of buttons) {
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation(); handleQuit();
    });
    btn.addEventListener("touchstart", (e) => {
      e.preventDefault(); e.stopPropagation(); handleQuit();
    }, { passive: false });
  }

  return {
    update(phase?: Phase | null) {
      const hidden = phase === null || phase === undefined;
      for (const btn of buttons) btn.classList.toggle("hidden", hidden);
    },
  };
}

/** Toggle between my zone (zoomed) and full map. */
export function createHomeZoomButton(deps: ZoomButtonDeps, container: HTMLElement): {
  update: (active?: boolean) => void;
} {
  const buttons = queryAll(container, "zoom-home");

  function getMyZone(): number | null {
    const state = deps.getState();
    if (!state) return null;
    const pid = deps.myPlayerId();
    if (pid < 0) return null;
    return state.playerZones[pid] ?? null;
  }

  function toggle() {
    const current = deps.getCameraZone();
    const myZone = getMyZone();
    deps.setCameraZone(current === myZone ? null : myZone);
    updateLabel();
  }

  function updateLabel() {
    const current = deps.getCameraZone();
    const myZone = getMyZone();
    const isHome = current === myZone && myZone !== null;
    const bg = zoomButtonBg(isHome ? -1 : deps.myPlayerId(), TOUCH_ZOOM_HOME_BG);
    for (const btn of buttons) btn.style.background = bg;
  }

  for (const btn of buttons) {
    btn.addEventListener("touchstart", (e) => {
      e.preventDefault(); e.stopPropagation(); toggle();
    }, { passive: false });
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation(); toggle();
    });
  }

  return {
    update(active = true) {
      for (const btn of buttons) btn.classList.toggle("disabled", !active);
      if (active) updateLabel();
    },
  };
}

/** Cycle through opponent zones. */
export function createEnemyZoomButton(deps: ZoomButtonDeps, container: HTMLElement): {
  update: (active?: boolean) => void;
} {
  const buttons = queryAll(container, "zoom-enemy");
  const getEnemyZones = deps.getEnemyZones;

  function cycle() {
    const enemyZones = getEnemyZones();
    if (enemyZones.length === 0) return;
    const current = deps.getCameraZone();
    const idx = current !== null ? enemyZones.indexOf(current) : -1;
    const next = enemyZones[(idx + 1) % enemyZones.length]!;
    deps.setCameraZone(next);
    updateLabel();
  }

  function updateLabel() {
    const zone = deps.getCameraZone();
    const state = deps.getState();
    const pid = zone !== null && state ? state.playerZones.indexOf(zone) : -1;
    const isActive = zone !== null && getEnemyZones().includes(zone);
    const bg = zoomButtonBg(isActive ? pid : -1, TOUCH_ZOOM_ENEMY_BG);
    for (const btn of buttons) btn.style.background = bg;
  }

  for (const btn of buttons) {
    btn.addEventListener("touchstart", (e) => {
      e.preventDefault(); e.stopPropagation(); cycle();
    }, { passive: false });
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation(); cycle();
    });
  }

  return {
    update(active = true) {
      for (const btn of buttons) btn.classList.toggle("disabled", !active);
      if (active) updateLabel();
    },
  };
}

/**
 * Wire the floating Rotate + Confirm buttons that appear near the phantom
 * when the player uses direct touch on the canvas map.
 */
export function createFloatingActions(
  deps: FloatingActionsDeps,
  el: HTMLElement,
): FloatingActionsHandle {
  const btnRotate = el.querySelector<HTMLButtonElement>('[data-action="float-rotate"]')!;
  const btnConfirm = el.querySelector<HTMLButtonElement>('[data-action="float-confirm"]')!;

  function handleRotate() {
    hapticTap();
    dispatchRotate(deps);
  }

  function handleConfirm() {
    hapticTap();
    const state = deps.getState();
    if (!state) return;
    dispatchPlacement(state, deps);
  }

  const TAP_THRESHOLD = 10; // pixels — beyond this the gesture is a drag
  for (const [btn, handler] of [[btnRotate, handleRotate], [btnConfirm, handleConfirm]] as const) {
    let startX = 0;
    let startY = 0;
    let dragged = false;
    btn.addEventListener("touchstart", (e) => {
      e.preventDefault(); e.stopPropagation(); pressDown(btn);
      const t = e.touches[0];
      if (t) { startX = t.clientX; startY = t.clientY; }
      dragged = false;
    }, { passive: false });
    btn.addEventListener("touchmove", (e) => {
      e.preventDefault();
      const t = e.touches[0];
      if (!t) return;
      if (!dragged && Math.hypot(t.clientX - startX, t.clientY - startY) > TAP_THRESHOLD) {
        dragged = true;
        pressUp(btn);
      }
      if (dragged) deps.onDrag?.(t.clientX, t.clientY);
    }, { passive: false });
    btn.addEventListener("touchend", (e) => {
      e.preventDefault(); pressUp(btn);
      if (!dragged) handler();
    }, { passive: false });
    btn.addEventListener("touchcancel", () => { pressUp(btn); dragged = false; });
  }

  return {
    update(visible, x, y, nearTop, leftHanded) {
      el.classList.toggle("visible", visible);
      if (!visible) return;
      const h = el.offsetHeight;
      const gap = h * 0.25;
      let left: number;
      let top: number;
      if (nearTop) {
        const sign = leftHanded ? 1 : -1;
        left = x + sign * (h + gap);
        top = y;
      } else {
        left = x;
        top = y - h - gap;
      }
      el.style.left = `${Math.round(Math.max(0, left))}px`;
      el.style.top = `${Math.round(Math.max(0, top))}px`;
    },
    setConfirmValid(valid) {
      btnConfirm.classList.toggle("disabled", !valid);
    },
  };
}

/** Resolve the background color for a zoom button: player color if pid is valid, fallback otherwise. */
function zoomButtonBg(pid: number, fallbackBg: string): string {
  if (pid >= 0 && PLAYER_COLORS[pid]) {
    return rgb(PLAYER_COLORS[pid]!.interiorLight, ZOOM_BUTTON_ALPHA);
  }
  return fallbackBg;
}

/** Rotate piece or cycle cannon mode for the first human player. */
function dispatchRotate(deps: RotateDeps): void {
  const state = deps.getState();
  if (!state) return;
  deps.withFirstHuman((human) => {
    if (state.phase === Phase.WALL_BUILD) {
      human.rotatePiece();
    } else if (state.phase === Phase.CANNON_PLACE) {
      const max = state.cannonLimits[human.playerId] ?? 0;
      human.cycleCannonMode(state, max);
    }
  });
}

/** Query all elements matching a data-action within a container. */
function queryAll(container: HTMLElement, action: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(`[data-action="${action}"]`));
}

/** Visual press feedback via CSS class. */
function pressDown(btn: HTMLElement): void { btn.classList.add("pressed"); }

function pressUp(btn: HTMLElement): void { btn.classList.remove("pressed"); }
