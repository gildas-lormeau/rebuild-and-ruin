import {
  createController,
  ensureAiModulesLoaded,
  rollAiPersonality,
} from "../controllers/controller-factory.ts";
import { HumanController } from "../controllers/controller-human.ts";
import { applyGameConfig, createGameFromSeed } from "../game/index.ts";
import type { AiPersonality } from "../shared/core/ai-personality.ts";
import { deriveAiStrategySeed } from "../shared/core/ai-seed.ts";
import {
  DIFFICULTY_PARAMS,
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
  type GameMode,
} from "../shared/core/game-constants.ts";
import type { KeyBindings } from "../shared/core/input-action.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type {
  AimResolver,
  ControllerFactory,
  PlayerController,
  WorldOccluder,
} from "../shared/core/system-interfaces.ts";
import { forcedPersonalityFor, type GameState } from "../shared/core/types.ts";
import { MAX_UINT32, Rng } from "../shared/platform/rng.ts";
import {
  type GameSettings,
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
  /** Frame-clock source (`timing.now`) — rebases `runtimeState.lastTime`
   *  at state install so the first post-install frame never measures a
   *  pre-session gap (see `setRuntimeGameState`). */
  readonly now: () => number;
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
  /** Camera-backed world-space occluder for keyboard fire (same origin as
   *  `humanAimResolver`). Optional: omitted in headless (no tilt), where
   *  keyboard aim needs no occlusion. */
  readonly humanWorldOccluder?: WorldOccluder;
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

/** `now` is excluded: it exists to build the `setState` closure, and both
 *  `bootstrapGame` callers (settings wrapper below, online initFromServer)
 *  close over their own clock when building `setState`. */
interface InitGameDeps
  extends Omit<BootstrapFromSettingsDeps, "now">,
    ResolvedGameConfig {
  seed: number;
  maxPlayers: number;
  /** Which seats have a human — ANY peer's human, not just this peer's
   *  (true = human seated, false/missing = pure AI). Cross-peer RNG
   *  contract: must be identical on every peer of the same match (see the
   *  seeding-contract comment in `bootstrapGame`). */
  humanSlots: readonly boolean[];
  /** Per-slot key bindings — present only for human seats THIS peer
   *  drives. A human seat without bindings is a remote player's seat. */
  keyBindings: readonly (KeyBindings | undefined)[];
  /** AI difficulty level (0=Easy, 1=Normal, 2=Hard, 3=Very Hard). */
  difficulty: number;
  log: (msg: string) => void;
  setState: (nextState: GameState) => void;
  setControllers: (controllers: readonly PlayerController[]) => void;
  /** Liveness probe for the awaits in `bootstrapGame`: returns true once
   *  the session this bootstrap belongs to has been torn down
   *  (`bootGeneration` moved — see its doc in state.ts). Checked after
   *  every await; the tail must not install state or enter selection for
   *  a session the user already exited. */
  isCancelled: () => boolean;
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

/** Build a LOCAL human controller SYNCHRONOUSLY (no AI-module load). The
 *  online seat-reclaim owner swap (composition `installLocalHumanController`)
 *  needs a synchronous build so it can ride the lockstep SEAT_RECLAIM apply in
 *  the same tick as the slot-set flip. Lives here because bootstrap.ts is the
 *  one composition-root file allowed to import `src/controllers/` directly. */
export function createHumanController(
  id: ValidPlayerId,
  keys: KeyBindings,
  aimResolver: AimResolver,
  worldOccluder?: WorldOccluder,
): PlayerController {
  return new HumanController(id, keys, aimResolver, worldOccluder);
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

  // Clear the one-shot seed. The URL mode override deliberately does NOT
  // write into `settings.gameMode`: settings hold the player's persisted
  // default (saveSettings strips the seed but keeps gameMode), so a
  // shared ?mode= link must stay a per-session override — every boot
  // re-resolves it from the URL — not silently flip the stored default
  // the next time the options screen saves.
  runtimeState.settings.seed = "";
  runtimeState.settings.seedMode = SEED_RANDOM;

  const generation = runtimeState.bootGeneration;
  await bootstrapGame({
    isCancelled: () => runtimeState.bootGeneration !== generation,
    seed,
    maxPlayers: Math.min(MAX_PLAYERS, PLAYER_KEY_BINDINGS.length),
    ...config,
    log,
    clearFrameData: deps.clearFrameData,
    setState: (state) => {
      setRuntimeGameState(runtimeState, state, deps.now());
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
    humanWorldOccluder: deps.humanWorldOccluder,
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

  // AI modules are needed for pure-AI slots AND for remote-human seats —
  // their disconnect-takeover AI controller is built now, at bootstrap.
  const hasAi = Array.from(
    { length: playerCount },
    (_, idx) => !deps.humanSlots[idx] || !deps.keyBindings[idx],
  ).includes(true);
  if (hasAi) await ensureAiModulesLoaded();
  if (deps.isCancelled()) {
    deps.log("initGame: cancelled during AI module load — session torn down");
    return;
  }

  // AI identity seeding contract (initial bootstrap path):
  //   `deps.humanSlots` is the SEATED-HUMAN set and must be identical on
  //   every peer (local: lobby.joined; online: lobby seating every client
  //   derived from the same ordered server stream — see initFromServer).
  //   It must never mean "slots this peer drives": the shared-stream draws
  //   below are keyed off it, so a per-peer view skews both the draw count
  //   and the slot→identity mapping across peers.
  //
  //   Pure-AI slots draw one privateSeed + one personality each from
  //   `state.rng`, in slot order — symmetric on every peer, and the
  //   sequence the local determinism fixtures are recorded against. Their
  //   controllers tick on every peer in lockstep, drawing decisions from
  //   `state.rng` (= strategy.rng). AssistedHuman factories (tests) use
  //   the per-slot privateSeed to construct a private `new Rng(seed)`
  //   because their animation runs only on the slot-owning peer.
  //
  //   Human seats draw NOTHING from the shared stream. The controller
  //   depends on who is bootstrapping:
  //     - keyBindings[i] present → this peer drives the seat: human.
  //     - keyBindings[i] absent → a remote human's seat: build its
  //       disconnect-takeover AI. If that player leaves mid-game the slot
  //       drops out of remotePlayerSlots and every surviving peer starts
  //       ticking this controller in lockstep — so its identity must agree
  //       across peers without touching the shared stream: personality
  //       rolls from a private Rng over deriveAiStrategySeed(seed ^ 1,
  //       round, slot) (the same salt the promotion rebuild uses), and
  //       decisions draw from `state.rng` like any lockstep pure-AI slot.
  //
  //   Personality is pre-rolled here (rather than inside
  //   `DefaultStrategy`'s constructor) so the factory can hand it to the
  //   strategy without any further RNG draws — construction stays free of
  //   strategy-side state.rng consumption.
  //
  //   Real host promotion KEEPS controllers on every surviving peer
  //   (reprimeAiControllersForPhase) — identity is retained, only phase
  //   state re-primes. The private-rng CONSTRUCTION path
  //   (rebuildControllersForPhase in online-host-promotion.ts) fires on
  //   fresh-boot checkpoint adoption instead (online-rehydrate.ts), where
  //   there is no pre-existing controller to keep; it derives BOTH rngs
  //   privately from deriveAiStrategySeed(seed [^ 1], round, slot). Either
  //   way, identity is a pure function of checkpointed inputs, never
  //   transmitted — but a rebuilt AI's personality is NOT preserved from
  //   whatever the pre-adoption host happened to roll. This does not
  //   desync (decisions still draw from the shared state.rng; the
  //   re-derivation is peer-symmetric and never touches state.rng); it is
  //   only a per-match flavor discontinuity. If you ever need that
  //   continuity too, checkpoint the strategy seeds into SerializedPlayer
  //   and restore them on rebuild.
  const factory = deps.controllerFactory ?? createController;
  const controllers = await Promise.all(
    Array.from({ length: playerCount }, (_, i) => {
      const pid = i as ValidPlayerId;
      const keys = deps.keyBindings[i];
      if (!deps.humanSlots[i]) {
        // Draw order matters: privateSeed before personality, slots in
        // order, so the determinism fixtures stay byte-stable. A forced
        // personality (test hook) skips the roll — and its state.rng
        // draws — for that slot.
        const privateSeed = state.rng.int(0, MAX_UINT32);
        const personality =
          forcedPersonalityFor(state, pid) ??
          rollAiPersonality(state.rng, deps.difficulty);
        return factory(
          pid,
          true,
          keys,
          state.rng,
          privateSeed,
          personality,
          deps.humanAimResolver,
        );
      }
      if (keys) {
        return factory(
          pid,
          false,
          keys,
          undefined,
          undefined,
          undefined,
          deps.humanAimResolver,
          deps.humanWorldOccluder,
        );
      }
      // Remote human's seat: disconnect-takeover AI, identity derived
      // off-stream (see contract above).
      const personality = rollAiPersonality(
        new Rng(deriveAiStrategySeed(state.rng.seed ^ 1, state.round, pid)),
        deps.difficulty,
      );
      return factory(
        pid,
        true,
        undefined,
        state.rng,
        undefined,
        personality,
        deps.humanAimResolver,
      );
    }),
  );

  if (deps.isCancelled()) {
    deps.log(
      "initGame: cancelled during controller construction — session torn down",
    );
    return;
  }

  deps.setState(state);
  deps.onStateReady();
  deps.setControllers(controllers);
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
