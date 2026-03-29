import {
  type FullStateMessage,
  type InitMessage,
  MESSAGE,
  type ServerMessage,
} from "../server/protocol.ts";
import type { GameState } from "./types.ts";

interface HandleServerLifecycleDeps {
  log: (msg: string) => void;
  now: () => number;

  session: {
    isHost: () => boolean;
    getMyPlayerId: () => number;
    setMyPlayerId: (playerId: number) => void;
    getHostMigrationSeq: () => number;
    setHostMigrationSeq: (seq: number) => void;
    bumpHostMigrationSeq: () => void;
  };

  lobby: {
    setWaitTimer: (seconds: number) => void;
    setRoomSettings: (battleLength: number, cannonMaxHp: number) => void;
    showWaitingRoom: (code: string, seed: number) => void;
    setStartTime: (timeMs: number) => void;
    joined: boolean[];
    occupiedSlots: Set<number>;
    remoteHumanSlots: Set<number>;
  };

  ui: {
    getLifeLostDialog: () => unknown;
    clearLifeLostDialog: () => void;
    isLifeLostMode: () => boolean;
    setGameMode: () => void;
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
    applyFullState: (msg: FullStateMessage) => void;
  };
}

export function handleServerLifecycleMessage(
  msg: ServerMessage,
  deps: HandleServerLifecycleDeps,
): boolean {
  const clearLobbySlot = (playerId: number) => {
    deps.lobby.joined[playerId] = false;
    deps.lobby.occupiedSlots.delete(playerId);
    deps.lobby.remoteHumanSlots.delete(playerId);
  };

  const occupyLobbySlot = (playerId: number) => {
    deps.lobby.joined[playerId] = true;
    deps.lobby.occupiedSlots.add(playerId);
    if (playerId !== deps.session.getMyPlayerId()) {
      deps.lobby.remoteHumanSlots.add(playerId);
    } else {
      deps.lobby.remoteHumanSlots.delete(playerId);
    }
  };

  // Dismiss stale life-lost dialog when a phase transition arrives from host.
  if (
    !deps.session.isHost() &&
    deps.ui.getLifeLostDialog() &&
    (msg.type === MESSAGE.CANNON_START ||
      msg.type === MESSAGE.BATTLE_START ||
      msg.type === MESSAGE.BUILD_START ||
      msg.type === MESSAGE.SELECT_START ||
      msg.type === MESSAGE.CASTLE_WALLS)
  ) {
    deps.log("dismissing stale life-lost dialog (phase transition received)");
    deps.ui.clearLifeLostDialog();
    if (deps.ui.isLifeLostMode()) deps.ui.setGameMode();
  }

  switch (msg.type) {
    case MESSAGE.ROOM_CREATED:
      deps.lobby.setWaitTimer(msg.settings.waitTimerSec);
      deps.lobby.setRoomSettings(
        msg.settings.battleLength,
        msg.settings.cannonMaxHp,
      );
      deps.lobby.showWaitingRoom(msg.code, msg.seed);
      return true;

    case MESSAGE.ROOM_JOINED:
      deps.lobby.setWaitTimer(msg.settings.waitTimerSec);
      deps.lobby.setRoomSettings(
        msg.settings.battleLength,
        msg.settings.cannonMaxHp,
      );
      deps.lobby.showWaitingRoom(msg.code, msg.seed);
      deps.lobby.setStartTime(deps.now() - msg.elapsedSec * 1000);
      for (const player of msg.players) {
        deps.lobby.joined[player.playerId] = true;
        deps.lobby.occupiedSlots.add(player.playerId);
        if (player.playerId !== deps.session.getMyPlayerId()) {
          deps.lobby.remoteHumanSlots.add(player.playerId);
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
        const currentPlayerId = deps.session.getMyPlayerId();
        if (currentPlayerId >= 0 && currentPlayerId !== msg.playerId) {
          clearLobbySlot(currentPlayerId);
        }
      }
      deps.session.setMyPlayerId(msg.playerId);
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
      deps.lobby.joined[msg.playerId] = false;
      deps.lobby.occupiedSlots.delete(msg.playerId);
      deps.lobby.remoteHumanSlots.delete(msg.playerId);
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
      if (!deps.session.isHost() && deps.game.getState())
        deps.transitions.onCastleWalls(msg);
      return true;

    case MESSAGE.CANNON_START:
      if (!deps.session.isHost() && deps.game.getState())
        deps.transitions.onCannonStart(msg);
      return true;

    case MESSAGE.BATTLE_START:
      if (!deps.session.isHost() && deps.game.getState())
        deps.transitions.onBattleStart(msg);
      return true;

    case MESSAGE.BUILD_START:
      if (!deps.session.isHost() && deps.game.getState())
        deps.transitions.onBuildStart(msg);
      return true;

    case MESSAGE.BUILD_END:
      if (!deps.session.isHost() && deps.game.getState())
        deps.transitions.onBuildEnd(msg);
      return true;

    case MESSAGE.GAME_OVER:
      if (!deps.session.isHost()) deps.transitions.onGameOver(msg);
      return true;

    case MESSAGE.HOST_LEFT: {
      deps.log(
        `host_left: new host is P${msg.newHostPlayerId} (previous: P${msg.previousHostPlayerId})`,
      );
      deps.session.bumpHostMigrationSeq();
      if (msg.newHostPlayerId === deps.session.getMyPlayerId()) {
        deps.migration.promoteToHost();
        deps.ui.setAnnouncement("You are now the host");
      } else {
        const name =
          deps.migration.playerNames[msg.newHostPlayerId] ?? "a watcher";
        deps.ui.setAnnouncement(`Host migrated to ${name}`);
      }
      return true;
    }

    case MESSAGE.FULL_STATE:
      if (!deps.session.isHost() && deps.game.getState()) {
        const incomingSeq = msg.migrationSeq ?? 0;
        if (incomingSeq < deps.session.getHostMigrationSeq()) {
          deps.log(
            `ignored stale full_state in lifecycle (seq=${incomingSeq})`,
          );
          return true;
        }
        if (incomingSeq > deps.session.getHostMigrationSeq()) {
          deps.session.setHostMigrationSeq(incomingSeq);
        }
        deps.migration.applyFullState(msg);
        deps.log("applied full_state from new host");
      }
      return true;

    default:
      return false;
  }
}
