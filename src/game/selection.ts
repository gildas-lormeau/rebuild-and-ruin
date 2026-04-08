import { getInterior } from "../shared/board-occupancy.ts";
import { SELECT_TIMER } from "../shared/game-constants.ts";
import {
  isReselectPhase,
  isSelectionPhase,
  Phase,
} from "../shared/game-phase.ts";
import {
  isActivePlayer,
  type PlayerSlotId,
  type ValidPlayerSlot,
} from "../shared/player-slot.ts";
import type {
  ControllerIdentity,
  SelectionController,
} from "../shared/system-interfaces.ts";
import { isRemoteHuman } from "../shared/tick-context.ts";
import { type GameState, type SelectionState } from "../shared/types.ts";
import { selectPlayerTower } from "./game-engine.ts";
import { BANNER_SELECT } from "./phase-banner.ts";

type SelectionCapable = ControllerIdentity & SelectionController;

interface TickSelectionPhaseDeps {
  dt: number;
  state: GameState;
  isHost: boolean;
  myPlayerId: PlayerSlotId;
  /** Mutable — tickSelectionPhase is a blessed mutation site (see MutableAccums in tick-context.ts). */
  accum: { select: number; selectAnnouncement: number };
  selectionStates: Map<number, SelectionState>;
  remoteHumanSlots: ReadonlySet<number>;
  controllers: SelectionCapable[];
  render: () => void;
  confirmSelectionAndStartBuild: (
    playerId: ValidPlayerSlot,
    isReselect?: boolean,
  ) => void;
  allSelectionsConfirmed: () => boolean;
  allBuildsComplete: () => boolean;
  tickActiveBuilds: (dt: number) => void;
  announcementDuration: number;
  setFrameAnnouncement: (text: string) => void;
  finishReselection: () => void;
  finishSelection: () => void;
  syncSelectionOverlay: () => void;
  sendOpponentTowerSelected: (
    playerId: ValidPlayerSlot,
    towerIdx: number,
    confirmed: boolean,
  ) => void;
}

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
  controllers: readonly SelectionCapable[],
  playerId: ValidPlayerSlot,
  isReselect: boolean,
): { towerIdx: number; allDone: boolean; isReselect: boolean } | null {
  const selectionState = selectionStates.get(playerId);
  if (!isSelectionPending(selectionState)) return null;
  selectionState.confirmed = true;

  const player = state.players[playerId]!;
  if (player.homeTower) {
    controllers[playerId]!.centerOn(player.homeTower.row, player.homeTower.col);
  }

  return {
    towerIdx: selectionState.highlighted,
    allDone: allSelectionsConfirmed(selectionStates),
    isReselect,
  };
}

export function tickSelectionPhase(deps: TickSelectionPhaseDeps): void {
  const {
    dt,
    state,
    isHost,
    myPlayerId,
    accum,
    selectionStates,
    remoteHumanSlots,
    controllers,
    render,
    confirmSelectionAndStartBuild,
    allSelectionsConfirmed,
    allBuildsComplete,
    tickActiveBuilds,
    announcementDuration,
    setFrameAnnouncement,
    finishReselection,
    finishSelection,
    syncSelectionOverlay,
    sendOpponentTowerSelected,
  } = deps;

  if (!isSelectionPhase(state.phase)) return;

  // Show announcement before timer starts (first selection only)
  if (accum.selectAnnouncement < announcementDuration) {
    accum.selectAnnouncement += dt;
    setFrameAnnouncement(BANNER_SELECT);
    state.timer = 0;
  } else {
    accum.select += dt;
    state.timer = Math.max(0, SELECT_TIMER - accum.select);
  }
  if (!isHost && !isActivePlayer(myPlayerId)) {
    render();
    return;
  }

  if (!isHost && isActivePlayer(myPlayerId)) {
    if (accum.select >= SELECT_TIMER) {
      confirmSelectionAndStartBuild(myPlayerId, isReselectPhase(state.phase));
    }
    render();
    return;
  }

  // Block all selection (AI + human) until the announcement finishes
  if (accum.selectAnnouncement < announcementDuration) {
    render();
    return;
  }
  // First frame after announcement: sync overlay so human cursor appears immediately
  if (accum.selectAnnouncement - dt < announcementDuration) {
    syncSelectionOverlay();
  }

  const isReselect = isReselectPhase(state.phase);
  for (const [rawPid, selectionState] of selectionStates) {
    const pid = rawPid as ValidPlayerSlot;
    if (selectionState.confirmed) continue;
    if (isRemoteHuman(pid, remoteHumanSlots)) continue;

    const towerBefore = state.players[pid]!.homeTower;
    if (controllers[pid]!.selectionTick(dt, state)) {
      confirmSelectionAndStartBuild(pid, isReselect);
      continue;
    }

    if (state.players[pid]!.homeTower !== towerBefore) {
      const newTower = state.players[pid]!.homeTower;
      if (newTower) {
        selectionState.highlighted = newTower.index;
        syncSelectionOverlay();
        sendOpponentTowerSelected(pid, newTower.index, false);
      }
    }
  }

  // Tick active castle builds during selection
  tickActiveBuilds(dt);

  render();

  if (accum.select >= SELECT_TIMER) {
    // Guard: only pending (unconfirmed) selections get auto-confirmed on timer expiry.
    // Equivalent to isSelectionPending() — uses loop-level check for iteration efficiency.
    for (const [rawPid, selectionState] of selectionStates) {
      if (selectionState.confirmed) continue;
      confirmSelectionAndStartBuild(rawPid as ValidPlayerSlot, isReselect);
    }
  }

  if (allSelectionsConfirmed() && allBuildsComplete()) {
    if (isReselect) finishReselection();
    else finishSelection();
  }
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
