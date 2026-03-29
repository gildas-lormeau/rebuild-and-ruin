/**
 * Host-side tick functions for the cannon placement and wall build phases.
 *
 * Contains the pure tick logic (tickHostCannonPhase, tickHostBuildPhase)
 * consumed by runtime-phase-ticks.ts. Networking deps are optional so the
 * same functions serve both local and online play.
 */

import type { SerializedPlayer } from "../server/protocol.ts";
import { snapshotAllWalls } from "./board-occupancy.ts";
import type { PlayerController } from "./controller-interfaces.ts";
import {
  type CannonPhantom,
  cannonPhantomKey,
  type HumanPiecePhantom,
  type PiecePhantom,
  phantomChanged,
  phantomWireMode,
  piecePhantomKey,
} from "./online-types.ts";
import { unpackTile } from "./spatial.ts";
import {
  getRemoteSlots,
  type HostNetContext,
  localActiveControllers,
  tickTimer,
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
    facing: number;
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
    humanPhantoms?: HumanPiecePhantom[];
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
  banner: { pendingOldWalls?: Set<number>[] };
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

/** Sentinel empty map — never mutated (phantomChanged short-circuits on empty maps). */
const EMPTY_MAP = new Map<number, string>();

/**
 * Controller cannon lifecycle per frame:
 *   cannonTick(state, dt) — called each frame (AI places, Human updates cursor)
 *   isCannonPhaseDone(state, max) — check if controller is finished
 *   flushCannons(state, max) — finalize remaining placements (called once at phase end)
 *   initCannons(state, max) — auto-place round-1 cannons if none placed (called once after flush)
 * flush + init must be called together, in that order, exactly once at phase end.
 */
export function tickHostCannonPhase(deps: TickHostCannonPhaseDeps): boolean {
  const { dt, state, accum, frame, controllers, render, startBattle } = deps;
  // Networking defaults (no-op for local play)
  const remoteHumanSlots = getRemoteSlots(deps.net);
  const isHost = deps.net?.isHost ?? true;
  const remoteCannonPhantoms = deps.net?.remoteCannonPhantoms ?? [];
  const lastSentCannonPhantom = deps.net?.lastSentCannonPhantom ?? EMPTY_MAP;
  const sendOpponentCannonPlaced = deps.net?.sendOpponentCannonPlaced;
  const sendOpponentCannonPhantom = deps.net?.sendOpponentCannonPhantom;

  ({ accum: accum.cannon, timer: state.timer } = tickTimer(
    accum.cannon,
    dt,
    state.cannonPlaceTimer,
  ));

  frame.phantoms = { aiCannonPhantoms: [] };
  // Pass 1: tick only local, non-eliminated controllers (process input & AI decisions)
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
      !phantomChanged(
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
      facing: phantom.facing ?? 0,
    });
  }

  if (remoteCannonPhantoms.length > 0) {
    frame.phantoms.aiCannonPhantoms!.push(
      ...remoteCannonPhantoms.filter(
        (p) =>
          !remoteHumanSlots.has(p.playerId) &&
          !state.players[p.playerId]?.eliminated,
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

  // Pass 2: flush/init ALL controllers (including remote) for phase transition
  for (const ctrl of controllers) {
    const max = state.cannonLimits[ctrl.playerId] ?? 0;
    if (remoteHumanSlots.has(ctrl.playerId)) {
      ctrl.initCannons(state, max);
      continue;
    }
    ctrl.flushCannons(state, max);
    ctrl.initCannons(state, max);
  }

  startBattle();
  return true;
}

export function tickHostBuildPhase(deps: TickHostBuildPhaseDeps): boolean {
  const { dt, state, accum, frame, controllers, render } = deps;
  const remoteHumanSlots = getRemoteSlots(deps.net);

  // --- Timer + grunt tick ---
  ({ accum: accum.build, timer: state.timer } = tickTimer(
    accum.build,
    dt,
    state.buildTimer,
  ));
  accum.grunt += dt;
  if (accum.grunt >= 1.0) {
    accum.grunt -= 1.0;
    deps.tickGrunts(state);
  }

  // --- Process each controller's build actions, collect phantoms ---
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
  const isHost = deps.net?.isHost ?? true;
  const lastSentPiecePhantom = deps.net?.lastSentPiecePhantom ?? EMPTY_MAP;
  const sendOpponentPiecePlaced = deps.net?.sendOpponentPiecePlaced;
  const sendOpponentPhantom = deps.net?.sendOpponentPhantom;

  // Pass 1: tick only local, non-eliminated controllers (process input & AI decisions)
  for (const ctrl of localActiveControllers(
    controllers,
    remoteHumanSlots,
    state,
  )) {
    const wallSnapshot =
      isHost && !deps.isHuman(ctrl)
        ? new Set(state.players[ctrl.playerId]!.walls)
        : null;
    const hadInterior = state.players[ctrl.playerId]!.interior.size > 0;

    const phantoms = ctrl.buildTick(state, dt);

    // Broadcast new walls placed by AI controllers
    if (wallSnapshot && sendOpponentPiecePlaced) {
      broadcastNewWalls(
        state,
        ctrl.playerId,
        wallSnapshot,
        sendOpponentPiecePlaced,
      );
    }

    if (!hadInterior && state.players[ctrl.playerId]!.interior.size > 0) {
      deps.onFirstEnclosure?.(ctrl.playerId);
    }

    for (const p of phantoms) {
      if (deps.isHuman(ctrl)) {
        frame.phantoms.humanPhantoms!.push({
          offsets: p.offsets,
          row: p.row,
          col: p.col,
          valid: p.valid,
          playerId: p.playerId,
        });
      } else {
        frame.phantoms.aiPhantoms!.push({
          offsets: p.offsets,
          row: p.row,
          col: p.col,
          playerId: p.playerId,
        });
      }

      if (!isHost || !sendOpponentPhantom) continue;
      if (!phantomChanged(lastSentPiecePhantom, p.playerId, piecePhantomKey(p)))
        continue;
      sendOpponentPhantom({
        playerId: p.playerId,
        row: p.row,
        col: p.col,
        offsets: p.offsets,
        valid: p.valid,
      });
    }
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
    sendOpponentPiecePlaced({ playerId, row: 0, col: 0, offsets });
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
      ...remotePiecePhantoms.filter(
        (p) =>
          !remoteHumanSlots.has(p.playerId) &&
          !state.players[p.playerId]?.eliminated,
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
  const isHost = deps.net?.isHost ?? true;
  const serializePlayers = deps.net?.serializePlayers ?? (() => []);
  const sendBuildEnd = deps.net?.sendBuildEnd;

  // Pass 2: finalize ALL controllers (including remote) for phase transition
  for (const ctrl of controllers) {
    if (remoteHumanSlots.has(ctrl.playerId)) continue;
    ctrl.endBuild(state);
  }

  // Stash pre-sweep walls so the live render keeps showing them
  // until the Place Cannons banner starts and consumes them.
  deps.banner.pendingOldWalls = snapshotAllWalls(state);

  const { needsReselect, eliminated } = deps.finalizeBuildPhase(state);
  if (isHost && sendBuildEnd) {
    sendBuildEnd({
      needsReselect,
      eliminated,
      scores: state.players.map((p) => p.score),
      players: serializePlayers(state),
    });
  }

  deps.showScoreDeltas(() => {
    for (const pid of [...needsReselect, ...eliminated]) {
      if (remoteHumanSlots.has(pid)) continue;
      controllers[pid]!.onLifeLost();
    }

    if (needsReselect.length > 0 || eliminated.length > 0) {
      deps.showLifeLostDialog(needsReselect, eliminated);
      return;
    }

    deps.afterLifeLostResolved();
  });
}
