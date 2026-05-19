import type {
  BurningPit,
  Cannonball,
  CannonMode,
  Grunt,
} from "./battle-types.ts";
import { BATTLE_TIMER, type ModifierId } from "./game-constants.ts";
import { Phase } from "./game-phase.ts";
import type { BonusSquare, GameMap } from "./geometry-types.ts";
import type { TileKey } from "./grid.ts";
import type { SupplyShip } from "./modifier-defs.ts";
import type { ValidPlayerId } from "./player-slot.ts";
import type { Player } from "./player-types.ts";
import type { ComboEvent, GameState } from "./types.ts";
import type { ZoneId } from "./zone-id.ts";

/** Narrowed slice of ModernState read by the render layer.
 *  Includes only what overlay builders need — no pending upgrade offers,
 *  masterBuilderOwners, etc. */
interface RenderModernSlice {
  readonly activeModifier: ModifierId | null;
  /** Tile keys mutated by the active modifier — populated by each
   *  modifier's `apply` and persisted on `state.modern` for the
   *  current MODIFIER_REVEAL window. Read by render-composition to
   *  thread per-modifier "which tiles were affected" into the overlay
   *  (e.g. grunt-surge spawn tiles). */
  readonly activeModifierChangedTiles: readonly TileKey[];
  readonly frozenTiles: ReadonlySet<TileKey> | null;
  /** Low-water exposed riverbed tiles. Renderer paints these as bank
   *  via FLAG_EXPOSED in the tile-data texture. */
  readonly exposedRiverbedTiles: ReadonlySet<TileKey> | null;
  readonly masterBuilderLockout: number;
  readonly comboTracker: {
    readonly events: readonly ComboEvent[];
  } | null;
  /** Pre-removal snapshot for rubble_clearing — read by the overlay
   *  composer to expose held entities to the pit + debris managers
   *  during the modifier reveal fade. */
  readonly rubbleClearingHeld: {
    readonly pits: readonly BurningPit[];
    readonly deadCannons: readonly {
      readonly ownerId: ValidPlayerId;
      readonly col: number;
      readonly row: number;
      readonly mode: CannonMode;
      readonly mortar?: true;
      readonly tier: 1 | 2 | 3;
    }[];
  } | null;
  /** Active supply ships — read by the overlay composer to project
   *  position + heading + hp + sink progress to the 3D ship manager. */
  readonly supplyShips: readonly SupplyShip[] | null;
}

/** Shared fields the renderer reads regardless of phase.
 *  GameState structurally satisfies this — the view is a readonly subset. */
interface RenderViewShared {
  readonly round: number;
  readonly maxRounds: number;
  readonly timer: number;
  readonly players: readonly Player[];
  readonly map: GameMap;
  readonly grunts: readonly Grunt[];
  readonly cannonballs: readonly Cannonball[];
  readonly towerAlive: readonly boolean[];
  readonly burningPits: readonly BurningPit[];
  readonly bonusSquares: readonly BonusSquare[];
  readonly playerZones: readonly ZoneId[];
  readonly modern: RenderModernSlice | null;
}

export interface SelectionRenderView extends RenderViewShared {
  readonly phase: Phase.CASTLE_SELECT;
}

export interface BuildRenderView extends RenderViewShared {
  readonly phase: Phase.WALL_BUILD;
}

export interface CannonRenderView extends RenderViewShared {
  readonly phase: Phase.CANNON_PLACE;
}

export interface BattleRenderView extends RenderViewShared {
  readonly phase: Phase.BATTLE;
}

export interface ModifierRevealRenderView extends RenderViewShared {
  readonly phase: Phase.MODIFIER_REVEAL;
}

export interface UpgradePickRenderView extends RenderViewShared {
  readonly phase: Phase.UPGRADE_PICK;
}

/** Discriminated-union view of GameState for the render layer.
 *  Produced once per frame by `selectRenderView`; passed to overlay
 *  builders (`createOnlineOverlay`, `createStatusBar`) instead of the
 *  full GameState. The `phase` discriminant enables exhaustive
 *  phase-dispatched rendering logic at compile time. */
export type RenderView =
  | SelectionRenderView
  | BuildRenderView
  | CannonRenderView
  | BattleRenderView
  | ModifierRevealRenderView
  | UpgradePickRenderView;

/** Project GameState onto the phase-discriminated RenderView.
 *  Constant-time: the cast is sound because GameState structurally
 *  satisfies every variant (its fields are a superset), and the phase
 *  discriminant is checked at runtime before the cast. */
export function selectRenderView(state: GameState): RenderView {
  switch (state.phase) {
    case Phase.CASTLE_SELECT:
      return state as SelectionRenderView;
    case Phase.WALL_BUILD:
      return state as BuildRenderView;
    case Phase.CANNON_PLACE:
      return state as CannonRenderView;
    case Phase.BATTLE:
      return state as BattleRenderView;
    case Phase.MODIFIER_REVEAL:
      return state as ModifierRevealRenderView;
    case Phase.UPGRADE_PICK:
      return state as UpgradePickRenderView;
  }
}

/** Project GameState onto the sun-arc parameter the 3D renderer expects:
 *  `[0, 1]` as battle progresses (`1 − timer / BATTLE_TIMER`), or `undefined`
 *  in every other phase (which puts the lighting rig back into the
 *  pre-feature "no shadow, full ambient" stance). Accepts a nullable state
 *  so callers don't need to gate on pre-install frames. */
export function sunTFromState(
  state: GameState | null | undefined,
): number | undefined {
  if (!state || state.phase !== Phase.BATTLE) return undefined;
  const elapsed = BATTLE_TIMER - state.timer;
  return Math.min(Math.max(elapsed / BATTLE_TIMER, 0), 1);
}
