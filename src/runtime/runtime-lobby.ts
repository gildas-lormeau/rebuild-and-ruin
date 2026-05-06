import { generateMap } from "../game/index.ts";
import {
  LOBBY_SKIP_LOCKOUT,
  LOBBY_SKIP_STEP,
} from "../shared/core/game-constants.ts";
import type { GameMap, Viewport } from "../shared/core/geometry-types.ts";
import { CANVAS_H, CANVAS_W, TILE_SIZE } from "../shared/core/grid.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import {
  CURSOR_DEFAULT,
  CURSOR_POINTER,
  IS_TOUCH_DEVICE,
} from "../shared/platform/platform.ts";
import type { RenderOverlay } from "../shared/ui/overlay-types.ts";
import {
  computeGameSeed,
  type KeyBindings,
  MAX_PLAYERS,
} from "../shared/ui/player-config.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import type {
  ComputeLobbyLayoutFn,
  CreateLobbyOverlayFn,
  LobbyClickHitTestFn,
  LobbyHit,
  UIContext,
} from "./runtime-contracts.ts";
import { type RuntimeState, setMode } from "./runtime-state.ts";

interface LobbySystemDeps {
  runtimeState: RuntimeState;
  uiCtx: UIContext;
  renderFrame: (
    map: GameMap,
    overlay: RenderOverlay | undefined,
    viewport?: Viewport | null,
  ) => void;
  warmMapCache: (map: GameMap) => void;
  log: (msg: string) => void;
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
  /** Runtime-internal lobby reset: clear joined/active/timer/map, clear
   *  quit + options state, render once, flip mode to LOBBY. The host's
   *  `RuntimeConfig.showLobby` callback wraps this with platform extras
   *  (browser: title music). */
  show: () => void;
  /** Mark a slot joined and re-render the lobby preview. */
  markJoined: (pid: ValidPlayerSlot) => void;
  /** Recompute `lobby.seed` from settings and regenerate the map preview
   *  when either the seed changed or no preview exists yet. Called from
   *  the options screen on close (settings may have changed) and from
   *  `renderLobby` on first lobby entry (map slot still null). */
  refreshSeed: () => void;
}

export function createLobbySystem(deps: LobbySystemDeps): LobbySystem {
  const { runtimeState, uiCtx } = deps;

  let cachedConfirmKeys: Map<string, number> | undefined;

  function getConfirmKeys(): Map<string, number> {
    if (!cachedConfirmKeys) {
      cachedConfirmKeys = buildLobbyConfirmKeys(uiCtx.settings.keyBindings);
    }
    return cachedConfirmKeys;
  }

  /** Refresh lobby seed + map preview when the seed changed *or* no map
   *  preview exists yet. The second condition covers first-entry bootstrap
   *  when `computeGameSeed()` happens to match the initial `lobby.seed = 0`
   *  (user picked seed "0" via localStorage) — without the null check, the
   *  seed-equality branch skips map generation and `lobby.map` stays null
   *  through the first lobby render, crashing `drawMap`. */
  function refreshSeed(): void {
    const newSeed = computeGameSeed(runtimeState.settings);
    if (
      newSeed !== runtimeState.lobby.seed ||
      runtimeState.lobby.map === null
    ) {
      runtimeState.lobby.seed = newSeed;
      deps.log(`[lobby] seed: ${newSeed}`);
      const map = generateMap(newSeed);
      runtimeState.lobby.map = map;
      deps.warmMapCache(map);
    }
  }

  function renderLobby(): void {
    if (!runtimeState.lobby.map) refreshSeed();
    const { map, overlay } = deps.createLobbyOverlay(uiCtx);
    deps.renderFrame(map, overlay);
  }

  function tickLobby(dt: number): void {
    runtimeState.lobby.timerAccum = (runtimeState.lobby.timerAccum ?? 0) + dt;
    if (!runtimeState.lobby.active) return;
    const allJoined = runtimeState.lobby.joined.every(Boolean);
    if (uiCtx.getLobbyRemaining() <= 0 || allJoined) {
      runtimeState.lobby.active = false;
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
    if (!runtimeState.lobby.active) return false;
    const pid = getConfirmKeys().get(key);
    if (pid === undefined) return false;
    if (runtimeState.lobby.joined[pid]) {
      lobbySkipStep();
      return true;
    }
    void onLobbyJoin(pid as ValidPlayerSlot);
    return true;
  }

  // Coordinate space: canvasX/canvasY are CSS pixels passed directly to lobbyClickHitTest.
  // Lobby hit-tests handle TILE_SIZE scaling internally — do NOT divide by SCALE here.

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
    // Mouse/trackpad can only join one slot (keyboard can join additional slots).
    // If already joined or slot taken, treat click as a "hurry up" timer skip.
    if (
      runtimeState.inputTracking.mouseJoinedSlot !== null ||
      runtimeState.lobby.joined[hit.slotId]
    ) {
      lobbySkipStep();
      return true;
    }
    runtimeState.inputTracking.mouseJoinedSlot = hit.slotId;
    void onLobbyJoin(hit.slotId);
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
  function lobbySkipStep(): void {
    if (uiCtx.getLobbyRemaining() <= LOBBY_SKIP_LOCKOUT) return;
    runtimeState.lobby.timerAccum =
      (runtimeState.lobby.timerAccum ?? 0) + LOBBY_SKIP_STEP;
  }

  function show(): void {
    runtimeState.lobby.joined = new Array(MAX_PLAYERS).fill(false);
    runtimeState.lobby.active = true;
    runtimeState.lobby.timerAccum = 0;
    runtimeState.lobby.map = null; // force fresh seed + map preview
    runtimeState.quit.pending = false;
    runtimeState.optionsUI.returnMode = null;
    renderLobby();
    setMode(runtimeState, Mode.LOBBY);
  }

  function markJoined(pid: ValidPlayerSlot): void {
    runtimeState.lobby.joined[pid] = true;
    renderLobby();
  }

  return {
    renderLobby,
    tickLobby,
    lobbyKeyJoin,
    lobbyClick,
    cursorAt,
    show,
    markJoined,
    refreshSeed,
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
