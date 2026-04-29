/**
 * Phase transition state machine.
 *
 * Every phase transition (CASTLE_SELECT → CANNON_PLACE, WALL_BUILD →
 * CANNON_PLACE, CANNON_PLACE → BATTLE, BATTLE → WALL_BUILD, reselect, game
 * over) is an entry in `TRANSITIONS`. Each entry declares:
 *
 *   - `from`: source phase guard, asserted on every peer because every
 *     peer dispatches the transition from its own local tick. `"*"` opts
 *     out (game-over transitions may fire from any phase). Per-transition
 *     target phase lives in the docstring, not in a field, because several
 *     transitions don't setPhase themselves (`round-end` stays in
 *     WALL_BUILD; the continuation flips it).
 *   - `mutate`: a single function run on every peer. Game-state mutation
 *     is identical across peers; the only role-gated effect is wire
 *     emission, expressed via `ctx.broadcast?.X?.()` — non-null only on
 *     the host (the peer that emits to the wire). Every other ctx field
 *     is uniform across peers.
 *   - `postMutate` (optional): shared sync that runs synchronously after
 *     `mutate` returns and BEFORE the first display step (e.g. rebuilding
 *     `battleAnim` snapshots from the freshly-mutated state).
 *   - `display`: ordered UI steps that play between mutation and the
 *     terminal frame (banner / score-overlay / life-lost-dialog /
 *     upgrade-pick).
 *   - `postDisplay` (optional): side-effects that complete the transition
 *     after the display steps (e.g. balloon-anim vs begin-battle). Same
 *     uniform-across-peers shape as `mutate`.
 *
 * `runTransition(id, ctx)` executes the entry: runs `mutate`, runs
 * `postMutate`, walks the display steps in order, then runs `postDisplay`.
 *
 * The bus is NOT used as control flow. Bus events (PHASE_START/END,
 * BANNER_START/END, SCORE_OVERLAY_START/END) remain pure observations
 * emitted from inside the mutate / display handlers.
 */

import type { GameOverReason } from "../game/index.ts";
import {
  applyUpgradePicks,
  buildTimerBonus,
  enterBattlePhase,
  enterCannonPhase,
  finalizeBattle,
  finalizeCastleConstruction,
  finalizeReselectedPlayers,
  finalizeRound,
  finalizeRoundVisuals,
  prepareNextRound,
  recheckTerritory,
  snapshotTerritory,
  startNextRound,
} from "../game/index.ts";
import { setPhase } from "../game/phase-setup.ts";
import type { BalloonFlight } from "../shared/core/battle-types.ts";
import { snapshotAllWalls } from "../shared/core/board-occupancy.ts";
import {
  MODIFIER_REVEAL_TIMER,
  type ModifierDiff,
} from "../shared/core/game-constants.ts";
import {
  type BannerKind,
  emitGameEvent,
  GAME_EVENT,
} from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import { modifierDef } from "../shared/core/modifier-defs.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type { GameState } from "../shared/core/types.ts";
import type { UpgradePickDialogState } from "../shared/ui/interaction-types.ts";
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
import type { BannerShow, TimingApi } from "./runtime-contracts.ts";
import { resolveAfterLifeLost } from "./runtime-life-lost-core.ts";
import type { RuntimeState } from "./runtime-state.ts";

type TransitionId =
  | "castle-select-done"
  | "castle-reselect-done"
  | "advance-to-cannon"
  | "round-end"
  | "cannon-place-done"
  | "enter-modifier-reveal"
  | "enter-battle"
  | "battle-done"
  | "ceasefire"
  | "enter-upgrade-pick"
  | "upgrade-pick-done"
  | "enter-wall-build"
  | "round-limit-reached"
  | "last-player-standing";

/** Opaque result produced by a transition's mutate fn, threaded through the
 *  display steps. `modifierDiff` and `flights` are always present — use
 *  `EMPTY_TRANSITION_RESULT` or spread it for transitions that don't touch
 *  the battle-entry fields. */
interface TransitionResult {
  readonly modifierDiff: ModifierDiff | null;
  readonly flights: readonly BalloonFlight[];
  readonly needsReselect?: readonly ValidPlayerSlot[];
  readonly eliminated?: readonly ValidPlayerSlot[];
  readonly preScores?: readonly number[];
  /** Populated by the `life-lost-dialog` display step once the dialog
   *  resolves (or immediately, for the all-pre-resolved path). Read by
   *  `ROUND_END`'s postDisplay to route via `resolveAfterLifeLost`.
   *  Mutable because it's written AFTER the mutate fn returns. */
  continuing?: readonly ValidPlayerSlot[];
}

type DisplayStep =
  | {
      readonly kind: "banner";
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
    }
  | { readonly kind: "score-overlay" }
  | { readonly kind: "life-lost-dialog" };

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

interface Transition {
  readonly id: TransitionId;
  /** Source phase asserted on every peer's dispatch. A single `Phase`
   *  accepts only that phase; a readonly array accepts any of the
   *  listed phases (used by entry transitions like `enter-battle` that
   *  may be dispatched from either CANNON_PLACE directly or from
   *  MODIFIER_REVEAL after the modifier banner). `"*"` opts out of the
   *  guard entirely (game-over transitions may fire from any phase). */
  readonly from: Phase | readonly Phase[] | "*";
  readonly mutate: MutateFn;
  /** Shared post-mutation sync. Runs after mutate, before display. */
  readonly postMutate?: PostMutateFn;
  readonly display: readonly DisplayStep[];
  readonly postDisplay?: PostDisplayFn;
}

/** Minimal battle-lifecycle hooks the machine needs to drive the post-
 *  battle-banner step (balloon anim or beginBattle). */
export interface BattleLifecycle {
  readonly setFlights: (
    flights: { flight: BalloonFlight; progress: number }[],
  ) => void;
  readonly setTerritory: (territory: readonly Set<number>[]) => void;
  readonly setWalls: (walls: readonly Set<number>[]) => void;
  readonly clearImpacts: () => void;
  readonly begin: () => void;
}

/** Context passed to every transition step. Same shape on every peer —
 *  role differences (host has wire `broadcast`, watcher doesn't) are
 *  encoded via optional fields populated only where they apply. */
export interface PhaseTransitionCtx {
  readonly state: GameState;
  readonly runtimeState: RuntimeState;
  /** Injected timing primitives. Transition display steps that schedule
   *  fallback timers (e.g. `proceedToBattle`'s pitch-settle watchdog) MUST
   *  route through here so headless tests on the mock clock observe the
   *  same timing as production. */
  readonly timing: TimingApi;

  readonly showBanner: BannerShow;
  /** Hide whatever banner is currently on screen. The display runner
   *  calls this between non-banner steps (so a held `swept` banner
   *  doesn't sit over a dialog) and at the end of the display sequence
   *  (so postDisplay hooks run against a clean screen). Banner steps
   *  never need this — `showBanner` overwrites cleanly. */
  readonly hideBanner: () => void;
  /** Park a post-convergence callback. `runTransition` sets
   *  `Mode.TRANSITION` (which drives `shouldUnzoom` true) then calls
   *  this; the callback fires on the first fullMapVp + flat-pitch frame
   *  so every mutate + display step runs against a full-map viewport.
   *  See `CameraSystem.onCameraReady`. */
  readonly onCameraReady: (onReady: () => void) => void;
  readonly setMode: (m: Mode) => void;
  readonly log: (msg: string) => void;

  readonly scoreDelta: {
    readonly capturePreScores?: () => void;
    readonly setPreScores?: (scores: readonly number[]) => void;
    readonly show: (onDone: () => void) => void;
    readonly reset: () => void;
    readonly isActive: () => boolean;
  };

  /** Life-lost dialog hooks. Only required for transitions whose `display`
   *  array contains a `life-lost-dialog` step (round-end). Other
   *  transitions may omit.
   *
   *  `show` drives the dialog to completion. It either resolves
   *  immediately (no entries needed input) or shows the modal and
   *  ticks it to resolution. Either way, `onResolved(continuing)` fires
   *  once with the list of players who chose CONTINUE. The step sets
   *  `result.continuing` from this list; `ROUND_END`'s postDisplay
   *  reads it and routes via `resolveAfterLifeLost` + `ctx.lifeLostRoute`. */
  readonly lifeLost?: {
    readonly show: (
      needsReselect: readonly ValidPlayerSlot[],
      eliminated: readonly ValidPlayerSlot[],
      onResolved: (continuing: readonly ValidPlayerSlot[]) => void,
    ) => boolean;
  };
  /** Post-life-lost dispatch bundle. `ROUND_END`'s postDisplay runs
   *  `resolveAfterLifeLost` with these three handlers — wired identically
   *  on every peer (each handler dispatches the next transition or seeds
   *  the reselect queue). Optional so transitions that don't include a
   *  life-lost-dialog step can omit. */
  readonly lifeLostRoute?: {
    readonly onGameOver: (
      winner: { id: number },
      reason: GameOverReason,
    ) => void;
    readonly onReselect: (continuing: readonly ValidPlayerSlot[]) => void;
    readonly onContinue: () => void;
  };
  /** Notify a local controller that its player lost a life. Called per
   *  affected player after the score overlay, before the dialog shows. */
  readonly notifyLifeLost?: (pid: ValidPlayerSlot) => void;
  /** Finalize local controllers' build-phase bag state. Used by
   *  `round-end` host mutate (remote humans are skipped — their
   *  controllers re-init via startBuildPhase at next round). */
  readonly finalizeLocalControllersBuildPhase?: () => void;
  /** End-of-battle loop: per local controller, clear fire targets and reset
   *  battle state. Used by `battle-done` host mutate. */
  readonly endBattleLocalControllers?: () => void;
  /** Save the human player's crosshair position so it can be restored at
   *  the start of the next battle (touch UX). Host-only, no-op otherwise. */
  readonly saveBattleCrosshair?: () => void;
  /** Camera pitch state machine — used by `proceedToBattle` to hold the
   *  balloon-anim start until the build→battle tilt completes (otherwise
   *  the drops play under a still-flattening camera). `"flat"` /
   *  `"tilted"` are both "don't wait" (2D mode also reports `"flat"`);
   *  only `"tilting"` / `"untilting"` block. Optional so headless
   *  contexts that don't own a camera can skip wiring it. */
  readonly getPitchState?: () => "flat" | "tilting" | "tilted" | "untilting";
  /** Start the build→battle tilt at battle-banner end. Called inside
   *  `proceedToBattle`. Optional so headless / watcher-without-camera
   *  contexts can skip it (2D wiring also skips — the renderer has no
   *  tilt axis). */
  readonly beginBattleTilt?: () => void;
  /** Re-engage the current phase's auto-zoom. Called from the
   *  life-lost-dialog step right before the popup is shown, so the
   *  spec'd `scores → zoom → life lost popup` sequence plays. */
  readonly engageAutoZoom?: () => void;
  /** Host-only per-frame setup when WALL_BUILD begins: score-delta reset,
   *  cannon facing reset, per-controller startBuildPhase, clear impacts,
   *  accumulator resets. Called from `battle-done` postDisplay, after the
   *  BUILD banner finishes sweeping. */
  readonly startBuildPhaseLocal?: () => void;
  /** Run `enterBuildSkippingBattle(state)` — the engine-level phase flip
   *  that the ceasefire path uses when no one can fight. Separate from
   *  `battle-done`'s `finalizeBattle` + `prepareNextRound` because it also decays burning
   *  pits, sweeps walls, rechecks territory, and clears active modifiers
   *  (things the real battle-end flow already handled). */
  readonly ceasefireSkipBattle?: () => void;
  readonly upgradePick?: {
    readonly prepare: () => boolean;
    readonly tryShow: (onDone: () => void) => boolean;
    /** Read the live dialog state — used by `runUpgradePickStep` to pass
     *  the picks into `applyUpgradePicks` once every player has resolved. */
    readonly getDialog: () => UpgradePickDialogState | null;
    readonly clear?: () => void;
  };

  readonly battle: BattleLifecycle;

  // ── Host-only hooks ──

  readonly broadcast?: {
    readonly cannonStart?: () => void;
    /** Phase-marker signal — watcher runs `enterBattlePhase` locally on
     *  receipt. No payload. */
    readonly battleStart?: () => void;
    /** Phase-marker signal — watcher runs `finalizeBattle` + `prepareNextRound`
     *  locally on receipt. No payload; both sides derive identical state. */
    readonly buildStart?: () => void;
    /** Phase-marker signal — watcher runs `finalizeRound` locally
     *  on receipt. No payload. */
    readonly buildEnd?: () => void;
  };

  // ── Castle-select / reselect hooks ──

  /** Clear the camera's castle-build viewport (zoom-out after castle
   *  construction). Host-only. */
  readonly clearCastleBuildViewport?: () => void;
  /** Per-local-controller cannon-phase init after `enterCannonPhase`:
   *  `placeCannons(state, maxSlots)` + `cannonCursor` + `startCannonPhase`.
   *  Host-only. The hook re-derives per-player prep from state via
   *  `prepareControllerCannonPhase` — `enterCannonPhase` has already
   *  populated `state.cannonLimits` / facings, so the work is idempotent
   *  and the entry struct doesn't need to thread through ctx. */
  readonly initLocalCannonControllers?: () => void;
  /** Players returned from the reselection queue. Used by
   *  `castle-reselect-done` mutate to call `finalizeReselectedPlayers`. */
  readonly reselectionPids?: readonly ValidPlayerSlot[];

  // ── Game-over hooks ──

  /** End-game side effects (set game-over frame, stop sound, switch to
   *  Mode.STOPPED, arm demo timer). Used by `round-limit-reached` /
   *  `last-player-standing` transitions. Host-only. */
  readonly endGame?: (winner: { id: number }) => void;
  /** Winner determined by the life-lost resolution. Threaded through via
   *  ctx so the mutate can pass it to `endGame`. */
  readonly winner?: { id: number };
}

/** Default "no battle-entry data" result. Every transition whose mutate
 *  doesn't produce a modifier roll or balloon flights returns this (or
 *  spreads it). Keeps `TransitionResult.modifierDiff` / `flights` strictly
 *  required at the type level — consumers no longer defensively coalesce. */
const EMPTY_TRANSITION_RESULT: TransitionResult = {
  modifierDiff: null,
  flights: [],
};
/** Discriminator values for `DisplayStep.kind` / `PhaseTransitionCtx.role`. */
const STEP_BANNER = "banner" as const;
const STEP_SCORE_OVERLAY = "score-overlay" as const;
const STEP_LIFE_LOST_DIALOG = "life-lost-dialog" as const;
/** `round-end` — end of WALL_BUILD (round closes here, after the score is finalized).
 *
 *  Mutate (every peer): finalizes local controllers' bag state, then runs
 *  the engine's `finalizeRound` (wall sweep + territory finalize + life
 *  penalties + grunt sweep). The host additionally broadcasts the BUILD_END
 *  checkpoint so non-host peers can use it as a sync marker.
 *
 *  Display: score-overlay animation → life-lost-dialog step. The dialog
 *  step writes `result.continuing` once resolved (or immediately, for
 *  the all-pre-resolved path) and hands control to postDisplay.
 *
 *  postDisplay: runs `resolveAfterLifeLost` with `ctx.lifeLostRoute`'s
 *  three handlers — every peer dispatches the next transition (game-over
 *  / reselect / continue) identically.
 *
 *  The `to` phase is nominally CANNON_PLACE but this transition itself
 *  does NOT call `setPhase`: the next transition (castle-reselect-done
 *  / advance-to-cannon / round-limit-reached / last-player-standing)
 *  flips it. */
const ROUND_END: Transition = {
  id: "round-end",
  from: Phase.WALL_BUILD,
  mutate: (ctx) => {
    ctx.finalizeLocalControllersBuildPhase?.();
    // Capture pre-scores BEFORE finalizeRound mutates them via
    // territory + life-penalty point awards — score-overlay needs the
    // starting values for the delta animation.
    const preScores = ctx.state.players.map((player) => player.score);
    // Phase A only: scoring + life penalties. The visual wall sweep +
    // dead-zone grunt sweep are deferred to `finalizeRoundVisuals`,
    // called from `advance-to-cannon` / `castle-reselect-done` /
    // game-over flows so the cannons banner reveals them.
    // `applyLifePenalties` inside finalizeRound already runs
    // `resetZoneState` for eliminated/reselect players — every peer
    // converges identically.
    const { needsReselect, eliminated } = finalizeRound(ctx.state);
    // Round counter advances here, after the score is finalized — this is
    // the moment the round officially ends. The score-delta animation that
    // plays next reads pre/post score values it captured, not state.round,
    // so it's safe to advance the counter before the animation begins.
    startNextRound(ctx.state);
    ctx.scoreDelta.setPreScores?.(preScores);
    ctx.broadcast?.buildEnd?.();
    return {
      ...EMPTY_TRANSITION_RESULT,
      needsReselect,
      eliminated,
      preScores,
    };
  },
  display: [{ kind: STEP_SCORE_OVERLAY }, { kind: STEP_LIFE_LOST_DIALOG }],
  postDisplay: routeLifeLostResolution,
};
/** `battle-done` — BATTLE prep transition. Runs engine post-battle
 *  housekeeping in two halves: `finalizeBattle` (combo bonuses, battle
 *  cleanup, freshCastle clear, lastModifierId snapshot, ROUND_END emit)
 *  followed by `prepareNextRound` (round increment, ROUND_START, grunt
 *  spawn, upgrade offer generation, piece bag init). Broadcasts BUILD_START.
 *  Does NOT flip the phase and shows no banner — `postDisplay` routes to
 *  `enter-upgrade-pick` (when offers were generated) or `enter-wall-build`,
 *  each of which owns setPhase + its own banner.
 *
 *  Both sides run `finalizeBattle` + `prepareNextRound` locally — the wire signal is just
 *  a marker telling the watcher when to dispatch this transition.
 *  RNG was synced at the previous `BATTLE_START` and has tracked
 *  identically through impact resolution, so post-battle RNG draws
 *  (interbattle grunt spawn, upgrade offers, bonus square shuffle,
 *  enclosed-grunt respawn) advance in lockstep. */
const BATTLE_DONE: Transition = {
  id: "battle-done",
  from: Phase.BATTLE,
  mutate: (ctx) => {
    ctx.endBattleLocalControllers?.();
    ctx.saveBattleCrosshair?.();
    finalizeBattle(ctx.state);
    prepareNextRound(ctx.state);
    ctx.broadcast?.buildStart?.();
    return EMPTY_TRANSITION_RESULT;
  },
  postMutate: clearBattleAnim,
  display: [],
  postDisplay: routePostBattleToBuild,
};
/** `ceasefire` — CANNON_PLACE prep transition (battle skipped).
 *
 *  Triggered when `shouldSkipBattle(state)` at the top of `startBattle`:
 *  no side has fighting capability, so the battle is skipped at the
 *  engine level. `enterBuildSkippingBattle` does the pre-battle cleanup
 *  (burning-pit decay, wall sweep, territory recheck, modifier clear)
 *  then calls `finalizeBattle` + `prepareNextRound` (round increment, upgrade
 *  offer generation). Shows no banner; `postDisplay` routes to
 *  `enter-upgrade-pick` or `enter-wall-build`. Watcher never hits this
 *  transition — the host broadcasts BUILD_START and the watcher routes
 *  through `battle-done`. */
const CEASEFIRE: Transition = {
  id: "ceasefire",
  from: Phase.CANNON_PLACE,
  // Dispatched on every peer's local tick — `tickCannonPhase` checks
  // `shouldSkipBattle` unconditionally and `ceasefireSkipBattle` is
  // wired in the universal ctx. The host additionally broadcasts
  // BUILD_START as a sync marker.
  mutate: (ctx) => {
    ctx.log(`ceasefire: skipping battle (round=${ctx.state.round})`);
    ctx.scoreDelta.reset?.();
    ctx.ceasefireSkipBattle?.();
    ctx.broadcast?.buildStart?.();
    return EMPTY_TRANSITION_RESULT;
  },
  postMutate: clearBattleAnim,
  display: [],
  postDisplay: routePostBattleToBuild,
};
/** `enter-upgrade-pick` — UPGRADE_PICK entry. Flips the phase,
 *  shows the "Choose Upgrade" banner, then runs the picker modal in
 *  `postDisplay`. Dispatched from `battle-done` / `ceasefire`
 *  postDisplay only when `state.modern?.pendingUpgradeOffers` is
 *  populated (modern mode, offers generated in `prepareNextRound`).
 *
 *  The picker modal sits over the same clipping rect as the banner;
 *  resolving all picks dispatches `upgrade-pick-done`. */
const ENTER_UPGRADE_PICK: Transition = {
  id: "enter-upgrade-pick",
  from: [Phase.BATTLE, Phase.CANNON_PLACE],
  mutate: (ctx) => {
    setPhase(ctx.state, Phase.UPGRADE_PICK);
    ctx.upgradePick?.prepare();
    return EMPTY_TRANSITION_RESULT;
  },
  display: [
    {
      kind: STEP_BANNER,
      bannerKind: "upgrade-pick",
      text: BANNER_UPGRADE_PICK,
      subtitle: BANNER_UPGRADE_PICK_SUB,
    },
  ],
  postDisplay: runPickerModalThenDispatch,
};
/** `upgrade-pick-done` — UPGRADE_PICK prep transition. Applies the
 *  picks into state and rechecks territory so the upcoming build
 *  phase's banner reveals the post-pick walls. Shows no banner;
 *  postDisplay dispatches `enter-wall-build`. */
const UPGRADE_PICK_DONE: Transition = {
  id: "upgrade-pick-done",
  from: Phase.UPGRADE_PICK,
  mutate: applyUpgradePicksFromDialog,
  display: [],
  postDisplay: (ctx) => runTransitionInline("enter-wall-build", ctx),
};
/** `enter-wall-build` — WALL_BUILD entry. Flips the phase, seeds the
 *  local build controllers, and shows the "Build & Repair" banner.
 *  Dispatched from `battle-done` / `ceasefire` prep (when no upgrade
 *  offers), or from `upgrade-pick-done` after all players have resolved
 *  their picks (the picks-dispatch path already tore down the dialog
 *  inside `upgrade-pick-done.mutate` before reaching this transition).
 *
 *  `startBuildPhaseLocal` / `initLocalBuildControllerIfActive` run in
 *  `mutate` so they populate each controller's `currentBuildPhantoms`
 *  (via `startBuildPhase`) before the B-snapshot is captured. The
 *  snapshot is taken between `mutate` and the banner's display step, so
 *  the controllers must be seeded first — otherwise the "new scene"
 *  slice of the banner sweep shows no piece previews and they pop in
 *  at banner end.
 *
 *  postDisplay (host): flips to Mode.GAME (behavioral gate for
 *  input/tick dispatch — not visible state, so not needed before the
 *  B-snapshot).
 *  postDisplay (watcher): anchors the phase timer at banner-end and
 *  flips to Mode.GAME. */
const ENTER_WALL_BUILD: Transition = {
  id: "enter-wall-build",
  from: [Phase.BATTLE, Phase.CANNON_PLACE, Phase.UPGRADE_PICK],
  mutate: (ctx) => {
    setPhase(ctx.state, Phase.WALL_BUILD);
    // Anchor the phase timer here — AFTER `applyUpgradePicks` (which
    // runs in `upgrade-pick-done.mutate`) and `resetPlayerUpgrades`
    // (which runs in `prepareNextRound`) have settled the upgrade
    // set for this round. Setting it earlier (e.g. in
    // `prepareNextRound`) reflects the PREVIOUS round's upgrades
    // and diverges Double Time / Master Builder bonuses from what the
    // build phase actually plays out with — host vs watcher would
    // disagree on phase length.
    ctx.state.timer = ctx.state.buildTimer + buildTimerBonus(ctx.state);
    // Per-controller startBuildPhase + scoreDelta reset/capturePreScores
    // + clearImpacts + accumulator resets. Same on every peer.
    ctx.startBuildPhaseLocal?.();
    return EMPTY_TRANSITION_RESULT;
  },
  display: [
    {
      kind: STEP_BANNER,
      bannerKind: "build",
      text: BANNER_BUILD,
      subtitle: BANNER_BUILD_SUB,
    },
  ],
  postDisplay: (ctx) => {
    ctx.setMode(Mode.GAME);
  },
};
/** Shared cannon-entry postDisplay for every transition that enters
 *  CANNON_PLACE (`castle-select-done`, `castle-reselect-done`,
 *  `advance-to-cannon`). Initializes local cannon controllers
 *  (placeCannons + cursor + startCannonPhase) and flips to Mode.GAME. */
const cannonEntryPostDisplay: PostDisplayFn = (ctx) => {
  ctx.initLocalCannonControllers?.();
  ctx.setMode(Mode.GAME);
};
const cannonEntryDisplay: readonly DisplayStep[] = [
  {
    kind: STEP_BANNER,
    bannerKind: "cannon-place",
    text: BANNER_PLACE_CANNONS,
    subtitle: BANNER_PLACE_CANNONS_SUB,
  },
];
/** `castle-select-done` — CASTLE_SELECT → CANNON_PLACE (round 1 / initial).
 *
 *  `finalizeCastleConstruction` claims territory and spawns houses /
 *  bonus squares; `enterCannonPhase` sets the phase + computes cannon
 *  limits + returns per-player init data. Host broadcasts CANNON_START
 *  so watchers can apply the checkpoint. Watchers run the same body
 *  locally — derived state matches byte-for-byte from synced state +
 *  RNG so no wire payload is needed; the broadcast is just a phase-
 *  advance marker. */
const CASTLE_SELECT_DONE: Transition = {
  id: "castle-select-done",
  from: Phase.CASTLE_SELECT,
  mutate: (ctx) => {
    finalizeCastleConstruction(ctx.state);
    ctx.clearCastleBuildViewport?.();
    enterCannonPhase(ctx.state);
    ctx.broadcast?.cannonStart?.();
    return EMPTY_TRANSITION_RESULT;
  },
  postMutate: clearBattleAnim,
  display: cannonEntryDisplay,
  postDisplay: cannonEntryPostDisplay,
};
/** `castle-reselect-done` — CASTLE_RESELECT → CANNON_PLACE (after a
 *  player lost a life and rebuilt their castle).
 *
 *  Differs from `castle-select-done` only in the prefix:
 *  `finalizeRoundVisuals` (Phase B visuals deferred from round-end)
 *  + `finalizeReselectedPlayers` (zone reset protection) before
 *  `finalizeCastleConstruction`. Rest is identical. */
const CASTLE_RESELECT_DONE: Transition = {
  id: "castle-reselect-done",
  from: Phase.CASTLE_RESELECT,
  mutate: (ctx) => {
    // Phase B visuals (deferred from round-end) + reselect-specific
    // finalize + castle finalize, then enter cannon phase. All under the
    // cannons banner reveal.
    finalizeRoundVisuals(ctx.state);
    finalizeReselectedPlayers(ctx.state, ctx.reselectionPids ?? []);
    finalizeCastleConstruction(ctx.state);
    ctx.clearCastleBuildViewport?.();
    enterCannonPhase(ctx.state);
    ctx.broadcast?.cannonStart?.();
    return EMPTY_TRANSITION_RESULT;
  },
  postMutate: clearBattleAnim,
  display: cannonEntryDisplay,
  postDisplay: cannonEntryPostDisplay,
};
/** `advance-to-cannon` — WALL_BUILD → CANNON_PLACE after the life-lost
 *  dialog resolves with "continue" (no reselect, no game over).
 *
 *  Unlike `castle-select-done` / `castle-reselect-done`, this path has NO
 *  finalize prefix: `finalizeRound` already ran inside the preceding
 *  `round-end` transition, so state is already post-sweep. The
 *  mutate just flips the phase (via `enterCannonPhase`) and broadcasts.
 *
 *  Triggered from `routeLifeLostResolution`'s `onContinue` callback. */
const ADVANCE_TO_CANNON: Transition = {
  id: "advance-to-cannon",
  from: Phase.WALL_BUILD,
  mutate: (ctx) => {
    // Phase B visuals (deferred from round-end) run under the
    // cannons banner reveal, then cannon phase entry.
    finalizeRoundVisuals(ctx.state);
    enterCannonPhase(ctx.state);
    ctx.broadcast?.cannonStart?.();
    return EMPTY_TRANSITION_RESULT;
  },
  postMutate: clearBattleAnim,
  display: cannonEntryDisplay,
  postDisplay: cannonEntryPostDisplay,
};
/** `round-limit-reached` — the round counter went past `maxRounds`.
 *  The winner is whoever has the highest score among alive players.
 *  Dispatched on every peer's local tick; the host additionally
 *  broadcasts GAME_OVER, which non-host peers consume in
 *  `handleGameOverTransition` to paint the authoritative score frame
 *  (idempotent with the locally-detected game-over). */
const gameOverMutate: MutateFn = (ctx) => {
  if (!ctx.winner) {
    throw new Error(
      "round-limit-reached / last-player-standing dispatched without ctx.winner",
    );
  }
  ctx.endGame?.(ctx.winner);
  return EMPTY_TRANSITION_RESULT;
};
const ROUND_LIMIT_REACHED: Transition = {
  id: "round-limit-reached",
  from: "*",
  mutate: gameOverMutate,
  display: [],
};
/** `last-player-standing` — one or fewer players still alive.
 *  Same shape as `round-limit-reached`; kept as a distinct id because the
 *  trigger semantic differs, which is useful for telemetry / tests.
 *  See `round-limit-reached` for the GAME_OVER wire / local-detection
 *  interplay. */
const LAST_PLAYER_STANDING: Transition = {
  id: "last-player-standing",
  from: "*",
  mutate: gameOverMutate,
  display: [],
};
/** `cannon-place-done` — CANNON_PLACE prep transition. Runs engine
 *  battle entry (`enterBattlePhase`: modifier roll, balloon resolution,
 *  post-modifier territory/wall snapshots) on every peer; the host
 *  additionally broadcasts BATTLE_START as a sync marker. Does NOT flip
 *  the phase and shows no banner — `postDisplay` routes to
 *  `enter-modifier-reveal` (when a modifier was rolled) or straight to
 *  `enter-battle`, each of which owns setPhase + its own banner.
 *
 *  RNG parity is load-bearing: every peer's `enterBattlePhase` consumes
 *  `state.rng` in lockstep (modifier roll, balloon perturbation). The
 *  BATTLE_START wire message is a payload-less phase marker — non-host
 *  peers ignore it, having already advanced via their local tick. */
const CANNON_PLACE_DONE: Transition = {
  id: "cannon-place-done",
  from: Phase.CANNON_PLACE,
  mutate: (ctx) => {
    ctx.log(`startBattle (round=${ctx.state.round})`);
    ctx.scoreDelta.reset();
    const entry = enterBattlePhase(ctx.state);
    ctx.broadcast?.battleStart?.();
    return { modifierDiff: entry.modifierDiff, flights: entry.flights };
  },
  postMutate: syncBattleAnim,
  display: [],
  postDisplay: routeCannonPlaceDone,
};
/** `enter-modifier-reveal` — MODIFIER_REVEAL entry. Flips the phase,
 *  primes `state.timer` with `MODIFIER_REVEAL_TIMER` so the phase
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
    setPhase(ctx.state, Phase.MODIFIER_REVEAL);
    ctx.state.timer = MODIFIER_REVEAL_TIMER;
    return EMPTY_TRANSITION_RESULT;
  },
  display: [
    {
      kind: STEP_BANNER,
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
 *  after its banner finishes. postDisplay runs `proceedToBattle`
 *  (balloon-anim start or direct battle begin). */
const ENTER_BATTLE: Transition = {
  id: "enter-battle",
  from: [Phase.CANNON_PLACE, Phase.MODIFIER_REVEAL],
  mutate: (ctx) => {
    setPhase(ctx.state, Phase.BATTLE);
    return EMPTY_TRANSITION_RESULT;
  },
  // syncBattleAnim already ran inside `cannon-place-done`'s postMutate
  // — the battle-anim snapshots are still valid here. Re-running is
  // idempotent but unnecessary.
  display: [
    {
      kind: STEP_BANNER,
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
  ROUND_END,
  BATTLE_DONE,
  CEASEFIRE,
  ENTER_UPGRADE_PICK,
  UPGRADE_PICK_DONE,
  ENTER_WALL_BUILD,
  CASTLE_SELECT_DONE,
  CASTLE_RESELECT_DONE,
  ADVANCE_TO_CANNON,
  ROUND_LIMIT_REACHED,
  LAST_PLAYER_STANDING,
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
 *  Callback-based, not Promise-based: the tick loop is synchronous so
 *  microtasks don't flush between ticks; every wait threads through the
 *  subsystem's own callback. */
export function runTransition(id: TransitionId, ctx: PhaseTransitionCtx): void {
  const transition = resolveTransition(id, ctx);

  // Mode.TRANSITION held for the entire transition; postDisplay flips to
  // the terminal mode. isTransition → shouldUnzoom drives the flatten;
  // onCameraReady parks the callback until the camera has converged.
  ctx.setMode(Mode.TRANSITION);

  ctx.onCameraReady(() => {
    executeTransition(transition, ctx);
  });
}

/** Post-cannon-place prep route: dispatch to `enter-modifier-reveal`
 *  when a modifier was rolled (modern mode), otherwise straight to
 *  `enter-battle`. Shared between host and watcher — the host reads
 *  `result.modifierDiff` from its own mutate; the watcher reads from
 *  the incoming BATTLE_START message (also threaded via result).
 *
 *  Uses `runTransitionInline`: the outer prep transition already
 *  awaited camera convergence; the inner entry transition doesn't need
 *  to wait another frame for the camera to settle.
 */
function routeCannonPlaceDone(
  ctx: PhaseTransitionCtx,
  result: TransitionResult,
): void {
  // Thread the prep's result into the inner transition so its banner
  // step can read `result.modifierDiff` (modifier-reveal banner text)
  // and `proceedToBattleFromCtx` can read `result.flights` if needed.
  if (result.modifierDiff) {
    runTransitionInline("enter-modifier-reveal", ctx, {
      modifierDiff: result.modifierDiff,
      flights: result.flights,
    });
  } else {
    runTransitionInline("enter-battle", ctx, { flights: result.flights });
  }
}

/** Post-battle / ceasefire prep transitions don't flip the phase — the
 *  following `enter-upgrade-pick` or `enter-wall-build` entry transition
 *  owns `setPhase`. Route based on whether modern-mode upgrade offers
 *  were generated. Uses `runTransitionInline` for the same reason as
 *  `routeCannonPlaceDone`. */
function routePostBattleToBuild(ctx: PhaseTransitionCtx): void {
  const hasOffers = !!ctx.state.modern?.pendingUpgradeOffers;
  if (hasOffers) runTransitionInline("enter-upgrade-pick", ctx);
  else runTransitionInline("enter-wall-build", ctx);
}

/** Shared post-life-lost routing. Runs the win-condition check
 *  (`resolveAfterLifeLost`) against the continuing-player list written
 *  by the life-lost step, then dispatches one of three branches via
 *  `ctx.lifeLostRoute`. The route handlers are wired identically on
 *  every peer (game-over / reselect / continue all dispatch the next
 *  transition locally). */
function routeLifeLostResolution(
  ctx: PhaseTransitionCtx,
  result: TransitionResult,
): void {
  const route = ctx.lifeLostRoute;
  if (!route) return;
  resolveAfterLifeLost({
    state: ctx.state,
    continuing: result.continuing ?? [],
    onGameOver: route.onGameOver,
    onReselect: route.onReselect,
    onContinue: route.onContinue,
  });
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
 *  (castle-select-done, castle-reselect-done, advance-to-cannon): clear
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
  // anything else. The phase machine has already reached fullMapVp via
  // `onCameraReady`, and `handlePhaseChangeZoom` no longer implicitly
  // engages the tilt / auto-zoom — auto-zoom re-engages when mode flips
  // back to GAME inside `battle.begin`, which also starts the "ready"
  // countdown, so the zoom lerp and "ready" cue start together.
  ctx.beginBattleTilt?.();

  // Flights were stashed into runtimeState.battleAnim.flights by
  // `cannon-place-done`'s `syncBattleAnim` postMutate. We only need to
  // read the count here to decide whether to flip into BALLOON_ANIM.
  const hasFlights = ctx.runtimeState.battleAnim.flights.length > 0;
  if (hasFlights) ctx.setMode(Mode.BALLOON_ANIM);

  const proceed = (): void => {
    if (hasFlights) {
      emitGameEvent(ctx.state.bus, GAME_EVENT.BALLOON_ANIM_START, {
        round: ctx.state.round,
      });
    } else {
      ctx.battle.begin();
    }
  };

  // Pitch gate: wait for the tilt we just requested (or any prior tilt
  // still in progress) to settle before we either start balloons or
  // flip to battle mode. `flat` / `tilted` are both "settled"; only
  // `tilting` / `untilting` block. 2D mode always reports `flat`.
  const pitchState = ctx.getPitchState?.() ?? "flat";
  if (pitchState === "flat" || pitchState === "tilted") {
    proceed();
    return;
  }
  const bus = ctx.state.bus;
  const onPitchSettled = (): void => {
    bus.off(GAME_EVENT.PITCH_SETTLED, onPitchSettled);
    proceed();
  };
  bus.on(GAME_EVENT.PITCH_SETTLED, onPitchSettled);
}

/** Apply the resolved upgrade picks into state + recheck territory.
 *  Used as both host and watcher mutate for `upgrade-pick-done`: the
 *  picks live on `runtime.upgradePick` (the dialog state), populated
 *  during the preceding `enter-upgrade-pick` transition's postDisplay
 *  modal. Emits UPGRADE_PICK_END so consumers (music, stats) can
 *  observe the end of the pick window. */
function applyUpgradePicksFromDialog(
  ctx: PhaseTransitionCtx,
): TransitionResult {
  const picker = ctx.upgradePick;
  const dialog = picker?.getDialog();
  if (dialog) {
    applyUpgradePicks(ctx.state, dialog);
    recheckTerritory(ctx.state);
  }
  // Dialog life is scoped to UPGRADE_PICK — clear here (phase still
  // UPGRADE_PICK) rather than in `enter-wall-build.mutate` so runtime
  // dialog state never coexists with phase != UPGRADE_PICK. The build
  // banner's A-snapshot is the last-painted picker-modal frame, so the
  // visual cross-fade is unaffected by when the state clears.
  picker?.clear?.();
  emitGameEvent(ctx.state.bus, GAME_EVENT.UPGRADE_PICK_END, {
    round: ctx.state.round,
  });
  return EMPTY_TRANSITION_RESULT;
}

/** `enter-upgrade-pick`'s postDisplay (both roles): prepare + show the
 *  picker modal. When all players have resolved their picks (or
 *  auto-skipped) it dispatches `upgrade-pick-done` to continue the
 *  flow. `prepare()` is idempotent — the dialog was already generated
 *  by `prepareNextRound`; `prepare()` just surfaces it. */
function runPickerModalThenDispatch(ctx: PhaseTransitionCtx): void {
  const picker = ctx.upgradePick;
  if (!picker || !picker.prepare()) {
    // No picker wired (shouldn't happen since this transition is only
    // dispatched when offers exist), or prepare failed — fall through
    // as if picks were already resolved.
    runTransitionInline("upgrade-pick-done", ctx);
    return;
  }
  emitGameEvent(ctx.state.bus, GAME_EVENT.UPGRADE_PICK_SHOW, {
    round: ctx.state.round,
  });
  const afterPicks = () => runTransitionInline("upgrade-pick-done", ctx);
  if (!picker.tryShow(afterPicks)) afterPicks();
}

/** Run a transition synchronously, bypassing the `onCameraReady` wait.
 *  Used ONLY when dispatched from inside another transition's
 *  `postDisplay`: the outer transition already unzoomed the camera and
 *  the unzoom state hasn't changed between then and now. Parks the
 *  parent runTransition's inner flow so the inner transition's mutate
 *  + display + postDisplay runs in-line without spending a frame on
 *  an extra unzoom round-trip. Without this, every prep → entry pair
 *  (e.g. `cannon-place-done` → `enter-battle`) would emit an extra
 *  tick between them, diverging the determinism stream.
 *
 *  `seedResult`: optional fields merged onto the inner mutate's return.
 *  Used to thread `modifierDiff` / `flights` from a prep transition
 *  into the entry transition that needs them for its display step
 *  (banner text) or postDisplay (balloon-anim routing). */
function runTransitionInline(
  id: TransitionId,
  ctx: PhaseTransitionCtx,
  seedResult?: Partial<TransitionResult>,
): void {
  const transition = resolveTransition(id, ctx);
  ctx.setMode(Mode.TRANSITION);
  executeTransition(transition, ctx, seedResult);
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
  // (game-over transitions may fire from any phase).
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
  seedResult?: Partial<TransitionResult>,
): void {
  // `showBanner` owns the A/B capture per banner (see
  // `runtime-banner.ts`). The transition runner doesn't snapshot
  // anything — each banner reads the current display pixels as its
  // own prev-scene (A), forces a render to flush any queued mutation,
  // and captures the resulting pixels as its new-scene (B).
  const mutated = transition.mutate(ctx);
  const result: TransitionResult = seedResult
    ? { ...mutated, ...seedResult }
    : mutated;
  transition.postMutate?.(ctx, result);

  runDisplay(transition.display, ctx, result, () => {
    transition.postDisplay?.(ctx, result);
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

function runStep(
  step: DisplayStep,
  ctx: PhaseTransitionCtx,
  result: TransitionResult,
  onDone: () => void,
): void {
  // Subsystems that own a Mode (life-lost, upgrade-pick) leave the mode
  // on their terminal value when firing their completion callback; the
  // transition's postDisplay sets the terminal mode after all steps finish.
  switch (step.kind) {
    case STEP_BANNER:
      runBannerStep(step, ctx, result, onDone);
      return;
    case STEP_SCORE_OVERLAY:
      ctx.scoreDelta.show(onDone);
      return;
    case STEP_LIFE_LOST_DIALOG:
      runLifeLostDialogStep(ctx, result, onDone);
      return;
  }
}

function runBannerStep(
  step: Extract<DisplayStep, { kind: "banner" }>,
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

/** Life-lost dialog step — notifies affected controllers, then hands
 *  the dialog off to `ctx.lifeLost.show` which either resolves
 *  immediately (only eliminations) or shows the modal and waits for
 *  the tick loop to resolve every entry. When `onResolved(continuing)`
 *  fires, we stash the list onto `result.continuing` and call the
 *  runner's `onDone` — postDisplay then routes via `resolveAfterLifeLost`
 *  + `ctx.lifeLostRoute`. */
function runLifeLostDialogStep(
  ctx: PhaseTransitionCtx,
  result: TransitionResult,
  onDone: () => void,
): void {
  const needsReselect = result.needsReselect ?? [];
  const eliminated = result.eliminated ?? [];
  for (const pid of [...needsReselect, ...eliminated]) {
    ctx.notifyLifeLost?.(pid);
  }
  const finish = (continuing: readonly ValidPlayerSlot[]): void => {
    result.continuing = continuing;
    onDone();
  };
  if (
    !ctx.lifeLost ||
    (needsReselect.length === 0 && eliminated.length === 0)
  ) {
    if (ctx.lifeLost) ctx.lifeLost.show([], [], finish);
    else finish([]);
    return;
  }
  // Spec: `max time of build phase → scores → zoom → life lost popup`.
  // The score overlay just finished unzoomed (runTransition's
  // setMode(TRANSITION) + onCameraReady gated display on fullMapVp).
  // Re-engage auto-zoom so the popup appears over the pov player's zone.
  ctx.engageAutoZoom?.();
  emitGameEvent(ctx.state.bus, GAME_EVENT.LIFE_LOST_DIALOG_SHOW, {
    needsReselect,
    eliminated,
    round: ctx.state.round,
  });
  ctx.lifeLost.show(needsReselect, eliminated, finish);
}
