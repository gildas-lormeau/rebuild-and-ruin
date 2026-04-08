import { getInterior } from "../shared/board-occupancy.ts";
import { SELECT_TIMER } from "../shared/game-constants.ts";
import { Phase } from "../shared/game-phase.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import { type GameState, type SelectionState } from "../shared/types.ts";
import { selectPlayerTower } from "./game-engine.ts";

export function initTowerSelection(
  state: GameState,
  selectionStates: Map<number, SelectionState>,
  playerId: ValidPlayerSlot,
  zone: number,
): void {
  const player = state.players[playerId]!;
  const towerIdx = player.homeTower
    ? // Identity check (===) is safe: tower refs are stable within a game session.
      // Online mode uses indices for serialization (see online-phase-transitions.ts).
      state.map.towers.findIndex((tower) => tower === player.homeTower)
    : (zoneTowerIndices(state, zone)[0] ?? 0);
  selectionStates.set(playerId, {
    highlighted: towerIdx,
    confirmed: false,
    towerAlreadyHighlighted: true,
  });
  const tower = state.map.towers[towerIdx];
  if (tower) selectPlayerTower(player, tower);
}

/** Highlight a tower for selection. Returns true if the highlight changed. */
export function highlightTowerSelection(
  state: GameState,
  selectionStates: Map<number, SelectionState>,
  idx: number,
  zone: number,
  playerId: ValidPlayerSlot,
): boolean {
  const tower = state.map.towers[idx];
  if (!tower || tower.zone !== zone) return false;

  const selectionState = selectionStates.get(playerId);
  if (!selectionState || selectionState.confirmed) return false;
  if (selectionState.highlighted === idx) return false;
  selectionState.highlighted = idx;

  const player = state.players[playerId]!;
  selectPlayerTower(player, tower);
  return true;
}

/** Confirm a player's tower selection. Returns null if already confirmed,
 *  otherwise returns the confirmed tower index and whether all players are done. */
export function confirmTowerSelection(
  state: GameState,
  selectionStates: Map<number, SelectionState>,
  playerId: ValidPlayerSlot,
  isReselect: boolean,
  onConfirmed?: (row: number, col: number) => void,
): { towerIdx: number; allDone: boolean; isReselect: boolean } | null {
  const selectionState = selectionStates.get(playerId);
  if (!isSelectionPending(selectionState)) return null;
  selectionState.confirmed = true;

  const player = state.players[playerId]!;
  if (player.homeTower) {
    onConfirmed?.(player.homeTower.row, player.homeTower.col);
  }

  return {
    towerIdx: selectionState.highlighted,
    allDone: allSelectionsConfirmed(selectionStates),
    isReselect,
  };
}

export function allSelectionsConfirmed(
  selectionStates: Map<number, SelectionState>,
): boolean {
  for (const [, selectionState] of selectionStates) {
    if (!selectionState.confirmed) return false;
  }
  return true;
}

/** Set the game timer for the selection phase. Keeps timer initialization
 *  inside the game domain instead of runtime directly mutating state.timer. */
export function initSelectionTimer(state: GameState): void {
  state.timer = SELECT_TIMER;
}

/** True when every player with a home tower has non-empty territory (or is eliminated).
 *  Game-rule check used by the selection tick to decide when castle builds are done. */
export function allPlayersHaveTerritory(state: GameState): boolean {
  return state.players.every(
    (player) =>
      !player.homeTower || getInterior(player).size > 0 || player.eliminated,
  );
}

/** Clear selection state if in CASTLE_SELECT phase. Returns true if cleared. */
export function finishSelectionPhase(
  state: GameState,
  selectionStates: Map<number, SelectionState>,
): boolean {
  if (state.phase !== Phase.CASTLE_SELECT) return false;
  selectionStates.clear();
  return true;
}

/** True when a selection exists and is not yet confirmed — the player can still change it. */
function isSelectionPending(
  state: SelectionState | undefined,
): state is SelectionState {
  return state !== undefined && !state.confirmed;
}

function zoneTowerIndices(state: GameState, zone: number): number[] {
  return state.map.towers
    .map((tower, i) => ({ tower, i }))
    .filter(({ tower }) => tower.zone === zone)
    .map(({ i }) => i);
}
