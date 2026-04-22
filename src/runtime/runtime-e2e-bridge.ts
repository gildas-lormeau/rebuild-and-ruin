/**
 * E2E test bridge — exposes game internals on `window.__e2e` each frame.
 *
 * Dev-only (guarded by IS_DEV at call site). Provides structured access to
 * game state, render overlay, camera, controllers, and network for Playwright
 * tests. Replaces the old runtime-test-globals.ts.
 */

import { computeLetterboxLayout } from "../render/render-layout.ts";
import type {
  GameEventBus,
  GameEventMap,
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
import type { GameState } from "../shared/core/types.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import {
  buildGrid,
  buildLegend,
  DEFAULT_MAP_LAYER,
  formatGrid,
  inspectTile,
  type MapLayer,
  type TileInspection,
} from "./dev-console-grid.ts";
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
  wallBurns: number;
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
  /** Whether the lobby UI is currently active (mirrors `runtimeState.lobby.active`).
   *  Distinct from `mode === "LOBBY"` — the flag can flip off a frame or two
   *  before the mode transition completes. */
  lobbyActive: boolean;
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
  /** Camera state — observable from tests. Mirrors the handful of
   *  observational methods on `CameraSystem` that tests actually
   *  assert on (zoom target, pitch, viewport presence, auto-zoom flag).
   *  Reset tests verify these match across quit / rematch boundaries;
   *  multi-phase tests can check zoom engagement at specific phases. */
  camera: {
    cameraZone: number | undefined;
    pitch: number;
    pitchState: "flat" | "tilting" | "tilted" | "untilting";
    hasViewport: boolean;
    autoZoomOn: boolean;
  };
  busLog: E2EBusEntry[];
}

/** The full bridge object exposed on window.__e2e. Extends the
 *  serializable snapshot with function fields and mutable flags. */
interface E2EBridge extends E2EBridgeSnapshot {
  worldToClient: (wx: number, wy: number) => { cx: number; cy: number };
  tileToClient: (row: number, col: number) => { cx: number; cy: number };
  /** Serialize the current `GameState` into a JSON-safe snapshot. Returns
   *  null before the state is ready (lobby). Sets/Maps are converted to
   *  arrays; `bus` and `rng` are dropped. */
  gameState: () => SerializedGameState | null;
  /** Text-grid snapshot of the map — identical output to the headless
   *  ASCII renderer (`AsciiRenderer.snapshot()`), produced on demand
   *  from the live `GameState`. Returns null before state is ready.
   *  Accepts a bare `MapLayer` for back-compat or an options object.
   *  Coordinate margins default ON for E2E (so agents can cite tiles
   *  by index without character-counting). */
  asciiSnapshot: (
    opts?: MapLayer | { layer?: MapLayer; coords?: boolean },
  ) => string | null;
  /** Structured read of everything at a single tile — terrain, wall,
   *  tower, cannon, grunt, burning pit, interior ownership, zone.
   *  Returns null before state is ready. Cheaper than rendering the
   *  whole grid and counting characters. */
  tileAt: (row: number, col: number) => TileInspection | null;
  /** Register a capture filter: whenever a bus event of `type` fires whose
   *  payload matches `predicateSrc` (a stringified `(ev) => boolean`, or
   *  `null` to match all events of the type), the bridge attaches a PNG
   *  of the canvas to the resulting busLog entry as `entry.capture`. The
   *  `toDataURL` call happens synchronously inside the bus handler, so
   *  subsequent renders cannot overwrite the capture.
   *
   *  Fires every time the event occurs — this is an event-listener style
   *  registration, not a one-shot promise. Tests read results by walking
   *  busLog (or via `sc.bus.on`) after the scenario runs. Missing captures
   *  appear as entries with no `capture` field, never as infinite hangs. */
  captureOn: (type: string, predicateSrc: string | null) => void;
  /** Enable mobile auto-zoom. E2E tests call this to simulate the
   *  `setupTouchControls` path without actually wiring touch UI, so
   *  the camera's `mobileZoomEnabled` flag flips to true and the
   *  auto-zoom paths become active for assertions. */
  enableMobileZoom: () => void;
}

/** Bridge metadata attached to every recorded bus entry. `_seq` is a
 *  monotonic index across all event types; `capture` is populated for
 *  entries matching a `captureOn` filter. */
export interface E2EEntryMeta {
  _seq: number;
  /** Canvas PNG data-URL, attached when the entry matches a `captureOn`
   *  filter registered via `bridge.captureOn`. */
  capture?: string | null;
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

/** Matches any function (contravariant `never[]` parameters accept all
 *  argument lists). Used to filter methods out of `Serialized<T>`. */
type AnyFn = (...args: never[]) => unknown;

/** Recursive type transformer that mirrors the runtime sanitizer applied to
 *  `GameState` before crossing the Playwright boundary:
 *  - `Set` / `ReadonlySet` become arrays
 *  - `Map` / `ReadonlyMap` become entry-tuple arrays
 *  - functions and class instances with method shapes are dropped
 *    (keys whose value extends `AnyFn` are filtered out)
 *  - plain arrays / objects are walked recursively */
export type Serialized<T> =
  T extends ReadonlyMap<infer K, infer V>
    ? (readonly [K, Serialized<V>])[]
    : T extends ReadonlySet<infer U>
      ? Serialized<U>[]
      : T extends readonly (infer U)[]
        ? Serialized<U>[]
        : T extends AnyFn
          ? never
          : T extends object
            ? {
                [K in keyof T as T[K] extends AnyFn ? never : K]: Serialized<
                  T[K]
                >;
              }
            : T;

/** Serialized `GameState` — the shape returned by `sc.gameState()`. Matches
 *  the in-memory `GameState` field-for-field with Sets/Maps converted to
 *  array forms and the transient service fields (`bus`, `rng`) dropped. */
export type SerializedGameState = Serialized<Omit<GameState, "bus" | "rng">>;

interface E2EBridgeDeps {
  runtimeState: RuntimeState;
  config: Pick<RuntimeConfig, "network">;
  camera: {
    worldToScreen: (wx: number, wy: number) => { sx: number; sy: number };
    getViewport: () => Viewport | undefined;
    getCameraZone: () => number | undefined;
    getPitch: () => number;
    getPitchState: () => "flat" | "tilting" | "tilted" | "untilting";
    isMobileAutoZoom: () => boolean;
    enableMobileZoom: () => void;
  };
  renderer: {
    eventTarget: HTMLElement;
  };
}

interface CaptureFilter {
  readonly type: string;
  readonly predicate: (ev: unknown) => boolean;
}

/** Registered via `bridge.captureOn`. Consumed inside the bus onAny
 *  handler: when a matching event fires, the canvas is captured
 *  synchronously and attached to the busLog entry as `entry.capture`.
 *  Filters persist — they fire for every matching event, not just the
 *  first one. */
const captureFilters: CaptureFilter[] = [];

/** Module-scoped singleton — created on first call, reused across frames.
 *  Holds only shallow snapshots (rebuilt each frame) and coordinate-conversion
 *  closures. No direct GameState references are retained between frames. */
let bridge: E2EBridge | undefined;
/** The bus instance we're currently forwarding into `bridge.busLog`.
 *  Deferred until state is ready. When the game restarts (new bus
 *  instance after a checkpoint hand-off or `page.reload()` scenario),
 *  this pointer changes and `subscribeBus` resubscribes against the
 *  new bus. Undefined means "no subscription yet". */
let subscribedBus: GameEventBus | undefined;

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
      lobbyActive: false,
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
      gameState: () =>
        isStateReady(deps.runtimeState)
          ? serializeGameState(deps.runtimeState.state)
          : null,
      asciiSnapshot: (opts) =>
        isStateReady(deps.runtimeState)
          ? renderAscii(deps.runtimeState.state, opts)
          : null,
      tileAt: (row, col) =>
        isStateReady(deps.runtimeState)
          ? inspectTile(deps.runtimeState.state, row, col)
          : null,
      targeting: { enemyCannons: [], enemyTargets: [] },
      paused: false,
      step: false,
      camera: {
        cameraZone: undefined,
        pitch: 0,
        pitchState: "flat",
        hasViewport: false,
        autoZoomOn: false,
      },
      enableMobileZoom: () => deps.camera.enableMobileZoom(),
      busLog: [],
      captureOn: (type, predicateSrc) => {
        const predicate: (ev: unknown) => boolean = predicateSrc
          ? (new Function("ev", `return (${predicateSrc})(ev);`) as (
              ev: unknown,
            ) => boolean)
          : () => true;
        captureFilters.push({ type, predicate });
      },
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
  updateBridgeSnapshots(ref, deps);
}

function subscribeBus(ref: E2EBridge, deps: E2EBridgeDeps): void {
  if (!isStateReady(deps.runtimeState)) return;
  const bus = deps.runtimeState.state.bus;
  // Re-subscribe when the bus instance changes — new game = new bus.
  // The previous subscription dangles harmlessly (its bus is GC'd with
  // the old game state). busLog is NOT reset — `_seq` keeps growing
  // monotonically so E2E drainBus's `lastSeenSeq` cursor remains valid
  // across games. Agents that want only the current game's events can
  // filter by round / phase fields on the entries.
  if (subscribedBus === bus) return;
  subscribedBus = bus;

  // Capture a PNG synchronously — runs inside the bus handler BEFORE
  // any chained callback can re-render the canvas.
  const captureCanvas = (): string | null => {
    const canvas =
      typeof document !== "undefined"
        ? (document.getElementById("canvas") as HTMLCanvasElement | null)
        : null;
    if (!canvas) return null;
    return canvas.toDataURL("image/png");
  };

  // Record every bus event into busLog. When an event matches a filter
  // registered via `bridge.captureOn`, attach the current canvas as
  // `entry.capture`. The spread carries every payload field from
  // `event`; the `as E2EBusEntry` cast is safe because `type` comes from
  // the typed bus and payload structure is guaranteed by `GameEventMap`.
  bus.onAny((type, event) => {
    const entry = {
      ...(event as Record<string, unknown>),
      type,
      _seq: ref.busLog.length,
    } as E2EBusEntry;

    for (const filter of captureFilters) {
      if (filter.type === type && filter.predicate(event)) {
        entry.capture = captureCanvas();
        break;
      }
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
  ref.lobbyActive = runtimeState.lobby.active;
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

  // --- Camera ---
  ref.camera.cameraZone = deps.camera.getCameraZone();
  ref.camera.pitch = deps.camera.getPitch();
  ref.camera.pitchState = deps.camera.getPitchState();
  ref.camera.hasViewport = deps.camera.getViewport() !== undefined;
  ref.camera.autoZoomOn = deps.camera.isMobileAutoZoom();
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
    wallBurns: battle.wallBurns?.length ?? 0,
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

/** Serialize `GameState` into a JSON-safe snapshot for the E2E bridge.
 *  Matches the shape declared by `SerializedGameState`. */
function serializeGameState(state: GameState): SerializedGameState {
  return JSON.parse(
    JSON.stringify(state, serializeStateReplacer),
  ) as SerializedGameState;
}

/** Render the current `GameState` as an ASCII grid + legend string.
 *  Output matches the headless `AsciiRenderer.snapshot()` format so
 *  agents can copy-paste inspection idioms across APIs. Coordinate
 *  margins default ON here (E2E) and OFF on headless (tests pattern-
 *  match on the raw grid). */
function renderAscii(
  state: GameState,
  opts: MapLayer | { layer?: MapLayer; coords?: boolean } | undefined,
): string {
  const { layer, coords } = normalizeAsciiOpts(opts);
  const grid = buildGrid(state, layer, undefined);
  return formatGrid(grid, buildLegend(state), { coords });
}

function normalizeAsciiOpts(
  opts: MapLayer | { layer?: MapLayer; coords?: boolean } | undefined,
): { layer: MapLayer; coords: boolean } {
  if (opts === undefined) return { layer: DEFAULT_MAP_LAYER, coords: true };
  if (typeof opts === "string") return { layer: opts, coords: true };
  return {
    layer: opts.layer ?? DEFAULT_MAP_LAYER,
    coords: opts.coords ?? true,
  };
}

/** JSON.stringify replacer that converts Sets/Maps to JSON-safe arrays,
 *  drops functions, and drops the transient `bus` and `rng` fields. Kept as
 *  a top-level const so the same function is reused across calls. */
function serializeStateReplacer(key: string, value: unknown): unknown {
  if (key === "bus" || key === "rng") return undefined;
  if (typeof value === "function") return undefined;
  if (value instanceof Set) return Array.from(value);
  if (value instanceof Map) return Array.from(value.entries());
  return value;
}
