import type { BurningPit, Cannonball, Grunt } from "./battle-types.ts";
import type { ModifierId } from "./game-constants.ts";
import { Phase } from "./game-phase.ts";
import type { BonusSquare, GameMap } from "./geometry-types.ts";
import type { Player } from "./player-types.ts";
import type { ComboEvent, GameState } from "./types.ts";

/** Narrowed slice of ModernState read by the render layer.
 *  Includes only what overlay builders need — no pending upgrade offers,
 *  masterBuilderOwners, etc. */
interface RenderModernSlice {
  readonly activeModifier: ModifierId | null;
  readonly frozenTiles: ReadonlySet<number> | null;
  readonly sinkholeTiles: ReadonlySet<number> | null;
  readonly masterBuilderLockout: number;
  readonly comboTracker: {
    readonly events: readonly ComboEvent[];
  } | null;
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
  readonly playerZones: readonly number[];
  readonly modern: RenderModernSlice | null;
}

export interface SelectionRenderView extends RenderViewShared {
  readonly phase: Phase.CASTLE_SELECT | Phase.CASTLE_RESELECT;
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
    case Phase.CASTLE_RESELECT:
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
