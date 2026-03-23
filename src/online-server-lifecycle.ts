import type { FullStateMessage, InitMessage, ServerMessage } from "../server/protocol.ts";
import { MSG } from "../server/protocol.ts";
import type { GameState } from "./types.ts";

interface HandleServerLifecycleDeps {
  log: (msg: string) => void;
  isHost: boolean;
  getState: () => GameState | undefined;
  getLifeLostDialog: () => unknown;
  clearLifeLostDialog: () => void;
  isLifeLostMode: () => boolean;
  setGameMode: () => void;
  setLobbyWaitTimer: (seconds: number) => void;
  setRoomSettings: (battleLength: number, cannonMaxHp: number) => void;
  showWaitingRoom: (code: string, seed: number) => void;
  setLobbyStartTime: (timeMs: number) => void;
  now: () => number;
  lobbyJoined: boolean[];
  occupiedSlots: Set<number>;
  remoteHumanSlots: Set<number>;
  getMyPlayerId: () => number;
  setMyPlayerId: (playerId: number) => void;
  createErrorEl: HTMLElement;
  joinErrorEl: HTMLElement;
  initFromServer: (msg: InitMessage) => void;
  enterTowerSelection: () => void;
  onCastleWalls: (msg: ServerMessage) => void;
  onCannonStart: (msg: ServerMessage) => void;
  onBattleStart: (msg: ServerMessage) => void;
  onBuildStart: (msg: ServerMessage) => void;
  onBuildEnd: (msg: ServerMessage) => void;
  onGameOver: (msg: ServerMessage) => void;
  setAnnouncement: (msg: string) => void;
  playerNames: readonly string[];
  promoteToHost: () => void;
  applyFullState: (msg: FullStateMessage) => void;
}

export function handleServerLifecycleMessage(
  msg: ServerMessage,
  deps: HandleServerLifecycleDeps,
): boolean {
  // Dismiss stale life-lost dialog when a phase transition arrives from host.
  if (
    !deps.isHost &&
    deps.getLifeLostDialog() &&
    (msg.type === MSG.CANNON_START ||
      msg.type === MSG.BATTLE_START ||
      msg.type === MSG.BUILD_START ||
      msg.type === MSG.SELECT_START ||
      msg.type === MSG.CASTLE_WALLS)
  ) {
    deps.log("dismissing stale life-lost dialog (phase transition received)");
    deps.clearLifeLostDialog();
    if (deps.isLifeLostMode()) deps.setGameMode();
  }

  switch (msg.type) {
    case MSG.ROOM_CREATED:
      deps.setLobbyWaitTimer(msg.settings.waitTimerSec);
      deps.setRoomSettings(msg.settings.battleLength, msg.settings.cannonMaxHp);
      deps.showWaitingRoom(msg.code, msg.seed);
      return true;

    case MSG.ROOM_JOINED:
      deps.setLobbyWaitTimer(msg.settings.waitTimerSec);
      deps.setRoomSettings(msg.settings.battleLength, msg.settings.cannonMaxHp);
      deps.showWaitingRoom(msg.code, msg.seed);
      deps.setLobbyStartTime(deps.now() - msg.elapsedSec * 1000);
      for (const p of msg.players) {
        deps.lobbyJoined[p.playerId] = true;
        deps.occupiedSlots.add(p.playerId);
        if (p.playerId !== deps.getMyPlayerId()) {
          deps.remoteHumanSlots.add(p.playerId);
        }
      }
      return true;

    case MSG.JOINED:
      deps.setMyPlayerId(msg.playerId);
      deps.lobbyJoined[msg.playerId] = true;
      return true;

    case MSG.PLAYER_JOINED:
      deps.lobbyJoined[msg.playerId] = true;
      deps.occupiedSlots.add(msg.playerId);
      if (msg.playerId !== deps.getMyPlayerId()) {
        deps.remoteHumanSlots.add(msg.playerId);
      }
      return true;

    case MSG.PLAYER_LEFT: {
      const name = deps.playerNames[msg.playerId] ?? `Player ${msg.playerId + 1}`;
      deps.lobbyJoined[msg.playerId] = false;
      deps.occupiedSlots.delete(msg.playerId);
      deps.remoteHumanSlots.delete(msg.playerId);
      deps.setAnnouncement(`${name} disconnected`);
      deps.log(`player_left: ${name} (pid=${msg.playerId})`);
      return true;
    }

    case MSG.ROOM_ERROR:
      deps.createErrorEl.textContent = msg.message;
      deps.joinErrorEl.textContent = msg.message;
      return true;

    case MSG.INIT:
      deps.initFromServer(msg);
      return true;

    case MSG.SELECT_START:
      deps.enterTowerSelection();
      return true;

    case MSG.CASTLE_WALLS:
      if (!deps.isHost && deps.getState()) deps.onCastleWalls(msg);
      return true;

    case MSG.CANNON_START:
      if (!deps.isHost && deps.getState()) deps.onCannonStart(msg);
      return true;

    case MSG.BATTLE_START:
      if (!deps.isHost && deps.getState()) deps.onBattleStart(msg);
      return true;

    case MSG.BUILD_START:
      if (!deps.isHost && deps.getState()) deps.onBuildStart(msg);
      return true;

    case MSG.BUILD_END:
      if (!deps.isHost && deps.getState()) deps.onBuildEnd(msg);
      return true;

    case MSG.GAME_OVER:
      if (!deps.isHost) deps.onGameOver(msg);
      return true;

    case MSG.HOST_LEFT: {
      deps.log(`host_left: new host is P${msg.newHostPlayerId} (previous: P${msg.previousHostPlayerId})`);
      if (msg.newHostPlayerId === deps.getMyPlayerId()) {
        deps.promoteToHost();
        deps.setAnnouncement("You are now the host");
      } else {
        const name = deps.playerNames[msg.newHostPlayerId] ?? "a watcher";
        deps.setAnnouncement(`Host migrated to ${name}`);
      }
      return true;
    }

    case MSG.FULL_STATE:
      if (!deps.isHost && deps.getState()) {
        deps.applyFullState(msg);
        deps.log("applied full_state from new host");
      }
      return true;

    default:
      return false;
  }
}
