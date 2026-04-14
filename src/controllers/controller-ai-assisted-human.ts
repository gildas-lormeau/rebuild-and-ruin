/**
 * AiAssistedHumanController — an AI-driven controller that presents itself
 * as a human (kind: "human") and routes every placement through typed send
 * callbacks, so AI-driven gameplay exercises the same per-action wire
 * pathway humans use. Useful for protocol testing.
 *
 * Inherits all per-phase state machines from AiController; only overrides
 * the tick methods to inject broadcasting execute callbacks.
 *
 * The caller (e.g. the test scenario) supplies typed senders — this file
 * stays in the `controllers` domain with no `protocol` dependency. Message
 * construction lives at the call site that imports protocol freely.
 *
 * InputReceiver methods are stub no-ops — this v1 doesn't support
 * interleaving real human input. Future work: setHumanDriven(phase, bool)
 * to selectively delegate phases to actual input handlers.
 */

import { tickBattle } from "../ai/ai-phase-battle.ts";
import { tickBuild } from "../ai/ai-phase-build.ts";
import { flushCannon, tickCannon } from "../ai/ai-phase-cannon.ts";
import type { AiStrategy } from "../ai/ai-strategy.ts";
import {
  executeCannonFire,
  executePlaceCannon,
  executePlacePiece,
} from "../game/index.ts";
import { type Cannonball, CannonMode } from "../shared/core/battle-types.ts";
import type {
  CannonPlacedPayload,
  PiecePlacedPayload,
} from "../shared/core/phantom-types.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type {
  BuildViewState,
  CannonPlacementPreview,
  CannonViewState,
  FireIntent,
  InputReceiver,
  PiecePlacementPreview,
  PlaceCannonIntent,
  PlacePieceIntent,
} from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import { Action } from "../shared/ui/input-action.ts";
import { AiController } from "./controller-ai.ts";

/** Typed wire-broadcast callbacks. The controller stays protocol-agnostic
 *  — callers wrap `network.send` with the appropriate MESSAGE.* type wrapping. */
interface AssistedSenders {
  sendPiecePlaced: (payload: PiecePlacedPayload) => void;
  sendCannonPlaced: (payload: CannonPlacedPayload) => void;
  sendCannonFired: (ball: Cannonball) => void;
}

interface AssistedControllerOptions {
  strategy?: AiStrategy;
  senders: AssistedSenders;
}

export class AiAssistedHumanController
  extends AiController
  implements InputReceiver
{
  override readonly kind = "human" as const;
  private readonly senders: AssistedSenders;

  constructor(playerId: ValidPlayerSlot, opts: AssistedControllerOptions) {
    super(playerId, opts.strategy);
    this.senders = opts.senders;
  }

  // ── Build phase: AI ticks; placement intents broadcast via senders.sendPiecePlaced ──

  override buildTick(state: GameState, _dt: number): PiecePlacementPreview[] {
    const executePlace = (intent: PlacePieceIntent): boolean => {
      const placed = executePlacePiece(state, intent, this);
      if (placed) {
        this.senders.sendPiecePlaced({
          playerId: intent.playerId,
          row: intent.row,
          col: intent.col,
          offsets: intent.piece.offsets,
        });
      }
      return placed;
    };
    return tickBuild(this, this._buildPhase, state, executePlace);
  }

  // ── Cannon phase: AI ticks; placements broadcast via senders.sendCannonPlaced ──

  override cannonTick(
    state: GameState,
    _dt: number,
  ): CannonPlacementPreview | null {
    const executePlace = (intent: PlaceCannonIntent): boolean => {
      const placed = executePlaceCannon(
        state,
        intent,
        this._cannonPhase.maxSlots,
      );
      if (placed) this.senders.sendCannonPlaced(intent);
      return placed;
    };
    return tickCannon(this, this._cannonPhase, state, executePlace);
  }

  override flushCannons(state: GameState, maxSlots: number): void {
    const executePlace = (intent: PlaceCannonIntent): boolean => {
      const placed = executePlaceCannon(state, intent, maxSlots);
      if (placed) this.senders.sendCannonPlaced(intent);
      return placed;
    };
    flushCannon(this._cannonPhase, this.playerId, executePlace);
  }

  // ── Battle phase: AI ticks; fires broadcast via senders.sendCannonFired ──

  override battleTick(state: GameState, _dt: number): void {
    const executeFire = (intent: FireIntent): boolean => {
      const ball = executeCannonFire(state, intent, this);
      if (!ball) return false;
      this.senders.sendCannonFired(ball);
      return true;
    };
    tickBattle(this, this._battlePhase, state, executeFire);
  }

  // ── InputReceiver stubs (v1 — no real human input handled yet) ──

  matchKey(_key: string): Action | null {
    return null;
  }
  handleKeyDown(_action: Action): void {}
  handleKeyUp(_action: Action): void {}
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
