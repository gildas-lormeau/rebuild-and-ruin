/**
 * Per-component / per-action deps shapes that input/ handler factories
 * (keyboard, mouse, touch UI) take. Lives in shared/ui so runtime/ and
 * input/ can both reference them without a cross-domain dependency.
 */

import type { TowerIdx, WorldPos } from "../core/geometry-types.ts";
import type { ValidPlayerId } from "../core/player-slot.ts";
import type {
  BattleViewState,
  BuildViewState,
  CannonViewState,
  InputReceiver,
  PlayerController,
} from "../core/system-interfaces.ts";
import type { GameState, SelectionState } from "../core/types.ts";
import type { ZoneId } from "../core/zone-id.ts";
import type { Action } from "./input-action.ts";
import type { QuitState } from "./interaction-types.ts";
import type { Mode } from "./ui-mode.ts";

/** Run `action` with the pointer (local human) controller. Returns `true`
 *  if it actually ran, `false` when there is no human to receive the input
 *  (all-AI, demo, online-watcher). Ignore the return value to preserve the
 *  legacy silent-no-op behavior; inspect it to surface a diagnostic.
 *
 *  lint:allow-callback-inversion -- dispatcher: action runs at the caller's
 *  identity; receiver only guards on whether a pointer player exists. */
export type WithPointerPlayer = (
  action: (human: PlayerController & InputReceiver) => void,
) => boolean;

export interface GameActionDeps {
  getSelectionStates: () => Map<ValidPlayerId, SelectionState>;
  highlightTowerForPlayer: (
    idx: TowerIdx,
    zone: ZoneId,
    pid: ValidPlayerId,
  ) => void;
  confirmSelectionAndStartBuild: (pid: ValidPlayerId) => boolean;
  tryPlacePiece: (
    ctrl: PlayerController & InputReceiver,
    state: BuildViewState,
  ) => boolean;
  tryPlaceCannon: (
    ctrl: PlayerController & InputReceiver,
    state: CannonViewState,
    max: number,
  ) => boolean;
  onPieceRotated?: () => void;
  onPiecePlaced?: () => void;
  onCannonPlaced?: () => void;
  fire: (ctrl: PlayerController, state: BattleViewState) => void;
}

export interface PointerMoveDeps {
  withPointerPlayer: WithPointerPlayer;
  coords: {
    screenToWorld: (x: number, y: number) => WorldPos;
    pickHitWorld: (x: number, y: number) => WorldPos;
    pixelToTile: (x: number, y: number) => { row: number; col: number };
  };
  gameAction: Pick<
    GameActionDeps,
    "getSelectionStates" | "highlightTowerForPlayer"
  >;
  maybeSendAimUpdate: (x: number, y: number) => void;
}

export interface OverlayActionDeps {
  options?: {
    isActive: () => boolean;
    moveCursor: (dir: -1 | 1) => void;
    changeValue: (dir: -1 | 1) => void;
    confirm: () => void;
  };
  /** Centralized per-player dialog action (life-lost, upgrade pick).
   *  The caller resolves the playerId upstream (pointer player for touch,
   *  matched controller for keyboard). Returns true if consumed. */
  dialogAction?: (action: Action) => boolean;
  gameOver?: {
    isActive: () => boolean;
    toggleFocus: () => void;
    confirm: () => void;
  };
}

export interface DpadDeps {
  getState: () => GameState | undefined;
  getMode: () => Mode;
  withPointerPlayer: WithPointerPlayer;
  /** Emit a `uiTap` bus event so the haptics subsystem (and any future
   *  feedback subsystem) can react to the user tapping a d-pad button
   *  without the d-pad importing those subsystems directly. No-op when
   *  game state isn't ready (lobby pre-state). */
  emitUiTap?: () => void;
  isHost: () => boolean;
  /** Join P1 in lobby (or skip if already joined). */
  lobbyAction: () => void;
  getLeftHanded: () => boolean;
  /** Shared game action deps (selection, placement, battle). */
  gameAction: GameActionDeps;
  /** Shared overlay action deps (options, life-lost, game-over). */
  overlay: OverlayActionDeps;
}

export interface FloatingActionsDeps {
  getState: () => GameState | undefined;
  getMode: () => Mode;
  withPointerPlayer: WithPointerPlayer;
  tryPlacePiece: (
    human: PlayerController & InputReceiver,
    state: BuildViewState,
  ) => boolean;
  tryPlaceCannon: (
    human: PlayerController & InputReceiver,
    state: CannonViewState,
    max: number,
  ) => boolean;
  onPieceRotated?: () => void;
  /** Emit a `uiTap` bus event — see `DpadDeps.emitUiTap`. */
  emitUiTap?: () => void;
  /** Forward a drag touch to the canvas pointer-move logic. */
  onDrag?: (clientX: number, clientY: number) => void;
}

export interface ZoomButtonDeps {
  getState: () => GameState | undefined;
  /** The zone the user is visually looking at right now — explicit zone
   *  target, or the zone at a pinch viewport center, or undefined when
   *  the camera is on full map / over a river. Used to base the cycle's
   *  "next zone" preview on the actually-visible zone. */
  getViewedZone: () => ZoneId | undefined;
  setCameraZone: (zone: ZoneId) => void;
  povPlayerId: () => number;
  getEnemyZones: () => ZoneId[];
  /** Move the human crosshair to a zone's home tower (battle auto-zoom). */
  aimAtZone?: (zone: ZoneId) => void;
}

export interface QuitButtonDeps {
  getQuit: () => QuitState;
  setQuit: (quit: QuitState) => void;
  showLobby: () => void;
  getControllers: () => PlayerController[];
  isHuman: (ctrl: PlayerController) => boolean;
}
