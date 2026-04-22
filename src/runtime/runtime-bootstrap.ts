import {
  createController,
  ensureAiModulesLoaded,
} from "../controllers/controller-factory.ts";
import {
  applyGameConfig,
  createGameFromSeed,
  generateMap,
} from "../game/index.ts";
import {
  DIFFICULTY_PARAMS,
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
  type GameMode,
} from "../shared/core/game-constants.ts";
import type { GameMap } from "../shared/core/geometry-types.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type { PlayerController } from "../shared/core/system-interfaces.ts";
import type { GameState, LobbyState } from "../shared/core/types.ts";
import { MAX_UINT32 } from "../shared/platform/rng.ts";
import {
  type GameSettings,
  type KeyBindings,
  MAX_PLAYERS,
  PLAYER_KEY_BINDINGS,
  SEED_RANDOM,
} from "../shared/ui/player-config.ts";
import {
  CANNON_HP_OPTIONS,
  ROUNDS_OPTIONS,
} from "../shared/ui/settings-defs.ts";
import type { TimingApi } from "./runtime-contracts.ts";
import type { RuntimeState } from "./runtime-state.ts";

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
  /** Injected timing primitives — replaces bare `performance.now()` access. */
  timing: TimingApi;
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
  gameMode: GameMode;
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
  /** Called immediately after `setState`, before controllers are created.
   *  Hook for any subscription that needs to bind to the fresh `state.bus`
   *  (sound / haptics / stats observers). Required because each game gets
   *  a new bus and the previous game's subscription is discarded with it. */
  onStateReady: () => void;
}

interface BootstrapFromSettingsDeps {
  readonly clearFrameData: () => void;
  readonly resetUIState: () => void;
  readonly enterSelection: () => void;
  readonly onStateReady: () => void;
}

/** Resolved game configuration from settings + URL overrides.
 *  Pure output — no side effects, no RuntimeState access. */
interface ResolvedGameConfig {
  maxRounds: number;
  cannonMaxHp: number;
  buildTimer: number;
  cannonPlaceTimer: number;
  firstRoundCannons: number;
  gameMode: GameMode;
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
  const time = deps.timing.now();
  setLobbyStartTime(time);
  setModeLobby();
  setLastTime(time);
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
 *  Used by the composition root (runtime-composition.ts) for local startGame. */
export async function bootstrapNewGameFromSettings(
  runtimeState: RuntimeState,
  log: (msg: string) => void,
  getUrlRoundsOverride: () => number,
  deps: BootstrapFromSettingsDeps,
  getUrlModeOverride?: () => string,
): Promise<void> {
  const seed = runtimeState.lobby.seed;
  log(`[game] seed: ${seed}`);

  const config = resolveGameConfig(
    runtimeState.settings,
    getUrlRoundsOverride(),
    getUrlModeOverride?.() ?? "",
  );

  // Apply side effects: clear one-shot seed, persist URL mode override
  runtimeState.settings.seed = "";
  runtimeState.settings.seedMode = SEED_RANDOM;
  runtimeState.settings.gameMode = config.gameMode;

  await bootstrapGame({
    seed,
    maxPlayers: Math.min(MAX_PLAYERS, PLAYER_KEY_BINDINGS.length),
    existingMap: runtimeState.lobby.map ?? undefined,
    ...config,
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
    onStateReady: deps.onStateReady,
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

  // AI strategy seeding contract (initial host path):
  //   Each AI controller pulls one uint32 from the shared game RNG in
  //   player-index order. This advances state.rng before castle selection,
  //   which is captured in every determinism fixture — changing the formula
  //   here re-rolls those fixtures.
  //
  //   The host-promotion path in online-host-promotion.ts derives a seed
  //   from (baseSeed, round, slot) without touching state.rng instead,
  //   because a promoted host doesn't know what the original host pulled at
  //   init time. The two formulas are intentionally different: post-promotion
  //   AI identity is NOT preserved from the pre-promotion host. If you ever
  //   need identity preservation across promotion, checkpoint the strategy
  //   seeds into SerializedPlayer and restore them on rebuild.
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
  deps.onStateReady();
  deps.setControllers(nextControllers);
  deps.enterSelection();
}

/** Resolve settings + URL overrides into game configuration params.
 *  Pure function — reads settings but does not mutate anything. */
function resolveGameConfig(
  settings: GameSettings,
  urlRoundsOverride: number,
  urlModeOverride: string,
): ResolvedGameConfig {
  const { buildTimer, cannonPlaceTimer, firstRoundCannons } =
    DIFFICULTY_PARAMS[settings.difficulty]!;
  const maxRounds =
    urlRoundsOverride > 0
      ? urlRoundsOverride
      : ROUNDS_OPTIONS[settings.rounds]!.value;
  const gameMode =
    urlModeOverride === GAME_MODE_MODERN ||
    urlModeOverride === GAME_MODE_CLASSIC
      ? urlModeOverride
      : settings.gameMode;
  return {
    maxRounds,
    cannonMaxHp: CANNON_HP_OPTIONS[settings.cannonHp]!.value,
    buildTimer,
    cannonPlaceTimer,
    firstRoundCannons,
    gameMode,
  };
}
