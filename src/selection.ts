import { MSG } from "../server/protocol.ts";
import { isHuman } from "./controller-factory.ts";
import type { PlayerController } from "./player-controller.ts";
import type { GameState } from "./types.ts";
import { Phase } from "./types.ts";

// ---------------------------------------------------------------------------
// Selection state
// ---------------------------------------------------------------------------

export interface SelectionState {
  highlighted: number;
  confirmed: boolean;
}

export function allSelectionsConfirmed(
  selectionStates: Map<number, SelectionState>,
): boolean {
  for (const [, ss] of selectionStates) {
    if (!ss.confirmed) return false;
  }
  return true;
}

function zoneTowerIndices(state: GameState, zone: number): number[] {
  return state.map.towers
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.zone === zone)
    .map(({ i }) => i);
}

export function initTowerSelection(
  state: GameState,
  selectionStates: Map<number, SelectionState>,
  playerId: number,
  zone: number,
): void {
  const player = state.players[playerId]!;
  const towerIdx = player.homeTower
    ? state.map.towers.findIndex((t) => t === player.homeTower)
    : (zoneTowerIndices(state, zone)[0] ?? 0);
  selectionStates.set(playerId, { highlighted: towerIdx, confirmed: false });
  const tower = state.map.towers[towerIdx];
  if (tower) {
    player.homeTower = tower;
    player.ownedTowers = [tower];
  }
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

  const ss = selectionStates.get(playerId);
  if (!ss) return;
  if (ss.highlighted === idx) return;
  ss.highlighted = idx;

  const player = state.players[playerId]!;
  player.homeTower = tower;
  player.ownedTowers = [tower];

  send({
    type: MSG.OPPONENT_TOWER_SELECTED,
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
  controllers: PlayerController[],
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
  remoteHumanSlots?: Set<number>,
): boolean {
  const ss = selectionStates.get(playerId);
  if (!ss || ss.confirmed) return allSelectionsConfirmed(selectionStates);
  ss.confirmed = true;

  send({
    type: MSG.OPPONENT_TOWER_SELECTED,
    playerId,
    towerIdx: ss.highlighted,
    confirmed: true,
  });

  const player = state.players[playerId]!;
  if (player.homeTower) {
    controllers[playerId]!.centerOn(player.homeTower.row, player.homeTower.col);
    if (isReselect) {
      onReselectConfirmed(playerId);
    }
  }

  // When a human confirms, auto-confirm all remaining AI players so the
  // castle construction animation starts immediately (no browsing delay).
  // Skip remote human slots — they choose independently over the network.
  if (isHuman(controllers[playerId]!)) {
    for (const [aiPid, aiSs] of selectionStates) {
      if (aiSs.confirmed || remoteHumanSlots?.has(aiPid) || isHuman(controllers[aiPid]!)) continue;
      aiSs.confirmed = true;
      const aiPlayer = state.players[aiPid]!;
      if (aiPlayer.homeTower) {
        controllers[aiPid]!.centerOn(aiPlayer.homeTower.row, aiPlayer.homeTower.col);
        if (isReselect) onReselectConfirmed(aiPid);
      }
      send({ type: MSG.OPPONENT_TOWER_SELECTED, playerId: aiPid, towerIdx: aiSs.highlighted, confirmed: true });
    }
  }

  onOverlayChanged();
  render();
  return allSelectionsConfirmed(selectionStates);
}

// ---------------------------------------------------------------------------
// Selection phase tick + finish
// ---------------------------------------------------------------------------

interface TickSelectionPhaseDeps {
  dt: number;
  state: GameState;
  isHost: boolean;
  myPlayerId: number;
  selectTimer: number;
  accum: { select: number };
  selectionStates: Map<number, SelectionState>;
  remoteHumanSlots: Set<number>;
  controllers: PlayerController[];
  render: () => void;
  confirmSelectionForPlayer: (playerId: number, isReselect?: boolean) => void;
  allSelectionsConfirmed: () => boolean;
  finishReselection: () => void;
  finishSelection: () => void;
  syncSelectionOverlay: () => void;
  sendOpponentTowerSelected: (
    playerId: number,
    towerIdx: number,
    confirmed: boolean,
  ) => void;
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
    confirmSelectionForPlayer,
    allSelectionsConfirmed,
    finishReselection,
    finishSelection,
    syncSelectionOverlay,
    sendOpponentTowerSelected,
  } = deps;

  const phase = state.phase;
  if (phase !== Phase.CASTLE_SELECT && phase !== Phase.CASTLE_RESELECT) return;

  accum.select += dt;
  state.timer = Math.max(0, selectTimer - accum.select);

  if (!isHost && myPlayerId < 0) {
    render();
    return;
  }

  if (!isHost && myPlayerId >= 0) {
    if (state.timer <= 0) {
      const ss = selectionStates.get(myPlayerId);
      if (ss && !ss.confirmed) {
        confirmSelectionForPlayer(myPlayerId, phase === Phase.CASTLE_RESELECT);
      }
    }
    render();
    return;
  }

  const isReselect = phase === Phase.CASTLE_RESELECT;
  for (const [pid, ss] of selectionStates) {
    if (ss.confirmed) continue;
    if (remoteHumanSlots.has(pid)) continue;

    const towerBefore = state.players[pid]!.homeTower;
    if (controllers[pid]!.selectionTick(dt, state)) {
      confirmSelectionForPlayer(pid, isReselect);
      if (allSelectionsConfirmed()) {
        render();
        if (isReselect) finishReselection();
        else finishSelection();
        return;
      }
      continue;
    }

    if (state.players[pid]!.homeTower !== towerBefore) {
      const newTower = state.players[pid]!.homeTower;
      if (newTower) {
        ss.highlighted = newTower.index;
        syncSelectionOverlay();
        sendOpponentTowerSelected(pid, newTower.index, false);
      }
    }
  }

  render();

  if (state.timer <= 0) {
    for (const [pid] of selectionStates) {
      confirmSelectionForPlayer(pid, isReselect);
    }
    if (isReselect) finishReselection();
    else finishSelection();
  }
}

export function finishSelectionPhase(deps: {
  state: GameState;
  selectionStates: Map<number, SelectionState>;
  clearOverlaySelection: () => void;
  animateCastleConstruction: (onDone: () => void) => void;
  advanceToCannonPhase: () => void;
}): void {
  const {
    state,
    selectionStates,
    clearOverlaySelection,
    animateCastleConstruction,
    advanceToCannonPhase,
  } = deps;

  if (state.phase !== Phase.CASTLE_SELECT) return;

  selectionStates.clear();
  clearOverlaySelection();
  animateCastleConstruction(() => advanceToCannonPhase());
}
