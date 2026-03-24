/**
 * Selection sub-system factory — owns tower selection, castle building,
 * reselection, and the advance-to-cannon-phase transition.
 *
 * Extracted from game-runtime.ts to reduce its size.  Follows the same
 * factory-with-deps pattern as runtime-camera.ts.
 */

import type { GameMessage } from "../server/protocol.ts";
import { MSG } from "../server/protocol.ts";
import {
  createCastleBuildState,
  tickCastleBuildAnimation,
} from "./castle-build.ts";
import { isHuman } from "./controller-factory.ts";
import { setupTowerSelection } from "./game-bootstrap.ts";
import {
  advanceToCannonPlacePhase,
  clearPlayerState,
  enterCannonPlacePhase,
  enterCastleReselectPhase,
  finalizeCastleConstruction,
  markPlayerReselected,
  prepareCastleWallsForPlayer,
} from "./game-engine.ts";
import type { RuntimeSelection } from "./game-runtime-types.ts";
import {
  completeReselection,
  processReselectionQueue,
} from "./game-ui-runtime.ts";
import { Mode } from "./game-ui-types.ts";
import {
  BANNER_PLACE_CANNONS,
  BANNER_PLACE_CANNONS_SUB,
} from "./phase-banner.ts";
import { claimTerritory } from "./phase-build.ts";
import type { InputReceiver, PlayerController } from "./player-controller.ts";
import {
  syncSelectionOverlay as syncSelectionOverlayImpl,
} from "./render-composition.ts";
import type { RuntimeState } from "./runtime-state.ts";
import {
  allSelectionsConfirmed as allSelectionsConfirmedImpl,
  confirmTowerSelection,
  finishSelectionPhase,
  highlightTowerSelection,
  initTowerSelection as initTowerSelectionImpl,
  tickSelectionPhase,
} from "./selection.ts";
import {
  SCORE_DELTA_DISPLAY_TIME,
  SELECT_ANNOUNCEMENT_DURATION,
  SELECT_TIMER,
  WALL_BUILD_INTERVAL,
} from "./types.ts";

interface SelectionSystemDeps {
  rs: RuntimeState;

  // Config / networking
  getIsHost: () => boolean;
  getMyPlayerId: () => number;
  getRemoteHumanSlots: () => Set<number>;
  send: (msg: GameMessage) => void;
  log: (msg: string) => void;

  // Camera
  lightUnzoom: () => void;
  clearCastleBuildViewport: () => void;
  setCastleBuildViewport: (plans: { playerId: number; tiles: number[] }[]) => void;
  computeZoneBounds: (zone: number) => { x: number; y: number; w: number; h: number };

  // Sibling systems / parent callbacks
  render: () => void;
  firstHuman: () => (PlayerController & InputReceiver) | null;
  startCannonPhase: () => void;
  showBanner: (
    text: string,
    onDone: () => void,
    reveal?: boolean,
    newBattle?: { territory: Set<number>[]; walls: Set<number>[] },
    subtitle?: string,
  ) => void;

  /**
   * Called once during enterTowerSelection — kicks off the animation loop
   * if the runtime is currently stopped (e.g. online mode starting from DOM lobby).
   */
  requestFrame: () => void;
}

/** Extended return: RuntimeSelection + extras needed by game-runtime internals. */
export type SelectionSystem = RuntimeSelection & {
  showBuildScoreDeltas: (onDone: () => void) => void;
};

export function createSelectionSystem(deps: SelectionSystemDeps): SelectionSystem {
  const { rs } = deps;

  // -------------------------------------------------------------------------
  // Tower selection helpers
  // -------------------------------------------------------------------------

  function initTowerSelection(pid: number, zone: number): void {
    initTowerSelectionImpl(rs.state, rs.selectionStates, pid, zone);
  }

  function enterTowerSelection(): void {
    setupTowerSelection({
      state: rs.state,
      isHost: deps.getIsHost(),
      myPlayerId: deps.getMyPlayerId(),
      remoteHumanSlots: deps.getRemoteHumanSlots(),
      controllers: rs.controllers,
      selectionStates: rs.selectionStates,
      initTowerSelection,
      syncSelectionOverlay,
      setOverlaySelection: () => { rs.overlay = { selection: { highlighted: null, selected: null } }; },
      selectTimer: SELECT_TIMER,
      accum: rs.accum,
      enterCastleReselectPhase,
      now: () => performance.now(),
      setModeSelection: () => { rs.mode = Mode.SELECTION; },
      setLastTime: (t) => { rs.lastTime = t; },
      requestFrame: deps.requestFrame,
      log: deps.log,
    });
  }

  function syncSelectionOverlay(): void {
    syncSelectionOverlayImpl(rs.overlay, rs.selectionStates, (pid) => isHuman(rs.controllers[pid]!));
  }

  function highlightTowerForPlayer(idx: number, zone: number, pid: number): void {
    highlightTowerSelection(
      rs.state,
      rs.selectionStates,
      idx,
      zone,
      pid,
      deps.send,
      () => syncSelectionOverlay(),
      () => deps.render(),
    );
  }

  function confirmSelectionForPlayer(pid: number, isReselect = false): boolean {
    const allDone = confirmTowerSelection(
      rs.state,
      rs.selectionStates,
      rs.controllers,
      pid,
      isReselect,
      deps.send,
      (reselectPid) => {
        markPlayerReselected(rs.state, reselectPid);
        rs.reselectionPids.push(reselectPid);
      },
      () => syncSelectionOverlay(),
      () => deps.render(),
    );
    startPlayerCastleBuild(pid);
    return allDone;
  }

  function allSelectionsConfirmed(): boolean {
    return allSelectionsConfirmedImpl(rs.selectionStates);
  }

  // -------------------------------------------------------------------------
  // Castle selection tick + finish
  // -------------------------------------------------------------------------

  function tickSelection(dt: number) {
    const remoteHumanSlots = deps.getRemoteHumanSlots();
    tickSelectionPhase({
      dt,
      state: rs.state,
      isHost: deps.getIsHost(),
      myPlayerId: deps.getMyPlayerId(),
      selectTimer: SELECT_TIMER,
      accum: rs.accum,
      selectionStates: rs.selectionStates,
      remoteHumanSlots,
      controllers: rs.controllers,
      render: deps.render,
      confirmSelectionForPlayer: (pid, isReselect) =>
        confirmSelectionForPlayer(pid, isReselect ?? false),
      allSelectionsConfirmed,
      allBuildsComplete: () => rs.castleBuilds.length === 0 &&
        rs.state.players.every(p => !p.homeTower || p.interior.size > 0 || p.eliminated),
      tickActiveBuilds: tickAllCastleBuilds,
      announcementDuration: SELECT_ANNOUNCEMENT_DURATION,
      setFrameAnnouncement: (text) => { rs.frame.announcement = text; },
      finishReselection,
      finishSelection,
      syncSelectionOverlay,
      sendOpponentTowerSelected: (playerId, towerIdx, confirmed) => {
        deps.send({
          type: MSG.OPPONENT_TOWER_SELECTED,
          playerId,
          towerIdx,
          confirmed,
        });
      },
    });
  }

  function clearOverlaySelection() {
    if (rs.overlay.selection) {
      rs.overlay.selection.highlights = undefined;
      rs.overlay.selection.highlighted = null;
      rs.overlay.selection.selected = null;
    }
  }

  function finalizeAndAdvance(): void {
    rs.banner.oldHouses = rs.state.map.houses.map((h) => ({ ...h }));
    rs.banner.oldBonusSquares = rs.state.bonusSquares.map((b) => ({ ...b }));
    finalizeCastleConstruction(rs.state);
    enterCannonPlacePhase(rs.state);
    deps.clearCastleBuildViewport();
    advanceToCannonPhase();
  }

  function finishSelection() {
    finishSelectionPhase({
      state: rs.state,
      selectionStates: rs.selectionStates,
      clearOverlaySelection,
      finalizeAndAdvance,
    });
  }

  function startPlayerCastleBuild(playerId: number): void {
    if (!deps.getIsHost()) return; // non-host builds via castle_walls message
    const plan = prepareCastleWallsForPlayer(rs.state, playerId);
    if (!plan) return;
    deps.send({ type: MSG.CASTLE_WALLS, plans: [plan] });
    const human = deps.firstHuman();
    rs.castleBuilds.push(createCastleBuildState([plan], () => {}));
    // Only zoom to the human player's castle build
    if (human && playerId === human.playerId) {
      deps.setCastleBuildViewport([plan]);
    }
  }

  function tickAllCastleBuilds(dt: number): void {
    let anyPlaced = false;
    for (let i = rs.castleBuilds.length - 1; i >= 0; i--) {
      const result = tickCastleBuildAnimation({
        castleBuild: rs.castleBuilds[i]!, dt, wallBuildIntervalMs: WALL_BUILD_INTERVAL, state: rs.state, render: () => {},
        onWallsPlaced: () => { anyPlaced = true; },
      });
      if (!result.next) {
        rs.castleBuilds.splice(i, 1);
      } else {
        rs.castleBuilds[i] = result.next;
      }
    }
    if (anyPlaced) claimTerritory(rs.state);
  }

  function showBuildScoreDeltas(onDone: () => void): void {
    // Compute score deltas from the build phase (with display coordinates)
    rs.scoreDeltas = rs.state.players
      .map((p, i) => {
        const zone = rs.state.playerZones[i] ?? 0;
        const bounds = deps.computeZoneBounds(zone);
        return {
          playerId: i, delta: p.score - (rs.preScores[i] ?? 0), total: p.score,
          cx: bounds.x + bounds.w / 2, cy: bounds.y + bounds.h / 2,
        };
      })
      .filter(d => d.delta > 0 && !rs.state.players[d.playerId]!.eliminated);

    if (rs.scoreDeltas.length > 0) {
      deps.lightUnzoom();
      rs.scoreDeltaTimer = SCORE_DELTA_DISPLAY_TIME;
      rs.scoreDeltaOnDone = onDone;
    } else {
      onDone();
    }
  }

  function advanceToCannonPhase(): void {
    advanceToCannonPlacePhase(rs.state);
    deps.startCannonPhase();
    deps.showBanner(BANNER_PLACE_CANNONS, () => { rs.mode = Mode.GAME; }, true, undefined, BANNER_PLACE_CANNONS_SUB);
  }

  function tickCastleBuild(dt: number): void {
    tickAllCastleBuilds(dt);
    deps.render();
    if (rs.castleBuilds.length === 0) {
      deps.clearCastleBuildViewport();
      if (rs.castleBuildOnDone) {
        const cb = rs.castleBuildOnDone;
        rs.castleBuildOnDone = null;
        cb();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Reselection
  // -------------------------------------------------------------------------

  function startReselection() {
    const remoteHumanSlots = deps.getRemoteHumanSlots();
    enterCastleReselectPhase(rs.state);
    rs.selectionStates.clear();
    rs.reselectionPids = [];

    const { remaining, needsUI } = processReselectionQueue({
      reselectQueue: rs.reselectQueue,
      state: rs.state,
      controllers: rs.controllers,
      initTowerSelection,
      processPlayer: (pid, ctrl, zone) => {
        if (remoteHumanSlots.has(pid)) return "pending" as const;
        const done = ctrl.reselect(rs.state, zone);
        return done ? "done" as const : "pending" as const;
      },
      onDone: (pid, ctrl) => {
        const player = rs.state.players[pid]!;
        if (player.homeTower) ctrl.centerOn(player.homeTower.row, player.homeTower.col);
        markPlayerReselected(rs.state, pid);
        rs.reselectionPids.push(pid);
      },
    });
    rs.reselectQueue = remaining.length > 0 ? remaining : [];

    if (needsUI) {
      syncSelectionOverlay();
      rs.accum.select = 0;
      rs.state.timer = SELECT_TIMER;
      rs.mode = Mode.SELECTION;
      if (deps.getIsHost()) {
        deps.send({ type: MSG.SELECT_START, timer: SELECT_TIMER });
      }
    } else {
      finishReselection();
    }
  }

  function finishReselection() {
    completeReselection({
      state: rs.state, selectionStates: rs.selectionStates, clearOverlaySelection,
      reselectQueue: rs.reselectQueue, reselectionPids: rs.reselectionPids, clearPlayerState,
      finalizeAndAdvance,
    });
  }

  // ---------------------------------------------------------------------------
  // Public API (matches RuntimeSelection + extras)
  // ---------------------------------------------------------------------------

  return {
    getStates: () => rs.selectionStates,
    init: initTowerSelection,
    enter: enterTowerSelection,
    syncOverlay: syncSelectionOverlay,
    highlight: highlightTowerForPlayer,
    confirm: confirmSelectionForPlayer,
    allConfirmed: allSelectionsConfirmed,
    tick: tickSelection,
    finish: finishSelection,
    advanceToCannonPhase,
    tickCastleBuild,
    setCastleBuildViewport: (plans: { playerId: number; tiles: number[] }[]) => deps.setCastleBuildViewport(plans),
    startReselection,
    finishReselection,
    showBuildScoreDeltas,
  };
}
