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
import {
  clearRenderSpy,
  enableRenderSpy,
  getRenderSpyLog,
} from "../shared/render-spy.ts";
import { unpackTile } from "../shared/spatial.ts";
import { isHuman } from "../shared/system-interfaces.ts";
import type { GameState } from "../shared/types.ts";
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

  // Render spy — records drawSprite calls per frame (call enableRenderSpy to start)
  enableRenderSpy: () => void;
  renderSpy: { name: string; x: number; y: number }[] | null;

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

let bridge: E2EBridge | undefined;

/** Update the E2E bridge on `window.__e2e` with the current frame's state.
 *  Called once per frame from the main loop (dev-only). */
export function exposeE2EBridge(deps: E2EBridgeDeps): void {
  if (typeof window === "undefined") return;

  const { runtimeState: rs, config } = deps;
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
      targeting: { enemyCannons: [], enemyTargets: [] },
      paused: false,
      step: false,
      network: { messages: [], logLevel: "type" },
    };
    win.__e2e = bridge;
  }
  // --- Pause support ---
  if (bridge.paused) {
    if (bridge.step) {
      bridge.step = false;
      // fall through to update one frame
    } else {
      return; // frozen
    }
  }

  // --- Core ---
  bridge.mode = Mode[rs.mode];
  const ready = isStateReady(rs);
  bridge.phase = ready ? Phase[rs.state.phase] : "";
  bridge.round = ready ? rs.state.round : 0;
  bridge.timer = ready ? rs.state.timer : 0;

  // --- Overlay ---
  bridge.overlay.entities = snapshotEntities(rs);
  bridge.overlay.bannerPrevEntities = snapshotBannerPrevEntities(rs);
  bridge.overlay.phantoms = snapshotPhantoms(rs);
  bridge.overlay.banner = snapshotBanner(rs);
  bridge.overlay.battle = snapshotBattle(rs);
  bridge.overlay.ui = snapshotUI(rs);

  // --- Players ---
  bridge.players = ready ? snapshotPlayers(rs.state) : [];

  // --- Controller ---
  // In local mode getMyPlayerId() returns -1; fall back to slot 0 (first human)
  const myPid = config.getMyPlayerId() >= 0 ? config.getMyPlayerId() : 0;
  bridge.controller = ready ? snapshotController(rs, myPid) : null;

  // --- Camera ---
  bridge.camera.viewport = deps.camera.getViewport();

  // --- Render spy (snapshot then clear for next frame) ---
  const spyLog = getRenderSpyLog();
  bridge.renderSpy = spyLog ? [...spyLog] : null;
  clearRenderSpy();

  // --- Targeting (battle simulation) ---
  if (ready) {
    populateTargeting(bridge, rs.state, myPid);
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

function snapshotEntities(rs: RuntimeState): E2EEntitySnapshot | null {
  const ent = rs.overlay.entities;
  return ent ? entityOverlayToSnapshot(ent) : null;
}

function snapshotBannerPrevEntities(
  rs: RuntimeState,
): E2EEntitySnapshot | null {
  const prev = rs.overlay.ui?.bannerPrevEntities;
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

function snapshotPhantoms(rs: RuntimeState): E2EPhantomSnapshot | null {
  const ph = rs.overlay.phantoms;
  if (!ph) return null;
  return {
    pieces: (ph.piecePhantoms ?? []).map((piece) => ({
      row: piece.row,
      col: piece.col,
      valid: piece.valid,
      playerId: piece.playerId,
    })),
    cannons: (ph.cannonPhantoms ?? []).map((cannon) => ({
      row: cannon.row,
      col: cannon.col,
      valid: cannon.valid,
      mode: String(cannon.mode),
      playerId: cannon.playerId,
    })),
  };
}

function snapshotBanner(rs: RuntimeState): E2EBannerSnapshot | null {
  const banner = rs.overlay.ui?.banner;
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

function snapshotBattle(rs: RuntimeState): E2EBattleSnapshot | null {
  const battle = rs.overlay.battle;
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

function snapshotUI(rs: RuntimeState): E2EUISnapshot {
  const ui = rs.overlay.ui;
  return {
    statusBar: ui?.statusBar
      ? {
          round: ui.statusBar.round,
          phase: ui.statusBar.phase,
          timer: ui.statusBar.timer,
          modifier: ui.statusBar.modifier,
        }
      : null,
    gameOver: ui?.gameOver ? { winner: ui.gameOver.winner } : null,
    lifeLostDialog: ui?.lifeLostDialog
      ? {
          entries: ui.lifeLostDialog.entries.map((en) => ({
            playerId: en.playerId,
            choice: String(en.choice),
          })),
        }
      : null,
    upgradePick: ui?.upgradePick
      ? {
          entries: ui.upgradePick.entries.map((en) => ({
            playerName: en.playerName,
            resolved: en.resolved,
          })),
        }
      : null,
  };
}

function snapshotPlayers(state: GameState): E2EPlayerSnapshot[] {
  return state.players.map((pl) => ({
    id: pl.id,
    score: pl.score,
    lives: pl.lives,
    eliminated: pl.eliminated,
    walls: pl.walls.size,
    cannons: pl.cannons.length,
  }));
}

function snapshotController(
  rs: RuntimeState,
  myPid: number,
): E2EControllerSnapshot | null {
  if (myPid < 0) return null;
  const ctrl = rs.controllers[myPid];
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

/** Populate targeting data for battle simulation (enemy cannons + walls). */
function populateTargeting(
  target: E2EBridge,
  state: GameState,
  myPid: number,
): void {
  const enemies: { x: number; y: number }[] = [];
  for (const player of state.players) {
    if (player.id === myPid || player.eliminated) continue;
    for (const cannon of player.cannons) {
      if (cannon.hp > 0)
        enemies.push({
          x: (cannon.col + 0.5) * TILE_SIZE,
          y: (cannon.row + 0.5) * TILE_SIZE,
        });
    }
  }
  target.targeting.enemyCannons = enemies;

  const targets: { x: number; y: number }[] = [...enemies];
  for (const player of state.players) {
    if (player.id === myPid || player.eliminated) continue;
    for (const key of player.walls) {
      const { r, c } = unpackTile(key);
      targets.push({ x: (c + 0.5) * TILE_SIZE, y: (r + 0.5) * TILE_SIZE });
    }
  }
  target.targeting.enemyTargets = targets;
}
