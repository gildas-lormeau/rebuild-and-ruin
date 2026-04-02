/**
 * Pure controller interfaces and types — no runtime imports.
 *
 * Extracted from controller-types.ts so that modules needing only the
 * PlayerController interface don't transitively depend on battle-system.
 *
 * Phase-scoped sub-interfaces let consumers import only the slice they need:
 *   ControllerIdentity  — identity, lifecycle, cursor centering
 *   SelectionController — tower selection phase
 *   BuildController     — wall build phase
 *   CannonController    — cannon placement phase
 *   BattleController    — battle phase
 *   PlayerController    — full intersection (backward-compatible)
 */

import type { PixelPos, TilePos } from "./geometry-types.ts";
import type { PieceShape } from "./pieces.ts";
import type { KeyBindings } from "./player-config.ts";
import { Action, CannonMode, type GameState } from "./types.ts";

/** Orbit animation parameters for AI countdown idle animation. */
export type OrbitParams = {
  rx: number;
  ry: number;
  speed: number;
  phase: number;
};

/** Visual preview of a piece the player is about to place (not yet committed to game state). */
export interface PiecePlacementPreview {
  offsets: [number, number][];
  row: number;
  col: number;
  /** true = placement is legal at this position. */
  valid: boolean;
  playerId: number;
}

/** Visual preview of a cannon the player is about to place (not yet committed to game state). */
export interface CannonPlacementPreview {
  row: number;
  col: number;
  /** true = placement is legal at this position. */
  valid: boolean;
  /** Cannon variant (normal, super, or balloon). */
  mode: CannonMode;
  playerId: number;
}

export interface Crosshair {
  x: number;
  y: number;
  playerId: number;
  cannonReady?: boolean;
}

/** Identity, lifecycle, and cursor centering — the minimal slice every consumer needs. */
export interface ControllerIdentity {
  readonly playerId: number;
  /** Discriminant for isHuman/isAiAnimatable type guards (string union, not enum — only two values). */
  readonly kind: "human" | "ai";

  /** Update key bindings (no-op for AI). */
  updateBindings(keys: KeyBindings): void;

  /** Center cursors/crosshair on a tower position. */
  centerOn(row: number, col: number): void;

  /** Reset stale state after losing a life (before reselection). */
  onLifeLost(): void;

  /** Reset all state for a new game. */
  reset(): void;
}

/** Tower selection phase. */
export interface SelectionController {
  /** Pick a tower. Initiates async selection — use selectionTick() to advance. */
  selectTower(state: GameState, zone: number): void;

  /** Select a new tower after losing a life (castle reselection phase).
   *  Called when the player enters CASTLE_RESELECT phase — they must pick a new
   *  home tower because their previous territory was destroyed.
   *  Not to be confused with selectTower() which is for initial tower selection. */
  reselect(state: GameState, zone: number): void;

  /** Tick during selection phase.
   *  Returns true when the player has confirmed their tower choice (AI auto-confirms
   *  after an animation delay; human always returns false — confirmation is driven by
   *  explicit UI input, not by the tick). */
  selectionTick(dt: number, state?: GameState): boolean;
}

/** Wall build phase. */
export interface BuildController {
  /** Build cursor position. */
  buildCursor: TilePos;

  /** Called once at the start of the build phase. */
  startBuild(state: GameState): void;

  /** Called each frame during build phase. Returns piece placement previews for rendering.
   *  Returns empty array when no preview is active.
   *  NOTE: Returns array (not null) because multiple piece previews can exist simultaneously.
   *  Contrast with cannonTick() which returns null when inactive. */
  buildTick(state: GameState, dt: number): PiecePlacementPreview[];

  /** Called at the end of the build phase. */
  finalizeBuildPhase(state: GameState): void;

  /** Move build cursor one tile in a direction (keyboard). Piece-aware clamping when provided. */
  moveBuildCursor(direction: Action, piece?: PieceShape | null): void;

  /** Set build cursor to absolute position (mouse/touch).
   *  HumanController overrides to offset by the piece pivot so the clicked tile
   *  aligns with the piece's visual center. Piece-aware clamping when provided. */
  setBuildCursor(row: number, col: number, piece?: PieceShape | null): void;

  /** Get the current build piece (for sending placement data). */
  getCurrentPiece(): PieceShape | null;
}

/** Cannon placement phase. */
export interface CannonController {
  /** Cannon cursor position (set by the game at cannon phase start). */
  cannonCursor: TilePos;

  /** Place cannons. AI places all immediately. Human sets up UI. */
  placeCannons(state: GameState, maxSlots: number): void;

  /** Whether the player has placed all their cannons. */
  isCannonPhaseDone(state: GameState, maxSlots: number): boolean;

  /** Called each frame during cannon phase. Returns a placement preview for rendering,
   *  or null if no preview should be shown (player eliminated, no slots remaining).
   *  NOTE: Returns null (not empty array) because at most one cannon preview exists at a time.
   *  Contrast with buildTick() which returns an array (multiple piece previews possible). */
  cannonTick(state: GameState, dt: number): CannonPlacementPreview | null;

  /** Move cannon cursor one tile in a direction (keyboard). */
  moveCannonCursor(direction: Action): void;

  /** Set cannon cursor to absolute position (mouse/touch).
   *  HumanController overrides to offset by half the cannon size so the clicked
   *  tile lands at the placement preview's center. */
  setCannonCursor(row: number, col: number): void;

  /** Called at start of cannon phase. */
  onCannonPhaseStart(state: GameState): void;

  /** Flush any remaining auto-placement queue (cannon timer expired).
   *  Do NOT call directly — use finalizeCannonPhase() which guarantees flush->init order. */
  flushCannons(state: GameState, maxSlots: number): void;

  /** End-of-cannon-phase finalization (flush + init). Use for LOCAL controllers.
   *  Remote controllers only need initCannons() (their client handles flush). */
  finalizeCannonPhase(state: GameState, maxSlots: number): void;

  /** Round-1 safety net: auto-place cannons if none were manually placed. No-op on round 2+. */
  initCannons(state: GameState, maxSlots: number): void;
}

/** Battle phase. */
export interface BattleController {
  /** Called each frame during battle. Uses state.battleCountdown and state.timer to decide behavior. */
  battleTick(state: GameState, dt: number): void;

  /** Fire one cannon at the current crosshair position (public entry point).
   *  Delegates to the protected round-robin method fireNextCannon(). */
  fire(state: GameState): void;

  /** Current crosshair for rendering. */
  getCrosshair(): Crosshair;

  /** Set crosshair to absolute pixel position (mouse). */
  setCrosshair(x: number, y: number): void;

  /** Initialize battle-phase state (cannon rotation index, crosshair position).
   *  Called once at battle start — not a full game reset (see reset() for that).
   *  Scope: resets cannonRotationIdx + centers cursors on home tower. */
  initBattleState(state?: GameState): void;

  /** Called at the end of the battle phase. */
  endBattle(): void;
}

/** Full controller interface — intersection of all phase-scoped sub-interfaces.
 *  Use this when a module genuinely crosses phases (orchestrators, factories).
 *  Prefer the narrower sub-interfaces when only one phase is needed. */
export interface PlayerController
  extends ControllerIdentity,
    SelectionController,
    BuildController,
    CannonController,
    BattleController {}

/** Human input handling — no-op in BaseController, overridden by HumanController. */
export interface InputReceiver {
  /** Match a keyboard key to an action name. Returns null if no match. */
  matchKey(key: string): Action | null;

  /** Register a held key for continuous crosshair movement (battle). */
  handleKeyDown(action: Action): void;

  /** Release a held key (battle). */
  handleKeyUp(action: Action): void;

  /** Rotate the current build piece clockwise. */
  rotatePiece(): void;

  /** Try to place the current build piece at the cursor. */
  tryPlacePiece(state: GameState): boolean;

  /** Try to place a cannon at the cursor. */
  tryPlaceCannon(state: GameState, maxSlots: number): boolean;

  /** Cycle cannon placement mode (normal/super/balloon). */
  cycleCannonMode(state: GameState, maxSlots: number): void;

  /** Current cannon placement mode. */
  getCannonPlaceMode(): CannonMode;
}

/** AI rendering queries — returns null in BaseController, overridden by AiController. */
export interface AiAnimatable {
  /** AI's current crosshair target (null for human — driven by mouse/keyboard). */
  getCrosshairTarget(): PixelPos | null;

  /** AI's orbit parameters for countdown animation (null if not orbiting). */
  getOrbitParams(): OrbitParams | null;
}

/** Battle crosshair movement speed in pixels per second. */
export const CROSSHAIR_SPEED = 80;

/** True if the action is a directional movement. */
export function isMovementAction(action: Action): boolean {
  return (
    action === Action.UP ||
    action === Action.DOWN ||
    action === Action.LEFT ||
    action === Action.RIGHT
  );
}

/** Type guard — true when ctrl is a HumanController (implements InputReceiver).
 *  Overloaded so callers with the full PlayerController get a PlayerController predicate,
 *  while callers with only ControllerIdentity get a narrower predicate. */
export function isHuman(
  ctrl: PlayerController,
): ctrl is PlayerController & InputReceiver;

export function isHuman(
  ctrl: ControllerIdentity,
): ctrl is ControllerIdentity & InputReceiver;

export function isHuman(
  ctrl: ControllerIdentity,
): ctrl is ControllerIdentity & InputReceiver {
  return ctrl.kind === "human";
}

/** Type guard — true when ctrl is an AiController (implements AiAnimatable).
 *  Overloaded so callers with the full PlayerController get a PlayerController predicate,
 *  while callers with only ControllerIdentity get a narrower predicate. */
export function isAiAnimatable(
  ctrl: PlayerController,
): ctrl is PlayerController & AiAnimatable;

export function isAiAnimatable(
  ctrl: ControllerIdentity,
): ctrl is ControllerIdentity & AiAnimatable;

export function isAiAnimatable(
  ctrl: ControllerIdentity,
): ctrl is ControllerIdentity & AiAnimatable {
  return ctrl.kind === "ai";
}
