/**
 * Last-resort interior discard for the desperate case (no enclosed alive
 * tower → life-loss imminent) AFTER every exterior placement path returned
 * null. Mirrors a human's reflex of throwing the current piece inside a
 * closed area to advance the bag, hoping the NEXT piece can close an
 * unenclosed alive tower's ring. Gated by `hasFillableTowerHope` so the
 * discard isn't pure cope. Uses `piecesInRoundPool` (info-symmetric).
 */

import { canPlacePiece, type PlacementContext } from "../game/index.ts";
import type { OccupancyCache } from "../shared/core/board-occupancy.ts";
import type { TilePos, Tower } from "../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, type TileKey } from "../shared/core/grid.ts";
import {
  type PieceShape,
  piecesInRoundPool,
  rotateCW,
} from "../shared/core/pieces.ts";
import { getInterior } from "../shared/core/player-interior.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import { manhattanDistance, packTile } from "../shared/core/spatial.ts";
import type { BuildViewState } from "../shared/core/system-interfaces.ts";
import { poolFillableTowerRing } from "./ai-build-target.ts";
import type { AiPlacement } from "./ai-build-types.ts";

/** True iff some piece in the round's pool can fill some unenclosed alive
 *  tower's ring (≤MANAGEABLE_GAP_LIMIT gaps). Used to gate the desperate
 *  interior discard — without hope, the discard just wastes a wall tile
 *  inside the closed area for no future payoff. Mirrors the rotation/gap
 *  check in `computePeekFitTargets` but uses every alive unenclosed tower
 *  (including the active target) since the trigger fires AFTER the active
 *  target's gap-filling enumeration already failed. */
export function hasFillableTowerHope(
  state: BuildViewState,
  playerId: ValidPlayerId,
  player: Player,
  unenclosedAliveTowers: readonly Tower[],
  castleMargin: number,
  bankHugging: boolean,
  cache: OccupancyCache,
  placementCtx: PlacementContext,
): boolean {
  const bag = player.bag;
  if (!bag) return false;
  const poolPieces = piecesInRoundPool(bag.round, bag.smallPieces);
  if (poolPieces.length === 0) return false;
  const interior = getInterior(player);
  for (const tower of unenclosedAliveTowers) {
    if (
      poolFillableTowerRing(
        tower,
        state,
        player,
        interior,
        castleMargin,
        bankHugging,
        poolPieces,
        playerId,
        cache,
        placementCtx,
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Find a placement whose every tile lands inside the player's own
 *  flooded interior (i.e. inside a closed enclosure — flood-fill from
 *  edges can't reach there). Closest-to-cursor wins. Returns null when
 *  no rotation has all offsets inside the interior, or when `canPlacePiece`
 *  rejects every interior candidate (entities, modifier flooding, etc.).
 *  No `excludeInterior` passed to `canPlacePiece` — closed-area tiles
 *  are legal placement targets at the game-rules layer (only the AI's
 *  enumeration excludes them by default).
 *
 *  `accept`, when supplied, filters candidate placements (e.g. the expansion
 *  clean-cycle passes a "creates no 2×2 fat block" predicate so the discard
 *  doesn't relocate the fat-wall pathology inside the territory). A candidate
 *  failing `accept` is skipped entirely; the function returns null if every
 *  interior placement is rejected by it. */
export function pickDesperateInteriorDiscard(
  state: BuildViewState,
  playerId: ValidPlayerId,
  piece: PieceShape,
  player: Player,
  cursorPos: TilePos | undefined,
  cache: OccupancyCache,
  placementCtx: PlacementContext,
  accept?: (shape: PieceShape, row: number, col: number) => boolean,
): AiPlacement | null {
  const interior = getInterior(player);
  if (interior.size === 0) return null;
  let best: AiPlacement | undefined = undefined;
  let bestDistance = Infinity;
  let rotated = piece;
  for (let rotation = 0; rotation < 4; rotation++) {
    for (let r = 0; r < GRID_ROWS - rotated.height + 1; r++) {
      for (let c = 0; c < GRID_COLS - rotated.width + 1; c++) {
        if (!allOffsetsInInterior(rotated.offsets, r, c, interior)) continue;
        if (
          !canPlacePiece(
            state,
            playerId,
            rotated.offsets,
            r,
            c,
            undefined,
            cache,
            placementCtx,
          )
        ) {
          continue;
        }
        if (accept && !accept(rotated, r, c)) continue;
        const distance = cursorPos
          ? manhattanDistance(r, c, cursorPos.row, cursorPos.col)
          : 0;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { piece: rotated, row: r, col: c };
        }
      }
    }
    rotated = rotateCW(rotated);
  }
  return best ?? null;
}

function allOffsetsInInterior(
  offsets: ReadonlyArray<readonly [number, number]>,
  row: number,
  col: number,
  interior: ReadonlySet<TileKey>,
): boolean {
  for (const [dr, dc] of offsets) {
    if (!interior.has(packTile(row + dr, col + dc))) return false;
  }
  return true;
}
