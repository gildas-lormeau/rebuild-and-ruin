/**
 * Outbound wire-message construction for the runtime subsystems — the one
 * place message literals are built from subsystem-supplied fields, so
 * every outbound shape is reviewable together. Subsystems receive these
 * as named senders and stay protocol-free; local play wires `send` to
 * the named no-op.
 */

import type { GameMessage } from "../protocol/protocol.ts";
import type { ResolvedChoice } from "../shared/core/dialog-state.ts";
import type { TowerIdx } from "../shared/core/geometry-types.ts";
import type {
  CannonPhantomPayload,
  PiecePhantomPayload,
} from "../shared/core/phantom-types.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { UpgradeId } from "../shared/core/upgrade-defs.ts";
import type { RuntimeState } from "./state.ts";

export interface WireSenders {
  readonly sendTowerSelected: (
    playerId: ValidPlayerId,
    towerIdx: TowerIdx,
    confirmed: boolean,
    applyAt?: number,
  ) => void;
  /** `round` is stamped at this wire boundary (protocol metadata for the
   *  receivers' stale-round guard), not threaded through the subsystem's
   *  decision path. Same for `sendUpgradePick` below. */
  readonly sendLifeLostChoice: (
    choice: ResolvedChoice,
    playerId: ValidPlayerId,
    applyAt: number,
  ) => void;
  readonly sendUpgradePick: (
    playerId: ValidPlayerId,
    choice: UpgradeId,
    applyAt: number,
  ) => void;
  readonly sendOpponentCannonPhantom: (msg: CannonPhantomPayload) => void;
  readonly sendOpponentPhantom: (msg: PiecePhantomPayload) => void;
  readonly sendOpponentCannonPhaseDone: (
    playerId: ValidPlayerId,
    applyAt: number,
  ) => void;
}

export function createWireSenders(deps: {
  readonly send: (msg: GameMessage) => void;
  readonly runtimeState: RuntimeState;
}): WireSenders {
  const { send, runtimeState } = deps;
  return {
    sendTowerSelected: (playerId, towerIdx, confirmed, applyAt) =>
      send({
        type: "opponentTowerSelected",
        playerId,
        towerIdx,
        confirmed,
        applyAt,
      }),
    sendLifeLostChoice: (choice, playerId, applyAt) =>
      send({
        type: "lifeLostChoice",
        choice,
        playerId,
        applyAt,
        round: runtimeState.state.round,
      }),
    sendUpgradePick: (playerId, choice, applyAt) =>
      send({
        type: "upgradePick",
        playerId,
        choice,
        applyAt,
        round: runtimeState.state.round,
      }),
    sendOpponentCannonPhantom: (msg) =>
      send({ type: "opponentCannonPhantom", ...msg }),
    sendOpponentPhantom: (msg) => send({ type: "opponentPhantom", ...msg }),
    sendOpponentCannonPhaseDone: (playerId, applyAt) =>
      send({
        type: "opponentCannonPhaseDone",
        playerId,
        applyAt,
      }),
  };
}
