import type { GameState } from "./types.ts";
import type { ServerMessage, InitMessage } from "../server/protocol.ts";

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
}

export function handleServerLifecycleMessage(
  msg: ServerMessage,
  deps: HandleServerLifecycleDeps,
): boolean {
  // Dismiss stale life-lost dialog when a phase transition arrives from host.
  if (
    !deps.isHost &&
    deps.getLifeLostDialog() &&
    (msg.type === "cannon_start" ||
      msg.type === "battle_start" ||
      msg.type === "build_start" ||
      msg.type === "select_start" ||
      msg.type === "castle_walls")
  ) {
    deps.log("dismissing stale life-lost dialog (phase transition received)");
    deps.clearLifeLostDialog();
    if (deps.isLifeLostMode()) deps.setGameMode();
  }

  switch (msg.type) {
    case "room_created":
      deps.setLobbyWaitTimer(msg.settings.waitTimerSec);
      deps.setRoomSettings(msg.settings.battleLength, msg.settings.cannonMaxHp);
      deps.showWaitingRoom(msg.code, msg.seed);
      return true;

    case "room_joined":
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

    case "joined":
      deps.setMyPlayerId(msg.playerId);
      deps.lobbyJoined[msg.playerId] = true;
      return true;

    case "player_joined":
      deps.lobbyJoined[msg.playerId] = true;
      deps.occupiedSlots.add(msg.playerId);
      if (msg.playerId !== deps.getMyPlayerId()) {
        deps.remoteHumanSlots.add(msg.playerId);
      }
      return true;

    case "player_left":
      deps.lobbyJoined[msg.playerId] = false;
      deps.occupiedSlots.delete(msg.playerId);
      deps.remoteHumanSlots.delete(msg.playerId);
      return true;

    case "room_error":
      deps.createErrorEl.textContent = msg.message;
      deps.joinErrorEl.textContent = msg.message;
      return true;

    case "init":
      deps.initFromServer(msg);
      return true;

    case "select_start":
      deps.enterTowerSelection();
      return true;

    case "castle_walls":
      if (!deps.isHost && deps.getState()) deps.onCastleWalls(msg);
      return true;

    case "cannon_start":
      if (!deps.isHost && deps.getState()) deps.onCannonStart(msg);
      return true;

    case "battle_start":
      if (!deps.isHost && deps.getState()) deps.onBattleStart(msg);
      return true;

    case "build_start":
      if (!deps.isHost && deps.getState()) deps.onBuildStart(msg);
      return true;

    case "build_end":
      if (!deps.isHost && deps.getState()) deps.onBuildEnd(msg);
      return true;

    case "game_over":
      if (!deps.isHost) deps.onGameOver(msg);
      return true;

    default:
      return false;
  }
}
