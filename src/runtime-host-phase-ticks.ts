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
} from "./tick-context.ts";
import { CannonMode, type GameState } from "./types.ts";

/** Networking context for the cannon placement phase. */
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

/** Networking context for the wall build phase. */
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

export function tickHostCannonPhase(deps: TickHostCannonPhaseDeps): boolean {
  const { dt, state, accum, frame, controllers, render, startBattle } = deps;
  // Networking defaults (no-op for local play)
  const remoteHumanSlots = getRemoteSlots(deps.net);
  const isHost = deps.net?.isHost ?? true;
  const remoteCannonPhantoms = deps.net?.remoteCannonPhantoms ?? [];
  const lastSentCannonPhantom = deps.net?.lastSentCannonPhantom ?? EMPTY_MAP;
  const sendOpponentCannonPlaced = deps.net?.sendOpponentCannonPlaced;
  const sendOpponentCannonPhantom = deps.net?.sendOpponentCannonPhantom;

  accum.cannon += dt;
  state.timer = Math.max(0, state.cannonPlaceTimer - accum.cannon);

  frame.phantoms = { aiCannonPhantoms: [] };
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
          mode: c.kind,
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
        (p) => !state.players[p.playerId]?.eliminated,
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
  const {
    dt,
    state,
    accum,
    frame,
    controllers,
    render,
    tickGrunts,
    isHuman,
    finalizeBuildPhase,
    showLifeLostDialog,
    afterLifeLostResolved,
    showScoreDeltas,
  } = deps;
  // Networking defaults (no-op for local play)
  const remoteHumanSlots = getRemoteSlots(deps.net);
  const isHost = deps.net?.isHost ?? true;
  const remotePiecePhantoms = deps.net?.remotePiecePhantoms ?? [];
  const lastSentPiecePhantom = deps.net?.lastSentPiecePhantom ?? EMPTY_MAP;
  const serializePlayers = deps.net?.serializePlayers ?? (() => []);
  const sendOpponentPiecePlaced = deps.net?.sendOpponentPiecePlaced;
  const sendOpponentPhantom = deps.net?.sendOpponentPhantom;
  const sendBuildEnd = deps.net?.sendBuildEnd;

  accum.build += dt;
  state.timer = Math.max(0, state.buildTimer - accum.build);
  accum.grunt += dt;
  if (accum.grunt >= 1.0) {
    accum.grunt -= 1.0;
    tickGrunts(state);
  }

  frame.phantoms = { aiPhantoms: [], humanPhantoms: [] };
  for (const ctrl of localActiveControllers(
    controllers,
    remoteHumanSlots,
    state,
  )) {
    const wallSnapshot =
      isHost && !isHuman(ctrl)
        ? new Set(state.players[ctrl.playerId]!.walls)
        : null;
    const hadInterior = state.players[ctrl.playerId]!.interior.size > 0;

    const phantoms = ctrl.buildTick(state, dt);

    if (wallSnapshot && sendOpponentPiecePlaced) {
      const player = state.players[ctrl.playerId]!;
      if (player.walls.size > wallSnapshot.size) {
        const offsets: [number, number][] = [];
        for (const key of player.walls) {
          if (!wallSnapshot.has(key)) {
            const { r, c } = unpackTile(key);
            offsets.push([r, c]);
          }
        }
        if (offsets.length > 0) {
          sendOpponentPiecePlaced({
            playerId: ctrl.playerId,
            row: 0,
            col: 0,
            offsets,
          });
        }
      }
    }

    if (!hadInterior && state.players[ctrl.playerId]!.interior.size > 0) {
      deps.onFirstEnclosure?.(ctrl.playerId);
    }

    for (const p of phantoms) {
      if (isHuman(ctrl)) {
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

  if (remotePiecePhantoms.length > 0) {
    frame.phantoms.aiPhantoms!.push(
      ...remotePiecePhantoms.filter(
        (p) => !state.players[p.playerId]?.eliminated,
      ),
    );
  }

  render();

  if (state.timer > 0) return false;

  for (const ctrl of controllers) {
    if (remoteHumanSlots.has(ctrl.playerId)) continue;
    ctrl.endBuild(state);
  }

  // Stash pre-sweep walls so the live render keeps showing them
  // until the Place Cannons banner starts and consumes them.
  deps.banner.pendingOldWalls = snapshotAllWalls(state);

  const { needsReselect, eliminated } = finalizeBuildPhase(state);
  if (isHost && sendBuildEnd) {
    sendBuildEnd({
      needsReselect,
      eliminated,
      scores: state.players.map((p) => p.score),
      players: serializePlayers(state),
    });
  }

  showScoreDeltas(() => {
    for (const pid of [...needsReselect, ...eliminated]) {
      if (remoteHumanSlots.has(pid)) continue;
      controllers[pid]!.onLifeLost();
    }

    if (needsReselect.length > 0 || eliminated.length > 0) {
      showLifeLostDialog(needsReselect, eliminated);
      return;
    }

    afterLifeLostResolved();
  });
  return true;
}
