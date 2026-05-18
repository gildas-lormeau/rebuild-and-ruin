/**
 * Pluggable AiStrategy interface + the value types it produces. The types
 * live here (low-layer) so phase modules and controllers can import the
 * interface without pulling in DefaultStrategy or its implementation tree.
 */

import type { CannonMode } from "../shared/core/battle-types.ts";
import type {
  GameMap,
  PixelPos,
  TilePos,
  Tower,
} from "../shared/core/geometry-types.ts";
import type { PieceShape } from "../shared/core/pieces.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import type {
  BattleViewState,
  BuildViewState,
  CannonPlacementPreview,
  CannonViewState,
  FireIntent,
  GameViewState,
  PiecePlacementPreview,
  PlaceCannonIntent,
  PlacePieceIntent,
} from "../shared/core/system-interfaces.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";
import type { Rng } from "../shared/platform/rng.ts";
import type { AiPlacement, StrategicPixelPos } from "./ai-build-types.ts";
import type { ChainType } from "./ai-chain.ts";

/** A single cannon placement decision returned by the AI strategy. */
export interface CannonPlacement {
  row: number;
  col: number;
  mode: CannonMode;
}

/** Per-frame cannon-phase tick result. `phantom` drives the cursor
 *  preview render; `commit`, when present, is the intent the controller
 *  must hand to its commit transport (executePlaceCannon /
 *  scheduleCannonPlacement). Brain advances its own state machine
 *  immediately after producing the intent — the controller is expected
 *  to commit (or surface a failure) on the same frame. */
export interface CannonTickResult {
  readonly phantom: CannonPlacementPreview | null;
  readonly commit?: PlaceCannonIntent;
}

/** Per-frame build-phase tick result. `phantoms` drives the cursor
 *  preview render; `commit`, when present, is the intent the controller
 *  must hand to its commit transport (executePlacePiece /
 *  schedulePiecePlacement). Brain holds DWELLING state across the commit
 *  and resolves it through `onPlaceResult(success)` — that's how the
 *  blocked-retry semantics (wait for grunt to clear, then retry same
 *  target once before giving up) survive moving the commit out of the
 *  brain. */
export interface BuildTickResult {
  readonly phantoms: PiecePlacementPreview[];
  readonly commit?: PlacePieceIntent;
}

/** Per-frame battle-phase tick result. `commit`, when present, is the
 *  fire intent the controller commits via fireNextReadyCannon /
 *  scheduleCannonFire. Brain holds DWELLING or CHAIN_DWELLING state
 *  across the commit and resolves it through `onFireResult(success)` —
 *  preserves the CANNON_RETRY_WAIT semantics for "no cannon ready yet"
 *  by re-aiming the same crosshair on the next pass. */
export interface BattleTickResult {
  readonly commit?: FireIntent;
}

/** Per-phase placement context — computed once at phase init. Tracks
 *  pre-rolled "try a super / rampart / balloon" decisions so the AI asks
 *  for one placement at a time (on the fly) during the cannon phase's
 *  animation loop, instead of planning the whole batch up-front. */
export interface CannonPlacementContext {
  readonly noiseScale: number;
  readonly towerCenters: readonly TilePos[];
  readonly defensiveness: number;
  /** Each flag is consumed (flipped to false) the first time we attempt
   *  that special placement, success or skip. "Pending" means we still
   *  owe the attempt — `nextCannonPlacement` handles one attempt per call
   *  in priority order: super → rampart → balloon → normal fill. */
  pendingSuperGun: boolean;
  pendingRampart: boolean;
  pendingBalloon: boolean;
}

/** Result of planBattle — tells the controller what chain attack to execute. */
export interface BattlePlan {
  chainTargets: TilePos[] | undefined;
  chainType: ChainType;
}

/** Minimal subset of AiController needed by the selection phase. Phase
 *  modules accept a Host parameter so they can be tested without the full
 *  AiController class. The controller satisfies the union of all four
 *  Host interfaces (static assertion in controller-ai.ts). */
export interface SelectionHost {
  readonly playerId: ValidPlayerId;
  readonly strategy: AiStrategy;
  /** Returns `(base + rng * spread) * delayScale` — humanizes AI timing per difficulty. */
  scaledDelay(base: number, spread: number): number;
}

export interface BuildHost {
  readonly playerId: ValidPlayerId;
  readonly strategy: AiStrategy;
  buildCursor: TilePos;
  readonly buildCursorSpeed: number;
  readonly boostThreshold: number;
  scaledDelay(base: number, spread: number): number;
  clampBuildCursor(piece: PieceShape | undefined): void;
  stepTileCursorToward(
    cursor: TilePos,
    targetRow: number,
    targetCol: number,
    baseSpeed: number,
    boostThreshold: number,
  ): boolean;
}

export interface CannonHost {
  readonly playerId: ValidPlayerId;
  readonly strategy: AiStrategy;
  cannonCursor: TilePos;
  readonly cannonCursorSpeed: number;
  readonly boostThreshold: number;
  scaledDelay(base: number, spread: number): number;
  stepTileCursorToward(
    cursor: TilePos,
    targetRow: number,
    targetCol: number,
    baseSpeed: number,
    boostThreshold: number,
  ): boolean;
}

export interface BattleHost {
  readonly playerId: ValidPlayerId;
  readonly strategy: AiStrategy;
  crosshair: { x: number; y: number };
  readonly cannonRotationIdx: number | undefined;
  readonly anticipatesTarget: boolean;
  scaledDelay(base: number, spread: number): number;
  stepCrosshairToward(tx: number, ty: number): boolean;
  fire(state: BattleViewState): FireIntent | null;
}

export interface AiStrategy {
  /** Seeded PRNG for reproducible AI behavior. */
  readonly rng: Rng;

  /** Pick a home tower for the AI player. Returns the chosen tower or null. */
  chooseBestTower(map: GameMap, zone: ZoneId): Tower | null;

  /** Pick the best placement for the current piece. */
  pickPlacement(
    state: BuildViewState,
    playerId: ValidPlayerId,
    piece: PieceShape,
    cursorPos?: TilePos,
  ): AiPlacement | null;

  /** Called at the end of the build phase — assess home tower status. */
  assessBuildEnd(state: GameViewState, playerId: ValidPlayerId): void;

  /** Initialize per-phase cannon-placement context — pre-rolls the
   *  probabilistic super/rampart/balloon decisions so subsequent
   *  per-cannon queries are deterministic. Called once at phase start. */
  initCannonPhase(
    player: Player,
    count: number,
    state: CannonViewState,
  ): CannonPlacementContext;

  /** Decide the next single cannon placement. Returns `undefined` when
   *  the AI has run out of slots or legal positions. Called each time
   *  the animation loop is ready for the next placement. */
  nextCannonPlacement(
    player: Player,
    count: number,
    state: CannonViewState,
    ctx: CannonPlacementContext,
  ): CannonPlacement | undefined;

  /** Plan the battle: pick focus target, decide chain attacks. */
  planBattle(state: BattleViewState, playerId: ValidPlayerId): BattlePlan;

  /** Pick a target to fire at. strategic = wall between obstacles. wallsOnly = skip cannon targets. */
  pickTarget(
    state: BattleViewState,
    playerId: ValidPlayerId,
    crosshair: PixelPos,
    wallsOnly?: boolean,
  ): StrategicPixelPos | null;

  /** Record a shot at whatever cannon is at the crosshair position. */
  trackShot(
    state: BattleViewState,
    playerId: ValidPlayerId,
    crosshair: PixelPos,
  ): void;

  /** Reset stale state after losing a life. */
  onLifeLost(): void;

  /** Reset all state for a new game. */
  reset(): void;

  /** When true, castle rects hug the river bank and seal diagonal leaks with
   *  interior plug walls.  When false (default), rects shrink away from bank
   *  corners for a tighter ring with fewer gaps to fill. */
  bankHugging: boolean;

  /** Thinking speed 1–3.  Multiplier on dwell/think delays.
   *  1 = slow and deliberate, 3 = snappy reactions. */
  thinkingSpeed: 1 | 2 | 3;

  /** Cursor control skill 1–3.  Affects 2× speed-boost threshold
   *  and ability to pre-pick the next target while firing.
   *  1 = clumsy cursor, 3 = fluid aim. */
  cursorSkill: 1 | 2 | 3;
}
