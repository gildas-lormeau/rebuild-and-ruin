import { MESSAGE } from "../server/protocol.ts";
import type {
  ControllerIdentity,
  SelectionController,
} from "./controller-interfaces.ts";
import { selectPlayerTower } from "./game-engine.ts";
import { BANNER_SELECT } from "./phase-banner.ts";
import {
  type GameState,
  isReselectPhase,
  isSelectionPhase,
  Phase,
  type SelectionState,
} from "./types.ts";

type SelectionCapable = ControllerIdentity & SelectionController;

interface TickSelectionPhaseDeps {
  dt: number;
  state: GameState;
  isHost: boolean;
  myPlayerId: number;
  selectTimer: number;
  /** Mutable — tickSelectionPhase is a blessed mutation site (see MutableAccums in tick-context.ts). */
  accum: { select: number; selectAnnouncement: number };
  selectionStates: Map<number, SelectionState>;
  remoteHumanSlots: ReadonlySet<number>;
  controllers: SelectionCapable[];
  render: () => void;
  confirmSelectionAndStartBuild: (
    playerId: number,
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
    playerId: number,
    towerIdx: number,
    confirmed: boolean,
  ) => void;
}

export function initTowerSelection(
  state: GameState,
  selectionStates: Map<number, SelectionState>,
  playerId: number,
  zone: number,
): void {
  const player = state.players[playerId]!;
  const towerIdx = player.homeTower
    ? state.map.towers.findIndex((tower) => tower === player.homeTower)
    : (zoneTowerIndices(state, zone)[0] ?? 0);
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
  selectionStates: Map<number, SelectionState>,
  idx: number,
  zone: number,
  playerId: number,
  send: (msg: {
    type: "opponent_tower_selected";
    playerId: number;
    towerIdx: number;
    confirmed: boolean;
  }) => void,
  onOverlayChanged: () => void,
  render: () => void,
): void {
  const tower = state.map.towers[idx];
  if (!tower || tower.zone !== zone) return;

  const selectionState = selectionStates.get(playerId);
  if (!selectionState) return;
  if (selectionState.highlighted === idx) return;
  selectionState.highlighted = idx;

  const player = state.players[playerId]!;
  selectPlayerTower(player, tower);

  send({
    type: MESSAGE.OPPONENT_TOWER_SELECTED,
    playerId,
    towerIdx: idx,
    confirmed: false,
  });

  onOverlayChanged();
  render();
}

export function confirmTowerSelection(
  state: GameState,
  selectionStates: Map<number, SelectionState>,
  controllers: readonly SelectionCapable[],
  playerId: number,
  isReselect: boolean,
  send: (msg: {
    type: "opponent_tower_selected";
    playerId: number;
    towerIdx: number;
    confirmed: boolean;
  }) => void,
  onReselectConfirmed: (playerId: number) => void,
  onOverlayChanged: () => void,
  render: () => void,
): boolean {
  const selectionState = selectionStates.get(playerId);
  // Selection-confirmed guard (see input-dispatch.ts header for convention):
  // once confirmed, all further selection actions are no-ops.
  if (!selectionState || selectionState.confirmed)
    return allSelectionsConfirmed(selectionStates);
  selectionState.confirmed = true;

  send({
    type: MESSAGE.OPPONENT_TOWER_SELECTED,
    playerId,
    towerIdx: selectionState.highlighted,
    confirmed: true,
  });

  const player = state.players[playerId]!;
  if (player.homeTower) {
    controllers[playerId]!.centerOn(player.homeTower.row, player.homeTower.col);
    if (isReselect) {
      onReselectConfirmed(playerId);
    }
  }

  onOverlayChanged();
  render();
  return allSelectionsConfirmed(selectionStates);
}

export function tickSelectionPhase(deps: TickSelectionPhaseDeps): void {
  const {
    dt,
    state,
    isHost,
    myPlayerId,
    selectTimer,
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
    state.timer = Math.max(0, selectTimer - accum.select);
  }
  if (!isHost && myPlayerId < 0) {
    render();
    return;
  }

  if (!isHost && myPlayerId >= 0) {
    if (accum.select >= selectTimer) {
      const selectionState = selectionStates.get(myPlayerId);
      if (selectionState && !selectionState.confirmed) {
        confirmSelectionAndStartBuild(myPlayerId, isReselectPhase(state.phase));
      }
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
  for (const [pid, selectionState] of selectionStates) {
    if (selectionState.confirmed) continue;
    if (remoteHumanSlots.has(pid)) continue;

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

  if (accum.select >= selectTimer) {
    for (const [pid, selectionState] of selectionStates) {
      if (selectionState.confirmed) continue;
      confirmSelectionAndStartBuild(pid, isReselect);
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

export function finishSelectionPhase(deps: {
  state: GameState;
  selectionStates: Map<number, SelectionState>;
  resetOverlaySelection: () => void;
  finalizeAndAdvance: () => void;
}): void {
  const { state, selectionStates, resetOverlaySelection, finalizeAndAdvance } =
    deps;

  if (state.phase !== Phase.CASTLE_SELECT) return;

  selectionStates.clear();
  resetOverlaySelection();
  finalizeAndAdvance();
}

function zoneTowerIndices(state: GameState, zone: number): number[] {
  return state.map.towers
    .map((tower, i) => ({ tower, i }))
    .filter(({ tower }) => tower.zone === zone)
    .map(({ i }) => i);
}
