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
// Zoom button — bottom-left, cycles: my zone → zone 1 → zone 2 → full map
// ---------------------------------------------------------------------------

interface ZoomButtonDeps {
  getState: () => GameState | undefined;
  getCameraZone: () => number | null;
  setCameraZone: (zone: number | null) => void;
  getMyPlayerId: () => number;
  render: () => void;
}

export function createZoomButton(deps: ZoomButtonDeps): {
  update: (phase: Phase | null) => void;
} {
  const btn = document.createElement("button");
  btn.style.cssText = `
    position: fixed;
    bottom: 36px;
    left: 24px;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    z-index: 100;
    background: rgba(60, 80, 120, 0.85);
    border: 2px solid rgba(100, 140, 200, 0.7);
    color: #c0d8f0;
    font-size: 24px;
    font-weight: bold;
    display: none;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    cursor: pointer;
    user-select: none;
  `;
  document.body.appendChild(btn);

  function cycleZoom() {
    const state = deps.getState();
    if (!state) return;
    const current = deps.getCameraZone();
    const playerCount = state.players.length;
    // Build zone list: player zones (0..N-1) then null (full map)
    const zones: (number | null)[] = [];
    for (let i = 0; i < playerCount; i++) {
      const zone = state.playerZones[i];
      if (zone !== undefined && !zones.includes(zone)) zones.push(zone);
    }
    zones.push(null); // full map

    const idx = current === null ? zones.length - 1 : zones.indexOf(current);
    const next = zones[(idx + 1) % zones.length]!;
    deps.setCameraZone(next === undefined ? null : next);
    updateLabel();
    deps.render();
  }

  function updateLabel() {
    const state = deps.getState();
    const zone = deps.getCameraZone();
    if (zone === null || !state) {
      btn.textContent = "\u25A3"; // ▣ full map
      btn.style.background = "rgba(60, 80, 120, 0.85)";
      return;
    }
    // Find which player owns this zone
    const pid = state.playerZones.indexOf(zone);
    if (pid >= 0 && PLAYER_COLORS[pid]) {
      const c = PLAYER_COLORS[pid]!.interiorLight;
      btn.style.background = `rgba(${c[0]},${c[1]},${c[2]},0.85)`;
      btn.textContent = "\u2922"; // ⤢ zoom
    } else {
      btn.textContent = "\u2922";
      btn.style.background = "rgba(60, 80, 120, 0.85)";
    }
  }

  btn.addEventListener("touchstart", (e) => {
    e.preventDefault();
    e.stopPropagation();
    cycleZoom();
  }, { passive: false });

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    cycleZoom();
  });

  return {
    update(phase: Phase | null) {
      const inGame = phase !== null;
      btn.style.display = inGame ? "block" : "none";
      updateLabel();
    },
  };
}
