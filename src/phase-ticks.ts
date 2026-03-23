import type { SerializedPlayer } from "./online-serialize.ts";
import {
  type CannonPhantom,
  cannonPhantomKey,
  type HumanPiecePhantom,
  type PiecePhantom,
  piecePhantomKey,
} from "./online-types.ts";
import type { PlayerController } from "./player-controller.ts";
import { EMPTY_TILE_SET, unpackTile } from "./spatial.ts";
import type { GameState } from "./types.ts";

/** Shared empty map — avoids allocating a throwaway Map on every frame. */
const EMPTY_MAP: ReadonlyMap<number, string> = new Map<number, string>();

// ---------------------------------------------------------------------------
// Networking context — groups all online-only deps for tick functions
// ---------------------------------------------------------------------------

/** Base networking context shared by all phase ticks. */
export interface HostNetContext {
  remoteHumanSlots: Set<number>;
  isHost: boolean;
}

/** Networking context for the cannon placement phase. */
interface CannonPhaseNet extends HostNetContext {
  remoteCannonPhantoms: CannonPhantom[];
  lastSentCannonPhantom: Map<number, string>;
  autoPlaceCannons: (
    player: GameState["players"][number],
    max: number,
    state: GameState,
  ) => void;
  sendOpponentCannonPlaced: (msg: {
    playerId: number;
    row: number;
    col: number;
    mode: "normal" | "super" | "balloon";
  }) => void;
  sendOpponentCannonPhantom: (msg: {
    playerId: number;
    row: number;
    col: number;
    mode: "normal" | "super" | "balloon";
    valid: boolean;
    facing: number;
  }) => void;
}

/** Networking context for the wall build phase. */
interface BuildPhaseNet extends HostNetContext {
  remotePiecePhantoms: PiecePhantom[];
  lastSentPiecePhantom: Map<number, string>;
  serializePlayers: (state: GameState) => SerializedPlayer[];
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

// ---------------------------------------------------------------------------
// Cannon placement phase tick
// ---------------------------------------------------------------------------

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

export function tickHostCannonPhase(deps: TickHostCannonPhaseDeps): boolean {
  const { dt, state, accum, frame, controllers, render, startBattle } = deps;
  // Networking defaults (no-op for local play)
  const remoteHumanSlots = deps.net?.remoteHumanSlots ?? EMPTY_TILE_SET as Set<number>;
  const isHost = deps.net?.isHost ?? true;
  const remoteCannonPhantoms = deps.net?.remoteCannonPhantoms ?? [];
  const lastSentCannonPhantom = deps.net?.lastSentCannonPhantom ?? EMPTY_MAP as Map<number, string>;
  const autoPlaceCannons = deps.net?.autoPlaceCannons;
  const sendOpponentCannonPlaced = deps.net?.sendOpponentCannonPlaced;
  const sendOpponentCannonPhantom = deps.net?.sendOpponentCannonPhantom;

  accum.cannon += dt;
  state.timer = Math.max(0, state.cannonPlaceTimer - accum.cannon);

  frame.phantoms = { aiCannonPhantoms: [] };
  for (const ctrl of controllers) {
    if (remoteHumanSlots.has(ctrl.playerId)) continue;
    if (state.players[ctrl.playerId]?.eliminated) continue;

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
          mode: c.super ? "super" : c.balloon ? "balloon" : "normal",
        });
      }
    }

    if (!phantom) continue;

    frame.phantoms.aiCannonPhantoms!.push(phantom);
    if (!isHost || !sendOpponentCannonPhantom) continue;

    const key = cannonPhantomKey(phantom);
    if (lastSentCannonPhantom.get(ctrl.playerId) === key) continue;

    lastSentCannonPhantom.set(ctrl.playerId, key);
    sendOpponentCannonPhantom({
      playerId: ctrl.playerId,
      row: phantom.row,
      col: phantom.col,
      mode: phantom.isSuper
        ? "super"
        : phantom.isBalloon
          ? "balloon"
          : "normal",
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
    if (remoteHumanSlots.has(ctrl.playerId)) {
      if (state.round === 1 && autoPlaceCannons) {
        const player = state.players[ctrl.playerId]!;
        if (!player.eliminated && player.cannons.length === 0) {
          const max = state.cannonLimits[ctrl.playerId] ?? 0;
          autoPlaceCannons(player, max, state);
        }
      }
      continue;
    }
    const max = state.cannonLimits[ctrl.playerId] ?? 0;
    ctrl.flushCannons(state, max);
  }

  startBattle();
  return true;
}

// ---------------------------------------------------------------------------
// Build phase tick
// ---------------------------------------------------------------------------

interface TickHostBuildPhaseDeps {
  dt: number;
  state: GameState;
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
  showLifeLostDialog: (needsReselect: number[], eliminated: number[]) => void;
  afterLifeLostResolved: () => boolean;
  net?: BuildPhaseNet;
}

export function tickHostBuildPhase(deps: TickHostBuildPhaseDeps): boolean {
  const {
    dt, state, accum, frame, controllers, render,
    tickGrunts, isHuman, finalizeBuildPhase, showLifeLostDialog, afterLifeLostResolved,
  } = deps;
  // Networking defaults (no-op for local play)
  const remoteHumanSlots = deps.net?.remoteHumanSlots ?? EMPTY_TILE_SET as Set<number>;
  const isHost = deps.net?.isHost ?? true;
  const remotePiecePhantoms = deps.net?.remotePiecePhantoms ?? [];
  const lastSentPiecePhantom = deps.net?.lastSentPiecePhantom ?? EMPTY_MAP as Map<number, string>;
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
  for (const ctrl of controllers) {
    if (remoteHumanSlots.has(ctrl.playerId)) continue;
    if (state.players[ctrl.playerId]?.eliminated) continue;

    const wallSnapshot =
      isHost && !isHuman(ctrl)
        ? new Set(state.players[ctrl.playerId]!.walls)
        : null;

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
      const key = piecePhantomKey(p);
      if (lastSentPiecePhantom.get(p.playerId) === key) continue;

      lastSentPiecePhantom.set(p.playerId, key);
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

  const { needsReselect, eliminated } = finalizeBuildPhase(state);
  if (isHost && sendBuildEnd) {
    sendBuildEnd({
      needsReselect,
      eliminated,
      scores: state.players.map((p) => p.score),
      players: serializePlayers(state),
    });
  }

  for (const pid of [...needsReselect, ...eliminated]) {
    if (remoteHumanSlots.has(pid)) continue;
    controllers[pid]!.onLifeLost();
  }

  if (needsReselect.length > 0 || eliminated.length > 0) {
    showLifeLostDialog(needsReselect, eliminated);
    return true;
  }

  return afterLifeLostResolved();
}
