/**
 * Pluggable AiStrategy interface + the value types it produces. The types
 * live here (low-layer) so phase modules and controllers can import the
 * interface without pulling in DefaultStrategy or its implementation tree.
 */

import type { ArchetypeId } from "../shared/core/ai-personality.ts";
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
  BattleController,
  BattleViewState,
  BuildController,
  BuildViewState,
  CannonController,
  CannonPlacementPreview,
  CannonViewState,
  ControllerIdentity,
  FireIntent,
  PiecePlacementPreview,
  PlaceCannonIntent,
  PlacePieceIntent,
} from "../shared/core/system-interfaces.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";
import type { Rng } from "../shared/platform/rng.ts";
import type { FireOrigin, PickPath } from "./ai-battle-diag.ts";
import type { AiPlacement } from "./ai-build-types.ts";
import type { ChainType, TacticId } from "./ai-chain.ts";

/** Pixel position annotated with strategic flag (AI targeting). `pickPath`
 *  is diag-only provenance (which `pickTarget` sub-branch produced it) —
 *  read by the fire-decision diag, never affects behavior. */
export type StrategicPixelPos = PixelPos & {
  strategic?: boolean;
  pickPath?: PickPath;
};

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
  /** Which planner / fallback produced `commit`'s target — fed to the
   *  battle-diag hook so observers can tag each fire with its provenance.
   *  Undefined iff `commit` is undefined. */
  readonly origin?: FireOrigin;
  /** Diag-only: the `pickTarget` sub-branch for a standard (non-chain) fire.
   *  Undefined for chain shots and when no commit. */
  readonly pickPath?: PickPath;
  /** Diag-only: the tile the planner actually wanted to hit, BEFORE aim
   *  occlusion redirected it. When a camera-near wall hides the target, this
   *  differs from `commit`'s tile (which snapped onto the occluder). Lets the
   *  battle-diag distinguish "aimed where intended" from "occlusion redirected
   *  onto a wall". Undefined when no commit. */
  readonly intendedTarget?: TilePos;
}

/** Per-phase placement context — computed once at phase init. Tracks
 *  pre-rolled "try a super / rampart / balloon" decisions so the AI asks
 *  for one placement at a time (on the fly) during the cannon phase's
 *  animation loop, instead of planning the whole batch up-front. */
export interface CannonPlacementContext {
  readonly noiseScale: number;
  readonly towerCenters: readonly TilePos[];
  readonly defensiveness: number;
  /** Multiplier on the corridor (enclosure-clearance) penalty, derived from
   *  spatialAwareness: low-awareness AIs barely perceive self-boxing and will
   *  seal cannons into unrepairable corridors; high-awareness AIs avoid it. */
  readonly corridorScale: number;
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
  /** Observability-only override for the diag FireOrigin tag, set when a
   *  plan collapses into a shared chainType (charity → CHAIN.GRUNT,
   *  super_attack → CHAIN.WALL) but battle-metrics want the precise origin.
   *  Falls back to CHAIN_TO_ORIGIN[chainType] when undefined. Does not affect
   *  AI behavior — only the emitted fire-decision diag. */
  originTag?: FireOrigin;
  /** The granular tactic that produced this plan (finer than chainType).
   *  Undefined when no chain was selected. The battle phase machine adds
   *  offensive tactics to its per-battle exclusion set so successive re-plans
   *  vary the attack. */
  tacticId?: TacticId;
}

/** Minimal subset of AiController needed by the selection phase. Phase
 *  modules accept a Host parameter so they can be tested without the full
 *  AiController class. The controller satisfies the union of all four
 *  Host interfaces (static assertion in controller-ai.ts). */
// The brain now owns its `strategy` (held on each phase object) and reads
// timing/movement tuning off it directly, so the Hosts no longer carry
// strategy or the trait getters. What remains is what only the controller can
// provide: cursor/crosshair state, the cursor steppers (which mutate that
// state), and the commit seam (aim/fire). The shared members are pulled in via
// `Pick<…>` of the controller interfaces so a controller-side signature change
// can't silently drift from the Host the brain depends on.
export type SelectionHost = Pick<ControllerIdentity, "playerId">;

/** Shared shape behind BuildHost + CannonHost: both phases step a tile cursor
 *  one axis at a time. Only the cursor field (+ clamp, for build) differs. */
interface TileCursorHost extends Pick<ControllerIdentity, "playerId"> {
  stepTileCursorToward(
    cursor: TilePos,
    targetRow: number,
    targetCol: number,
    baseSpeed: number,
    boostThreshold: number,
  ): boolean;
}

export type BuildHost = TileCursorHost &
  Pick<BuildController, "buildCursor" | "clampBuildCursor">;

export type CannonHost = TileCursorHost &
  Pick<CannonController, "cannonCursor">;

export interface BattleHost
  extends Pick<ControllerIdentity, "playerId">,
    Pick<BattleController, "aim" | "fire"> {
  crosshair: PixelPos;
  stepCrosshairToward(tx: PixelPos["x"], ty: PixelPos["y"]): boolean;
}

export interface AiStrategy {
  /** Seeded PRNG for reproducible AI behavior. */
  readonly rng: Rng;

  /** This AI's rolled personality archetype — read by diagnostics/metrics to
   *  segment results by play style (the trait ranges are intentionally uneven
   *  per archetype, so a pool mean blends distinct skill tiers). */
  readonly archetype: ArchetypeId;

  /** Current focus-fire target — set by `planBattle` at battle start when
   *  the FOCUS_FIRE_PROBABILITY roll succeeds, cleared otherwise. Read by
   *  the diag-emit path to tag a non-chain fire as `focus_fire` (vs the
   *  unfocused `default`). */
  readonly focusFirePlayerId: ValidPlayerId | undefined;

  // ── Trait-derived timing/movement tuning. Pure functions of the rolled
  //    personality traits (+ rng for scaledDelay). The brain reads these
  //    instead of reaching back through the controller, and the controller's
  //    cursor mechanics read battleBoostDist for the same source of truth. ──

  /** Humanize AI timing — returns an integer tick count. Derived from
   *  thinkingSpeed (delay scale) plus an rng jitter over [base, base+spread]. */
  scaledDelay(base: number, spread: number): number;
  /** Tile-cursor boost-distance threshold (tiles), derived from cursorSkill —
   *  below it the cursor moves at 1× instead of 2×. */
  readonly boostThreshold: number;
  /** Whether the AI keeps aiming while every cannon reloads (cursorSkill ≥ 2). */
  readonly anticipatesTarget: boolean;
  /** Battle crosshair boost-distance threshold (px), derived from cursorSkill
   *  (skill 1 = never boosts → Infinity; 2/3 = always → 0). */
  readonly battleBoostDist: number;

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
  assessBuildEnd(state: BuildViewState, playerId: ValidPlayerId): void;

  /** Initialize per-phase cannon-placement context — pre-rolls the
   *  probabilistic super/rampart/balloon decisions so subsequent
   *  per-cannon queries are deterministic. Called once at phase start. */
  initCannonPhase(player: Player, count: number): CannonPlacementContext;

  /** Decide the next single cannon placement. Returns `undefined` when
   *  the AI has run out of slots or legal positions. Called each time
   *  the animation loop is ready for the next placement. */
  nextCannonPlacement(
    player: Player,
    count: number,
    state: CannonViewState,
    ctx: CannonPlacementContext,
  ): CannonPlacement | undefined;

  /** Plan one chain attack. Called at battle entry and again each time a chain
   *  finishes (multiple attacks per battle). The entry call OMITS
   *  `replanExcludedTactics` — that's what (re-)rolls focus-fire. Re-plans
   *  always pass the set of offensive tactics already fired this battle so
   *  the cascade skips them (force variety); the set may legitimately be
   *  empty (defensive-only chains aren't recorded), which must NOT re-roll
   *  focus. */
  planBattle(
    state: BattleViewState,
    playerId: ValidPlayerId,
    replanExcludedTactics?: ReadonlySet<TacticId>,
  ): BattlePlan;

  /** Pick a target to fire at. strategic = wall between obstacles. */
  pickTarget(
    state: BattleViewState,
    playerId: ValidPlayerId,
    crosshair: PixelPos,
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
