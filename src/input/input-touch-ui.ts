/**
 * Touch UI — wires event handlers to the static touch controls in index.html.
 *
 * Layout is handled entirely by CSS (landscape panels / portrait bars).
 * This module only queries existing DOM elements and attaches behavior.
 *
 * Left panel : loupe + d-pad
 * Right panel: quit + zoom + rotate + confirm
 */

import type {
  DpadDeps,
  FloatingActionsDeps,
  FloatingActionsHandle,
  QuitButtonDeps,
  ZoomButtonDeps,
} from "../runtime/runtime-contracts.ts";
import { isSelectionPhase, Phase } from "../shared/core/game-phase.ts";
import { Action } from "../shared/ui/input-action.ts";
import { PLAYER_COLORS } from "../shared/ui/player-config.ts";
import {
  rgb,
  TOUCH_ZOOM_ENEMY_BG,
  TOUCH_ZOOM_HOME_BG,
  ZOOM_BUTTON_ALPHA,
} from "../shared/ui/theme.ts";
import { isInteractiveMode, Mode } from "../shared/ui/ui-mode.ts";
import { TAP_MAX_DIST } from "./input.ts";
import {
  dispatchGameAction,
  dispatchOverlayAction,
  dispatchPlacementConfirm,
  dispatchQuit,
} from "./input-dispatch.ts";

const CLS_DISABLED = "disabled";
const CLS_HIDDEN = "hidden";
const CLICK_EVENT = "click";

/**
 * Wire touch controls inside the game container.
 * Finds all d-pad, action, and rotate buttons (both landscape and portrait copies)
 * and attaches event handlers.
 */
export function createDpad(
  deps: DpadDeps,
  container: HTMLElement,
): {
  update: (phase: Phase | null, disableRotate?: boolean) => void;
  setLeftHanded: (lh: boolean) => void;
  setConfirmValid: (valid: boolean) => void;
} {
  // Query all duplicated elements (landscape + portrait)
  const dpads = Array.from(container.querySelectorAll<HTMLElement>(".dpad"));
  const btnsAction = queryAll(container, "confirm");
  const btnsRotate = queryAll(container, "rotate");

  const { stopRepeat, isBattlePhase, battleKeyDown, battleKeyUp } =
    wireDpadArrows(deps, container);

  wireActionButtons(btnsAction, () => handleDpadAction(deps));
  wireRotateButtons(
    btnsRotate,
    deps,
    isBattlePhase,
    battleKeyDown,
    battleKeyUp,
  );

  container.classList.toggle("left-handed", deps.getLeftHanded());

  let prevPhase: Phase | undefined;

  return {
    update(phase: Phase | null, disableRotate?: boolean) {
      if (phase !== prevPhase) {
        stopRepeat();
        prevPhase = phase ?? undefined;
      }
      const inGame = phase !== null;
      for (const dpad of dpads) dpad.classList.toggle(CLS_DISABLED, !inGame);
      const rotateActive =
        inGame && !isSelectionPhase(phase!) && !disableRotate;
      for (const btn of btnsRotate)
        btn.classList.toggle(CLS_DISABLED, !rotateActive);
    },
    setLeftHanded(lh: boolean) {
      container.classList.toggle("left-handed", lh);
    },
    setConfirmValid(valid: boolean) {
      for (const btn of btnsAction) btn.classList.toggle(CLS_DISABLED, !valid);
    },
  };
}

export function createQuitButton(
  deps: QuitButtonDeps,
  container: HTMLElement,
): {
  update: (phase?: Phase | null) => void;
} {
  const buttons = queryAll(container, "quit");

  function handleQuit() {
    dispatchQuit(
      {
        getPending: deps.getQuitPending,
        setPending: deps.setQuitPending,
        setTimer: deps.setQuitTimer,
        setMessage: deps.setQuitMessage,
        showLobby: deps.showLobby,
        getControllers: deps.getControllers,
        isHuman: deps.isHuman,
      },
      "Tap \u2715 again to quit",
    );
  }

  for (const btn of buttons) {
    btn.addEventListener(CLICK_EVENT, (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleQuit();
    });
    btn.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleQuit();
      },
      { passive: false },
    );
  }

  return {
    update(phase?: Phase | null) {
      const hidden = phase === null || phase === undefined;
      for (const btn of buttons) btn.classList.toggle(CLS_HIDDEN, hidden);
    },
  };
}

/** Toggle between my zone (zoomed) and full map. */
export function createHomeZoomButton(
  deps: ZoomButtonDeps,
  container: HTMLElement,
): {
  update: (active?: boolean) => void;
} {
  const buttons = queryAll(container, "zoom-home");

  function getMyZone(): number | null {
    const state = deps.getState();
    if (!state) return null;
    const pid = deps.povPlayerId();
    if (pid < 0) return null;
    return state.playerZones[pid] ?? null;
  }

  function toggle() {
    const current = deps.getCameraZone();
    const myZone = getMyZone();
    if (current === undefined) {
      // Unzoomed → zoom to own zone + move cursor home
      deps.aimAtZone?.(myZone!);
      deps.setCameraZone(myZone ?? undefined);
    } else if (current === myZone) {
      // On own zone → unzoom
      deps.setCameraZone(undefined);
    } else {
      // On enemy zone → move cursor to own home tower (camera follows)
      deps.aimAtZone?.(myZone!);
      deps.setCameraZone(myZone ?? undefined);
    }
    updateLabel();
  }

  function updateLabel() {
    const current = deps.getCameraZone();
    const myZone = getMyZone();
    const isHome = current === myZone && myZone !== null;
    const background = zoomButtonBg(
      isHome ? -1 : deps.povPlayerId(),
      TOUCH_ZOOM_HOME_BG,
    );
    for (const btn of buttons) btn.style.background = background;
  }

  for (const btn of buttons) {
    btn.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      },
      { passive: false },
    );
    btn.addEventListener(CLICK_EVENT, (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    });
  }

  return {
    update(active = true) {
      for (const btn of buttons) btn.classList.toggle(CLS_DISABLED, !active);
      if (active) updateLabel();
    },
  };
}

/** Cycle through opponent zones. */
export function createEnemyZoomButton(
  deps: ZoomButtonDeps,
  container: HTMLElement,
): {
  update: (active?: boolean) => void;
} {
  const buttons = queryAll(container, "zoom-enemy");
  const getEnemyZones = deps.getEnemyZones;

  function cycle() {
    const enemyZones = getEnemyZones();
    if (enemyZones.length === 0) return;
    const current = deps.getCameraZone();
    const idx = current !== undefined ? enemyZones.indexOf(current) : -1;
    const next = enemyZones[(idx + 1) % enemyZones.length]!;
    deps.aimAtZone?.(next);
    deps.setCameraZone(next);
    updateLabel();
  }

  function updateLabel() {
    const zone = deps.getCameraZone();
    const state = deps.getState();
    const pid =
      zone !== undefined && state ? state.playerZones.indexOf(zone) : -1;
    const isActive = zone !== undefined && getEnemyZones().includes(zone);
    const background = zoomButtonBg(isActive ? pid : -1, TOUCH_ZOOM_ENEMY_BG);
    for (const btn of buttons) btn.style.background = background;
  }

  for (const btn of buttons) {
    btn.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        cycle();
      },
      { passive: false },
    );
    btn.addEventListener(CLICK_EVENT, (e) => {
      e.preventDefault();
      e.stopPropagation();
      cycle();
    });
  }

  return {
    update(active = true) {
      for (const btn of buttons) btn.classList.toggle(CLS_DISABLED, !active);
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
  element: HTMLElement,
): FloatingActionsHandle {
  const btnRotate = element.querySelector<HTMLButtonElement>(
    '[data-action="float-rotate"]',
  )!;
  const btnConfirm = element.querySelector<HTMLButtonElement>(
    '[data-action="float-confirm"]',
  )!;

  function handleRotate() {
    deps.onHapticTap?.();
    const state = deps.getState();
    if (!state || !isInteractiveMode(deps.getMode())) return;
    deps.withPointerPlayer((human) => {
      if (state.phase === Phase.WALL_BUILD) {
        human.rotatePiece();
        deps.onPieceRotated?.();
      } else if (state.phase === Phase.CANNON_PLACE) {
        const max = state.cannonLimits[human.playerId] ?? 0;
        human.cycleCannonMode(state, max);
      }
    });
  }

  function handleConfirm() {
    deps.onHapticTap?.();
    const state = deps.getState();
    if (!state || !isInteractiveMode(deps.getMode())) return;
    deps.withPointerPlayer((human) => {
      dispatchPlacementConfirm(human, state, deps);
    });
  }

  for (const [btn, handler] of [
    [btnRotate, handleRotate],
    [btnConfirm, handleConfirm],
  ] as const) {
    wireDragOrTap(btn, handler, deps.onDrag);
  }

  return {
    update(visible, x, y, nearTop, leftHanded) {
      element.classList.toggle("visible", visible);
      if (!visible) return;
      const h = element.offsetHeight;
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
      element.style.left = `${Math.round(Math.max(0, left))}px`;
      element.style.top = `${Math.round(Math.max(0, top))}px`;
    },
    setConfirmValid(valid) {
      btnConfirm.classList.toggle(CLS_DISABLED, !valid);
    },
  };
}

/** Action button: confirm selection / place piece / place cannon / lobby join. */
function handleDpadAction(deps: DpadDeps): void {
  deps.onHapticTap?.();
  if (dispatchOverlayAction(Action.CONFIRM, deps.overlay)) return;
  const mode = deps.getMode();
  if (mode === Mode.LOBBY) {
    deps.lobbyAction();
    return;
  }
  const state = deps.getState();
  if (!state || !isInteractiveMode(mode)) return;
  deps.withPointerPlayer((human) => {
    dispatchGameAction(human, Action.CONFIRM, state, deps.gameAction);
  });
}

/** Wire d-pad arrow buttons with context-dependent behavior:
 *  - PLACEMENT PHASES: key-repeat (short initial delay, fast repeat interval)
 *  - BATTLE: hold-to-move (battleKeyDown on touchstart, battleKeyUp on touchend)
 *  Phase is checked live via isBattlePhase() on each touch, not at wiring time.
 *  repeatTimer is a closure variable shared across all four arrow buttons.
 *  Returns handles needed by the parent for phase updates and rotate wiring. */
function wireDpadArrows(
  deps: DpadDeps,
  container: HTMLElement,
): {
  stopRepeat: () => void;
  isBattlePhase: () => boolean;
  battleKeyDown: (action: Action) => void;
  battleKeyUp: (action: Action) => void;
} {
  const btnsUp = queryAll(container, "up");
  const btnsDown = queryAll(container, "down");
  const btnsLeft = queryAll(container, "left");
  const btnsRight = queryAll(container, "right");

  const { startRepeat, stopRepeat } = createKeyRepeatController(fireDirection);

  function fireDirection(action: Action) {
    deps.onHapticTap?.();
    if (dispatchOverlayAction(action, deps.overlay)) return;
    const state = deps.getState();
    if (!state || !isInteractiveMode(deps.getMode())) return;
    deps.withPointerPlayer((human) => {
      dispatchGameAction(human, action, state, deps.gameAction);
    });
  }

  function isBattlePhase(): boolean {
    return deps.getState()?.phase === Phase.BATTLE;
  }

  function battleKeyDown(action: Action) {
    deps.onHapticTap?.();
    deps.withPointerPlayer((human) => human.handleKeyDown(action));
  }

  function battleKeyUp(action: Action) {
    deps.withPointerPlayer((human) => human.handleKeyUp(action));
  }

  function wireArrow(btn: HTMLButtonElement, action: Action) {
    btn.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        pressDown(btn);
        deps.clearDirectTouch?.();
        if (isBattlePhase()) battleKeyDown(action);
        else startRepeat(action);
      },
      { passive: false },
    );
    btn.addEventListener(
      "touchend",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        pressUp(btn);
        if (isBattlePhase()) battleKeyUp(action);
        else stopRepeat();
      },
      { passive: false },
    );
    btn.addEventListener("touchcancel", () => {
      pressUp(btn);
      if (isBattlePhase()) battleKeyUp(action);
      else stopRepeat();
    });
  }

  for (const btn of btnsUp) wireArrow(btn, Action.UP);
  for (const btn of btnsDown) wireArrow(btn, Action.DOWN);
  for (const btn of btnsLeft) wireArrow(btn, Action.LEFT);
  for (const btn of btnsRight) wireArrow(btn, Action.RIGHT);

  return { stopRepeat, isBattlePhase, battleKeyDown, battleKeyUp };
}

/** Encapsulate key-repeat timing: short initial delay for responsiveness,
 *  fast repeat for holding to slide across the grid. */
function createKeyRepeatController(fireDirection: (action: Action) => void): {
  startRepeat: (action: Action) => void;
  stopRepeat: () => void;
} {
  const REPEAT_DELAY = 120;
  // 100 ms (10 Hz) instead of the prior 50 ms (20 Hz) — at 20 Hz the
  // release window between ticks was tighter than typical reaction time
  // (~200 ms), so a hold consistently overshot the target by one tile.
  const REPEAT_RATE = 100;
  let repeatTimer: ReturnType<typeof setTimeout> | undefined;

  function stopRepeat() {
    if (repeatTimer !== undefined) {
      clearTimeout(repeatTimer);
      repeatTimer = undefined;
    }
  }

  function startRepeat(action: Action) {
    stopRepeat();
    fireDirection(action);
    repeatTimer = setTimeout(function tick() {
      fireDirection(action);
      repeatTimer = setTimeout(tick, REPEAT_RATE);
    }, REPEAT_DELAY);
  }

  return { startRepeat, stopRepeat };
}

/** Wire action (confirm) buttons — single-tap, no repeat. */
function wireActionButtons(
  btnsAction: readonly HTMLButtonElement[],
  handleAction: () => void,
): void {
  for (const btn of btnsAction) {
    btn.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        pressDown(btn);
        handleAction();
      },
      { passive: false },
    );
    btn.addEventListener(
      "touchend",
      (e) => {
        e.preventDefault();
        pressUp(btn);
      },
      { passive: false },
    );
    btn.addEventListener("touchcancel", () => pressUp(btn));
  }
}

/** Wire rotate buttons — single-tap in placement, hold-to-move in battle. */
function wireRotateButtons(
  btnsRotate: readonly HTMLButtonElement[],
  deps: DpadDeps,
  isBattlePhase: () => boolean,
  battleKeyDown: (action: Action) => void,
  battleKeyUp: (action: Action) => void,
): void {
  function handleRotate() {
    deps.onHapticTap?.();
    if (dispatchOverlayAction(Action.ROTATE, deps.overlay)) return;
    if (!isInteractiveMode(deps.getMode())) return;
    const state = deps.getState();
    if (!state) return;
    deps.withPointerPlayer((human) => {
      dispatchGameAction(human, Action.ROTATE, state, deps.gameAction);
    });
  }

  for (const btn of btnsRotate) {
    btn.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        pressDown(btn);
        if (isBattlePhase()) battleKeyDown(Action.ROTATE);
        else handleRotate();
      },
      { passive: false },
    );
    btn.addEventListener(
      "touchend",
      (e) => {
        e.preventDefault();
        pressUp(btn);
        if (isBattlePhase()) battleKeyUp(Action.ROTATE);
      },
      { passive: false },
    );
    btn.addEventListener("touchcancel", () => {
      pressUp(btn);
      if (isBattlePhase()) battleKeyUp(Action.ROTATE);
    });
  }
}

/** Resolve the background color for a zoom button: player color if pid is valid, fallback otherwise. */
function zoomButtonBg(pid: number, fallbackBg: string): string {
  if (pid >= 0 && PLAYER_COLORS[pid]) {
    return rgb(PLAYER_COLORS[pid]!.interiorLight, ZOOM_BUTTON_ALPHA);
  }
  return fallbackBg;
}

/** Query all elements matching a data-action within a container. */
function queryAll(container: HTMLElement, action: string): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(`[data-action="${action}"]`),
  );
}

/** Wire a button for drag-or-tap discrimination: short touches fire `onTap`,
 *  longer drags forward to `onDrag`. Used by floating action buttons. */
function wireDragOrTap(
  btn: HTMLButtonElement,
  onTap: () => void,
  onDrag?: (clientX: number, clientY: number) => void,
): void {
  let startX = 0;
  let startY = 0;
  let dragged = false;
  btn.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      pressDown(btn);
      const touch = e.touches[0];
      if (touch) {
        startX = touch.clientX;
        startY = touch.clientY;
      }
      dragged = false;
    },
    { passive: false },
  );
  btn.addEventListener(
    "touchmove",
    (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      if (!touch) return;
      if (
        !dragged &&
        Math.hypot(touch.clientX - startX, touch.clientY - startY) >
          TAP_MAX_DIST
      ) {
        dragged = true;
        pressUp(btn);
      }
      if (dragged) onDrag?.(touch.clientX, touch.clientY);
    },
    { passive: false },
  );
  btn.addEventListener(
    "touchend",
    (e) => {
      e.preventDefault();
      pressUp(btn);
      if (!dragged) onTap();
    },
    { passive: false },
  );
  btn.addEventListener("touchcancel", () => {
    pressUp(btn);
    dragged = false;
  });
}

/** Visual press feedback via CSS class. */
function pressDown(btn: HTMLElement): void {
  btn.classList.add("pressed");
}

function pressUp(btn: HTMLElement): void {
  btn.classList.remove("pressed");
}
