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
import { PLAYER_COLORS } from "./player-config.ts";
import type { InputReceiver, PlayerController } from "./player-controller.ts";
import { rgb, TOUCH_ZOOM_ENEMY_BG, TOUCH_ZOOM_HOME_BG } from "./render-theme.ts";
import type { SelectionState } from "./selection.ts";
import { findNearestTower } from "./spatial.ts";
import type { GameState } from "./types.ts";
import { Action, Phase } from "./types.ts";

interface DpadDeps {
  getState: () => GameState | undefined;
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
  render: () => void;
  getLeftHanded: () => boolean;
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
  render: () => void;
}

interface ZoomButtonDeps {
  getState: () => GameState | undefined;
  getCameraZone: () => number | null;
  setCameraZone: (zone: number | null) => void;
  myPlayerId: () => number;
  getEnemyZones: () => number[];
  render: () => void;
}

/**
 * Wire touch controls inside the game container.
 * Finds all d-pad, action, and rotate buttons (both landscape and portrait copies)
 * and attaches event handlers.
 */
export function createDpad(deps: DpadDeps, container: HTMLElement): {
  update: (phase: Phase | null) => void;
  setLeftHanded: (lh: boolean) => void;
} {
  // Query all duplicated elements (landscape + portrait)
  const dpads = Array.from(container.querySelectorAll<HTMLElement>(".dpad"));
  const btnsUp = queryAll(container, "up");
  const btnsDown = queryAll(container, "down");
  const btnsLeft = queryAll(container, "left");
  const btnsRight = queryAll(container, "right");
  const btnsAction = queryAll(container, "confirm");
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
      deps.render();
      return;
    }
    const state = deps.getState();
    if (!state) return;
    if ((state.phase === Phase.CASTLE_SELECT || state.phase === Phase.CASTLE_RESELECT)
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
    deps.render();
  }

  /** Battle: hold-to-move via handleKeyDown/handleKeyUp (mirrors keyboard). */
  function battleArrowDown(action: Action) {
    hapticTap();
    deps.withFirstHuman((human) => human.handleKeyDown(action));
  }

  function battleArrowUp(action: Action) {
    deps.withFirstHuman((human) => human.handleKeyUp(action));
  }

  function isBattle(): boolean {
    return deps.getState()?.phase === Phase.BATTLE;
  }

  function wireArrow(btn: HTMLButtonElement, action: Action) {
    btn.addEventListener("touchstart", (e) => {
      e.preventDefault(); e.stopPropagation(); pressDown(btn);
      if (isBattle()) battleArrowDown(action); else startRepeat(action);
    }, { passive: false });
    btn.addEventListener("touchend", (e) => {
      e.preventDefault(); e.stopPropagation(); pressUp(btn);
      if (isBattle()) battleArrowUp(action); else stopRepeat();
    }, { passive: false });
    btn.addEventListener("touchcancel", () => {
      pressUp(btn);
      if (isBattle()) battleArrowUp(action); else stopRepeat();
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
      deps.render();
      return;
    }
    const state = deps.getState();
    if (!state || !lastPhase) {
      deps.lobbyAction();
      return;
    }
    if ((state.phase === Phase.CASTLE_SELECT || state.phase === Phase.CASTLE_RESELECT)
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
      deps.withFirstHuman((human) => {
        if (state.phase === Phase.WALL_BUILD) {
          deps.tryPlacePieceAndSend(human, state);
        } else if (state.phase === Phase.CANNON_PLACE) {
          const max = state.cannonLimits[human.playerId] ?? 0;
          deps.tryPlaceCannonAndSend(human, state, max);
        }
      });
    }
    deps.render();
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
      deps.render();
      return;
    }
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
    deps.render();
  }

  for (const btn of btnsRotate) {
    btn.addEventListener("touchstart", (e) => {
      e.preventDefault(); e.stopPropagation(); pressDown(btn);
      if (isBattle()) battleArrowDown(Action.ROTATE); else handleRotate();
    }, { passive: false });
    btn.addEventListener("touchend", (e) => {
      e.preventDefault(); pressUp(btn);
      if (isBattle()) battleArrowUp(Action.ROTATE);
    }, { passive: false });
    btn.addEventListener("touchcancel", () => {
      pressUp(btn);
      if (isBattle()) battleArrowUp(Action.ROTATE);
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
      deps.render();
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
    deps.render();
  }

  function updateLabel() {
    const current = deps.getCameraZone();
    const myZone = getMyZone();
    let bg: string;
    if (current === myZone && myZone !== null) {
      bg = TOUCH_ZOOM_HOME_BG;
    } else {
      const state = deps.getState();
      const pid = deps.myPlayerId();
      if (pid >= 0 && state && PLAYER_COLORS[pid]) {
        bg = rgb(PLAYER_COLORS[pid]!.interiorLight, 0.85);
      } else {
        bg = TOUCH_ZOOM_HOME_BG;
      }
    }
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
    deps.render();
  }

  function updateLabel() {
    const state = deps.getState();
    const zone = deps.getCameraZone();
    const enemyZones = getEnemyZones();
    let bg: string;
    if (zone !== null && state && enemyZones.includes(zone)) {
      const pid = state.playerZones.indexOf(zone);
      if (pid >= 0 && PLAYER_COLORS[pid]) {
        bg = rgb(PLAYER_COLORS[pid]!.interiorLight, 0.85);
      } else {
        bg = TOUCH_ZOOM_ENEMY_BG;
      }
    } else {
      bg = TOUCH_ZOOM_ENEMY_BG;
    }
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

/** Query all elements matching a data-action within a container. */
function queryAll(container: HTMLElement, action: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(`[data-action="${action}"]`));
}

/** Visual press feedback via CSS class. */
function pressDown(btn: HTMLElement): void { btn.classList.add("pressed"); }

function pressUp(btn: HTMLElement): void { btn.classList.remove("pressed"); }
