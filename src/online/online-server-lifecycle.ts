/**
 * Server lifecycle message handlers — room join, slot selection, phase transitions.
 *
 * NOTE: session.isHost is VOLATILE (can flip during host promotion).
 * All reads go through isHostInContext() from tick-context.ts (enforced by ESLint).
 * The host-check guards on phase-transition cases ensure that only watchers
 * apply host-sent checkpoints — the host computes its own. */

import { GAME_MODE_CLASSIC, type GameMode } from "../shared/game-constants.ts";
import {
  type FullStateMessage,
  type InitMessage,
  MESSAGE,
  type ServerMessage,
} from "../shared/net/protocol.ts";
import { isHostInContext } from "../shared/net/tick-context.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import type { GameState } from "../shared/types.ts";
import type { OnlineSession } from "./online-session.ts";

export interface HandleServerLifecycleDeps {
  log: (msg: string) => void;

  session: Pick<
    OnlineSession,
    | "isHost"
    | "myPlayerId"
    | "hostMigrationSeq"
    | "roomWaitTimerSec"
    | "roomMaxRounds"
    | "roomCannonMaxHp"
    | "roomGameMode"
    | "lobbyStartTime"
    | "occupiedSlots"
    | "remotePlayerSlots"
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
    initFromServer: (msg: InitMessage) => Promise<void>;
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
    promoteToHost: () => Promise<void>;
    restoreFullState: (msg: FullStateMessage) => void;
  };
}

export async function handleServerLifecycleMessage(
  msg: ServerMessage,
  deps: HandleServerLifecycleDeps,
): Promise<boolean> {
  /** Atomically update all three slot-tracking structures (clear).
   *  Invariant: occupiedSlots, remotePlayerSlots, and lobby.joined must always
   *  be mutated together to avoid phantom entries or orphaned lobby data. */
  const clearLobbySlot = (playerId: ValidPlayerSlot) => {
    deps.lobby.joined[playerId] = false;
    deps.session.occupiedSlots.delete(playerId);
    deps.session.remotePlayerSlots.delete(playerId);
  };

  /** Atomically update all three slot-tracking structures (occupy).
   *  Invariant: occupiedSlots, remotePlayerSlots, and lobby.joined must always
   *  be mutated together to avoid phantom entries or orphaned lobby data. */
  const occupyLobbySlot = (playerId: ValidPlayerSlot) => {
    deps.lobby.joined[playerId] = true;
    deps.session.occupiedSlots.add(playerId);
    if (playerId !== deps.session.myPlayerId) {
      deps.session.remotePlayerSlots.add(playerId);
    } else {
      deps.session.remotePlayerSlots.delete(playerId);
    }
  };

  // Dismiss stale dialogs when a phase transition arrives from host.
  const isPhaseTransition =
    !isHostInContext(deps.session) &&
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
      deps.session.roomGameMode =
        (msg.settings.gameMode as GameMode | undefined) ?? GAME_MODE_CLASSIC;
      deps.lobby.showWaitingRoom(msg.code, msg.seed);
      return true;

    case MESSAGE.ROOM_JOINED:
      deps.session.roomWaitTimerSec = msg.settings.waitTimerSec;
      deps.session.roomMaxRounds = msg.settings.maxRounds;
      deps.session.roomCannonMaxHp = msg.settings.cannonMaxHp;
      deps.session.roomGameMode =
        (msg.settings.gameMode as GameMode | undefined) ?? GAME_MODE_CLASSIC;
      deps.lobby.showWaitingRoom(msg.code, msg.seed);
      deps.session.lobbyStartTime = performance.now() - msg.elapsedSec * 1000;
      for (const player of msg.players) {
        occupyLobbySlot(player.playerId);
      }
      return true;

    case MESSAGE.JOINED:
      if (
        msg.previousPlayerId !== undefined &&
        msg.previousPlayerId !== msg.playerId
      ) {
        clearLobbySlot(msg.previousPlayerId as ValidPlayerSlot);
      } else {
        const currentPlayerId = deps.session.myPlayerId;
        if (currentPlayerId >= 0 && currentPlayerId !== msg.playerId) {
          clearLobbySlot(currentPlayerId as ValidPlayerSlot);
        }
      }
      deps.session.myPlayerId = msg.playerId;
      occupyLobbySlot(msg.playerId as ValidPlayerSlot);
      return true;

    case MESSAGE.PLAYER_JOINED:
      if (
        msg.previousPlayerId !== undefined &&
        msg.previousPlayerId !== msg.playerId
      ) {
        clearLobbySlot(msg.previousPlayerId as ValidPlayerSlot);
      }
      occupyLobbySlot(msg.playerId as ValidPlayerSlot);
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
      await deps.game.initFromServer(msg);
      return true;

    case MESSAGE.SELECT_START:
      deps.game.enterTowerSelection();
      return true;

    case MESSAGE.CASTLE_WALLS:
      if (!isHostInContext(deps.session) && deps.game.getState())
        deps.transitions.onCastleWalls(msg);
      return true;

    case MESSAGE.CANNON_START:
      if (!isHostInContext(deps.session) && deps.game.getState())
        deps.transitions.onCannonStart(msg);
      return true;

    case MESSAGE.BATTLE_START:
      if (!isHostInContext(deps.session) && deps.game.getState())
        deps.transitions.onBattleStart(msg);
      return true;

    case MESSAGE.BUILD_START:
      if (!isHostInContext(deps.session) && deps.game.getState())
        deps.transitions.onBuildStart(msg);
      return true;

    case MESSAGE.BUILD_END:
      if (!isHostInContext(deps.session) && deps.game.getState())
        deps.transitions.onBuildEnd(msg);
      return true;

    case MESSAGE.GAME_OVER:
      if (!isHostInContext(deps.session)) deps.transitions.onGameOver(msg);
      return true;

    case MESSAGE.HOST_LEFT: {
      deps.log(
        `host_left: new host is P${msg.newHostPlayerId} (previous: P${msg.disconnectedPlayerId})`,
      );
      deps.session.hostMigrationSeq++;
      if (msg.newHostPlayerId === deps.session.myPlayerId) {
        await deps.migration.promoteToHost();
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
      if (!isHostInContext(deps.session) && deps.game.getState()) {
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
