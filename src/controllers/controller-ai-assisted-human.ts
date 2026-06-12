/**
 * AI controller that presents as `kind: "human"` and routes placements through
 * typed send callbacks, so AI play exercises the same wire path humans use.
 * Inherits per-phase state machines from AiController; tick methods inject
 * broadcasting execute callbacks. Senders are caller-supplied so this file
 * stays in `controllers` with no `protocol` dependency. InputReceiver methods
 * are no-ops — v1 doesn't interleave real human input.
 */

import type { AiBrain } from "../ai/ai-brain-types.ts";
import type { AiStrategy } from "../ai/ai-strategy-types.ts";
import type {
  LockstepOriginatorDeps,
  ScheduledAction,
} from "../shared/core/action-schedule.ts";
import { CannonMode } from "../shared/core/battle-types.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type {
  BuildViewState,
  CannonViewState,
  GameViewState,
  InputReceiver,
  UpgradePickViewState,
} from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import type { UpgradeId } from "../shared/core/upgrade-defs.ts";
import { Action } from "../shared/ui/input-action.ts";
import {
  LifeLostChoice,
  type LifeLostEntry,
  type ResolvedChoice,
  type UpgradePickEntry,
} from "../shared/ui/interaction-types.ts";
import { type CommitSenders, networkedCommitPort } from "./ai-commit-port.ts";
import { AiController } from "./controller-ai.ts";

/** Typed wire-broadcast callbacks. The controller stays protocol-agnostic
 *  — callers wrap `network.send` with the appropriate MESSAGE.* type wrapping.
 *  Extends the port's CommitSenders (piece/cannon/fire) with the
 *  upgrade/life-lost senders the commit port doesn't touch. */
interface AssistedSenders extends CommitSenders {
  sendUpgradePick: (choice: UpgradeId, applyAt: number) => void;
  sendLifeLostChoice: (choice: ResolvedChoice, applyAt: number) => void;
}

interface AssistedControllerOptions extends LockstepOriginatorDeps<GameState> {
  strategy: AiStrategy;
  brain: AiBrain;
  senders: AssistedSenders;
  /** Outstanding lockstep debt in ticks (`lockstepDebtTicks`) — added to
   *  dialog-commit stamps so a choice committed mid-replay still lands in
   *  every other peer's future. Dialog commits are owner-funnel
   *  obligations the room waits on, so unlike board commits they ride
   *  out during replay, stamp-corrected. 0 in healthy play. */
  stampDelayTicks: () => number;
}

export class AiAssistedHumanController
  extends AiController
  implements InputReceiver
{
  override readonly kind = "human" as const;
  private readonly senders: AssistedSenders;
  private readonly safetyTicks: number;
  private readonly stampDelayTicks: () => number;
  private readonly scheduleAction: (action: ScheduledAction<GameState>) => void;
  /** True while a dialog commit awaits its lockstep `applyAt` tick (the
   *  entry still reads as pending, so the dialog tick keeps calling us —
   *  these flags stop the AI from re-deciding and re-broadcasting every
   *  tick of that window). Reset inside the scheduled apply; controllers
   *  are rebuilt per game, so a reset dropped with the action schedule
   *  (rematch) can't leak across games. */
  private pendingUpgradePick = false;
  private pendingLifeLost = false;

  constructor(playerId: ValidPlayerId, opts: AssistedControllerOptions) {
    // Inject a networked commit port: piece/cannon/fire commits schedule on
    // the lockstep queue + broadcast instead of mutating GameState directly.
    // All three tick methods are inherited unchanged from AiController — the
    // port is the only difference between local and assisted-human AI.
    super(
      playerId,
      opts.strategy,
      opts.brain,
      networkedCommitPort({
        schedule: opts.schedule,
        senders: opts.senders,
        safetyTicks: opts.safetyTicks,
        isQuarantined: opts.isQuarantined,
      }),
    );
    this.senders = opts.senders;
    this.safetyTicks = opts.safetyTicks;
    this.stampDelayTicks = opts.stampDelayTicks;
    this.scheduleAction = opts.schedule;
  }

  // ── Upgrade pick: AI animates + decides; the COMMIT rides the lockstep
  //    queue, mirroring a real human's pick (decision at T, apply at
  //    T+SAFETY on every peer including this one). Letting `super` keep
  //    its direct write here skewed the dialog's resolution tick across
  //    peers (owner at T, receivers at T+SAFETY) — that skew shifted the
  //    following WALL_BUILD window and let the build-end gate accept a
  //    late piece on one peer and reject it on another. ──

  override tickUpgradePick(
    entry: UpgradePickEntry,
    entryIdx: number,
    autoDelaySeconds: number,
    dialogTimer: number,
    state: UpgradePickViewState,
  ): void {
    if (this.pendingUpgradePick) return;
    const wasCommitted = entry.choice !== null;
    super.tickUpgradePick(
      entry,
      entryIdx,
      autoDelaySeconds,
      dialogTimer,
      state,
    );
    if (wasCommitted || entry.choice === null) return;
    // `super` committed with local-AI semantics (direct write). Re-stage
    // the commit through the lockstep queue: undo the write, broadcast,
    // and apply locally at the same `applyAt` every receiver uses.
    const choice = entry.choice;
    entry.choice = null;
    entry.pickedAtTimer = null;
    // + debt: see `stampDelayTicks` — keeps the stamp in every peer's
    // future while this peer is replaying a hidden-tab gap.
    const applyAt = state.simTick + this.safetyTicks + this.stampDelayTicks();
    this.pendingUpgradePick = true;
    this.senders.sendUpgradePick(choice, applyAt);
    this.scheduleAction({
      applyAt,
      playerId: this.playerId,
      apply: () => {
        this.pendingUpgradePick = false;
        if (entry.choice !== null) return;
        entry.choice = choice;
        entry.focusedCard = entry.offers.indexOf(choice);
        // Decision-time stamp. pickedAtTimer only drives the reveal-pulse
        // animation — the dialog's post-resolve dwell counts sim ticks
        // (`resolvedAtSimTick` in subsystems/upgrade-pick.ts), so a
        // cosmetic cross-peer stamp difference is acceptable.
        entry.pickedAtTimer = dialogTimer;
      },
    });
  }

  override forceUpgradePick(
    entry: UpgradePickEntry,
    state: UpgradePickViewState,
  ): UpgradeId {
    const choice = super.forceUpgradePick(entry, state);
    this.senders.sendUpgradePick(
      choice,
      state.simTick + this.safetyTicks + this.stampDelayTicks(),
    );
    return choice;
  }

  // ── Life-lost: AI decides; the COMMIT rides the lockstep queue, same
  //    shape (and same skew rationale) as tickUpgradePick above. ──

  override tickLifeLost(
    entry: LifeLostEntry,
    dt: number,
    autoDelaySeconds: number,
    state: GameViewState,
  ): void {
    if (this.pendingLifeLost) return;
    const wasPending = entry.choice === LifeLostChoice.PENDING;
    super.tickLifeLost(entry, dt, autoDelaySeconds, state);
    if (!wasPending || entry.choice === LifeLostChoice.PENDING) return;
    const choice = entry.choice;
    entry.choice = LifeLostChoice.PENDING;
    // + debt: see `stampDelayTicks` — same correction as tickUpgradePick.
    const applyAt = state.simTick + this.safetyTicks + this.stampDelayTicks();
    this.pendingLifeLost = true;
    this.senders.sendLifeLostChoice(choice, applyAt);
    this.scheduleAction({
      applyAt,
      playerId: this.playerId,
      apply: () => {
        this.pendingLifeLost = false;
        if (entry.choice === LifeLostChoice.PENDING) entry.choice = choice;
      },
    });
  }

  // ── InputReceiver stubs (v1 — no real human input handled yet) ──

  matchKey(_key: string): Action | null {
    return null;
  }
  handleKeyDown(_action: Action): void {}
  handleKeyUp(_action: Action): void {}
  setDpadVector(_x: number, _y: number): void {}
  clearDpadVector(): void {}
  rotatePiece(_state: BuildViewState): void {}
  tryPlacePiece(_state: BuildViewState): null {
    return null;
  }
  tryPlaceCannon(_state: CannonViewState): null {
    return null;
  }
  cycleCannonMode(_state: CannonViewState, _maxSlots: number): void {}
  getCannonPlaceMode(): CannonMode {
    return CannonMode.NORMAL;
  }
}
