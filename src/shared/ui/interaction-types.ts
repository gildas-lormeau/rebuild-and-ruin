import type { TileKey } from "../core/grid.ts";
import type { PlayerId, ValidPlayerId } from "../core/player-slot.ts";
import type { UpgradeId } from "../core/upgrade-defs.ts";

/** ESC/✕ double-tap-to-quit countdown. Armed = first press waiting for a
 *  confirming second press; otherwise idle. Discriminated so `timer` and
 *  `message` are only reachable while armed. */
export type QuitState =
  | { readonly pending: false }
  | {
      readonly pending: true;
      readonly timer: number;
      readonly message: string;
    };

export enum LifeLostChoice {
  PENDING = "pending",
  CONTINUE = "continue",
  ABANDON = "abandon",
}

export type ResolvedChoice = LifeLostChoice.CONTINUE | LifeLostChoice.ABANDON;

export interface LifeLostEntry {
  playerId: ValidPlayerId;
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
  playerId: ValidPlayerId;
  offers: readonly [UpgradeId, UpgradeId, UpgradeId];
  choice: UpgradeId | null;
  /** True when this entry auto-resolves (no local human input needed). */
  autoResolve: boolean;
  autoTimer: number;
  /** Which offer card is focused (0, 1, or 2). */
  focusedCard: number;
  /** Dialog.timer value when `choice` flipped from null to set — drives the
   *  reveal pulse animation. null while pending. */
  pickedAtTimer: number | null;
}

export interface UpgradePickDialogState {
  entries: UpgradePickEntry[];
  timer: number;
}

/** Mutable state for the controls-rebinding screen. */
export interface ControlsState {
  playerIdx: ValidPlayerId;
  actionIdx: number;
  rebinding: boolean;
}

/** Game-over focus state — which button is highlighted on the game-over screen. */
export type GameOverFocus = "rematch" | "menu";

export interface AutoResolveDeps {
  readonly hostAtFrameStart: boolean;
  readonly myPlayerId: PlayerId;
  readonly remotePlayerSlots: ReadonlySet<ValidPlayerId>;
  /** True if this player's entry waits for local UI input (i.e. should
   *  NOT auto-resolve). Wired from the controller's
   *  `autoResolvesUpgradePick()` / `isHuman()` check depending on the
   *  dialog. */
  readonly needsLocalInput: (playerId: ValidPlayerId) => boolean;
}

export interface CastleBuildState {
  wallPlans: readonly CastleWallPlan[];
  maxTiles: number;
  wallTimelineIdx: number;
  accum: number;
}

export interface CastleWallPlan {
  playerId: ValidPlayerId;
  /** Ordered wall tiles for castle construction animation.
   *  Encoded as packed tile keys: row * GRID_COLS + col.
   *  Use unpackTile() from spatial.ts to convert to (row, col). */
  tiles: TileKey[];
}

/** Which button is focused in the life-lost dialog. */
export const LIFE_LOST_FOCUS_CONTINUE = 0;
export const LIFE_LOST_FOCUS_ABANDON = 1;
export const FOCUS_REMATCH: GameOverFocus = "rematch";
export const FOCUS_MENU: GameOverFocus = "menu";

/** True when this player's dialog entry should auto-resolve (no local input needed).
 *  Host checks controller identity; non-host only resolves its own slot. */
export function shouldAutoResolve(
  playerId: ValidPlayerId,
  deps: AutoResolveDeps,
): boolean {
  return deps.hostAtFrameStart
    ? !deps.needsLocalInput(playerId) && !deps.remotePlayerSlots.has(playerId)
    : playerId !== deps.myPlayerId;
}
