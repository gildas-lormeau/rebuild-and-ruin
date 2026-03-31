/**
 * Host-side tick functions for the cannon placement and wall build phases.
 *
 * Contains the pure tick logic (tickHostCannonPhase, tickHostBuildPhase)
 * consumed by runtime-phase-ticks.ts. Networking deps are optional so the
 * same functions serve both local and online play.
 *
 * Net destructuring convention (shared with runtime-host-battle-ticks.ts):
 *   const remoteHumanSlots = getRemoteSlots(deps.net);
 *   const isHost = isHostInContext(deps.net);
 *   const sendXxx = deps.net?.sendXxx;          // optional send callbacks
 * Always destructure net at the top of each tick function for consistency.
 */

import { snapshotAllWalls } from "./board-occupancy.ts";
import type { SerializedPlayer } from "./checkpoint-data.ts";
import type { PlayerController } from "./controller-interfaces.ts";
import {
  type CannonPhantom,
  cannonPhantomKey,
  dedupChanged,
  filterAlivePhantoms,
  type PiecePhantom,
  phantomWireMode,
  piecePhantomKey,
} from "./phantom-types.ts";
import { snapshotEntities } from "./phase-banner.ts";
import { runBuildEndSequence } from "./phase-transition-shared.ts";
import type { EntityOverlay } from "./render-types.ts";
import { unpackTile } from "./spatial.ts";
import {
  advancePhaseTimer,
  getRemoteSlots,
  type HostNetContext,
  isHostInContext,
  localActiveControllers,
  tickGruntsIfDue,
} from "./tick-context.ts";
import { CannonMode, type GameState } from "./types.ts";

/** Networking context for the cannon placement phase.
 *  Optional (`net?`) — when omitted, the tick function runs in local-play mode
 *  with no-op networking (no broadcasts, no remote phantom merging). */
interface CannonPhaseNet extends HostNetContext {
  remoteCannonPhantoms: readonly CannonPhantom[];
  lastSentCannonPhantom: Map<number, string>;
  sendOpponentCannonPlaced: (msg: {
    playerId: number;
    row: number;
    col: number;
    mode: CannonMode;
  }) => void;
  sendOpponentCannonPhantom: (msg: {
    playerId: number;
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
  lastSentPiecePhantom: Map<number, string>;
  serializePlayers?: (state: GameState) => SerializedPlayer[];
  sendOpponentPiecePlaced: (msg: {
    playerId: number;
    row: number;
    col: number;
    offsets: [number, number][];
  }) => void;
  sendOpponentPhantom: (msg: {
    playerId: number;
    row: number;
    col: number;
    offsets: [number, number][];
    valid: boolean;
  }) => void;
  sendBuildEnd: (msg: {
    needsReselect: number[];
    eliminated: number[];
    scores: number[];
    players: SerializedPlayer[];
  }) => void;
}

interface HostFrame {
  phantoms: {
    aiCannonPhantoms?: CannonPhantom[];
    aiPhantoms?: PiecePhantom[];
    humanPhantoms?: PiecePhantom[];
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
  net?: CannonPhaseNet;
}

interface TickHostBuildPhaseDeps {
  dt: number;
  state: GameState;
  banner: { wallsBeforeSweep?: Set<number>[]; oldEntities?: EntityOverlay };
  accum: { build: number; grunt: number };
  frame: HostFrame;
  controllers: PlayerController[];
  render: () => void;
  tickGrunts: (state: GameState) => void;
  isHuman: (controller: PlayerController) => boolean;
  finalizeBuildPhase: (state: GameState) => {
    needsReselect: number[];
    eliminated: number[];
  };
  showLifeLostDialog: (
    needsReselect: readonly number[],
    eliminated: readonly number[],
  ) => void;
  afterLifeLostResolved: () => boolean;
  showScoreDeltas: (onDone: () => void) => void;
  onFirstEnclosure?: (playerId: number) => void;
  net?: BuildPhaseNet;
}

/** Sentinel empty map — never mutated (dedupChanged short-circuits on empty maps). */
const EMPTY_MAP = new Map<number, string>();
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
 */
export function tickHostCannonPhase(deps: TickHostCannonPhaseDeps): boolean {
  const { dt, state, accum, frame, controllers, render, startBattle } = deps;
  // Networking defaults (no-op for local play)
  const remoteHumanSlots = getRemoteSlots(deps.net);
  const isHost = isHostInContext(deps.net);
  const remoteCannonPhantoms = deps.net?.remoteCannonPhantoms ?? [];
  const lastSentCannonPhantom = deps.net?.lastSentCannonPhantom ?? EMPTY_MAP;
  const sendOpponentCannonPlaced = deps.net?.sendOpponentCannonPlaced;
  const sendOpponentCannonPhantom = deps.net?.sendOpponentCannonPhantom;

  advancePhaseTimer(accum, "cannon", state, dt, state.cannonPlaceTimer);

  // Cannon phase phantom contract: { aiCannonPhantoms: CannonPhantom[] }
  // (only AI cannon phantoms — human cannon previews come from cannonTick return value)
  const defaultFacings = new Map<number, number>();
  for (const player of state.players) {
    defaultFacings.set(player.id, player.defaultFacing);
  }
  frame.phantoms = { aiCannonPhantoms: [], defaultFacings };
  // ── PASS 1: Tick local controllers (process input & AI decisions) ──
  for (const ctrl of localActiveControllers(
    controllers,
    remoteHumanSlots,
    state,
  )) {
    const cannonsBefore = state.players[ctrl.playerId]!.cannons.length;
    const phantom = ctrl.cannonTick(state, dt);

    if (isHost && sendOpponentCannonPlaced) {
      const cannonsAfter = state.players[ctrl.playerId]!.cannons.length;
      for (let ci = cannonsBefore; ci < cannonsAfter; ci++) {
        const c = state.players[ctrl.playerId]!.cannons[ci]!;
        sendOpponentCannonPlaced({
          playerId: ctrl.playerId,
          row: c.row,
          col: c.col,
          mode: c.mode,
        });
      }
    }

    if (!phantom) continue;

    frame.phantoms.aiCannonPhantoms!.push(phantom);
    if (!isHost || !sendOpponentCannonPhantom) continue;

    if (
      !dedupChanged(
        lastSentCannonPhantom,
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
    frame.phantoms.aiCannonPhantoms!.push(
      ...filterAlivePhantoms(remoteCannonPhantoms, state.players).filter(
        (player) => !remoteHumanSlots.has(player.playerId),
      ),
    );
  }

  render();

  const allDone = controllers.every((ctrl) => {
    if (remoteHumanSlots.has(ctrl.playerId)) return true;
    const player = state.players[ctrl.playerId]!;
    if (player.eliminated) return true;
    const max = state.cannonLimits[player.id] ?? 0;
    return ctrl.isCannonPhaseDone(state, max);
  });

  if (state.timer > 0 && !allDone) return false;

  // ── PASS 2: Finalize all controllers (including remote) for phase transition ──
  // Controller finalization — load-bearing split:
  // Remote humans: call initCannons() only (their cannons were flushed client-side).
  // Local controllers (AI + local human): call finalizeCannonPhase() which flushes then inits.
  // Using the wrong method corrupts cannon state.
  for (const ctrl of controllers) {
    const max = state.cannonLimits[ctrl.playerId] ?? 0;
    if (remoteHumanSlots.has(ctrl.playerId)) {
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
 *      remote clients finalize their own controllers independently. */
export function tickHostBuildPhase(deps: TickHostBuildPhaseDeps): boolean {
  const { dt, state, accum, frame, controllers, render } = deps;
  const remoteHumanSlots = getRemoteSlots(deps.net);

  // --- Timer + grunt tick ---
  advancePhaseTimer(accum, "build", state, dt, state.buildTimer);
  tickGruntsIfDue(accum, dt, state, deps.tickGrunts);

  // --- Process each controller's build actions, collect phantoms ---
  // Build phase phantom contract: { aiPhantoms: PiecePhantom[], humanPhantoms: PiecePhantom[] }
  // (AI and human phantoms tracked separately for network broadcast)
  frame.phantoms = { aiPhantoms: [], humanPhantoms: [] };
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
  const isHost = isHostInContext(deps.net);
  const lastSentPiecePhantom = deps.net?.lastSentPiecePhantom ?? EMPTY_MAP;
  const sendOpponentPiecePlaced = deps.net?.sendOpponentPiecePlaced;
  const sendOpponentPhantom = deps.net?.sendOpponentPhantom;

  // ── PASS 1: Tick local controllers (process input & AI decisions) ──
  for (const ctrl of localActiveControllers(
    controllers,
    remoteHumanSlots,
    state,
  )) {
    const player = state.players[ctrl.playerId];
    if (!player) continue;
    const hadInterior = player.interior.size > 0;

    const phantoms = buildTickWithWallBroadcast(
      ctrl,
      player,
      state,
      dt,
      isHost && !deps.isHuman(ctrl),
      sendOpponentPiecePlaced,
    );

    if (!hadInterior && player.interior.size > 0) {
      deps.onFirstEnclosure?.(ctrl.playerId);
    }

    collectBuildPhantoms(
      phantoms,
      deps.isHuman(ctrl),
      frame,
      isHost,
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
    playerId: number;
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
  isHumanCtrl: boolean,
  frame: HostFrame,
  isHost: boolean,
  lastSentPiecePhantom: Map<number, string>,
  sendOpponentPhantom:
    | ((msg: {
        playerId: number;
        row: number;
        col: number;
        offsets: [number, number][];
        valid: boolean;
      }) => void)
    | undefined,
): void {
  for (const phantom of phantoms) {
    if (isHumanCtrl) {
      frame.phantoms.humanPhantoms!.push({
        offsets: phantom.offsets,
        row: phantom.row,
        col: phantom.col,
        valid: phantom.valid ?? true,
        playerId: phantom.playerId,
      });
    } else {
      frame.phantoms.aiPhantoms!.push({
        offsets: phantom.offsets,
        row: phantom.row,
        col: phantom.col,
        playerId: phantom.playerId,
        valid: phantom.valid ?? true,
      });
    }

    if (!isHost || !sendOpponentPhantom) continue;
    if (
      !dedupChanged(
        lastSentPiecePhantom,
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
  playerId: number,
  wallSnapshot: ReadonlySet<number>,
  sendOpponentPiecePlaced: (msg: {
    playerId: number;
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
    frame.phantoms.aiPhantoms!.push(
      ...filterAlivePhantoms(remotePiecePhantoms, state.players).filter(
        (player) => !remoteHumanSlots.has(player.playerId),
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
  const isHost = isHostInContext(deps.net);
  const serializePlayers = deps.net?.serializePlayers ?? (() => []);
  const sendBuildEnd = deps.net?.sendBuildEnd;

  // ── PASS 2: Finalize all controllers for phase transition ──
  // Controller finalization — load-bearing split:
  // Remote humans: call initBag() only (their build was finalized client-side).
  // Local controllers (AI + local human): call finalizeBuildPhase() which flushes then inits.
  // Using the wrong method corrupts piece-bag state.
  for (const ctrl of controllers) {
    if (remoteHumanSlots.has(ctrl.playerId)) continue;
    ctrl.finalizeBuildPhase(state);
  }

  // Snapshot MUST precede finalize — finalize calls sweepAllPlayersWalls
  // (deletes isolated walls) and reviveEnclosedTowers (mutates towerAlive).
  // The banner needs pre-finalize snapshots for both.
  const { wallsBeforeSweep, oldEntities, needsReselect, eliminated } =
    snapshotThenFinalize(state, deps.finalizeBuildPhase);
  deps.banner.wallsBeforeSweep = wallsBeforeSweep;
  deps.banner.oldEntities = oldEntities;
  if (isHost && sendBuildEnd) {
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
      if (!remoteHumanSlots.has(pid)) controllers[pid]!.onLifeLost();
    },
    showLifeLostDialog: deps.showLifeLostDialog,
    afterLifeLostResolved: deps.afterLifeLostResolved,
  });
}

/** Snapshot all walls THEN finalize the build phase. Enforces the invariant
 *  that the snapshot is captured before sweepAllPlayersWalls deletes isolated walls. */
function snapshotThenFinalize(
  state: GameState,
  finalizeBuildPhase: (state: GameState) => {
    needsReselect: number[];
    eliminated: number[];
  },
): {
  wallsBeforeSweep: Set<number>[];
  oldEntities: EntityOverlay;
  needsReselect: number[];
  eliminated: number[];
} {
  const wallsBeforeSweep = snapshotAllWalls(state);
  const oldEntities = snapshotEntities(state);
  const { needsReselect, eliminated } = finalizeBuildPhase(state);
  return { wallsBeforeSweep, oldEntities, needsReselect, eliminated };
}
