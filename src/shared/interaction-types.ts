import type { PlayerSlotId, ValidPlayerSlot } from "./player-slot.ts";
import type { UpgradeId } from "./upgrade-defs.ts";

/** Life-lost types. */
export enum LifeLostChoice {
  PENDING = "pending",
  CONTINUE = "continue",
  ABANDON = "abandon",
}

export type ResolvedChoice = LifeLostChoice.CONTINUE | LifeLostChoice.ABANDON;

export interface LifeLostEntry {
  playerId: ValidPlayerSlot;
  lives: number;
  /** True when this entry auto-resolves (no local human input needed). */
  autoResolve: boolean;
  choice: LifeLostChoice;
  autoTimer: number;
  /** Which button is focused: LIFE_LOST_FOCUS_CONTINUE (0) or LIFE_LOST_FOCUS_ABANDON (1). */
  focusedButton: number;
}

export interface LifeLostDialogState {
  entries: LifeLostEntry[];
  timer: number;
}

export interface UpgradePickEntry {
  playerId: ValidPlayerSlot;
  offers: readonly [UpgradeId, UpgradeId, UpgradeId];
  choice: UpgradeId | null;
  /** True when this entry auto-resolves (no local human input needed). */
  autoResolve: boolean;
  autoTimer: number;
  /** Which offer card is focused (0, 1, or 2). */
  focusedCard: number;
}

export interface UpgradePickDialogState {
  entries: UpgradePickEntry[];
  timer: number;
}

/** Mutable state for the controls-rebinding screen. */
export interface ControlsState {
  playerIdx: number;
  actionIdx: number;
  rebinding: boolean;
}

/** Game-over focus state — which button is highlighted on the game-over screen. */
export type GameOverFocus = "rematch" | "menu";

export interface AutoResolveDeps {
  readonly hostAtFrameStart: boolean;
  readonly myPlayerId: PlayerSlotId;
  readonly remotePlayerSlots: ReadonlySet<number>;
  readonly isHumanController: (playerId: ValidPlayerSlot) => boolean;
}

export interface CastleBuildState {
  wallPlans: readonly CastleWallPlan[];
  maxTiles: number;
  wallTimelineIdx: number;
  accum: number;
}

export interface CastleWallPlan {
  playerId: ValidPlayerSlot;
  /** Ordered wall tiles for castle construction animation.
   *  Encoded as packed tile keys: row * GRID_COLS + col.
   *  Use unpackTile() from spatial.ts to convert to (row, col). */
  tiles: number[];
}

/** Which button is focused in the life-lost dialog. */
export const LIFE_LOST_FOCUS_CONTINUE = 0;
export const LIFE_LOST_FOCUS_ABANDON = 1;
export const FOCUS_REMATCH: GameOverFocus = "rematch";
export const FOCUS_MENU: GameOverFocus = "menu";

export function createControlsState(): ControlsState {
  return { playerIdx: 0, actionIdx: 0, rebinding: false };
}

/** True when this player's dialog entry should auto-resolve (no local input needed).
 *  Host checks controller identity; non-host only resolves its own slot. */
export function shouldAutoResolve(
  playerId: ValidPlayerSlot,
  deps: AutoResolveDeps,
): boolean {
  return deps.hostAtFrameStart
    ? !deps.isHumanController(playerId) && !deps.remotePlayerSlots.has(playerId)
    : playerId !== deps.myPlayerId;
}
