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
import type {
  ModifierDiff,
  ModifierId,
} from "../shared/core/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import { modifierDef } from "../shared/core/modifier-defs.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type { GameState } from "../shared/core/types.ts";
import type { UpgradePickDialogState } from "../shared/ui/interaction-types.ts";
import type { SceneCapture } from "../shared/ui/overlay-types.ts";
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
import type { BannerShow } from "./runtime-contracts.ts";
import {
  type GameOverReason,
  resolveAfterLifeLost,
} from "./runtime-life-lost-core.ts";
import type { RuntimeState } from "./runtime-state.ts";
import type { BuildEndSummary } from "./runtime-types.ts";

export type TransitionId =
  | "castle-select-done"
  | "castle-reselect-done"
  | "advance-to-cannon"
  | "wall-build-done"
  | "cannon-place-done"
  | "battle-done"
  | "ceasefire"
  | "round-limit-reached"
  | "last-player-standing";

/** Opaque result produced by a transition's mutate fn, threaded through the
 *  display steps. */
interface TransitionResult {
  readonly modifierDiff?: ModifierDiff | null;
  readonly flights?: readonly BalloonFlight[];
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
      /** Static text, or a function of the mutation result (used by the
       *  modifier-reveal banner which reads the modifier label from the
       *  result). */
      readonly text: string | ((r: TransitionResult) => string);
      readonly subtitle?: string;
      /** Set on the modifier-reveal banner step. Resolved at dispatch
       *  time and forwarded to the banner system so the bannerStart
       *  event can distinguish modifier reveals from plain phase
       *  banners. Function form reads the id out of the transition
       *  result (the rolled modifier lives there). */
      readonly modifierId?: (r: TransitionResult) => ModifierId | undefined;
      /** Optional predicate: skip when false. Used for modifier-reveal
       *  (only when a modifier was rolled) and upgrade-pick (only when
       *  offers are pending). */
      readonly when?: (state: GameState, r: TransitionResult) => boolean;
    }
  | { readonly kind: "score-overlay" }
  | { readonly kind: "life-lost-dialog" }
  | {
      readonly kind: "upgrade-pick";
      readonly when?: (state: GameState, r: TransitionResult) => boolean;
    };

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
  /** Source phase asserted on host dispatch. `"*"` opts out of the guard
   *  (used by game-over transitions which may fire from any phase). */
  readonly from: Phase | "*";
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

  readonly showBanner: BannerShow;
  /** Capture the current scene for a banner's prev-scene. Stamped with
   *  the monotonic banner-clock tick. Callers pass the result into
   *  `showBanner({ prevScene })`. Returns `undefined` in headless tests
   *  (no canvas) — `showBanner` accepts that as "no fade, just sweep". */
  readonly captureScene: () => SceneCapture | undefined;
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

/** Discriminator values for `DisplayStep.kind` / `PhaseTransitionCtx.role`. */
const STEP_BANNER = "banner" as const;
const STEP_SCORE_OVERLAY = "score-overlay" as const;
const STEP_LIFE_LOST_DIALOG = "life-lost-dialog" as const;
const STEP_UPGRADE_PICK = "upgrade-pick" as const;
/** `cannon-place-done` — CANNON_PLACE → BATTLE.
 *
 *  Host: `enterBattlePhase` computes the modifier, balloon flights, and the
 *  post-modifier territory/wall snapshots; the host broadcasts BATTLE_START.
 *
 *  Watcher: `applyBattleStart` is the symmetric counterpart — it
 *  deserializes the checkpoint, applies modifier tiles, recomputes
 *  territory, and sets Phase.BATTLE (so PHASE_END/PHASE_START fire).
 *  Both paths leave state in the same post-modifier, post-setPhase shape;
 *  `postMutate: syncBattleAnim` rebuilds battleAnim from that state.
 *
 *  Display: conditional modifier-reveal banner (when modifier rolled) →
 *  "Prepare for Battle" banner. Each banner captures its own prev-scene
 *  at `showBanner` time (see `runBannerStep`) — the modifier banner
 *  captures the pre-modifier scene before its sweep starts; by the time
 *  the battle banner's `showBanner` fires, the modifier's tile changes
 *  have finished rendering and the capture naturally reflects them.
 *
 *  postDisplay: flights > 0 → BALLOON_ANIM mode; else begin battle. */
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
      setPhase(ctx.state, Phase.BATTLE);
      return {
        modifierDiff: msg.modifierDiff ?? null,
        flights: msg.flights ?? [],
      };
    },
  },
  postMutate: syncBattleAnim,
  display: [
    {
      kind: STEP_BANNER,
      text: (r) => modifierDef(r.modifierDiff!.id).label,
      modifierId: (r) => r.modifierDiff?.id,
      when: (_, r) => !!r.modifierDiff,
    },
    {
      kind: STEP_BANNER,
      text: BANNER_BATTLE,
      subtitle: BANNER_BATTLE_SUB,
    },
  ],
  postDisplay: {
    host: (ctx, result) => proceedToBattle(ctx, result.flights ?? []),
    watcher: (ctx, result) => proceedToBattle(ctx, result.flights ?? []),
  },
};
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
      return { needsReselect, eliminated };
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
/** Shared display list for every transition that enters WALL_BUILD and
 *  shows the "Build & Repair" banner (optionally preceded by the
 *  upgrade-pick chain when modern-mode offers are pending). Used by
 *  `battle-done` and `ceasefire`. */
const BUILD_ENTRY_DISPLAY: readonly DisplayStep[] = [
  {
    kind: STEP_UPGRADE_PICK,
    when: (state) => !!state.modern?.pendingUpgradeOffers,
  },
  {
    kind: STEP_BANNER,
    text: BANNER_BUILD,
    subtitle: BANNER_BUILD_SUB,
  },
];
/** Shared host postDisplay for every transition that enters WALL_BUILD:
 *  tear down any upgrade-pick dialog, flip the UI mode back to GAME, and
 *  run the host-side build-phase setup (score-delta reset, controller
 *  startBuildPhase, accumulator resets). Used by both `battle-done` and
 *  `ceasefire`. */
const buildEntryHostPostDisplay = (ctx: PhaseTransitionCtx): void => {
  ctx.clearUpgradePickDialog?.();
  ctx.setMode(Mode.GAME);
  ctx.startBuildPhaseLocal?.();
};
/** `battle-done` — BATTLE → WALL_BUILD.
 *
 *  Host: ends battle per local controller (clears fire targets, etc.),
 *  saves the human crosshair for next battle, runs `enterBuildPhase`
 *  (sets phase to WALL_BUILD + engine-level build state), broadcasts
 *  BUILD_START so watchers can apply.
 *
 *  Display: optional "Choose Upgrade" chain (modern mode, when there are
 *  pending upgrade offers) → "Build & Repair" banner.
 *
 *  postDisplay (host): clear the upgrade-pick dialog if it was shown,
 *  setMode(GAME), then run the host-side build-phase setup
 *  (`startBuildPhaseLocal`) which resets score-delta pre-scores, cannon
 *  facings, controller build state, impacts, and accumulators. */
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
      return {};
    },
    watcher: (ctx) => {
      const msg = ctx.incomingMsg as BuildStartData;
      ctx.checkpoint?.applyBuildStart?.(msg);
      setPhase(ctx.state, Phase.WALL_BUILD);
      return {};
    },
  },
  postMutate: clearBattleAnim,
  display: BUILD_ENTRY_DISPLAY,
  postDisplay: {
    // Host's phase timer is driven by `enterBuildPhase` (engine-level)
    // plus `startBuildPhaseLocal` inside `buildEntryHostPostDisplay`
    // (controller resets + accumulator clears), so no explicit anchor is
    // needed. Watcher has no engine-level tick, so it anchors its phase
    // timer at the banner-end moment to match the host's ticking baseline.
    host: buildEntryHostPostDisplay,
    watcher: (ctx) => {
      ctx.watcher?.setPhaseTimerAtBannerEnd(ctx.state.timer);
      ctx.clearUpgradePickDialog?.();
      ctx.setMode(Mode.GAME);
      ctx.watcher?.initLocalBuildControllerIfActive();
    },
  },
};
/** `ceasefire` — CANNON_PLACE → WALL_BUILD (battle skipped).
 *
 *  Triggered when `shouldSkipBattle(state)` at the top of `startBattle`:
 *  no side has fighting capability, so the battle is skipped at the
 *  engine level. State flips straight to WALL_BUILD via
 *  `enterBuildSkippingBattle` (burning-pit decay, wall sweep, territory
 *  recheck, modifier clear, then enterBuildFromBattle). The UI flow is
 *  identical to `battle-done`: optional upgrade-pick → "Build & Repair"
 *  banner → setMode(GAME) + startBuildPhaseLocal. Watcher never hits this
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
      return {};
    },
    // No watcher mutate: host broadcasts BUILD_START and the watcher routes
    // through `battle-done`. Accidental dispatch from a watcher ctx throws
    // via the runner's missing-mutate guard.
  },
  postMutate: clearBattleAnim,
  display: BUILD_ENTRY_DISPLAY,
  postDisplay: { host: buildEntryHostPostDisplay },
};
/** Shared watcher mutate for every transition that enters CANNON_PLACE
 *  (`castle-select-done`, `castle-reselect-done`, `advance-to-cannon`).
 *  The watcher dispatches one id regardless of host-side source, so all
 *  three transitions point their `mutate.watcher` at this fn.
 *  `applyCannonStart` restores `state.timer` from the checkpoint payload —
 *  no separate override needed since the host serializes it right after
 *  `enterCannonPhase` (which set it to `cannonPlaceTimer`). */
const CANNON_ENTRY_WATCHER_MUTATE = (
  ctx: PhaseTransitionCtx,
): TransitionResult => {
  const msg = ctx.incomingMsg as CannonStartData;
  ctx.checkpoint?.applyCannonStart?.(msg);
  setPhase(ctx.state, Phase.CANNON_PLACE);
  return {};
};
/** Shared watcher postDisplay paired with `CANNON_ENTRY_WATCHER_MUTATE`. */
const CANNON_ENTRY_WATCHER_POSTDISPLAY = (ctx: PhaseTransitionCtx): void => {
  ctx.watcher?.setPhaseTimerAtBannerEnd(ctx.state.timer);
  ctx.setMode(Mode.GAME);
  ctx.watcher?.initLocalCannonControllerIfActive();
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
      return {};
    },
    watcher: CANNON_ENTRY_WATCHER_MUTATE,
  },
  postMutate: clearBattleAnim,
  display: [
    {
      kind: STEP_BANNER,
      text: BANNER_PLACE_CANNONS,
      subtitle: BANNER_PLACE_CANNONS_SUB,
    },
  ],
  postDisplay: {
    host: (ctx) => {
      ctx.initLocalCannonControllers?.();
      ctx.setMode(Mode.GAME);
    },
    watcher: CANNON_ENTRY_WATCHER_POSTDISPLAY,
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
      return {};
    },
    watcher: CANNON_ENTRY_WATCHER_MUTATE,
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
 *  Triggered from the life-lost resolve chain's `onContinue` callback. */
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
      return {};
    },
    watcher: CANNON_ENTRY_WATCHER_MUTATE,
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
      return {};
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
const TRANSITIONS: readonly Transition[] = [
  CANNON_PLACE_DONE,
  WALL_BUILD_DONE,
  BATTLE_DONE,
  CEASEFIRE,
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
/** Safety fallback if the PITCH_SETTLED bus event never fires (tab
 *  hidden, paused timing, etc.). Far longer than PITCH_DURATION (0.6s)
 *  so a normal tilt-in never hits the timeout — it only trips on a
 *  stalled camera. Balloon anim still fires, just under the
 *  not-quite-settled view. */
const BALLOON_ANIM_TILT_TIMEOUT_MS = 1500;
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
 *   3. **Display** — walks `display` steps in order. Each banner step
 *      captures its own `prevScene` at `showBanner`-time (see
 *      `runBannerStep`), so the snapshot reflects whatever the user
 *      was last shown — pre-mutation for the first banner in a chain,
 *      post-previous-banner for each subsequent one. No mutation-site
 *      capture, no `recaptureAfter` — one rule, everywhere.
 *
 *   4. **postDisplay** — side-effects after all display steps (setMode,
 *      startBuildPhase, beginBattle, etc.).
 *
 *  Callback-based, not Promise-based: the tick loop is synchronous so
 *  microtasks don't flush between ticks; every wait threads through the
 *  subsystem's own callback. */
export function runTransition(id: TransitionId, ctx: PhaseTransitionCtx): void {
  const transition = BY_ID.get(id);
  if (!transition) {
    throw new Error(`runTransition: unknown transition id "${id}"`);
  }

  // Host-only source-phase guard. Watcher collapses multiple host
  // sources into a single dispatched id (e.g. `advance-to-cannon` fires
  // for any of host's three CANNON_START-broadcasting transitions), so
  // the watcher can legitimately be in a different phase than `from`.
  if (
    ctx.role === ROLE_HOST &&
    transition.from !== "*" &&
    ctx.state.phase !== transition.from
  ) {
    throw new Error(
      `runTransition: transition "${id}" expects phase "${transition.from}" but state is in "${ctx.state.phase}"`,
    );
  }

  const mutateFn =
    ctx.role === ROLE_HOST ? transition.mutate.host : transition.mutate.watcher;
  if (!mutateFn) {
    throw new Error(
      `runTransition: transition "${id}" has no ${ctx.role} mutate (host-only transition dispatched from watcher ctx)`,
    );
  }

  // Lock interaction the instant we start a transition. Setting
  // Mode.BANNER before mutate runs:
  //   - Blocks the per-mode tick dispatcher: `ticks[mode]` becomes
  //     `tickBanner` (a no-op while `banner.active` is false) instead
  //     of the gameplay tick that just dispatched us. That stops the
  //     immediate caller (tickCannonPhase → startBattle → runTransition)
  //     from re-firing the same transition on the next sub-step, which
  //     would otherwise double-run `finalizeCannonPhase` and corrupt
  //     controller state.
  //   - Gates player input (isInteractiveMode returns false for BANNER),
  //     so the user can't interact in the NEW phase during the unzoom
  //     lerp before the banner actually appears.
  ctx.setMode(Mode.BANNER);

  // The hard ordering rule (matches the spec):
  //
  //   1. Unzoom FIRST. The camera reaches fullMapVp while the pre-mutate
  //      scene is still live on screen (no house spawn, no modifier
  //      tiles applied, no wall sweep yet). `requestUnzoom` clears
  //      cameraZone + pinchVp (persisting the pinch into the phase slot)
  //      and fires `onReady` the first post-render frame where currentVp
  //      has converged to fullMapVp.
  //
  //   2. Capture the full-map pre-mutate scene. This is the frame the
  //      first banner's sweep will reveal FROM.
  //
  //   3. Mutate + postMutate. Phase flips, houses / bonus squares spawn,
  //      modifier tiles apply, walls sweep — all happening in the same
  //      tick as the first banner's `showBanner`, so the next rendered
  //      frame is already under banner cover. No pop window.
  //
  //   4. Run the display chain. The first banner receives the pre-mutate
  //      scene as its prevScene; each subsequent banner captures fresh
  //      at show-time (the previous banner's sweep-end frame).
  //
  //   5. postDisplay runs after the chain completes (setMode(GAME),
  //      controller init, balloon-anim / beginBattle). `handlePhaseChangeZoom`
  //      then re-engages auto-zoom for the new phase.
  ctx.requestUnzoom(() => {
    const preMutateScene = ctx.captureScene();
    const result = mutateFn(ctx);
    transition.postMutate?.(ctx, result);
    runDisplay(transition.display, ctx, result, preMutateScene, () => {
      const postDisplay =
        ctx.role === ROLE_HOST
          ? transition.postDisplay?.host
          : transition.postDisplay?.watcher;
      postDisplay?.(ctx, result);
    });
  });
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

/** Walk the display steps in order, calling `onDone` after the last step
 *  completes. Each step registers `onDone` with its subsystem callback.
 *
 *  `initialPrevScene` is the pre-mutate full-map snapshot captured at the
 *  top of the transition (see `runTransition`). The FIRST banner-like
 *  step (banner or upgrade-pick) consumes it as its prev-scene so the
 *  sweep reveals from pre-mutate to post-mutate. Subsequent steps receive
 *  `undefined` and fall back to `ctx.captureScene()` at show-time (which
 *  reads the previous banner's sweep-end frame). Non-banner steps
 *  (score-overlay, life-lost-dialog) ignore it and pass it along to the
 *  next step so the first banner in the chain still gets it. */
function runDisplay(
  steps: readonly DisplayStep[],
  ctx: PhaseTransitionCtx,
  result: TransitionResult,
  initialPrevScene: SceneCapture | undefined,
  onDone: () => void,
): void {
  if (steps.length === 0) {
    onDone();
    return;
  }
  const [first, ...rest] = steps;
  const consumesBanner =
    first!.kind === STEP_BANNER || first!.kind === STEP_UPGRADE_PICK;
  const passToFirst = consumesBanner ? initialPrevScene : undefined;
  const passToRest = consumesBanner ? undefined : initialPrevScene;
  runStep(first!, ctx, result, passToFirst, () =>
    runDisplay(rest, ctx, result, passToRest, onDone),
  );
}

/** Shared post-mutation sync for battle ENTRY (cannon-place-done): clear
 *  transient battle-anim visuals and rebuild the per-player territory /
 *  wall snapshots from the freshly-mutated state. Host and watcher arrive
 *  at the same post-state through different routes, so this step is
 *  identical for both and lives in `postMutate`. */
function syncBattleAnim(ctx: PhaseTransitionCtx): void {
  clearBattleAnim(ctx);
  ctx.battle.setTerritory(snapshotTerritory(ctx.state.players));
  ctx.battle.setWalls(snapshotAllWalls(ctx.state));
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

function proceedToBattle(
  ctx: PhaseTransitionCtx,
  flights: readonly BalloonFlight[],
): void {
  // Spec: `battle banner → tilt → balloons (skip if none) → ready → zoom`.
  // Tilt begins here (at battle-banner end) so it plays UNZOOMED, before
  // anything else. The phase machine has already reached fullMapVp via
  // `requestUnzoom`, and `handlePhaseChangeZoom` no longer implicitly
  // engages the tilt / auto-zoom — auto-zoom re-engages when mode flips
  // back to GAME inside `battle.begin`, which also starts the "ready"
  // countdown, so the zoom lerp and "ready" cue start together.
  ctx.beginBattleTilt?.();

  const hasFlights = flights.length > 0;
  if (hasFlights) {
    ctx.battle.setFlights(flights.map((flight) => ({ flight, progress: 0 })));
    ctx.setMode(Mode.BALLOON_ANIM);
  }

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
  let fired = false;
  const fireOnce = (): void => {
    if (fired) return;
    fired = true;
    bus.off(GAME_EVENT.PITCH_SETTLED, onPitchSettled);
    clearTimeout(timer);
    proceed();
  };
  const onPitchSettled = (): void => fireOnce();
  bus.on(GAME_EVENT.PITCH_SETTLED, onPitchSettled);
  const timer = setTimeout(fireOnce, BALLOON_ANIM_TILT_TIMEOUT_MS);
}

function runStep(
  step: DisplayStep,
  ctx: PhaseTransitionCtx,
  result: TransitionResult,
  prevScene: SceneCapture | undefined,
  onDone: () => void,
): void {
  switch (step.kind) {
    case STEP_BANNER:
      runBannerStep(step, ctx, result, prevScene, onDone);
      return;
    case STEP_SCORE_OVERLAY:
      ctx.scoreDelta.show(onDone);
      return;
    case STEP_LIFE_LOST_DIALOG:
      runLifeLostDialogStep(ctx, result, onDone);
      return;
    case STEP_UPGRADE_PICK:
      runUpgradePickStep(step, ctx, result, prevScene, onDone);
      return;
  }
}

function runBannerStep(
  step: Extract<DisplayStep, { kind: "banner" }>,
  ctx: PhaseTransitionCtx,
  result: TransitionResult,
  prevScene: SceneCapture | undefined,
  onDone: () => void,
): void {
  if (step.when && !step.when(ctx.state, result)) {
    onDone();
    return;
  }
  const text = typeof step.text === "function" ? step.text(result) : step.text;
  const modifierId = step.modifierId?.(result);
  // First banner in the chain: `prevScene` is the pre-mutate full-map
  // capture taken inside `runTransition`'s unzoom-ready callback — the
  // sweep reveals post-mutate (house spawn, modifier tiles, wall
  // sweep) FROM that frame. Subsequent banners: `prevScene` is
  // undefined, so we capture the previous banner's sweep-end frame via
  // `ctx.captureScene()`.
  ctx.showBanner({
    text,
    onDone,
    subtitle: step.subtitle,
    modifierId,
    prevScene: prevScene ?? ctx.captureScene(),
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
  if (!ctx.lifeLost) {
    finish([]);
    return;
  }
  if (needsReselect.length === 0 && eliminated.length === 0) {
    ctx.lifeLost.show([], [], finish);
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

/** Upgrade-pick display step — composes the three-part chain:
 *
 *   1. `prepare()` — builds the offers (synchronous).
 *   2. "Choose Upgrade" banner — sweeps while the dialog fades in beneath
 *      it (the dialog is drawn with an inverted clip rect keyed to the
 *      banner's sweep y).
 *   3. `tryShow(onDone)` — modal dialog; fires `onDone` once all players
 *      have picked or auto-skipped.
 *
 *  If the predicate is false, no offers are prepared, or no dialog is
 *  required, the step resolves immediately. */
function runUpgradePickStep(
  step: Extract<DisplayStep, { kind: "upgrade-pick" }>,
  ctx: PhaseTransitionCtx,
  result: TransitionResult,
  prevScene: SceneCapture | undefined,
  onDone: () => void,
): void {
  if (step.when && !step.when(ctx.state, result)) {
    onDone();
    return;
  }
  const picker = ctx.upgradePick;
  if (!picker || !picker.prepare()) {
    onDone();
    return;
  }
  emitGameEvent(ctx.state.bus, GAME_EVENT.UPGRADE_PICK_SHOW, {
    round: ctx.state.round,
  });
  ctx.showBanner({
    text: BANNER_UPGRADE_PICK,
    subtitle: BANNER_UPGRADE_PICK_SUB,
    prevScene: prevScene ?? ctx.captureScene(),
    onDone: () => {
      // All players have resolved their picks (or auto-skipped). Apply
      // the picks + recompute territory; the NEXT banner in the chain
      // (the build-phase banner inserted by `BUILD_ENTRY_DISPLAY`) will
      // capture its own prev-scene at its `showBanner` time — which, by
      // the time it fires, reflects the post-pick frame the user just
      // saw. No manual snapshotting here.
      const afterPicks = () => {
        const dialog = picker.getDialog();
        if (dialog) {
          applyUpgradePicks(ctx.state, dialog);
          recheckTerritory(ctx.state);
        }
        emitGameEvent(ctx.state.bus, GAME_EVENT.UPGRADE_PICK_END, {
          round: ctx.state.round,
        });
        onDone();
      };
      if (!picker.tryShow(afterPicks)) afterPicks();
    },
  });
}
