import {
  allSelectionsConfirmed,
  confirmTowerSelection,
  enterCastleReselectPhase,
  enterReselectPhase,
  enterSelectionPhase,
  finalizeReselectedPlayers,
  finishSelectionPhase,
  highlightTowerSelection,
  isSelectionComplete,
  prepareCastleWallsForPlayer,
  recheckTerritory,
  snapshotAndFinalizeForCannonPhase,
} from "../game/index.ts";
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
  isRemotePlayer,
  type MutableAccums,
  resetAccum,
} from "../shared/tick-context.ts";
import type { SelectionState } from "../shared/types.ts";
import { Mode } from "../shared/ui-mode.ts";
import { fireOnce } from "../shared/utils.ts";
import { BANNER_SELECT } from "./banner-messages.ts";
import {
  createCastleBuildState,
  tickCastleBuildAnimation,
} from "./runtime-castle-build.ts";
import {
  type RuntimeState,
  resetFrameTiming,
  setMode,
} from "./runtime-state.ts";
import type {
  CameraSystem,
  RuntimeSelection,
  TimingApi,
} from "./runtime-types.ts";

interface SelectionSystemDeps {
  runtimeState: RuntimeState;
  /** Injected timing primitives — replaces bare `performance.now()` access
   *  needed by `resetFrameTiming` after a mode transition. */
  timing: TimingApi;
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

  function enterTowerSelection(): void {
    resetSelectionState();

    const { state } = runtimeState;
    const isHost = deps.hostAtFrameStart();
    const { myPlayerId, remotePlayerSlots } = runtimeState.frameMeta;

    deps.log(
      `enterTowerSelection (phase=${Phase[state.phase]}, round=${state.round})`,
    );

    const isWatcher = !isHost && !isActivePlayer(myPlayerId);

    // Non-host active player joining mid-game needs reselect phase
    if (!isHost && isActivePlayer(myPlayerId)) {
      const needsCastleReselect = state.phase !== Phase.CASTLE_SELECT;
      if (needsCastleReselect && !isReselectPhase(state.phase)) {
        enterCastleReselectPhase(state);
      }
    }

    // Engine owns selection-state init + timer.
    enterSelectionPhase(state, runtimeState.selection.states);

    // Per-player runtime setup: AI/controller init for drivable slots,
    // camera zoom for humans. Runs after the engine has populated
    // selectionStates + player.homeTower defaults.
    //
    // Drivable slot policy:
    //   Watcher: nobody — just observing
    //   Non-host player: only myPlayerId — remote players handled by host
    //   Host: all non-remote-humans — host drives AI + local player
    const shouldSelect = (pid: ValidPlayerSlot): boolean => {
      if (isWatcher) return false;
      if (!isHost) return pid === myPlayerId;
      return !isRemotePlayer(pid, remotePlayerSlots);
    };

    for (let i = 0; i < state.players.length; i++) {
      const pid = i as ValidPlayerSlot;
      const zone = state.playerZones[i]!;
      if (shouldSelect(pid)) {
        runtimeState.controllers[i]!.selectInitialTower(state, zone);
      }
      if (isHuman(runtimeState.controllers[pid]!)) {
        const player = state.players[pid];
        if (player?.homeTower)
          deps.camera.setSelectionViewport(
            player.homeTower.row,
            player.homeTower.col,
          );
      }
    }

    runtimeState.overlay = {
      selection: { highlighted: null, selected: null },
    };
    syncSelectionOverlay();
    resetAccum(runtimeState.accum, ACCUM_SELECT);
    setMode(runtimeState, Mode.SELECTION);
    deps.sound.drumsStart();
    resetFrameTiming(runtimeState, deps.timing.now());
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
    const changed = highlightTowerSelection(
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
    const result = confirmTowerSelection(
      runtimeState.state,
      runtimeState.selection.states,
      pid,
      isReselect,
      (row, col) => runtimeState.controllers[pid]!.centerOn(row, col),
    );
    if (!result) return allSelectionsConfirmed(runtimeState.selection.states);

    deps.sendTowerSelected(pid, result.towerIdx, true);

    if (result.isReselect) {
      runtimeState.selection.reselectionPids.push(pid);
    }

    syncSelectionOverlay();
    deps.render();
    if (deps.hostAtFrameStart()) startPlayerCastleBuild(pid);
    return result.allDone;
  }

  function allConfirmed(): boolean {
    return allSelectionsConfirmed(runtimeState.selection.states);
  }

  // -------------------------------------------------------------------------
  // Castle selection tick + finish
  // -------------------------------------------------------------------------

  function tickSelection(dt: number) {
    const { state, accum, selection } = runtimeState;
    const remotePlayerSlots = runtimeState.frameMeta.remotePlayerSlots;
    const isHost = deps.hostAtFrameStart();
    const myPlayerId = runtimeState.frameMeta.myPlayerId;

    // Advance announcement / selection timer (blessed mutation site — see MutableAccums)
    const mutAccum = accum as MutableAccums;
    if (accum.selectAnnouncement < SELECT_ANNOUNCEMENT_DURATION) {
      mutAccum.selectAnnouncement += dt;
      runtimeState.frame.announcement = BANNER_SELECT;
      state.timer = 0;
    } else {
      mutAccum.select += dt;
      state.timer = Math.max(0, SELECT_TIMER - accum.select);
    }

    // Non-host watcher: just render
    if (!isHost && !isActivePlayer(myPlayerId)) {
      deps.render();
      return;
    }

    // Non-host active player: auto-confirm on timer expiry
    if (!isHost && isActivePlayer(myPlayerId)) {
      if (accum.select >= SELECT_TIMER) {
        confirmSelectionAndStartBuild(myPlayerId, isReselectPhase(state.phase));
      }
      deps.render();
      return;
    }

    // Host: block selection until announcement finishes
    if (accum.selectAnnouncement < SELECT_ANNOUNCEMENT_DURATION) {
      deps.render();
      return;
    }
    // First frame after announcement: sync overlay so cursor appears
    if (accum.selectAnnouncement - dt < SELECT_ANNOUNCEMENT_DURATION) {
      syncSelectionOverlay();
    }

    // Tick controllers (AI + local human)
    const isReselect = isReselectPhase(state.phase);
    for (const [rawPid, selectionState] of selection.states) {
      const pid = rawPid as ValidPlayerSlot;
      if (selectionState.confirmed) continue;
      if (isRemotePlayer(pid, remotePlayerSlots)) continue;

      const towerBefore = state.players[pid]!.homeTower;
      if (runtimeState.controllers[pid]!.selectionTick(dt, state)) {
        confirmSelectionAndStartBuild(pid, isReselect);
        continue;
      }

      if (state.players[pid]!.homeTower !== towerBefore) {
        const newTower = state.players[pid]!.homeTower;
        if (newTower) {
          selectionState.highlighted = newTower.index;
          syncSelectionOverlay();
          deps.sendTowerSelected(pid, newTower.index, false);
        }
      }
    }

    // Tick castle build animations during selection
    if (tickAllCastleBuilds(dt)) {
      recheckTerritory(state);
    }

    deps.render();

    // Auto-confirm pending selections on timer expiry
    if (accum.select >= SELECT_TIMER) {
      for (const [rawPid, selectionState] of selection.states) {
        if (selectionState.confirmed) continue;
        confirmSelectionAndStartBuild(rawPid as ValidPlayerSlot, isReselect);
      }
    }

    // Advance to next phase when all confirmed and builds complete.
    // Engine combines "all confirmed" + "all have territory"; runtime adds
    // the castle-build animation gate (runtime-owned state).
    if (
      selection.castleBuilds.length === 0 &&
      isSelectionComplete(state, selection.states)
    ) {
      if (isReselect) finishReselection();
      else finishSelection();
    }
  }

  /** Reset the overlay selection to its clean initial state (no highlights, no selection). */
  function resetOverlaySelection() {
    runtimeState.overlay.selection = { highlighted: null, selected: null };
  }

  function finalizeAndAdvance(): void {
    const prevEntities = snapshotAndFinalizeForCannonPhase(runtimeState.state);
    deps.setPrevEntities(prevEntities);
    deps.camera.clearCastleBuildViewport();
    deps.startCannonPhase(() => {
      setMode(runtimeState, Mode.GAME);
    });
  }

  function finishSelection() {
    if (
      !finishSelectionPhase(runtimeState.state, runtimeState.selection.states)
    )
      return;
    resetOverlaySelection();
    finalizeAndAdvance();
  }

  /** Generate + broadcast castle walls for a confirmed player.
   *  Caller must guard with isHost() — non-hosts receive walls via network. */
  function startPlayerCastleBuild(playerId: ValidPlayerSlot): void {
    const plan = prepareCastleWallsForPlayer(runtimeState.state, playerId);
    if (!plan) return;
    deps.sendCastleWalls([plan]);
    const human = deps.pointerPlayer();
    runtimeState.selection.castleBuilds.push(createCastleBuildState([plan]));
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
    if (tickAllCastleBuilds(dt)) recheckTerritory(runtimeState.state);
    deps.render();
    if (runtimeState.selection.castleBuilds.length === 0) {
      fireOnce(runtimeState.selection, "castleBuildOnDone");
    }
  }

  // -------------------------------------------------------------------------
  // Reselection
  // -------------------------------------------------------------------------

  function startReselection() {
    const remotePlayerSlots = runtimeState.frameMeta.remotePlayerSlots;
    const { state } = runtimeState;
    resetSelectionState();

    // Engine: set CASTLE_RESELECT phase, init selection state for queued
    // players, set timer.
    enterReselectPhase(
      state,
      runtimeState.selection.states,
      runtimeState.selection.reselectQueue,
    );

    // Runtime: per-player controller (selectReplacementTower) + camera
    // setup loop. AI players auto-confirm via selectionTick(); humans
    // need UI interaction. Both paths run through the selection tick —
    // there's no "done immediately" branch (the old processReselectionQueue
    // had one but it was never reachable).
    for (const pid of runtimeState.selection.reselectQueue) {
      if (isRemotePlayer(pid, remotePlayerSlots)) continue;
      const zone = state.playerZones[pid] ?? 0;
      runtimeState.controllers[pid]!.selectReplacementTower(state, zone);
      if (isHuman(runtimeState.controllers[pid]!)) {
        const player = state.players[pid];
        if (player?.homeTower) {
          deps.camera.setSelectionViewport(
            player.homeTower.row,
            player.homeTower.col,
          );
        }
      }
    }

    if (runtimeState.selection.reselectQueue.length > 0) {
      syncSelectionOverlay();
      resetAccum(runtimeState.accum, ACCUM_SELECT);
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
    runtimeState.selection.states.clear();
    resetOverlaySelection();
    runtimeState.selection.reselectQueue.length = 0;
    finalizeReselectedPlayers(
      runtimeState.state,
      runtimeState.selection.reselectionPids,
    );
    finalizeAndAdvance();
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
    enter: enterTowerSelection,
    syncOverlay: syncSelectionOverlay,
    highlight: highlightTowerForPlayer,
    confirmAndStartBuild: confirmSelectionAndStartBuild,
    allConfirmed,
    tick: tickSelection,
    finish: finishSelection,
    advanceToCannonPhase: () => {
      // enterCannonPhase (inside startCannonPhase → applyCheckpoint) handles
      // the phase flip + preparation; no separate enterCannonPlacePhase call.
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
