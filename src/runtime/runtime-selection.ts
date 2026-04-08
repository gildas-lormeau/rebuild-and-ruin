/**
 * Selection sub-system factory — owns tower selection, castle building,
 * reselection, and the advance-to-cannon-phase transition.
 *
 * Extracted from runtime.ts to reduce its size.  Follows the same
 * factory-with-deps pattern as runtime-camera.ts.
 */

import { selectionFacade } from "../game/selection-facade.ts";
import {
  SELECT_ANNOUNCEMENT_DURATION,
  SELECT_TIMER,
  WALL_BUILD_INTERVAL,
} from "../shared/game-constants.ts";
import { isReselectPhase, Phase } from "../shared/game-phase.ts";
import type { CastleWallPlan } from "../shared/interaction-types.ts";
import type { EntityOverlay, RenderOverlay } from "../shared/overlay-types.ts";
import { isActivePlayer, type ValidPlayerSlot } from "../shared/player-slot.ts";
import {
  type InputReceiver,
  isHuman,
  type PlayerController,
  type SoundSystem,
} from "../shared/system-interfaces.ts";
import {
  ACCUM_SELECT,
  isRemoteHuman,
  resetAccum,
} from "../shared/tick-context.ts";
import type { SelectionState } from "../shared/types.ts";
import { Mode } from "../shared/ui-mode.ts";
import { fireOnce } from "../shared/utils.ts";
import {
  type RuntimeState,
  resetFrameTiming,
  setMode,
} from "./runtime-state.ts";
import type { CameraSystem, RuntimeSelection } from "./runtime-types.ts";

interface SelectionSystemDeps {
  runtimeState: RuntimeState;
  /** True when this client is the host (drives castle wall generation + broadcasts). */
  hostAtFrameStart: () => boolean;

  // Networking (named sends — protocol knowledge stays in composition root)
  sendTowerSelected: (
    playerId: ValidPlayerSlot,
    towerIdx: number,
    confirmed: boolean,
  ) => void;
  sendCastleWalls: (plans: readonly CastleWallPlan[]) => void;
  sendSelectStart: (timer: number) => void;
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
  /** Clear stale banner snapshots when selection state is reset (e.g. after life lost). */
  clearBannerSnapshots: () => void;
  /** Store entity snapshot for banner before/after comparison. */
  setPrevEntities: (entities: EntityOverlay) => void;

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
    runtimeState.selection.states.clear();
    runtimeState.selection.reselectionPids = [];
    resetOverlaySelection();
    deps.clearBannerSnapshots();
  }

  // -------------------------------------------------------------------------
  // Tower selection helpers
  // -------------------------------------------------------------------------

  function initPlayerTowerSelection(pid: ValidPlayerSlot, zone: number): void {
    selectionFacade.initTowerSelection(
      runtimeState.state,
      runtimeState.selection.states,
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

    const { state } = runtimeState;
    const isHost = deps.hostAtFrameStart();
    const { myPlayerId, remoteHumanSlots } = runtimeState.frameMeta;

    deps.log(
      `enterTowerSelection (phase=${Phase[state.phase]}, round=${state.round})`,
    );

    const isWatcher = !isHost && !isActivePlayer(myPlayerId);

    // Non-host active player joining mid-game needs reselect phase
    if (!isHost && isActivePlayer(myPlayerId)) {
      const needsCastleReselect = state.phase !== Phase.CASTLE_SELECT;
      if (needsCastleReselect && !isReselectPhase(state.phase)) {
        selectionFacade.enterCastleReselectPhase(state);
      }
    }

    // Determine which players need selectInitialTower:
    //   Watcher: nobody — just observing
    //   Non-host player: only myPlayerId — remote players handled by host
    //   Host: all non-remote-humans — host drives AI + local player
    const shouldSelect = (pid: ValidPlayerSlot): boolean => {
      if (isWatcher) return false;
      if (!isHost) return pid === myPlayerId;
      return !isRemoteHuman(pid, remoteHumanSlots);
    };

    runtimeState.selection.states.clear();
    for (let i = 0; i < state.players.length; i++) {
      const pid = i as ValidPlayerSlot;
      const zone = state.playerZones[i]!;
      if (shouldSelect(pid)) {
        runtimeState.controllers[i]!.selectInitialTower(state, zone);
      }
      initPlayerTowerSelection(pid, zone);
    }

    runtimeState.overlay = {
      selection: { highlighted: null, selected: null },
    };
    syncSelectionOverlay();
    resetAccum(runtimeState.accum, ACCUM_SELECT);
    selectionFacade.initSelectionTimer(state);
    setMode(runtimeState, Mode.SELECTION);
    deps.sound.drumsStart();
    resetFrameTiming(runtimeState);
    deps.requestFrame();
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
      runtimeState.selection.states,
      visible,
    );
  }

  /** Highlight a tower for a player's selection UI. */
  function highlightTowerForPlayer(
    idx: number,
    zone: number,
    pid: ValidPlayerSlot,
  ): void {
    const changed = selectionFacade.highlightTowerSelection(
      runtimeState.state,
      runtimeState.selection.states,
      idx,
      zone,
      pid,
    );
    if (!changed) return;

    deps.sendTowerSelected(pid, idx, false);
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
    const result = selectionFacade.confirmTowerSelection(
      runtimeState.state,
      runtimeState.selection.states,
      runtimeState.controllers,
      pid,
      isReselect,
    );
    if (!result)
      return selectionFacade.allSelectionsConfirmed(
        runtimeState.selection.states,
      );

    deps.sendTowerSelected(pid, result.towerIdx, true);

    if (result.isReselect) {
      selectionFacade.markPlayerReselected(runtimeState.state, pid);
      runtimeState.selection.reselectionPids.push(pid);
    }

    syncSelectionOverlay();
    deps.render();
    if (deps.hostAtFrameStart()) startPlayerCastleBuild(pid);
    return result.allDone;
  }

  /** Alias for allSelectionsConfirmed() — returns true when every player's selection is confirmed.
   *  Named `allConfirmed` for brevity in the public API; the underlying function is
   *  allSelectionsConfirmed() in selection.ts. */
  function allSelectionsConfirmed(): boolean {
    return selectionFacade.allSelectionsConfirmed(
      runtimeState.selection.states,
    );
  }

  // -------------------------------------------------------------------------
  // Castle selection tick + finish
  // -------------------------------------------------------------------------

  function tickSelection(dt: number) {
    const remoteHumanSlots = runtimeState.frameMeta.remoteHumanSlots;
    selectionFacade.tickSelectionPhase({
      dt,
      state: runtimeState.state,
      isHost: deps.hostAtFrameStart(),
      myPlayerId: runtimeState.frameMeta.myPlayerId,
      accum: runtimeState.accum,
      selectionStates: runtimeState.selection.states,
      remoteHumanSlots,
      controllers: runtimeState.controllers,
      render: deps.render,
      confirmSelectionAndStartBuild: (pid, isReselect) =>
        confirmSelectionAndStartBuild(pid, isReselect ?? false),
      allSelectionsConfirmed,
      allBuildsComplete: () =>
        runtimeState.selection.castleBuilds.length === 0 &&
        selectionFacade.allPlayersHaveTerritory(runtimeState.state),
      tickActiveBuilds: (dt: number) => {
        if (tickAllCastleBuilds(dt))
          selectionFacade.recheckTerritoryOnly(runtimeState.state);
      },
      announcementDuration: SELECT_ANNOUNCEMENT_DURATION,
      setFrameAnnouncement: (text) => {
        runtimeState.frame.announcement = text;
      },
      finishReselection,
      finishSelection,
      syncSelectionOverlay,
      sendOpponentTowerSelected: deps.sendTowerSelected,
    });
  }

  /** Reset the overlay selection to its clean initial state (no highlights, no selection). */
  function resetOverlaySelection() {
    runtimeState.overlay.selection = { highlighted: null, selected: null };
  }

  function finalizeAndAdvance(): void {
    const prevEntities = selectionFacade.snapshotAndFinalizeForCannonPhase(
      runtimeState.state,
    );
    deps.setPrevEntities(prevEntities);
    deps.camera.clearCastleBuildViewport();
    deps.startCannonPhase(() => {
      setMode(runtimeState, Mode.GAME);
    });
  }

  function finishSelection() {
    if (
      !selectionFacade.finishSelectionPhase(
        runtimeState.state,
        runtimeState.selection.states,
      )
    )
      return;
    resetOverlaySelection();
    finalizeAndAdvance();
  }

  /** Generate + broadcast castle walls for a confirmed player.
   *  Caller must guard with isHost() — non-hosts receive walls via network. */
  function startPlayerCastleBuild(playerId: ValidPlayerSlot): void {
    const plan = selectionFacade.prepareCastleWallsForPlayer(
      runtimeState.state,
      playerId,
    );
    if (!plan) return;
    deps.sendCastleWalls([plan]);
    const human = deps.pointerPlayer();
    runtimeState.selection.castleBuilds.push(
      selectionFacade.createCastleBuildState([plan]),
    );
    // Only zoom to the human player's castle build
    if (human && playerId === human.playerId) {
      deps.camera.setCastleBuildViewport([plan]);
    }
  }

  /** Tick castle build animations. Returns true if any wall tiles were placed
   *  this frame (caller is responsible for territory recheck). */
  function tickAllCastleBuilds(dt: number): boolean {
    let anyPlaced = false;
    const humanPid = deps.pointerPlayer()?.playerId ?? -1;
    let humanBuildDone = false;
    for (let i = runtimeState.selection.castleBuilds.length - 1; i >= 0; i--) {
      const build = runtimeState.selection.castleBuilds[i]!;
      const result = selectionFacade.tickCastleBuildAnimation({
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
        runtimeState.selection.castleBuilds.splice(i, 1);
      } else {
        runtimeState.selection.castleBuilds[i] = result.next;
      }
    }
    // Unzoom once human player's castle build animation finishes
    if (humanBuildDone) {
      deps.camera.clearCastleBuildViewport();
      deps.camera.clearPhaseZoom();
    }
    return anyPlaced;
  }

  function tickCastleBuild(dt: number): void {
    if (tickAllCastleBuilds(dt))
      selectionFacade.recheckTerritoryOnly(runtimeState.state);
    deps.render();
    if (runtimeState.selection.castleBuilds.length === 0) {
      fireOnce(runtimeState.selection, "castleBuildOnDone");
    }
  }

  // -------------------------------------------------------------------------
  // Reselection
  // -------------------------------------------------------------------------

  function startReselection() {
    const remoteHumanSlots = runtimeState.frameMeta.remoteHumanSlots;
    selectionFacade.enterCastleReselectPhase(runtimeState.state);
    resetSelectionState();

    const { remaining, needsUI } = selectionFacade.processReselectionQueue({
      reselectQueue: runtimeState.selection.reselectQueue,
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
        selectionFacade.markPlayerReselected(runtimeState.state, pid);
        runtimeState.selection.reselectionPids.push(pid);
      },
    });
    runtimeState.selection.reselectQueue =
      remaining.length > 0 ? remaining : [];

    if (needsUI) {
      syncSelectionOverlay();
      resetAccum(runtimeState.accum, ACCUM_SELECT);
      selectionFacade.initSelectionTimer(runtimeState.state);
      setMode(runtimeState, Mode.SELECTION);
      deps.sound.drumsStart();
      if (deps.hostAtFrameStart()) {
        deps.sendSelectStart(SELECT_TIMER);
      }
    } else {
      finishReselection();
    }
  }

  function finishReselection() {
    selectionFacade.completeReselection({
      state: runtimeState.state,
      selectionStates: runtimeState.selection.states,
      resetOverlaySelection,
      reselectQueue: runtimeState.selection.reselectQueue,
      reselectionPids: runtimeState.selection.reselectionPids,
      finalizeAndAdvance,
    });
  }

  /** Full reset for game restart / rematch. Clears all selection, reselection,
   *  and castle-build state. Distinct from resetSelectionState() which only
   *  clears per-round selection tracking for the next selection phase. */
  function reset(): void {
    runtimeState.selection.reselectQueue = [];
    runtimeState.selection.reselectionPids = [];
    runtimeState.selection.castleBuilds = [];
    runtimeState.selection.castleBuildOnDone = null;
    runtimeState.selection.states.clear();
  }

  // ---------------------------------------------------------------------------
  // Public API (matches RuntimeSelection)
  // ---------------------------------------------------------------------------

  return {
    getStates: () => runtimeState.selection.states,
    init: initPlayerTowerSelection,
    enter: enterTowerSelection,
    syncOverlay: syncSelectionOverlay,
    highlight: highlightTowerForPlayer,
    confirmAndStartBuild: confirmSelectionAndStartBuild,
    allConfirmed: allSelectionsConfirmed,
    tick: tickSelection,
    finish: finishSelection,
    advanceToCannonPhase: () => {
      selectionFacade.enterCannonPlacePhase(runtimeState.state);
      deps.startCannonPhase(() => {
        setMode(runtimeState, Mode.GAME);
      });
    },
    tickCastleBuild,
    setCastleBuildViewport: (
      plans: readonly { playerId: ValidPlayerSlot; tiles: number[] }[],
    ) => deps.camera.setCastleBuildViewport(plans),
    startReselection,
    finishReselection,
    reset,
  };
}
