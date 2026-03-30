/**
 * Lobby sub-system factory.
 *
 * Extracted from runtime.ts. Follows the factory-with-deps pattern.
 *
 * Deps convention (shared across all runtime-*.ts sub-systems):
 * destructure frequently-used deps (runtimeState, uiCtx) at the factory top;
 * reference rarely-used deps inline as deps.X to avoid clutter.
 */

import type { UIContext } from "./game-ui-screens.ts";
import {
  createLobbyOverlay,
  lobbyKeyJoin as lobbyKeyJoinShared,
  lobbySkipStep,
  tickLobby as tickLobbyShared,
} from "./game-ui-screens.ts";
import { computeGameSeed } from "./game-ui-settings.ts";
import { CANVAS_H, CANVAS_W, TILE_SIZE } from "./grid.ts";
import { generateMap } from "./map-generation.ts";
import { IS_TOUCH_DEVICE } from "./platform.ts";
import { MAX_PLAYERS } from "./player-config.ts";
import {
  computeLobbyLayout,
  type LobbyHit,
  lobbyClickHitTest,
} from "./render-composition.ts";
import type { MapData, RenderOverlay, Viewport } from "./render-types.ts";
import { NO_SLOT, type RuntimeState } from "./runtime-state.ts";

interface LobbySystemDeps {
  runtimeState: RuntimeState;
  uiCtx: UIContext;
  renderFrame: (
    map: MapData,
    overlay: RenderOverlay | undefined,
    viewport?: Viewport | null,
  ) => void;
  showOptions: () => void;
  isOnline: boolean;
  onTickLobbyExpired: () => void;
  onLobbySlotJoined: (pid: number) => void;
}

interface LobbySystem {
  refreshLobbySeed: () => void;
  renderLobby: () => void;
  tickLobby: (dt: number) => void;
  lobbyKeyJoin: (key: string) => boolean;
  lobbyClick: (canvasX: number, canvasY: number) => boolean;
}

export function createLobbySystem(deps: LobbySystemDeps): LobbySystem {
  const { runtimeState, uiCtx } = deps;

  function refreshLobbySeed(): void {
    const newSeed = computeGameSeed(runtimeState.settings);
    if (newSeed !== runtimeState.lobby.seed) {
      runtimeState.lobby.seed = newSeed;
      runtimeState.lobby.map = generateMap(newSeed);
    }
  }

  function renderLobby(): void {
    if (!runtimeState.lobby.map) refreshLobbySeed();
    const { map, overlay } = createLobbyOverlay(uiCtx);
    deps.renderFrame(map, overlay);
  }

  function tickLobby(dt: number): void {
    runtimeState.lobby.timerAccum = (runtimeState.lobby.timerAccum ?? 0) + dt;
    renderLobby();
    tickLobbyShared(uiCtx, () => {
      deps.onTickLobbyExpired();
    });
  }

  function onLobbyJoin(pid: number): void {
    deps.onLobbySlotJoined(pid);
    renderLobby();
    // On touch devices in local mode, start immediately after joining
    if (IS_TOUCH_DEVICE && !deps.isOnline) {
      runtimeState.lobby.active = false;
      deps.onTickLobbyExpired();
    }
  }

  function lobbyKeyJoin(key: string): boolean {
    return lobbyKeyJoinShared(uiCtx, key, onLobbyJoin);
  }

  function lobbyClick(canvasX: number, canvasY: number): boolean {
    if (!runtimeState.lobby.active) return false;
    const hit: LobbyHit | null = lobbyClickHitTest({
      canvasX,
      canvasY,
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      tileSize: TILE_SIZE,
      slotCount: MAX_PLAYERS,
      computeLayout: computeLobbyLayout,
    });
    if (!hit) return false;
    if (hit.type === "gear") {
      deps.showOptions();
      return true;
    }
    // Mouse/trackpad can only join one slot (keyboard can join additional slots)
    if (runtimeState.mouseJoinedSlot !== NO_SLOT) {
      lobbySkipStep(uiCtx);
      return true;
    }
    if (!runtimeState.lobby.joined[hit.slotId]) {
      runtimeState.mouseJoinedSlot = hit.slotId;
      onLobbyJoin(hit.slotId);
    }
    return true;
  }

  return {
    refreshLobbySeed,
    renderLobby,
    tickLobby,
    lobbyKeyJoin,
    lobbyClick,
  };
}
