import {
  type FullStateMessage,
  type InitMessage,
  MESSAGE,
  type ServerMessage,
} from "../server/protocol.ts";
import type { OnlineSession } from "./online-session.ts";
import type { GameState } from "./types.ts";

interface HandleServerLifecycleDeps {
  log: (msg: string) => void;
  now: () => number;

  session: Pick<
    OnlineSession,
    | "isHost"
    | "myPlayerId"
    | "hostMigrationSeq"
    | "lobbyWaitTimer"
    | "roomBattleLength"
    | "roomCannonMaxHp"
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
    restoreFullState: (msg: FullStateMessage) => void;
  };
}

export function handleServerLifecycleMessage(
  msg: ServerMessage,
  deps: HandleServerLifecycleDeps,
): boolean {
  const clearLobbySlot = (playerId: number) => {
    deps.lobby.joined[playerId] = false;
    deps.session.occupiedSlots.delete(playerId);
    deps.session.remoteHumanSlots.delete(playerId);
  };

  const occupyLobbySlot = (playerId: number) => {
    deps.lobby.joined[playerId] = true;
    deps.session.occupiedSlots.add(playerId);
    if (playerId !== deps.session.myPlayerId) {
      deps.session.remoteHumanSlots.add(playerId);
    } else {
      deps.session.remoteHumanSlots.delete(playerId);
    }
  };

  // Dismiss stale life-lost dialog when a phase transition arrives from host.
  if (
    !deps.session.isHost &&
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
      deps.session.lobbyWaitTimer = msg.settings.waitTimerSec;
      deps.session.roomBattleLength = msg.settings.battleLength;
      deps.session.roomCannonMaxHp = msg.settings.cannonMaxHp;
      deps.lobby.showWaitingRoom(msg.code, msg.seed);
      return true;

    case MESSAGE.ROOM_JOINED:
      deps.session.lobbyWaitTimer = msg.settings.waitTimerSec;
      deps.session.roomBattleLength = msg.settings.battleLength;
      deps.session.roomCannonMaxHp = msg.settings.cannonMaxHp;
      deps.lobby.showWaitingRoom(msg.code, msg.seed);
      deps.session.lobbyStartTime = deps.now() - msg.elapsedSec * 1000;
      for (const player of msg.players) {
        deps.lobby.joined[player.playerId] = true;
        deps.session.occupiedSlots.add(player.playerId);
        if (player.playerId !== deps.session.myPlayerId) {
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
        const currentPlayerId = deps.session.myPlayerId;
        if (currentPlayerId >= 0 && currentPlayerId !== msg.playerId) {
          clearLobbySlot(currentPlayerId);
        }
      }
      deps.session.myPlayerId = msg.playerId;
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
      deps.session.occupiedSlots.delete(msg.playerId);
      deps.session.remoteHumanSlots.delete(msg.playerId);
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
        `host_left: new host is P${msg.newHostPlayerId} (previous: P${msg.previousHostPlayerId})`,
      );
      deps.session.hostMigrationSeq++;
      if (msg.newHostPlayerId === deps.session.myPlayerId) {
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
