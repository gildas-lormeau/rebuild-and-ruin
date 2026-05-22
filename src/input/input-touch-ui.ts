/**
 * Wires event handlers to the static touch controls in index.html.
 * Layout is pure CSS (landscape panels / portrait bars); this module only
 * queries existing DOM elements and attaches behavior.
 *
 * - Left panel: loupe + d-pad
 * - Right panel: quit + zoom + rotate + confirm
 */

import type { FloatingActionsHandle } from "../runtime/ui-contracts.ts";
import {
  isPlacementPhase,
  isSelectionPhase,
  Phase,
} from "../shared/core/game-phase.ts";
import { playerByZone, zoneByPlayer } from "../shared/core/player-types.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";
import { Action } from "../shared/ui/input-action.ts";
import type {
  DpadDeps,
  FloatingActionsDeps,
  QuitButtonDeps,
  ZoomButtonDeps,
} from "../shared/ui/input-deps.ts";
import { PLAYER_COLORS } from "../shared/ui/player-config.ts";
import { rgb, TOUCH_ZOOM_BG, ZOOM_BUTTON_ALPHA } from "../shared/ui/theme.ts";
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
const CLS_FADED = "faded";
const CLICK_EVENT = "click";
const FLOATING_ACTIONS_ID = "floating-actions";
/** Fraction of the dpad radius treated as a center dead-zone — touches
 *  within it produce no direction (suppresses jitter near the origin). */
const DPAD_DEAD_ZONE = 0.15;

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
    wireDpadCircle(deps, container);

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
        getQuit: deps.getQuit,
        setQuit: deps.setQuit,
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

/** Cycle through all zones (own + opponents) in order. */
export function createZoneCycleButton(
  deps: ZoomButtonDeps,
  container: HTMLElement,
): {
  update: (active?: boolean) => void;
} {
  const buttons = queryAll(container, "zoom-zone");

  function getCycle(): ZoneId[] {
    const myZone = zoneByPlayer(deps.getState(), deps.povPlayerId());
    const enemies = deps.getEnemyZones();
    return myZone !== null ? [myZone, ...enemies] : enemies;
  }

  /** Resolve the zone the player is conceptually "looking at": the camera's
   *  reported viewed zone (explicit zone target, or the zone at a pinch
   *  viewport's center), falling back to the player's home zone when the
   *  camera is on full map / over a river / mid-CASTLE_SELECT. So a pinch
   *  on enemy B previews enemy C as the next cycle step, and an unzoomed
   *  view previews enemy 1 (cycling out from home). */
  function effectiveCurrentZone(): ZoneId | undefined {
    return (
      deps.getViewedZone() ??
      zoneByPlayer(deps.getState(), deps.povPlayerId()) ??
      undefined
    );
  }

  function nextZone(): ZoneId | undefined {
    const zones = getCycle();
    if (zones.length === 0) return undefined;
    const current = effectiveCurrentZone();
    const idx = current !== undefined ? zones.indexOf(current) : -1;
    return zones[(idx + 1) % zones.length];
  }

  function cycle() {
    const next = nextZone();
    if (next === undefined) return;
    deps.aimAtZone?.(next);
    deps.setCameraZone(next);
    updateLabel();
  }

  function updateLabel() {
    const next = nextZone();
    const state = deps.getState();
    const pid =
      next !== undefined && state
        ? (playerByZone(state.playerZones, next) ?? -1)
        : -1;
    const background = zoomButtonBg(pid, TOUCH_ZOOM_BG);
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
      for (const btn of buttons) {
        btn.classList.toggle(CLS_DISABLED, !active);
        if (active) {
          btn.style.color = "";
        } else {
          btn.style.background = "";
          btn.style.color = "transparent";
        }
      }
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
    deps.emitUiTap?.();
    const state = deps.getState();
    if (!state || !isInteractiveMode(deps.getMode())) return;
    deps.withPointerPlayer((human) => {
      if (state.phase === Phase.WALL_BUILD) {
        human.rotatePiece(state);
        deps.onPieceRotated?.();
      } else if (state.phase === Phase.CANNON_PLACE) {
        const max = state.cannonLimits[human.playerId] ?? 0;
        human.cycleCannonMode(state, max);
      }
    });
  }

  function handleConfirm() {
    deps.emitUiTap?.();
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

  // Capture phase so we run before the buttons' own touchstart handlers
  // call stopPropagation — restoring opacity the instant a finger lands.
  element.addEventListener(
    "touchstart",
    () => element.classList.remove(CLS_FADED),
    { capture: true, passive: true },
  );

  return {
    update(visible, x, y, nearTop, leftHanded) {
      element.classList.toggle("visible", visible);
      if (!visible) {
        element.classList.remove(CLS_FADED);
        return;
      }
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
  deps.emitUiTap?.();
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

/** Wire the circular touch d-pad with context-dependent behavior:
 *  - PLACEMENT PHASES: key-repeat (short initial delay, fast repeat interval).
 *    Touch position snaps to one cardinal Action via axis comparison;
 *    drag re-decodes the cardinal as the finger crosses the diagonal.
 *  - BATTLE: continuous unit-vector aiming via setDpadVector (drift in any
 *    direction the finger points; magnitude scales with distance from
 *    center, capped at 1).
 *  Phase is checked live via isBattlePhase() on each event, not at wiring
 *  time. A single touch is tracked per element via pointerId to ignore
 *  multi-finger interactions. Returns handles needed by the parent for
 *  phase updates and rotate wiring. */
function wireDpadCircle(
  deps: DpadDeps,
  container: HTMLElement,
): {
  stopRepeat: () => void;
  isBattlePhase: () => boolean;
  battleKeyDown: (action: Action) => void;
  battleKeyUp: (action: Action) => void;
} {
  const dpads = Array.from(container.querySelectorAll<HTMLElement>(".dpad"));

  const { startRepeat, stopRepeat } = createKeyRepeatController(fireDirection);

  function fireDirection(action: Action) {
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
    deps.withPointerPlayer((human) => human.handleKeyDown(action));
  }

  function battleKeyUp(action: Action) {
    deps.withPointerPlayer((human) => human.handleKeyUp(action));
  }

  function setVector(vec: { x: number; y: number }) {
    deps.withPointerPlayer((human) => human.setDpadVector(vec.x, vec.y));
  }

  function clearVector() {
    deps.withPointerPlayer((human) => human.clearDpadVector());
  }

  for (const dpad of dpads) wireDpadElement(dpad);

  function wireDpadElement(dpad: HTMLElement): void {
    let activeTouchId: number | undefined;
    let lastCardinal: Action | undefined;

    function onStart(e: TouchEvent) {
      if (activeTouchId !== undefined) return;
      const touch = e.changedTouches[0];
      if (!touch) return;
      e.preventDefault();
      e.stopPropagation();
      activeTouchId = touch.identifier;
      pressDown(dpad);
      // Emit once per physical press — avoids continuous vibration during
      // touchmove sector crossings or analog aim drift.
      deps.emitUiTap?.();
      const vec = computeDpadVector(dpad, touch);
      if (isBattlePhase()) {
        if (vec !== undefined) setVector(vec);
      } else {
        const phase = deps.getState()?.phase;
        if (phase !== undefined && isPlacementPhase(phase)) {
          // Dim the floating rotate/confirm so they don't obscure the
          // gameplay under the cursor while navigating with the d-pad.
          document
            .getElementById(FLOATING_ACTIONS_ID)
            ?.classList.add(CLS_FADED);
        }
        if (vec !== undefined) {
          const cardinal = vectorToCardinal(vec);
          lastCardinal = cardinal;
          startRepeat(cardinal);
        }
      }
    }

    function onMove(e: TouchEvent) {
      if (activeTouchId === undefined) return;
      const touch = findTouch(e.changedTouches, activeTouchId);
      if (!touch) return;
      e.preventDefault();
      const vec = computeDpadVector(dpad, touch);
      if (isBattlePhase()) {
        if (vec === undefined) clearVector();
        else setVector(vec);
      } else if (vec === undefined) {
        if (lastCardinal !== undefined) {
          stopRepeat();
          lastCardinal = undefined;
        }
      } else {
        const cardinal = vectorToCardinal(vec);
        if (cardinal !== lastCardinal) {
          stopRepeat();
          lastCardinal = cardinal;
          startRepeat(cardinal);
        }
      }
    }

    function onRelease(e: TouchEvent) {
      if (activeTouchId === undefined) return;
      const touch = findTouch(e.changedTouches, activeTouchId);
      if (!touch) return;
      e.preventDefault();
      activeTouchId = undefined;
      lastCardinal = undefined;
      pressUp(dpad);
      clearVector();
      stopRepeat();
    }

    dpad.addEventListener("touchstart", onStart, { passive: false });
    dpad.addEventListener("touchmove", onMove, { passive: false });
    dpad.addEventListener("touchend", onRelease, { passive: false });
    dpad.addEventListener("touchcancel", onRelease);
  }

  return { stopRepeat, isBattlePhase, battleKeyDown, battleKeyUp };
}

/** Compute a unit vector from the d-pad element's center to the touch
 *  point. Returns undefined inside the dead-zone. Magnitude is capped at
 *  1 (touches outside the visible circle still produce full speed). */
function computeDpadVector(
  element: HTMLElement,
  touch: Touch,
): { x: number; y: number } | undefined {
  const rect = element.getBoundingClientRect();
  const radius = Math.min(rect.width, rect.height) / 2;
  if (radius <= 0) return undefined;
  const dx = touch.clientX - (rect.left + rect.width / 2);
  const dy = touch.clientY - (rect.top + rect.height / 2);
  const dist = Math.hypot(dx, dy);
  if (dist < radius * DPAD_DEAD_ZONE) return undefined;
  const scale = Math.min(1, dist / radius);
  return { x: (dx / dist) * scale, y: (dy / dist) * scale };
}

/** Snap a unit vector to the nearest cardinal Action (used outside BATTLE).
 *  The longer-magnitude axis wins so a 30°-from-vertical drag still reads as
 *  UP/DOWN, matching how players expect a "mostly vertical" stick to behave. */
function vectorToCardinal(vec: { x: number; y: number }): Action {
  if (Math.abs(vec.x) > Math.abs(vec.y)) {
    return vec.x > 0 ? Action.RIGHT : Action.LEFT;
  }
  return vec.y > 0 ? Action.DOWN : Action.UP;
}

function findTouch(touches: TouchList, identifier: number): Touch | undefined {
  for (let i = 0; i < touches.length; i++) {
    if (touches[i]?.identifier === identifier) return touches[i];
  }
  return undefined;
}

/** Encapsulate key-repeat timing: short initial delay for responsiveness,
 *  fast repeat for holding to slide across the grid. */
function createKeyRepeatController(fireDirection: (action: Action) => void): {
  startRepeat: (action: Action) => void;
  stopRepeat: () => void;
} {
  // Initial delay well above typical reaction time (~200 ms) so a brief
  // tap-and-release moves exactly one tile and never triggers a repeat.
  const REPEAT_DELAY = 300;
  // Repeat interval kept at ~5 Hz — slow enough that the player can stop
  // on the target tile, fast enough for longer slides to feel responsive.
  const REPEAT_RATE = 180;
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
