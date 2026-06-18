/**
 * FULL_STATE adoption helpers — pure functions shared by host migration
 * (controller re-prime + accumulator sync, on every surviving peer) and
 * the fresh-boot checkpoint apply (controller rebuild, phase-test
 * fixtures).
 */

import {
  primeControllerForPhase,
  useSmallPieces,
  wallBuildTimerMax,
} from "../game/index.ts";
import type { MutableAccums } from "../runtime/timer-accums.ts";
import type { AiPersonality } from "../shared/core/ai-personality.ts";
import { deriveAiStrategySeed } from "../shared/core/ai-seed.ts";
import {
  BATTLE_TIMER,
  MODIFIER_REVEAL_TIMER,
  SELECT_ANNOUNCEMENT_DURATION,
  SELECT_TIMER,
} from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import {
  isPlayerEliminated,
  type PlayerId,
  type ValidPlayerId,
} from "../shared/core/player-slot.ts";
import { isPlayerSeated } from "../shared/core/player-types.ts";
import type { PlayerController } from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import { Rng } from "../shared/platform/rng.ts";
import { initPlayerBag } from "../shared/sim/player-bag.ts";

/** AI dependencies injected by the caller — keeps this file free of any
 *  `controllers/` or `ai/` imports. The caller wires up the concrete
 *  implementations (typically from `controllers/controller-factory.ts`). */
interface AiPromotionDeps {
  /** Resolves once AI chunks are loaded. Called once before the per-slot loop
   *  so `rollPersonality` can run synchronously. */
  readonly ensureLoaded: () => Promise<void>;
  /** Sync personality roll (requires `ensureLoaded` to have resolved). */
  readonly rollPersonality: (rng: Rng) => AiPersonality;
  /** Construct an AI controller for the given slot. */
  readonly create: (
    id: ValidPlayerId,
    rng: Rng,
    personality: AiPersonality,
  ) => Promise<PlayerController>;
}

/**
 * Re-deal build-phase piece bags from the just-adopted shared rng — the
 * bag mirror of `reprimeAiControllersForPhase`, same call discipline
 * (promoted host AFTER serializing, every watcher right after applying,
 * both BEFORE the controller re-prime, whose build picks read
 * `currentPiece`). Bags are deliberately never serialized (see
 * `Player.bag`): the queue and the in-hand `currentPiece` are PAST rng
 * draws, and an adopting peer's copies advanced past the snapshot during
 * its wire-delay skew — kept, its AI picks plan against different pieces
 * than the host's and the match re-diverges. Decided entirely from
 * serialized state, never from local bag presence (a skew window that
 * crossed build-end cleared bags on some peers only): every seated
 * player gets a fresh deal stamped like `prepareNextRound`'s
 * (upcomingRound = round + 1). A one-shot supply small-pieces bias is
 * gone with the original deal — symmetric on every peer, migration-only.
 */
export function redealPlayerBagsForAdoption(state: GameState): void {
  if (state.phase !== Phase.WALL_BUILD) return;
  for (const player of state.players) {
    if (!isPlayerSeated(player)) continue;
    initPlayerBag(player, state.round + 1, state.rng, useSmallPieces(player));
  }
}

/**
 * Re-prime kept AI controllers from a freshly-adopted FULL_STATE so every
 * surviving peer's AI brains restart from the same snapshot moment.
 *
 * Controllers are KEPT across host migration on every peer — AI identity
 * (strategy rng, personality) is a cross-peer contract, and for pure-AI /
 * takeover slots the strategy rng IS `state.rng`, the shared stream the
 * snapshot just restored. What cannot be kept is brain phase state: each
 * peer's brains ticked to their own local position while the snapshot
 * froze one authoritative moment, so without this re-init their decision
 * timing (and the `state.rng` draws it triggers) would drift apart.
 *
 * Cross-peer draw contract — phase init itself draws from the strategy
 * rng, so every peer must re-prime the SAME slots in the SAME order from
 * the SAME rng cursor:
 *  - slots: kind "ai", seat not driven by a connected human, player
 *    alive. Peer-identical because each peer's `remotePlayerSlots` plus
 *    its own human seat (kind "human", skipped) union to the seated-human
 *    set, which every peer derives from the same ordered server stream.
 *  - order: controller-array (= slot) order.
 *  - cursor: the promoted host calls this AFTER serializing the snapshot;
 *    every watcher calls it right after applying that snapshot.
 */
export function reprimeAiControllersForPhase(
  state: GameState,
  controllers: readonly PlayerController[],
  remotePlayerSlots: ReadonlySet<ValidPlayerId>,
): void {
  for (const ctrl of controllers) {
    if (ctrl.kind !== "ai") continue;
    if (remotePlayerSlots.has(ctrl.playerId)) continue;
    const player = state.players[ctrl.playerId];
    if (!player || isPlayerEliminated(player)) continue;
    primeAiControllerForPhase(state, ctrl);
  }
}

/**
 * Reset + phase-init one local AI brain from the current `state`. The
 * per-controller body of `reprimeAiControllersForPhase` (adoption), also
 * fired for a single seat by the lockstep seat-takeover apply
 * (online-seat-takeover.ts) — a takeover mid-phase is exactly a one-seat
 * adoption: the brain restarts from the live state at a tick every peer
 * shares, drawing from the same `state.rng` cursor.
 *
 * Wipes transient decision memory BEFORE the phase init. Strategy
 * transients (per-shot counts, battle target memory, the
 * lastTargetTowerIndex pick short-circuit) are not in the snapshot, and
 * each peer's copy ticked past the snapshot by its own local skew — a
 * surviving difference feeds the very next pick (planEnclosureTarget
 * reuses lastTargetTowerIndex verbatim) and re-diverges the adopted
 * match. reset() draws nothing; the re-roll draws all live in the init
 * calls below. Skipped mid-CASTLE_SELECT: reset would idle the selection
 * brain the selection system armed at cycle entry, and none of the
 * transient mutation sites (fires, build picks) run during that cycle.
 */
export function primeAiControllerForPhase(
  state: GameState,
  ctrl: PlayerController,
): void {
  if (state.phase !== Phase.CASTLE_SELECT) ctrl.reset();
  primeControllerForPhase(state, ctrl);
}

/**
 * Return a new controller array with non-self slots replaced by fresh AI
 * controllers initialized for the current game phase. Fresh-boot path
 * only (`applyMidGameCheckpoint` — phase-test fixtures): a just-booted
 * runtime holds round-1 controllers whose identity draws came off the
 * boot-time shared stream, so a mid-game snapshot needs new, privately
 * seeded ones. Host promotion does NOT rebuild — surviving peers keep
 * their controllers (see `reprimeAiControllersForPhase`).
 */
export async function rebuildControllersForPhase(
  state: GameState,
  controllers: readonly PlayerController[],
  myPlayerId: PlayerId,
  aiDeps: AiPromotionDeps,
): Promise<PlayerController[]> {
  // Pre-load AI modules so rollPersonality can run synchronously inside
  // the per-slot loop (matches the bootstrap path).
  await aiDeps.ensureLoaded();
  return Promise.all(
    controllers.map(async (existing, i) => {
      if (i === myPlayerId) return existing;
      const player = state.players[i];
      if (!player || isPlayerEliminated(player)) return existing;

      const pid = i as ValidPlayerId;
      const strategyRng = new Rng(
        deriveAiStrategySeed(state.rng.seed, state.round, pid),
      );
      // Roll personality from a separate, deterministic Rng. We must NOT
      // touch state.rng here — identity must be a pure function of the
      // snapshot (seed, round, slot), never of construction-time draws
      // off the canonical stream.
      const personalityRng = new Rng(
        deriveAiStrategySeed(state.rng.seed ^ 1, state.round, pid),
      );
      const personality = aiDeps.rollPersonality(personalityRng);
      const ctrl = await aiDeps.create(pid, strategyRng, personality);

      // Initialize the fresh AI for the current phase (no reset needed —
      // it was just constructed). CASTLE_SELECT cycle: driven by selection.
      primeControllerForPhase(state, ctrl);
      return ctrl;
    }),
  );
}

/**
 * Rebuild per-phase accumulators from `state.timer` after a FULL_STATE
 * apply (host promotion broadcast, mid-game checkpoint rehydrate).
 *
 * Every peer ticks accumulators identically (`accum.X += dt`, with
 * `state.timer = max - accum.X` via `advancePhaseTimer`). When an
 * authoritative `state.timer` arrives via FULL_STATE, the local
 * accumulators may not match it — without this resync, the next
 * `advancePhaseTimer` OVERWRITES the restored timer with
 * `max - localAccum`, and since phase exits are timer-driven that's a
 * cross-peer transition-timing divergence, not a cosmetic glitch.
 * Total over every timed phase: a phase without a recompute branch
 * here silently restarts that phase's timer on the applying peer.
 *
 * Two accums get special handling — neither is derivable from
 * `state.timer`:
 *  - `grunt`: cross-phase step-interval clock. Zeroing it on one peer
 *    restarts its grunt cadence while the others' grunts step on
 *    schedule — board divergence within the build phase. Correct only
 *    on the promoted host (syncing against its own state); an adopting
 *    watcher's local clock ticked past the snapshot by its wire-delay
 *    skew, so the migration apply overwrites it from
 *    `FullStateMessage.gruntAccum` right after this call.
 *  - `selectAnnouncement`: consumed-flag for the game-start BANNER_SELECT
 *    window, armed by cycle type in `enterTowerSelection`. Zeroing it
 *    would replay the announcement on one peer only, gating its
 *    selection (and AI) ticks a full window behind every other peer —
 *    so outside CASTLE_SELECT it is preserved. INSIDE CASTLE_SELECT it
 *    is force-CONSUMED instead: the host's own progress through the
 *    window is not serialized (and timer 0 is ambiguous between stage A
 *    and not-started), so the only pose every peer can adopt
 *    identically is "announcement over, countdown running". Cosmetic
 *    cost: a migration mid-announcement cuts the banner short.
 */
export function syncAccumulatorsFromTimer(
  state: GameState,
  accum: MutableAccums,
  gruntAccum?: number,
): void {
  accum.build = 0;
  accum.cannon = 0;
  accum.battle = 0;
  accum.select = 0;
  accum.modifierReveal = 0;
  if (gruntAccum !== undefined) accum.grunt = gruntAccum;

  if (state.phase === Phase.WALL_BUILD) {
    // Three-term max (base + upgrade bonus + drained supply-ship seconds):
    // a snapshot captured mid-bonus-build must not read as further
    // elapsed than it is. `extraBuildTimeSeconds` rides in FULL_STATE.
    accum.build = wallBuildTimerMax(state) - state.timer;
  } else if (state.phase === Phase.CANNON_PLACE && state.timer > 0) {
    // timer === 0 is the cannons-banner window: `enterCannonPhase` primes
    // the timer to 0 and the banner's postDisplay starts the real
    // countdown via `resetAccum` (the promotion repair that skips the
    // banner does the same). Reading 0 as "fully elapsed" here would make
    // every applying peer skip cannon placement for the round; leave
    // `cannon` at 0 (countdown from full) — same ambiguity rule as the
    // CASTLE_SELECT branch below.
    accum.cannon = state.cannonPlaceTimer - state.timer;
  } else if (state.phase === Phase.BATTLE) {
    accum.battle = BATTLE_TIMER - state.timer;
  } else if (state.phase === Phase.MODIFIER_REVEAL) {
    accum.modifierReveal = MODIFIER_REVEAL_TIMER - state.timer;
  } else if (state.phase === Phase.CASTLE_SELECT) {
    if (state.timer > 0) {
      // timer === 0 is the round-1 announcement window (stage A holds
      // the timer at 0) or the countdown-expiry tick — in both, elapsed
      // can't be derived; leave `select` at 0 (countdown from full).
      accum.select = SELECT_TIMER - state.timer;
    }
    accum.selectAnnouncement = SELECT_ANNOUNCEMENT_DURATION;
  }
}
