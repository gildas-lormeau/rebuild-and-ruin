/**
 * Online runtime session helpers — four entry points for room/game
 * lifecycle transitions over runtime/session/timing/container deps.
 * `showLobby` / `showWaitingRoom` are user-driven UI navigation;
 * `initFromServer` / `restoreFullState` are WebSocket-driven (game start
 * and snapshot recovery after disconnect/migration).
 */

import { generateMap } from "../../game/index.ts";
import type { FullStateMessage, InitMessage } from "../../protocol/protocol.ts";
import { ROUTE_ONLINE } from "../../protocol/routes.ts";
import { clearBalloonFlights } from "../../runtime/battle-anim.ts";
import { bootstrapGame } from "../../runtime/bootstrap.ts";
import type { GameRuntime } from "../../runtime/handle.ts";
import { setMode, setRuntimeGameState } from "../../runtime/state.ts";
import type { TimingApi } from "../../runtime/timing-api.ts";
import type { GameMode } from "../../shared/core/game-constants.ts";
import { Phase } from "../../shared/core/game-phase.ts";
import { Rng } from "../../shared/platform/rng.ts";
import { MAX_PLAYERS } from "../../shared/ui/player-config.ts";
import { Mode } from "../../shared/ui/ui-mode.ts";
import { pageOnline } from "../online-dom.ts";
import {
  buildRoomCodeOverlay,
  hideRoomCodeOverlay,
} from "../online-lobby-ui.ts";
import { resolveModeAfterFullState } from "../online-rehydrate.ts";
import { GAME_CONTAINER_ACTIVE, navigateTo } from "../online-router.ts";
import { restoreFullStateSnapshot } from "../online-serialize.ts";
import type { OnlineSession } from "../online-session.ts";

interface OnlineRuntimeSessionDeps {
  getRuntime: () => GameRuntime;
  session: OnlineSession;
  /** Injected timing primitives — replaces bare `performance.now()` access.
   *  Same `TimingApi` instance the runtime receives via `RuntimeConfig.timing`. */
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
    hideRoomCodeOverlay();
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
    buildRoomCodeOverlay(code, joinUrl);
    pageOnline.hidden = true;
    deps.container.classList.add(GAME_CONTAINER_ACTIVE);
    lobby.seed = seed;
    deps.log(`[online] seed: ${seed}`);
    lobby.map = generateMap(new Rng(seed));
    lobby.joined = new Array(MAX_PLAYERS).fill(false);
    lobby.active = true;
    deps.session.lobbyStartTime = deps.timing.now();
    setMode(runtime.runtimeState, Mode.LOBBY);
    runtime.warmMapCache(lobby.map);
  }

  async function initFromServer(msg: InitMessage): Promise<void> {
    const runtime = deps.getRuntime();
    hideRoomCodeOverlay();
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
      onStateReady: () => {
        // Watcher visuals + stats are populated from `result.impactEvents`
        // inside `tickBattlePhase` (same code path as host) — no per-bus
        // subscription needed here.
      },
      // Camera-backed human aim resolver (screen px → occluded world). Only
      // the local human slot uses it; remote/AI slots resolve their own aim.
      humanAimResolver: (_state, x, y) => runtime.camera.pickHitWorld(x, y),
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
    if (inBattle) runtime.runtimeState.battleAnim.flights = flights;
    else clearBalloonFlights(runtime.runtimeState.battleAnim);
    // Phase timer / battle countdown read straight from `state` — both
    // peers now use dt-based decrement, no separate wall-clock anchor.
  }

  return {
    initFromServer,
    restoreFullState,
    showLobby,
    showWaitingRoom,
  };
}
