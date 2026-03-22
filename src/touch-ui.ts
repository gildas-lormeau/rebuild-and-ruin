/**
 * Touch UI elements — on-screen buttons for mobile.
 *
 * Currently: rotate button (build phase) / mode button (cannon phase).
 * Only created on touch-capable devices.
 */

import { Phase } from "./types.ts";
import type { GameState } from "./types.ts";
import type { PlayerController } from "./player-controller.ts";
import { PLAYER_COLORS } from "./player-config.ts";

interface RotateButtonDeps {
  getState: () => GameState | undefined;
  withFirstHuman: (action: (human: PlayerController) => void) => void;
  render: () => void;
}

export function createRotateButton(deps: RotateButtonDeps): {
  update: (phase: Phase | null) => void;
} {
  const btn = document.createElement("button");
  btn.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    z-index: 100;
    background: rgba(200, 160, 64, 0.85);
    border: 2px solid rgba(240, 216, 112, 0.9);
    color: #1a1a2e;
    font-size: 30px;
    font-weight: bold;
    display: none;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    cursor: pointer;
    user-select: none;
  `;
  btn.textContent = "\u21BB"; // ↻ clockwise arrow
  document.body.appendChild(btn);

  btn.addEventListener("touchstart", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const state = deps.getState();
    if (!state) return;
    deps.withFirstHuman((human) => {
      if (state.phase === Phase.WALL_BUILD) {
        human.rotatePiece();
      } else if (state.phase === Phase.CANNON_PLACE) {
        const max = state.cannonLimits[human.playerId] ?? 0;
        human.cycleCannonMode(state, max);
      }
      deps.render();
    });
  }, { passive: false });

  // Also handle click for hybrid devices (mouse + touch)
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const state = deps.getState();
    if (!state) return;
    deps.withFirstHuman((human) => {
      if (state.phase === Phase.WALL_BUILD) {
        human.rotatePiece();
      } else if (state.phase === Phase.CANNON_PLACE) {
        const max = state.cannonLimits[human.playerId] ?? 0;
        human.cycleCannonMode(state, max);
      }
      deps.render();
    });
  });

  return {
    update(phase: Phase | null) {
      const visible = phase === Phase.WALL_BUILD || phase === Phase.CANNON_PLACE;
      btn.style.display = visible ? "block" : "none";
      if (phase === Phase.WALL_BUILD) {
        btn.textContent = "\u21BB"; // ↻ rotate
      } else if (phase === Phase.CANNON_PLACE) {
        btn.textContent = "\u2699"; // ⚙ mode
      }
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
  setFrameAnnouncement: (msg: string) => void;
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
      deps.setFrameAnnouncement("Tap ✕ again to quit");
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
// Status bar — bottom, shows round, scores, timer
// ---------------------------------------------------------------------------


interface StatusBarDeps {
  getState: () => GameState | undefined;
}

export function createStatusBar(_deps: StatusBarDeps): {
  update: () => void;
} {
  // Status bar is now rendered inside the canvas via drawStatusBar in render-ui.ts
  return { update() {} };
}

// ---------------------------------------------------------------------------
// Zoom buttons — bottom-left pair
//   Home: toggles between my zone and full map
//   Enemy: cycles through opponent zones
// ---------------------------------------------------------------------------

const ZOOM_BTN_CSS = `
  position: fixed;
  left: 24px;
  width: 48px;
  height: 48px;
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
  getMyPlayerId: () => number;
  firstHumanPlayerId: () => number;
  render: () => void;
}

/** Toggle between my zone (zoomed) and full map. */
export function createHomeZoomButton(deps: ZoomButtonDeps): {
  update: (phase: Phase | null) => void;
} {
  const btn = document.createElement("button");
  btn.dataset.btn = "home";
  btn.style.cssText = ZOOM_BTN_CSS + `
    bottom: 36px;
    background: rgba(60, 80, 120, 0.85);
    border: 2px solid rgba(100, 140, 200, 0.7);
    color: #c0d8f0;
  `;
  document.body.appendChild(btn);

  function getMyZone(): number | null {
    const state = deps.getState();
    if (!state) return null;
    let pid = deps.getMyPlayerId();
    if (pid < 0) pid = deps.firstHumanPlayerId();
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
      let pid = deps.getMyPlayerId();
      if (pid < 0) pid = deps.firstHumanPlayerId();
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
    bottom: 92px;
    background: rgba(100, 50, 50, 0.85);
    border: 2px solid rgba(180, 80, 80, 0.7);
    color: #f0c0c0;
  `;
  document.body.appendChild(btn);

  function getEnemyZones(): number[] {
    const state = deps.getState();
    if (!state) return [];
    let myPid = deps.getMyPlayerId();
    if (myPid < 0) myPid = deps.firstHumanPlayerId();
    const zones: number[] = [];
    for (let i = 0; i < state.players.length; i++) {
      if (i === myPid || state.players[i]!.eliminated) continue;
      const z = state.playerZones[i];
      if (z !== undefined && !zones.includes(z)) zones.push(z);
    }
    return zones;
  }

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
