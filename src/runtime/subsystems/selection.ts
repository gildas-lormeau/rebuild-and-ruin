import {
  allSelectionsConfirmed,
  confirmTowerSelection,
  enterSelectionPhase,
  finishSelectionPhase,
  highlightTowerSelection,
  isSelectionComplete,
  prepareCastleWallsForPlayer,
  recheckTerritory,
} from "../../game/index.ts";
import { DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS } from "../../shared/core/action-schedule.ts";
import { filterAliveEnclosedTowers } from "../../shared/core/board-occupancy.ts";
import { isHuman } from "../../shared/core/controller-guards.ts";
import {
  SELECT_ANNOUNCEMENT_DURATION,
  SELECT_TIMER,
  WALL_BUILD_INTERVAL,
} from "../../shared/core/game-constants.ts";
import { Phase } from "../../shared/core/game-phase.ts";
import type { TowerIdx } from "../../shared/core/geometry-types.ts";
import type { ValidPlayerId } from "../../shared/core/player-slot.ts";
import { isPlayerAlive } from "../../shared/core/player-types.ts";
import {
  type InputReceiver,
  type PlayerController,
} from "../../shared/core/system-interfaces.ts";
import type { SelectionState } from "../../shared/core/types.ts";
import type { ZoneId } from "../../shared/core/zone-id.ts";
import type { RenderOverlay } from "../../shared/ui/overlay-types.ts";
import { Mode } from "../../shared/ui/ui-mode.ts";
import { BANNER_SELECT } from "../banner-messages.ts";
import {
  createCastleBuildState,
  tickCastleBuildAnimation,
} from "../castle-build.ts";
import { type RuntimeState, setMode } from "../state.ts";
import { advancePhaseTimer, isRemotePlayer } from "../tick-context.ts";
import {
  ACCUM_SELECT,
  type MutableAccums,
  resetAccum,
} from "../timer-accums.ts";
import type { RuntimeCamera } from "./camera.ts";

/** Public selection handle exposed on `GameRuntime`. Drives the CASTLE_SELECT
 *  phase (initial cycle + reselect cycle) and the castle-build animation. */
export interface RuntimeSelection {
  getStates: () => Map<ValidPlayerId, SelectionState>;
  /** Enter CASTLE_SELECT. Omit `queue` for the initial cycle (bootstrap
   *  path: round 1 / watcher SELECT_START); pass an explicit queue for
   *  the lifeLostRoute reselect cycle. `remoteSlotsOverride` is the
   *  FULL_STATE adoption entry's live session slot set — see the impl. */
  enter: (
    queue?: readonly ValidPlayerId[],
    remoteSlotsOverride?: ReadonlySet<ValidPlayerId>,
  ) => void;
  syncOverlay: () => void;
  highlight: (idx: TowerIdx, zone: ZoneId, pid: ValidPlayerId) => void;
  confirmAndStartBuild: (
    pid: ValidPlayerId,
    source?: "local" | "network",
    applyAt?: number,
    /** Wire-supplied tower for network confirms — re-asserted at the
     *  scheduled apply so the commit matches the originator's broadcast. */
    towerIdx?: TowerIdx,
  ) => boolean;
  allConfirmed: () => boolean;
  isReady: () => boolean;
  tick: (dt: number) => void;
  finish: () => void;
  /** Full reset for game restart / rematch. */
  reset: () => void;
  /** Reconcile this subsystem's runtime-local bookkeeping with an adopted
   *  FULL_STATE snapshot landing mid-CASTLE_SELECT (host migration on a
   *  peer already inside the cycle). See the impl for the failure mode. */
  reconcileAfterAdoption: () => void;
  /** Re-draw the cycle's AI selection arming from the current state.rng
   *  cursor at a FULL_STATE boundary — promoted host post-serialize,
   *  mid-cycle adopters post-apply. See the impl for the draw-pairing
   *  contract. */
  rearmCycleControllersAfterAdoption: (
    remotePlayerSlots: ReadonlySet<ValidPlayerId>,
  ) => void;
  /** Rebuild the castle-build animation queue from the current GameState
   *  after a FULL_STATE boundary (host migration / checkpoint apply).
   *  The queue is runtime-local and its only producer is the confirm
   *  apply, so an adoption landing mid-animation would otherwise orphan
   *  every in-flight ring: walls stop placing, territory never forms,
   *  and the cycle hangs. Runs on EVERY peer — the promoted host
   *  included, replacing its live animations — so the restarted builds
   *  place walls at the same sim ticks everywhere. */
  requeueCastleBuildsFromState: () => void;
}

interface SelectionSystemDeps {
  runtimeState: RuntimeState;

  // Networking (named sends — protocol knowledge stays in composition root)
  sendTowerSelected: (
    playerId: ValidPlayerId,
    towerIdx: TowerIdx,
    confirmed: boolean,
    applyAt?: number,
  ) => void;
  log: (msg: string) => void;

  camera: Pick<RuntimeCamera, "setSelectionViewport">;
  /** Render-domain: sync overlay highlights from selectionStates (injected from composition root). */
  syncSelectionOverlay: (
    overlay: RenderOverlay,
    selectionStates: Map<ValidPlayerId, SelectionState>,
    visiblePlayers?: ReadonlySet<ValidPlayerId>,
  ) => void;

  // Sibling systems / parent callbacks
  requestRender: () => void;
  /** Drain a pending `requestRender` to the visible canvas synchronously.
   *  Called inside `finishSelection` immediately before `dispatchCastleDone`
   *  so the auto-build's final wall (placed earlier in the same tick via
   *  `tickAllCastleBuilds`, with `requestRender()` queued) reaches the
   *  visible canvas BEFORE the transition's mutate runs. The banner system
   *  then captures its A-snapshot from a canvas that already shows every
   *  pre-mutation wall — without this flush, the snapshot is one frame
   *  stale and the sweep reveals a castle missing its last wall on the
   *  pre-side. Must run before mutate, not before A-capture: flushing
   *  inside `showBanner` (after mutate) would paint the post-mutation
   *  scene onto the visible canvas, defeating the offscreen-B model. */
  flushPendingRender: () => void;
  pointerPlayer: () => (PlayerController & InputReceiver) | null;
  /** Dispatch the `castle-done` transition. Called from both the round-1
   *  initial-selection path and the reselect-cycle finish path. */
  dispatchCastleDone: () => void;
}

export function createSelectionSystem(
  deps: SelectionSystemDeps,
): RuntimeSelection {
  const { runtimeState } = deps;

  /** Slots with a confirm broadcast but not yet applied (the lockstep window
   *  between the `sendTowerSelected` broadcast and `applyAt`). Blocks
   *  duplicate sends while the selection still reads as unconfirmed — both
   *  from a repeat confirm press and from the timer-expiry auto-confirm loop
   *  re-firing every tick. Cleared per-slot when the scheduled apply fires,
   *  wholesale on selection reset. Mirrors `inFlightChoices` in
   *  subsystems/life-lost.ts (the dialogs grew this guard; selection drifted
   *  behind). */
  const inFlightConfirms = new Set<ValidPlayerId>();

  /** Clear all selection tracking state — call before entering a new selection
   *  round (initial selection or reselection). Resets selectionStates map and
   *  overlay selection display. Banner prev-scene snapshots no longer need
   *  explicit clearing here: they live on `runtimeState.banner` which is
   *  reset to a fresh struct when the banner ends (`subsystems/banner.ts`), so
   *  by the time a selection reset runs the prevScene field is already
   *  undefined. */
  function resetSelectionState(): void {
    runtimeState.selection.states.clear();
    inFlightConfirms.clear();
    resetOverlaySelection();
  }

  /** Reconcile selection bookkeeping with an adopted FULL_STATE snapshot.
   *  The snapshot carries the authoritative GameState but NOT this
   *  subsystem's map: a confirm whose scheduled apply the adoption
   *  discarded (already baked into the snapshot on the serializing host)
   *  would otherwise leave its entry unconfirmed and its slot parked in
   *  `inFlightConfirms` forever — the re-send guard blocks every later
   *  confirm AND `allConfirmed` never flips, a permanent CASTLE_SELECT
   *  hang. Derive "already picked" from the adopted state with the same
   *  predicate the rehydrate arming path uses: the player has an alive
   *  enclosed tower (their auto-castle is in the snapshot). Only the
   *  runtime-local flag flips here — the engine-side confirm effects
   *  (walls, inGracePeriod) arrived with the snapshot, so routing through
   *  `confirmTowerSelection` would double-mutate adopted state. */
  function reconcileAfterAdoption(): void {
    const { state } = runtimeState;
    for (const [pid, selectionState] of runtimeState.selection.states) {
      const player = state.players[pid];
      if (!player) continue;
      // "Already picked" = the castle-wall plan is committed. The plan
      // seeds `castleWallTiles` inside the confirm apply and the set is
      // cleared by the life-loss board reset, so non-empty ⟺ confirmed
      // THIS cycle — including a confirm whose ring is still animating,
      // which an alive-enclosed-tower predicate would miss (a mid-build
      // ring encloses nothing yet). Synced BOTH ways: a peer that ran
      // ahead of the snapshot may hold a local confirm the adopted
      // timeline hasn't reached — kept, its brain skips the seat while
      // every other peer re-confirms it (and draws the castle plan),
      // a one-peer rng fork.
      selectionState.confirmed = player.castleWallTiles.size > 0;
    }
    // Stale in-flight guards die with the discarded applies. A confirm
    // kept in the post-snapshot window still fires; its apply re-deletes
    // the (now absent) guard and confirms idempotently.
    inFlightConfirms.clear();
    syncSelectionOverlay();
  }

  /** Re-arm the cycle's controller selection brains from the current
   *  GameState at a FULL_STATE boundary — the CASTLE_SELECT face of the
   *  serialize-first/draw-after contract (`reprimeAiControllersForPhase`
   *  deliberately skips this phase; the selection system owns its brain
   *  arming). AI arming draws from `strategy.rng` ≡ `state.rng`
   *  (chooseBestTower + browse plan + delays), and each peer's brains sit
   *  at their own local browse progress when the snapshot lands — kept,
   *  their confirms (and the castle-plan draws those trigger) fire at
   *  different ticks per peer. Every peer re-draws instead: the promoted
   *  host right after serializing, mid-cycle adopters right after
   *  applying — same cursor, same slots, same order. A peer entering the
   *  cycle AT adoption (`enterTowerSelection` with the state-derived
   *  queue) draws the identical stream inside its entry loop and must
   *  NOT also call this. Slot set/order contract: unconfirmed cycle
   *  slots not driven by a connected human, ascending pid — matching the
   *  entry loop over the (ascending, unconfirmed-only) adoption queue. */
  function rearmCycleControllersAfterAdoption(
    remotePlayerSlots: ReadonlySet<ValidPlayerId>,
  ): void {
    const { state } = runtimeState;
    const pids = [...runtimeState.selection.states.keys()].sort(
      (a, b) => a - b,
    );
    for (const pid of pids) {
      if (runtimeState.selection.states.get(pid)!.confirmed) continue;
      if (isRemotePlayer(pid, remotePlayerSlots)) continue;
      const zone = state.playerZones[pid];
      if (zone === undefined) continue;
      runtimeState.controllers[pid]!.selectTower(state, zone);
    }
    syncSelectionOverlay();
  }

  // -------------------------------------------------------------------------
  // Tower selection helpers
  // -------------------------------------------------------------------------

  /** Enter CASTLE_SELECT for the initial cycle (omit `cycleQueue`) or the
   *  reselect cycle (pass the list of players who lost a life). Initial
   *  cycle = bootstrap path: runs once at game start (round 1) and on
   *  watcher SELECT_START. Reselect cycle = mid-game; the queue is
   *  precomputed by the life-lost dialog.
   *
   *  `remoteSlotsOverride` is for the FULL_STATE adoption entry only: the
   *  arming loop's rng draws must gate on the LIVE session slot set (a
   *  seat-takeover flip reconciled inside the same apply isn't in
   *  `frameMeta`'s frame-start snapshot yet), and the promoted host's
   *  paired re-arm (`rearmCycleControllersAfterAdoption`) reads the same
   *  live set. Lockstep entries omit it — every peer's frameMeta is
   *  equally stale at a scheduled flip, so the frame-start view is
   *  cross-peer symmetric there. */
  function enterTowerSelection(
    cycleQueue?: readonly ValidPlayerId[],
    remoteSlotsOverride?: ReadonlySet<ValidPlayerId>,
  ): void {
    const { state } = runtimeState;
    const remotePlayerSlots =
      remoteSlotsOverride ?? runtimeState.frameMeta.remotePlayerSlots;

    deps.log(
      `enterTowerSelection (phase=${Phase[state.phase]}, round=${state.round})`,
    );
    setMode(runtimeState, Mode.SELECTION);

    const slots: readonly ValidPlayerId[] =
      cycleQueue ?? state.players.map((_, i) => i as ValidPlayerId);

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
    const human = deps.pointerPlayer();
    for (const pid of slots) {
      const zone = state.playerZones[pid];
      if (zone === undefined) continue;
      const ctrl = runtimeState.controllers[pid]!;
      if (!isRemotePlayer(pid, remotePlayerSlots)) {
        ctrl.selectTower(state, zone);
      }
      // Auto-zoom to the initial tower on mobile — local human only.
      // Remote humans also run this loop (their slots get a deterministic
      // initial homeTower above), and the camera holds a single selection
      // viewport, so an ungated call would frame an opponent's zone.
      if (isHuman(ctrl) && human && pid === human.playerId) {
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
    // Arm the announcement stage by cycle type (see tickSelection's
    // two-stage timer): the BANNER_SELECT window plays only at game
    // start; reselect cycles (round > 1) skip straight to the countdown.
    // Armed explicitly on every entry so the skip never depends on the
    // accumulator happening to retain its game-start value across rounds
    // and FULL_STATE applies.
    (runtimeState.accum as MutableAccums).selectAnnouncement =
      state.round > 1 ? SELECT_ANNOUNCEMENT_DURATION : 0;
  }

  function syncSelectionOverlay(): void {
    const visible = new Set<ValidPlayerId>();
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
    idx: TowerIdx,
    zone: ZoneId,
    pid: ValidPlayerId,
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
   *  confirmations apply immediately.
   *
   *  Scheduled applies pass `towerIdx` (the tower captured at broadcast
   *  time) and it is re-asserted here: highlight input stays open during
   *  the lockstep window, so the live `selectionState.highlighted` at
   *  drain may not be the tower the confirm broadcast — and the wire
   *  towerIdx is the cross-peer contract (every peer must commit the
   *  same tower at the same applyAt, or homeTower / castle ring /
   *  state.rng fork). Immediate applies omit it: an AI that moves and
   *  confirms in the same tick has a stale `highlighted`, and its live
   *  `player.homeTower` is the truth. */
  function applyConfirmedSelection(
    pid: ValidPlayerId,
    towerIdx?: TowerIdx,
  ): void {
    if (towerIdx !== undefined) {
      const zone = runtimeState.state.playerZones[pid];
      if (zone !== undefined) {
        highlightTowerSelection(
          runtimeState.state,
          runtimeState.selection.states,
          towerIdx,
          zone,
          pid,
        );
      }
    }
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
    pid: ValidPlayerId,
    source: "local" | "network" = "local",
    applyAtFromWire?: number,
    towerIdxFromWire?: TowerIdx,
  ): boolean {
    const selectionState = runtimeState.selection.states.get(pid);
    const allConfirmed = () =>
      allSelectionsConfirmed(runtimeState.selection.states);
    if (!selectionState || selectionState.confirmed) return allConfirmed();

    const ctrl = runtimeState.controllers[pid]!;
    const isLocalHumanBroadcast = source === "local" && isHuman(ctrl);

    // Lockstep: human-driven confirms (own peer broadcasts, other peers
    // receive over wire) defer the apply to `applyAt` so castle-wall RNG
    // consumption and `selectionStates.confirmed` transitions align across
    // peers. Non-human local confirms (AI, timer-fallback for AI) keep the
    // immediate-apply semantics — clone-everywhere already guarantees both
    // peers run the same logic at the same simTick.
    if (isLocalHumanBroadcast) {
      // Already broadcast this slot's confirm — the apply hasn't flipped
      // `confirmed` yet, so block the re-send (timer-expiry loop / repeat
      // press) instead of spamming the wire + schedule with no-op dupes.
      if (inFlightConfirms.has(pid)) return false;
      inFlightConfirms.add(pid);
      const applyAt =
        runtimeState.state.simTick + DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS;
      const towerIdx = selectionState.highlighted;
      deps.sendTowerSelected(pid, towerIdx, true, applyAt);
      runtimeState.actionSchedule.schedule({
        applyAt,
        playerId: pid,
        apply: () => {
          inFlightConfirms.delete(pid);
          applyConfirmedSelection(pid, towerIdx);
        },
      });
      return false;
    }

    if (source === "network" && applyAtFromWire !== undefined) {
      runtimeState.actionSchedule.schedule({
        applyAt: applyAtFromWire,
        playerId: pid,
        apply: () => applyConfirmedSelection(pid, towerIdxFromWire),
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

    // Two-stage timer: BANNER_SELECT announcement window (no visible
    // countdown) → selection countdown. Phase A holds `state.timer` at 0
    // so the UI shows the banner instead of a counter; Phase B drives the
    // standard `timer = SELECT_TIMER - elapsed` countdown via the shared
    // helper that every other phase tick uses. Whether phase A runs at
    // all is decided at entry: `enterTowerSelection` arms
    // `selectAnnouncement` at 0 for the game-start cycle and at
    // SELECT_ANNOUNCEMENT_DURATION (already consumed) for reselects.
    if (accum.selectAnnouncement < SELECT_ANNOUNCEMENT_DURATION) {
      (accum as MutableAccums).selectAnnouncement += dt;
      runtimeState.frame.announcement = BANNER_SELECT;
      state.timer = 0;
    } else {
      advancePhaseTimer(accum, ACCUM_SELECT, state, dt, SELECT_TIMER);
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
    for (const [pid, selectionState] of selection.states) {
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
      for (const [pid, selectionState] of selection.states) {
        if (selectionState.confirmed) continue;
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
    // Flush any pending requestRender from this tick BEFORE dispatching
    // the transition. The auto-build's final wall was placed in this same
    // tick (see `tickAllCastleBuilds` above) with `requestRender()` queued
    // for the next mainLoop drain — but the transition's mutate +
    // showBanner would otherwise run synchronously inside this tick, with
    // the A-snapshot taken from a canvas that doesn't yet show the last
    // wall. Flushing here paints the pre-mutation state to the visible
    // canvas first; the banner's offscreen-B model is preserved because
    // the mutate hasn't run yet.
    deps.flushPendingRender();
    // castle-done's mutate runs finalizeRoundCleanup (round > 1) +
    // finalizeFreshCastles + finalizeCastleConstruction + the cannon-start
    // broadcast; its postDisplay routes inline to enter-cannon-place,
    // which owns enterCannonPhase + the banner.
    deps.dispatchCastleDone();
  }

  /** Derive a player's castle-wall plan and queue the build animation.
   *  Run on both host and watcher: `prepareCastleWallsForPlayer` consumes
   *  state.rng (clumsy builders + wall ordering) and seeds
   *  `player.castleWallTiles` with the planned ring — identical RNG
   *  sequence on both sides keeps state in sync. No wire broadcast:
   *  every confirmation path (local AI, local human, network remote-human)
   *  runs this locally on every peer. */
  function startPlayerCastleBuild(playerId: ValidPlayerId): void {
    const plan = prepareCastleWallsForPlayer(runtimeState.state, playerId);
    if (!plan) return;
    runtimeState.selection.castleBuilds.push(createCastleBuildState([plan]));
    // No castle-build zoom here: the moment the human confirms, the
    // mobile unzoom (main-loop's `humanCastleConfirmed` → full map) takes
    // over so the player watches every castle auto-build at once.
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

  /** See `RuntimeSelection.requeueCastleBuildsFromState`. Derivation is
   *  pure state (no rng): a player is mid-build when their committed plan
   *  (`castleWallTiles`, insertion-ordered = animation order) has tiles
   *  not yet in `player.walls`. The alive-enclosed-tower guard excludes
   *  non-cycle players whose stale plan set merely lost walls to battle
   *  damage — at CASTLE_SELECT every alive non-cycle player is enclosed
   *  (losing all enclosure costs a life, which resets the plan set). */
  function requeueCastleBuildsFromState(): void {
    runtimeState.selection.castleBuilds = [];
    const { state } = runtimeState;
    if (state.phase !== Phase.CASTLE_SELECT) return;
    for (const player of state.players) {
      if (!isPlayerAlive(player)) continue;
      if (player.castleWallTiles.size === 0) continue;
      if (filterAliveEnclosedTowers(player, state).length > 0) continue;
      const remaining = [...player.castleWallTiles].filter(
        (tile) => !player.walls.has(tile),
      );
      if (remaining.length === 0) continue;
      runtimeState.selection.castleBuilds.push(
        createCastleBuildState([{ playerId: player.id, tiles: remaining }]),
      );
    }
  }

  /** Full reset for game restart / rematch. Clears all selection and
   *  castle-build state. Distinct from resetSelectionState() which only
   *  clears per-round selection tracking for the next selection phase. */
  function reset(): void {
    runtimeState.selection.castleBuilds = [];
    runtimeState.selection.states.clear();
    inFlightConfirms.clear();
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
    reset,
    reconcileAfterAdoption,
    rearmCycleControllersAfterAdoption,
    requeueCastleBuildsFromState,
  };
}
