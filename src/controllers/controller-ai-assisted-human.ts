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
import {
  scheduleCannonFire,
  scheduleCannonPlacement,
  schedulePiecePlacement,
} from "../game/index.ts";
import type { ScheduledAction } from "../shared/core/action-schedule.ts";
import type { CannonFiredMessage } from "../shared/core/battle-events.ts";
import { CannonMode } from "../shared/core/battle-types.ts";
import type {
  CannonPlacedPayload,
  PiecePlacedPayload,
} from "../shared/core/phantom-types.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type {
  BattleViewState,
  BuildViewState,
  CannonPlacementPreview,
  CannonViewState,
  FireIntent,
  GameViewState,
  InputReceiver,
  PiecePlacementPreview,
  PlaceCannonIntent,
  PlacePieceIntent,
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
import { AiController } from "./controller-ai.ts";

/** Typed wire-broadcast callbacks. The controller stays protocol-agnostic
 *  — callers wrap `network.send` with the appropriate MESSAGE.* type wrapping. */
interface AssistedSenders {
  sendPiecePlaced: (payload: PiecePlacedPayload) => void;
  sendCannonPlaced: (payload: CannonPlacedPayload) => void;
  sendCannonFired: (msg: CannonFiredMessage) => void;
  sendUpgradePick: (choice: UpgradeId) => void;
  sendLifeLostChoice: (choice: ResolvedChoice) => void;
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
  private readonly schedule: (action: ScheduledAction<GameState>) => void;
  private readonly safetyTicks: number;

  constructor(playerId: ValidPlayerId, opts: AssistedControllerOptions) {
    super(playerId, opts.strategy, opts.brain);
    this.senders = opts.senders;
    this.schedule = opts.schedule;
    this.safetyTicks = opts.safetyTicks;
  }

  // ── Build phase: AI ticks; placements scheduled with lockstep applyAt ──

  override buildTick(
    state: BuildViewState,
    _dt: number,
  ): PiecePlacementPreview[] {
    const executePlace = (intent: PlacePieceIntent): boolean => {
      const stamped = schedulePiecePlacement({
        schedule: this.schedule,
        state,
        intent,
        safetyTicks: this.safetyTicks,
        clampBuildCursor: (piece) => this.clampBuildCursor(piece),
      });
      if (!stamped) return false;
      this.senders.sendPiecePlaced(stamped);
      return true;
    };
    const result = this.brain.build.tick(this, state, executePlace);
    this.currentBuildPhantoms = result;
    return result;
  }

  // ── Cannon phase: AI ticks; placements broadcast via senders.sendCannonPlaced ──

  override cannonTick(
    state: CannonViewState,
    _dt: number,
  ): CannonPlacementPreview | undefined {
    const executePlace = (intent: PlaceCannonIntent): boolean => {
      const stamped = scheduleCannonPlacement({
        schedule: this.schedule,
        state: state as GameState,
        intent,
        maxSlots: this.brain.cannon.maxSlots,
        safetyTicks: this.safetyTicks,
      });
      if (!stamped) return false;
      this.senders.sendCannonPlaced(stamped);
      return true;
    };
    const result = this.brain.cannon.tick(this, state, executePlace);
    this.currentCannonPhantom = result;
    return result;
  }

  override flushCannons(state: CannonViewState, maxSlots: number): void {
    const executePlace = (intent: PlaceCannonIntent): boolean => {
      const stamped = scheduleCannonPlacement({
        schedule: this.schedule,
        state: state as GameState,
        intent,
        maxSlots,
        safetyTicks: this.safetyTicks,
      });
      if (!stamped) return false;
      this.senders.sendCannonPlaced(stamped);
      return true;
    };
    this.brain.cannon.flush(this, state, executePlace);
  }

  // ── Battle phase: AI ticks; fires broadcast via senders.sendCannonFired ──

  override battleTick(state: BattleViewState, _dt: number): void {
    const executeFire = (intent: FireIntent): boolean => {
      const fired = scheduleCannonFire({
        schedule: this.schedule,
        state: state as GameState,
        intent,
        ctrl: this,
        safetyTicks: this.safetyTicks,
      });
      if (!fired) return false;
      this.cannonRotationIdx = fired.rotationIdx;
      this.senders.sendCannonFired(fired.msg);
      return true;
    };
    this.brain.battle.tick(this, state, executeFire);
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
      this.senders.sendLifeLostChoice(entry.choice);
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
  tryPlaceCannon(_state: CannonViewState, _maxSlots: number): boolean {
    return false;
  }
  cycleCannonMode(_state: CannonViewState, _maxSlots: number): void {}
  getCannonPlaceMode(): CannonMode {
    return CannonMode.NORMAL;
  }
}
