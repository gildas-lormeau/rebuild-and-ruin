/**
 * Selection sub-system factory — owns tower selection, castle building,
 * reselection, and the advance-to-cannon-phase transition.
 *
 * Extracted from runtime.ts to reduce its size.  Follows the same
 * factory-with-deps pattern as runtime-camera.ts.
 */

import { type GameMessage, MESSAGE } from "../server/protocol.ts";
import { claimTerritory } from "./build-system.ts";
import {
  createCastleBuildState,
  tickCastleBuildAnimation,
} from "./castle-build.ts";
import {
  type InputReceiver,
  isHuman,
  type PlayerController,
} from "./controller-interfaces.ts";
import {
  SCORE_DELTA_DISPLAY_TIME,
  SELECT_ANNOUNCEMENT_DURATION,
  SELECT_TIMER,
  WALL_BUILD_INTERVAL,
} from "./game-constants.ts";
import {
  advanceToCannonPlacePhase,
  enterCannonPlacePhase,
  enterCastleReselectPhase,
  finalizeCastleConstruction,
  markPlayerReselected,
  prepareCastleWallsForPlayer,
} from "./game-engine.ts";
import {
  completeReselection,
  processReselectionQueue,
} from "./game-ui-helpers.ts";
import { TILE_SIZE } from "./grid.ts";
import { syncSelectionOverlay as syncSelectionOverlayImpl } from "./render-composition.ts";
import { initTowerSelection } from "./runtime-bootstrap.ts";
import type { RuntimeState } from "./runtime-state.ts";
import type { CameraSystem, RuntimeSelection } from "./runtime-types.ts";
import {
  allSelectionsConfirmed as allSelectionsConfirmedImpl,
  confirmTowerSelection,
  finishSelectionPhase,
  highlightTowerSelection,
  initTowerSelection as initTowerSelectionImpl,
  tickSelectionPhase,
} from "./selection.ts";
import type { SoundSystem } from "./sound-system.ts";
import { towerCenterPx } from "./spatial.ts";
import { Mode } from "./types.ts";

interface SelectionSystemDeps {
  rs: RuntimeState;

  // Config / networking
  send: (msg: GameMessage) => void;
  log: (msg: string) => void;

  camera: Pick<
    CameraSystem,
    | "lightUnzoom"
    | "clearCastleBuildViewport"
    | "setCastleBuildViewport"
    | "setSelectionViewport"
  >;
  sound: Pick<SoundSystem, "drumsStart" | "chargeFanfare">;

  // Sibling systems / parent callbacks
  render: () => void;
  firstHuman: () => (PlayerController & InputReceiver) | null;
  startCannonPhase: (onBannerDone?: () => void) => void;

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

export function createSelectionSystem(
  deps: SelectionSystemDeps,
): SelectionSystem {
  const { rs } = deps;

  // -------------------------------------------------------------------------
  // Tower selection helpers
  // -------------------------------------------------------------------------

  function initPlayerTowerSelection(pid: number, zone: number): void {
    initTowerSelectionImpl(rs.state, rs.selectionStates, pid, zone);
    if (isHuman(rs.controllers[pid]!)) {
      const player = rs.state.players[pid];
      if (player?.homeTower)
        deps.camera.setSelectionViewport(
          player.homeTower.row,
          player.homeTower.col,
        );
    }
  }

  function enterTowerSelection(): void {
    initTowerSelection({
      state: rs.state,
      isHost: rs.ctx.isHost,
      myPlayerId: rs.ctx.myPlayerId,
      remoteHumanSlots: rs.ctx.remoteHumanSlots,
      controllers: rs.controllers,
      selectionStates: rs.selectionStates,
      initTowerSelection: initPlayerTowerSelection,
      syncSelectionOverlay,
      setOverlaySelection: () => {
        rs.overlay = { selection: { highlighted: null, selected: null } };
      },
      selectTimer: SELECT_TIMER,
      accum: rs.accum,
      enterCastleReselectPhase,
      now: () => performance.now(),
      setModeSelection: () => {
        rs.mode = Mode.SELECTION;
        deps.sound.drumsStart();
      },
      setLastTime: (t) => {
        rs.lastTime = t;
      },
      requestFrame: deps.requestFrame,
      log: deps.log,
    });
  }

  function syncSelectionOverlay(): void {
    const announcementDone =
      rs.accum.selectAnnouncement >= SELECT_ANNOUNCEMENT_DURATION;
    syncSelectionOverlayImpl(
      rs.overlay,
      rs.selectionStates,
      (pid) => isHuman(rs.controllers[pid]!) && announcementDone,
    );
  }

  function highlightTowerForPlayer(
    idx: number,
    zone: number,
    pid: number,
  ): void {
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
    // Auto-zoom to the highlighted tower on mobile (human player only, own zone)
    const human = deps.firstHuman();
    if (human && pid === human.playerId) {
      const tower = rs.state.map.towers[idx];
      if (tower && tower.zone === zone)
        deps.camera.setSelectionViewport(tower.row, tower.col);
    }
  }

  function confirmSelectionForPlayer(pid: number, isReselect = false): boolean {
    const ss = rs.selectionStates.get(pid);
    const alreadyConfirmed = ss?.confirmed ?? true;
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
    if (!alreadyConfirmed) startPlayerCastleBuild(pid);
    return allDone;
  }

  function allSelectionsConfirmed(): boolean {
    return allSelectionsConfirmedImpl(rs.selectionStates);
  }

  // -------------------------------------------------------------------------
  // Castle selection tick + finish
  // -------------------------------------------------------------------------

  function tickSelection(dt: number) {
    const remoteHumanSlots = rs.ctx.remoteHumanSlots;
    tickSelectionPhase({
      dt,
      state: rs.state,
      isHost: rs.ctx.isHost,
      myPlayerId: rs.ctx.myPlayerId,
      selectTimer: SELECT_TIMER,
      accum: rs.accum,
      selectionStates: rs.selectionStates,
      remoteHumanSlots,
      controllers: rs.controllers,
      render: deps.render,
      confirmSelectionForPlayer: (pid, isReselect) =>
        confirmSelectionForPlayer(pid, isReselect ?? false),
      allSelectionsConfirmed,
      allBuildsComplete: () =>
        rs.castleBuilds.length === 0 &&
        rs.state.players.every(
          (p) => !p.homeTower || p.interior.size > 0 || p.eliminated,
        ),
      tickActiveBuilds: tickAllCastleBuilds,
      announcementDuration: SELECT_ANNOUNCEMENT_DURATION,
      setFrameAnnouncement: (text) => {
        rs.frame.announcement = text;
      },
      finishReselection,
      finishSelection,
      syncSelectionOverlay,
      sendOpponentTowerSelected: (playerId, towerIdx, confirmed) => {
        deps.send({
          type: MESSAGE.OPPONENT_TOWER_SELECTED,
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
    deps.camera.clearCastleBuildViewport();
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
    if (!rs.ctx.isHost) return; // non-host builds via castle_walls message
    const plan = prepareCastleWallsForPlayer(rs.state, playerId);
    if (!plan) return;
    deps.send({ type: MESSAGE.CASTLE_WALLS, plans: [plan] });
    const human = deps.firstHuman();
    rs.castleBuilds.push(createCastleBuildState([plan], () => {}));
    // Only zoom to the human player's castle build
    if (human && playerId === human.playerId) {
      deps.camera.setCastleBuildViewport([plan]);
    }
  }

  function tickAllCastleBuilds(dt: number): void {
    let anyPlaced = false;
    const humanPid = deps.firstHuman()?.playerId ?? -1;
    let humanBuildDone = false;
    for (let i = rs.castleBuilds.length - 1; i >= 0; i--) {
      const build = rs.castleBuilds[i]!;
      const result = tickCastleBuildAnimation({
        castleBuild: build,
        dt,
        wallBuildIntervalMs: WALL_BUILD_INTERVAL,
        state: rs.state,
        render: () => {},
        onWallsPlaced: () => {
          anyPlaced = true;
        },
      });
      if (!result.next) {
        for (const p of build.wallPlans) deps.sound.chargeFanfare(p.playerId);
        if (build.wallPlans.some((p) => p.playerId === humanPid))
          humanBuildDone = true;
        rs.castleBuilds.splice(i, 1);
      } else {
        rs.castleBuilds[i] = result.next;
      }
    }
    if (anyPlaced) claimTerritory(rs.state);
    // Unzoom once human player's castle build animation finishes
    if (humanBuildDone) {
      deps.camera.clearCastleBuildViewport();
      deps.camera.lightUnzoom();
    }
  }

  function showBuildScoreDeltas(onDone: () => void): void {
    // Compute score deltas from the build phase (with display coordinates)
    rs.scoreDeltas = rs.state.players
      .map((p, i) => {
        const ht = p.homeTower;
        const px = ht ? towerCenterPx(ht) : { x: 0, y: 0 };
        return {
          playerId: i,
          delta: p.score - (rs.preScores[i] ?? 0),
          total: p.score,
          cx: px.x,
          cy: px.y - TILE_SIZE, // just above the tower
        };
      })
      .filter((d) => d.delta > 0 && !rs.state.players[d.playerId]!.eliminated);

    if (rs.scoreDeltas.length > 0) {
      deps.camera.lightUnzoom();
      rs.scoreDeltaTimer = SCORE_DELTA_DISPLAY_TIME;
      rs.scoreDeltaOnDone = onDone;
    } else {
      onDone();
    }
  }

  function advanceToCannonPhase(): void {
    advanceToCannonPlacePhase(rs.state);
    deps.startCannonPhase(() => {
      rs.mode = Mode.GAME;
    });
  }

  function tickCastleBuild(dt: number): void {
    tickAllCastleBuilds(dt);
    deps.render();
    if (rs.castleBuilds.length === 0) {
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
    const remoteHumanSlots = rs.ctx.remoteHumanSlots;
    enterCastleReselectPhase(rs.state);
    rs.selectionStates.clear();
    rs.reselectionPids = [];

    const { remaining, needsUI } = processReselectionQueue({
      reselectQueue: rs.reselectQueue,
      state: rs.state,
      controllers: rs.controllers,
      initTowerSelection: initPlayerTowerSelection,
      processPlayer: (pid, ctrl, zone) => {
        if (remoteHumanSlots.has(pid)) return "pending" as const;
        ctrl.reselect(rs.state, zone);
        // AI confirms via selectionTick(); humans need UI interaction
        return "pending" as const;
      },
      onDone: (pid, ctrl) => {
        const player = rs.state.players[pid]!;
        if (player.homeTower)
          ctrl.centerOn(player.homeTower.row, player.homeTower.col);
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
      deps.sound.drumsStart();
      if (rs.ctx.isHost) {
        deps.send({ type: MESSAGE.SELECT_START, timer: SELECT_TIMER });
      }
    } else {
      finishReselection();
    }
  }

  function finishReselection() {
    completeReselection({
      state: rs.state,
      selectionStates: rs.selectionStates,
      clearOverlaySelection,
      reselectQueue: rs.reselectQueue,
      reselectionPids: rs.reselectionPids,
      finalizeAndAdvance,
    });
  }

  // ---------------------------------------------------------------------------
  // Public API (matches RuntimeSelection + extras)
  // ---------------------------------------------------------------------------

  return {
    getStates: () => rs.selectionStates,
    init: initPlayerTowerSelection,
    enter: enterTowerSelection,
    syncOverlay: syncSelectionOverlay,
    highlight: highlightTowerForPlayer,
    confirm: confirmSelectionForPlayer,
    allConfirmed: allSelectionsConfirmed,
    tick: tickSelection,
    finish: finishSelection,
    advanceToCannonPhase,
    tickCastleBuild,
    setCastleBuildViewport: (
      plans: readonly { playerId: number; tiles: number[] }[],
    ) => deps.camera.setCastleBuildViewport(plans),
    startReselection,
    finishReselection,
    showBuildScoreDeltas,
  };
}
