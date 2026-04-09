/**
 * E2E test bridge — exposes game internals on `window.__e2e` each frame.
 *
 * Dev-only (guarded by IS_DEV at call site). Provides structured access to
 * game state, render overlay, camera, controllers, and network for Playwright
 * tests. Replaces the old runtime-test-globals.ts.
 */

import { computeLetterboxLayout } from "../shared/canvas-layout.ts";
import { Phase } from "../shared/game-phase.ts";
import { TILE_SIZE } from "../shared/grid.ts";
import { isPlayerEliminated } from "../shared/player-types.ts";
import {
  clearRenderSpy,
  enableRenderSpy,
  getRenderSpyLog,
  getTextSpyLog,
  type TextDraw,
} from "../shared/render-spy.ts";
import { tileCenterPx, unpackTile } from "../shared/spatial.ts";
import { type GameViewState, isHuman } from "../shared/system-interfaces.ts";
import { Mode } from "../shared/ui-mode.ts";
import { isStateReady, type RuntimeState } from "./runtime-state.ts";
import type { RuntimeConfig } from "./runtime-types.ts";

interface E2EEntitySnapshot {
  houses: { row: number; col: number; alive: boolean }[];
  grunts: { row: number; col: number }[];
  towerAlive: boolean[];
  burningPits: { row: number; col: number }[];
  bonusSquares: { row: number; col: number }[];
  frozenTiles: number[];
}

interface E2EPhantomSnapshot {
  pieces: {
    row: number;
    col: number;
    valid: boolean;
    playerId: number;
  }[];
  cannons: {
    row: number;
    col: number;
    valid: boolean;
    mode: string;
    playerId: number;
  }[];
}

interface E2EBannerSnapshot {
  text: string;
  y: number;
  modifierDiff: {
    id: string;
    changedTiles: readonly number[];
    gruntsSpawned: number;
  } | null;
}

interface E2EBattleSnapshot {
  cannonballs: number;
  impacts: number;
  crosshairs: { x: number; y: number; playerId: number }[];
}

interface E2EUISnapshot {
  statusBar: {
    round: string;
    phase: string;
    timer: string;
    modifier?: string;
  } | null;
  /** Master Builder lockout seconds remaining (0 = inactive). */
  masterBuilderLockout: number;
  gameOver: { winner: string } | null;
  lifeLostDialog: {
    entries: { playerId: number; choice: string }[];
  } | null;
  upgradePick: {
    entries: { playerName: string; resolved: boolean }[];
  } | null;
}

interface E2EPlayerSnapshot {
  id: number;
  score: number;
  lives: number;
  eliminated: boolean;
  walls: number;
  cannons: number;
}

interface E2EControllerSnapshot {
  buildCursor: { row: number; col: number } | null;
  cannonCursor: { row: number; col: number } | null;
  cannonMode: string | null;
  crosshair: { x: number; y: number } | null;
}

interface E2ENetworkMessage {
  dir: "in" | "out";
  type: string;
  time: number;
}

/** The full bridge object exposed on window.__e2e. */
interface E2EBridge {
  // Core state
  mode: string;
  phase: string;
  round: number;
  timer: number;

  // Render overlay
  overlay: {
    entities: E2EEntitySnapshot | null;
    /** Entities snapshot from before the banner sweep — null when no banner active. */
    bannerPrevEntities: E2EEntitySnapshot | null;
    phantoms: E2EPhantomSnapshot | null;
    banner: E2EBannerSnapshot | null;
    battle: E2EBattleSnapshot | null;
    ui: E2EUISnapshot;
  };

  // Players
  players: E2EPlayerSnapshot[];

  // Human controller
  controller: E2EControllerSnapshot | null;

  // Camera
  camera: {
    viewport: { x: number; y: number; w: number; h: number } | undefined;
  };

  // Coord conversion (callable from page.evaluate)
  worldToClient: (wx: number, wy: number) => { cx: number; cy: number };
  tileToClient: (row: number, col: number) => { cx: number; cy: number };

  // Pause / step
  paused: boolean;
  step: boolean;

  // Render spy — records drawSprite/text calls per frame (call enableRenderSpy to start)
  enableRenderSpy: () => void;
  renderSpy: { name: string; x: number; y: number }[] | null;
  textSpy: TextDraw[] | null;

  // Battle targeting (computed from state for e2e battle simulation)
  targeting: {
    enemyCannons: { x: number; y: number }[];
    enemyTargets: { x: number; y: number }[];
  };

  // Network
  network: {
    messages: E2ENetworkMessage[];
    logLevel: "type" | "full";
  };
}

interface E2EBridgeDeps {
  runtimeState: RuntimeState;
  config: Pick<RuntimeConfig, "getMyPlayerId">;
  camera: {
    worldToScreen: (wx: number, wy: number) => { sx: number; sy: number };
    getViewport: () =>
      | { x: number; y: number; w: number; h: number }
      | undefined;
  };
  renderer: {
    eventTarget: HTMLElement;
  };
}

/** Module-scoped singleton — created on first call, reused across frames.
 *  Holds only shallow snapshots (rebuilt each frame) and coordinate-conversion
 *  closures. No direct GameState references are retained between frames. */
let bridge: E2EBridge | undefined;

/** Update the E2E bridge on `window.__e2e` with the current frame's state.
 *  Called once per frame from the main loop (dev-only). */
export function exposeE2EBridge(deps: E2EBridgeDeps): void {
  if (typeof window === "undefined") return;

  const win = globalThis as unknown as Record<string, unknown>;

  if (bridge === undefined) {
    const worldToClient = makeWorldToClient(deps);
    bridge = {
      mode: "",
      phase: "",
      round: 0,
      timer: 0,
      overlay: {
        entities: null,
        bannerPrevEntities: null,
        phantoms: null,
        banner: null,
        battle: null,
        ui: {
          statusBar: null,
          masterBuilderLockout: 0,
          gameOver: null,
          lifeLostDialog: null,
          upgradePick: null,
        },
      },
      players: [],
      controller: null,
      camera: { viewport: undefined },
      worldToClient,
      tileToClient: makeTileToClient(worldToClient),
      enableRenderSpy,
      renderSpy: null,
      textSpy: null,
      targeting: { enemyCannons: [], enemyTargets: [] },
      paused: false,
      step: false,
      network: { messages: [], logLevel: "type" },
    };
    win.__e2e = bridge;
  }
  // After init guard, bridge is guaranteed non-null
  const ref = bridge!;

  // --- Pause support ---
  if (ref.paused) {
    if (ref.step) {
      ref.step = false;
      // fall through to update one frame
    } else {
      return; // frozen
    }
  }

  updateBridgeSnapshots(ref, deps);
}

/** Snapshot all bridge fields from the current frame's runtime state. */
function updateBridgeSnapshots(ref: E2EBridge, deps: E2EBridgeDeps): void {
  const { runtimeState, config } = deps;

  // --- Core ---
  ref.mode = Mode[runtimeState.mode];
  const ready = isStateReady(runtimeState);
  ref.phase = ready ? Phase[runtimeState.state.phase] : "";
  ref.round = ready ? runtimeState.state.round : 0;
  ref.timer = ready ? runtimeState.state.timer : 0;

  // --- Overlay ---
  ref.overlay.entities = snapshotEntities(runtimeState);
  ref.overlay.bannerPrevEntities = snapshotBannerPrevEntities(runtimeState);
  ref.overlay.phantoms = snapshotPhantoms(runtimeState);
  ref.overlay.banner = snapshotBanner(runtimeState);
  ref.overlay.battle = snapshotBattle(runtimeState);
  ref.overlay.ui = snapshotUI(runtimeState);

  // --- Players ---
  ref.players = ready ? snapshotPlayers(runtimeState.state) : [];

  // --- Controller ---
  // In local mode getMyPlayerId() returns -1; fall back to slot 0 (first human)
  const myPid = config.getMyPlayerId() >= 0 ? config.getMyPlayerId() : 0;
  ref.controller = ready ? snapshotController(runtimeState, myPid) : null;

  // --- Camera ---
  ref.camera.viewport = deps.camera.getViewport();

  // --- Render spy (snapshot then clear for next frame) ---
  const spyLog = getRenderSpyLog();
  ref.renderSpy = spyLog ? [...spyLog] : null;
  const textLog = getTextSpyLog();
  ref.textSpy = textLog ? [...textLog] : null;
  clearRenderSpy();

  // --- Targeting (battle simulation) ---
  if (ready) {
    const targeting = collectEnemyTargets(runtimeState.state, myPid);
    ref.targeting.enemyCannons = targeting.enemyCannons;
    ref.targeting.enemyTargets = targeting.enemyTargets;
  }
}

/** Inverse of clientToSurface — world pixels to client coordinates.
 *  Uses camera worldToScreen + letterbox-aware canvas→client conversion. */
function makeWorldToClient(
  deps: E2EBridgeDeps,
): (wx: number, wy: number) => { cx: number; cy: number } {
  return (wx: number, wy: number) => {
    const { sx, sy } = deps.camera.worldToScreen(wx, wy);
    return canvasToClient(
      sx,
      sy,
      deps.renderer.eventTarget as HTMLCanvasElement,
    );
  };
}

/** Inverse of clientToCanvas — backing-store pixels to client coordinates.
 *  Accounts for letterboxing (object-fit:contain). */
function canvasToClient(
  sx: number,
  sy: number,
  canvas: HTMLCanvasElement,
): { cx: number; cy: number } {
  const rect = canvas.getBoundingClientRect();
  const { contentW, contentH, offsetX, offsetY } = computeLetterboxLayout(
    canvas,
    rect,
  );
  return {
    cx: (sx / canvas.width) * contentW + offsetX + rect.left,
    cy: (sy / canvas.height) * contentH + offsetY + rect.top,
  };
}

function makeTileToClient(
  worldToClient: (wx: number, wy: number) => { cx: number; cy: number },
): (row: number, col: number) => { cx: number; cy: number } {
  return (row: number, col: number) =>
    worldToClient((col + 0.5) * TILE_SIZE, (row + 0.5) * TILE_SIZE);
}

function snapshotEntities(
  runtimeState: RuntimeState,
): E2EEntitySnapshot | null {
  const ent = runtimeState.overlay.entities;
  return ent ? entityOverlayToSnapshot(ent) : null;
}

function snapshotBannerPrevEntities(
  runtimeState: RuntimeState,
): E2EEntitySnapshot | null {
  const prev = runtimeState.overlay.ui?.bannerPrevEntities;
  return prev ? entityOverlayToSnapshot(prev) : null;
}

function entityOverlayToSnapshot(
  ent: NonNullable<RuntimeState["overlay"]["entities"]>,
): E2EEntitySnapshot {
  return {
    houses: (ent.houses ?? []).map((h) => ({
      row: h.row,
      col: h.col,
      alive: h.alive,
    })),
    grunts: (ent.grunts ?? []).map((gr) => ({ row: gr.row, col: gr.col })),
    towerAlive: [...(ent.towerAlive ?? [])],
    burningPits: (ent.burningPits ?? []).map((pit) => ({
      row: pit.row,
      col: pit.col,
    })),
    bonusSquares: (ent.bonusSquares ?? []).map((b) => ({
      row: b.row,
      col: b.col,
    })),
    frozenTiles: ent.frozenTiles ? [...ent.frozenTiles] : [],
  };
}

function snapshotPhantoms(
  runtimeState: RuntimeState,
): E2EPhantomSnapshot | null {
  const phantoms = runtimeState.overlay.phantoms;
  if (!phantoms) return null;
  return {
    pieces: (phantoms.piecePhantoms ?? []).map((piece) => ({
      row: piece.row,
      col: piece.col,
      valid: piece.valid,
      playerId: piece.playerId,
    })),
    cannons: (phantoms.cannonPhantoms ?? []).map((cannon) => ({
      row: cannon.row,
      col: cannon.col,
      valid: cannon.valid,
      mode: String(cannon.mode),
      playerId: cannon.playerId,
    })),
  };
}

function snapshotBanner(runtimeState: RuntimeState): E2EBannerSnapshot | null {
  const banner = runtimeState.overlay.ui?.banner;
  if (!banner) return null;
  return {
    text: banner.text,
    y: banner.y,
    modifierDiff: banner.modifierDiff
      ? {
          id: banner.modifierDiff.id,
          changedTiles: banner.modifierDiff.changedTiles,
          gruntsSpawned: banner.modifierDiff.gruntsSpawned,
        }
      : null,
  };
}

function snapshotBattle(runtimeState: RuntimeState): E2EBattleSnapshot | null {
  const battle = runtimeState.overlay.battle;
  if (!battle) return null;
  return {
    cannonballs: battle.cannonballs?.length ?? 0,
    impacts: battle.impacts?.length ?? 0,
    crosshairs: (battle.crosshairs ?? []).map((ch) => ({
      x: ch.x,
      y: ch.y,
      playerId: ch.playerId,
    })),
  };
}

function snapshotUI(runtimeState: RuntimeState): E2EUISnapshot {
  const ui = runtimeState.overlay.ui;
  return {
    statusBar: ui?.statusBar
      ? {
          round: ui.statusBar.round,
          phase: ui.statusBar.phase,
          timer: ui.statusBar.timer,
          modifier: ui.statusBar.modifier,
        }
      : null,
    masterBuilderLockout: ui?.masterBuilderLockout ?? 0,
    gameOver: ui?.gameOver ? { winner: ui.gameOver.winner } : null,
    lifeLostDialog: ui?.lifeLostDialog
      ? {
          entries: ui.lifeLostDialog.entries.map((entry) => ({
            playerId: entry.playerId,
            choice: String(entry.choice),
          })),
        }
      : null,
    upgradePick: ui?.upgradePick
      ? {
          entries: ui.upgradePick.entries.map((entry) => ({
            playerName: entry.playerName,
            resolved: entry.resolved,
          })),
        }
      : null,
  };
}

function snapshotPlayers(state: GameViewState): E2EPlayerSnapshot[] {
  return state.players.map((player) => ({
    id: player.id,
    score: player.score,
    lives: player.lives,
    eliminated: player.eliminated,
    walls: player.walls.size,
    cannons: player.cannons.length,
  }));
}

function snapshotController(
  runtimeState: RuntimeState,
  myPid: number,
): E2EControllerSnapshot | null {
  if (myPid < 0) return null;
  const ctrl = runtimeState.controllers[myPid];
  if (!ctrl) return null;
  const ch = ctrl.getCrosshair();
  const cannonMode = isHuman(ctrl) ? String(ctrl.getCannonPlaceMode()) : null;
  return {
    buildCursor: { row: ctrl.buildCursor.row, col: ctrl.buildCursor.col },
    cannonCursor: {
      row: ctrl.cannonCursor.row,
      col: ctrl.cannonCursor.col,
    },
    cannonMode,
    crosshair: ch ? { x: ch.x, y: ch.y } : null,
  };
}

/** Collect enemy cannons and walls as pixel positions for E2E battle targeting. */
function collectEnemyTargets(
  state: GameViewState,
  myPid: number,
): {
  enemyCannons: { x: number; y: number }[];
  enemyTargets: { x: number; y: number }[];
} {
  const enemyCannons: { x: number; y: number }[] = [];
  for (const player of state.players) {
    if (player.id === myPid || isPlayerEliminated(player)) continue;
    for (const cannon of player.cannons) {
      if (cannon.hp > 0)
        enemyCannons.push(tileCenterPx(cannon.row, cannon.col));
    }
  }

  const enemyTargets: { x: number; y: number }[] = [...enemyCannons];
  for (const player of state.players) {
    if (player.id === myPid || isPlayerEliminated(player)) continue;
    for (const key of player.walls) {
      const { r, c } = unpackTile(key);
      enemyTargets.push(tileCenterPx(r, c));
    }
  }

  return { enemyCannons, enemyTargets };
}
