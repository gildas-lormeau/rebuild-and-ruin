import type { Rng } from "../platform/rng.ts";
import { Action } from "../ui/input-action.ts";
import type {
  LifeLostEntry,
  UpgradePickEntry,
} from "../ui/interaction-types.ts";
import type { KeyBindings } from "../ui/player-config.ts";
import type { AiPersonality } from "./ai-personality.ts";
import {
  type BurningPit,
  type Cannonball,
  CannonMode,
  type CapturedCannon,
  type Crosshair,
  type Grunt,
} from "./battle-types.ts";
import type { GameMode, ModifierId } from "./game-constants.ts";
import type { GameEventBus } from "./game-event-bus.ts";
import type { Phase } from "./game-phase.ts";
import type {
  BonusSquare,
  GameMap,
  PixelPos,
  TilePos,
  WorldPos,
} from "./geometry-types.ts";
import type { TileKey } from "./grid.ts";
import type { SupplyShip } from "./modifier-defs.ts";
import type { CannonPhantom, PiecePhantom } from "./phantom-types.ts";
import type { PieceShape } from "./pieces.ts";
import type { ValidPlayerId } from "./player-slot.ts";
import type { Player } from "./player-types.ts";
import type { UpgradeId } from "./upgrade-defs.ts";
import type { ZoneId } from "./zone-id.ts";

/** Minimal game-state slice used in controller method signatures.
 *  Breaks the coupling chain: consumers of controller interfaces no longer
 *  transitively depend on types.ts (GameState). GameState satisfies this
 *  structurally — no casts needed at call sites.
 *
 *  BIVARIANCE NOTE: Controller implementations declare `state: GameState`
 *  while interfaces declare the per-phase view. TypeScript's method bivariance
 *  allows this. All real call sites pass GameState, so the gap is theoretical.
 *  The views document the actual field contract per phase — not a runtime guard. */
export interface GameViewState {
  readonly phase: Phase;
  /** Monotonic simulation tick.  Universal across phases — used by
   *  scheduled-actions helpers to stamp `applyAt = simTick + safetyTicks`. */
  readonly simTick: number;
  readonly players: readonly Player[];
  readonly map: GameMap;
  readonly bus: GameEventBus;
  /** Grass tiles temporarily blocked by burning pits (3-round duration).
   *  Universal across phases — every phase view reads them for placement /
   *  movement / obstacle checks. */
  readonly burningPits: readonly BurningPit[];
}

/** Build-phase state slice.  10 fields (vs 25 on GameState).
 *  `modern` is an inline structural subset — only `activeModifier`, read by
 *  `effectivePlanTiles` when the AI recomputes the home castle rect.
 *  Mirrors the BattleViewState pattern; keeps BuildViewState free of a
 *  ModernState import. */
export interface BuildViewState extends GameViewState {
  readonly round: number;
  readonly rng: Rng;
  readonly timer: number;
  readonly towerAlive: readonly boolean[];
  readonly bonusSquares: readonly BonusSquare[];
  readonly grunts: readonly Grunt[];
  readonly modern: {
    readonly activeModifier: ModifierId | null;
  } | null;
}

/** Cannon-phase state slice.  8 fields. */
export interface CannonViewState extends GameViewState {
  readonly cannonLimits: readonly number[];
  readonly capturedCannons: readonly CapturedCannon[];
  readonly cannonMaxHp: number;
  readonly gameMode: GameMode;
  /** Per-player slot-cost counter for scheduled-but-not-yet-drained cannon
   *  placements. See `GameState.pendingCannonSlotCost`. Read by
   *  `isCannonPlacementLegal` to avoid double-placement during the
   *  lockstep SAFETY window. */
  readonly pendingCannonSlotCost: readonly number[];
}

/** Upgrade-pick dialog state slice.  5 fields on top of GameViewState.
 *  Used by UpgradePickController.tickUpgradePick and forceUpgradePick —
 *  covers the fields read by the AI decision heuristic (aiPickUpgrade)
 *  plus the rng + round needed for deriving the per-pick private Rng. */
export interface UpgradePickViewState extends GameViewState {
  readonly rng: Rng;
  readonly round: number;
  readonly towerAlive: readonly boolean[];
  readonly grunts: readonly Grunt[];
}

/** Battle-phase state slice.  15 fields.
 *  `modern` is an inline structural subset — only the fields the battle
 *  controller reads (frozenTiles, activeModifier).  Avoids importing
 *  ModernState from types.ts, preserving the coupling break. */
export interface BattleViewState extends GameViewState {
  readonly rng: Rng;
  readonly timer: number;
  readonly battleCountdown: number;
  /** Per-tower alive flags (indexed by `map.towers`). Read by the
   *  aim-occlusion snap so a live tower visually blocks the tile behind it
   *  (dead towers are debris and don't). */
  readonly towerAlive: readonly boolean[];
  readonly grunts: readonly Grunt[];
  readonly cannonballs: readonly Cannonball[];
  readonly cannonMaxHp: number;
  readonly capturedCannons: readonly CapturedCannon[];
  readonly playerZones: readonly ZoneId[];
  /** Cannons whose fire has been scheduled on this peer but not yet
   *  drained. See `GameState.pendingCannonFires`. Read by `canFireOwnCannon`
   *  to avoid double-fire during the lockstep SAFETY window. */
  readonly pendingCannonFires: ReadonlySet<number>;
  readonly modern: {
    readonly frozenTiles: ReadonlySet<TileKey> | null;
    readonly activeModifier: ModifierId | null;
    readonly supplyShips: readonly SupplyShip[] | null;
  } | null;
}

/** Intent to fire a cannon — returned by BattleController.fire() for the orchestrator to execute. */
export interface FireIntent {
  readonly playerId: ValidPlayerId;
  readonly targetRow: number;
  readonly targetCol: number;
}

/** Intent to place a build piece — returned by InputReceiver.tryPlacePiece() for the orchestrator to execute. */
export interface PlacePieceIntent {
  readonly playerId: ValidPlayerId;
  readonly piece: PieceShape;
  readonly row: number;
  readonly col: number;
}

/** Intent to place a cannon — returned by InputReceiver.tryPlaceCannon
 *  for the orchestrator to validate and either apply locally (offline) or
 *  schedule + broadcast (online). Distinct from `CannonPlacedPayload`,
 *  which carries the lockstep `applyAt` stamp added at schedule time. */
export interface PlaceCannonIntent {
  readonly playerId: ValidPlayerId;
  readonly row: number;
  readonly col: number;
  readonly mode: CannonMode;
}

/** Visual preview of a piece the player is about to place (not yet committed to game state). */
export type PiecePlacementPreview = PiecePhantom;

/** Visual preview of a cannon the player is about to place (not yet committed to game state). */
export type CannonPlacementPreview = CannonPhantom;

/** Identity, lifecycle, and cursor centering — the minimal slice every consumer needs. */
export interface ControllerIdentity {
  readonly playerId: ValidPlayerId;
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
interface SelectionController {
  /** Pick a tower for the player's home castle. Used for both the round-1
   *  initial cycle and the round > 1 reselect cycle (after losing a life,
   *  the player picks a new home tower because their previous territory
   *  was destroyed). Initiates async selection — use selectionTick() to
   *  advance. */
  selectTower(state: GameViewState, zone: ZoneId): void;

  /** Tick during selection phase.
   *  Returns true when the player has confirmed their tower choice (AI auto-confirms
   *  after an animation delay; human always returns false — confirmation is driven by
   *  explicit UI input, not by the tick). */
  selectionTick(dt: number, state?: GameViewState): boolean;
}

/** Wall build phase. */
export interface BuildController {
  buildCursor: TilePos;

  /** Controller-owned view of "what piece previews this player wants drawn
   *  right now". For local-controlled slots, populated by `startBuildPhase`
   *  (so the WALL_BUILD banner's B-snapshot captures previews even though
   *  no tick has run yet) and refreshed after every `buildTick`. For
   *  remote-controlled slots, written by the inbound `OPPONENT_PHANTOM`
   *  network handler. Render and network-broadcast paths read from here.
   *  Empty array when the player is eliminated, not ready to place, or has
   *  no active preview. */
  currentBuildPhantoms: readonly PiecePhantom[];

  /** Called once at the start of the build phase. Must populate
   *  `currentBuildPhantoms` after its own init so the banner B-snapshot
   *  renders with previews. */
  startBuildPhase(state: BuildViewState): void;

  /** Called each frame during build phase. Returns piece placement previews for rendering.
   *  Returns empty array when no preview is active. Implementations must
   *  also assign the returned array to `this.currentBuildPhantoms` so the
   *  render path reads the same snapshot between ticks.
   *  NOTE: Returns array (not null) because multiple piece previews can exist simultaneously.
   *  Contrast with cannonTick() which returns null when inactive. */
  buildTick(state: BuildViewState, dt: number): PiecePlacementPreview[];

  finalizeBuildPhase(state: BuildViewState): void;

  /** Move build cursor one tile in a direction (keyboard). Piece-aware clamping via state lookup. */
  moveBuildCursor(state: BuildViewState, direction: Action): void;

  /** Set build cursor to absolute position (mouse/touch).
   *  HumanController overrides to offset by the piece pivot so the clicked tile
   *  aligns with the piece's visual center. Piece-aware clamping via state lookup. */
  setBuildCursor(state: BuildViewState, row: number, col: number): void;

  /** Clamp build cursor so the entire piece stays within the grid. */
  clampBuildCursor(piece: PieceShape | undefined): void;
}

/** Cannon placement phase. */
export interface CannonController {
  /** Cannon cursor position (set by the game at cannon phase start). */
  cannonCursor: TilePos;

  /** Controller-owned view of "what cannon preview this player wants drawn
   *  right now". For local-controlled slots, populated by `startCannonPhase`
   *  (so the CANNON_PLACE banner's B-snapshot captures the preview even
   *  though no tick has run yet) and refreshed after every `cannonTick`.
   *  For remote-controlled slots, written by the inbound
   *  `OPPONENT_CANNON_PHANTOM` network handler. `undefined` when the
   *  player is eliminated, out of slots, or has no active preview. */
  currentCannonPhantom: CannonPhantom | undefined;

  /** Place cannons. Mode selection differs by controller type:
   *  - AI: pre-plans all placements in one batch (super/balloon/normal decided by strategy).
   *  - Human: selects mode interactively; downgradeCannonModeIfNeeded() reverts to NORMAL
   *    each tick if remaining slots can't afford the current mode.
   *  When adding a new cannon mode, update both ai-strategy-cannon.ts and controller-human.ts. */
  placeCannons(state: CannonViewState, maxSlots: number): void;

  /** Whether the player has finished cannon placement. Human: checks remaining
   *  slots. AI: checks internal phase step. Both are correct — they measure
   *  different completion criteria. */
  isCannonPhaseDone(state: CannonViewState, maxSlots: number): boolean;

  /** Called each frame during cannon phase. Returns a placement preview for rendering,
   *  or undefined if no preview should be shown (player eliminated, no slots remaining).
   *  Implementations must also assign the returned value (coerced to
   *  `undefined` if absent) to `this.currentCannonPhantom` so the render
   *  path reads the same snapshot between ticks.
   *  NOTE: Returns `undefined` (not empty array) because at most one cannon preview exists at a time.
   *  Contrast with buildTick() which returns an array (multiple piece previews possible). */
  cannonTick(
    state: CannonViewState,
    dt: number,
  ): CannonPlacementPreview | undefined;

  /** Move cannon cursor one tile in a direction (keyboard). */
  moveCannonCursor(direction: Action): void;

  /** Set cannon cursor from world-pixel coordinates (mouse/touch).
   *  HumanController overrides to center the cannon phantom on the pointer. */
  setCannonCursor(worldX: number, worldY: number): void;

  /** Called at start of cannon phase. Must populate
   *  `currentCannonPhantom` after its own init so the banner B-snapshot
   *  renders with the preview. */
  startCannonPhase(state: CannonViewState): void;

  /** Flush any remaining auto-placement queue (cannon timer expired).
   *  Do NOT call directly — use finalizeCannonPhase() which guarantees flush->init order. */
  flushCannons(state: CannonViewState, maxSlots: number): void;

  /** End-of-cannon-phase finalization (flush + init). Use for LOCAL controllers.
   *  Remote controllers only need initCannons() (their client handles flush). */
  finalizeCannonPhase(state: CannonViewState, maxSlots: number): void;

  /** Round-1 safety net: auto-place cannons if none were manually placed. No-op on round 2+. */
  initCannons(state: CannonViewState, maxSlots: number): void;
}

export interface BattleController {
  /** Round-robin index into combined cannon list. undefined = no cannon fired yet this round.
   *  Written by the orchestrator after executing a FireIntent. */
  cannonRotationIdx: number | undefined;

  /** Called each frame during battle. Uses state.battleCountdown and state.timer to decide behavior. */
  battleTick(state: BattleViewState, dt: number): void;

  /** Compute a fire intent at the current crosshair position.
   *  Returns null if the player can't fire (eliminated, timer, no cannon ready).
   *  The orchestrator executes the actual mutation via fireNextReadyCannon(). */
  fire(state: BattleViewState): FireIntent | null;

  getCrosshair(): Crosshair;

  /** Set crosshair to absolute pixel position (mouse). */
  setCrosshair(x: number, y: number): void;

  /** Resolve a battle-aim input through this controller's occlusion model —
   *  the single seam both a human pointer (`input-dispatch`) and the AI brain
   *  drive, so neither can aim at a tile the battle tilt hides behind a nearer
   *  wall / tower. `x,y` are the controller's native pixels (screen px for a
   *  human pointer, world px for an AI tile-target); the injected `AimResolver`
   *  encapsulates that modality difference. Returns the resolved world
   *  position. HumanController snaps the crosshair onto it immediately;
   *  AiController resolves only (its crosshair glides via stepCrosshairToward). */
  aim(state: BattleViewState, x: number, y: number): WorldPos;

  /** Initialize battle-phase state (cannon rotation index, crosshair position).
   *  Called once at battle start — not a full game reset (see reset() for that).
   *  Scope: resets cannonRotationIdx + centers cursors on home tower. */
  initBattleState(state?: BattleViewState): void;

  endBattle(): void;
}

/** Upgrade-pick dialog resolution (modern mode).
 *
 *  The dialog state (focus, timers, offers) lives on `UpgradePickEntry`;
 *  the controller decides when to commit a pick and which one. The
 *  orchestrator (`runtime/subsystems/upgrade-pick.ts`) iterates entries each tick
 *  and calls `tickUpgradePick` on auto-resolving controllers, falling
 *  back to `forceUpgradePick` at max-timer expiry.
 *
 *  HumanController inherits the default no-op / `false` auto-resolve so
 *  its entry waits for UI input (which commits via the runtime's existing
 *  `resolveAndSend` path). AiController overrides to animate + commit
 *  via `aiPickUpgrade`. AssistedHumanController extends AiController and
 *  broadcasts the committed pick over the wire for protocol testing. */
interface UpgradePickController {
  /** True if this controller's entry auto-resolves (AI-driven commit).
   *  False if it waits for local UI input. Queried at dialog-create time
   *  to populate `UpgradePickEntry.autoResolve`. */
  autoResolvesUpgradePick(): boolean;

  /** Per-frame tick for an auto-resolving entry. Mutates
   *  `entry.autoTimer` / `focusedCard` / `choice` / `pickedAtTimer` in
   *  place. No-op for controllers that return `false` from
   *  `autoResolvesUpgradePick`. */
  tickUpgradePick(
    entry: UpgradePickEntry,
    entryIdx: number,
    autoDelaySeconds: number,
    dialogTimer: number,
    state: UpgradePickViewState,
  ): void;

  /** Max-timer fallback: produce a deterministic commit choice for a
   *  still-pending entry. Must use `state.rng` if randomizing so host
   *  and peer agree. The orchestrator applies the returned UpgradeId to
   *  `entry.choice` / `focusedCard` / `pickedAtTimer`. */
  forceUpgradePick(
    entry: UpgradePickEntry,
    state: UpgradePickViewState,
  ): UpgradeId;
}

/** Life-lost dialog resolution (after failing to enclose a tower).
 *
 *  Parallel to `UpgradePickController`: HumanController waits for UI input,
 *  AiController auto-resolves via `aiChooseLifeLost`, AssistedHumanController
 *  broadcasts the committed choice over the wire for protocol testing.
 *
 *  The dialog state (timer, per-entry autoTimer, focus) lives on
 *  `LifeLostEntry`; the controller decides whether to commit and what to
 *  pick. The orchestrator (`subsystems/life-lost.ts`) iterates entries each
 *  tick and calls `tickLifeLost` on auto-resolving controllers; the
 *  max-timer fallback in `tickLifeLostDialog` picks ABANDON directly. */
interface LifeLostController {
  /** True if this controller's entry auto-resolves (AI-driven commit).
   *  False if it waits for local UI input. Queried at dialog-create time
   *  to populate `LifeLostEntry.autoResolve`. */
  autoResolvesLifeLost(): boolean;

  /** Per-frame tick for an auto-resolving entry. Mutates `entry.autoTimer`
   *  and `entry.choice` in place. No-op for controllers that return `false`
   *  from `autoResolvesLifeLost`. */
  tickLifeLost(
    entry: LifeLostEntry,
    dt: number,
    autoDelaySeconds: number,
    state: GameViewState,
  ): void;
}

/** Full controller interface — intersection of all phase-scoped sub-interfaces.
 *  Use this when a module genuinely crosses phases (orchestrators, factories).
 *  Prefer the narrower sub-interfaces when only one phase is needed. */
export interface PlayerController
  extends ControllerIdentity,
    SelectionController,
    BuildController,
    CannonController,
    BattleController,
    UpgradePickController,
    LifeLostController {}

/** Per-slot controller construction signature. Production wiring uses the
 *  default `createController` (controller-factory.ts); tests inject a custom
 *  factory to install variants like `AiAssistedHumanController` from
 *  bootstrap onward, avoiding mid-game controller swaps that would advance
 *  RNG asymmetrically across host/watcher.
 *
 *  Personality is rolled at bootstrap (drawing from `state.rng` symmetrically
 *  on every peer) and handed to the factory pre-rolled, so the strategy
 *  constructor doesn't draw any RNG. Pure-AI factories then use `sharedRng`
 *  (typically `state.rng`) for runtime decision draws — symmetric across
 *  peers because every peer ticks pure-AI slots in lockstep. AssistedHuman
 *  factories use `privateSeed` to construct a private `new Rng(privateSeed)`
 *  because their animation runs only on the slot-owning peer. Both are
 *  passed to every AI slot regardless of variant so all peers consume
 *  `state.rng` identically at bootstrap. */
export type ControllerFactory = (
  slot: ValidPlayerId,
  isAi: boolean,
  keys: KeyBindings | undefined,
  sharedRng: Rng | undefined,
  privateSeed: number | undefined,
  personality: AiPersonality | undefined,
  humanAimResolver: AimResolver,
) => Promise<PlayerController>;

/** Resolves a controller's raw battle-aim input (native pixels) to the
 *  occluded crosshair world position the aim actually lands on under the
 *  battle tilt — the geometry behind the controller `aim()` seam. Two impls:
 *
 *  - **Human** — camera-backed (`camera.pickHitWorld`): screen px → live-pitch +
 *    overlay-height ray-walk → occluded world. Injected at construction because
 *    it needs the runtime camera (built in `composition.ts`).
 *  - **AI** — sim-only (`occludedAimWorld`): world px → fixed `BATTLE_TILT_PITCH_RAD`
 *    + GameState-height ray-walk → occluded world. Camera-independent so AI aim
 *    stays identical across host / watcher (parity).
 *
 *  Both delegate to the shared `rayWalkOccluder`; only pitch source + height
 *  table differ. The `state` arg is read by the AI resolver and ignored by the
 *  camera-backed human one (the camera captures its own state). */
export type AimResolver = (
  state: BattleViewState,
  x: number,
  y: number,
) => WorldPos;

/** Human input handling — no-op in BaseController, overridden by HumanController. */
export interface InputReceiver {
  /** Match a keyboard key to an action name. Returns null if no match. */
  matchKey(key: string): Action | null;

  /** Register a held key for continuous crosshair movement (battle). */
  handleKeyDown(action: Action): void;

  /** Release a held key (battle). */
  handleKeyUp(action: Action): void;

  /** Set the analog d-pad vector for continuous crosshair aiming (touch
   *  circle pad). Components are expected to be in [-1, 1]; magnitude
   *  ≤ 1 acts as a fractional speed scale. While set, takes precedence
   *  over `heldActions` in the crosshair update — keyboard cardinals
   *  are ignored until `clearDpadVector()` is called. */
  setDpadVector(x: number, y: number): void;

  /** Release the analog d-pad vector (touchend / touchcancel / phase
   *  exit). Crosshair movement falls back to `heldActions`. */
  clearDpadVector(): void;

  /** Rotate the current build piece clockwise. */
  rotatePiece(state: BuildViewState): void;

  /** Compute a place-piece intent at the cursor.
   *  Returns null if placement is invalid. The orchestrator executes the
   *  mutation via placePiece() then calls advancePlayerBag(player, true). */
  tryPlacePiece(state: BuildViewState): PlacePieceIntent | null;

  /** Compute a place-cannon intent at the cursor.
   *  Returns null if the controller has no current placement to commit
   *  (eliminated, no current selection). The orchestrator executes the
   *  mutation via executePlaceCannon(), which also handles validation
   *  (slot budget, occupied tile, etc.) and the eventual `applyAt`
   *  scheduling on the online path. */
  tryPlaceCannon(state: CannonViewState): PlaceCannonIntent | null;

  /** Cycle cannon placement mode (normal/super/balloon). */
  cycleCannonMode(state: CannonViewState, maxSlots: number): void;

  getCannonPlaceMode(): CannonMode;
}

/** AI rendering queries — returns null in BaseController, overridden by AiController. */
export interface AiAnimatable {
  /** AI's current crosshair target (null for human — driven by mouse/keyboard). */
  getCrosshairTarget(): PixelPos | null;
}

/** Reason a haptic call was made — lets the observer (and future debug
 *  overlays) attribute a vibration to the game event that triggered it
 *  instead of just seeing a duration. */
export type HapticReason =
  | "tap"
  | "phaseChange"
  | "wallDestroyed"
  | "cannonDamaged"
  | "cannonDestroyed"
  | "towerKilled";

/** Test observer — receives every vibrate intent BEFORE the platform/level
 *  gate. Tests use this to assert that bus events triggered the right
 *  haptic feedback without needing a real `navigator.vibrate`. Threaded in
 *  via the runtime's `observers` bag from the test scenario; production
 *  callers omit it. */
export interface HapticsObserver {
  vibrate?(reason: HapticReason, ms: number): void;
}
