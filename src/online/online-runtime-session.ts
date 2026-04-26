import { generateMap } from "../game/index.ts";
import type { FullStateMessage, InitMessage } from "../protocol/protocol.ts";
import { ROUTE_ONLINE } from "../protocol/routes.ts";
import { bootstrapGame } from "../runtime/runtime-bootstrap.ts";
import type { TimingApi } from "../runtime/runtime-contracts.ts";
import { setMode, setRuntimeGameState } from "../runtime/runtime-state.ts";
import { setWatcherPhaseTimer } from "../runtime/runtime-tick-context.ts";
import type { GameRuntime } from "../runtime/runtime-types.ts";
import type { GameMode } from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import { MAX_PLAYERS } from "../shared/ui/player-config.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import { pageOnline, roomCodeOverlay } from "./online-dom.ts";
import {
  buildRoomCodeOverlay,
  hideRoomCodeOverlay,
} from "./online-lobby-ui.ts";
import { GAME_CONTAINER_ACTIVE, navigateTo } from "./online-router.ts";
import { restoreFullStateSnapshot } from "./online-serialize.ts";
import type { OnlineSession } from "./online-session.ts";
import type { WatcherState } from "./online-watcher-tick.ts";

interface OnlineRuntimeSessionDeps {
  getRuntime: () => GameRuntime;
  session: OnlineSession;
  watcher: Pick<WatcherState, "timing">;
  /** Injected timing primitives — replaces bare `performance.now()` /
   *  `requestAnimationFrame` access. Same `TimingApi` instance the runtime
   *  receives via `RuntimeConfig.timing`. */
  timing: TimingApi;
  resetNetworkingForNewGame: () => void;
  destroyClient: () => void;
  log: (msg: string) => void;
  container: HTMLElement;
}

export function createOnlineRuntimeSessionHelpers(
  deps: OnlineRuntimeSessionDeps,
) {
  function showLobby(): void {
    const runtime = deps.getRuntime();
    runtime.shutdown();
    deps.container.classList.remove(GAME_CONTAINER_ACTIVE);
    hideRoomCodeOverlay(roomCodeOverlay);
    navigateTo(ROUTE_ONLINE);
    deps.destroyClient();
    runtime.runtimeState.lobby.roomSeedDisplay = null;
  }

  function showWaitingRoom(code: string, seed: number): void {
    const runtime = deps.getRuntime();
    const lobby = runtime.runtimeState.lobby;
    deps.session.roomSeed = seed;
    lobby.roomSeedDisplay = seed;
    const joinUrl = `${location.origin}${location.pathname}?server=${location.host}&join=${code}`;
    buildRoomCodeOverlay(roomCodeOverlay, code, joinUrl);
    pageOnline.hidden = true;
    deps.container.classList.add(GAME_CONTAINER_ACTIVE);
    lobby.seed = seed;
    deps.log(`[online] seed: ${seed}`);
    lobby.map = generateMap(seed);
    lobby.joined = new Array(MAX_PLAYERS).fill(false);
    lobby.active = true;
    const time = deps.timing.now();
    deps.session.lobbyStartTime = time;
    setMode(runtime.runtimeState, Mode.LOBBY);
    runtime.runtimeState.lastTime = time;
    deps.timing.requestFrame(runtime.mainLoop);
    runtime.warmMapCache(lobby.map);
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
        setRuntimeGameState(runtime.runtimeState, state);
      },
      setControllers: (controllers) => {
        runtime.runtimeState.controllers = [...controllers];
      },
      resetUIState: () => {
        runtime.lifecycle.resetUIState();
        deps.resetNetworkingForNewGame();
      },
      enterSelection: () => runtime.selection.enter(),
      onStateReady: () => runtime.phaseTicks.subscribeBusObservers(),
    });
  }

  function restoreFullState(msg: FullStateMessage): void {
    const runtime = deps.getRuntime();
    const state = runtime.runtimeState.state;
    const result = restoreFullStateSnapshot(state, msg);
    if (!result) return;

    const flights = result.balloonFlights ?? [];
    const inBattle = state.phase === Phase.BATTLE;
    setMode(
      runtime.runtimeState,
      resolveModeAfterFullState(state.phase, inBattle && flights.length > 0),
    );
    runtime.runtimeState.selection.castleBuilds = [];
    runtime.lifeLost.set(null);
    runtime.runtimeState.frame.announcement = undefined;
    runtime.runtimeState.battleAnim.flights = inBattle ? flights : [];

    setWatcherPhaseTimer(deps.watcher.timing, performance.now(), state.timer);
    // Always sync watcher countdown timing — even if battleCountdown is 0
    // (e.g. full-state recovery mid-battle). Omitting leaves stale values
    // in countdownStartTime/countdownDuration from a prior phase.
    deps.watcher.timing.countdownStartTime = performance.now();
    deps.watcher.timing.countdownDuration = state.battleCountdown;
  }

  return {
    initFromServer,
    restoreFullState,
    showLobby,
    showWaitingRoom,
  };
}

function resolveModeAfterFullState(phase: Phase, hasBalloons: boolean): Mode {
  if (phase === Phase.CASTLE_SELECT || phase === Phase.CASTLE_RESELECT) {
    return Mode.SELECTION;
  }
  if (phase === Phase.BATTLE && hasBalloons) return Mode.BALLOON_ANIM;
  return Mode.GAME;
}
