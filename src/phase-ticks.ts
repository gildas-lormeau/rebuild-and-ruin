import { GRID_COLS } from "./grid.ts";
import type { GameState } from "./types.ts";
import type { PlayerController } from "./player-controller.ts";
import type { SerializedPlayer } from "./online-serialize.ts";

import type {
  CannonPhantom,
  PiecePhantom,
  HumanPiecePhantom,
} from "./online-types.ts";

/** Shared empty collections — avoids allocating throwaway objects on every frame. */
const EMPTY_SET: ReadonlySet<number> = new Set<number>();
const EMPTY_MAP: ReadonlyMap<number, string> = new Map<number, string>();

interface HostFrame {
  phantoms: {
    aiCannonPhantoms?: CannonPhantom[];
    aiPhantoms?: PiecePhantom[];
    humanPhantoms?: HumanPiecePhantom[];
  };
}

interface TickHostCannonPhaseDeps {
  // Core game deps (required)
  dt: number;
  state: GameState;
  accum: { cannon: number };
  frame: HostFrame;
  controllers: PlayerController[];
  render: () => void;
  startBattle: () => void;

  // Networking hooks (optional, default to no-op / empty)
  remoteHumanSlots?: Set<number>;
  remoteCannonPhantoms?: CannonPhantom[];
  lastSentCannonPhantom?: Map<number, string>;
  isHost?: boolean;
  autoPlaceCannons?: (
    player: GameState["players"][number],
    max: number,
    state: GameState,
  ) => void;
  sendOpponentCannonPlaced?: (msg: {
    playerId: number;
    row: number;
    col: number;
    mode: "normal" | "super" | "balloon";
  }) => void;
  sendOpponentCannonPhantom?: (msg: {
    playerId: number;
    row: number;
    col: number;
    mode: "normal" | "super" | "balloon";
    valid: boolean;
    facing: number;
  }) => void;
}

export function tickHostCannonPhase(deps: TickHostCannonPhaseDeps): boolean {
  const {
    dt,
    state,
    accum,
    frame,
    controllers,
    render,
    startBattle,
    // Networking hooks with sensible defaults
    remoteHumanSlots = EMPTY_SET as Set<number>,
    remoteCannonPhantoms = [],
    lastSentCannonPhantom = EMPTY_MAP as Map<number, string>,
    isHost = true,
    autoPlaceCannons = () => {},
    sendOpponentCannonPlaced = () => {},
    sendOpponentCannonPhantom = () => {},
  } = deps;

  accum.cannon += dt;
  state.timer = Math.max(0, state.cannonPlaceTimer - accum.cannon);

  frame.phantoms = { aiCannonPhantoms: [] };
  for (const ctrl of controllers) {
    if (remoteHumanSlots.has(ctrl.playerId)) continue;
    if (state.players[ctrl.playerId]?.eliminated) continue;

    const cannonsBefore = state.players[ctrl.playerId]!.cannons.length;
    const phantom = ctrl.cannonTick(state, dt);

    if (isHost) {
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
    if (!isHost) continue;

    const key = `${phantom.row},${phantom.col},${phantom.isSuper},${phantom.isBalloon}`;
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

  if (remoteHumanSlots.size > 0 && remoteCannonPhantoms.length > 0) {
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
      if (state.round === 1) {
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

interface TickHostBuildPhaseDeps {
  // Core game deps (required)
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

  // Networking hooks (optional, default to no-op / empty)
  remoteHumanSlots?: Set<number>;
  remotePiecePhantoms?: PiecePhantom[];
  lastSentPiecePhantom?: Map<number, string>;
  isHost?: boolean;
  serializePlayers?: (state: GameState) => SerializedPlayer[];
  sendOpponentPiecePlaced?: (msg: {
    playerId: number;
    row: number;
    col: number;
    offsets: [number, number][];
  }) => void;
  sendOpponentPhantom?: (msg: {
    playerId: number;
    row: number;
    col: number;
    offsets: [number, number][];
    valid: boolean;
  }) => void;
  sendBuildEnd?: (msg: {
    needsReselect: number[];
    eliminated: number[];
    scores: number[];
    players: SerializedPlayer[];
  }) => void;
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
    // Networking hooks with sensible defaults
    remoteHumanSlots = EMPTY_SET as Set<number>,
    remotePiecePhantoms = [],
    lastSentPiecePhantom = EMPTY_MAP as Map<number, string>,
    isHost = true,
    serializePlayers = () => [],
    sendOpponentPiecePlaced = () => {},
    sendOpponentPhantom = () => {},
    sendBuildEnd = () => {},
  } = deps;

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

    if (wallSnapshot) {
      const player = state.players[ctrl.playerId]!;
      if (player.walls.size > wallSnapshot.size) {
        const offsets: [number, number][] = [];
        for (const key of player.walls) {
          if (!wallSnapshot.has(key)) {
            offsets.push([Math.floor(key / GRID_COLS), key % GRID_COLS]);
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

      if (!isHost) continue;
      const key = `${p.row},${p.col},${p.offsets.map((o) => o.join(":")).join(";")}`;
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

  if (remoteHumanSlots.size > 0 && remotePiecePhantoms.length > 0) {
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
  if (isHost) {
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
