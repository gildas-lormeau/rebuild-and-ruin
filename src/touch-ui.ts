/**
 * Touch UI — pocket-console layout for mobile.
 *
 * Two opaque side panels (landscape) or a bottom panel (portrait) hold all
 * touch controls.  The game canvas fills the remaining space without overlap.
 *
 * Left panel : d-pad + zoom/quit
 * Right panel: rotate + confirm (action)
 */

import { hapticTap } from "./haptics.ts";
import { PLAYER_COLORS } from "./player-config.ts";
import type { InputReceiver, PlayerController } from "./player-controller.ts";
import {
  rgb,
  TOUCH_ACTION_BG,
  TOUCH_ACTION_BORDER,
  TOUCH_ARROW_BG,
  TOUCH_ARROW_BORDER,
  TOUCH_QUIT_BG,
  TOUCH_QUIT_BORDER,
  TOUCH_ROTATE_BG,
  TOUCH_ROTATE_BORDER,
  TOUCH_ZOOM_ENEMY_BG,
  TOUCH_ZOOM_ENEMY_BORDER,
  TOUCH_ZOOM_HOME_BG,
  TOUCH_ZOOM_HOME_BORDER,
} from "./render-theme.ts";
import type { SelectionState } from "./selection.ts";
import { findNearestTower } from "./spatial.ts";
import type { GameState } from "./types.ts";
import { Action, Phase } from "./types.ts";

interface DpadDeps {
  getState: () => GameState | undefined;
  withFirstHuman: (action: (human: PlayerController & InputReceiver) => void) => void;
  tryPlacePieceAndSend: (human: PlayerController & InputReceiver, state: GameState) => void;
  tryPlaceCannonAndSend: (human: PlayerController & InputReceiver, state: GameState, max: number) => void;
  getSelectionStates: () => Map<number, SelectionState>;
  highlightTowerForPlayer: (idx: number, zone: number, pid: number) => void;
  confirmSelectionForPlayer: (pid: number, isReselect: boolean) => boolean;
  isHost: () => boolean;
  /** Join P1 in lobby (or skip if already joined). */
  lobbyAction: () => void;
  render: () => void;
  getLeftHanded: () => boolean;
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
 * Create the two side panels as children of #game-container.
 * Layout is handled entirely by CSS grid + media queries in index.html.
 */
interface TouchPanels {
  left: HTMLDivElement;
  right: HTMLDivElement;
  leftTop: HTMLDivElement;
  leftBottom: HTMLDivElement;
  rightTop: HTMLDivElement;
  rightBottom: HTMLDivElement;
}

// Button sizing — one base unit, everything proportional.
// Three constraints: absolute cap, viewport-relative, and panel-relative
const PANEL_CLASS = "touch-panel";
// vmin keeps buttons usable on both landscape and portrait.
const BTN_UNIT = "min(48px, 7.5vmin)";
const BTN_GAP = "5vmin";
const DPAD_GAP_CSS = "0.3vmin";
const GRID_SIZE_CSS = `calc(${BTN_UNIT} * 3 + ${DPAD_GAP_CSS} * 2)`;
const ACTION_LG_CSS = `calc(${BTN_UNIT} + 1.2vmin)`;
const BTN_BASE_CSS = `
  border-radius: 1.5vmin;
  font-weight: bold;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  cursor: pointer;
  user-select: none;
  transition: transform 60ms, opacity 60ms;
  display: flex;
  align-items: center;
  justify-content: center;
`;
const ARROW_CSS = BTN_BASE_CSS + `
  width: ${BTN_UNIT};
  height: ${BTN_UNIT};
  border-radius: 1vmin;
  background: ${TOUCH_ARROW_BG};
  border: 2px solid ${TOUCH_ARROW_BORDER};
  color: #c0d0e0;
`;
const ROUND_BTN_CSS = BTN_BASE_CSS + `
  width: ${BTN_UNIT};
  height: ${BTN_UNIT};
  border-radius: 50%;
`;

export function createTouchPanels(container: HTMLElement): TouchPanels {
  const lp = document.createElement("div");
  lp.className = PANEL_CLASS;
  container.prepend(lp);

  const rp = document.createElement("div");
  rp.className = PANEL_CLASS;
  container.append(rp);

  container.classList.add("has-touch-panels");

  // Each panel has top + bottom sections for space-between layout
  function addLeftSection(p: HTMLDivElement) {
    const top = document.createElement("div");
    top.style.cssText = `display: flex; flex-direction: column; align-items: center; padding: 2dvh 2vmin; gap: ${BTN_GAP};`;
    const bottom = document.createElement("div");
    bottom.style.cssText = `display: flex; flex-direction: column; align-items: center; padding: 5dvh 5vmin; gap: ${BTN_GAP};`;
    p.appendChild(top);
    p.appendChild(bottom);
    return { top, bottom };
  }

  function addRightSection(p: HTMLDivElement) {
    const top = document.createElement("div");
    top.style.cssText = `display: flex; flex-direction: column; align-items: center; padding: 5dvh 5vmin; gap: 3vmin;`;
    const bottom = document.createElement("div");
    bottom.style.cssText = `display: flex; flex-direction: column; align-items: center; padding: 5dvh 5vmin; gap: ${BTN_GAP};`;
    p.appendChild(top);
    p.appendChild(bottom);
    return { top, bottom };
  }

  const leftSections = addLeftSection(lp);
  const rightSections = addRightSection(rp);

  return {
    left: lp, right: rp,
    leftTop: leftSections.top, leftBottom: leftSections.bottom,
    rightTop: rightSections.top, rightBottom: rightSections.bottom,
  };
}

export function createDpad(deps: DpadDeps, panel: TouchPanels): {
  update: (phase: Phase | null) => void;
  setLeftHanded: (lh: boolean) => void;
} {
  // --- D-pad arrows (grid layout) ---
  const dpadGrid = document.createElement("div");
  dpadGrid.style.cssText = `
    width: ${GRID_SIZE_CSS}; height: ${GRID_SIZE_CSS};
    display: grid;
    grid-template-columns: repeat(3, ${BTN_UNIT});
    grid-template-rows: repeat(3, ${BTN_UNIT});
    gap: ${DPAD_GAP_CSS};
  `;

  function makeArrow(_label: string, gridCol: number, gridRow: number): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.style.cssText = ARROW_CSS + `grid-column: ${gridCol}; grid-row: ${gridRow};`;
    dpadGrid.appendChild(btn);
    return btn;
  }

  const btnUp    = makeArrow("\u25B2", 2, 1); // ▲
  const btnLeft  = makeArrow("\u25C0", 1, 2); // ◀
  const btnRight = makeArrow("\u25B6", 3, 2); // ▶
  const btnDown  = makeArrow("\u25BC", 2, 3); // ▼

  // --- Action buttons (place + rotate) ---
  const actionGroup = document.createElement("div");
  actionGroup.style.cssText = `
    display: flex; flex-direction: column; gap: ${BTN_GAP};
    align-items: center; justify-content: center;
  `;

  const btnRotate = document.createElement("button");
  btnRotate.style.cssText = ROUND_BTN_CSS + `
    width: ${ACTION_LG_CSS};
    height: ${ACTION_LG_CSS};
    background: ${TOUCH_ROTATE_BG};
    border: 2px solid ${TOUCH_ROTATE_BORDER};
    color: #1a1a2e;
  `;
  actionGroup.appendChild(btnRotate);

  const btnAction = document.createElement("button");
  btnAction.style.cssText = ROUND_BTN_CSS + `
    width: ${ACTION_LG_CSS};
    height: ${ACTION_LG_CSS};
    background: ${TOUCH_ACTION_BG};
    border: 2px solid ${TOUCH_ACTION_BORDER};
    color: #1a1a2e;
  `;
  actionGroup.appendChild(btnAction);

  // Initial placement: d-pad bottom-left, action buttons bottom-right
  panel.leftBottom.appendChild(dpadGrid);
  panel.rightBottom.appendChild(actionGroup);

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
    const state = deps.getState();
    if (!state) return;
    if (state.phase === Phase.CASTLE_SELECT || state.phase === Phase.CASTLE_RESELECT) {
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

  function wireArrow(btn: HTMLButtonElement, action: Action) {
    btn.addEventListener("touchstart", (e) => {
      e.preventDefault(); e.stopPropagation(); pressDown(btn); startRepeat(action);
    }, { passive: false });
    btn.addEventListener("touchend", (e) => {
      e.preventDefault(); e.stopPropagation(); pressUp(btn); stopRepeat();
    }, { passive: false });
    btn.addEventListener("touchcancel", () => { pressUp(btn); stopRepeat(); });
  }

  wireArrow(btnUp, Action.UP);
  wireArrow(btnDown, Action.DOWN);
  wireArrow(btnLeft, Action.LEFT);
  wireArrow(btnRight, Action.RIGHT);

  // --- Action button: confirm selection / place piece / place cannon ---
  function handleAction() {
    hapticTap();
    const state = deps.getState();
    if (!state || !lastPhase) {
      deps.lobbyAction();
      return;
    }
    if (state.phase === Phase.CASTLE_SELECT || state.phase === Phase.CASTLE_RESELECT) {
      const isReselect = state.phase === Phase.CASTLE_RESELECT;
      deps.withFirstHuman((human) => {
        deps.confirmSelectionForPlayer(human.playerId, isReselect);
      });
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

  btnAction.addEventListener("touchstart", (e) => {
    e.preventDefault(); e.stopPropagation(); pressDown(btnAction); handleAction();
  }, { passive: false });
  btnAction.addEventListener("touchend", (e) => {
    e.preventDefault(); pressUp(btnAction);
  }, { passive: false });
  btnAction.addEventListener("touchcancel", () => pressUp(btnAction));

  // --- Rotate button: rotate piece / cycle cannon mode ---
  function handleRotate() {
    hapticTap();
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

  btnRotate.addEventListener("touchstart", (e) => {
    e.preventDefault(); e.stopPropagation(); pressDown(btnRotate); handleRotate();
  }, { passive: false });
  btnRotate.addEventListener("touchend", (e) => {
    e.preventDefault(); pressUp(btnRotate);
  }, { passive: false });
  btnRotate.addEventListener("touchcancel", () => pressUp(btnRotate));

  // --- Layout: swap panels based on handedness (CSS order swap) ---
  const container = panel.left.parentElement!;

  function applyLayout(leftHanded: boolean) {
    container.classList.toggle("left-handed", leftHanded);
  }

  applyLayout(deps.getLeftHanded());

  return {
    update(phase: Phase | null) {
      stopRepeat();
      lastPhase = phase;
      const dpadActive = phase === Phase.CASTLE_SELECT || phase === Phase.CASTLE_RESELECT
        || phase === Phase.WALL_BUILD || phase === Phase.CANNON_PLACE;
      const rotateActive = phase === Phase.WALL_BUILD || phase === Phase.CANNON_PLACE;
      dpadGrid.classList.toggle("disabled", !dpadActive);
      btnRotate.classList.toggle("disabled", !rotateActive);
    },
    setLeftHanded(lh: boolean) {
      applyLayout(lh);
    },
  };
}

export function createQuitButton(deps: QuitButtonDeps, container?: HTMLElement): {
  update: (phase?: Phase | null) => void;
} {
  const btn = document.createElement("button");
  btn.style.cssText = ROUND_BTN_CSS + `
    width: ${ACTION_LG_CSS};
    height: ${ACTION_LG_CSS};
    background: ${TOUCH_QUIT_BG};
    border: 2px solid ${TOUCH_QUIT_BORDER};
    color: #cc8888;
  `;
  if (container) {
    btn.style.display = "none";
    container.appendChild(btn);
  } else {
    // Desktop fallback: fixed position
    btn.style.cssText += "position: fixed; top: 12px; right: 12px; z-index: 100; display: none;";
    document.body.appendChild(btn);
  }

  function handleQuit() {
    const hasHumans = deps.getControllers().some((c) => deps.isHuman(c));
    if (!hasHumans || deps.getQuitPending()) {
      deps.showLobby();
    } else {
      deps.setQuitPending(true);
      deps.setQuitTimer(2);
      deps.setQuitMessage("Tap ✕ again to quit");
      deps.render();
    }
  }

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleQuit();
  });

  btn.addEventListener("touchstart", (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleQuit();
  }, { passive: false });

  return {
    update(phase?: Phase | null) {
      btn.style.display = phase !== null ? "flex" : "none";
    },
  };
}

/** Toggle between my zone (zoomed) and full map. */
export function createHomeZoomButton(deps: ZoomButtonDeps, container: HTMLElement): {
  update: (visible?: boolean) => void;
} {
  const btn = createZoomBtn(TOUCH_ZOOM_HOME_BG, TOUCH_ZOOM_HOME_BORDER, "#c0d8f0");
  btn.dataset.btn = "home";
  container.appendChild(btn);

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
    if (current === myZone && myZone !== null) {
      btn.style.background = TOUCH_ZOOM_HOME_BG;
    } else {
      const state = deps.getState();
      const pid = deps.myPlayerId();
      if (pid >= 0 && state && PLAYER_COLORS[pid]) {
        btn.style.background = rgb(PLAYER_COLORS[pid]!.interiorLight, 0.85);
      } else {
        btn.style.background = TOUCH_ZOOM_HOME_BG;
      }
    }
  }

  btn.addEventListener("touchstart", (e) => {
    e.preventDefault(); e.stopPropagation(); toggle();
  }, { passive: false });
  btn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation(); toggle();
  });

  return {
    update(visible = true) {
      btn.style.display = visible ? "flex" : "none";
      if (visible) updateLabel();
    },
  };
}

/** Cycle through opponent zones. */
export function createEnemyZoomButton(deps: ZoomButtonDeps, container: HTMLElement): {
  update: (visible?: boolean) => void;
} {
  const btn = createZoomBtn(TOUCH_ZOOM_ENEMY_BG, TOUCH_ZOOM_ENEMY_BORDER, "#f0c0c0");
  btn.dataset.btn = "enemy";
  container.appendChild(btn);

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
    if (zone !== null && state && enemyZones.includes(zone)) {
      const pid = state.playerZones.indexOf(zone);
      if (pid >= 0 && PLAYER_COLORS[pid]) {
        btn.style.background = rgb(PLAYER_COLORS[pid]!.interiorLight, 0.85);
      }
    } else {
      btn.style.background = TOUCH_ZOOM_ENEMY_BG;
    }
  }

  btn.addEventListener("touchstart", (e) => {
    e.preventDefault(); e.stopPropagation(); cycle();
  }, { passive: false });
  btn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation(); cycle();
  });

  return {
    update(visible = true) {
      btn.style.display = visible ? "flex" : "none";
      if (visible) updateLabel();
    },
  };
}

function createZoomBtn(bgColor: string, borderColor: string, textColor: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.style.cssText = ROUND_BTN_CSS + `
    width: ${ACTION_LG_CSS};
    height: ${ACTION_LG_CSS};
    background: ${bgColor};
    border: 2px solid ${borderColor};
    color: ${textColor};
  `;
  return btn;
}

/** Visual press feedback — scale down on press, restore on release. */
function pressDown(btn: HTMLElement): void {
  btn.style.transform = "scale(0.88)";
  btn.style.opacity = "0.75";
}

function pressUp(btn: HTMLElement): void {
  btn.style.transform = "";
  btn.style.opacity = "";
}
