import {
  allSelectionsConfirmed,
  confirmTowerSelection,
  enterCastleReselectPhase,
  enterReselectPhase,
  enterSelectionPhase,
  finishSelectionPhase,
  highlightTowerSelection,
  isSelectionComplete,
  prepareCastleWallsForPlayer,
  recheckTerritory,
} from "../game/index.ts";
import {
  SELECT_ANNOUNCEMENT_DURATION,
  SELECT_TIMER,
  WALL_BUILD_INTERVAL,
} from "../shared/core/game-constants.ts";
import { isReselectPhase, Phase } from "../shared/core/game-phase.ts";
import {
  isActivePlayer,
  type ValidPlayerSlot,
} from "../shared/core/player-slot.ts";
import {
  type InputReceiver,
  isHuman,
  type PlayerController,
} from "../shared/core/system-interfaces.ts";
import type { SelectionState } from "../shared/core/types.ts";
import { fireOnce } from "../shared/platform/utils.ts";
import type { RenderOverlay } from "../shared/ui/overlay-types.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import { BANNER_SELECT } from "./banner-messages.ts";
import {
  createCastleBuildState,
  tickCastleBuildAnimation,
} from "./runtime-castle-build.ts";
import type { TimingApi } from "./runtime-contracts.ts";
import {
  type RuntimeState,
  resetFrameTiming,
  setMode,
} from "./runtime-state.ts";
import {
  ACCUM_SELECT,
  isRemotePlayer,
  type MutableAccums,
  resetAccum,
} from "./runtime-tick-context.ts";
import type { CameraSystem, RuntimeSelection } from "./runtime-types.ts";

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
  sendSelectStart: (timer: number) => void;
  log: (msg: string) => void;

  camera: Pick<CameraSystem, "setCastleBuildViewport" | "setSelectionViewport">;
  /** Render-domain: sync overlay highlights from selectionStates (injected from composition root). */
  syncSelectionOverlay: (
    overlay: RenderOverlay,
    selectionStates: Map<number, SelectionState>,
    visiblePlayers?: ReadonlySet<number>,
  ) => void;

  // Sibling systems / parent callbacks
  requestRender: () => void;
  pointerPlayer: () => (PlayerController & InputReceiver) | null;
  /** Dispatch the `advance-to-cannon` transition (post-life-lost continue
   *  path). */
  startCannonPhase: () => void;
  /** Dispatch the `castle-select-done` transition (round-1 / initial). */
  enterCannonAfterCastleSelect: () => void;
  /** Dispatch the `castle-reselect-done` transition (after a player who
   *  lost a life rebuilt their castle). */
  enterCannonAfterCastleReselect: (
    reselectionPids: readonly ValidPlayerSlot[],
  ) => void;
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
   *  reselectionPids, and overlay selection display. Banner prev-scene
   *  snapshots no longer need explicit clearing here: they live on
   *  `runtimeState.banner` which is reset to a fresh struct when the banner
   *  ends (`runtime-banner.ts`), so by the time a selection reset runs the
   *  prevScene field is already undefined. */
  function resetSelectionState(): void {
    runtimeState.selection.states.clear();
    runtimeState.selection.reselectionPids = [];
    resetOverlaySelection();
  }

  // -------------------------------------------------------------------------
  // Tower selection helpers
  // -------------------------------------------------------------------------

  function enterTowerSelection(): void {
    const { state } = runtimeState;
    const { myPlayerId, remotePlayerSlots } = runtimeState.frameMeta;
    const isHost = deps.hostAtFrameStart();

    deps.log(
      `enterTowerSelection (phase=${Phase[state.phase]}, round=${state.round})`,
    );

    // SELECT_START / local entry: detect reselection by inspecting state
    // (some active players have a homeTower, some don't). Reselection only
    // ticks the queued slot — re-running the full enterSelectionPhase here
    // would re-init every AI's selection and advance strategy.rng for
    // slots that didn't actually reselect, drifting state vs other peers.
    const queue: ValidPlayerSlot[] = [];
    let anyHasHome = false;
    for (let i = 0; i < state.players.length; i++) {
      const player = state.players[i];
      if (!player || player.eliminated) continue;
      if (player.homeTower) anyHasHome = true;
      else queue.push(i as ValidPlayerSlot);
    }
    if (anyHasHome && queue.length > 0) {
      runtimeState.selection.reselectQueue = queue;
      startReselection();
      return;
    }

    resetSelectionState();

    // Non-host active player joining mid-game (state.phase isn't
    // CASTLE_SELECT yet) needs to flip into the reselect phase locally.
    // Host never reaches this branch — it's the source of truth and
    // already in CASTLE_SELECT when this runs.
    if (!isHost && isActivePlayer(myPlayerId)) {
      const needsCastleReselect = state.phase !== Phase.CASTLE_SELECT;
      if (needsCastleReselect && !isReselectPhase(state.phase)) {
        enterCastleReselectPhase(state);
      }
    }

    // Engine owns selection-state init + timer.
    enterSelectionPhase(state, runtimeState.selection.states);

    // Per-player runtime setup: drive non-remote-human slots (AI + own
    // local human). AI selection ticks deterministically from
    // `strategy.rng`, so every peer derives identical `homeTower`
    // sequences without wire chatter. Remote humans (other peers' input)
    // come in via OPPONENT_TOWER_SELECTED.
    for (let i = 0; i < state.players.length; i++) {
      const pid = i as ValidPlayerSlot;
      const zone = state.playerZones[i]!;
      const ctrl = runtimeState.controllers[i]!;
      if (!isRemotePlayer(pid, remotePlayerSlots)) {
        ctrl.selectInitialTower(state, zone);
      }
      if (isHuman(ctrl)) {
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
    deps.requestRender();

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
    source: "local" | "network" = "local",
  ): boolean {
    const result = confirmTowerSelection(
      runtimeState.state,
      runtimeState.selection.states,
      pid,
      isReselect,
      (row, col) => runtimeState.controllers[pid]!.centerOn(row, col),
    );
    if (!result) return allSelectionsConfirmed(runtimeState.selection.states);

    // Only locally-driven human confirmations broadcast to the network.
    // - Local human auto-confirm / mouse confirm: source="local", sends to host.
    // - AI selection: source="local" but isHuman=false, no send.
    // - Network-received remote-human confirm (handleTowerSelected): source="network",
    //   skip send (server already relayed; an echo would be redundant).
    if (source === "local" && isHuman(runtimeState.controllers[pid]!)) {
      deps.sendTowerSelected(pid, result.towerIdx, true);
    }

    if (result.isReselect) {
      runtimeState.selection.reselectionPids.push(pid);
    }

    syncSelectionOverlay();
    deps.requestRender();
    // Both host and watcher run startPlayerCastleBuild — derives wall plan
    // locally via prepareCastleWallsForPlayer (consumes state.rng) and
    // queues animation. No wire payload: state.rng is in sync, so plans match.
    startPlayerCastleBuild(pid);
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

    // Block selection until announcement finishes — same gate on every
    // peer so the AI tick count stays in lockstep across runtimes.
    if (accum.selectAnnouncement < SELECT_ANNOUNCEMENT_DURATION) {
      deps.requestRender();
      return;
    }
    // First frame after announcement: sync overlay so cursor appears
    if (accum.selectAnnouncement - dt < SELECT_ANNOUNCEMENT_DURATION) {
      syncSelectionOverlay();
    }

    // Tick non-remote-human controllers (AI + own local human). Every peer
    // runs AI selection locally — `selectionTick` consumes `strategy.rng`
    // deterministically, so each peer derives identical homeTower
    // sequences without wire chatter. Remote-human selections come in via
    // OPPONENT_TOWER_SELECTED from the input handler on the owning peer.
    const isReselect = isReselectPhase(state.phase);
    for (const [rawPid, selectionState] of selection.states) {
      const pid = rawPid as ValidPlayerSlot;
      if (selectionState.confirmed) continue;
      if (isRemotePlayer(pid, remotePlayerSlots)) continue;

      const ctrl = runtimeState.controllers[pid]!;
      const towerBefore = state.players[pid]!.homeTower;
      if (ctrl.selectionTick(dt, state)) {
        confirmSelectionAndStartBuild(pid, isReselect);
        continue;
      }

      if (state.players[pid]!.homeTower !== towerBefore) {
        const newTower = state.players[pid]!.homeTower;
        if (newTower) {
          selectionState.highlighted = newTower.index;
          syncSelectionOverlay();
        }
      }
    }

    // Tick castle build animations during selection
    if (tickAllCastleBuilds(dt)) {
      recheckTerritory(state);
    }

    deps.requestRender();

    // Auto-confirm pending selections on timer expiry. Skip remote
    // humans — their owning peer runs the same auto-confirm and
    // broadcasts via OPPONENT_TOWER_SELECTED.
    if (accum.select >= SELECT_TIMER) {
      for (const [rawPid, selectionState] of selection.states) {
        if (selectionState.confirmed) continue;
        const pid = rawPid as ValidPlayerSlot;
        if (isRemotePlayer(pid, remotePlayerSlots)) continue;
        confirmSelectionAndStartBuild(pid, isReselect);
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

  function finishSelection() {
    if (
      !finishSelectionPhase(runtimeState.state, runtimeState.selection.states)
    )
      return;
    resetOverlaySelection();
    // Castle-select-done's mutate handles finalizeCastleConstruction +
    // clearCastleBuildViewport + enterCannonPhase + cannon-start broadcast.
    deps.enterCannonAfterCastleSelect();
  }

  /** Derive a player's castle-wall plan and queue the build animation.
   *  Run on both host and watcher: `prepareCastleWallsForPlayer` consumes
   *  state.rng (clumsy builders + wall ordering) and sets player.castle —
   *  identical RNG sequence on both sides keeps state in sync. No wire
   *  broadcast: every confirmation path (local AI, local human, network
   *  remote-human) runs this locally on every peer. */
  function startPlayerCastleBuild(playerId: ValidPlayerSlot): void {
    const plan = prepareCastleWallsForPlayer(runtimeState.state, playerId);
    if (!plan) return;
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
        runtimeState.selection.castleBuilds.splice(i, 1);
      } else {
        runtimeState.selection.castleBuilds[i] = result.next;
      }
    }
    return anyPlaced;
  }

  function tickCastleBuild(dt: number): void {
    if (tickAllCastleBuilds(dt)) recheckTerritory(runtimeState.state);
    deps.requestRender();
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
    // setup loop. Drive every non-remote-human slot in the queue —
    // AI players auto-confirm via selectionTick(); own local human
    // needs UI interaction. Remote humans (other peers' input) handled
    // on their owning peer.
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
      // Host fan-out: SELECT_START tells watchers to enter the reselect
      // phase. Self-gates via `hostAtFrameStart` since the wire is the
      // host's responsibility — watchers see this no-op and don't echo.
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
    // Castle-reselect-done's mutate handles finalizeReselectedPlayers +
    // finalizeCastleConstruction + clearCastleBuildViewport + enterCannonPhase
    // + cannon-start broadcast — we just hand it the pids.
    deps.enterCannonAfterCastleReselect(runtimeState.selection.reselectionPids);
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
      // enterCannonPhase (inside startCannonPhase → runTransition) handles
      // the phase flip + banner + setMode(GAME) via the transition's
      // postDisplay.
      deps.startCannonPhase();
    },
    tickCastleBuild,
    startReselection,
    finishReselection,
    reset,
  };
}
