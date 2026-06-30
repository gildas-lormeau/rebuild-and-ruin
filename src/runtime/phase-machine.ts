/**
 * Phase transition state machine. Each `TRANSITIONS` entry declares:
 * `from` guard (`"*"` = any), `mutate` (identical on every peer; only
 * `ctx.broadcast?.X?.()` is host-gated), optional `postMutate` (sync after
 * mutate, before display), `display` (ordered UI steps), optional
 * `postDisplay`. Phase entry is owned by game/ via `enter*Phase`; bus
 * events are observation-only — never control flow.
 */

import {
  applyUpgradePicks,
  enterBattlePhase,
  enterCannonPhase,
  enterModifierRevealPhase,
  enterRoundEndPhase,
  enterUpgradePickPhase,
  enterWallBuildPhase,
  finalizeBattle,
  finalizeCastleConstruction,
  finalizeFreshCastles,
  finalizeRound,
  finalizeRoundCleanup,
  type GameOverOutcome,
  prepareBattle,
  prepareNextRound,
  recheckTerritory,
  snapshotTerritory,
} from "../game/index.ts";
import type { BalloonFlight } from "../shared/core/battle-types.ts";
import type { UpgradePickDialogState } from "../shared/core/dialog-state.ts";
import { MODIFIER_ID } from "../shared/core/game-constants.ts";
import {
  type BannerKind,
  emitGameEvent,
  GAME_EVENT,
} from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { TileKey } from "../shared/core/grid.ts";
import {
  type ModifierDiff,
  modifierDef,
} from "../shared/core/modifier-defs.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { GameState } from "../shared/core/types.ts";
import { snapshotAllWalls } from "../shared/sim/board-occupancy.ts";
import { clearAllPlayerBags } from "../shared/sim/player-bag.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import {
  BANNER_BATTLE,
  BANNER_BATTLE_SUB,
  BANNER_BUILD,
  BANNER_BUILD_SUB,
  BANNER_PLACE_CANNONS,
  BANNER_PLACE_CANNONS_SUB,
  BANNER_UPGRADE_PICK,
  BANNER_UPGRADE_PICK_SUB,
} from "./banner-messages.ts";
import type { BannerShow } from "./banner-state.ts";
import type { RuntimeState } from "./state.ts";

type TransitionId =
  | "castle-done"
  | "advance-to-cannon"
  | "enter-cannon-place"
  | "enter-round-end"
  | "cannon-place-done"
  | "enter-modifier-reveal"
  | "enter-battle"
  | "battle-done"
  | "ceasefire"
  | "enter-upgrade-pick"
  | "enter-wall-build"
  | "game-over";

/** Opaque result produced by a transition's mutate fn, threaded through the
 *  display steps. `modifierDiff` and `flights` are always present — use
 *  `EMPTY_TRANSITION_RESULT` or spread it for transitions that don't touch
 *  the battle-entry fields. */
interface TransitionResult {
  readonly modifierDiff: ModifierDiff | null;
  readonly flights: readonly BalloonFlight[];
}

type DisplayStep = {
  /** Banner identity — forwarded through `showBanner` onto every
   *  BANNER_* event so consumers discriminate on this, not
   *  `phase`/`text`. */
  readonly bannerKind: BannerKind;
  /** Static text, or a function of the current GameState (used by
   *  the modifier-reveal banner which reads the modifier label from
   *  `state.modern.activeModifier`). State is already fully populated
   *  by the preceding mutate step on both host and watcher. */
  readonly text: string | ((state: GameState) => string);
  readonly subtitle?: string;
  /** Opaque accent-palette key extractor. Used by the
   *  modifier-reveal banner to recolor its chrome (title + border).
   *  The banner system treats the result as a string the renderer
   *  indexes into its palette table. Only set where a non-default
   *  palette is wanted. */
  readonly paletteKey?: (state: GameState) => string | undefined;
};

/** Per-transition mutation. Same function runs on every peer. Game-state
 *  mutation is uniform; the only role-gated effect is wire emission via
 *  `ctx.broadcast?.X?.()`, populated only on the host. */
type MutateFn = (ctx: PhaseTransitionCtx) => TransitionResult;

/** Shared post-mutation sync. Runs synchronously after `mutate` returns and
 *  BEFORE the first display step (e.g. rebuilding `battleAnim` snapshots
 *  from the freshly-mutated state). Keeping it separate from `mutate`
 *  removes duplicated trailing calls. */
type PostMutateFn = (ctx: PhaseTransitionCtx, r: TransitionResult) => void;

/** Side-effects after the display steps complete. Same function runs on
 *  every peer; the only role-gated effect is `ctx.broadcast?.X?.()`. */
type PostDisplayFn = (ctx: PhaseTransitionCtx, r: TransitionResult) => void;

/** Declarative successor edge. Returned by a "prep" transition (one with
 *  no banner of its own) to name the entry transition the runner dispatches
 *  next, INLINE, on the same dispatch tick — that's how the runner chains
 *  prep → entry without each prep imperatively calling the next dispatch.
 *  Reads the just-run transition's `result` (e.g. modifier roll) and/or
 *  `ctx.state` to pick the branch. Absent on entry transitions (they're
 *  terminal for the synchronous chain — their own exit is a later
 *  banner-driven or self-driving-tick dispatch). */
type RouteFn = (
  ctx: PhaseTransitionCtx,
  result: TransitionResult,
) => TransitionId;

interface Transition {
  readonly id: TransitionId;
  /** Source phase asserted on every peer's dispatch. A single `Phase`
   *  accepts only that phase; a readonly array accepts any of the
   *  listed phases (used by entry transitions like `enter-battle` that
   *  may be dispatched from either CANNON_PLACE directly or from
   *  MODIFIER_REVEAL after the modifier banner). `"*"` opts out of the
   *  guard entirely (the game-over transition may fire from any phase). */
  readonly from: Phase | readonly Phase[] | "*";
  readonly mutate: MutateFn;
  /** Shared post-mutation sync. Runs after mutate, before display. */
  readonly postMutate?: PostMutateFn;
  readonly display: readonly DisplayStep[];
  readonly postDisplay?: PostDisplayFn;
  /** Successor edge for prep transitions — the runner dispatches its
   *  result inline after `postDisplay`. Declaring it on the transition
   *  (instead of dispatching from inside `postDisplay`) lets the table
   *  show the phase graph. */
  readonly route?: RouteFn;
}

/** Minimal battle-lifecycle hooks the machine needs to drive the post-
 *  battle-banner step (balloon anim or beginBattle). */
interface BattleLifecycle {
  readonly setFlights: (
    flights: { flight: BalloonFlight; progress: number }[],
  ) => void;
  readonly setTerritory: (territory: readonly Set<TileKey>[]) => void;
  readonly setWalls: (walls: readonly Set<TileKey>[]) => void;
  readonly clearImpacts: () => void;
  readonly begin: () => void;
}

/** Context passed to every transition step.
 *
 *  Two-tier shape. The CORE block is wired UNCONDITIONALLY by the sole
 *  constructor (`buildPhaseCtx`) on every peer — those fields are
 *  non-optional and callers dereference them directly. The trailing
 *  OPTIONAL block holds the genuinely-conditional capabilities (host role,
 *  modern mode, touch, 3D renderer) plus the one per-dispatch datum
 *  (`gameOverOutcome`); their `?` is honest — present only where the gate
 *  applies. Keep that contract: a new always-wired hook goes in core as
 *  required; only add an optional field when a real wiring can omit it. */
export interface PhaseTransitionCtx {
  readonly state: GameState;
  readonly runtimeState: RuntimeState;

  readonly showBanner: BannerShow;
  /** Hide whatever banner is currently on screen. The display runner
   *  calls this once at the END of every display sequence — empty ones
   *  included — so postDisplay hooks run against a clean screen (a
   *  `swept` banner sits on screen until explicitly hidden). Banner steps
   *  never need this — `showBanner` overwrites cleanly. */
  readonly hideBanner: () => void;
  /** Render the current (pre-mutation) state offscreen at fullMapVp and
   *  hand it to the banner system as the next banner's prev-scene.
   *  Called by `runTransition` BEFORE the mutate — the snapshot must
   *  show the old board, and it must not depend on the displayed
   *  camera (per-peer cosmetic state). See `BannerSystem.primePrevScene`. */
  readonly primeBannerPrevScene: () => void;
  /** Cosmetic hard-cut of the displayed viewport to fullMapVp at
   *  transition dispatch (no-op on desktop, which never leaves fullmap).
   *  See `RuntimeCamera.snapToFullMapForTransition`. */
  readonly snapCameraToFullMap: () => void;
  readonly setMode: (m: Mode) => void;
  readonly log: (msg: string) => void;

  readonly scoreDelta: {
    // The round's pre-scores are captured inline in `enter-round-end`'s
    // mutate (before `finalizeRound` mutates scores) and handed to
    // `setPreScores` — there is no separate capture hook. `start` begins
    // the overlay beat in the same transition's postDisplay; the
    // self-driving `tickRoundEndPhase` then polls `isActive`. The overlay's
    // own teardown is owned outside the machine (host-promote / rehydrate /
    // lifecycle call `RuntimeScoreDelta.reset` on the full handle), so the
    // machine's narrowed view exposes no `reset`.
    readonly setPreScores: (scores: readonly number[]) => void;
    readonly start: () => void;
    readonly isActive: () => boolean;
  };

  readonly battle: BattleLifecycle;

  /** Finalize local controllers' build-phase bag state. Called from
   *  `enter-round-end`'s mutate on every peer, over the controllers this
   *  peer drives (remote humans are skipped — their controllers re-init via
   *  startBuildPhase at next round). */
  readonly finalizeLocalControllersBuildPhase: () => void;
  /** End-of-battle loop: per local controller, clear fire targets and reset
   *  battle state. Called from `battle-done`'s mutate on every peer. */
  readonly endBattleLocalControllers: () => void;
  /** Run `cb` once the in-flight pitch animation completes (in either
   *  direction). `proceedToBattleFromCtx` uses it to hold balloon-anim start
   *  until the build→battle tilt completes. Fires synchronously when
   *  pitch is already settled, so callers don't need a separate gate. See
   *  `RuntimeCamera.awaitPitchSettled`. Wired UNCONDITIONALLY — headless and
   *  2D included: the pitch state machine is renderer-independent,
   *  deterministic (SIM_TICK_DT), and GATES battle-done dispatch, so a peer
   *  that skipped it would dispatch at different sim ticks than the rest
   *  (camera-zoom-parity pins this). */
  readonly awaitPitchSettled: (callback: () => void) => void;
  /** Start the build→battle tilt at battle-banner end. Called inside
   *  `proceedToBattleFromCtx`. Same wiring contract as `awaitPitchSettled`
   *  above: renderer-independent — a 2D renderer simply doesn't DISPLAY the
   *  pitch, but the deterministic pitch sim must still run on every peer. */
  readonly beginTilt: () => void;
  /** Per-peer setup when WALL_BUILD begins: score-delta reset,
   *  per-LOCAL-controller startBuildPhase, clear impacts, accumulator
   *  resets. Called from `enter-wall-build`'s mutate (before the banner's
   *  B-snapshot — see that transition's doc) on every peer; "local" means
   *  the controllers this peer drives (AI + own human), not host role. */
  readonly startBuildPhaseLocal: () => void;
  /** Run `enterBuildSkippingBattle(state)` — the engine post-battle work
   *  the ceasefire path runs when no one can fight (no phase flip happens
   *  here; the following `enter-wall-build` / `enter-upgrade-pick` entry
   *  transition owns that). Separate from `battle-done`'s `finalizeBattle`
   *  + `prepareNextRound` because it also decays burning pits, sweeps
   *  walls, rechecks territory, and clears active modifiers (things the
   *  real battle-end flow already handled). */
  readonly ceasefireSkipBattle: () => void;
  /** Per-local-controller cannon-phase init after `enterCannonPhase`:
   *  `placeCannons(state, maxSlots)` + `cannonCursor` + `startCannonPhase`.
   *  Wired on every peer — "local" means the controllers this peer drives
   *  (AI + own human), not host role. The hook re-derives per-player prep
   *  from state via `prepareControllerCannonPhase` — `enterCannonPhase`
   *  has already populated `state.cannonLimits` / facings, so the work is
   *  idempotent and the entry struct doesn't need to thread through ctx. */
  readonly initLocalCannonControllers: () => void;
  /** End-game side effects (set game-over frame, stop sound, switch to
   *  Mode.STOPPED, arm demo timer). Used by the `game-over` transition.
   *  Wired on every peer — watchers run it from their own local
   *  dispatch. */
  readonly endGame: (winner: { id: ValidPlayerId }) => void;

  // ── Genuinely optional: role / mode / renderer-gated capabilities, plus
  //    the one per-dispatch datum (`gameOverOutcome`). The `?` here is
  //    honest — each is absent in the wirings that don't apply. ──

  /** Save the human player's crosshair position so it can be restored at
   *  the start of the next battle (touch UX). Composition gates it on
   *  IS_TOUCH_DEVICE, so it's absent on non-touch wirings. */
  readonly saveBattleCrosshair?: () => void;
  /** Upgrade-pick dialog hooks. Present only in modern mode (classic
   *  wirings omit it). Required by transitions whose display chain runs the
   *  picker modal (`enter-upgrade-pick`) and by the self-driving phase tick
   *  (`tickUpgradePickPhase`).
   *
   *  UPGRADE_PICK is a self-driving phase (like MODIFIER_REVEAL): the
   *  entry transition `prepare()`s + `show()`s the dialog, then the phase
   *  tick polls `isReadyToExit()` and the phase machine dispatches the
   *  exit (`finishUpgradePick` → `enter-wall-build`) itself — no armed
   *  resolution callback that promotion teardown could orphan. `get`/`set`
   *  let `finishUpgradePick` read the resolved snapshot and tear the
   *  dialog down at the single exit funnel. */
  readonly upgradePick?: {
    readonly prepare: () => boolean;
    /** Flip to Mode.UPGRADE_PICK + drain early wire picks. False = no
     *  offers (exit immediately). */
    readonly show: () => boolean;
    readonly tick: (dt: number) => void;
    readonly isReadyToExit: () => boolean;
    readonly get: () => UpgradePickDialogState | null;
    readonly set: (dialog: UpgradePickDialogState | null) => void;
  };
  /** Host-only phase markers, sent so the relay SERVER can track the
   *  current phase. Two distinct receivers, not one:
   *  - Non-host PEERS ignore them (`online-server-lifecycle.ts` acks but
   *    runs no engine work) — under clone-everywhere every peer already
   *    dispatched the matching transition from its own local tick. The
   *    per-field comment names that work.
   *  - The relay SERVER consumes `cannonStart` / `battleStart` /
   *    `buildStart` to drive `this.phase` (`server/game-room.ts`
   *    `updatePhaseFromMessage`), which gates per-message phase validation
   *    (PHASE_GATES) + late-spectator boots. So those three are NOT
   *    vestigial — dropping them would blind the relay's phase gate.
   *  `buildEnd` alone drives nothing: the server tracks WALL_BUILD from
   *  `buildStart` and stays there through ROUND_END until the next
   *  `cannonStart` / `selectStart`, so it's a pure liveness marker (kept
   *  for symmetry + cheap tracing). Absent on non-host wirings. */
  readonly broadcast?: {
    /** CANNON_PLACE-entry marker — receivers ran `enterCannonPhase` from
     *  their own `castle-done` / `advance-to-cannon` tick. */
    readonly cannonStart?: () => void;
    /** BATTLE-entry marker — receivers ran `prepareBattle` from their own
     *  `cannon-place-done` tick. */
    readonly battleStart?: () => void;
    /** WALL_BUILD-entry marker — receivers ran `finalizeBattle` +
     *  `prepareNextRound` from their own `battle-done` / `ceasefire` tick. */
    readonly buildStart?: () => void;
    /** Round-close marker — receivers ran `finalizeRound` from their own
     *  `round-end` tick. */
    readonly buildEnd?: () => void;
  };
  /** Fire-and-forget: pre-compile the shadow-pass permutation of every
   *  entity material on the renderer. Called from `enter-cannon-place`'s
   *  postDisplay so the GPU links shadow programs in the background during
   *  the cannon-place banner — by the time the camera tilts into BATTLE
   *  (which flips `sun.castShadow` on), three.js finds the programs
   *  already linked and skips the ~84ms blocking recompile that would
   *  otherwise hit the critical frame. Idempotent across calls.
   *  Renderers without a 3D pipeline (2D, headless stub) omit it. */
  readonly warmShadowPermutations?: () => Promise<void>;
  /** Outcome decided by the life-lost resolution. A per-dispatch datum
   *  spread onto the ctx by `dispatchGameOver` only — so the `game-over`
   *  mutate can log the reason and pass the winner to `endGame`. Absent
   *  for every other transition. */
  readonly gameOverOutcome?: GameOverOutcome;
}

/** Default "no battle-entry data" result. Every transition whose mutate
 *  doesn't produce a modifier roll or balloon flights returns this (or
 *  spreads it). Keeps `TransitionResult.modifierDiff` / `flights` strictly
 *  required at the type level — consumers no longer defensively coalesce.
 *  No code mutates a result (the type is fully `readonly`); the shared
 *  singleton is only ever read or spread into a fresh object. */
const EMPTY_TRANSITION_RESULT: TransitionResult = {
  modifierDiff: null,
  flights: [],
};
/** `enter-round-end` — end of WALL_BUILD (round closes here, after the
 *  score is finalized). Dispatched from `tickBuildPhase` at `timer <= 0`.
 *
 *  Mutate (every peer): finalizes local controllers' bag state, runs the
 *  engine's `finalizeRound` (territory finalize + life penalties), stashes
 *  the resulting `{needsReselect, eliminated}` routing on `runtimeState`,
 *  then enters Phase.ROUND_END. The host additionally broadcasts the
 *  BUILD_END phase marker, which non-host peers ignore on the wire — they
 *  ran `finalizeRound` from their own `enter-round-end` tick.
 *
 *  postDisplay: starts the score-delta overlay (the first ROUND_END beat).
 *  From here ROUND_END is SELF-DRIVING: `tickRoundEndPhase` (phase-ticks)
 *  drives the overlay beat → life-lost dialog beat → exit routing
 *  (game-over / reselect / advance-to-cannon), re-derived from state every
 *  frame, so a host-promoted peer resumes without a repair hatch. The
 *  round number stays at the closing value through the window — the
 *  advance + ROUND_START are deferred to the exit (`exitRoundEnd`). */
const ENTER_ROUND_END: Transition = {
  id: "enter-round-end",
  from: Phase.WALL_BUILD,
  mutate: (ctx) => {
    ctx.finalizeLocalControllersBuildPhase();
    // Clear bags on every peer at the same logical sim tick. Per-LOCAL
    // controller bag clears (which `finalizeLocalControllersBuildPhase`
    // used to do) drifted `state.rng`: late-arriving piece-place actions
    // would drain on one peer (no-op against null bag) while the other
    // peer advanced + potentially shuffled the bag (RNG draw). Symmetric
    // clear here closes that window — see `clearAllPlayerBags` docstring.
    clearAllPlayerBags(ctx.state);
    // Capture pre-scores BEFORE finalizeRound mutates them via
    // territory + life-penalty point awards — the score overlay needs the
    // starting values for the delta animation.
    const preScores = ctx.state.players.map((player) => player.score);
    // Phase A only: scoring + life penalties. The wall sweep, dead-zone
    // grunt sweep, and targetedWall recompute are deferred to `finalizeRoundCleanup`,
    // called from `advance-to-cannon` / `castle-done` (round > 1) so the
    // cannons banner reveals them. The game-over routes never run it —
    // the final board keeps its un-swept walls and dead-zone grunts
    // (cosmetic only: scoring already happened here in Phase A).
    // `applyLifePenalties` inside finalizeRound already runs
    // `resetZoneState` for eliminated/reselect players — every peer
    // converges identically.
    const routing = finalizeRound(ctx.state);
    ctx.scoreDelta.setPreScores(preScores);
    // Stash the routing for the self-driving tick: the dialog beat reads
    // it to build the life-lost entries, and the exit reads it. Runtime-
    // only — a peer that ADOPTS a mid-ROUND_END snapshot re-derives
    // `needsReselect` from the board instead (see `deriveRoundEndRouting`).
    ctx.runtimeState.roundEnd = routing;
    enterRoundEndPhase(ctx.state);
    ctx.broadcast?.buildEnd?.();
    return EMPTY_TRANSITION_RESULT;
  },
  display: [],
  // Start the score-overlay beat. `tickRoundEndPhase` takes over from here.
  postDisplay: (ctx) => ctx.scoreDelta.start(),
};
/** `battle-done` — BATTLE prep transition. Runs engine post-battle
 *  housekeeping in two halves: `finalizeBattle` (combo bonuses, battle
 *  cleanup, inGracePeriod clear, lastModifierId snapshot) followed by
 *  `prepareNextRound` (interbattle grunt spawn, upgrade offer generation,
 *  bonus-square replenish, piece bag init — round increment and
 *  ROUND_START happen later, in `round-end`). Broadcasts BUILD_START.
 *  Does NOT flip the phase and shows no banner — `postDisplay` routes to
 *  `enter-upgrade-pick` (when offers were generated) or `enter-wall-build`,
 *  each of which delegates the phase entry to game/ + shows its own banner.
 *
 *  Both sides run `finalizeBattle` + `prepareNextRound` locally — the
 *  BUILD_START wire signal is a payload-less marker the watcher ignores
 *  (it dispatches this transition from its own local tick).
 *  RNG was synced at the previous `BATTLE_START` and has tracked
 *  identically through impact resolution, so post-battle RNG draws
 *  (interbattle grunt spawn, upgrade offers, bonus square shuffle,
 *  enclosed-grunt respawn) advance in lockstep. */
const BATTLE_DONE: Transition = {
  id: "battle-done",
  from: Phase.BATTLE,
  mutate: (ctx) => {
    ctx.endBattleLocalControllers();
    ctx.saveBattleCrosshair?.();
    finalizeBattle(ctx.state);
    if (ctx.state.modern?.lastModifierId === MODIFIER_ID.SUPPLY_SHIP) {
      const pending = ctx.state.modern.pendingSupplyBonuses;
      const summary = pending?.size
        ? [...pending.entries()]
            .map(([playerId, bonuses]) => `P${playerId}=${bonuses.join(",")}`)
            .join(" ")
        : "(no hits)";
      ctx.log(`supply ships resolved: ${summary}`);
    }
    prepareNextRound(ctx.state);
    ctx.broadcast?.buildStart?.();
    return EMPTY_TRANSITION_RESULT;
  },
  postMutate: clearBattleAnim,
  display: [],
  route: routePostBattleToBuild,
};
/** `ceasefire` — CANNON_PLACE prep transition (battle skipped).
 *
 *  Triggered when `shouldSkipBattle(state)` at the top of `startBattle`:
 *  no side has fighting capability, so the battle is skipped at the
 *  engine level. `enterBuildSkippingBattle` does the pre-battle cleanup
 *  (burning-pit decay, wall sweep, territory recheck, modifier clear)
 *  then calls `finalizeBattle` + `prepareNextRound` (upgrade-offer
 *  generation, interbattle grunt spawn — the round increment happens
 *  later, in `round-end`). Shows no banner; `postDisplay` routes to
 *  `enter-upgrade-pick` or `enter-wall-build`. Dispatched on every peer's
 *  local tick (`tickCannonPhase` checks `shouldSkipBattle` unconditionally);
 *  the host additionally broadcasts BUILD_START, a payload-less marker the
 *  watcher ignores. */
const CEASEFIRE: Transition = {
  id: "ceasefire",
  from: Phase.CANNON_PLACE,
  // Dispatched on every peer's local tick — `tickCannonPhase` checks
  // `shouldSkipBattle` unconditionally and `ceasefireSkipBattle` is
  // wired in the universal ctx. The host additionally broadcasts
  // BUILD_START as a sync marker.
  mutate: (ctx) => {
    ctx.log(`ceasefire: skipping battle (round=${ctx.state.round})`);
    ctx.ceasefireSkipBattle();
    ctx.broadcast?.buildStart?.();
    return EMPTY_TRANSITION_RESULT;
  },
  postMutate: clearBattleAnim,
  display: [],
  route: routePostBattleToBuild,
};
/** `enter-upgrade-pick` — UPGRADE_PICK entry. Flips the phase,
 *  shows the "Choose Upgrade" banner, then runs the picker modal in
 *  `postDisplay`. Dispatched from `battle-done` / `ceasefire`
 *  postDisplay only when `state.modern?.pendingUpgradeOffers` is
 *  populated (modern mode, offers generated in `prepareNextRound`).
 *
 *  The picker modal sits over the same clipping rect as the banner;
 *  resolving all picks dispatches `enter-wall-build`. */
const ENTER_UPGRADE_PICK: Transition = {
  id: "enter-upgrade-pick",
  from: [Phase.BATTLE, Phase.CANNON_PLACE],
  mutate: (ctx) => {
    enterUpgradePickPhase(ctx.state);
    ctx.upgradePick?.prepare();
    return EMPTY_TRANSITION_RESULT;
  },
  display: [
    {
      bannerKind: "upgrade-pick",
      text: BANNER_UPGRADE_PICK,
      subtitle: BANNER_UPGRADE_PICK_SUB,
    },
  ],
  postDisplay: runPickerModalThenDispatch,
};
/** `enter-wall-build` — WALL_BUILD entry. Flips the phase, seeds the
 *  local build controllers, and shows the "Build & Repair" banner.
 *  Dispatched from `battle-done` / `ceasefire` prep (when no upgrade
 *  offers), or from `runPickerModalThenDispatch`'s finish callback after
 *  all players have resolved their picks (the upgrade-pick subsystem
 *  tears down its own dialog state before handing the resolution back,
 *  and the picks are applied before this transition dispatches).
 *
 *  `startBuildPhaseLocal` / `initLocalBuildControllerIfActive` run in
 *  `mutate` so they populate each controller's `currentBuildPhantoms`
 *  (via `startBuildPhase`) before the B-snapshot is captured. The
 *  snapshot is taken between `mutate` and the banner's display step, so
 *  the controllers must be seeded first — otherwise the "new scene"
 *  slice of the banner sweep shows no piece previews and they pop in
 *  at banner end.
 *
 *  postDisplay flips to Mode.GAME — identical on every peer (behavioral
 *  gate for input/tick dispatch — not visible state, so not needed
 *  before the B-snapshot). The phase timer is anchored in `mutate` via
 *  `enterWallBuildPhase`, not here. */
const ENTER_WALL_BUILD: Transition = {
  id: "enter-wall-build",
  from: [Phase.BATTLE, Phase.CANNON_PLACE, Phase.UPGRADE_PICK],
  mutate: (ctx) => {
    // Phase flip + entry-time timer anchor (timer must reflect THIS round's
    // upgrade set — see `enterWallBuildPhase` JSDoc for the parity story).
    enterWallBuildPhase(ctx.state);
    // Per-controller startBuildPhase + clearImpacts + accumulator resets.
    // Same on every peer.
    ctx.startBuildPhaseLocal();
    return EMPTY_TRANSITION_RESULT;
  },
  display: [
    {
      bannerKind: "build",
      text: BANNER_BUILD,
      subtitle: BANNER_BUILD_SUB,
    },
  ],
  postDisplay: (ctx) => {
    ctx.setMode(Mode.GAME);
  },
};
/** `enter-cannon-place` — CANNON_PLACE entry. Flips the phase via
 *  `enterCannonPhase` (cannon limits + facings) and shows the "Place
 *  Cannons" banner. Dispatched inline from `castle-done` or
 *  `advance-to-cannon` prep — the same shared-entry shape as
 *  `enter-battle` with its two predecessors. postDisplay initializes
 *  local cannon controllers (placeCannons + cursor + startCannonPhase)
 *  and flips to Mode.GAME. */
const ENTER_CANNON_PLACE: Transition = {
  id: "enter-cannon-place",
  // From `castle-done` (CASTLE_SELECT) or `advance-to-cannon` (ROUND_END —
  // the round-close continue path).
  from: [Phase.CASTLE_SELECT, Phase.ROUND_END],
  mutate: (ctx) => {
    enterCannonPhase(ctx.state);
    return EMPTY_TRANSITION_RESULT;
  },
  display: [
    {
      bannerKind: "cannon-place",
      text: BANNER_PLACE_CANNONS,
      subtitle: BANNER_PLACE_CANNONS_SUB,
    },
  ],
  postDisplay: (ctx) => {
    ctx.initLocalCannonControllers();
    ctx.setMode(Mode.GAME);
    // Fire-and-forget: the renderer's program cache makes repeat calls
    // ~free, so we don't need an explicit once-per-session guard. By the
    // time the camera tilts in to BATTLE the GPU has linked the shadow
    // permutation, so the BATTLE-entry frame doesn't pay for it.
    void ctx.warmShadowPermutations?.();
  },
};
/** `castle-done` — CASTLE_SELECT prep transition.
 *
 *  Fires at the end of every castle-build cycle: round 1's initial selection
 *  and any mid-game reselection after a life loss. Body order:
 *    1. `finalizeRoundCleanup` (round > 1 only) — Phase B cleanup deferred
 *       from the prior round-end, lands here so the wall + grunt sweeps
 *       reveal under the cannons banner instead of popping during the score
 *       overlay. Round 1 has no prior round-end to defer from.
 *    2. `finalizeFreshCastles` — snapshots new castle walls for fresh-castle
 *       players (drives off `player.inGracePeriod`, set at confirm-time).
 *    3. `finalizeCastleConstruction` — claims territory + spawns houses /
 *       bonus squares.
 *
 *  Does NOT flip the phase and shows no banner — `postDisplay` routes
 *  inline to `enter-cannon-place`, which owns the phase entry + banner.
 *
 *  Host broadcasts CANNON_START, a payload-less phase-advance marker.
 *  Watchers run the same body locally — derived state matches byte-for-byte
 *  from synced state + RNG so no wire payload is needed. */
const CASTLE_DONE: Transition = {
  id: "castle-done",
  from: Phase.CASTLE_SELECT,
  mutate: (ctx) => {
    // Phase B cleanup is deferred from the prior round's `round-end`; round 1
    // has no prior round to clean up. The gate is cleanup-deferral, not
    // initial-vs-reselect cycle type — both cycles run the rest unconditionally.
    if (ctx.state.round > 1) finalizeRoundCleanup(ctx.state);
    finalizeFreshCastles(ctx.state);
    finalizeCastleConstruction(ctx.state);
    ctx.broadcast?.cannonStart?.();
    return EMPTY_TRANSITION_RESULT;
  },
  postMutate: clearBattleAnim,
  display: [],
  route: () => "enter-cannon-place",
};
/** `advance-to-cannon` — ROUND_END exit prep transition, after the
 *  life-lost dialog resolves with "continue" (no reselect, no game over).
 *
 *  Unlike `castle-done`, this path has no fresh-castle prefix: there's no
 *  new castle to finalize and `finalizeRound` already ran inside the
 *  preceding `enter-round-end` transition. The mutate runs
 *  `finalizeRoundCleanup` (Phase B sweeps) under the cannons banner reveal
 *  and broadcasts; `postDisplay` routes inline to `enter-cannon-place`.
 *
 *  Triggered from `exitRoundEnd`'s `onAdvance` callback (phase-ticks). */
const ADVANCE_TO_CANNON: Transition = {
  id: "advance-to-cannon",
  // Dispatched from `exitRoundEnd`'s `onAdvance` while the phase is still
  // ROUND_END (the advance + ROUND_START already ran; the phase flip to
  // CANNON_PLACE is owned by the routed `enter-cannon-place`).
  from: Phase.ROUND_END,
  mutate: (ctx) => {
    finalizeRoundCleanup(ctx.state);
    ctx.broadcast?.cannonStart?.();
    return EMPTY_TRANSITION_RESULT;
  },
  postMutate: clearBattleAnim,
  display: [],
  route: () => "enter-cannon-place",
};
/** `game-over` — the match ended; `GameOverOutcome.reason` says why
 *  (`round-limit-reached` or `last-player-standing`). The winner is
 *  whoever has the highest score among alive players. Dispatched on
 *  every peer's local tick; the host additionally broadcasts GAME_OVER,
 *  which non-host peers consume in `handleGameOverTransition` to paint
 *  the authoritative score frame (idempotent with the locally-detected
 *  game-over). */
const GAME_OVER: Transition = {
  id: "game-over",
  from: "*",
  mutate: (ctx) => {
    const outcome = ctx.gameOverOutcome;
    if (!outcome) {
      throw new Error("game-over dispatched without ctx.gameOverOutcome");
    }
    ctx.log(`game over: ${outcome.reason} (winner P${outcome.winner.id})`);
    ctx.endGame(outcome.winner);
    return EMPTY_TRANSITION_RESULT;
  },
  display: [],
};
/** `cannon-place-done` — CANNON_PLACE prep transition. Runs engine
 *  battle setup (`prepareBattle`: modifier roll, balloon resolution,
 *  post-modifier territory/wall snapshots) on every peer; the host
 *  additionally broadcasts BATTLE_START as a sync marker. Does NOT flip
 *  the phase and shows no banner — `postDisplay` routes to
 *  `enter-modifier-reveal` (when a modifier was rolled) or straight to
 *  `enter-battle`, each of which delegates the phase entry to game/.
 *
 *  RNG parity is load-bearing: every peer's `prepareBattle` consumes
 *  `state.rng` in lockstep (modifier roll, balloon perturbation). The
 *  BATTLE_START wire message is a payload-less phase marker — non-host
 *  peers ignore it, having already advanced via their local tick. */
const CANNON_PLACE_DONE: Transition = {
  id: "cannon-place-done",
  from: Phase.CANNON_PLACE,
  mutate: (ctx) => {
    ctx.log(`startBattle (round=${ctx.state.round})`);
    const entry = prepareBattle(ctx.state);
    const modifierId = ctx.state.modern?.activeModifier;
    if (modifierId) {
      ctx.log(
        `modifier applied: ${modifierDef(modifierId).label} (${modifierId})`,
      );
    }
    ctx.broadcast?.battleStart?.();
    return { modifierDiff: entry.modifierDiff, flights: entry.flights };
  },
  postMutate: syncBattleAnim,
  display: [],
  route: routeCannonPlaceDone,
};
/** `enter-modifier-reveal` — MODIFIER_REVEAL entry. Delegates the phase
 *  flip + dwell-timer prime to `enterModifierRevealPhase` so the phase
 *  behaves like every other timed phase, and shows the modifier-reveal
 *  banner. `tickModifierRevealPhase` counts `state.timer` down and
 *  dispatches `enter-battle` when it reaches 0 — the same pattern as
 *  `tickCannonPhase` → `cannon-place-done`. The banner is hidden by
 *  `runDisplay`'s end-of-sequence `hideBanner()` before `postDisplay`
 *  runs; the 2s MODIFIER_REVEAL dwell that follows shows the modifier
 *  tile pulse over the static post-reveal scene (no banner).
 *
 *  Only dispatched when `cannon-place-done`'s result carries a
 *  `modifierDiff` (modern mode, modifier actually rolled this round).
 *  The result is threaded through `syncBattleAnim` by the caller but
 *  doesn't need re-running here — the battle-anim snapshots are still
 *  valid for the modifier banner. */
const ENTER_MODIFIER_REVEAL: Transition = {
  id: "enter-modifier-reveal",
  from: Phase.CANNON_PLACE,
  mutate: (ctx) => {
    enterModifierRevealPhase(ctx.state);
    return EMPTY_TRANSITION_RESULT;
  },
  display: [
    {
      bannerKind: "modifier-reveal",
      // `activeModifier` is set by `prepareBattleState` during the prior
      // `cannon-place-done` mutate, so it's populated identically on
      // every peer by the time this banner displays.
      text: (state) => modifierDef(state.modern!.activeModifier!).label,
      // The modifier id becomes an opaque palette key the renderer
      // looks up — the banner system itself never sees `ModifierDiff`.
      paletteKey: (state) => state.modern?.activeModifier ?? undefined,
    },
  ],
  postDisplay: (ctx) => {
    // After flipping to Mode.GAME, `tickModifierRevealPhase` counts the
    // dt-based `state.timer` down and dispatches `enter-battle` when it
    // hits 0. Same on every peer — no network message exchanged for the
    // edge.
    ctx.setMode(Mode.GAME);
  },
};
/** `enter-battle` — BATTLE entry. Flips the phase and shows the
 *  "Prepare for Battle" banner. Dispatched from `cannon-place-done`
 *  prep (classic / modern-no-modifier) or from `enter-modifier-reveal`
 *  after its banner finishes. postDisplay runs `proceedToBattleFromCtx`
 *  (balloon-anim start or direct battle begin). */
const ENTER_BATTLE: Transition = {
  id: "enter-battle",
  from: [Phase.CANNON_PLACE, Phase.MODIFIER_REVEAL],
  mutate: (ctx) => {
    enterBattlePhase(ctx.state);
    return EMPTY_TRANSITION_RESULT;
  },
  // syncBattleAnim already ran inside `cannon-place-done`'s postMutate
  // — the battle-anim snapshots are still valid here. Re-running is
  // idempotent but unnecessary.
  display: [
    {
      bannerKind: "battle",
      text: BANNER_BATTLE,
      subtitle: BANNER_BATTLE_SUB,
    },
  ],
  postDisplay: proceedToBattleFromCtx,
};
const TRANSITIONS: readonly Transition[] = [
  CANNON_PLACE_DONE,
  ENTER_MODIFIER_REVEAL,
  ENTER_BATTLE,
  ENTER_ROUND_END,
  BATTLE_DONE,
  CEASEFIRE,
  ENTER_UPGRADE_PICK,
  ENTER_WALL_BUILD,
  CASTLE_DONE,
  ADVANCE_TO_CANNON,
  ENTER_CANNON_PLACE,
  GAME_OVER,
];
/** Fast lookup from id → entry. Rebuilt once at module load. */
const BY_ID: ReadonlyMap<TransitionId, Transition> = new Map(
  TRANSITIONS.map((transition) => [transition.id, transition] as const),
);

/** Execute a transition.
 *
 *  Runner contract:
 *
 *   1. **Mutate** — runs the transition's mutation. Same fn on every peer;
 *      role differences live in optional `ctx` fields the mutate dereferences.
 *
 *   2. **postMutate** — shared post-mutation sync (battleAnim rebuilds,
 *      impact clears). Runs once, before any display step.
 *
 *   3. **Display** — walks `display` steps in order.
 *
 *   4. **postDisplay** — side-effects after all display steps (setMode,
 *      startBuildPhase, beginBattle, etc.).
 *
 *   5. **route** — prep transitions name their entry transition here; the
 *      runner dispatches it inline (no re-prime), chaining prep → entry on
 *      the one dispatch tick. Entry transitions declare no `route` and end
 *      the chain.
 *
 *  Callback-based, not Promise-based: the tick loop is synchronous so
 *  microtasks don't flush between ticks; every wait threads through the
 *  subsystem's own callback.
 *
 *  LOCKSTEP INVARIANT: the mutate runs synchronously at the dispatch
 *  tick. Dispatch is sim-driven (phase timers / drained actions), so
 *  every peer mutates at the same `simTick` and the scheduled-action
 *  drain interleaves identically everywhere. Deferring the mutate behind
 *  anything per-peer (rendered-frame camera convergence was the historic
 *  bug) lets in-flight `applyAt` actions land pre-mutate on one peer and
 *  post-mutate on another, and offsets the next phase's entry tick —
 *  both diverge game state across peers (see
 *  test/camera-zoom-parity.test.ts). */
export function runTransition(id: TransitionId, ctx: PhaseTransitionCtx): void {
  const transition = resolveTransition(id, ctx);

  // Mode.TRANSITION held for the entire transition; postDisplay flips to
  // the terminal mode.
  ctx.setMode(Mode.TRANSITION);

  // Banner prev-scene: rendered offscreen at fullMapVp from the
  // pre-mutation state, NOW, so the mutate doesn't have to wait for the
  // displayed camera. The displayed viewport then hard-cuts to fullmap —
  // a per-peer cosmetic snap that keeps the banner strip's uniform
  // map→display scale assumption true (see render-map.ts) from the
  // first sweep frame.
  ctx.primeBannerPrevScene();
  ctx.snapCameraToFullMap();

  executeTransition(transition, ctx);
}

/** Post-cannon-place prep route: `enter-modifier-reveal` when a modifier
 *  was rolled (modern mode), otherwise straight to `enter-battle`. Shared
 *  between host and watcher — every peer reads `result.modifierDiff` from
 *  its own mutate (clone-everywhere; the prepareBattle roll ran identically
 *  off synced rng). The runner dispatches the returned id inline. */
function routeCannonPlaceDone(
  _ctx: PhaseTransitionCtx,
  result: TransitionResult,
): TransitionId {
  return result.modifierDiff ? "enter-modifier-reveal" : "enter-battle";
}

/** Post-battle / ceasefire prep route: the prep doesn't flip the phase —
 *  the returned `enter-upgrade-pick` / `enter-wall-build` entry transition
 *  owns the phase entry. Branches on whether modern-mode upgrade offers
 *  were generated (in `prepareNextRound`). */
function routePostBattleToBuild(ctx: PhaseTransitionCtx): TransitionId {
  return ctx.state.modern?.pendingUpgradeOffers
    ? "enter-upgrade-pick"
    : "enter-wall-build";
}

/** Shared post-mutation sync for battle ENTRY (cannon-place-done): clear
 *  transient battle-anim visuals and rebuild the per-player territory /
 *  wall snapshots from the freshly-mutated state. Host and watcher arrive
 *  at the same post-state through different routes, so this step is
 *  identical for both and lives in `postMutate`.
 *
 *  Stashes balloon flights onto `battleAnim.flights` here (via
 *  `battle.setFlights`) so the downstream `enter-battle` postDisplay
 *  (`proceedToBattleFromCtx`) can read them out of runtime state — the
 *  cannon-place-done prep owns computing them; the entry transition
 *  owns consuming them. */
function syncBattleAnim(
  ctx: PhaseTransitionCtx,
  result: TransitionResult,
): void {
  clearBattleAnim(ctx);
  ctx.battle.setTerritory(snapshotTerritory(ctx.state.players));
  ctx.battle.setWalls(snapshotAllWalls(ctx.state));
  ctx.battle.setFlights(
    result.flights.map((flight) => ({ flight, progress: 0 })),
  );
}

/** Shared post-mutation sync for EXITING a battle (battle-done, ceasefire)
 *  or entering the cannon phase after a completed battle / build cycle
 *  (castle-done, advance-to-cannon): clear
 *  any lingering battle-anim visuals (impact flashes + thaw flashes) so
 *  the next phase renders against a clean slate. Every battleAnim reset
 *  in the phase machine goes through this hook so the authoritative clear
 *  is always machine-level (not buried in a checkpoint-apply fn). */
function clearBattleAnim(ctx: PhaseTransitionCtx): void {
  ctx.battle.clearImpacts();
}

function proceedToBattleFromCtx(ctx: PhaseTransitionCtx): void {
  // Spec: `battle banner → tilt → balloons (skip if none) → ready → zoom`.
  // Tilt begins here (at battle-banner end) so it plays UNZOOMED, before
  // anything else. The phase machine snapped to fullMapVp at dispatch
  // (`snapCameraToFullMap`), and `handlePhaseChangeZoom` no longer implicitly
  // engages the tilt / auto-zoom — auto-zoom re-engages when mode flips
  // back to GAME inside `battle.begin`, which also starts the "ready"
  // countdown, so the zoom lerp and "ready" cue start together.
  ctx.beginTilt();

  // Flights were stashed into runtimeState.battleAnim.flights by
  // `cannon-place-done`'s `syncBattleAnim` postMutate. We only read the
  // count here to decide what `proceed` does — the BALLOON_ANIM flip is
  // deferred into `proceed` (below) so balloons don't render or accrue
  // progress UNTIL the tilt settles. Flipping early let them animate
  // through the tilt, ahead of the BALLOON_ANIM_START cue.
  const hasFlights = ctx.runtimeState.battleAnim.flights.length > 0;

  const proceed = (): void => {
    if (hasFlights) {
      ctx.setMode(Mode.BALLOON_ANIM);
      emitGameEvent(ctx.state.bus, GAME_EVENT.BALLOON_ANIM_START, {
        round: ctx.state.round,
      });
    } else {
      ctx.battle.begin();
    }
  };

  // Pitch gate: wait for the tilt we just requested (or any prior tilt
  // still in progress) to settle before we start balloons (flip mode +
  // emit) or, with no flights, flip to battle mode. `awaitPitchSettled`
  // fires `proceed` synchronously if pitch is already settled (or
  // headless without a camera), so this single call covers both the
  // mid-animation and already-done cases. Closure-stored callback (not
  // Promise) — runtime ticks synchronously this frame on settle and a
  // microtask hop would break mock-clock determinism.
  ctx.awaitPitchSettled(proceed);
}

/** `enter-upgrade-pick`'s postDisplay (both roles): prepare + show the
 *  picker modal. When all players have resolved their picks (or
 *  auto-skipped) the subsystem hands the resolved dialog back via the
 *  `onResolved` callback. The callback applies the picks against the
 *  snapshot, emits UPGRADE_PICK_END, then dispatches `enter-wall-build`
 *  to continue the flow. `prepare()` is idempotent — the dialog was
 *  already generated by `prepareNextRound`; `prepare()` just surfaces it.
 *
 *  Mirrors `runLifeLostDialogStep`: the dialog subsystem produces
 *  resolutions, the phase machine applies them. */
function runPickerModalThenDispatch(ctx: PhaseTransitionCtx): void {
  const picker = ctx.upgradePick;
  if (!picker || !picker.prepare()) {
    // No picker wired (shouldn't happen since this transition is only
    // dispatched when offers exist), or prepare failed — fall through
    // as if picks were already resolved.
    finishUpgradePick(ctx);
    return;
  }
  emitGameEvent(ctx.state.bus, GAME_EVENT.UPGRADE_PICK_SHOW, {
    round: ctx.state.round,
  });
  // Flip to Mode.UPGRADE_PICK and let the self-driving `tickUpgradePickPhase`
  // poll the dialog to resolution and dispatch the exit. No armed callback:
  // the exit is re-derived from state every tick, so a host-promoted peer
  // adopting mid-phase resumes without a repair hatch.
  if (!picker.show()) finishUpgradePick(ctx);
}

/** Single exit funnel of the UPGRADE_PICK phase: apply the resolved picks
 *  (read from the live dialog), tear it down, emit UPGRADE_PICK_END, and
 *  dispatch `enter-wall-build`. Called by the self-driving phase tick when
 *  `isReadyToExit()` flips, and by the no-offers fall-through above. */
export function finishUpgradePick(ctx: PhaseTransitionCtx): void {
  const resolved = ctx.upgradePick?.get() ?? null;
  if (resolved) {
    applyUpgradePicks(ctx.state, resolved);
    recheckTerritory(ctx.state);
    // Tear the dialog down at the single exit funnel — the build banner's
    // A-snapshot freezes the last-painted picker frame, so the cross-fade
    // to the build scene doesn't depend on dialog state surviving here.
    ctx.upgradePick?.set(null);
  }
  // Consume the offers: this is the single exit funnel for UPGRADE_PICK
  // (the picker modal's resolution AND the promotion force-resolve), so
  // the clear is lockstep on every peer. Left in place, last round's
  // offers ride every later BUILD_START checkpoint / FULL_STATE snapshot
  // and would re-arm the pick dialog from stale data if anything
  // re-entered the phase (createUpgradePickDialog keys on this field
  // being non-null).
  if (ctx.state.modern) ctx.state.modern.pendingUpgradeOffers = null;
  emitGameEvent(ctx.state.bus, GAME_EVENT.UPGRADE_PICK_END, {
    round: ctx.state.round,
  });
  runTransitionInline("enter-wall-build", ctx);
}

/** Run a transition without re-priming the banner prev-scene or
 *  re-snapping the camera. Used for two cases, both already inside a
 *  `Mode.TRANSITION` window the outer `runTransition` opened (primed +
 *  snapped): the runner's own `route` chaining (prep → entry, same tick),
 *  and `finishUpgradePick` resuming the flow into `enter-wall-build` after
 *  the self-driving picker resolves. Either way the chain's first banner
 *  consumes the outer prime; a later banner's prev-scene is the previous
 *  banner's new-scene (display pixels), exactly as `showBanner` falls
 *  back to. */
function runTransitionInline(id: TransitionId, ctx: PhaseTransitionCtx): void {
  const transition = resolveTransition(id, ctx);
  ctx.setMode(Mode.TRANSITION);
  executeTransition(transition, ctx);
}

function resolveTransition(
  id: TransitionId,
  ctx: PhaseTransitionCtx,
): Transition {
  const transition = BY_ID.get(id);
  if (!transition) {
    throw new Error(`runTransition: unknown transition id "${id}"`);
  }

  // Source-phase guard: every peer dispatches transitions from its own
  // local tick, so the source phase is always known. Bypass for `*`
  // (the game-over transition may fire from any phase).
  if (transition.from !== "*") {
    const currentPhase = ctx.state.phase;
    const allowed = Array.isArray(transition.from)
      ? transition.from.includes(currentPhase)
      : currentPhase === transition.from;
    if (!allowed) {
      throw new Error(
        `runTransition: transition "${id}" expects phase "${String(
          transition.from,
        )}" but state is in "${currentPhase}"`,
      );
    }
  }

  return transition;
}

function executeTransition(
  transition: Transition,
  ctx: PhaseTransitionCtx,
): void {
  // `showBanner` owns the A/B capture per banner (see
  // `subsystems/banner.ts`). The chain's FIRST banner consumes the
  // pre-mutation prev-scene primed by `runTransition`; later banners
  // read the current display pixels (the previous banner's swept end
  // state) as their prev-scene (A). Every banner renders the current
  // (post-mutation) state offscreen as its new-scene (B).
  const result = transition.mutate(ctx);
  transition.postMutate?.(ctx, result);

  runDisplay(transition.display, ctx, result, () => {
    transition.postDisplay?.(ctx, result);
    // Prep transitions chain to their entry transition here, inline on the
    // same dispatch tick. A prep's `display` is empty, so this runs
    // synchronously; entry transitions declare no `route` and end the
    // chain. The whole chain stays in the one `Mode.TRANSITION` window.
    const nextId = transition.route?.(ctx, result);
    if (nextId) runTransitionInline(nextId, ctx);
  });
}

/** Walk the display steps in order, calling `onDone` after the last step
 *  completes. Each step registers `onDone` with its subsystem callback.
 *  Banner / upgrade-pick steps hand the capture decision to the banner
 *  system — it captures both the prev-scene and new-scene inside
 *  `showBanner`, once per banner.
 *
 *  End-of-sequence hide: a `swept` banner sits on screen until explicitly
 *  hidden, so we hide before handing control to postDisplay. Also emits
 *  the BANNER_HIDDEN beat that closes every banner display sequence. */
function runDisplay(
  steps: readonly DisplayStep[],
  ctx: PhaseTransitionCtx,
  result: TransitionResult,
  onDone: () => void,
): void {
  if (steps.length === 0) {
    ctx.hideBanner();
    onDone();
    return;
  }
  const [first, ...rest] = steps;
  runStep(first!, ctx, result, () => runDisplay(rest, ctx, result, onDone));
}

/** Run a banner display step. The only display-step kind — the round-end
 *  score-overlay + life-lost dialog beats are no longer display steps;
 *  they're driven by the self-driving `tickRoundEndPhase`. */
function runStep(
  step: DisplayStep,
  ctx: PhaseTransitionCtx,
  _result: TransitionResult,
  onDone: () => void,
): void {
  const text =
    typeof step.text === "function" ? step.text(ctx.state) : step.text;
  ctx.showBanner({
    text,
    kind: step.bannerKind,
    onDone,
    subtitle: step.subtitle,
    paletteKey: step.paletteKey?.(ctx.state),
  });
}
