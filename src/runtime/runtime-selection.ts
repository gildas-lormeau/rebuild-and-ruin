import {
  allSelectionsConfirmed,
  confirmTowerSelection,
  enterSelectionPhase,
  finishSelectionPhase,
  highlightTowerSelection,
  isSelectionComplete,
  prepareCastleWallsForPlayer,
  recheckTerritory,
} from "../game/index.ts";
import { DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS } from "../shared/core/action-schedule.ts";
import {
  SELECT_ANNOUNCEMENT_DURATION,
  SELECT_TIMER,
  WALL_BUILD_INTERVAL,
} from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import {
  type InputReceiver,
  isHuman,
  type PlayerController,
} from "../shared/core/system-interfaces.ts";
import type { SelectionState } from "../shared/core/types.ts";
import type { RenderOverlay } from "../shared/ui/overlay-types.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import { BANNER_SELECT } from "./banner-messages.ts";
import {
  createCastleBuildState,
  tickCastleBuildAnimation,
} from "./runtime-castle-build.ts";
import { type RuntimeState, setMode } from "./runtime-state.ts";
import {
  ACCUM_SELECT,
  isRemotePlayer,
  type MutableAccums,
  resetAccum,
} from "./runtime-tick-context.ts";
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
    applyAt?: number,
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
  dispatchAdvanceToCannon: () => void;
  /** Dispatch the `castle-done` transition. Called from both the round-1
   *  initial-selection path and the reselect-cycle finish path. */
  dispatchCastleDone: () => void;
}

export function createSelectionSystem(
  deps: SelectionSystemDeps,
): RuntimeSelection {
  const { runtimeState } = deps;

  /** Clear all selection tracking state — call before entering a new selection
   *  round (initial selection or reselection). Resets selectionStates map and
   *  overlay selection display. Banner prev-scene snapshots no longer need
   *  explicit clearing here: they live on `runtimeState.banner` which is
   *  reset to a fresh struct when the banner ends (`runtime-banner.ts`), so
   *  by the time a selection reset runs the prevScene field is already
   *  undefined. */
  function resetSelectionState(): void {
    runtimeState.selection.states.clear();
    resetOverlaySelection();
  }

  // -------------------------------------------------------------------------
  // Tower selection helpers
  // -------------------------------------------------------------------------

  /** Enter CASTLE_SELECT for the initial cycle (omit `cycleQueue`) or the
   *  reselect cycle (pass the list of players who lost a life). Initial
   *  cycle = bootstrap path: runs once at game start (round 1) and on
   *  watcher SELECT_START. Reselect cycle = mid-game; the queue is
   *  precomputed by the life-lost dialog. */
  function enterTowerSelection(cycleQueue?: readonly ValidPlayerSlot[]): void {
    const { state } = runtimeState;
    const { remotePlayerSlots } = runtimeState.frameMeta;

    deps.log(
      `enterTowerSelection (phase=${Phase[state.phase]}, round=${state.round})`,
    );
    setMode(runtimeState, Mode.SELECTION);

    const slots: readonly ValidPlayerSlot[] =
      cycleQueue ?? state.players.map((_, i) => i as ValidPlayerSlot);

    resetSelectionState();

    // Engine owns phase flip + selection-state init + timer. Watchers
    // joining mid-game (whose local phase may still reflect a prior
    // round's WALL_BUILD) get their phase flipped here too. The reselect
    // cycle passes the queue so only those players get a selection state.
    enterSelectionPhase(state, runtimeState.selection.states, cycleQueue);

    // Per-player runtime setup: drive non-remote-human slots (AI + own
    // local human). AI selection ticks deterministically from
    // `strategy.rng`, so every peer derives identical `homeTower`
    // sequences without wire chatter. Remote humans (other peers' input)
    // come in via OPPONENT_TOWER_SELECTED.
    for (const pid of slots) {
      const zone = state.playerZones[pid] ?? 0;
      const ctrl = runtimeState.controllers[pid]!;
      if (!isRemotePlayer(pid, remotePlayerSlots)) {
        ctrl.selectTower(state, zone);
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

    syncSelectionOverlay();
    resetAccum(runtimeState.accum, ACCUM_SELECT);
  }

  function syncSelectionOverlay(): void {
    const visible = new Set<number>();
    if (isReady()) {
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

  function isReady(): boolean {
    return (
      runtimeState.accum.selectAnnouncement >= SELECT_ANNOUNCEMENT_DURATION
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
  /** Internal: actually commit the tower-selection (selectionStates +
   *  state.rng-consuming castle-wall plan). Caller decides when this fires
   *  — locally driven human confirmations and network-received confirms
   *  defer this to the lockstep `applyAt`; AI / non-human local
   *  confirmations apply immediately. */
  function applyConfirmedSelection(pid: ValidPlayerSlot): void {
    const result = confirmTowerSelection(
      runtimeState.state,
      runtimeState.selection.states,
      pid,
      (row, col) => runtimeState.controllers[pid]!.centerOn(row, col),
    );
    if (!result) return;
    syncSelectionOverlay();
    deps.requestRender();
    // Both host and watcher run startPlayerCastleBuild — derives wall plan
    // locally via prepareCastleWallsForPlayer (consumes state.rng) and
    // queues animation. No wire payload: state.rng is in sync because the
    // schedule fires at the same `applyAt` on every peer.
    startPlayerCastleBuild(pid);
  }

  function confirmSelectionAndStartBuild(
    pid: ValidPlayerSlot,
    source: "local" | "network" = "local",
    applyAtFromWire?: number,
  ): boolean {
    const selectionState = runtimeState.selection.states.get(pid);
    const allConfirmed = () =>
      allSelectionsConfirmed(runtimeState.selection.states);
    if (!selectionState || selectionState.confirmed) return allConfirmed();
    if (selectionState.highlighted === undefined) return allConfirmed();

    const ctrl = runtimeState.controllers[pid]!;
    const isLocalHumanBroadcast = source === "local" && isHuman(ctrl);

    // Lockstep: human-driven confirms (own peer broadcasts, other peers
    // receive over wire) defer the apply to `applyAt` so castle-wall RNG
    // consumption and `selectionStates.confirmed` transitions align across
    // peers. Non-human local confirms (AI, timer-fallback for AI) keep the
    // immediate-apply semantics — clone-everywhere already guarantees both
    // peers run the same logic at the same simTick.
    if (isLocalHumanBroadcast) {
      const applyAt =
        runtimeState.state.simTick + DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS;
      const towerIdx = selectionState.highlighted;
      deps.sendTowerSelected(pid, towerIdx, true, applyAt);
      runtimeState.actionSchedule.schedule({
        applyAt,
        playerId: pid,
        apply: () => applyConfirmedSelection(pid),
      });
      return false;
    }

    if (source === "network" && applyAtFromWire !== undefined) {
      runtimeState.actionSchedule.schedule({
        applyAt: applyAtFromWire,
        playerId: pid,
        apply: () => applyConfirmedSelection(pid),
      });
      return false;
    }

    // Immediate apply: AI confirmations (no wire), and a defensive fallback
    // for any caller that doesn't supply an `applyAt` for the network path.
    applyConfirmedSelection(pid);
    return allConfirmed();
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
    for (const [rawPid, selectionState] of selection.states) {
      const pid = rawPid as ValidPlayerSlot;
      if (selectionState.confirmed) continue;
      if (isRemotePlayer(pid, remotePlayerSlots)) continue;

      const ctrl = runtimeState.controllers[pid]!;
      const towerBefore = state.players[pid]!.homeTower;
      if (ctrl.selectionTick(dt, state)) {
        confirmSelectionAndStartBuild(pid);
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
        confirmSelectionAndStartBuild(pid);
      }
    }

    // Advance to next phase when all confirmed and builds complete.
    // Engine combines "all confirmed" + "all have territory"; runtime adds
    // the castle-build animation gate (runtime-owned state).
    if (
      selection.castleBuilds.length === 0 &&
      isSelectionComplete(state, selection.states)
    ) {
      finishSelection();
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
    // castle-done's mutate handles finalizeRoundCleanup (round > 1) +
    // finalizeFreshCastles + finalizeCastleConstruction +
    // clearCastleBuildViewport + enterCannonPhase + cannon-start broadcast.
    deps.dispatchCastleDone();
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
      deps.camera.setCastleBuildViewport(playerId);
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
  }

  /** Full reset for game restart / rematch. Clears all selection and
   *  castle-build state. Distinct from resetSelectionState() which only
   *  clears per-round selection tracking for the next selection phase. */
  function reset(): void {
    runtimeState.selection.castleBuilds = [];
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
    isReady,
    tick: tickSelection,
    finish: finishSelection,
    advanceToCannonPhase: () => {
      // enterCannonPhase (inside dispatchAdvanceToCannon → runTransition)
      // handles the phase flip + banner + setMode(GAME) via the
      // transition's postDisplay.
      deps.dispatchAdvanceToCannon();
    },
    tickCastleBuild,
    reset,
  };
}
