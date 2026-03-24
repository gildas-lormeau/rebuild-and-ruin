import type { ServerMessage } from "../server/protocol.ts";
import { MSG } from "../server/protocol.ts";
import type { ImpactEvent } from "./battle-system.ts";
import type { PixelPos } from "./geometry-types.ts";
import { GRID_COLS, GRID_ROWS } from "./grid.ts";
import { CHOICE_ABANDON, CHOICE_CONTINUE, type LifeLostChoice } from "./life-lost.ts";
import type { OrbitParams } from "./player-controller.ts";
import type { SelectionState } from "./selection.ts";
import { CannonMode, type GameState } from "./types.ts";

interface LifeLostChoiceEntry {
  playerId: number;
  choice: LifeLostChoice;
}
interface LifeLostChoiceDialog {
  entries: LifeLostChoiceEntry[];
}
interface HandleServerIncrementalDeps {
  log: (msg: string) => void;
  isHost: boolean;
  getState: () => GameState | undefined;
  remoteHumanSlots: Set<number>;
  selectionStates: Map<number, SelectionState>;
  syncSelectionOverlay: () => void;
  isCastleReselectPhase: () => boolean;
  onRemotePlayerReselected: (playerId: number) => void;
  allSelectionsConfirmed: () => boolean;
  finishReselection: () => void;
  finishSelection: () => void;
  applyPiecePlacement: (
    state: GameState,
    playerId: number,
    offsets: [number, number][],
    row: number,
    col: number,
  ) => void;
  applyCannonPlacement: (
    state: GameState,
    playerId: number,
    row: number,
    col: number,
    mode: string,
  ) => void;
  applyImpactEvent: (state: GameState, event: ImpactEvent) => void;
  gridCols: number;
  remoteCrosshairs: Map<number, PixelPos>;
  watcherOrbitParams: Map<number, OrbitParams>;
  getRemotePiecePhantoms: () => {
    offsets: [number, number][];
    row: number;
    col: number;
    playerId: number;
  }[];
  setRemotePiecePhantoms: (
    value: {
      offsets: [number, number][];
      row: number;
      col: number;
      playerId: number;
    }[],
  ) => void;
  getRemoteCannonPhantoms: () => {
    row: number;
    col: number;
    valid: boolean;
    isSuper?: boolean;
    isBalloon?: boolean;
    playerId: number;
    facing?: number;
  }[];
  setRemoteCannonPhantoms: (
    value: {
      row: number;
      col: number;
      valid: boolean;
      isSuper?: boolean;
      isBalloon?: boolean;
      playerId: number;
      facing?: number;
    }[],
  ) => void;
  getLifeLostDialog: () => LifeLostChoiceDialog | null;
}

export function handleServerIncrementalMessage(
  msg: ServerMessage,
  deps: HandleServerIncrementalDeps,
): boolean {
  const state = deps.getState();

  switch (msg.type) {
    case MSG.OPPONENT_TOWER_SELECTED: {
      if (!state || !validPid(msg.playerId, state)) return true;
      if (msg.towerIdx < 0 || msg.towerIdx >= state.map.towers.length) return true;
      const acceptTower =
        !deps.isHost || deps.remoteHumanSlots.has(msg.playerId);
      if (acceptTower) {
        const tower = state.map.towers[msg.towerIdx];
        if (tower) {
          const player = state.players[msg.playerId]!;
          player.homeTower = tower;
          player.ownedTowers = [tower];
          const ss = deps.selectionStates.get(msg.playerId);
          if (ss && !ss.confirmed) {
            ss.highlighted = msg.towerIdx;
            if (msg.confirmed) ss.confirmed = true;
            deps.syncSelectionOverlay();
            if (deps.isHost) {
              const isReselect = deps.isCastleReselectPhase();
              if (isReselect) {
                deps.onRemotePlayerReselected(msg.playerId);
              }
              if (deps.allSelectionsConfirmed()) {
                if (isReselect) deps.finishReselection();
                else deps.finishSelection();
              }
            }
          }
        }
      }
      return true;
    }

    case MSG.OPPONENT_PIECE_PLACED: {
      if (!state || !validPid(msg.playerId, state)) return true;
      if (!inBounds(msg.row, msg.col)) return true;
      if (!Array.isArray(msg.offsets) || msg.offsets.length === 0) return true;
      const acceptPiece =
        !deps.isHost || deps.remoteHumanSlots.has(msg.playerId);
      if (acceptPiece) {
        deps.log(
          `applying piece placement for P${msg.playerId} (${msg.offsets.length} tiles)`,
        );
        deps.applyPiecePlacement(
          state,
          msg.playerId,
          msg.offsets,
          msg.row,
          msg.col,
        );
      }
      return true;
    }

    case MSG.OPPONENT_CANNON_PLACED: {
      if (!state || !validPid(msg.playerId, state)) return true;
      if (!inBounds(msg.row, msg.col)) return true;
      const acceptCannon =
        !deps.isHost || deps.remoteHumanSlots.has(msg.playerId);
      deps.log(
        `opponent_cannon_placed: P${msg.playerId} accept=${acceptCannon} isHost=${deps.isHost} remoteHumans=[${[...deps.remoteHumanSlots]}] hasState=${!!state}`,
      );
      if (acceptCannon) {
        deps.applyCannonPlacement(
          state,
          msg.playerId,
          msg.row,
          msg.col,
          msg.mode,
        );
        deps.log(
          `  -> P${msg.playerId} now has ${state.players[msg.playerId]!.cannons.length} cannons`,
        );
      }
      return true;
    }

    case MSG.CANNON_FIRED: {
      if (!state || !validPid(msg.playerId, state)) return true;
      if (!Number.isFinite(msg.speed) || msg.speed <= 0) return true;
      if (!Number.isFinite(msg.startX) || !Number.isFinite(msg.startY) ||
          !Number.isFinite(msg.targetX) || !Number.isFinite(msg.targetY)) return true;
      const acceptFire =
        !deps.isHost || deps.remoteHumanSlots.has(msg.playerId);
      if (acceptFire) {
        const player = state.players[msg.playerId];
        if (!player || !player.cannons[msg.cannonIdx]) {
          deps.log(`cannon_fired: stale ref P${msg.playerId} cannon[${msg.cannonIdx}] — skipped`);
          return true;
        }
        state.cannonballs.push({
          cannonIdx: msg.cannonIdx,
          startX: msg.startX,
          startY: msg.startY,
          x: msg.startX,
          y: msg.startY,
          targetX: msg.targetX,
          targetY: msg.targetY,
          speed: msg.speed,
          playerId: msg.playerId,
          incendiary: msg.incendiary,
        });
      }
      return true;
    }

    case MSG.WALL_DESTROYED:
    case MSG.CANNON_DAMAGED:
    case MSG.HOUSE_DESTROYED:
    case MSG.GRUNT_KILLED:
    case MSG.GRUNT_SPAWNED:
    case MSG.PIT_CREATED:
      if (!deps.isHost && state) {
        if ("row" in msg && "col" in msg && !inBounds(msg.row, msg.col)) return true;
        if ("playerId" in msg && !validPid(msg.playerId, state)) return true;
        if (msg.type === MSG.WALL_DESTROYED) {
          const wallKey = msg.row * deps.gridCols + msg.col;
          const owner = state.players.find((p) => p.walls.has(wallKey));
          deps.log(
            `wall_destroyed: (${msg.row},${msg.col}) owner=P${owner?.id ?? "?"} shooter=P${msg.shooterId ?? "?"}`,
          );
        } else if (msg.type === MSG.CANNON_DAMAGED) {
          deps.log(
            `cannon_damaged: P${msg.playerId} newHp=${msg.newHp} shooter=P${msg.shooterId ?? "?"}`,
          );
        }
        deps.applyImpactEvent(state, msg as ImpactEvent);
      }
      return true;

    case MSG.AIM_UPDATE: {
      if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return true;
      const acceptAim = !deps.isHost || deps.remoteHumanSlots.has(msg.playerId);
      if (acceptAim) {
        deps.remoteCrosshairs.set(msg.playerId, { x: msg.x, y: msg.y });
        if (msg.orbit) deps.watcherOrbitParams.set(msg.playerId, msg.orbit);
      }
      return true;
    }

    case MSG.TOWER_KILLED:
      if (!deps.isHost && state) {
        if (msg.towerIdx < 0 || msg.towerIdx >= state.towerAlive.length) return true;
        state.towerAlive[msg.towerIdx] = false;
      }
      return true;

    case MSG.OPPONENT_PHANTOM: {
      if (state && !validPid(msg.playerId, state)) return true;
      if (!inBounds(msg.row, msg.col)) return true;
      const acceptPhantom =
        !deps.isHost || deps.remoteHumanSlots.has(msg.playerId);
      if (acceptPhantom) {
        const next = deps
          .getRemotePiecePhantoms()
          .filter((p) => p.playerId !== msg.playerId);
        next.push({
          offsets: msg.offsets,
          row: msg.row,
          col: msg.col,
          playerId: msg.playerId,
        });
        deps.setRemotePiecePhantoms(next);
      }
      return true;
    }

    case MSG.OPPONENT_CANNON_PHANTOM: {
      if (state && !validPid(msg.playerId, state)) return true;
      if (!inBounds(msg.row, msg.col)) return true;
      const acceptCannonPhantom =
        !deps.isHost || deps.remoteHumanSlots.has(msg.playerId);
      if (acceptCannonPhantom) {
        const next = deps
          .getRemoteCannonPhantoms()
          .filter((p) => p.playerId !== msg.playerId);
        next.push({
          row: msg.row,
          col: msg.col,
          valid: msg.valid,
          isSuper: msg.mode === CannonMode.SUPER,
          isBalloon: msg.mode === CannonMode.BALLOON,
          playerId: msg.playerId,
          facing: msg.facing,
        });
        deps.setRemoteCannonPhantoms(next);
      }
      return true;
    }

    case MSG.LIFE_LOST_CHOICE: {
      if (!deps.isHost) return true;
      if (msg.choice !== CHOICE_CONTINUE && msg.choice !== CHOICE_ABANDON) return true;
      deps.log(
        `life_lost_choice from P${msg.playerId}: ${msg.choice} (dialog=${deps.getLifeLostDialog() ? "active" : "null"})`,
      );
      const dialog = deps.getLifeLostDialog();
      if (dialog) {
        const entry = dialog.entries.find(
          (e) => e.playerId === msg.playerId,
        );
        if (entry && entry.choice === "pending") {
          entry.choice = msg.choice;
        }
      }
      return true;
    }

    default:
      return false;
  }
}
function validPid(pid: number, state: GameState): boolean {
  return Number.isInteger(pid) && pid >= 0 && pid < state.players.length;
}
function inBounds(row: number, col: number): boolean {
  return Number.isInteger(row) && Number.isInteger(col) &&
    row >= 0 && row < GRID_ROWS && col >= 0 && col < GRID_COLS;
}
