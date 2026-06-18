import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { TowerIdx } from "../shared/core/geometry-types.ts";
import {
  isPlayerEliminated,
  type ValidPlayerId,
} from "../shared/core/player-slot.ts";
import { selectPlayerTower } from "../shared/core/player-types.ts";
import { type GameState, type SelectionState } from "../shared/core/types.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";
import { getInterior } from "../shared/sim/player-interior.ts";

export function initTowerSelection(
  state: GameState,
  selectionStates: Map<ValidPlayerId, SelectionState>,
  playerId: ValidPlayerId,
  zone: ZoneId,
): void {
  const player = state.players[playerId]!;
  const towerIdx = (
    player.homeTower
      ? // Identity check (===) is safe: tower refs are stable within a game session.
        // Online mode uses indices for serialization (see online-phase-transitions.ts).
        state.map.towers.findIndex((tower) => tower === player.homeTower)
      : (zoneTowerIndices(state, zone)[0] ?? 0)
  ) as TowerIdx;
  selectionStates.set(playerId, {
    highlighted: towerIdx,
    confirmed: false,
    towerAlreadyHighlighted: true,
  });
  const tower = state.map.towers[towerIdx];
  if (tower) selectPlayerTower(player, tower);
}

export function highlightTowerSelection(
  state: GameState,
  selectionStates: Map<ValidPlayerId, SelectionState>,
  idx: TowerIdx,
  zone: ZoneId,
  playerId: ValidPlayerId,
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
 *  otherwise returns the confirmed tower index and whether all players are done.
 *  Sets `player.inGracePeriod = true` — round 1's auto-built castle and a
 *  mid-game reselected castle are both freshly built this round, and
 *  downstream consumers (cannon-budget, modifier grace) treat them the
 *  same way. The cycle type (initial vs reselect) is derived from
 *  `state.round > 1` by consumers that care. The flag is cleared in
 *  `finalizeBattle`. */
export function confirmTowerSelection(
  state: GameState,
  selectionStates: Map<ValidPlayerId, SelectionState>,
  playerId: ValidPlayerId,
  onConfirmed?: (row: number, col: number) => void,
): { towerIdx: TowerIdx; allDone: boolean } | null {
  const selectionState = selectionStates.get(playerId);
  if (!isSelectionPending(selectionState)) return null;
  selectionState.confirmed = true;

  const player = state.players[playerId]!;
  player.inGracePeriod = true;
  if (player.homeTower) {
    onConfirmed?.(player.homeTower.row, player.homeTower.col);
    emitGameEvent(state.bus, GAME_EVENT.CASTLE_PLACED, {
      playerId,
      row: player.homeTower.row,
      col: player.homeTower.col,
    });
  }

  return {
    towerIdx: selectionState.highlighted,
    allDone: allSelectionsConfirmed(selectionStates),
  };
}

/** Clear selection state if in CASTLE_SELECT phase. Returns true if cleared. */
export function finishSelectionPhase(
  state: GameState,
  selectionStates: Map<ValidPlayerId, SelectionState>,
): boolean {
  if (state.phase !== Phase.CASTLE_SELECT) return false;
  selectionStates.clear();
  return true;
}

/** True when the selection phase is ready to advance: every player has
 *  confirmed their tower AND every player with a home tower has claimed
 *  territory (castle build animation complete). Callers typically also
 *  check runtime-specific conditions (castle build queue empty). */
export function isSelectionComplete(
  state: GameState,
  selectionStates: Map<ValidPlayerId, SelectionState>,
): boolean {
  return (
    allSelectionsConfirmed(selectionStates) && allPlayersHaveTerritory(state)
  );
}

export function allSelectionsConfirmed(
  selectionStates: Map<ValidPlayerId, SelectionState>,
): boolean {
  for (const [, selectionState] of selectionStates) {
    if (!selectionState.confirmed) return false;
  }
  return true;
}

/** True when every player with a home tower has non-empty territory (or is eliminated).
 *  Game-rule check used by the selection tick to decide when castle builds are done. */
function allPlayersHaveTerritory(state: GameState): boolean {
  return state.players.every(
    (player) =>
      !player.homeTower ||
      getInterior(player).size > 0 ||
      isPlayerEliminated(player),
  );
}

/** True when a selection exists and is not yet confirmed — the player can still change it. */
function isSelectionPending(
  state: SelectionState | undefined,
): state is SelectionState {
  return state !== undefined && !state.confirmed;
}

function zoneTowerIndices(state: GameState, zone: ZoneId): TowerIdx[] {
  return state.map.towers
    .filter((tower) => tower.zone === zone)
    .map((tower) => tower.index);
}
