import {
  computeLobbyLayout,
  type LobbyHit,
  lobbyClickHitTest,
} from "../render/render-composition.ts";
import {
  createLobbyOverlay,
  lobbyKeyJoin as lobbyKeyJoinShared,
  lobbySkipStep,
  tickLobby as tickLobbyShared,
  type UIContext,
} from "../render/screen-builders.ts";
import type { GameMap, Viewport } from "../shared/geometry-types.ts";
import { CANVAS_H, CANVAS_W, TILE_SIZE } from "../shared/grid.ts";
import type { RenderOverlay } from "../shared/overlay-types.ts";
import {
  CURSOR_DEFAULT,
  CURSOR_POINTER,
  IS_TOUCH_DEVICE,
} from "../shared/platform.ts";
import { MAX_PLAYERS } from "../shared/player-config.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import type { RuntimeState } from "./runtime-state.ts";

interface LobbySystemDeps {
  runtimeState: RuntimeState;
  uiCtx: UIContext;
  renderFrame: (
    map: GameMap,
    overlay: RenderOverlay | undefined,
    viewport?: Viewport | null,
  ) => void;
  refreshLobbySeed: () => void;
  showOptions: () => void;
  isOnline: boolean;
  onTickLobbyExpired: () => void;
  onLobbySlotJoined: (pid: ValidPlayerSlot) => void;
}

interface LobbySystem {
  renderLobby: () => void;
  tickLobby: (dt: number) => void;
  lobbyKeyJoin: (key: string) => boolean;
  lobbyClick: (canvasX: number, canvasY: number) => boolean;
  cursorAt: (canvasX: number, canvasY: number) => string;
}

export function createLobbySystem(deps: LobbySystemDeps): LobbySystem {
  const { runtimeState, uiCtx } = deps;

  function renderLobby(): void {
    if (!runtimeState.lobby.map) deps.refreshLobbySeed();
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

  function onLobbyJoin(pid: ValidPlayerSlot): void {
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
    if (runtimeState.mouseJoinedSlot !== null) {
      lobbySkipStep(uiCtx);
      return true;
    }
    if (!runtimeState.lobby.joined[hit.slotId]) {
      runtimeState.mouseJoinedSlot = hit.slotId;
      onLobbyJoin(hit.slotId);
    }
    return true;
  }

  function cursorAt(canvasX: number, canvasY: number): string {
    if (!runtimeState.lobby.active) return CURSOR_DEFAULT;
    const hit = lobbyClickHitTest({
      canvasX,
      canvasY,
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      tileSize: TILE_SIZE,
      slotCount: MAX_PLAYERS,
      computeLayout: computeLobbyLayout,
    });
    return hit ? CURSOR_POINTER : CURSOR_DEFAULT;
  }

  return {
    renderLobby,
    tickLobby,
    lobbyKeyJoin,
    lobbyClick,
    cursorAt,
  };
}
