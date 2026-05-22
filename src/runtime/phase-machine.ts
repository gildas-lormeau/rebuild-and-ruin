/**
 * Phase transition state machine. Each `TRANSITIONS` entry declares:
 * `from` guard (`"*"` = any), `mutate` (identical on every peer; only
 * `ctx.broadcast?.X?.()` is host-gated), optional `postMutate` (sync after
 * mutate, before display), `display` (ordered UI steps), optional
 * `postDisplay`. Phase entry is owned by game/ via `enter*Phase`; bus
 * events are observation-only — never control flow.
 */

import type { GameOverReason } from "../game/index.ts";
import {
  applyUpgradePicks,
  eliminatePlayers,
  emitGameEnd,
  emitRoundStart,
  enterBattlePhase,
  enterCannonPhase,
  enterModifierRevealPhase,
  enterUpgradePickPhase,
  enterWallBuildPhase,
  finalizeBattle,
  finalizeCastleConstruction,
  finalizeFreshCastles,
  finalizeRound,
  finalizeRoundCleanup,
  type GameOverOutcome,
  peekGameOverOutcome,
  prepareBattle,
  prepareNextRound,
  recheckTerritory,
  snapshotTerritory,
} from "../game/index.ts";
import type { BalloonFlight } from "../shared/core/battle-types.ts";
import { snapshotAllWalls } from "../shared/core/board-occupancy.ts";
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
import { clearAllPlayerBags } from "../shared/core/player-types.ts";
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
import type { BannerShow } from "./banner-state.ts";
import { resolveAfterLifeLost } from "./dialogs/life-lost-core.ts";
import type { RuntimeState } from "./state.ts";
import type { TimingApi } from "./timing-api.ts";

type TransitionId =
  | "castle-done"
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
  readonly needsReselect?: readonly ValidPlayerId[];
  readonly eliminated?: readonly ValidPlayerId[];
  /** Populated by the `life-lost-dialog` display step once the dialog
   *  resolves (or immediately, for the all-pre-resolved path). Read by
   *  `ROUND_END`'s postDisplay to route via `resolveAfterLifeLost`.
   *  Mutable because it's written AFTER the mutate fn returns. */
  continuing?: readonly ValidPlayerId[];
  /** Set by `ROUND_END`'s mutate when `peekGameOverOutcome` detects the
   *  match has ended. Causes the `life-lost-dialog` step to short-circuit
   *  (no popup) and the postDisplay to fire `onGameOver` directly. */
  readonly gameOverOutcome?: GameOverOutcome;
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
interface BattleLifecycle {
  readonly setFlights: (
    flights: { flight: BalloonFlight; progress: number }[],
  ) => void;
  readonly setTerritory: (territory: readonly Set<TileKey>[]) => void;
  readonly setWalls: (walls: readonly Set<TileKey>[]) => void;
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
  /** Run `cb` once the camera has converged to fullMapVp with pitch
   *  flat. `runTransition` sets `Mode.TRANSITION` (which drives
   *  `shouldUnzoom` true) then calls this; `cb` fires on the first
   *  fullMapVp + flat-pitch frame so every mutate + display step runs
   *  against a full-map viewport. Fires synchronously when both already
   *  hold. See `RuntimeCamera.awaitCameraFlat`. */
  readonly awaitCameraFlat: (callback: () => void) => void;
  readonly setMode: (m: Mode) => void;
  readonly log: (msg: string) => void;

  readonly scoreDelta: {
    readonly capturePreScores?: () => void;
    readonly setPreScores?: (scores: readonly number[]) => void;
    readonly show: (onDone: () => void) => void;
    readonly reset: () => void;
  };

  /** Life-lost dialog hooks. Only required for transitions whose `display`
   *  array contains a `life-lost-dialog` step (round-end). Other
   *  transitions may omit.
   *
   *  `show` drives the dialog to completion. It either resolves
   *  immediately (no entries needed input) or shows the modal and
   *  ticks it to resolution. Either way, `onResolved(continuing,
   *  abandoned)` fires once. `runLifeLostDialogStep`'s wrapper calls
   *  `eliminatePlayers(state, abandoned)` and stashes `continuing` on
   *  `result`; `ROUND_END`'s postDisplay reads it and routes via
   *  `resolveAfterLifeLost` + `ctx.lifeLostRoute`. */
  readonly lifeLost?: {
    readonly show: (
      needsReselect: readonly ValidPlayerId[],
      eliminated: readonly ValidPlayerId[],
      onResolved: (
        continuing: readonly ValidPlayerId[],
        abandoned: readonly ValidPlayerId[],
      ) => void,
    ) => boolean;
  };
  /** Post-life-lost dispatch bundle. `ROUND_END`'s postDisplay runs
   *  `resolveAfterLifeLost` with these three handlers — wired identically
   *  on every peer (each handler dispatches the next transition or seeds
   *  the reselect queue). Optional so transitions that don't include a
   *  life-lost-dialog step can omit. */
  readonly lifeLostRoute?: {
    readonly onGameOver: (
      winner: { id: ValidPlayerId },
      reason: GameOverReason,
    ) => void;
    readonly onReselect: (continuing: readonly ValidPlayerId[]) => void;
    readonly onAdvance: () => void;
  };
  /** Notify a local controller that its player lost a life. Called per
   *  affected player after the score overlay, before the dialog shows. */
  readonly notifyLifeLost?: (pid: ValidPlayerId) => void;
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
  /** Run `cb` once the in-flight pitch animation completes (in either
   *  direction). `proceedToBattle` uses it to hold balloon-anim start
   *  until the build→battle tilt completes. Fires synchronously when
   *  pitch is already settled (including headless `cameraTiltEnabled` =
   *  false), so callers don't need a separate gate. See
   *  `RuntimeCamera.awaitPitchSettled`. Optional so headless contexts
   *  that don't own a camera can skip wiring it. */
  readonly awaitPitchSettled?: (callback: () => void) => void;
  /** Start the build→battle tilt at battle-banner end. Called inside
   *  `proceedToBattle`. Optional so headless / watcher-without-camera
   *  contexts can skip it (2D wiring also skips — the renderer has no
   *  tilt axis). */
  readonly beginTilt?: () => void;
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
  /** Upgrade-pick dialog hooks. Only required for transitions whose
   *  display chain runs the picker modal (`enter-upgrade-pick`).
   *
   *  `tryShow` drives the dialog to completion. It returns false when no
   *  dialog could be created (no offers). When it does run, the
   *  `onResolved(resolved)` callback fires once with the finalized
   *  dialog snapshot — the subsystem clears its own dialog state before
   *  invoking the callback. The phase machine applies the picks via
   *  `applyUpgradePicks` against that snapshot. Mirrors `lifeLost.show`:
   *  the dialog subsystem produces resolutions, the phase machine
   *  applies them. */
  readonly upgradePick?: {
    readonly prepare: () => boolean;
    readonly tryShow: (
      onResolved: (resolved: UpgradePickDialogState) => void,
    ) => boolean;
  };

  readonly battle: BattleLifecycle;

  // ── Host-only hooks ──

  readonly broadcast?: {
    readonly cannonStart?: () => void;
    /** Phase-marker signal — watcher runs `prepareBattle` locally on
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

  // ── Game-over hooks ──

  /** End-game side effects (set game-over frame, stop sound, switch to
   *  Mode.STOPPED, arm demo timer). Used by `round-limit-reached` /
   *  `last-player-standing` transitions. Host-only. */
  readonly endGame?: (winner: { id: ValidPlayerId }) => void;
  /** Winner determined by the life-lost resolution. Threaded through via
   *  ctx so the mutate can pass it to `endGame`. */
  readonly winner?: { id: ValidPlayerId };
}

/** Default "no battle-entry data" result. Every transition whose mutate
 *  doesn't produce a modifier roll or balloon flights returns this (or
 *  spreads it). Keeps `TransitionResult.modifierDiff` / `flights` strictly
 *  required at the type level — consumers no longer defensively coalesce. */
const EMPTY_TRANSITION_RESULT: TransitionResult = {
  modifierDiff: null,
  flights: [],
};
/** Discriminator values for `DisplayStep.kind`. */
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
 *  does NOT enter a new phase: the next transition (castle-done /
 *  advance-to-cannon / round-limit-reached / last-player-standing)
 *  flips it. */
const ROUND_END: Transition = {
  id: "round-end",
  from: Phase.WALL_BUILD,
  mutate: (ctx) => {
    ctx.finalizeLocalControllersBuildPhase?.();
    // Clear bags on every peer at the same logical sim tick. Per-LOCAL
    // controller bag clears (which `finalizeLocalControllersBuildPhase`
    // used to do) drifted `state.rng`: late-arriving piece-place actions
    // would drain on one peer (no-op against null bag) while the other
    // peer advanced + potentially shuffled the bag (RNG draw). Symmetric
    // clear here closes that window — see `clearAllPlayerBags` docstring.
    clearAllPlayerBags(ctx.state);
    // Capture pre-scores BEFORE finalizeRound mutates them via
    // territory + life-penalty point awards — score-overlay needs the
    // starting values for the delta animation.
    const preScores = ctx.state.players.map((player) => player.score);
    // Phase A only: scoring + life penalties. The wall sweep, dead-zone
    // grunt sweep, and targetedWall recompute are deferred to `finalizeRoundCleanup`,
    // called from `advance-to-cannon` / `castle-done` (round > 1) /
    // game-over flows so the cannons banner reveals them.
    // `applyLifePenalties` inside finalizeRound already runs
    // `resetZoneState` for eliminated/reselect players — every peer
    // converges identically.
    const { needsReselect, eliminated } = finalizeRound(ctx.state);
    ctx.scoreDelta.setPreScores?.(preScores);
    ctx.broadcast?.buildEnd?.();
    // Decide game-over BEFORE the life-lost popup. The popup is just a
    // continue/abandon prompt — its choice has no effect when the match
    // is ending, so we suppress it on the game-over branch (the dialog
    // step short-circuits when needsReselect + eliminated are both
    // empty). The peek runs against the closing round (state.round not
    // yet incremented). Tiebreak is score-only among alive players;
    // eliminated players (lives = 0) are filtered out before the compare.
    const gameOverOutcome = peekGameOverOutcome(ctx.state);
    if (gameOverOutcome) {
      return { ...EMPTY_TRANSITION_RESULT, gameOverOutcome };
    }
    // Game continues — advance the counter and emit ROUND_START so the
    // life-lost popup (and everything after it) reads the new round.
    ctx.state.round++;
    // gruntSpawnSeq deliberately NOT reset — it must keep advancing so
    // the per-round-first spawn lands at a different rotation than the
    // previous round's first spawn. Only the per-round used-tile set
    // resets (that's the within-round no-cluster guarantee).
    ctx.state.gruntSpawnUsedTiles.clear();
    emitRoundStart(ctx.state);
    return {
      ...EMPTY_TRANSITION_RESULT,
      needsReselect,
      eliminated,
    };
  },
  display: [{ kind: STEP_SCORE_OVERLAY }, { kind: STEP_LIFE_LOST_DIALOG }],
  postDisplay: routeLifeLostResolution,
};
/** `battle-done` — BATTLE prep transition. Runs engine post-battle
 *  housekeeping in two halves: `finalizeBattle` (combo bonuses, battle
 *  cleanup, inGracePeriod clear, lastModifierId snapshot, ROUND_END emit)
 *  followed by `prepareNextRound` (round increment, ROUND_START, grunt
 *  spawn, upgrade offer generation, piece bag init). Broadcasts BUILD_START.
 *  Does NOT flip the phase and shows no banner — `postDisplay` routes to
 *  `enter-upgrade-pick` (when offers were generated) or `enter-wall-build`,
 *  each of which delegates the phase entry to game/ + shows its own banner.
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
    enterUpgradePickPhase(ctx.state);
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
/** `upgrade-pick-done` — UPGRADE_PICK prep transition. Picks were already
 *  applied inside `runPickerModalThenDispatch`'s onResolved callback (the
 *  subsystem hands the resolved dialog back; the phase machine applies
 *  it before dispatching this transition). Mirrors how life-lost
 *  resolutions reach the postDisplay router via callback rather than via
 *  a state read from a separate mutate.
 *
 *  Shows no banner; postDisplay dispatches `enter-wall-build`. */
const UPGRADE_PICK_DONE: Transition = {
  id: "upgrade-pick-done",
  from: Phase.UPGRADE_PICK,
  mutate: () => EMPTY_TRANSITION_RESULT,
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
    // Phase flip + entry-time timer anchor (timer must reflect THIS round's
    // upgrade set — see `enterWallBuildPhase` JSDoc for the parity story).
    enterWallBuildPhase(ctx.state);
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
 *  CANNON_PLACE (`castle-done`, `advance-to-cannon`). Initializes local
 *  cannon controllers (placeCannons + cursor + startCannonPhase) and
 *  flips to Mode.GAME. */
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
/** `castle-done` — CASTLE_SELECT → CANNON_PLACE.
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
 *    4. `enterCannonPhase` — sets the phase + computes cannon limits +
 *       returns per-player init data.
 *
 *  Host broadcasts CANNON_START so watchers can apply the checkpoint.
 *  Watchers run the same body locally — derived state matches byte-for-byte
 *  from synced state + RNG so no wire payload is needed; the broadcast is
 *  just a phase-advance marker. */
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
 *  Unlike `castle-done`, this path has no fresh-castle prefix: there's no
 *  new castle to finalize and `finalizeRound` already ran inside the
 *  preceding `round-end` transition. The mutate runs `finalizeRoundCleanup`
 *  (Phase B sweeps) under the cannons banner, flips the phase via
 *  `enterCannonPhase`, and broadcasts.
 *
 *  Triggered from `routeLifeLostResolution`'s `onAdvance` callback. */
const ADVANCE_TO_CANNON: Transition = {
  id: "advance-to-cannon",
  from: Phase.WALL_BUILD,
  mutate: (ctx) => {
    // Phase B cleanup (deferred from round-end) runs under the
    // cannons banner reveal, then cannon phase entry.
    finalizeRoundCleanup(ctx.state);
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
    ctx.scoreDelta.reset();
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
  postDisplay: routeCannonPlaceDone,
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
    enterBattlePhase(ctx.state);
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
  CASTLE_DONE,
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
  // awaitCameraFlat fires `executeTransition` once the camera has
  // converged (synchronously if it's already at fullMap + flat pitch).
  ctx.setMode(Mode.TRANSITION);

  ctx.awaitCameraFlat(() => {
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
 *  owns the phase entry. Route based on whether modern-mode upgrade offers
 *  were generated. Uses `runTransitionInline` for the same reason as
 *  `routeCannonPlaceDone`. */
function routePostBattleToBuild(ctx: PhaseTransitionCtx): void {
  const hasOffers = !!ctx.state.modern?.pendingUpgradeOffers;
  if (hasOffers) runTransitionInline("enter-upgrade-pick", ctx);
  else runTransitionInline("enter-wall-build", ctx);
}

/** Shared post-life-lost routing. Two branches:
 *
 *    1. `result.gameOverOutcome` set — the round-end mutate already
 *       detected game-over via `peekGameOverOutcome`. The life-lost
 *       popup was suppressed (its choice would be moot). Emit GAME_END
 *       NOW (after the score overlay, not at decision time so SFX
 *       observers fire in the right order) and dispatch onGameOver.
 *    2. otherwise — the dialog populated `result.continuing`. Dispatch
 *       continue/reselect via `resolveAfterLifeLost`.
 *
 *  Route handlers (`onGameOver` / `onReselect` / `onAdvance`) are
 *  wired identically on every peer, so each peer dispatches the next
 *  transition locally. */
function routeLifeLostResolution(
  ctx: PhaseTransitionCtx,
  result: TransitionResult,
): void {
  const route = ctx.lifeLostRoute;
  if (!route) return;
  if (result.gameOverOutcome) {
    emitGameEnd(ctx.state, result.gameOverOutcome);
    route.onGameOver(
      result.gameOverOutcome.winner,
      result.gameOverOutcome.reason,
    );
    return;
  }
  resolveAfterLifeLost({
    continuing: result.continuing ?? [],
    onReselect: route.onReselect,
    onAdvance: route.onAdvance,
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
  // anything else. The phase machine has already reached fullMapVp via
  // `awaitCameraFlat`, and `handlePhaseChangeZoom` no longer implicitly
  // engages the tilt / auto-zoom — auto-zoom re-engages when mode flips
  // back to GAME inside `battle.begin`, which also starts the "ready"
  // countdown, so the zoom lerp and "ready" cue start together.
  ctx.beginTilt?.();

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
  // still in progress) to settle before we either start balloons or flip
  // to battle mode. `awaitPitchSettled` fires `proceed` synchronously if
  // pitch is already settled (or headless), so this single call covers
  // both the mid-animation and already-done cases. Closure-stored
  // callback (not Promise) — runtime ticks synchronously this frame on
  // settle and a microtask hop would break mock-clock determinism.
  if (ctx.awaitPitchSettled) ctx.awaitPitchSettled(proceed);
  else proceed();
}

/** `enter-upgrade-pick`'s postDisplay (both roles): prepare + show the
 *  picker modal. When all players have resolved their picks (or
 *  auto-skipped) the subsystem hands the resolved dialog back via the
 *  `onResolved` callback. The callback applies the picks against the
 *  snapshot, emits UPGRADE_PICK_END, then dispatches `upgrade-pick-done`
 *  to continue the flow. `prepare()` is idempotent — the dialog was
 *  already generated by `prepareNextRound`; `prepare()` just surfaces it.
 *
 *  Mirrors `runLifeLostDialogStep`: the dialog subsystem produces
 *  resolutions, the phase machine applies them. */
function runPickerModalThenDispatch(ctx: PhaseTransitionCtx): void {
  const picker = ctx.upgradePick;
  const finish = (resolved: UpgradePickDialogState | null): void => {
    if (resolved) {
      applyUpgradePicks(ctx.state, resolved);
      recheckTerritory(ctx.state);
    }
    emitGameEvent(ctx.state.bus, GAME_EVENT.UPGRADE_PICK_END, {
      round: ctx.state.round,
    });
    runTransitionInline("upgrade-pick-done", ctx);
  };
  if (!picker || !picker.prepare()) {
    // No picker wired (shouldn't happen since this transition is only
    // dispatched when offers exist), or prepare failed — fall through
    // as if picks were already resolved.
    finish(null);
    return;
  }
  emitGameEvent(ctx.state.bus, GAME_EVENT.UPGRADE_PICK_SHOW, {
    round: ctx.state.round,
  });
  if (!picker.tryShow(finish)) finish(null);
}

/** Run a transition synchronously, bypassing the `awaitCameraFlat` wait.
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
  // `subsystems/banner.ts`). The transition runner doesn't snapshot
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
  const finish = (
    continuing: readonly ValidPlayerId[],
    abandoned: readonly ValidPlayerId[],
  ): void => {
    // Mirrors how `runPickerModalThenDispatch`'s finish callback applies
    // the upgrade picks after the subsystem hands them back — the dialog
    // subsystem produces resolutions, the phase-machine applies them.
    if (abandoned.length > 0) eliminatePlayers(ctx.state, abandoned);
    result.continuing = continuing;
    onDone();
  };
  if (
    !ctx.lifeLost ||
    (needsReselect.length === 0 && eliminated.length === 0)
  ) {
    if (ctx.lifeLost) ctx.lifeLost.show([], [], finish);
    else finish([], []);
    return;
  }
  // Spec: `max time of build phase → scores → zoom → life lost popup`.
  // The score overlay just finished unzoomed (runTransition's
  // setMode(TRANSITION) + awaitCameraFlat gated display on fullMapVp).
  // The camera reads `lifeLostKeepZoom` from FrameContext and snaps to the
  // local pov player's zone via `holdLifeLostZoom` once the dialog opens —
  // this used to be a poke from here (`engageAutoZoom`) that lost the race
  // against `unzoomForOverlays` and produced a flicker.
  emitGameEvent(ctx.state.bus, GAME_EVENT.LIFE_LOST_DIALOG_SHOW, {
    needsReselect,
    eliminated,
    round: ctx.state.round,
  });
  ctx.lifeLost.show(needsReselect, eliminated, finish);
}
