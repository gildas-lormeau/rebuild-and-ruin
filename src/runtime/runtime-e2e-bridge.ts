/**
 * E2E test bridge — exposes game internals on `window.__e2e` each frame.
 *
 * Dev-only (guarded by IS_DEV at call site). Provides structured access to
 * game state, render overlay, camera, controllers, and network for Playwright
 * tests. Replaces the old runtime-test-globals.ts.
 */

import { computeLetterboxLayout } from "../render/render-layout.ts";
import {
  GAME_EVENT,
  type GameEventMap,
} from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { Viewport } from "../shared/core/geometry-types.ts";
import { TILE_SIZE } from "../shared/core/grid.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import { tileCenterPx, unpackTile } from "../shared/core/spatial.ts";
import {
  type GameViewState,
  isHuman,
} from "../shared/core/system-interfaces.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import { isStateReady, type RuntimeState } from "./runtime-state.ts";
import type { RuntimeConfig } from "./runtime-types.ts";

export interface E2EBannerSnapshot {
  text: string;
  y: number;
  modifierDiff: {
    id: string;
    changedTiles: readonly number[];
    gruntsSpawned: number;
  } | null;
}

export interface E2EBattleSnapshot {
  cannonballs: number;
  impacts: number;
  crosshairs: { x: number; y: number; playerId: number }[];
}

export interface E2EUISnapshot {
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

export interface E2EControllerSnapshot {
  buildCursor: { row: number; col: number } | null;
  cannonCursor: { row: number; col: number } | null;
  cannonMode: string | null;
  crosshair: { x: number; y: number } | null;
}

/** Serializable subset of the bridge — what `state()` returns across
 *  the Playwright boundary (functions stripped by JSON.stringify). */
export interface E2EBridgeSnapshot {
  /** Stringified `Mode` enum key (e.g. "LOBBY", "GAME", "STOPPED"), or "" before
   *  the first frame. Compare with string literals, not the numeric enum value. */
  mode: keyof typeof Mode | "";
  /** `Phase` enum (string-valued), or "" before state is ready. Compare directly
   *  with `Phase.BATTLE` etc. */
  phase: Phase | "";
  round: number;
  timer: number;
  overlay: {
    hasBannerPrevScene: boolean;
    banner: E2EBannerSnapshot | null;
    battle: E2EBattleSnapshot | null;
    ui: E2EUISnapshot;
  };
  controller: E2EControllerSnapshot | null;
  paused: boolean;
  step: boolean;
  targeting: {
    enemyCannons: { x: number; y: number }[];
    enemyTargets: { x: number; y: number }[];
  };
  busLog: E2EBusEntry[];
}

/** The full bridge object exposed on window.__e2e. Extends the
 *  serializable snapshot with function fields and mutable flags. */
interface E2EBridge extends E2EBridgeSnapshot {
  worldToClient: (wx: number, wy: number) => { cx: number; cy: number };
  tileToClient: (row: number, col: number) => { cx: number; cy: number };
  /** When true, the bridge captures a canvas PNG on every non-banner tick
   *  to populate `_prevSnapshot` on the next bannerStart. Opt-in because
   *  `toDataURL` every frame is expensive. Set by E2E tests that need
   *  per-frame pixel data. */
  captureTickSnapshots: boolean;
}

/** Bridge metadata attached to every recorded bus entry. `_seq` is a
 *  monotonic index across all event types; `_canvasSnapshot` is populated
 *  for bannerStart, bannerEnd, and tick events (during banners + one after). */
export interface E2EEntryMeta {
  _seq: number;
  /** Canvas PNG dataURL captured at emission time. */
  _canvasSnapshot?: string | null;
  /** On bannerStart: the previous tick's canvas snapshot (the frame before
   *  the banner appeared). */
  _prevSnapshot?: string | null;
  /** On tick events: the banner sweep Y position (null when no banner). */
  _bannerY?: number | null;
}

/** A bus entry for a specific event type — the full typed payload from
 *  `GameEventMap[K]` plus the bridge's recording metadata. Consumers that
 *  know the event type (e.g. `bus.on("bannerStart", …)`) get full field
 *  typing on `event.text`, `event.phase`, etc. */
export type E2EBusEntryOf<K extends keyof GameEventMap> = GameEventMap[K] &
  E2EEntryMeta;

/** A bus event as recorded by the bridge — union over all known event types.
 *  Each element is narrowable by `entry.type`. */
export type E2EBusEntry = {
  [K in keyof GameEventMap]: E2EBusEntryOf<K>;
}[keyof GameEventMap];

interface E2EBridgeDeps {
  runtimeState: RuntimeState;
  config: Pick<RuntimeConfig, "network">;
  camera: {
    worldToScreen: (wx: number, wy: number) => { sx: number; sy: number };
    getViewport: () => Viewport | undefined;
  };
  renderer: {
    eventTarget: HTMLElement;
  };
}

/** Module-scoped singleton — created on first call, reused across frames.
 *  Holds only shallow snapshots (rebuilt each frame) and coordinate-conversion
 *  closures. No direct GameState references are retained between frames. */
let bridge: E2EBridge | undefined;
/** One-shot: subscribe to all game bus events via `onAny` and forward them
 *  to `bridge.busLog`. Deferred until state is ready (the bus lives on
 *  `runtimeState.state`). Idempotent. */
let busSubscribed = false;

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
        hasBannerPrevScene: false,
        banner: null,
        battle: null,
        ui: {
          statusBar: null,
          gameOver: null,
          lifeLostDialog: null,
          upgradePick: null,
        },
      },
      controller: null,
      worldToClient,
      tileToClient: makeTileToClient(worldToClient),
      targeting: { enemyCannons: [], enemyTargets: [] },
      paused: false,
      step: false,
      busLog: [],
      captureTickSnapshots: false,
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

  subscribeBus(ref, deps);

  // Emit a per-frame tick event so E2E tests can read per-frame data
  // from busLog (with canvas snapshots) instead of wrapping RAF.
  if (isStateReady(deps.runtimeState)) {
    deps.runtimeState.state.bus.emit(GAME_EVENT.TICK, {
      type: GAME_EVENT.TICK,
      dt: deps.runtimeState.frameDt,
    });
  }

  updateBridgeSnapshots(ref, deps);
}

function subscribeBus(ref: E2EBridge, deps: E2EBridgeDeps): void {
  if (busSubscribed || !isStateReady(deps.runtimeState)) return;
  busSubscribed = true;
  const bus = deps.runtimeState.state.bus;

  // Capture a PNG synchronously — runs inside the bus handler
  // BEFORE any chained callback can re-render the canvas.
  const captureCanvas = (): string | null => {
    const canvas =
      typeof document !== "undefined"
        ? (document.getElementById("canvas") as HTMLCanvasElement | null)
        : null;
    if (!canvas) return null;
    return canvas.toDataURL("image/png");
  };

  // Track banner state for tick snapshot gating: only capture canvas
  // snapshots on tick events during banner transitions (+ one frame
  // before and after) to avoid storing thousands of PNGs.
  let bannerActive = false;
  let captureNextTick = false;
  let prevTickSnapshot: string | undefined;

  // Generic: record every bus event into busLog. The spread carries every
  // payload field from `event`; the `as E2EBusEntry` cast is safe because
  // `type` comes from the typed bus and payload structure is guaranteed
  // by `GameEventMap[type]`.
  bus.onAny((type, event) => {
    const entry = {
      ...(event as Record<string, unknown>),
      type,
      _seq: ref.busLog.length,
    } as E2EBusEntry;

    if (entry.type === "bannerStart" || entry.type === "bannerEnd") {
      entry._canvasSnapshot = captureCanvas();
      if (entry.type === "bannerStart") {
        bannerActive = true;
        // Attach the previous tick's snapshot as _prevSnapshot so
        // the test can read the "frame before banner" without storing
        // every tick's PNG.
        entry._prevSnapshot = prevTickSnapshot;
      } else {
        bannerActive = false;
        captureNextTick = true;
      }
    } else if (entry.type === GAME_EVENT.TICK) {
      if (bannerActive || captureNextTick) {
        // During banners + one frame after: capture for the test.
        entry._canvasSnapshot = captureCanvas();
        captureNextTick = false;
      }
      // Keep prevTickSnapshot for the "frame before banner" only when
      // E2E tests opted in via __e2e.captureTickSnapshots = true.
      if (ref.captureTickSnapshots && !bannerActive) {
        prevTickSnapshot = captureCanvas() ?? undefined;
      }
      // Propagate banner y position for mid-sweep detection.
      entry._bannerY = ref.overlay.banner?.y ?? null;
    }

    ref.busLog.push(entry);
  });
}

/** Snapshot all bridge fields from the current frame's runtime state. */
function updateBridgeSnapshots(ref: E2EBridge, deps: E2EBridgeDeps): void {
  const { runtimeState, config } = deps;

  // --- Core ---
  ref.mode = Mode[runtimeState.mode] as keyof typeof Mode;
  const ready = isStateReady(runtimeState);
  ref.phase = ready ? runtimeState.state.phase : "";
  ref.round = ready ? runtimeState.state.round : 0;
  ref.timer = ready ? runtimeState.state.timer : 0;

  // --- Overlay ---
  ref.overlay.hasBannerPrevScene =
    runtimeState.overlay.ui?.bannerPrevScene !== undefined;
  ref.overlay.banner = snapshotBanner(runtimeState);
  ref.overlay.battle = snapshotBattle(runtimeState);
  ref.overlay.ui = snapshotUI(runtimeState);

  // --- Controller ---
  // In local mode myPlayerId() returns -1; fall back to slot 0 (first human)
  const myPid =
    config.network.myPlayerId() >= 0 ? config.network.myPlayerId() : 0;
  ref.controller = ready ? snapshotController(runtimeState, myPid) : null;

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
