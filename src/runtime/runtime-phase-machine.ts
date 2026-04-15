/**
 * Phase transition state machine.
 *
 * Every phase transition (CASTLE_SELECT → CANNON_PLACE, WALL_BUILD →
 * CANNON_PLACE, CANNON_PLACE → BATTLE, BATTLE → WALL_BUILD, reselect, game
 * over) is an entry in `TRANSITIONS`. Each entry declares:
 *
 *   - `from` / `to` phase
 *   - `mutate`: the pair of functions (host + watcher) that apply the state
 *     change — host runs game logic, watcher applies an incoming checkpoint
 *   - `display`: the ordered UI steps that play between mutation and arrival
 *     at `to` (banner / score-overlay / life-lost-dialog / upgrade-pick)
 *   - `postDisplay`: side-effects that complete the transition after the
 *     display steps (e.g. balloon-anim vs begin-battle)
 *
 * `runTransition(id, ctx)` executes the entry: runs the role-appropriate
 * mutate, walks the display steps in order, then runs postDisplay. Host and
 * watcher call the same runner; only the `mutate` fn differs.
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
import type { ModifierDiff } from "../shared/core/game-constants.ts";
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
import type { BannerShow } from "./runtime-contracts.ts";
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

/** Target of a transition. `"game-over"` is a sentinel — the machine routes
 *  it to the game-over frame rather than a Phase. */
type TransitionTarget = Phase | "game-over";

/** Opaque result produced by a transition's mutate fn, threaded through the
 *  display steps. */
interface TransitionResult {
  readonly modifierDiff?: ModifierDiff | null;
  readonly flights?: readonly BalloonFlight[];
  readonly needsReselect?: readonly ValidPlayerSlot[];
  readonly eliminated?: readonly ValidPlayerSlot[];
  readonly preScores?: readonly number[];
}

type DisplayStep =
  | {
      readonly kind: "banner";
      /** Static text, or a function of the mutation result (used by the
       *  modifier-reveal banner which reads the modifier label from the
       *  result). */
      readonly text: string | ((r: TransitionResult) => string);
      readonly subtitle?: string;
      /** Optional predicate: skip when false. Used for modifier-reveal
       *  (only when a modifier was rolled) and upgrade-pick (only when
       *  offers are pending). */
      readonly when?: (state: GameState, r: TransitionResult) => boolean;
      /** When the banner's own animation was a visible mutation reveal
       *  and a subsequent banner in the chain follows, take a fresh
       *  `prevSceneImageData` snapshot at this banner's `onDone`. Example:
       *  the modifier-reveal banner reveals tile changes; the battle
       *  banner that chains afterwards needs prev = post-modifier so it
       *  doesn't flash pre-modifier tiles below its sweep. */
      readonly recaptureAfter?: boolean;
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
  readonly from: Phase | "*";
  readonly toPhase: TransitionTarget;
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
  /** Grab the current offscreen scene pixels into
   *  `banner.prevSceneImageData`. Call this immediately before any
   *  map-mutating block whose visual delta the next banner should reveal.
   *  No-op in headless tests (ascii renderer returns `undefined`). */
  readonly snapshotForNextBanner: () => void;
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
   *  transitions may omit. */
  readonly lifeLost?: {
    readonly tryShow: (
      needsReselect: readonly ValidPlayerSlot[],
      eliminated: readonly ValidPlayerSlot[],
    ) => boolean;
    /** Resolve the life-lost flow (either via user dialog action or by
     *  immediate advance when no dialog was needed). Passing an empty
     *  `continuing` list signals "nobody to reselect" and routes to the
     *  continue / game-over branch. */
    readonly resolve: (continuing?: readonly ValidPlayerSlot[]) => void;
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

  readonly sound: {
    readonly drumsStop: () => void;
    readonly lifeLost?: () => void;
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
  /** Quiet the selection drum-roll sound — called when castle construction
   *  wraps up and the cannons banner starts. */
  readonly soundDrumsQuiet?: () => void;
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
const STEP_LIFE_LOST_DIALOG = "life-lost-dialog" as const;
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
 *  "Prepare for Battle" banner. The modifier banner's `recaptureAfter`
 *  grabs the post-modifier scene so the battle banner reveals against it.
 *
 *  postDisplay: flights > 0 → BALLOON_ANIM mode; else begin battle. */
const CANNON_PLACE_DONE: Transition = {
  id: "cannon-place-done",
  from: Phase.CANNON_PLACE,
  toPhase: Phase.BATTLE,
  mutate: {
    host: (ctx) => {
      ctx.sound.drumsStop();
      ctx.log(`startBattle (round=${ctx.state.round})`);
      ctx.scoreDelta.reset();
      // Snapshot the cannon-placement scene before entering battle —
      // `enterBattlePhase` rolls the modifier, which applies tile changes
      // (high-tide, frozen-river, etc.) that the modifier / battle banner
      // is supposed to reveal. Without this, the prev-scene is whatever
      // was captured at the last cannons banner (pre-houses) and the
      // battle banner briefly shows a stale map without houses/cannons.
      ctx.snapshotForNextBanner();
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
      // See host mutate comment — snapshot before applyBattleStart so the
      // battle / modifier banner reveals the modifier's tile changes.
      // `applyBattleStart` is the watcher-side counterpart to
      // `enterBattlePhase`: when it returns, state is already in
      // Phase.BATTLE with recomputed, post-modifier territory.
      ctx.snapshotForNextBanner();
      ctx.checkpoint?.applyBattleStart?.(msg);
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
      when: (_, r) => !!r.modifierDiff,
      // Modifier banner revealed the tile changes — refresh snapshot so
      // the battle banner that follows doesn't re-reveal pre-modifier
      // tiles below its sweep line.
      recaptureAfter: true,
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
 *  Display: score-overlay animation first, then life-lost-dialog step
 *  (which either shows the modal dialog for affected players or calls
 *  `lifeLost.resolve()` to advance directly).
 *
 *  The `to` phase is nominally CANNON_PLACE but this transition itself
 *  does NOT call `setPhase`: the continuation (reselect vs continue vs
 *  game-over) is driven by the life-lost resolve chain, which fires the
 *  next transition (castle-reselect-done / castle-select-done-for-cannons
 *  / game-over) once the user resolves the dialog. */
const WALL_BUILD_DONE: Transition = {
  id: "wall-build-done",
  from: Phase.WALL_BUILD,
  toPhase: Phase.CANNON_PLACE,
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
  display: [{ kind: "score-overlay" }, { kind: STEP_LIFE_LOST_DIALOG }],
};
/** Shared display list for every transition that enters WALL_BUILD and
 *  shows the "Build & Repair" banner (optionally preceded by the
 *  upgrade-pick chain when modern-mode offers are pending). Used by
 *  `battle-done` and `ceasefire`. */
const BUILD_ENTRY_DISPLAY: readonly DisplayStep[] = [
  {
    kind: "upgrade-pick",
    when: (state) => !!state.modern?.pendingUpgradeOffers,
  },
  {
    kind: STEP_BANNER,
    text: BANNER_BUILD,
    subtitle: BANNER_BUILD_SUB,
  },
];
/** Shared postDisplay for the ceasefire path — mirrors `battle-done`'s
 *  host postDisplay (clear upgrade dialog + setMode + startBuildPhaseLocal)
 *  with a no-op watcher since the ceasefire transition is host-only. */
const BUILD_ENTRY_POSTDISPLAY_CEASEFIRE: PostDisplayFns = {
  host: (ctx) => {
    ctx.clearUpgradePickDialog?.();
    ctx.setMode(Mode.GAME);
    ctx.startBuildPhaseLocal?.();
  },
  watcher: () => {},
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
  toPhase: Phase.WALL_BUILD,
  mutate: {
    host: (ctx) => {
      ctx.endBattleLocalControllers?.();
      ctx.saveBattleCrosshair?.();
      ctx.snapshotForNextBanner();
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
      ctx.snapshotForNextBanner();
      ctx.checkpoint?.applyBuildStart?.(msg);
      setPhase(ctx.state, Phase.WALL_BUILD);
      return {};
    },
  },
  display: BUILD_ENTRY_DISPLAY,
  postDisplay: {
    host: (ctx) => {
      ctx.clearUpgradePickDialog?.();
      ctx.setMode(Mode.GAME);
      ctx.startBuildPhaseLocal?.();
    },
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
  toPhase: Phase.WALL_BUILD,
  mutate: {
    host: (ctx) => {
      ctx.sound.drumsStop();
      ctx.log(`ceasefire: skipping battle (round=${ctx.state.round})`);
      ctx.scoreDelta.reset?.();
      ctx.snapshotForNextBanner();
      ctx.ceasefireSkipBattle?.();
      ctx.broadcast?.buildStart?.(ctx.state);
      return {};
    },
    watcher: () => ({}),
  },
  display: BUILD_ENTRY_DISPLAY,
  postDisplay: BUILD_ENTRY_POSTDISPLAY_CEASEFIRE,
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
const CANNON_ENTRY_WATCHER_MUTATE = (
  ctx: PhaseTransitionCtx,
): TransitionResult => {
  const msg = ctx.incomingMsg as CannonStartData;
  ctx.snapshotForNextBanner();
  ctx.checkpoint?.applyCannonStart?.(msg);
  setPhase(ctx.state, Phase.CANNON_PLACE);
  ctx.state.timer = ctx.state.cannonPlaceTimer;
  return {};
};
const CANNON_ENTRY_WATCHER_POSTDISPLAY = (ctx: PhaseTransitionCtx): void => {
  ctx.watcher?.setPhaseTimerAtBannerEnd(ctx.state.timer);
  ctx.setMode(Mode.GAME);
  ctx.watcher?.initLocalCannonControllerIfActive();
};
const CASTLE_SELECT_DONE: Transition = {
  id: "castle-select-done",
  from: Phase.CASTLE_SELECT,
  toPhase: Phase.CANNON_PLACE,
  mutate: {
    host: (ctx) => {
      ctx.soundDrumsQuiet?.();
      ctx.snapshotForNextBanner();
      finalizeCastleConstruction(ctx.state);
      ctx.clearCastleBuildViewport?.();
      enterCannonPhase(ctx.state);
      ctx.broadcast?.cannonStart?.(ctx.state);
      return {};
    },
    watcher: CANNON_ENTRY_WATCHER_MUTATE,
  },
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
  toPhase: Phase.CANNON_PLACE,
  mutate: {
    host: (ctx) => {
      ctx.soundDrumsQuiet?.();
      ctx.snapshotForNextBanner();
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
  toPhase: Phase.CANNON_PLACE,
  mutate: {
    host: (ctx) => {
      ctx.soundDrumsQuiet?.();
      ctx.snapshotForNextBanner();
      // Phase B visuals (deferred from wall-build-done) run under the
      // cannons banner reveal, then cannon phase entry.
      finalizeBuildVisuals(ctx.state);
      enterCannonPhase(ctx.state);
      ctx.broadcast?.cannonStart?.(ctx.state);
      return {};
    },
    watcher: CANNON_ENTRY_WATCHER_MUTATE,
  },
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
  toPhase: "game-over",
  mutate: {
    host: (ctx) => {
      if (ctx.winner) ctx.endGame?.(ctx.winner);
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
  toPhase: "game-over",
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
export const ROLE_HOST = "host" as const;
export const ROLE_WATCHER = "watcher" as const;

/** Execute a transition. Public entry for both host and watcher.
 *
 *  Runner contract:
 *
 *   1. **Capture pre-mutation scene** — `banner.prevSceneImageData` is set
 *      to `captureScene()` BEFORE `mutate` runs. Every banner step in the
 *      transition's `display` array composites this snapshot below its
 *      sweep line. If a chained banner needs a mid-sweep recapture (e.g.
 *      modifier reveal → battle banner), the first banner step sets
 *      `recaptureAfter: true`.
 *
 *   2. **Mutate** — runs the role-appropriate mutation (host runs game
 *      logic; watcher applies a checkpoint).
 *
 *   3. **Display** — walks `display` steps in order, each calling its
 *      `onDone` when the underlying subsystem finishes (banner sweep
 *      completes, score-delta timer expires, dialog resolves).
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

  // No capture here — snapshotting is the responsibility of each mutation
  // site inside the mutate fns (and the upgrade-pick display step). See
  // `snapshotForNextBanner` on `PhaseTransitionCtx`.
  const mutateFn =
    ctx.role === ROLE_HOST ? transition.mutate.host : transition.mutate.watcher;
  if (!mutateFn) {
    throw new Error(
      `runTransition: transition "${id}" has no ${ctx.role} mutate (host-only transition dispatched from watcher ctx)`,
    );
  }
  const result = mutateFn(ctx);
  transition.postMutate?.(ctx, result);

  runDisplay(transition.display, ctx, result, () => {
    const postDisplay =
      ctx.role === ROLE_HOST
        ? transition.postDisplay?.host
        : transition.postDisplay?.watcher;
    postDisplay?.(ctx, result);
  });
}

/** A `life-lost-dialog` step is terminal — the resolve chain dispatches the
 *  next transition externally, so the runner does not invoke `onDone` after
 *  it. Enforce at module load that any transition containing this step has
 *  it as the LAST display entry and declares no `postDisplay` (which would
 *  silently never run). */
for (const transition of TRANSITIONS) {
  const lastIdx = transition.display.length - 1;
  for (let idx = 0; idx < transition.display.length; idx++) {
    if (transition.display[idx]!.kind !== STEP_LIFE_LOST_DIALOG) continue;
    if (idx !== lastIdx) {
      throw new Error(
        `Transition "${transition.id}": life-lost-dialog must be the last display step (it is terminal)`,
      );
    }
    if (transition.postDisplay) {
      throw new Error(
        `Transition "${transition.id}": cannot define postDisplay — life-lost-dialog is terminal and the runner never reaches postDisplay`,
      );
    }
  }
}

/** Walk the display steps in order, calling `onDone` after the last step
 *  completes. Each step registers `onDone` with its subsystem callback. */
function runDisplay(
  steps: readonly DisplayStep[],
  ctx: PhaseTransitionCtx,
  result: TransitionResult,
  onDone: () => void,
): void {
  if (steps.length === 0) {
    onDone();
    return;
  }
  const [first, ...rest] = steps;
  runStep(first!, ctx, result, () => runDisplay(rest, ctx, result, onDone));
}

/**Can we fix that point 4 Shared post-mutation sync for battle entry: clear transient battle-anim
 *  visuals (impact flashes + thaw animations) and rebuild the per-player
 *  territory / wall snapshots from the freshly-mutated state. Host and
 *  watcher arrive at the same post-state through different routes, so this
 *  step is identical for both and lives in `postMutate` instead of being
 *  re-emitted at the end of each role-specific mutate. */
function syncBattleAnim(ctx: PhaseTransitionCtx): void {
  ctx.battle.clearImpacts();
  ctx.battle.setTerritory(snapshotTerritory(ctx.state.players));
  ctx.battle.setWalls(snapshotAllWalls(ctx.state));
}

function proceedToBattle(
  ctx: PhaseTransitionCtx,
  flights: readonly BalloonFlight[],
): void {
  if (flights.length > 0) {
    ctx.battle.setFlights(flights.map((flight) => ({ flight, progress: 0 })));
    ctx.setMode(Mode.BALLOON_ANIM);
    return;
  }
  ctx.battle.begin();
}

function runStep(
  step: DisplayStep,
  ctx: PhaseTransitionCtx,
  result: TransitionResult,
  onDone: () => void,
): void {
  switch (step.kind) {
    case STEP_BANNER:
      runBannerStep(step, ctx, result, onDone);
      return;
    case "score-overlay":
      ctx.scoreDelta.show(onDone);
      return;
    case STEP_LIFE_LOST_DIALOG:
      // Terminal step: the life-lost resolve chain dispatches the next
      // transition externally (castle-reselect-done / advance-to-cannon /
      // game-over). Do NOT call onDone — postDisplay would either no-op or
      // race the modal. `assertLifeLostStepIsTerminal` enforces this at load.
      runLifeLostDialogStep(ctx, result);
      return;
    case "upgrade-pick":
      runUpgradePickStep(step, ctx, result, onDone);
      return;
  }
}

function runBannerStep(
  step: Extract<DisplayStep, { kind: "banner" }>,
  ctx: PhaseTransitionCtx,
  result: TransitionResult,
  onDone: () => void,
): void {
  if (step.when && !step.when(ctx.state, result)) {
    onDone();
    return;
  }
  const text = typeof step.text === "function" ? step.text(result) : step.text;
  // `prevSceneImageData` was populated by the mutation site (via
  // `ctx.snapshotForNextBanner`) — the banner step just displays.
  // `recaptureAfter` refreshes the snapshot at this banner's onDone so
  // a chained next banner reveals against the post-this-banner state.
  ctx.showBanner(
    text,
    step.recaptureAfter
      ? () => {
          ctx.snapshotForNextBanner();
          onDone();
        }
      : onDone,
    step.subtitle,
  );
}

/** Life-lost dialog step — TERMINAL:
 *
 *   1. Notify each affected player's controller (per-player side-effect).
 *   2. If nobody lost a life, call `lifeLost.resolve()` to advance the game
 *      directly (no dialog needed).
 *   3. Else play the life-lost sound and invoke `lifeLost.tryShow(...)` —
 *      the dialog is modal; its own resolution chain drives the subsequent
 *      transition (reselect / continue / game-over) OUTSIDE the machine.
 *
 *  In BOTH branches the next transition is dispatched externally by the
 *  life-lost resolve chain, NOT by the machine. The runner therefore
 *  treats this step as terminal: it does not call `onDone`, so any
 *  `postDisplay` on the enclosing transition would never run. The
 *  module-load assert below enforces that constraint. */
function runLifeLostDialogStep(
  ctx: PhaseTransitionCtx,
  result: TransitionResult,
): void {
  const needsReselect = result.needsReselect ?? [];
  const eliminated = result.eliminated ?? [];
  for (const pid of [...needsReselect, ...eliminated]) {
    ctx.notifyLifeLost?.(pid);
  }
  if (needsReselect.length === 0 && eliminated.length === 0) {
    ctx.lifeLost?.resolve();
    return;
  }
  ctx.sound.lifeLost?.();
  ctx.lifeLost?.tryShow(needsReselect, eliminated);
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
  ctx.showBanner(
    BANNER_UPGRADE_PICK,
    () => {
      // All players have resolved their picks (or auto-skipped). Snapshot
      // the pre-mutation scene so the next banner reveals the demolition
      // cleanly, then apply the picks and recompute territory.
      const afterPicks = () => {
        const dialog = picker.getDialog();
        if (dialog) {
          ctx.snapshotForNextBanner();
          applyUpgradePicks(ctx.state, dialog);
          recheckTerritory(ctx.state);
        }
        onDone();
      };
      if (!picker.tryShow(afterPicks)) afterPicks();
    },
    BANNER_UPGRADE_PICK_SUB,
  );
}
