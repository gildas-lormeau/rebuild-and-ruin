import { applyGameConfig, createGameFromSeed } from "../game/game-engine.ts";
import { generateMap } from "../game/map-generation.ts";
import { selectionFacade } from "../game/selection-facade.ts";
import {
  createController,
  ensureAiModulesLoaded,
} from "../player/controller-factory.ts";
import {
  DIFFICULTY_PARAMS,
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
} from "../shared/game-constants.ts";
import { isReselectPhase, Phase } from "../shared/game-phase.ts";
import type { GameMap } from "../shared/geometry-types.ts";
import {
  type KeyBindings,
  MAX_PLAYERS,
  PLAYER_KEY_BINDINGS,
  SEED_RANDOM,
} from "../shared/player-config.ts";
import { isActivePlayer, type ValidPlayerSlot } from "../shared/player-slot.ts";
import { MAX_UINT32 } from "../shared/rng.ts";
import { CANNON_HP_OPTIONS, ROUNDS_OPTIONS } from "../shared/settings-defs.ts";
import type { PlayerController } from "../shared/system-interfaces.ts";
import { isRemoteHuman } from "../shared/tick-context.ts";
import type { GameState, LobbyState } from "../shared/types.ts";
import type { RuntimeState } from "./runtime-state.ts";
import type { EnterTowerSelectionDeps } from "./runtime-types.ts";

interface InitWaitingRoomDeps {
  seed: number;
  hideLobbyPage: () => void;
  activateGameContainer: () => void;
  lobby: LobbyState;
  maxPlayers: number;
  log: (msg: string) => void;
  setLobbyStartTime: (timeMs: number) => void;
  setModeLobby: () => void;
  setLastTime: (timeMs: number) => void;
  requestFrame: () => void;
}

interface InitGameDeps {
  seed: number;
  maxPlayers: number;
  /** Reuse an existing map (e.g. from lobby) to avoid regeneration and keep terrain cache warm. */
  existingMap?: GameMap;
  /** Game settings to apply after state creation. */
  maxRounds: number;
  cannonMaxHp: number;
  buildTimer: number;
  cannonPlaceTimer: number;
  firstRoundCannons: number;
  /** Game mode: "classic" or "modern". */
  gameMode: string;
  /** Which slots are human (true = human, false/missing = AI). */
  humanSlots: readonly boolean[];
  /** Per-slot key bindings (only used for human slots). */
  keyBindings: readonly (KeyBindings | undefined)[];
  /** AI difficulty level (0=Easy, 1=Normal, 2=Hard, 3=Very Hard). */
  difficulty?: number;
  log: (msg: string) => void;
  clearFrameData: () => void;
  setState: (nextState: GameState) => void;
  setControllers: (nextControllers: readonly PlayerController[]) => void;
  resetUIState: () => void;
  /** Called after state + controllers are ready. Enters tower selection. */
  enterSelection: () => void;
}

interface BootstrapFromSettingsDeps {
  readonly clearFrameData: () => void;
  readonly resetUIState: () => void;
  readonly enterSelection: () => void;
}

export function initWaitingRoom(deps: InitWaitingRoomDeps): void {
  const {
    seed,
    hideLobbyPage,
    activateGameContainer,
    lobby,
    maxPlayers,
    setLobbyStartTime,
    log,
    setModeLobby,
    setLastTime,
    requestFrame,
  } = deps;

  hideLobbyPage();
  activateGameContainer();

  lobby.seed = seed;
  log(`[online] seed: ${seed}`);
  lobby.map = generateMap(seed);
  lobby.joined = new Array(maxPlayers).fill(false);
  lobby.active = true;
  const time = performance.now();
  setLobbyStartTime(time);
  setModeLobby();
  setLastTime(time);
  requestFrame();
}

export function enterTowerSelection(deps: EnterTowerSelectionDeps): void {
  const {
    state,
    isHost,
    myPlayerId,
    remoteHumanSlots,
    controllers,
    selectionStates,
    initTowerSelection,
    syncSelectionOverlay,
    setOverlaySelection,
    accum,
    enterCastleReselectPhase,
    setModeSelection,
    setLastTime,
    requestFrame,
    log,
  } = deps;

  log(
    `enterTowerSelection (phase=${Phase[state.phase]}, round=${state.round})`,
  );

  const isWatcher = !isHost && !isActivePlayer(myPlayerId);

  // Non-host active player joining mid-game needs reselect phase
  if (!isHost && isActivePlayer(myPlayerId)) {
    const needsCastleReselect = state.phase !== Phase.CASTLE_SELECT;
    if (needsCastleReselect && !isReselectPhase(state.phase)) {
      enterCastleReselectPhase(state);
    }
  }

  // Determine which players need selectInitialTower:
  //   Watcher: nobody — just observing
  //   Non-host player: only myPlayerId — remote players handled by host
  //   Host: all non-remote-humans — host drives AI + local player
  const shouldSelect = (pid: ValidPlayerSlot): boolean => {
    if (isWatcher) return false;
    if (!isHost) return pid === myPlayerId;
    return !isRemoteHuman(pid, remoteHumanSlots);
  };

  selectionStates.clear();
  for (let i = 0; i < state.players.length; i++) {
    const pid = i as ValidPlayerSlot;
    const zone = state.playerZones[i]!;
    if (shouldSelect(pid)) {
      controllers[i]!.selectInitialTower(state, zone);
    }
    initTowerSelection(pid, zone);
  }

  setOverlaySelection();
  syncSelectionOverlay();
  accum.select = 0;
  selectionFacade.initSelectionTimer(state);
  setModeSelection();
  setLastTime(performance.now());
  requestFrame();
}

/** Create an AI-only controller (no key bindings). Used during initial game
 *  setup and host promotion to rebuild controllers for vacant slots. */
export function createAiController(
  id: ValidPlayerSlot,
  seed: number,
  difficulty?: number,
): Promise<PlayerController> {
  return createController(id, true, undefined, seed, difficulty);
}

/** High-level bootstrap: resolves settings → params, then calls bootstrapGame.
 *  Used by the composition root (runtime.ts) for local startGame. */
export async function bootstrapNewGameFromSettings(
  runtimeState: RuntimeState,
  log: (msg: string) => void,
  getUrlRoundsOverride: () => number,
  deps: BootstrapFromSettingsDeps,
  getUrlModeOverride?: () => string,
): Promise<void> {
  const seed = runtimeState.lobby.seed;
  log(`[game] seed: ${seed}`);
  // Clear custom seed so it's only used for this game
  runtimeState.settings.seed = "";
  runtimeState.settings.seedMode = SEED_RANDOM;
  const { buildTimer, cannonPlaceTimer, firstRoundCannons } =
    DIFFICULTY_PARAMS[runtimeState.settings.difficulty]!;
  const roundsParam = getUrlRoundsOverride();
  const roundsVal =
    roundsParam > 0
      ? roundsParam
      : ROUNDS_OPTIONS[runtimeState.settings.rounds]!.value;
  const modeParam = getUrlModeOverride?.() ?? "";
  if (modeParam === GAME_MODE_MODERN || modeParam === GAME_MODE_CLASSIC) {
    runtimeState.settings.gameMode = modeParam;
  }
  await bootstrapGame({
    seed,
    maxPlayers: Math.min(MAX_PLAYERS, PLAYER_KEY_BINDINGS.length),
    existingMap: runtimeState.lobby.map ?? undefined,
    maxRounds: roundsVal,
    cannonMaxHp: CANNON_HP_OPTIONS[runtimeState.settings.cannonHp]!.value,
    buildTimer,
    cannonPlaceTimer,
    firstRoundCannons,
    gameMode: runtimeState.settings.gameMode,
    log,
    clearFrameData: deps.clearFrameData,
    setState: (state) => {
      runtimeState.state = state;
    },
    setControllers: (controllers) => {
      runtimeState.controllers = [...controllers];
    },
    humanSlots: runtimeState.lobby.joined,
    keyBindings: runtimeState.settings.keyBindings,
    difficulty: runtimeState.settings.difficulty,
    resetUIState: deps.resetUIState,
    enterSelection: deps.enterSelection,
  });
}

/** Shared game init — used by both local startGame and online initFromServer.
 *  Generates map from seed, creates state, creates controllers, enters selection. */
export async function bootstrapGame(deps: InitGameDeps): Promise<void> {
  deps.resetUIState();
  deps.clearFrameData();

  const { state, playerCount } = createGameFromSeed(
    deps.seed,
    deps.maxPlayers,
    deps.existingMap,
  );
  applyGameConfig(state, {
    maxRounds: deps.maxRounds,
    cannonMaxHp: deps.cannonMaxHp,
    buildTimer: deps.buildTimer,
    cannonPlaceTimer: deps.cannonPlaceTimer,
    firstRoundCannons: deps.firstRoundCannons,
    gameMode: deps.gameMode,
  });

  deps.log(
    `initGame: ${playerCount} players, seed=${deps.seed}, maxRounds=${state.maxRounds}`,
  );

  const hasAi = deps.humanSlots.some(
    (joined, idx) => idx < playerCount && !joined,
  );
  if (hasAi) await ensureAiModulesLoaded();

  const nextControllers = await Promise.all(
    Array.from({ length: playerCount }, (_, i) => {
      const isAi = !deps.humanSlots[i];
      const strategySeed = isAi ? state.rng.int(0, MAX_UINT32) : undefined;
      return createController(
        i as ValidPlayerSlot,
        isAi,
        deps.keyBindings[i],
        strategySeed,
        isAi ? deps.difficulty : undefined,
      );
    }),
  );

  deps.setState(state);
  deps.setControllers(nextControllers);
  deps.enterSelection();
}
