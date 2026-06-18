import type { TileKey } from "../core/grid.ts";
import type { ValidPlayerId } from "../core/player-slot.ts";
import type { Mode } from "./ui-mode.ts";

/** Where the options screen was opened from. Drives editable-vs-read-only
 *  behavior across the settings UI and determines what mode to restore on
 *  close. `returnMode` is only reachable when opened during gameplay. */
export type OptionsContext =
  | { readonly kind: "lobby" }
  | { readonly kind: "gameplay"; readonly returnMode: Mode };

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

/** Mutable state for the controls-rebinding screen. */
export interface ControlsState {
  playerIdx: ValidPlayerId;
  actionIdx: number;
  rebinding: boolean;
}

/** Game-over focus state — which button is highlighted on the game-over screen. */
export type GameOverFocus = "rematch" | "menu";

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

export const FOCUS_REMATCH: GameOverFocus = "rematch";
export const FOCUS_MENU: GameOverFocus = "menu";
