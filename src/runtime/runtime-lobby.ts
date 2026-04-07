import type {
  ComputeLobbyLayoutFn,
  LobbyClickHitTestFn,
  LobbyHit,
} from "../render/render-composition.ts";
import type {
  CreateLobbyOverlayFn,
  UIContext,
} from "../render/render-ui-screens.ts";
import {
  LOBBY_SKIP_LOCKOUT,
  LOBBY_SKIP_STEP,
} from "../shared/game-constants.ts";
import type { GameMap, Viewport } from "../shared/geometry-types.ts";
import { CANVAS_H, CANVAS_W, TILE_SIZE } from "../shared/grid.ts";
import type { RenderOverlay } from "../shared/overlay-types.ts";
import {
  CURSOR_DEFAULT,
  CURSOR_POINTER,
  IS_TOUCH_DEVICE,
} from "../shared/platform.ts";
import { type KeyBindings, MAX_PLAYERS } from "../shared/player-config.ts";
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
  onTickLobbyExpired: () => void | Promise<void>;
  onLobbySlotJoined: (pid: ValidPlayerSlot) => void;

  // Render-domain functions (injected from composition root)
  createLobbyOverlay: CreateLobbyOverlayFn;
  computeLobbyLayout: ComputeLobbyLayoutFn;
  lobbyClickHitTest: LobbyClickHitTestFn;
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
    const { map, overlay } = deps.createLobbyOverlay(uiCtx);
    deps.renderFrame(map, overlay);
  }

  function tickLobby(dt: number): void {
    runtimeState.lobby.timerAccum = (runtimeState.lobby.timerAccum ?? 0) + dt;
    renderLobby();
    if (!uiCtx.lobby.active) return;
    const allJoined = uiCtx.lobby.joined.every(Boolean);
    if (uiCtx.getLobbyRemaining() <= 0 || allJoined) {
      uiCtx.lobby.active = false;
      void deps.onTickLobbyExpired();
    }
  }

  async function onLobbyJoin(pid: ValidPlayerSlot): Promise<void> {
    deps.onLobbySlotJoined(pid);
    renderLobby();
    // On touch devices in local mode, start immediately after joining
    if (IS_TOUCH_DEVICE && !deps.isOnline) {
      runtimeState.lobby.active = false;
      await deps.onTickLobbyExpired();
    }
  }

  function lobbyKeyJoin(key: string): boolean {
    if (!uiCtx.lobby.active) return false;
    const confirmKeys = buildLobbyConfirmKeys(uiCtx.settings.keyBindings);
    const pid = confirmKeys.get(key);
    if (pid === undefined) return false;
    if (uiCtx.lobby.joined[pid]) {
      lobbySkipStep();
      return true;
    }
    void onLobbyJoin(pid as ValidPlayerSlot);
    return true;
  }

  // Coordinate space: canvasX/canvasY are CSS pixels passed directly to lobbyClickHitTest.
  // Lobby hit-tests handle TILE_SIZE scaling internally — do NOT divide by SCALE here.
  // CONTRAST with runtime-options.ts which divides by SCALE before calling its hit-tests.

  function lobbyClick(canvasX: number, canvasY: number): boolean {
    if (!runtimeState.lobby.active) return false;
    const hit: LobbyHit | null = deps.lobbyClickHitTest({
      canvasX,
      canvasY,
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      tileSize: TILE_SIZE,
      slotCount: MAX_PLAYERS,
      computeLayout: deps.computeLobbyLayout,
    });
    if (!hit) return false;
    if (hit.type === "gear") {
      void deps.showOptions();
      return true;
    }
    // Mouse/trackpad can only join one slot (keyboard can join additional slots)
    if (runtimeState.inputTracking.mouseJoinedSlot !== null) {
      lobbySkipStep();
      return true;
    }
    if (!runtimeState.lobby.joined[hit.slotId]) {
      runtimeState.inputTracking.mouseJoinedSlot = hit.slotId;
      void onLobbyJoin(hit.slotId);
    }
    return true;
  }

  function cursorAt(canvasX: number, canvasY: number): string {
    if (!runtimeState.lobby.active) return CURSOR_DEFAULT;
    const hit = deps.lobbyClickHitTest({
      canvasX,
      canvasY,
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      tileSize: TILE_SIZE,
      slotCount: MAX_PLAYERS,
      computeLayout: deps.computeLobbyLayout,
    });
    return hit ? CURSOR_POINTER : CURSOR_DEFAULT;
  }

  /** Speed up lobby timer by one step if allowed. */
  function lobbySkipStep(): boolean {
    if (uiCtx.lobby.timerAccum === undefined) return false;
    if (uiCtx.getLobbyRemaining() <= LOBBY_SKIP_LOCKOUT) return false;
    uiCtx.lobby.timerAccum += LOBBY_SKIP_STEP;
    return true;
  }

  return {
    renderLobby,
    tickLobby,
    lobbyKeyJoin,
    lobbyClick,
    cursorAt,
  };
}

/** Build a map from confirm key → player slot index for lobby joining. */
function buildLobbyConfirmKeys(
  keyBindings: readonly KeyBindings[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (let idx = 0; idx < keyBindings.length; idx++) {
    const keyBinding = keyBindings[idx]!;
    map.set(keyBinding.confirm, idx);
    map.set(keyBinding.confirm.toUpperCase(), idx);
  }
  return map;
}
