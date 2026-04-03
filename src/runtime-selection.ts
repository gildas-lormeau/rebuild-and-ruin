/**
 * Selection sub-system factory — owns tower selection, castle building,
 * reselection, and the advance-to-cannon-phase transition.
 *
 * Extracted from runtime.ts to reduce its size.  Follows the same
 * factory-with-deps pattern as runtime-camera.ts.
 */

import { type GameMessage, MESSAGE } from "../server/protocol.ts";
import { getInterior } from "./board-occupancy.ts";
import { recheckTerritoryOnly } from "./build-system.ts";
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
  type ValidPlayerSlot,
  WALL_BUILD_INTERVAL,
} from "./game-constants.ts";
import {
  enterCannonPlacePhase,
  enterCastleReselectPhase,
  markPlayerReselected,
  nextPhase,
} from "./game-engine.ts";
import { TILE_SIZE } from "./grid.ts";
import { snapshotEntities } from "./phase-banner.ts";
import {
  advanceToCannonPlacePhase,
  completeReselection,
  finalizeCastleConstruction,
  prepareCastleWallsForPlayer,
  processReselectionQueue,
} from "./phase-setup.ts";
import { updateSelectionOverlay as syncSelectionOverlayImpl } from "./render-composition.ts";
import { enterTowerSelection as enterTowerSelectionImpl } from "./runtime-bootstrap.ts";
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
import { isRemoteHuman, type MutableAccums } from "./tick-context.ts";
import { Mode } from "./types.ts";
import { fireOnce } from "./utils.ts";

interface SelectionSystemDeps {
  runtimeState: RuntimeState;

  // Config / networking
  send: (msg: GameMessage) => void;
  log: (msg: string) => void;

  camera: Pick<
    CameraSystem,
    | "clearPhaseZoom"
    | "clearCastleBuildViewport"
    | "setCastleBuildViewport"
    | "setSelectionViewport"
  >;
  sound: Pick<SoundSystem, "drumsStart" | "chargeFanfare">;

  // Sibling systems / parent callbacks
  render: () => void;
  pointerPlayer: () => (PlayerController & InputReceiver) | null;
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
  const { runtimeState } = deps;

  /** Clear all selection tracking state — call before entering a new selection
   *  round (initial selection or reselection). Resets selectionStates map,
   *  reselectionPids, overlay selection display, and stale banner snapshots
   *  (wallsBeforeSweep / prevCastles captured at BUILD_END become invalid
   *  when a player's zone is reset after losing a life). */
  function resetSelectionState(): void {
    runtimeState.selectionStates.clear();
    runtimeState.reselectionPids = [];
    resetOverlaySelection();
    runtimeState.banner.wallsBeforeSweep = undefined;
    runtimeState.banner.prevCastles = undefined;
  }

  // -------------------------------------------------------------------------
  // Tower selection helpers
  // -------------------------------------------------------------------------

  function initPlayerTowerSelection(pid: ValidPlayerSlot, zone: number): void {
    initTowerSelectionImpl(
      runtimeState.state,
      runtimeState.selectionStates,
      pid,
      zone,
    );
    if (isHuman(runtimeState.controllers[pid]!)) {
      const player = runtimeState.state.players[pid];
      if (player?.homeTower)
        deps.camera.setSelectionViewport(
          player.homeTower.row,
          player.homeTower.col,
        );
    }
  }

  function enterTowerSelection(): void {
    resetSelectionState();
    enterTowerSelectionImpl({
      state: runtimeState.state,
      isHost: runtimeState.frameCtx.hostAtFrameStart,
      myPlayerId: runtimeState.frameCtx.myPlayerId,
      remoteHumanSlots: runtimeState.frameCtx.remoteHumanSlots,
      controllers: runtimeState.controllers,
      selectionStates: runtimeState.selectionStates,
      initTowerSelection: initPlayerTowerSelection,
      syncSelectionOverlay,
      setOverlaySelection: () => {
        runtimeState.overlay = {
          selection: { highlighted: null, selected: null },
        };
      },
      selectTimer: SELECT_TIMER,
      accum: runtimeState.accum,
      enterCastleReselectPhase,
      now: () => performance.now(),
      setModeSelection: () => {
        runtimeState.mode = Mode.SELECTION;
        deps.sound.drumsStart();
      },
      setLastTime: (timestamp) => {
        runtimeState.lastTime = timestamp;
      },
      requestFrame: deps.requestFrame,
      log: deps.log,
    });
  }

  function syncSelectionOverlay(): void {
    const announcementDone =
      runtimeState.accum.selectAnnouncement >= SELECT_ANNOUNCEMENT_DURATION;
    const visible = new Set<number>();
    if (announcementDone) {
      for (const ctrl of runtimeState.controllers) {
        if (isHuman(ctrl)) visible.add(ctrl.playerId);
      }
    }
    syncSelectionOverlayImpl(
      runtimeState.overlay,
      runtimeState.selectionStates,
      visible,
    );
  }

  /** Highlight a tower for a player's selection UI. */
  function highlightTowerForPlayer(
    idx: number,
    zone: number,
    pid: ValidPlayerSlot,
  ): void {
    const changed = highlightTowerSelection(
      runtimeState.state,
      runtimeState.selectionStates,
      idx,
      zone,
      pid,
    );
    if (!changed) return;

    deps.send({
      type: MESSAGE.OPPONENT_TOWER_SELECTED,
      playerId: pid,
      towerIdx: idx,
      confirmed: false,
    });
    syncSelectionOverlay();
    deps.render();

    // Auto-zoom to the highlighted tower on mobile (human player only, own zone)
    const human = deps.pointerPlayer();
    if (human && pid === human.playerId) {
      const tower = runtimeState.state.map.towers[idx];
      if (tower && tower.zone === zone)
        deps.camera.setSelectionViewport(tower.row, tower.col);
    }
  }

  /** Confirms tower selection and triggers castle build animation.
   *  @sideeffect Starts castle build animation for the player (via startPlayerCastleBuild).
   *  Idempotent: calling multiple times for the same player is safe — skips if already confirmed.
   *
   *  Two-step flow:
   *  1. confirmSelectionAndStartBuild — marks the player as confirmed in selectionStates,
   *     then kicks off startPlayerCastleBuild for the newly confirmed player.
   *     Returns true when ALL players have confirmed.
   *  2. finishSelection (called separately by tickSelection when allConfirmed) —
   *     clears overlay state, finalizes castle construction, and advances to cannon phase.
   */
  function confirmSelectionAndStartBuild(
    pid: ValidPlayerSlot,
    isReselect = false,
  ): boolean {
    const result = confirmTowerSelection(
      runtimeState.state,
      runtimeState.selectionStates,
      runtimeState.controllers,
      pid,
      isReselect,
    );
    if (!result)
      return allSelectionsConfirmedImpl(runtimeState.selectionStates);

    deps.send({
      type: MESSAGE.OPPONENT_TOWER_SELECTED,
      playerId: pid,
      towerIdx: result.towerIdx,
      confirmed: true,
    });

    if (result.isReselect) {
      markPlayerReselected(runtimeState.state, pid);
      runtimeState.reselectionPids.push(pid);
    }

    syncSelectionOverlay();
    deps.render();
    startPlayerCastleBuild(pid);
    return result.allDone;
  }

  /** Alias for allSelectionsConfirmed() — returns true when every player's selection is confirmed.
   *  Named `allConfirmed` for brevity in the public API; the underlying function is
   *  allSelectionsConfirmed() in selection.ts. */
  function allSelectionsConfirmed(): boolean {
    return allSelectionsConfirmedImpl(runtimeState.selectionStates);
  }

  // -------------------------------------------------------------------------
  // Castle selection tick + finish
  // -------------------------------------------------------------------------

  function tickSelection(dt: number) {
    const remoteHumanSlots = runtimeState.frameCtx.remoteHumanSlots;
    tickSelectionPhase({
      dt,
      state: runtimeState.state,
      isHost: runtimeState.frameCtx.hostAtFrameStart,
      myPlayerId: runtimeState.frameCtx.myPlayerId,
      selectTimer: SELECT_TIMER,
      accum: runtimeState.accum,
      selectionStates: runtimeState.selectionStates,
      remoteHumanSlots,
      controllers: runtimeState.controllers,
      render: deps.render,
      confirmSelectionAndStartBuild: (pid, isReselect) =>
        confirmSelectionAndStartBuild(pid, isReselect ?? false),
      allSelectionsConfirmed,
      allBuildsComplete: () =>
        runtimeState.castleBuilds.length === 0 &&
        runtimeState.state.players.every(
          (player) =>
            !player.homeTower ||
            getInterior(player).size > 0 ||
            player.eliminated,
        ),
      tickActiveBuilds: tickAllCastleBuilds,
      announcementDuration: SELECT_ANNOUNCEMENT_DURATION,
      setFrameAnnouncement: (text) => {
        runtimeState.frame.announcement = text;
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

  /** Reset the overlay selection to its clean initial state (no highlights, no selection). */
  function resetOverlaySelection() {
    runtimeState.overlay.selection = { highlighted: null, selected: null };
  }

  function finalizeAndAdvance(): void {
    runtimeState.banner.prevEntities = snapshotEntities(runtimeState.state);
    finalizeCastleConstruction(runtimeState.state);
    enterCannonPlacePhase(runtimeState.state);
    deps.camera.clearCastleBuildViewport();
    advanceToCannonPhase();
  }

  function finishSelection() {
    if (!finishSelectionPhase(runtimeState.state, runtimeState.selectionStates))
      return;
    resetOverlaySelection();
    finalizeAndAdvance();
  }

  function startPlayerCastleBuild(playerId: ValidPlayerSlot): void {
    if (!runtimeState.frameCtx.hostAtFrameStart) return; // non-host builds via castle_walls message
    const plan = prepareCastleWallsForPlayer(runtimeState.state, playerId);
    if (!plan) return;
    deps.send({ type: MESSAGE.CASTLE_WALLS, plans: [plan] });
    const human = deps.pointerPlayer();
    runtimeState.castleBuilds.push(createCastleBuildState([plan]));
    // Only zoom to the human player's castle build
    if (human && playerId === human.playerId) {
      deps.camera.setCastleBuildViewport([plan]);
    }
  }

  function tickAllCastleBuilds(dt: number): void {
    let anyPlaced = false;
    const humanPid = deps.pointerPlayer()?.playerId ?? -1;
    let humanBuildDone = false;
    for (let i = runtimeState.castleBuilds.length - 1; i >= 0; i--) {
      const build = runtimeState.castleBuilds[i]!;
      const result = tickCastleBuildAnimation({
        castleBuild: build,
        dt,
        wallBuildIntervalMs: WALL_BUILD_INTERVAL,
        state: runtimeState.state,
        render: () => {},
        onWallsPlaced: () => {
          anyPlaced = true;
        },
      });
      if (!result.next) {
        for (const plan of build.wallPlans)
          deps.sound.chargeFanfare(plan.playerId);
        if (build.wallPlans.some((plan) => plan.playerId === humanPid))
          humanBuildDone = true;
        runtimeState.castleBuilds.splice(i, 1);
      } else {
        runtimeState.castleBuilds[i] = result.next;
      }
    }
    if (anyPlaced) recheckTerritoryOnly(runtimeState.state);
    // Unzoom once human player's castle build animation finishes
    if (humanBuildDone) {
      deps.camera.clearCastleBuildViewport();
      deps.camera.clearPhaseZoom();
    }
  }

  function showBuildScoreDeltas(onDone: () => void): void {
    // Guard: prevent re-entrancy (onDone callbacks must not restart the display)
    if (runtimeState.scoreDeltaTimer > 0) {
      onDone();
      return;
    }
    // Compute score deltas from the build phase (with display coordinates)
    runtimeState.scoreDeltas = runtimeState.state.players
      .map((player, i) => {
        const ht = player.homeTower;
        const px = ht ? towerCenterPx(ht) : { x: 0, y: 0 };
        return {
          playerId: i as ValidPlayerSlot,
          delta: player.score - (runtimeState.preScores[i] ?? 0),
          total: player.score,
          cx: px.x,
          cy: px.y - TILE_SIZE, // just above the tower
        };
      })
      .filter(
        (scoreDelta) =>
          scoreDelta.delta > 0 &&
          !runtimeState.state.players[scoreDelta.playerId]!.eliminated,
      );

    if (runtimeState.scoreDeltas.length > 0) {
      deps.camera.clearPhaseZoom();
      runtimeState.scoreDeltaTimer = SCORE_DELTA_DISPLAY_TIME;
      runtimeState.scoreDeltaOnDone = onDone;
    } else {
      onDone();
    }
  }

  function advanceToCannonPhase(): void {
    advanceToCannonPlacePhase(runtimeState.state, nextPhase);
    deps.startCannonPhase(() => {
      runtimeState.mode = Mode.GAME;
    });
  }

  function tickCastleBuild(dt: number): void {
    tickAllCastleBuilds(dt);
    deps.render();
    if (runtimeState.castleBuilds.length === 0) {
      fireOnce(runtimeState, "castleBuildOnDone");
    }
  }

  // -------------------------------------------------------------------------
  // Reselection
  // -------------------------------------------------------------------------

  function startReselection() {
    const remoteHumanSlots = runtimeState.frameCtx.remoteHumanSlots;
    enterCastleReselectPhase(runtimeState.state);
    resetSelectionState();

    const { remaining, needsUI } = processReselectionQueue({
      reselectQueue: runtimeState.reselectQueue,
      state: runtimeState.state,
      controllers: runtimeState.controllers,
      initTowerSelection: initPlayerTowerSelection,
      processPlayer: (pid, ctrl, zone) => {
        if (isRemoteHuman(pid, remoteHumanSlots)) return "pending" as const;
        ctrl.selectReplacementTower(runtimeState.state, zone);
        // AI confirms via selectionTick(); humans need UI interaction
        return "pending" as const;
      },
      onDone: (pid, ctrl) => {
        const player = runtimeState.state.players[pid]!;
        if (player.homeTower)
          ctrl.centerOn(player.homeTower.row, player.homeTower.col);
        markPlayerReselected(runtimeState.state, pid);
        runtimeState.reselectionPids.push(pid);
      },
    });
    runtimeState.reselectQueue = remaining.length > 0 ? remaining : [];

    if (needsUI) {
      syncSelectionOverlay();
      (runtimeState.accum as MutableAccums).select = 0;
      runtimeState.state.timer = SELECT_TIMER;
      runtimeState.mode = Mode.SELECTION;
      deps.sound.drumsStart();
      if (runtimeState.frameCtx.hostAtFrameStart) {
        deps.send({ type: MESSAGE.SELECT_START, timer: SELECT_TIMER });
      }
    } else {
      finishReselection();
    }
  }

  function finishReselection() {
    completeReselection({
      state: runtimeState.state,
      selectionStates: runtimeState.selectionStates,
      resetOverlaySelection,
      reselectQueue: runtimeState.reselectQueue,
      reselectionPids: runtimeState.reselectionPids,
      finalizeAndAdvance,
    });
  }

  // ---------------------------------------------------------------------------
  // Public API (matches RuntimeSelection + extras)
  // ---------------------------------------------------------------------------

  return {
    getStates: () => runtimeState.selectionStates,
    init: initPlayerTowerSelection,
    enter: enterTowerSelection,
    syncOverlay: syncSelectionOverlay,
    highlight: highlightTowerForPlayer,
    confirmAndStartBuild: confirmSelectionAndStartBuild,
    allConfirmed: allSelectionsConfirmed,
    tick: tickSelection,
    finish: finishSelection,
    advanceToCannonPhase,
    tickCastleBuild,
    setCastleBuildViewport: (
      plans: readonly { playerId: ValidPlayerSlot; tiles: number[] }[],
    ) => deps.camera.setCastleBuildViewport(plans),
    startReselection,
    finishReselection,
    showBuildScoreDeltas,
  };
}
