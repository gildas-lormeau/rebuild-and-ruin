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
import type { ScheduledAction } from "../shared/core/action-schedule.ts";
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
  sendUpgradePick: (choice: UpgradeId) => void;
  sendLifeLostChoice: (choice: ResolvedChoice, applyAt: number) => void;
}

interface AssistedControllerOptions {
  strategy: AiStrategy;
  brain: AiBrain;
  senders: AssistedSenders;
  /** Lockstep apply queue. Piece placements (state-mutating, RNG-consuming
   *  via recheckTerritory) are scheduled with `applyAt = state.simTick +
   *  safetyTicks` so receivers' wire-receipt enqueue lands at the same
   *  logical tick on every peer. */
  schedule: (action: ScheduledAction<GameState>) => void;
  /** Buffer depth in sim ticks. See `shared/core/action-schedule.ts`. */
  safetyTicks: number;
}

export class AiAssistedHumanController
  extends AiController
  implements InputReceiver
{
  override readonly kind = "human" as const;
  private readonly senders: AssistedSenders;
  private readonly safetyTicks: number;

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
      }),
    );
    this.senders = opts.senders;
    this.safetyTicks = opts.safetyTicks;
  }

  // ── Upgrade pick: AI animates + commits; pick broadcast via senders.sendUpgradePick ──

  override tickUpgradePick(
    entry: UpgradePickEntry,
    entryIdx: number,
    autoDelaySeconds: number,
    dialogTimer: number,
    state: UpgradePickViewState,
  ): void {
    const wasCommitted = entry.choice !== null;
    super.tickUpgradePick(
      entry,
      entryIdx,
      autoDelaySeconds,
      dialogTimer,
      state,
    );
    if (!wasCommitted && entry.choice !== null) {
      this.senders.sendUpgradePick(entry.choice);
    }
  }

  override forceUpgradePick(
    entry: UpgradePickEntry,
    state: UpgradePickViewState,
  ): UpgradeId {
    const choice = super.forceUpgradePick(entry, state);
    this.senders.sendUpgradePick(choice);
    return choice;
  }

  // ── Life-lost: AI auto-resolves; broadcast the committed choice ──

  override tickLifeLost(
    entry: LifeLostEntry,
    dt: number,
    autoDelaySeconds: number,
    state: GameViewState,
  ): void {
    const wasPending = entry.choice === LifeLostChoice.PENDING;
    super.tickLifeLost(entry, dt, autoDelaySeconds, state);
    if (wasPending && entry.choice !== LifeLostChoice.PENDING) {
      // Local mutation already landed via `super.tickLifeLost`. The wire
      // payload carries `applyAt` for protocol uniformity — receivers
      // schedule the apply, which no-ops via the PENDING guard since
      // their own deterministic local tick has already set `entry.choice`.
      this.senders.sendLifeLostChoice(
        entry.choice,
        state.simTick + this.safetyTicks,
      );
    }
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
