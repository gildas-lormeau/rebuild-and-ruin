/**
 * Host-side tick functions for the cannon placement and wall build phases.
 *
 * Contains the pure tick logic (tickHostCannonPhase, tickHostBuildPhase)
 * consumed by runtime-phase-ticks.ts. Networking deps are optional so the
 * same functions serve both local and online play.
 *
 * Net destructuring convention (shared with runtime-host-battle-ticks.ts):
 *   const remoteHumanSlots = getRemoteSlots(deps.net);
 *   const sendXxx = deps.net?.sendXxx;          // optional send callbacks
 * Always destructure net at the top of each tick function for consistency.
 * Use isHostInContext(deps.net) inline — never cache in a local variable
 * (isHost is volatile during host promotion; see online-session.ts).
 *
 * PASS 1 / PASS 2 pattern (tickHostCannonPhase & tickHostBuildPhase):
 *   PASS 1 (per-frame): tick LOCAL controllers only — remote human placements arrive
 *     via network messages and are applied by the server-event handler, not here.
 *   PASS 2 (phase end): finalize ALL controllers for phase transition. The finalization
 *     method differs by role and phase — see CONTRAST comments inside each function.
 */

import { CannonMode } from "../shared/battle-types.ts";
import { getInterior, snapshotAllWalls } from "../shared/board-occupancy.ts";
import type { SerializedPlayer } from "../shared/checkpoint-data.ts";
import { MASTER_BUILDER_BONUS_SECONDS } from "../shared/game-constants.ts";
import type { EntityOverlay } from "../shared/overlay-types.ts";
import {
  type CannonPhantom,
  cannonPhantomKey,
  type DedupChannel,
  filterAlivePhantoms,
  NOOP_DEDUP_CHANNEL,
  type PiecePhantom,
  phantomWireMode,
  piecePhantomKey,
} from "../shared/phantom-types.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import { unpackTile } from "../shared/spatial.ts";
import type { PlayerController } from "../shared/system-interfaces.ts";
import {
  ACCUM_CANNON,
  advancePhaseTimer,
  getRemoteSlots,
  type HostNetContext,
  isHostInContext,
  isRemoteHuman,
  localControllers,
  tickGruntsIfDue,
} from "../shared/tick-context.ts";
import { type GameState, isMasterBuilderLocked } from "../shared/types.ts";
import { snapshotEntities } from "./phase-banner.ts";
import { runBuildEndSequence } from "./phase-transition-steps.ts";

/** Networking context for the cannon placement phase.
 *  Optional (`net?`) — when omitted, the tick function runs in local-play mode
 *  with no-op networking (no broadcasts, no remote phantom merging). */
interface CannonPhaseNet extends HostNetContext {
  remoteCannonPhantoms: readonly CannonPhantom[];
  lastSentCannonPhantom: DedupChannel;
  sendOpponentCannonPlaced: (msg: {
    playerId: ValidPlayerSlot;
    row: number;
    col: number;
    mode: CannonMode;
  }) => void;
  sendOpponentCannonPhantom: (msg: {
    playerId: ValidPlayerSlot;
    row: number;
    col: number;
    mode: CannonMode;
    valid: boolean;
  }) => void;
}

/** Networking context for the wall build phase.
 *  Optional (`net?`) — when omitted, defaults to local-play no-ops. */
interface BuildPhaseNet extends HostNetContext {
  remotePiecePhantoms: readonly PiecePhantom[];
  lastSentPiecePhantom: DedupChannel;
  serializePlayers?: (state: GameState) => SerializedPlayer[];
  sendOpponentPiecePlaced: (msg: {
    playerId: ValidPlayerSlot;
    row: number;
    col: number;
    offsets: [number, number][];
  }) => void;
  sendOpponentPhantom: (msg: {
    playerId: ValidPlayerSlot;
    row: number;
    col: number;
    offsets: [number, number][];
    valid: boolean;
  }) => void;
  sendBuildEnd: (msg: {
    needsReselect: ValidPlayerSlot[];
    eliminated: ValidPlayerSlot[];
    scores: number[];
    players: SerializedPlayer[];
  }) => void;
}

interface HostFrame {
  phantoms: {
    cannonPhantoms?: CannonPhantom[];
    piecePhantoms?: PiecePhantom[];
    defaultFacings?: ReadonlyMap<number, number>;
  };
}

interface TickHostCannonPhaseDeps {
  dt: number;
  state: GameState;
  accum: { cannon: number };
  frame: HostFrame;
  controllers: PlayerController[];
  render: () => void;
  startBattle: () => void;
  /** Network context. Pass LOCAL_NET (spread with cannon-phase stubs) for local play. */
  net: CannonPhaseNet;
}

interface TickHostBuildPhaseDeps {
  dt: number;
  state: GameState;
  banner: { wallsBeforeSweep?: Set<number>[]; prevEntities?: EntityOverlay };
  accum: { build: number; grunt: number };
  frame: HostFrame;
  controllers: PlayerController[];
  render: () => void;
  tickGrunts: (state: GameState) => void;
  isHuman: (controller: PlayerController) => boolean;
  finalizeBuildPhase: (state: GameState) => {
    needsReselect: ValidPlayerSlot[];
    eliminated: ValidPlayerSlot[];
  };
  showLifeLostDialog: (
    needsReselect: readonly ValidPlayerSlot[],
    eliminated: readonly ValidPlayerSlot[],
  ) => void;
  onLifeLostResolved: () => boolean;
  showScoreDeltas: (onDone: () => void) => void;
  onFirstEnclosure?: (playerId: ValidPlayerSlot) => void;
  /** Network context. Pass LOCAL_NET (spread with build-phase stubs) for local play. */
  net: BuildPhaseNet;
}

/** Sentinel channel for local play — never blocks sends.
 *  Used as fallback when networking deps are absent. */
const LOCAL_CHANNEL = NOOP_DEDUP_CHANNEL;
/** Protocol placeholder — broadcastNewWalls sends absolute tile positions in `offsets`,
 *  so `row`/`col` are unused. This constant documents the intent. */
const PLACEHOLDER_ORIGIN = { row: 0, col: 0 } as const;

/** Tick the cannon phase. Returns true when the phase ends (all controllers
 *  done or timer expired → transitions to battle), false while still ticking.
 *
 * Controller cannon lifecycle per frame:
 *   cannonTick(state, dt) — called each frame (AI places, Human updates cursor)
 *   isCannonPhaseDone(state, max) — check if controller is finished
 *   flushCannons(state, max) — finalize remaining placements (called once at phase end)
 *   initCannons(state, max) — auto-place round-1 cannons if none placed (called once after flush)
 * flush + init are combined in finalizeCannonPhase() which guarantees correct ordering.
 *
 * Remote vs local dispatch:
 *   Pass 1 (per-frame): ticks LOCAL controllers only (remoteHumanSlots are skipped).
 *   Pass 2 (phase end): calls flushCannons on LOCAL only, initCannons on ALL
 *     (remote humans get initCannons only — their placements arrive via network).
 *
 * Remote human finalization — CONTRAST with tickHostBuildPhase:
 *   Cannon: remote humans call initCannons() because cannon state must be ready
 *     for the immediate battle transition — there is no "startCannonPhase" re-init.
 *   Build: remote humans are SKIPPED entirely because bag state is re-initialized
 *     at the start of the next build phase via startBuildPhase().
 *   Using the wrong method corrupts state. Do NOT unify these two approaches.
 */
export function tickHostCannonPhase(deps: TickHostCannonPhaseDeps): boolean {
  const { dt, state, accum, frame, controllers, render, startBattle } = deps;
  // Networking defaults (no-op for local play)
  const remoteHumanSlots = getRemoteSlots(deps.net);
  const remoteCannonPhantoms = deps.net?.remoteCannonPhantoms ?? [];
  const lastSentCannonPhantom =
    deps.net?.lastSentCannonPhantom ?? LOCAL_CHANNEL;
  const sendOpponentCannonPlaced = deps.net?.sendOpponentCannonPlaced;
  const sendOpponentCannonPhantom = deps.net?.sendOpponentCannonPhantom;

  advancePhaseTimer(accum, ACCUM_CANNON, state, dt, state.cannonPlaceTimer);

  const defaultFacings = new Map<number, number>();
  for (const player of state.players) {
    defaultFacings.set(player.id, player.defaultFacing);
  }
  frame.phantoms = { cannonPhantoms: [], defaultFacings };
  // ── PASS 1: Tick local controllers (process input & AI decisions) ──
  for (const ctrl of localControllers(controllers, remoteHumanSlots)) {
    const cannonsBefore = state.players[ctrl.playerId]!.cannons.length;
    const phantom = ctrl.cannonTick(state, dt);

    if (isHostInContext(deps.net) && sendOpponentCannonPlaced) {
      const cannonsAfter = state.players[ctrl.playerId]!.cannons.length;
      for (
        let cannonIdx = cannonsBefore;
        cannonIdx < cannonsAfter;
        cannonIdx++
      ) {
        const c = state.players[ctrl.playerId]!.cannons[cannonIdx]!;
        sendOpponentCannonPlaced({
          playerId: ctrl.playerId,
          row: c.row,
          col: c.col,
          mode: c.mode,
        });
      }
    }

    if (!phantom) continue;

    frame.phantoms.cannonPhantoms!.push(phantom);
    if (!isHostInContext(deps.net) || !sendOpponentCannonPhantom) continue;

    if (
      !lastSentCannonPhantom.shouldSend(
        ctrl.playerId,
        cannonPhantomKey(phantom),
      )
    )
      continue;
    sendOpponentCannonPhantom({
      playerId: ctrl.playerId,
      row: phantom.row,
      col: phantom.col,
      mode: phantomWireMode(phantom),
      valid: phantom.valid,
    });
  }

  if (remoteCannonPhantoms.length > 0) {
    frame.phantoms.cannonPhantoms!.push(
      ...filterAlivePhantoms(remoteCannonPhantoms, state.players).filter(
        (player) => !isRemoteHuman(player.playerId, remoteHumanSlots),
      ),
    );
  }

  render();

  const allDone = controllers.every((ctrl) => {
    if (isRemoteHuman(ctrl.playerId, remoteHumanSlots)) return true;
    const player = state.players[ctrl.playerId]!;
    if (player.eliminated) return true;
    const max = state.cannonLimits[player.id] ?? 0;
    return ctrl.isCannonPhaseDone(state, max);
  });

  if (state.timer > 0 && !allDone) return false;

  // ── PASS 2: Finalize all controllers (including remote) for phase transition ──
  // Controller finalization — LOAD-BEARING SPLIT (do not merge):
  // Remote humans: call initCannons() only (their cannons were flushed client-side).
  // Local controllers (AI + local human): call finalizeCannonPhase() which flushes then inits.
  // Using the wrong method corrupts cannon state — finalizeCannonPhase on a remote
  // double-flushes; initCannons on a local skips the flush entirely.
  // CONTRAST with build finalization (finalizeBuildEnd, ~line 454): build skips remote
  // humans entirely because bag state is re-initialized via startBuildPhase at the start
  // of the next build phase. Cannon has no equivalent re-init step, so initCannons must
  // run here explicitly.
  // NOTE: Intentionally includes eliminated players — they need cannon state
  // cleanup (flush + round-1 init) for potential castle reselection.
  for (const ctrl of controllers) {
    const max = state.cannonLimits[ctrl.playerId] ?? 0;
    if (isRemoteHuman(ctrl.playerId, remoteHumanSlots)) {
      ctrl.initCannons(state, max);
      continue;
    }
    ctrl.finalizeCannonPhase(state, max);
  }

  startBattle();
  return true;
}

/** Tick the build phase. Returns true when the phase ends (timer expired,
 *  controllers finalized, life-loss dialogs queued), false while still ticking.
 *
 *  Remote vs local dispatch:
 *    Per-frame: ticks LOCAL controllers only (remoteHumanSlots skipped — their
 *      placements arrive via network and are applied by the message handler).
 *    Phase end (finalizeBuildAndShowDialogs): calls finalizeBuildPhase on LOCAL only —
 *      remote clients finalize their own controllers independently.
 *
 *  Remote human finalization — CONTRAST with tickHostCannonPhase:
 *    Build: remote humans are SKIPPED (bag state is re-initialized via startBuildPhase).
 *    Cannon: remote humans call initCannons() (no equivalent re-init step exists).
 *    Using the wrong method corrupts state. Do NOT unify these two approaches. */
export function tickHostBuildPhase(deps: TickHostBuildPhaseDeps): boolean {
  const { dt, state, accum, frame, controllers, render } = deps;
  // Networking defaults (no-op for local play)
  const remoteHumanSlots = getRemoteSlots(deps.net);

  // --- Timer + grunt tick ---
  const hasMB = (state.modern?.masterBuilderOwners?.size ?? 0) > 0;
  const buildMax =
    state.buildTimer + (hasMB ? MASTER_BUILDER_BONUS_SECONDS : 0);
  advancePhaseTimer(accum, "build", state, dt, buildMax);
  // Decrement Master Builder lockout (non-owners can't build until it reaches 0)
  if (state.modern && state.modern.masterBuilderLockout > 0) {
    state.modern.masterBuilderLockout = Math.max(
      0,
      state.modern.masterBuilderLockout - dt,
    );
  }
  tickGruntsIfDue(accum, dt, state, deps.tickGrunts);

  // --- Process each controller's build actions, collect phantoms ---
  frame.phantoms = { piecePhantoms: [] };
  processControllerBuildActions(deps, frame, remoteHumanSlots);

  // --- Merge remote phantoms from non-host players ---
  mergeRemotePiecePhantoms(frame, deps.net, remoteHumanSlots, state);

  render();
  if (state.timer > 0) return false;

  // --- End of phase: finalize and handle life loss ---
  finalizeBuildAndShowDialogs(deps, controllers, remoteHumanSlots);
  return true;
}

/** Tick each local controller's build logic, detect new walls, collect phantoms. */
function processControllerBuildActions(
  deps: TickHostBuildPhaseDeps,
  frame: HostFrame,
  remoteHumanSlots: ReadonlySet<number>,
): void {
  const { state, dt, controllers } = deps;
  const lastSentPiecePhantom = deps.net?.lastSentPiecePhantom ?? LOCAL_CHANNEL;
  const sendOpponentPiecePlaced = deps.net?.sendOpponentPiecePlaced;
  const sendOpponentPhantom = deps.net?.sendOpponentPhantom;

  // ── PASS 1: Tick local controllers (process input & AI decisions) ──
  for (const ctrl of localControllers(controllers, remoteHumanSlots)) {
    // Master Builder lockout: skip non-owners during the exclusive window
    if (isMasterBuilderLocked(state, ctrl.playerId)) continue;
    const player = state.players[ctrl.playerId];
    if (!player) continue;
    const hadInterior = getInterior(player).size > 0;

    const phantoms = buildTickWithWallBroadcast(
      ctrl,
      player,
      state,
      dt,
      isHostInContext(deps.net) && !deps.isHuman(ctrl),
      sendOpponentPiecePlaced,
    );

    if (!hadInterior && getInterior(player).size > 0) {
      deps.onFirstEnclosure?.(ctrl.playerId);
    }

    collectBuildPhantoms(
      phantoms,
      frame,
      isHostInContext(deps.net),
      lastSentPiecePhantom,
      sendOpponentPhantom,
    );
  }
}

/** Snapshot walls, run buildTick, and broadcast any new AI walls.
 *  Enforces the invariant that the snapshot is captured BEFORE the tick —
 *  reversing the order silently produces empty diffs with no compile error. */
function buildTickWithWallBroadcast(
  ctrl: PlayerController,
  player: { readonly walls: ReadonlySet<number> },
  state: GameState,
  dt: number,
  shouldSnapshot: boolean,
  sendOpponentPiecePlaced?: (msg: {
    playerId: ValidPlayerSlot;
    row: number;
    col: number;
    offsets: [number, number][];
  }) => void,
): readonly (PiecePhantom & { valid?: boolean })[] {
  const wallSnapshot = shouldSnapshot ? new Set(player.walls) : null;
  const phantoms = ctrl.buildTick(state, dt);
  if (wallSnapshot && sendOpponentPiecePlaced) {
    broadcastNewWalls(
      state,
      ctrl.playerId,
      wallSnapshot,
      sendOpponentPiecePlaced,
    );
  }
  return phantoms;
}

/** Collect build-phase phantoms into the frame and broadcast new ones to peers. */
function collectBuildPhantoms(
  phantoms: readonly (PiecePhantom & { valid?: boolean })[],
  frame: HostFrame,
  isHost: boolean,
  lastSentPiecePhantom: DedupChannel,
  sendOpponentPhantom:
    | ((msg: {
        playerId: ValidPlayerSlot;
        row: number;
        col: number;
        offsets: [number, number][];
        valid: boolean;
      }) => void)
    | undefined,
): void {
  for (const phantom of phantoms) {
    frame.phantoms.piecePhantoms!.push({
      offsets: phantom.offsets,
      row: phantom.row,
      col: phantom.col,
      playerId: phantom.playerId,
      valid: phantom.valid ?? true,
    });

    if (!isHost || !sendOpponentPhantom) continue;
    if (
      !lastSentPiecePhantom.shouldSend(
        phantom.playerId,
        piecePhantomKey(phantom),
      )
    )
      continue;
    sendOpponentPhantom({
      playerId: phantom.playerId,
      row: phantom.row,
      col: phantom.col,
      offsets: phantom.offsets,
      valid: phantom.valid ?? true,
    });
  }
}

/** Detect walls added by an AI controller tick and broadcast them. */
function broadcastNewWalls(
  state: GameState,
  playerId: ValidPlayerSlot,
  wallSnapshot: ReadonlySet<number>,
  sendOpponentPiecePlaced: (msg: {
    playerId: ValidPlayerSlot;
    row: number;
    col: number;
    offsets: [number, number][];
  }) => void,
): void {
  const player = state.players[playerId]!;
  if (player.walls.size <= wallSnapshot.size) return;
  const offsets: [number, number][] = [];
  for (const key of player.walls) {
    if (!wallSnapshot.has(key)) {
      const { r, c } = unpackTile(key);
      offsets.push([r, c]);
    }
  }
  if (offsets.length > 0) {
    sendOpponentPiecePlaced({ playerId, ...PLACEHOLDER_ORIGIN, offsets });
  }
}

/** Add remote piece phantoms from non-host players into the frame. */
function mergeRemotePiecePhantoms(
  frame: HostFrame,
  net: BuildPhaseNet | undefined,
  remoteHumanSlots: ReadonlySet<number>,
  state: GameState,
): void {
  const remotePiecePhantoms = net?.remotePiecePhantoms ?? [];
  if (remotePiecePhantoms.length > 0) {
    frame.phantoms.piecePhantoms!.push(
      ...filterAlivePhantoms(remotePiecePhantoms, state.players).filter(
        (player) => !isRemoteHuman(player.playerId, remoteHumanSlots),
      ),
    );
  }
}

/** End build phase: finalize, broadcast, and show life-lost dialogs. */
function finalizeBuildAndShowDialogs(
  deps: TickHostBuildPhaseDeps,
  controllers: readonly PlayerController[],
  remoteHumanSlots: ReadonlySet<number>,
): void {
  const { state } = deps;
  const serializePlayers = deps.net?.serializePlayers ?? (() => []);
  const sendBuildEnd = deps.net?.sendBuildEnd;

  // ── PASS 2: Finalize all controllers for phase transition ──
  // Controller finalization — load-bearing split:
  // Remote humans: skipped (their build was finalized client-side; bag state is
  // re-initialized at the start of the next build phase via startBuildPhase).
  // Local controllers (AI + local human): call finalizeBuildPhase() which flushes then inits.
  // Using the wrong method corrupts piece-bag state.
  // CONTRAST with cannon finalization (~line 236): cannon calls initCannons() on remote
  // humans because cannon state must be ready for the immediate battle transition —
  // there is no "startCannonPhase" re-init step.
  // NOTE: Intentionally includes eliminated players — they need state cleanup
  // (bag/piece nulling) for potential castle reselection.
  for (const ctrl of controllers) {
    if (isRemoteHuman(ctrl.playerId, remoteHumanSlots)) continue;
    ctrl.finalizeBuildPhase(state);
  }

  // Snapshot MUST precede finalize — finalize calls sweepAllPlayersWalls
  // (deletes isolated walls) and reviveEnclosedTowers (mutates towerAlive).
  // The banner needs pre-finalize snapshots for both.
  const { wallsBeforeSweep, prevEntities, needsReselect, eliminated } =
    snapshotThenFinalize(state, deps.finalizeBuildPhase);
  deps.banner.wallsBeforeSweep = wallsBeforeSweep;
  deps.banner.prevEntities = prevEntities;
  if (isHostInContext(deps.net) && sendBuildEnd) {
    sendBuildEnd({
      needsReselect,
      eliminated,
      scores: state.players.map((player) => player.score),
      players: serializePlayers(state),
    });
  }

  runBuildEndSequence({
    needsReselect,
    eliminated,
    showScoreDeltas: deps.showScoreDeltas,
    notifyLifeLost: (pid) => {
      if (!isRemoteHuman(pid, remoteHumanSlots)) controllers[pid]!.onLifeLost();
    },
    showLifeLostDialog: deps.showLifeLostDialog,
    onLifeLostResolved: deps.onLifeLostResolved,
  });
}

/** Snapshot all walls THEN finalize the build phase. Enforces the invariant
 *  that the snapshot is captured before sweepAllPlayersWalls deletes isolated walls.
 *
 *  INVARIANT: Snapshot MUST precede finalizeBuildPhase(). Wall sweeping deletes
 *  isolated walls during finalization — snapshotting after would show post-sweep state
 *  in the banner, hiding destroyed walls from the player.
 *
 *  Zone-dependent entities (grunts, houses, pits, bonuses) are re-snapshotted
 *  AFTER finalize so that resetZoneState changes are reflected. Without this,
 *  the banner old-scene would flash stale grunts that were already removed
 *  before the life-lost dialog appeared. */
function snapshotThenFinalize(
  state: GameState,
  finalizeBuildPhase: (state: GameState) => {
    needsReselect: ValidPlayerSlot[];
    eliminated: ValidPlayerSlot[];
  },
): {
  wallsBeforeSweep: Set<number>[];
  prevEntities: EntityOverlay;
  needsReselect: ValidPlayerSlot[];
  eliminated: ValidPlayerSlot[];
} {
  const wallsBeforeSweep = snapshotAllWalls(state);
  const prevEntities = snapshotEntities(state);
  const { needsReselect, eliminated } = finalizeBuildPhase(state);

  // Re-snapshot zone-dependent entities after finalize — resetZoneState
  // removes grunts/houses/pits/bonuses from eliminated/reselect zones,
  // and the player already sees them gone during the life-lost dialog.
  // Walls and towerAlive keep their pre-finalize snapshots (wall sweep
  // and tower revival are the changes the banner should visualize).
  if (needsReselect.length > 0 || eliminated.length > 0) {
    prevEntities.grunts = state.grunts.map((grunt) => ({ ...grunt }));
    prevEntities.houses = state.map.houses.map((house) => ({ ...house }));
    prevEntities.burningPits = state.burningPits.map((pit) => ({ ...pit }));
    prevEntities.bonusSquares = state.bonusSquares.map((bonus) => ({
      ...bonus,
    }));
  }

  return { wallsBeforeSweep, prevEntities, needsReselect, eliminated };
}
