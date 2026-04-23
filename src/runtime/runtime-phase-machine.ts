/**
 * Phase transition state machine.
 *
 * Every phase transition (CASTLE_SELECT → CANNON_PLACE, WALL_BUILD →
 * CANNON_PLACE, CANNON_PLACE → BATTLE, BATTLE → WALL_BUILD, reselect, game
 * over) is an entry in `TRANSITIONS`. Each entry declares:
 *
 *   - `from`: source phase asserted on host dispatch. `"*"` opts out of
 *     the guard (game-over transitions may fire from any phase). The
 *     assertion is host-only because the watcher collapses multiple host
 *     sources into a single dispatched id (e.g. CANNON_START arrives
 *     after host's `castle-select-done` / `castle-reselect-done` /
 *     `advance-to-cannon`, all handled via `advance-to-cannon` on the
 *     watcher). Per-transition target phase lives in the docstring, not
 *     in a field, because several transitions don't setPhase themselves
 *     (`wall-build-done` stays in WALL_BUILD; the continuation flips it).
 *   - `mutate.host` (required) and `mutate.watcher` (optional, omitted for
 *     host-only transitions like `round-limit-reached` /
 *     `last-player-standing` / `ceasefire` — the runner throws if a
 *     watcher ctx dispatches one). Host runs game logic; watcher applies
 *     an incoming checkpoint.
 *   - `postMutate` (optional): shared sync that runs synchronously after
 *     `mutate` returns and BEFORE the first display step. Use for work
 *     that is genuinely identical between host and watcher (e.g.
 *     rebuilding `battleAnim` snapshots from the freshly-mutated state).
 *   - `display`: ordered UI steps that play between mutation and the
 *     terminal frame (banner / score-overlay / life-lost-dialog /
 *     upgrade-pick).
 *   - `postDisplay` (optional, per-role): side-effects that complete the
 *     transition after the display steps (e.g. balloon-anim vs begin-battle).
 *
 * `runTransition(id, ctx)` executes the entry: runs the role-appropriate
 * mutate, runs `postMutate`, walks the display steps in order, then runs the
 * role-appropriate postDisplay. Host and watcher call the same runner; only
 * the `mutate` and `postDisplay` fns differ.
 *
 * The bus is NOT used as control flow. Bus events (PHASE_START/END,
 * BANNER_START/END, SCORE_OVERLAY_START/END) remain pure observations
 * emitted from inside the mutate / display handlers.
 */

import type { GameOverReason } from "../game/index.ts";
import {
  applyUpgradePicks,
  enterBattlePhase,
  enterBuildPhase,
  enterCannonPhase,
  finalizeBuildPhase,
  finalizeBuildVisuals,
  finalizeCastleConstruction,
  finalizeReselectedPlayers,
  recheckTerritory,
  snapshotTerritory,
} from "../game/index.ts";
import { setPhase } from "../game/phase-setup.ts";
import type {
  BattleStartData,
  BuildEndData,
  BuildStartData,
  CannonStartData,
} from "../protocol/checkpoint-data.ts";
import type { BuildEndMessage } from "../protocol/protocol.ts";
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
import type { BuildEndSummary } from "./runtime-types.ts";

export type TransitionId =
  | "castle-select-done"
  | "castle-reselect-done"
  | "advance-to-cannon"
  | "wall-build-done"
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
   *  `WALL_BUILD_DONE`'s postDisplay to route via `resolveAfterLifeLost`.
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
      /** Static text, or a function of the mutation result (used by the
       *  modifier-reveal banner which reads the modifier label from the
       *  result). */
      readonly text: string | ((r: TransitionResult) => string);
      readonly subtitle?: string;
      /** Opaque accent-palette key extractor. Used by the
       *  modifier-reveal banner to recolor its chrome (and match the
       *  `revealTiles` highlight pulse). The banner system treats the
       *  result as a string the renderer indexes into its palette
       *  table. Only set where a non-default palette is wanted. */
      readonly paletteKey?: (r: TransitionResult) => string | undefined;
      /** Tile keys to highlight progressively as the sweep passes.
       *  Used by the modifier-reveal banner to announce the
       *  newly-changed tiles. Only set on banners that want a
       *  highlight overlay — other banner steps leave this undefined. */
      readonly revealTiles?: (
        r: TransitionResult,
      ) => readonly number[] | undefined;
    }
  | { readonly kind: "score-overlay" }
  | { readonly kind: "life-lost-dialog" };

/** Per-role mutation: host mutates by running game logic, watcher mutates
 *  by applying a checkpoint. Both return the same shape. `watcher` is
 *  omitted for host-only transitions (game-over); the runner throws if a
 *  watcher ctx dispatches one. */
interface MutationFns {
  readonly host: (ctx: PhaseTransitionCtx) => TransitionResult;
  readonly watcher?: (ctx: PhaseTransitionCtx) => TransitionResult;
}

/** Shared post-mutation sync. Runs synchronously after `mutate` returns and
 *  BEFORE the first display step. Use for work that is genuinely identical
 *  between host and watcher (e.g. rebuilding `battleAnim` snapshots from the
 *  freshly-mutated state). Keeping it separate from `mutate` removes the
 *  duplicated trailing calls that every role-specific mutate would otherwise
 *  re-emit. */
type PostMutateFn = (ctx: PhaseTransitionCtx, r: TransitionResult) => void;

/** Side-effects after the display steps complete. Each role optional —
 *  transitions that do nothing for a role omit that entry. */
interface PostDisplayFns {
  readonly host?: (ctx: PhaseTransitionCtx, r: TransitionResult) => void;
  readonly watcher?: (ctx: PhaseTransitionCtx, r: TransitionResult) => void;
}

interface Transition {
  readonly id: TransitionId;
  /** Source phase asserted on host dispatch. A single `Phase` accepts
   *  only that phase; a readonly array accepts any of the listed
   *  phases (used by entry transitions like `enter-battle` that may be
   *  dispatched from either CANNON_PLACE directly or from
   *  MODIFIER_REVEAL after the modifier banner). `"*"` opts out of the
   *  guard entirely (game-over transitions may fire from any phase). */
  readonly from: Phase | readonly Phase[] | "*";
  readonly mutate: MutationFns;
  /** Shared post-mutation sync. Runs after mutate, before display. Applies
   *  to both roles; omit if the transition has no shared post-work. */
  readonly postMutate?: PostMutateFn;
  readonly display: readonly DisplayStep[];
  readonly postDisplay?: PostDisplayFns;
}

/** Minimal battle-lifecycle hooks the machine needs to drive the post-
 *  battle-banner step (balloon anim or beginBattle). Host and watcher plug
 *  in different implementations. */
export interface BattleLifecycle {
  readonly setFlights: (
    flights: { flight: BalloonFlight; progress: number }[],
  ) => void;
  readonly setTerritory: (territory: readonly Set<number>[]) => void;
  readonly setWalls: (walls: readonly Set<number>[]) => void;
  readonly clearImpacts: () => void;
  /** On host: calls into runtime-phase-ticks `beginBattle`. On watcher:
   *  the watcher's equivalent countdown start. */
  readonly begin: () => void;
}

/** Watcher checkpoint-apply hooks. Only set on watcher ctx. Each function
 *  accepts the incoming checkpoint payload (defined in
 *  `protocol/checkpoint-data.ts`) and applies the mutation to state /
 *  territory / battleAnim. */
export type ApplyBattleStart = (msg: BattleStartData) => void;

export type ApplyCannonStart = (msg: CannonStartData) => void;

export type ApplyBuildStart = (msg: BuildStartData) => void;

export type ApplyBuildEnd = (
  msg: BuildEndData,
  capturePreScores: () => void,
) => void;

/** Watcher-specific hooks. Populated only when `role === "watcher"`. */
export interface WatcherHooks {
  /** Anchor the watcher's phase timer at the banner-end moment (so
   *  `state.timer` reconstruction matches the host). */
  readonly setPhaseTimerAtBannerEnd: (phaseDuration: number) => void;
  /** Initialize the local player's cannon controller (placeCannons / cursor
   *  / startCannonPhase) — watcher only init's its own controller, not all
   *  local controllers like host does. No-op when the local player is
   *  unseated or eliminated. */
  readonly initLocalCannonControllerIfActive: () => void;
  /** Initialize the local player's build-phase controller state. No-op when
   *  local player is unseated or eliminated. */
  readonly initLocalBuildControllerIfActive: () => void;
  /** Reset zone state for every player returned by the build-end checkpoint
   *  as `needsReselect` or `eliminated`. */
  readonly resetRemovedPlayerZones: (
    needsReselect: readonly ValidPlayerSlot[],
    eliminated: readonly ValidPlayerSlot[],
  ) => void;
}

/** Context passed to every transition step. Host and watcher build this
 *  with different `role` and role-specific hooks filled in. */
export interface PhaseTransitionCtx {
  readonly state: GameState;
  readonly runtimeState: RuntimeState;
  readonly role: "host" | "watcher";
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
  /** Pre-transition unzoom with post-convergence callback. Called once
   *  at the top of `runTransition` so every mutate + display step runs
   *  against a full-map viewport. See `CameraSystem.requestUnzoom`. */
  readonly requestUnzoom: (onReady: () => void) => void;
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
   *  array contains a `life-lost-dialog` step (wall-build-done). Other
   *  transitions may omit.
   *
   *  `show` drives the dialog to completion. It either resolves
   *  immediately (no entries needed input) or shows the modal and
   *  ticks it to resolution. Either way, `onResolved(continuing)` fires
   *  once with the list of players who chose CONTINUE. The step sets
   *  `result.continuing` from this list; `WALL_BUILD_DONE`'s postDisplay
   *  reads it and routes via `resolveAfterLifeLost` + `ctx.lifeLostRoute`. */
  readonly lifeLost?: {
    readonly show: (
      needsReselect: readonly ValidPlayerSlot[],
      eliminated: readonly ValidPlayerSlot[],
      onResolved: (continuing: readonly ValidPlayerSlot[]) => void,
    ) => boolean;
  };
  /** Post-life-lost dispatch bundle. `WALL_BUILD_DONE`'s postDisplay
   *  runs `resolveAfterLifeLost` with these three handlers; host and
   *  watcher supply different implementations (host dispatches the
   *  next transition, watcher only sets Mode.STOPPED on game-over
   *  since the server drives continue/reselect). Optional so
   *  transitions that don't include a life-lost-dialog step can omit. */
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
   *  `wall-build-done` host mutate (remote humans are skipped — their
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
   *  `battle-done`'s `enterBuildPhase` because it also decays burning
   *  pits, sweeps walls, rechecks territory, and clears active modifiers
   *  (things the real battle-end flow already handled). */
  readonly ceasefireSkipBattle?: () => void;
  /** Tear down the upgrade-pick dialog when the BUILD banner completes.
   *  Wired to modern-mode only — the dialog sits on top of the BUILD
   *  banner via an inverted clip rect. */
  readonly clearUpgradePickDialog?: () => void;

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
    readonly cannonStart?: (state: GameState) => void;
    readonly battleStart?: (
      state: GameState,
      flights: readonly BalloonFlight[],
      modifierDiff: ModifierDiff | null,
    ) => void;
    readonly buildStart?: (state: GameState) => void;
    readonly buildEnd?: (state: GameState, payload: BuildEndSummary) => void;
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

  // ── Watcher-only hooks ──

  /** The incoming server message that triggered this transition. Only set
   *  on watcher ctx; mutate fns cast to the expected message shape. */
  readonly incomingMsg?: unknown;

  readonly checkpoint?: {
    readonly applyCannonStart?: ApplyCannonStart;
    readonly applyBattleStart?: ApplyBattleStart;
    readonly applyBuildStart?: ApplyBuildStart;
    readonly applyBuildEnd?: ApplyBuildEnd;
  };

  readonly watcher?: WatcherHooks;
}

/** Bundles a paired `mutate` + `postDisplay` so the type system enforces
 *  the link between the two halves of a transition step that share state /
 *  invariants. Without the bundle, the pairing is naming-convention only
 *  and signature drift on one half goes unnoticed until runtime. */
interface TransitionStep {
  readonly mutate: (ctx: PhaseTransitionCtx) => TransitionResult;
  readonly postDisplay: (ctx: PhaseTransitionCtx) => void;
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
/** `wall-build-done` — end of WALL_BUILD.
 *
 *  Host: finalizes local controllers' bag state, then runs the engine's
 *  `finalizeBuildPhase` (wall sweep + territory finalize + life penalties
 *  + grunt sweep). Broadcasts the BUILD_END checkpoint so watchers replay.
 *
 *  Display: score-overlay animation → life-lost-dialog step. The dialog
 *  step writes `result.continuing` once resolved (or immediately, for
 *  the all-pre-resolved path) and hands control to postDisplay.
 *
 *  postDisplay: runs `resolveAfterLifeLost` with `ctx.lifeLostRoute`'s
 *  three handlers. Host dispatches the next transition (game-over /
 *  reselect / continue); watcher's handlers set Mode.STOPPED on
 *  game-over and no-op otherwise (server checkpoint drives the rest).
 *
 *  The `to` phase is nominally CANNON_PLACE but this transition itself
 *  does NOT call `setPhase`: the next transition (castle-reselect-done
 *  / advance-to-cannon / round-limit-reached / last-player-standing)
 *  flips it. */
const WALL_BUILD_DONE: Transition = {
  id: "wall-build-done",
  from: Phase.WALL_BUILD,
  mutate: {
    host: (ctx) => {
      ctx.finalizeLocalControllersBuildPhase?.();
      // Phase A only: scoring + life penalties. The visual wall sweep +
      // dead-zone grunt sweep are deferred to `finalizeBuildVisuals`,
      // called from `advance-to-cannon` / `castle-reselect-done` /
      // game-over flows so the cannons banner reveals them.
      const { needsReselect, eliminated } = finalizeBuildPhase(ctx.state);
      ctx.broadcast?.buildEnd?.(ctx.state, {
        needsReselect,
        eliminated,
        scores: ctx.state.players.map((player) => player.score),
      });
      return { ...EMPTY_TRANSITION_RESULT, needsReselect, eliminated };
    },
    watcher: (ctx) => {
      const msg = ctx.incomingMsg as BuildEndMessage;
      let preScores: readonly number[] = [];
      ctx.checkpoint?.applyBuildEnd?.(msg, () => {
        preScores = ctx.state.players.map((player) => player.score);
      });
      ctx.watcher?.resetRemovedPlayerZones(msg.needsReselect, msg.eliminated);
      // Feed pre-scores into scoreDelta so the score-overlay display step
      // animates against the correct starting values (checkpoint has already
      // written the new scores into state).
      ctx.scoreDelta.setPreScores?.(preScores);
      return {
        ...EMPTY_TRANSITION_RESULT,
        needsReselect: msg.needsReselect,
        eliminated: msg.eliminated,
        preScores,
      };
    },
  },
  display: [{ kind: STEP_SCORE_OVERLAY }, { kind: STEP_LIFE_LOST_DIALOG }],
  postDisplay: {
    host: routeLifeLostResolution,
    watcher: routeLifeLostResolution,
  },
};
/** `battle-done` — BATTLE prep transition. Runs engine post-battle
 *  housekeeping (`enterBuildPhase` → `enterBuildFromBattle`: combo bonuses,
 *  battle cleanup, grunt spawn, upgrade offer generation, modifier
 *  rotation, round increment) and broadcasts BUILD_START. Does NOT
 *  flip the phase and shows no banner — `postDisplay` routes to
 *  `enter-upgrade-pick` (when offers were generated) or
 *  `enter-wall-build`, each of which owns setPhase + its own banner. */
const BATTLE_DONE: Transition = {
  id: "battle-done",
  from: Phase.BATTLE,
  mutate: {
    host: (ctx) => {
      ctx.endBattleLocalControllers?.();
      ctx.saveBattleCrosshair?.();
      enterBuildPhase(
        ctx.state,
        ctx.runtimeState.battleAnim.territory,
        ctx.runtimeState.battleAnim.walls,
      );
      ctx.broadcast?.buildStart?.(ctx.state);
      return EMPTY_TRANSITION_RESULT;
    },
    watcher: (ctx) => {
      const msg = ctx.incomingMsg as BuildStartData;
      ctx.checkpoint?.applyBuildStart?.(msg);
      return EMPTY_TRANSITION_RESULT;
    },
  },
  postMutate: clearBattleAnim,
  display: [],
  postDisplay: {
    host: routePostBattleToBuild,
    watcher: routePostBattleToBuild,
  },
};
/** `ceasefire` — CANNON_PLACE prep transition (battle skipped).
 *
 *  Triggered when `shouldSkipBattle(state)` at the top of `startBattle`:
 *  no side has fighting capability, so the battle is skipped at the
 *  engine level. `enterBuildSkippingBattle` does the pre-battle cleanup
 *  (burning-pit decay, wall sweep, territory recheck, modifier clear)
 *  then calls `enterBuildFromBattle` (round increment, upgrade offer
 *  generation). Shows no banner; `postDisplay` routes to
 *  `enter-upgrade-pick` or `enter-wall-build`. Watcher never hits this
 *  transition — the host broadcasts BUILD_START and the watcher routes
 *  through `battle-done`. */
const CEASEFIRE: Transition = {
  id: "ceasefire",
  from: Phase.CANNON_PLACE,
  mutate: {
    host: (ctx) => {
      ctx.log(`ceasefire: skipping battle (round=${ctx.state.round})`);
      ctx.scoreDelta.reset?.();
      ctx.ceasefireSkipBattle?.();
      ctx.broadcast?.buildStart?.(ctx.state);
      return EMPTY_TRANSITION_RESULT;
    },
    // No watcher mutate: host broadcasts BUILD_START and the watcher routes
    // through `battle-done`. Accidental dispatch from a watcher ctx throws
    // via the runner's missing-mutate guard.
  },
  postMutate: clearBattleAnim,
  display: [],
  postDisplay: { host: routePostBattleToBuild },
};
/** `enter-upgrade-pick` — UPGRADE_PICK entry. Flips the phase,
 *  shows the "Choose Upgrade" banner, then runs the picker modal in
 *  `postDisplay`. Dispatched from `battle-done` / `ceasefire`
 *  postDisplay only when `state.modern?.pendingUpgradeOffers` is
 *  populated (modern mode, offers generated in `enterBuildFromBattle`).
 *
 *  The picker modal sits over the same clipping rect as the banner;
 *  resolving all picks dispatches `upgrade-pick-done`. */
const ENTER_UPGRADE_PICK: Transition = {
  id: "enter-upgrade-pick",
  from: [Phase.BATTLE, Phase.CANNON_PLACE],
  mutate: {
    host: (ctx) => {
      setPhase(ctx.state, Phase.UPGRADE_PICK);
      ctx.upgradePick?.prepare();
      return EMPTY_TRANSITION_RESULT;
    },
    watcher: (ctx) => {
      setPhase(ctx.state, Phase.UPGRADE_PICK);
      ctx.upgradePick?.prepare();
      return EMPTY_TRANSITION_RESULT;
    },
  },
  display: [
    {
      kind: STEP_BANNER,
      bannerKind: "upgrade-pick",
      text: BANNER_UPGRADE_PICK,
      subtitle: BANNER_UPGRADE_PICK_SUB,
    },
  ],
  postDisplay: {
    host: runPickerModalThenDispatch,
    watcher: runPickerModalThenDispatch,
  },
};
/** `upgrade-pick-done` — UPGRADE_PICK prep transition. Applies the
 *  picks into state and rechecks territory so the upcoming build
 *  phase's banner reveals the post-pick walls. Shows no banner;
 *  postDisplay dispatches `enter-wall-build`. */
const UPGRADE_PICK_DONE: Transition = {
  id: "upgrade-pick-done",
  from: Phase.UPGRADE_PICK,
  mutate: {
    host: applyUpgradePicksFromDialog,
    watcher: applyUpgradePicksFromDialog,
  },
  display: [],
  postDisplay: {
    host: (ctx) => runTransitionInline("enter-wall-build", ctx),
    watcher: (ctx) => runTransitionInline("enter-wall-build", ctx),
  },
};
/** `enter-wall-build` — WALL_BUILD entry. Flips the phase, tears down
 *  any upgrade-pick dialog, seeds the local build controllers, and
 *  shows the "Build & Repair" banner. Dispatched from `battle-done` /
 *  `ceasefire` prep (when no upgrade offers), or from
 *  `upgrade-pick-done` after all players have resolved their picks.
 *
 *  The dialog teardown runs in `mutate` (not `postDisplay`) so the
 *  banner's B-snapshot renders the clean build scene. If the teardown
 *  were deferred to `postDisplay`, the banner would capture the
 *  picker modal on both sides of the sweep and the map would "pop in"
 *  when the banner ends.
 *
 *  `startBuildPhaseLocal` / `initLocalBuildControllerIfActive` also run
 *  in `mutate` for the same reason: they populate each controller's
 *  `currentBuildPhantoms` (via `startBuildPhase`), which the render
 *  path now reads directly. The B-snapshot is captured between `mutate`
 *  and the banner's display step, so the controllers must be seeded
 *  before that capture — otherwise the "new scene" slice of the banner
 *  sweep shows no piece previews and they pop in at banner end.
 *
 *  postDisplay (host): flips to Mode.GAME (behavioral gate for
 *  input/tick dispatch — not visible state, so not needed before the
 *  B-snapshot).
 *  postDisplay (watcher): anchors the phase timer at banner-end and
 *  flips to Mode.GAME. */
const ENTER_WALL_BUILD: Transition = {
  id: "enter-wall-build",
  from: [Phase.BATTLE, Phase.CANNON_PLACE, Phase.UPGRADE_PICK],
  mutate: {
    host: (ctx) => {
      setPhase(ctx.state, Phase.WALL_BUILD);
      ctx.clearUpgradePickDialog?.();
      ctx.startBuildPhaseLocal?.();
      return EMPTY_TRANSITION_RESULT;
    },
    watcher: (ctx) => {
      setPhase(ctx.state, Phase.WALL_BUILD);
      ctx.clearUpgradePickDialog?.();
      ctx.watcher?.initLocalBuildControllerIfActive();
      return EMPTY_TRANSITION_RESULT;
    },
  },
  display: [
    {
      kind: STEP_BANNER,
      bannerKind: "build",
      text: BANNER_BUILD,
      subtitle: BANNER_BUILD_SUB,
    },
  ],
  postDisplay: {
    host: (ctx) => {
      ctx.setMode(Mode.GAME);
    },
    watcher: (ctx) => {
      ctx.watcher?.setPhaseTimerAtBannerEnd(ctx.state.timer);
      ctx.setMode(Mode.GAME);
    },
  },
};
/** Shared watcher mutate + postDisplay for every transition that enters
 *  CANNON_PLACE (`castle-select-done`, `castle-reselect-done`,
 *  `advance-to-cannon`). The watcher dispatches one id regardless of
 *  host-side source, so all three transitions reuse this bundle.
 *  `applyCannonStart` restores `state.timer` from the checkpoint payload —
 *  no separate override needed since the host serializes it right after
 *  `enterCannonPhase` (which set it to `cannonPlaceTimer`). */
const CANNON_ENTRY_WATCHER_STEP: TransitionStep = {
  mutate: (ctx) => {
    const msg = ctx.incomingMsg as CannonStartData;
    ctx.checkpoint?.applyCannonStart?.(msg);
    setPhase(ctx.state, Phase.CANNON_PLACE);
    return EMPTY_TRANSITION_RESULT;
  },
  postDisplay: (ctx) => {
    ctx.watcher?.setPhaseTimerAtBannerEnd(ctx.state.timer);
    ctx.setMode(Mode.GAME);
    ctx.watcher?.initLocalCannonControllerIfActive();
  },
};
/** `castle-select-done` — CASTLE_SELECT → CANNON_PLACE (round 1 / initial).
 *
 *  Host: `finalizeCastleConstruction` claims territory, spawns houses /
 *  bonus squares; `enterCannonPhase` sets the phase + computes cannon
 *  limits + returns per-player init data; host broadcasts CANNON_START
 *  so watchers can apply the checkpoint.
 *
 *  Display: "Place Cannons" banner.
 *
 *  postDisplay (host): initialize local cannon controllers (placeCannons +
 *  cursor + startCannonPhase) + setMode(GAME). */
const CASTLE_SELECT_DONE: Transition = {
  id: "castle-select-done",
  from: Phase.CASTLE_SELECT,
  mutate: {
    host: (ctx) => {
      finalizeCastleConstruction(ctx.state);
      ctx.clearCastleBuildViewport?.();
      enterCannonPhase(ctx.state);
      ctx.broadcast?.cannonStart?.(ctx.state);
      return EMPTY_TRANSITION_RESULT;
    },
    watcher: CANNON_ENTRY_WATCHER_STEP.mutate,
  },
  postMutate: clearBattleAnim,
  display: [
    {
      kind: STEP_BANNER,
      bannerKind: "cannon-place",
      text: BANNER_PLACE_CANNONS,
      subtitle: BANNER_PLACE_CANNONS_SUB,
    },
  ],
  postDisplay: {
    host: (ctx) => {
      ctx.initLocalCannonControllers?.();
      ctx.setMode(Mode.GAME);
    },
    watcher: CANNON_ENTRY_WATCHER_STEP.postDisplay,
  },
};
/** `castle-reselect-done` — CASTLE_RESELECT → CANNON_PLACE (after a
 *  player lost a life and rebuilt their castle).
 *
 *  Differs from `castle-select-done` only in the prefix: host runs
 *  `finalizeReselectedPlayers` (zone reset protection) BEFORE
 *  `finalizeCastleConstruction`. Rest is identical. */
const CASTLE_RESELECT_DONE: Transition = {
  id: "castle-reselect-done",
  from: Phase.CASTLE_RESELECT,
  mutate: {
    host: (ctx) => {
      // Phase B visuals (deferred from wall-build-done) + reselect-specific
      // finalize + castle finalize, then enter cannon phase. All under the
      // cannons banner reveal.
      finalizeBuildVisuals(ctx.state);
      finalizeReselectedPlayers(ctx.state, ctx.reselectionPids ?? []);
      finalizeCastleConstruction(ctx.state);
      ctx.clearCastleBuildViewport?.();
      enterCannonPhase(ctx.state);
      ctx.broadcast?.cannonStart?.(ctx.state);
      return EMPTY_TRANSITION_RESULT;
    },
    watcher: CANNON_ENTRY_WATCHER_STEP.mutate,
  },
  postMutate: clearBattleAnim,
  display: CASTLE_SELECT_DONE.display,
  postDisplay: CASTLE_SELECT_DONE.postDisplay,
};
/** `advance-to-cannon` — WALL_BUILD → CANNON_PLACE after the life-lost
 *  dialog resolves with "continue" (no reselect, no game over).
 *
 *  Unlike `castle-select-done` / `castle-reselect-done`, this path has NO
 *  finalize prefix: `finalizeBuildPhase` already ran inside the preceding
 *  `wall-build-done` transition, so state is already post-sweep. The
 *  mutate just flips the phase (via `enterCannonPhase`) and broadcasts.
 *
 *  Triggered from `routeLifeLostResolution`'s `onContinue` callback. */
const ADVANCE_TO_CANNON: Transition = {
  id: "advance-to-cannon",
  from: Phase.WALL_BUILD,
  mutate: {
    host: (ctx) => {
      // Phase B visuals (deferred from wall-build-done) run under the
      // cannons banner reveal, then cannon phase entry.
      finalizeBuildVisuals(ctx.state);
      enterCannonPhase(ctx.state);
      ctx.broadcast?.cannonStart?.(ctx.state);
      return EMPTY_TRANSITION_RESULT;
    },
    watcher: CANNON_ENTRY_WATCHER_STEP.mutate,
  },
  postMutate: clearBattleAnim,
  display: CASTLE_SELECT_DONE.display,
  postDisplay: CASTLE_SELECT_DONE.postDisplay,
};
/** `round-limit-reached` — the round counter went past `maxRounds`.
 *  The winner is whoever has the highest score among alive players.
 *  Host-only: watchers receive GAME_OVER via `handleGameOverTransition`,
 *  which writes the game-over frame directly and bypasses the machine. */
const ROUND_LIMIT_REACHED: Transition = {
  id: "round-limit-reached",
  from: "*",
  mutate: {
    host: (ctx) => {
      if (!ctx.winner) {
        throw new Error(
          "round-limit-reached / last-player-standing dispatched without ctx.winner",
        );
      }
      ctx.endGame?.(ctx.winner);
      return EMPTY_TRANSITION_RESULT;
    },
  },
  display: [],
};
/** `last-player-standing` — one or fewer players still alive.
 *  Same shape as `round-limit-reached`; kept as a distinct id because the
 *  trigger semantic differs, which is useful for telemetry / tests.
 *  Host-only (see `round-limit-reached`). */
const LAST_PLAYER_STANDING: Transition = {
  id: "last-player-standing",
  from: "*",
  mutate: ROUND_LIMIT_REACHED.mutate,
  display: [],
};
/** `cannon-place-done` — CANNON_PLACE prep transition. Runs engine
 *  battle entry (`enterBattlePhase`: modifier roll, balloon resolution,
 *  post-modifier territory/wall snapshots) and broadcasts BATTLE_START.
 *  Does NOT flip the phase and shows no banner — `postDisplay` routes
 *  to `enter-modifier-reveal` (when a modifier was rolled) or straight
 *  to `enter-battle`, each of which owns setPhase + its own banner. */
const CANNON_PLACE_DONE: Transition = {
  id: "cannon-place-done",
  from: Phase.CANNON_PLACE,
  mutate: {
    host: (ctx) => {
      ctx.log(`startBattle (round=${ctx.state.round})`);
      ctx.scoreDelta.reset();
      const entry = enterBattlePhase(ctx.state);
      ctx.broadcast?.battleStart?.(
        ctx.state,
        entry.flights,
        entry.modifierDiff,
      );
      return { modifierDiff: entry.modifierDiff, flights: entry.flights };
    },
    watcher: (ctx) => {
      const msg = ctx.incomingMsg as BattleStartData;
      ctx.checkpoint?.applyBattleStart?.(msg);
      return {
        modifierDiff: msg.modifierDiff,
        flights: msg.flights,
      };
    },
  },
  postMutate: syncBattleAnim,
  display: [],
  postDisplay: {
    host: routeCannonPlaceDone,
    watcher: routeCannonPlaceDone,
  },
};
/** `enter-modifier-reveal` — MODIFIER_REVEAL entry. Flips the phase,
 *  primes `state.timer` with `MODIFIER_REVEAL_TIMER` so the phase
 *  behaves like every other timed phase, and shows the modifier-reveal
 *  banner. The tick system (`tickModifierRevealPhase` host-side,
 *  `tickWatcher` watcher-side) counts `state.timer` down and dispatches
 *  `enter-battle` when it reaches 0 — the same pattern as
 *  `tickCannonPhase` → `cannon-place-done`. The banner keeps sweeping
 *  and remains on screen (status = `swept`) until `enter-battle`'s own
 *  banner replaces it.
 *
 *  Only dispatched when `cannon-place-done`'s result carries a
 *  `modifierDiff` (modern mode, modifier actually rolled this round).
 *  The result is threaded through `syncBattleAnim` by the caller but
 *  doesn't need re-running here — the battle-anim snapshots are still
 *  valid for the modifier banner. */
const ENTER_MODIFIER_REVEAL: Transition = {
  id: "enter-modifier-reveal",
  from: Phase.CANNON_PLACE,
  mutate: {
    host: (ctx) => {
      setPhase(ctx.state, Phase.MODIFIER_REVEAL);
      ctx.state.timer = MODIFIER_REVEAL_TIMER;
      return EMPTY_TRANSITION_RESULT;
    },
    watcher: (ctx) => {
      setPhase(ctx.state, Phase.MODIFIER_REVEAL);
      ctx.state.timer = MODIFIER_REVEAL_TIMER;
      return EMPTY_TRANSITION_RESULT;
    },
  },
  display: [
    {
      kind: STEP_BANNER,
      bannerKind: "modifier-reveal",
      text: (r) => modifierDef(r.modifierDiff!.id).label,
      // Decompose the (modifier-domain) diff into banner-agnostic bits:
      // the id becomes an opaque palette key the renderer looks up, and
      // the changed-tile set becomes a generic highlight overlay. The
      // banner system never sees `ModifierDiff` directly.
      paletteKey: (r) => r.modifierDiff?.id,
      revealTiles: (r) => r.modifierDiff?.changedTiles,
    },
  ],
  postDisplay: {
    // Host: flip to Mode.GAME so `tickModifierRevealPhase` runs and
    // dispatches `enter-battle` when `state.timer` hits 0. Do NOT
    // dispatch `enter-battle` here — that's what the timer drives.
    host: (ctx) => {
      ctx.setMode(Mode.GAME);
    },
    // Watcher: same, plus anchor the watcher's wall-clock timer to
    // the current `state.timer` (2s) so `tickWatcherTimers`
    // decrements it from the banner-end instant. The watcher detects
    // timer expiry in its own tick loop and dispatches enter-battle
    // locally — no network message is exchanged for this edge.
    watcher: (ctx) => {
      ctx.watcher?.setPhaseTimerAtBannerEnd(ctx.state.timer);
      ctx.setMode(Mode.GAME);
    },
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
  mutate: {
    host: (ctx) => {
      setPhase(ctx.state, Phase.BATTLE);
      return EMPTY_TRANSITION_RESULT;
    },
    watcher: (ctx) => {
      setPhase(ctx.state, Phase.BATTLE);
      return EMPTY_TRANSITION_RESULT;
    },
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
  postDisplay: {
    host: (ctx) => proceedToBattleFromCtx(ctx),
    watcher: (ctx) => proceedToBattleFromCtx(ctx),
  },
};
const TRANSITIONS: readonly Transition[] = [
  CANNON_PLACE_DONE,
  ENTER_MODIFIER_REVEAL,
  ENTER_BATTLE,
  WALL_BUILD_DONE,
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
export const ROLE_HOST = "host" as const;
export const ROLE_WATCHER = "watcher" as const;

/** Execute a transition. Public entry for both host and watcher.
 *
 *  Runner contract:
 *
 *   1. **Mutate** — runs the role-appropriate mutation (host runs game
 *      logic; watcher applies a checkpoint).
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

  // Mode.TRANSITION held for the entire transition; postDisplay flips to the terminal mode.
  ctx.setMode(Mode.TRANSITION);

  ctx.requestUnzoom(() => {
    executeTransition(transition, ctx);
  });
}

/** Post-cannon-place prep route: dispatch to `enter-modifier-reveal`
 *  when a modifier was rolled (modern mode), otherwise straight to
 *  `enter-battle`. Shared between host and watcher — the host reads
 *  `result.modifierDiff` from its own mutate; the watcher reads from
 *  the incoming BATTLE_START message (also threaded via result).
 *
 *  Uses `runTransitionInline`: the outer prep transition already ran
 *  its requestUnzoom; the inner entry transition doesn't need to wait
 *  another frame for the camera to settle.
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
 *  `ctx.lifeLostRoute`. Host-role supplies handlers that fire the next
 *  transition; watcher-role supplies handlers that only flip
 *  Mode.STOPPED on game-over (the server drives reselect / continue). */
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
  // `requestUnzoom`, and `handlePhaseChangeZoom` no longer implicitly
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
  emitGameEvent(ctx.state.bus, GAME_EVENT.UPGRADE_PICK_END, {
    round: ctx.state.round,
  });
  return EMPTY_TRANSITION_RESULT;
}

/** `enter-upgrade-pick`'s postDisplay (both roles): prepare + show the
 *  picker modal. When all players have resolved their picks (or
 *  auto-skipped) it dispatches `upgrade-pick-done` to continue the
 *  flow. `prepare()` is idempotent — the dialog was already generated
 *  by `enterBuildFromBattle`; `prepare()` just surfaces it. */
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

/** Run a transition synchronously, bypassing the `requestUnzoom` wait.
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

  // Host-only source-phase guard. Watcher collapses multiple host
  // sources into a single dispatched id (e.g. `advance-to-cannon` fires
  // for any of host's three CANNON_START-broadcasting transitions), so
  // the watcher can legitimately be in a different phase than `from`.
  if (ctx.role === ROLE_HOST && transition.from !== "*") {
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
  const mutateFn =
    ctx.role === ROLE_HOST ? transition.mutate.host : transition.mutate.watcher;
  if (!mutateFn) {
    throw new Error(
      `runTransition: transition "${transition.id}" has no ${ctx.role} mutate (host-only transition dispatched from watcher ctx)`,
    );
  }

  // `showBanner` owns the A/B capture per banner (see
  // `runtime-banner.ts`). The transition runner doesn't snapshot
  // anything — each banner reads the current display pixels as its
  // own prev-scene (A), forces a render to flush any queued mutation,
  // and captures the resulting pixels as its new-scene (B).
  const mutated = mutateFn(ctx);
  const result: TransitionResult = seedResult
    ? { ...mutated, ...seedResult }
    : mutated;
  transition.postMutate?.(ctx, result);

  runDisplay(transition.display, ctx, result, () => {
    const postDisplay =
      ctx.role === ROLE_HOST
        ? transition.postDisplay?.host
        : transition.postDisplay?.watcher;
    postDisplay?.(ctx, result);
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
  result: TransitionResult,
  onDone: () => void,
): void {
  const text = typeof step.text === "function" ? step.text(result) : step.text;
  ctx.showBanner({
    text,
    kind: step.bannerKind,
    onDone,
    subtitle: step.subtitle,
    paletteKey: step.paletteKey?.(result),
    revealTiles: step.revealTiles?.(result),
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
  // requestUnzoom ran at the top of this transition). Re-engage
  // auto-zoom so the popup appears over the pov player's zone.
  ctx.engageAutoZoom?.();
  emitGameEvent(ctx.state.bus, GAME_EVENT.LIFE_LOST_DIALOG_SHOW, {
    needsReselect,
    eliminated,
    round: ctx.state.round,
  });
  ctx.lifeLost.show(needsReselect, eliminated, finish);
}
