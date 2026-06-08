import {
  createController,
  ensureAiModulesLoaded,
  rollAiPersonality,
} from "../controllers/controller-factory.ts";
import { applyGameConfig, createGameFromSeed } from "../game/index.ts";
import type { AiPersonality } from "../shared/core/ai-personality.ts";
import {
  DIFFICULTY_PARAMS,
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
  type GameMode,
} from "../shared/core/game-constants.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type {
  AimResolver,
  ControllerFactory,
  PlayerController,
} from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import { MAX_UINT32, type Rng } from "../shared/platform/rng.ts";
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
import { type RuntimeState, setRuntimeGameState } from "./state.ts";

// Re-export AI loading helpers so online code routes through runtime/
// instead of importing controllers/ directly. Keeps online's domain
// boundary at runtime + shared + protocol + game.
export {
  ensureAiModulesLoaded,
  rollAiPersonality,
} from "../controllers/controller-factory.ts";

interface BootstrapFromSettingsDeps {
  readonly clearFrameData: () => void;
  readonly resetUIState: () => void;
  /** Called after state + controllers are ready. Enters tower selection. */
  readonly enterSelection: () => void;
  /** Called immediately after `setState`, before controllers are created.
   *  Hook for any subscription that needs to bind to the fresh `state.bus`
   *  (sound / haptics / stats observers). Required because each game gets
   *  a new bus and the previous game's subscription is discarded with it. */
  readonly onStateReady: () => void;
  /** Optional override for per-slot controller construction. When unset
   *  (production path), `createController` is used. Tests inject a wrapper
   *  to install `AiAssistedHumanController` for selected slots from
   *  bootstrap onward — see `assistedSlots` in `test/runtime-headless.ts`. */
  readonly controllerFactory?: ControllerFactory;
  /** Camera-backed aim resolver for human controllers (screen px → occluded
   *  world). Built in the composition root where the camera exists, then
   *  handed to the factory at construction. */
  readonly humanAimResolver: AimResolver;
}

/** Resolved game configuration from settings + URL overrides.
 *  Pure output — no side effects, no RuntimeState access. */
interface ResolvedGameConfig {
  maxRounds: number;
  cannonMaxHp: number;
  buildTimer: number;
  cannonPlaceTimer: number;
  firstRoundCannons: number;
  /** Game mode: "classic" or "modern". */
  gameMode: GameMode;
}

interface InitGameDeps extends BootstrapFromSettingsDeps, ResolvedGameConfig {
  seed: number;
  maxPlayers: number;
  /** Which slots are human (true = human, false/missing = AI). */
  humanSlots: readonly boolean[];
  /** Per-slot key bindings (only used for human slots). */
  keyBindings: readonly (KeyBindings | undefined)[];
  /** AI difficulty level (0=Easy, 1=Normal, 2=Hard, 3=Very Hard). */
  difficulty: number;
  log: (msg: string) => void;
  setState: (nextState: GameState) => void;
  setControllers: (nextControllers: readonly PlayerController[]) => void;
}

/** Create an AI-only controller (no key bindings). Used during host promotion
 *  to rebuild controllers for vacant slots — receives a private RNG and a
 *  pre-rolled personality because promotion-time construction runs only on
 *  the new host (asymmetric across peers, so it must not draw from
 *  `state.rng`). Initial-bootstrap pure-AI calls the factory directly. */
export function createAiController(
  id: ValidPlayerId,
  rng: Rng,
  personality: AiPersonality,
): Promise<PlayerController> {
  return createController(id, true, undefined, rng, undefined, personality);
}

/** High-level bootstrap: resolves settings → params, then calls bootstrapGame.
 *  Used by the composition root (composition.ts) for local startGame. */
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
    ...config,
    log,
    clearFrameData: deps.clearFrameData,
    setState: (state) => {
      setRuntimeGameState(runtimeState, state);
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
    controllerFactory: deps.controllerFactory,
    humanAimResolver: deps.humanAimResolver,
  });
}

/** Shared game init — used by both local startGame and online initFromServer.
 *  Generates map from seed, creates state, creates controllers, enters selection. */
export async function bootstrapGame(deps: InitGameDeps): Promise<void> {
  deps.resetUIState();
  deps.clearFrameData();

  const { state, playerCount } = createGameFromSeed(deps.seed, deps.maxPlayers);
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
  //   Every peer rolls one personality + one private seed per AI slot in
  //   player order, drawing from `state.rng` symmetrically. Personality is
  //   pre-rolled here (rather than inside `DefaultStrategy`'s constructor)
  //   so the factory can hand it to the strategy without any further RNG
  //   draws — that keeps the construction phase free of strategy-side
  //   state.rng consumption, which would otherwise differ between host and
  //   watcher when one peer installs an AssistedHuman variant for a slot
  //   the other treats as plain pure-AI.
  //
  //   Pure-AI factories use `state.rng` for runtime decision draws (every
  //   peer ticks pure-AI in lockstep). AssistedHuman factories use the
  //   per-slot privateSeed to construct a private `new Rng(seed)` because
  //   their animation runs only on the slot-owning peer.
  //
  //   The host-promotion path in online-host-promotion.ts uses a private
  //   `new Rng(deriveAiStrategySeed(...))` instead, because a promoted host
  //   constructs AI controllers asymmetrically (only on the new host). Post-
  //   promotion AI identity is NOT preserved from the pre-promotion host.
  //   If you ever need identity preservation across promotion, checkpoint
  //   the strategy seeds into SerializedPlayer and restore them on rebuild.
  const factory = deps.controllerFactory ?? createController;
  const nextControllers = await Promise.all(
    Array.from({ length: playerCount }, (_, i) => {
      const isAi = !deps.humanSlots[i];
      // Object-literal evaluation order matters: privateSeed must draw before
      // personality so the determinism fixtures stay byte-stable.
      const aiFields = isAi
        ? {
            privateSeed: state.rng.int(0, MAX_UINT32),
            personality: rollAiPersonality(state.rng, deps.difficulty),
            rng: state.rng,
          }
        : { privateSeed: undefined, personality: undefined, rng: undefined };
      return factory(
        i as ValidPlayerId,
        isAi,
        deps.keyBindings[i],
        aiFields.rng,
        aiFields.privateSeed,
        aiFields.personality,
        deps.humanAimResolver,
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
