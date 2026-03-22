/**
 * Touch UI elements — on-screen buttons for mobile.
 *
 * Currently: rotate button (build phase) / mode button (cannon phase).
 * Only created on touch-capable devices.
 */

import { Phase } from "./types.ts";
import type { GameState } from "./types.ts";
import type { PlayerController } from "./player-controller.ts";

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
    font-size: 24px;
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
