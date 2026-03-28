import { MSG, type ServerMessage } from "../server/protocol.ts";
import type { ImpactEvent } from "./battle-system.ts";
import type { OrbitParams } from "./controller-interfaces.ts";
import { selectPlayerTower } from "./game-engine.ts";
import type { PixelPos } from "./geometry-types.ts";
import {
  type CannonPhantom,
  type PiecePhantom,
  toCannonMode,
} from "./online-types.ts";
import { inBoundsStrict } from "./spatial.ts";
import {
  CANNON_MODES,
  type GameState,
  LifeLostChoice,
  type ResolvedChoice,
  type SelectionState,
} from "./types.ts";

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
  confirmSelectionForPlayer: (playerId: number, isReselect: boolean) => void;
  allSelectionsConfirmed: () => boolean;
  finishReselection: () => void;
  finishSelection: () => void;
  applyPiecePlacement: (
    state: GameState,
    playerId: number,
    offsets: readonly [number, number][],
    row: number,
    col: number,
  ) => void;
  onFirstEnclosure?: (playerId: number) => void;
  applyCannonPlacement: (
    state: GameState,
    playerId: number,
    row: number,
    col: number,
    mode: string,
  ) => void;
  canApplyPiecePlacement: (
    state: GameState,
    playerId: number,
    offsets: readonly [number, number][],
    row: number,
    col: number,
  ) => boolean;
  canApplyCannonPlacement: (
    state: GameState,
    playerId: number,
    row: number,
    col: number,
    mode: string,
  ) => boolean;
  applyImpactEvent: (state: GameState, event: ImpactEvent) => void;
  gridCols: number;
  remoteCrosshairs: Map<number, PixelPos>;
  watcherOrbitParams: Map<number, OrbitParams>;
  getRemotePiecePhantoms: () => readonly PiecePhantom[];
  setRemotePiecePhantoms: (value: readonly PiecePhantom[]) => void;
  getRemoteCannonPhantoms: () => readonly CannonPhantom[];
  setRemoteCannonPhantoms: (value: readonly CannonPhantom[]) => void;
  getLifeLostDialog: () => LifeLostChoiceDialog | null;
  queueEarlyLifeLostChoice: (playerId: number, choice: LifeLostChoice) => void;
}

export function handleServerIncrementalMessage(
  msg: ServerMessage,
  deps: HandleServerIncrementalDeps,
): boolean {
  const state = deps.getState();

  switch (msg.type) {
    case MSG.OPPONENT_TOWER_SELECTED: {
      if (!state || !validPid(msg.playerId, state)) return true;
      if (msg.towerIdx < 0 || msg.towerIdx >= state.map.towers.length)
        return true;
      if (acceptRemote(msg.playerId, deps)) {
        const tower = state.map.towers[msg.towerIdx];
        const expectedZone: number | undefined =
          state.playerZones[msg.playerId];
        if (
          tower &&
          expectedZone !== undefined &&
          tower.zone === expectedZone
        ) {
          const player = state.players[msg.playerId]!;
          selectPlayerTower(player, tower);
          const ss = deps.selectionStates.get(msg.playerId);
          if (ss && !ss.confirmed) {
            ss.highlighted = msg.towerIdx;
            deps.syncSelectionOverlay();
            if (msg.confirmed && deps.isHost) {
              deps.confirmSelectionForPlayer(
                msg.playerId,
                deps.isCastleReselectPhase(),
              );
            } else if (msg.confirmed) {
              ss.confirmed = true;
            }
          }
        }
      }
      return true;
    }

    case MSG.OPPONENT_PIECE_PLACED: {
      if (!state || !validPid(msg.playerId, state)) return true;
      if (!inBoundsStrict(msg.row, msg.col)) return true;
      if (!Array.isArray(msg.offsets) || msg.offsets.length === 0) return true;
      if (acceptRemote(msg.playerId, deps)) {
        if (
          deps.isHost &&
          !deps.canApplyPiecePlacement(
            state,
            msg.playerId,
            msg.offsets,
            msg.row,
            msg.col,
          )
        ) {
          deps.log(
            `piece_placed: rejected invalid placement for P${msg.playerId}`,
          );
          return true;
        }
        deps.log(
          `applying piece placement for P${msg.playerId} (${msg.offsets.length} tiles)`,
        );
        const hadInterior = state.players[msg.playerId]!.interior.size > 0;
        deps.applyPiecePlacement(
          state,
          msg.playerId,
          msg.offsets,
          msg.row,
          msg.col,
        );
        if (!hadInterior && state.players[msg.playerId]!.interior.size > 0) {
          deps.onFirstEnclosure?.(msg.playerId);
        }
      }
      return true;
    }

    case MSG.OPPONENT_CANNON_PLACED: {
      if (!state || !validPid(msg.playerId, state)) return true;
      if (!inBoundsStrict(msg.row, msg.col)) return true;
      if (!CANNON_MODES.has(msg.mode)) return true;
      if (acceptRemote(msg.playerId, deps)) {
        if (
          deps.isHost &&
          !deps.canApplyCannonPlacement(
            state,
            msg.playerId,
            msg.row,
            msg.col,
            msg.mode,
          )
        ) {
          deps.log(
            `cannon_placed: rejected invalid placement for P${msg.playerId}`,
          );
          return true;
        }
        deps.applyCannonPlacement(
          state,
          msg.playerId,
          msg.row,
          msg.col,
          msg.mode,
        );
      }
      return true;
    }

    case MSG.CANNON_FIRED: {
      if (!state || !validPid(msg.playerId, state)) return true;
      if (!Number.isFinite(msg.speed) || msg.speed <= 0) return true;
      if (
        !Number.isFinite(msg.startX) ||
        !Number.isFinite(msg.startY) ||
        !Number.isFinite(msg.targetX) ||
        !Number.isFinite(msg.targetY)
      )
        return true;
      if (acceptRemote(msg.playerId, deps)) {
        const player = state.players[msg.playerId];
        if (!player || !player.cannons[msg.cannonIdx]) {
          deps.log(
            `cannon_fired: stale ref P${msg.playerId} cannon[${msg.cannonIdx}] — skipped`,
          );
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
        if ("row" in msg && "col" in msg && !inBoundsStrict(msg.row, msg.col))
          return true;
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
      if (acceptRemote(msg.playerId, deps)) {
        deps.remoteCrosshairs.set(msg.playerId, { x: msg.x, y: msg.y });
        if (msg.orbit) deps.watcherOrbitParams.set(msg.playerId, msg.orbit);
      }
      return true;
    }

    case MSG.TOWER_KILLED:
      if (!deps.isHost && state) {
        if (msg.towerIdx < 0 || msg.towerIdx >= state.towerAlive.length)
          return true;
        state.towerAlive[msg.towerIdx] = false;
      }
      return true;

    case MSG.OPPONENT_PHANTOM: {
      if (state && !validPid(msg.playerId, state)) return true;
      if (!inBoundsStrict(msg.row, msg.col)) return true;
      if (acceptRemote(msg.playerId, deps)) {
        setPhantom(
          deps.getRemotePiecePhantoms(),
          msg.playerId,
          {
            offsets: msg.offsets,
            row: msg.row,
            col: msg.col,
            playerId: msg.playerId,
          },
          deps.setRemotePiecePhantoms,
        );
      }
      return true;
    }

    case MSG.OPPONENT_CANNON_PHANTOM: {
      if (state && !validPid(msg.playerId, state)) return true;
      if (!inBoundsStrict(msg.row, msg.col)) return true;
      if (acceptRemote(msg.playerId, deps)) {
        setPhantom(
          deps.getRemoteCannonPhantoms(),
          msg.playerId,
          {
            row: msg.row,
            col: msg.col,
            valid: msg.valid,
            kind: toCannonMode(msg.mode),
            playerId: msg.playerId,
            facing: msg.facing,
          },
          deps.setRemoteCannonPhantoms,
        );
      }
      return true;
    }

    case MSG.LIFE_LOST_CHOICE: {
      if (!deps.isHost) return true;
      deps.log(
        `life_lost_choice from P${msg.playerId}: ${msg.choice} (dialog=${deps.getLifeLostDialog() ? "active" : "null"})`,
      );
      const validated = parseLifeLostChoice(msg.choice);
      if (validated === null) return true;
      const dialog = deps.getLifeLostDialog();
      if (dialog) {
        const entry = dialog.entries.find((e) => e.playerId === msg.playerId);
        if (entry && entry.choice === LifeLostChoice.PENDING) {
          entry.choice = validated;
        }
      } else {
        // Dialog not yet created — queue choice for when it appears
        deps.queueEarlyLifeLostChoice(msg.playerId, validated);
      }
      return true;
    }

    default:
      return false;
  }
}

/** Parse an untrusted value into a resolved LifeLostChoice, or null if invalid. */
function parseLifeLostChoice(raw: unknown): ResolvedChoice | null {
  if (raw === LifeLostChoice.CONTINUE) return LifeLostChoice.CONTINUE;
  if (raw === LifeLostChoice.ABANDON) return LifeLostChoice.ABANDON;
  return null;
}

/** Watchers accept all remote messages; hosts only accept from remote humans. */
function acceptRemote(
  pid: number,
  deps: Pick<HandleServerIncrementalDeps, "isHost" | "remoteHumanSlots">,
): boolean {
  return !deps.isHost || deps.remoteHumanSlots.has(pid);
}

function validPid(pid: number, state: GameState): boolean {
  return Number.isInteger(pid) && pid >= 0 && pid < state.players.length;
}

/** Replace or append a phantom entry for `playerId` in an array, then persist via `set`. */
function setPhantom<T extends { playerId: number }>(
  current: readonly T[],
  playerId: number,
  next: T,
  set: (value: readonly T[]) => void,
): void {
  const updated = current.filter((p) => p.playerId !== playerId);
  updated.push(next);
  set(updated);
}
