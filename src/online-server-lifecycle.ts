/**
 * Server lifecycle message handlers — room join, slot selection, phase transitions.
 *
 * NOTE: deps.session.isHost is VOLATILE (can flip during host promotion).
 * All reads here are inline (not cached), which is safe.
 * The `!deps.session.isHost` guards on phase-transition cases ensure that
 * only watchers apply host-sent checkpoints — the host computes its own. */

import {
  type FullStateMessage,
  type InitMessage,
  MESSAGE,
  type ServerMessage,
} from "../server/protocol.ts";
import { GAME_MODE_CLASSIC } from "./game-constants.ts";
import type { OnlineSession } from "./online-session.ts";
import type { GameState } from "./types.ts";

interface HandleServerLifecycleDeps {
  log: (msg: string) => void;
  now: () => number;

  session: Pick<
    OnlineSession,
    | "isHost"
    | "onlinePlayerId"
    | "hostMigrationSeq"
    | "roomWaitTimerSec"
    | "roomMaxRounds"
    | "roomCannonMaxHp"
    | "roomGameMode"
    | "lobbyStartTime"
    | "occupiedSlots"
    | "remoteHumanSlots"
  >;

  lobby: {
    showWaitingRoom: (code: string, seed: number) => void;
    joined: boolean[];
  };

  ui: {
    getLifeLostDialog: () => unknown;
    clearLifeLostDialog: () => void;
    isLifeLostMode: () => boolean;
    getUpgradePickDialog: () => unknown;
    clearUpgradePickDialog: () => void;
    isUpgradePickMode: () => boolean;
    setModeToGame: () => void;
    setAnnouncement: (msg: string) => void;
    createErrorEl: HTMLElement;
    joinErrorEl: HTMLElement;
  };

  game: {
    getState: () => GameState | undefined;
    initFromServer: (msg: InitMessage) => void;
    enterTowerSelection: () => void;
  };

  transitions: {
    onCastleWalls: (msg: ServerMessage) => void;
    onCannonStart: (msg: ServerMessage) => void;
    onBattleStart: (msg: ServerMessage) => void;
    onBuildStart: (msg: ServerMessage) => void;
    onBuildEnd: (msg: ServerMessage) => void;
    onGameOver: (msg: ServerMessage) => void;
  };

  migration: {
    playerNames: readonly string[];
    promoteToHost: () => void;
    restoreFullState: (msg: FullStateMessage) => void;
  };
}

export function handleServerLifecycleMessage(
  msg: ServerMessage,
  deps: HandleServerLifecycleDeps,
): boolean {
  /** Atomically update all three slot-tracking structures (clear).
   *  Invariant: occupiedSlots, remoteHumanSlots, and lobby.joined must always
   *  be mutated together to avoid phantom entries or orphaned lobby data. */
  const clearLobbySlot = (playerId: number) => {
    deps.lobby.joined[playerId] = false;
    deps.session.occupiedSlots.delete(playerId);
    deps.session.remoteHumanSlots.delete(playerId);
  };

  /** Atomically update all three slot-tracking structures (occupy).
   *  Invariant: occupiedSlots, remoteHumanSlots, and lobby.joined must always
   *  be mutated together to avoid phantom entries or orphaned lobby data. */
  const occupyLobbySlot = (playerId: number) => {
    deps.lobby.joined[playerId] = true;
    deps.session.occupiedSlots.add(playerId);
    if (playerId !== deps.session.onlinePlayerId) {
      deps.session.remoteHumanSlots.add(playerId);
    } else {
      deps.session.remoteHumanSlots.delete(playerId);
    }
  };

  // Dismiss stale dialogs when a phase transition arrives from host.
  const isPhaseTransition =
    !deps.session.isHost &&
    (msg.type === MESSAGE.CANNON_START ||
      msg.type === MESSAGE.BATTLE_START ||
      msg.type === MESSAGE.BUILD_START ||
      msg.type === MESSAGE.SELECT_START ||
      msg.type === MESSAGE.CASTLE_WALLS);
  if (isPhaseTransition && deps.ui.getLifeLostDialog()) {
    deps.log("dismissing stale life-lost dialog (phase transition received)");
    deps.ui.clearLifeLostDialog();
    if (deps.ui.isLifeLostMode()) deps.ui.setModeToGame();
  }
  if (isPhaseTransition && deps.ui.getUpgradePickDialog()) {
    deps.log(
      "dismissing stale upgrade pick dialog (phase transition received)",
    );
    deps.ui.clearUpgradePickDialog();
    if (deps.ui.isUpgradePickMode()) deps.ui.setModeToGame();
  }

  switch (msg.type) {
    case MESSAGE.ROOM_CREATED:
      deps.session.roomWaitTimerSec = msg.settings.waitTimerSec;
      deps.session.roomMaxRounds = msg.settings.maxRounds;
      deps.session.roomCannonMaxHp = msg.settings.cannonMaxHp;
      deps.session.roomGameMode = msg.settings.gameMode ?? GAME_MODE_CLASSIC;
      deps.lobby.showWaitingRoom(msg.code, msg.seed);
      return true;

    case MESSAGE.ROOM_JOINED:
      deps.session.roomWaitTimerSec = msg.settings.waitTimerSec;
      deps.session.roomMaxRounds = msg.settings.maxRounds;
      deps.session.roomCannonMaxHp = msg.settings.cannonMaxHp;
      deps.session.roomGameMode = msg.settings.gameMode ?? GAME_MODE_CLASSIC;
      deps.lobby.showWaitingRoom(msg.code, msg.seed);
      deps.session.lobbyStartTime = deps.now() - msg.elapsedSec * 1000;
      for (const player of msg.players) {
        deps.lobby.joined[player.playerId] = true;
        deps.session.occupiedSlots.add(player.playerId);
        if (player.playerId !== deps.session.onlinePlayerId) {
          deps.session.remoteHumanSlots.add(player.playerId);
        }
      }
      return true;

    case MESSAGE.JOINED:
      if (
        msg.previousPlayerId !== undefined &&
        msg.previousPlayerId !== msg.playerId
      ) {
        clearLobbySlot(msg.previousPlayerId);
      } else {
        const currentPlayerId = deps.session.onlinePlayerId;
        if (currentPlayerId >= 0 && currentPlayerId !== msg.playerId) {
          clearLobbySlot(currentPlayerId);
        }
      }
      deps.session.onlinePlayerId = msg.playerId;
      occupyLobbySlot(msg.playerId);
      return true;

    case MESSAGE.PLAYER_JOINED:
      if (
        msg.previousPlayerId !== undefined &&
        msg.previousPlayerId !== msg.playerId
      ) {
        clearLobbySlot(msg.previousPlayerId);
      }
      occupyLobbySlot(msg.playerId);
      return true;

    case MESSAGE.PLAYER_LEFT: {
      const name =
        deps.migration.playerNames[msg.playerId] ??
        `Player ${msg.playerId + 1}`;
      clearLobbySlot(msg.playerId);
      deps.ui.setAnnouncement(`${name} disconnected`);
      deps.log(`player_left: ${name} (pid=${msg.playerId})`);
      return true;
    }

    case MESSAGE.ROOM_ERROR:
      deps.ui.createErrorEl.textContent = msg.message;
      deps.ui.joinErrorEl.textContent = msg.message;
      return true;

    case MESSAGE.INIT:
      deps.game.initFromServer(msg);
      return true;

    case MESSAGE.SELECT_START:
      deps.game.enterTowerSelection();
      return true;

    case MESSAGE.CASTLE_WALLS:
      if (!deps.session.isHost && deps.game.getState())
        deps.transitions.onCastleWalls(msg);
      return true;

    case MESSAGE.CANNON_START:
      if (!deps.session.isHost && deps.game.getState())
        deps.transitions.onCannonStart(msg);
      return true;

    case MESSAGE.BATTLE_START:
      if (!deps.session.isHost && deps.game.getState())
        deps.transitions.onBattleStart(msg);
      return true;

    case MESSAGE.BUILD_START:
      if (!deps.session.isHost && deps.game.getState())
        deps.transitions.onBuildStart(msg);
      return true;

    case MESSAGE.BUILD_END:
      if (!deps.session.isHost && deps.game.getState())
        deps.transitions.onBuildEnd(msg);
      return true;

    case MESSAGE.GAME_OVER:
      if (!deps.session.isHost) deps.transitions.onGameOver(msg);
      return true;

    case MESSAGE.HOST_LEFT: {
      deps.log(
        `host_left: new host is P${msg.newHostPlayerId} (previous: P${msg.disconnectedPlayerId})`,
      );
      deps.session.hostMigrationSeq++;
      if (msg.newHostPlayerId === deps.session.onlinePlayerId) {
        deps.migration.promoteToHost();
        deps.ui.setAnnouncement("You are now the host");
      } else {
        const name =
          (msg.newHostPlayerId !== null
            ? deps.migration.playerNames[msg.newHostPlayerId]
            : undefined) ?? "a watcher";
        deps.ui.setAnnouncement(`Host migrated to ${name}`);
      }
      return true;
    }

    case MESSAGE.FULL_STATE:
      if (!deps.session.isHost && deps.game.getState()) {
        const incomingSeq = msg.migrationSeq ?? 0;
        if (incomingSeq < deps.session.hostMigrationSeq) {
          deps.log(
            `ignored stale full_state in lifecycle (seq=${incomingSeq})`,
          );
          return true;
        }
        if (incomingSeq > deps.session.hostMigrationSeq) {
          deps.session.hostMigrationSeq = incomingSeq;
        }
        deps.migration.restoreFullState(msg);
        deps.log("applied full_state from new host");
      }
      return true;

    default:
      return false;
  }
}
