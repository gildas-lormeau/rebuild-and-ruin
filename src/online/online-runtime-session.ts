import type { FullStateMessage, InitMessage } from "../../server/protocol.ts";
import {
  bootstrapGame,
  initWaitingRoom,
} from "../runtime/runtime-bootstrap.ts";
import { setMode } from "../runtime/runtime-state.ts";
import type { GameRuntime } from "../runtime/runtime-types.ts";
import type { GameMode } from "../shared/game-constants.ts";
import { MAX_PLAYERS } from "../shared/player-config.ts";
import { GAME_CONTAINER_ACTIVE, navigateTo } from "../shared/router.ts";
import { Mode } from "../shared/ui-mode.ts";
import { pageOnline, roomCodeOverlay } from "./online-dom.ts";
import { restoreFullStateUiRecovery } from "./online-full-state-recovery.ts";
import {
  buildRoomCodeOverlay,
  hideRoomCodeOverlay,
} from "./online-lobby-ui.ts";
import { restoreFullStateSnapshot } from "./online-serialize.ts";
import type { OnlineSession } from "./online-session.ts";
import { setWatcherPhaseTimer } from "./online-types.ts";
import type { WatcherState } from "./online-watcher-tick.ts";

interface OnlineRuntimeSessionDeps {
  getRuntime: () => GameRuntime;
  session: OnlineSession;
  watcher: Pick<WatcherState, "timing">;
  resetNetworkingForNewGame: () => void;
  destroyClient: () => void;
  log: (msg: string) => void;
  container: HTMLElement;
}

export function createOnlineRuntimeSessionHelpers(
  deps: OnlineRuntimeSessionDeps,
) {
  function resetSession(): void {
    deps.destroyClient();
    deps.getRuntime().runtimeState.settings.seed = "";
  }

  function showLobby(): void {
    const runtime = deps.getRuntime();
    setMode(runtime.runtimeState, Mode.STOPPED);
    runtime.runtimeState.lobby.active = false;
    deps.container.classList.remove(GAME_CONTAINER_ACTIVE);
    hideRoomCodeOverlay(roomCodeOverlay);
    navigateTo("/online");
    resetSession();
  }

  function showWaitingRoom(code: string, seed: number): void {
    const runtime = deps.getRuntime();
    deps.session.roomSeed = seed;
    runtime.runtimeState.settings.seed = String(seed);
    const joinUrl = `${location.origin}${location.pathname}?server=${location.host}&join=${code}`;
    buildRoomCodeOverlay(roomCodeOverlay, code, joinUrl);
    initWaitingRoom({
      seed,
      hideLobbyPage: () => {
        pageOnline.hidden = true;
      },
      activateGameContainer: () => {
        deps.container.classList.add(GAME_CONTAINER_ACTIVE);
      },
      lobby: runtime.runtimeState.lobby,
      maxPlayers: MAX_PLAYERS,
      log: deps.log,
      setLobbyStartTime: (timestamp: number) => {
        deps.session.lobbyStartTime = timestamp;
      },
      setModeLobby: () => {
        setMode(runtime.runtimeState, Mode.LOBBY);
      },
      setLastTime: (timestamp: number) => {
        runtime.runtimeState.lastTime = timestamp;
      },
      requestFrame: () => {
        requestAnimationFrame(runtime.mainLoop);
      },
    });
    runtime.warmMapCache(runtime.runtimeState.lobby.map!);
  }

  async function initFromServer(msg: InitMessage): Promise<void> {
    const runtime = deps.getRuntime();
    hideRoomCodeOverlay(roomCodeOverlay);
    runtime.runtimeState.lobby.active = false;
    const settings = runtime.runtimeState.settings;
    const playerCount = Math.min(Math.max(1, msg.playerCount), MAX_PLAYERS);
    const humanSlots = Array.from(
      { length: playerCount },
      (_, index) => index === deps.session.myPlayerId,
    );
    const keyBindings = Array.from({ length: playerCount }, (_, index) =>
      index === deps.session.myPlayerId ? settings.keyBindings[0] : undefined,
    );
    await bootstrapGame({
      seed: msg.seed,
      maxPlayers: playerCount,
      existingMap: runtime.runtimeState.lobby.map ?? undefined,
      maxRounds: msg.settings.maxRounds,
      cannonMaxHp: msg.settings.cannonMaxHp,
      buildTimer: msg.settings.buildTimer,
      cannonPlaceTimer: msg.settings.cannonPlaceTimer,
      firstRoundCannons: msg.settings.firstRoundCannons,
      gameMode: msg.settings.gameMode as GameMode,
      humanSlots,
      keyBindings,
      difficulty: settings.difficulty,
      log: deps.log,
      clearFrameData: () => runtime.clearFrameData(),
      setState: (state) => {
        runtime.runtimeState.state = state;
      },
      setControllers: (controllers) => {
        runtime.runtimeState.controllers = [...controllers];
      },
      resetUIState: () => {
        runtime.lifecycle.resetUIState();
        deps.resetNetworkingForNewGame();
      },
      enterSelection: () => runtime.selection.enter(),
    });
  }

  function restoreFullState(msg: FullStateMessage): void {
    const runtime = deps.getRuntime();
    const state = runtime.runtimeState.state;
    const result = restoreFullStateSnapshot(state, msg);
    if (!result) return;

    restoreFullStateUiRecovery(
      {
        setMode: (mode) => {
          setMode(runtime.runtimeState, mode);
        },
        onModeSet: (mode) => {
          if (mode === Mode.SELECTION) runtime.sound.drumsStart();
          else runtime.sound.drumsStop();
        },
        clearCastleBuilds: () => {
          runtime.runtimeState.selection.castleBuilds = [];
        },
        clearLifeLostDialog: () => {
          runtime.lifeLost.set(null);
        },
        clearAnnouncement: () => {
          runtime.runtimeState.frame.announcement = undefined;
        },
        setBattleFlights: (flights) => {
          runtime.runtimeState.battleAnim.flights = flights;
        },
      },
      state.phase,
      result.balloonFlights,
    );

    setWatcherPhaseTimer(deps.watcher.timing, performance.now(), state.timer);
    if (state.battleCountdown > 0) {
      deps.watcher.timing.countdownStartTime = performance.now();
      deps.watcher.timing.countdownDuration = state.battleCountdown;
    }
  }

  return {
    initFromServer,
    restoreFullState,
    resetSession,
    showLobby,
    showWaitingRoom,
  };
}
