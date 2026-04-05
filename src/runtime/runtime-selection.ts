/**
 * Selection sub-system factory — owns tower selection, castle building,
 * reselection, and the advance-to-cannon-phase transition.
 *
 * Extracted from runtime.ts to reduce its size.  Follows the same
 * factory-with-deps pattern as runtime-camera.ts.
 */

import { type GameMessage, MESSAGE } from "../../server/protocol.ts";
import { recheckTerritoryOnly } from "../game/build-system.ts";
import {
  createCastleBuildState,
  tickCastleBuildAnimation,
} from "../game/castle-build.ts";
import {
  enterCannonPlacePhase,
  enterCastleReselectPhase,
  markPlayerReselected,
  nextPhase,
} from "../game/game-engine.ts";
import { snapshotEntities } from "../game/phase-banner.ts";
import {
  advanceToCannonPlacePhase,
  completeReselection,
  finalizeCastleConstruction,
  prepareCastleWallsForPlayer,
  processReselectionQueue,
} from "../game/phase-setup.ts";
import {
  allSelectionsConfirmed as allSelectionsConfirmedImpl,
  confirmTowerSelection,
  finishSelectionPhase,
  highlightTowerSelection,
  initTowerSelection as initTowerSelectionImpl,
  tickSelectionPhase,
} from "../game/selection.ts";
import { getInterior } from "../shared/board-occupancy.ts";
import {
  SELECT_ANNOUNCEMENT_DURATION,
  SELECT_TIMER,
  WALL_BUILD_INTERVAL,
} from "../shared/game-constants.ts";
import { Mode } from "../shared/game-phase.ts";
import type { RenderOverlay } from "../shared/overlay-types.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import {
  type InputReceiver,
  isHuman,
  type PlayerController,
  type SoundSystem,
} from "../shared/system-interfaces.ts";
import { isRemoteHuman, resetAccum } from "../shared/tick-context.ts";
import type { SelectionState } from "../shared/types.ts";
import { fireOnce } from "../shared/utils.ts";
import { type RuntimeState, setMode } from "./runtime-state.ts";
import type {
  CameraSystem,
  EnterTowerSelectionDeps,
  RuntimeSelection,
} from "./runtime-types.ts";

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
  /** Render-domain: sync overlay highlights from selectionStates (injected from composition root). */
  syncSelectionOverlay: (
    overlay: RenderOverlay,
    selectionStates: Map<number, SelectionState>,
    visiblePlayers?: ReadonlySet<number>,
  ) => void;

  // Sibling systems / parent callbacks
  render: () => void;
  pointerPlayer: () => (PlayerController & InputReceiver) | null;
  startCannonPhase: (onBannerDone?: () => void) => void;
  /** Tower-selection entry procedure (injected from runtime-bootstrap). */
  enterTowerSelectionImpl: (deps: EnterTowerSelectionDeps) => void;
  /** Clear stale banner snapshots when selection state is reset (e.g. after life lost). */
  clearBannerSnapshots: () => void;

  /**
   * Called once during enterTowerSelection — kicks off the animation loop
   * if the runtime is currently stopped (e.g. online mode starting from DOM lobby).
   */
  requestFrame: () => void;
}

export function createSelectionSystem(
  deps: SelectionSystemDeps,
): RuntimeSelection {
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
    deps.clearBannerSnapshots();
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
    deps.enterTowerSelectionImpl({
      state: runtimeState.state,
      isHost: runtimeState.frameMeta.hostAtFrameStart,
      myPlayerId: runtimeState.frameMeta.myPlayerId,
      remoteHumanSlots: runtimeState.frameMeta.remoteHumanSlots,
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
      setModeSelection: () => {
        setMode(runtimeState, Mode.SELECTION);
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
    deps.syncSelectionOverlay(
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
    const remoteHumanSlots = runtimeState.frameMeta.remoteHumanSlots;
    tickSelectionPhase({
      dt,
      state: runtimeState.state,
      isHost: runtimeState.frameMeta.hostAtFrameStart,
      myPlayerId: runtimeState.frameMeta.myPlayerId,
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
    if (!runtimeState.frameMeta.hostAtFrameStart) return; // non-host builds via castle_walls message
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

  function advanceToCannonPhase(): void {
    advanceToCannonPlacePhase(runtimeState.state, nextPhase);
    deps.startCannonPhase(() => {
      setMode(runtimeState, Mode.GAME);
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
    const remoteHumanSlots = runtimeState.frameMeta.remoteHumanSlots;
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
      resetAccum(runtimeState.accum, "select");
      runtimeState.state.timer = SELECT_TIMER;
      setMode(runtimeState, Mode.SELECTION);
      deps.sound.drumsStart();
      if (runtimeState.frameMeta.hostAtFrameStart) {
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

  /** Full reset for game restart / rematch. Clears all selection, reselection,
   *  and castle-build state. Distinct from resetSelectionState() which only
   *  clears per-round selection tracking for the next selection phase. */
  function reset(): void {
    runtimeState.reselectQueue = [];
    runtimeState.reselectionPids = [];
    runtimeState.castleBuilds = [];
    runtimeState.castleBuildOnDone = null;
    runtimeState.selectionStates.clear();
  }

  // ---------------------------------------------------------------------------
  // Public API (matches RuntimeSelection)
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
    reset,
  };
}
