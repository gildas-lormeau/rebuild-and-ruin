/**
 * Touch UI elements — on-screen buttons for mobile.
 *
 * D-pad (build/cannon phases), zoom buttons, quit button.
 * Only created on touch-capable devices.
 */

import { Phase, Action } from "./types.ts";
import type { GameState } from "./types.ts";
import type { PlayerController } from "./player-controller.ts";
import { PLAYER_COLORS } from "./player-config.ts";
import { findNearestTower } from "./spatial.ts";
import type { SelectionState } from "./selection.ts";

// ---------------------------------------------------------------------------
// D-pad — directional arrows + action + rotate
// ---------------------------------------------------------------------------

const DPAD_BTN = 48;       // arrow button size
const DPAD_GAP = 2;        // gap between arrow buttons
const ACTION_BTN = 56;     // action/rotate button size
const DPAD_MARGIN = 84;    // distance from screen edge (clears zoom buttons at left: 24px + 48px + gap)
const DPAD_BOTTOM = 20;    // distance from bottom

const BTN_BASE_CSS = `
  border-radius: 10px;
  z-index: 100;
  font-weight: bold;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: center;
`;

const ARROW_CSS = BTN_BASE_CSS + `
  width: ${DPAD_BTN}px;
  height: ${DPAD_BTN}px;
  background: rgba(80, 90, 110, 0.8);
  border: 2px solid rgba(140, 160, 190, 0.7);
  color: #c0d0e0;
  font-size: 22px;
`;

const ACTION_CSS = BTN_BASE_CSS + `
  width: ${ACTION_BTN}px;
  height: ${ACTION_BTN}px;
  border-radius: 50%;
`;

interface DpadDeps {
  getState: () => GameState | undefined;
  withFirstHuman: (action: (human: PlayerController) => void) => void;
  tryPlacePieceAndSend: (human: PlayerController, state: GameState) => void;
  tryPlaceCannonAndSend: (human: PlayerController, state: GameState, max: number) => void;
  getSelectionStates: () => Map<number, SelectionState>;
  highlightTowerForPlayer: (idx: number, zone: number, pid: number) => void;
  confirmSelectionForPlayer: (pid: number, isReselect: boolean) => boolean;
  finishSelection: () => void;
  finishReselection: () => void;
  isHost: () => boolean;
  render: () => void;
  getLeftHanded: () => boolean;
}

export function createDpad(deps: DpadDeps): {
  update: (phase: Phase | null) => void;
  setLeftHanded: (lh: boolean) => void;
} {
  const container = document.createElement("div");
  container.style.cssText = `position: fixed; bottom: ${DPAD_BOTTOM}px; left: 0; right: 0; z-index: 100; display: none; pointer-events: none;`;
  document.body.appendChild(container);

  // --- D-pad arrows (grid layout) ---
  const dpadGrid = document.createElement("div");
  const gridSize = DPAD_BTN * 3 + DPAD_GAP * 2;
  dpadGrid.style.cssText = `
    position: absolute; bottom: 0;
    width: ${gridSize}px; height: ${gridSize}px;
    display: grid;
    grid-template-columns: repeat(3, ${DPAD_BTN}px);
    grid-template-rows: repeat(3, ${DPAD_BTN}px);
    gap: ${DPAD_GAP}px;
    pointer-events: auto;
  `;
  container.appendChild(dpadGrid);

  function makeArrow(label: string, gridCol: number, gridRow: number): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.style.cssText = ARROW_CSS + `grid-column: ${gridCol}; grid-row: ${gridRow};`;
    btn.textContent = label;
    dpadGrid.appendChild(btn);
    return btn;
  }

  const btnUp    = makeArrow("\u25B2", 2, 1); // ▲
  const btnLeft  = makeArrow("\u25C0", 1, 2); // ◀
  const btnRight = makeArrow("\u25B6", 3, 2); // ▶
  const btnDown  = makeArrow("\u25BC", 2, 3); // ▼

  // --- Action buttons (place + rotate) ---
  // Action buttons are vertically centered against the d-pad grid height
  const actionGroupHeight = ACTION_BTN + 12 + (ACTION_BTN + 8); // rotate + gap + action
  const actionBottom = Math.max(0, (gridSize - actionGroupHeight) / 2);
  const actionGroup = document.createElement("div");
  actionGroup.style.cssText = `position: absolute; bottom: ${actionBottom}px; display: flex; flex-direction: column; gap: 12px; align-items: center; pointer-events: auto;`;
  container.appendChild(actionGroup);

  const btnRotate = document.createElement("button");
  btnRotate.style.cssText = ACTION_CSS + `
    background: rgba(200, 160, 64, 0.85);
    border: 2px solid rgba(240, 216, 112, 0.9);
    color: #1a1a2e;
    font-size: 26px;
  `;
  btnRotate.textContent = "\u21BB"; // ↻
  actionGroup.appendChild(btnRotate);

  const btnAction = document.createElement("button");
  btnAction.style.cssText = ACTION_CSS + `
    width: ${ACTION_BTN + 8}px;
    height: ${ACTION_BTN + 8}px;
    background: rgba(60, 160, 80, 0.85);
    border: 2px solid rgba(100, 220, 120, 0.9);
    color: #1a1a2e;
    font-size: 26px;
  `;
  btnAction.textContent = "\u2714"; // ✔
  actionGroup.appendChild(btnAction);

  // --- Key-repeat for arrows ---
  const REPEAT_DELAY = 200;
  const REPEAT_RATE = 80;
  let repeatTimer: ReturnType<typeof setTimeout> | null = null;

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
      e.preventDefault(); e.stopPropagation(); startRepeat(action);
    }, { passive: false });
    btn.addEventListener("touchend", (e) => {
      e.preventDefault(); e.stopPropagation(); stopRepeat();
    }, { passive: false });
    btn.addEventListener("touchcancel", () => stopRepeat());
  }

  wireArrow(btnUp, Action.UP);
  wireArrow(btnDown, Action.DOWN);
  wireArrow(btnLeft, Action.LEFT);
  wireArrow(btnRight, Action.RIGHT);

  // --- Action button: confirm selection / place piece / place cannon ---
  function handleAction() {
    const state = deps.getState();
    if (!state) return;
    if (state.phase === Phase.CASTLE_SELECT || state.phase === Phase.CASTLE_RESELECT) {
      const isReselect = state.phase === Phase.CASTLE_RESELECT;
      deps.withFirstHuman((human) => {
        if (deps.confirmSelectionForPlayer(human.playerId, isReselect) && deps.isHost()) {
          if (isReselect) deps.finishReselection();
          else deps.finishSelection();
        }
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
    e.preventDefault(); e.stopPropagation(); handleAction();
  }, { passive: false });

  // --- Rotate button: rotate piece / cycle cannon mode ---
  function handleRotate() {
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
    e.preventDefault(); e.stopPropagation(); handleRotate();
  }, { passive: false });

  // --- Layout: position d-pad and action group based on handedness ---
  function applyLayout(leftHanded: boolean) {
    if (leftHanded) {
      // D-pad right, actions left
      dpadGrid.style.right = `${DPAD_MARGIN}px`; dpadGrid.style.left = "";
      actionGroup.style.left = `${DPAD_MARGIN}px`; actionGroup.style.right = "";
    } else {
      // D-pad left, actions right
      dpadGrid.style.left = `${DPAD_MARGIN}px`; dpadGrid.style.right = "";
      actionGroup.style.right = `${DPAD_MARGIN}px`; actionGroup.style.left = "";
    }
  }

  applyLayout(deps.getLeftHanded());

  return {
    update(phase: Phase | null) {
      const isSelection = phase === Phase.CASTLE_SELECT || phase === Phase.CASTLE_RESELECT;
      const visible = isSelection || phase === Phase.WALL_BUILD || phase === Phase.CANNON_PLACE;
      container.style.display = visible ? "block" : "none";
      stopRepeat();
      if (isSelection) {
        btnRotate.style.display = "none";
      } else {
        btnRotate.style.display = "flex";
        if (phase === Phase.WALL_BUILD) {
          btnRotate.textContent = "\u21BB"; // ↻ rotate
        } else if (phase === Phase.CANNON_PLACE) {
          btnRotate.textContent = "\u2699"; // ⚙ mode
        }
      }
    },
    setLeftHanded(lh: boolean) {
      applyLayout(lh);
    },
  };
}

// ---------------------------------------------------------------------------
// Quit button — top-right, always visible during game
// ---------------------------------------------------------------------------

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

export function createQuitButton(deps: QuitButtonDeps): {
  update: (phase: Phase | null) => void;
} {
  const btn = document.createElement("button");
  btn.style.cssText = `
    position: fixed;
    top: 12px;
    right: 12px;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    z-index: 100;
    background: rgba(80, 40, 40, 0.7);
    border: 2px solid rgba(180, 80, 80, 0.7);
    color: #cc8888;
    font-size: 22px;
    font-weight: bold;
    display: none;
    cursor: pointer;
    user-select: none;
    line-height: 1;
  `;
  btn.textContent = "✕";
  document.body.appendChild(btn);

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
    update(phase: Phase | null) {
      btn.style.display = phase !== null ? "block" : "none";
    },
  };
}

// ---------------------------------------------------------------------------
// Zoom buttons — bottom-left pair
//   Home: toggles between my zone and full map
//   Enemy: cycles through opponent zones
// ---------------------------------------------------------------------------

const ZOOM_BTN_SIZE = 48;
const ZOOM_BTN_MARGIN = 24;
const ZOOM_BTN_BOTTOM = 36;
const ZOOM_BTN_GAP = 8;
const ZOOM_BTN_CSS = `
  position: fixed;
  left: ${ZOOM_BTN_MARGIN}px;
  width: ${ZOOM_BTN_SIZE}px;
  height: ${ZOOM_BTN_SIZE}px;
  border-radius: 50%;
  z-index: 100;
  font-size: 24px;
  font-weight: bold;
  display: none;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  cursor: pointer;
  user-select: none;
`;

interface ZoomButtonDeps {
  getState: () => GameState | undefined;
  getCameraZone: () => number | null;
  setCameraZone: (zone: number | null) => void;
  myPlayerId: () => number;
  getEnemyZones: () => number[];
  render: () => void;
}

/** Toggle between my zone (zoomed) and full map. */
export function createHomeZoomButton(deps: ZoomButtonDeps): {
  update: (phase: Phase | null) => void;
} {
  const btn = document.createElement("button");
  btn.dataset.btn = "home";
  btn.style.cssText = ZOOM_BTN_CSS + `
    bottom: ${ZOOM_BTN_BOTTOM}px;
    background: rgba(60, 80, 120, 0.85);
    border: 2px solid rgba(100, 140, 200, 0.7);
    color: #c0d8f0;
  `;
  document.body.appendChild(btn);

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
      // Currently zoomed on my zone — show full-map icon
      btn.textContent = "\u25A3"; // ▣ full map
      btn.style.background = "rgba(60, 80, 120, 0.85)";
    } else {
      // Currently full map or enemy — show home icon with my color
      btn.textContent = "\u2302"; // ⌂ home
      const state = deps.getState();
      const pid = deps.myPlayerId();
      if (pid >= 0 && state && PLAYER_COLORS[pid]) {
        const c = PLAYER_COLORS[pid]!.interiorLight;
        btn.style.background = `rgba(${c[0]},${c[1]},${c[2]},0.85)`;
      } else {
        btn.style.background = "rgba(60, 80, 120, 0.85)";
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
    update(phase: Phase | null) {
      btn.style.display = phase !== null ? "block" : "none";
      updateLabel();
    },
  };
}

/** Cycle through opponent zones. */
export function createEnemyZoomButton(deps: ZoomButtonDeps): {
  update: (phase: Phase | null) => void;
} {
  const btn = document.createElement("button");
  btn.dataset.btn = "enemy";
  btn.style.cssText = ZOOM_BTN_CSS + `
    bottom: ${ZOOM_BTN_BOTTOM + ZOOM_BTN_SIZE + ZOOM_BTN_GAP}px;
    background: rgba(100, 50, 50, 0.85);
    border: 2px solid rgba(180, 80, 80, 0.7);
    color: #f0c0c0;
  `;
  document.body.appendChild(btn);

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
    // If currently viewing an enemy zone, show that enemy's color
    if (zone !== null && state && enemyZones.includes(zone)) {
      const pid = state.playerZones.indexOf(zone);
      if (pid >= 0 && PLAYER_COLORS[pid]) {
        const c = PLAYER_COLORS[pid]!.interiorLight;
        btn.style.background = `rgba(${c[0]},${c[1]},${c[2]},0.85)`;
      }
      btn.textContent = "\u2694"; // ⚔ swords
    } else {
      btn.textContent = "\u2694"; // ⚔ swords
      btn.style.background = "rgba(100, 50, 50, 0.85)";
    }
  }

  btn.addEventListener("touchstart", (e) => {
    e.preventDefault(); e.stopPropagation(); cycle();
  }, { passive: false });
  btn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation(); cycle();
  });

  return {
    update(phase: Phase | null) {
      btn.style.display = phase !== null ? "block" : "none";
      updateLabel();
    },
  };
}
