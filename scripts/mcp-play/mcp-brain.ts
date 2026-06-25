/**
 * McpBrain — an `AiBrain` whose per-phase decisions come from an external
 * agent over a mailbox (`AgentBridge`) instead of the default strategy. It is
 * a research/demo probe: drop it onto one slot via the headless runtime's
 * `controllerFactory` seam and an out-of-process agent drives that slot through
 * the exact same controller/intent path a normal AI uses.
 *
 * The brain never blocks. Each `*.tick` either consumes a pending decision the
 * agent has submitted (emitting the matching intent for the controller to
 * commit) or parks — setting `bridge.waiting` so the driver knows the agent
 * owes a move and stops advancing the mock clock. This mirrors how a human
 * controller's input arrives on a later frame than the phase start.
 *
 * Dev-only: lives in `scripts/`, outside the `src/` layer system, and is never
 * wired into determinism fixtures or parity gates (the agent slot is
 * non-deterministic by design).
 */

import type { AiBrain } from "../../src/ai/ai-brain-types.ts";
import { CannonMode } from "../../src/shared/core/battle-types.ts";
import { LifeLostChoice } from "../../src/shared/core/dialog-state.ts";
import { rotateCW } from "../../src/shared/core/pieces.ts";
import { pxToTile, tileCenterPx } from "../../src/shared/core/spatial.ts";
import { selectPlayerTower } from "../../src/shared/sim/player-rules.ts";

/** A single decision the external agent submits for the current phase. The
 *  driver only ever sets a decision whose `kind` matches the live phase. */
export type AgentDecision =
  | { kind: "select"; towerIdx: number }
  | { kind: "build"; row: number; col: number; rotation: number }
  | { kind: "cannon"; row: number; col: number; mode: CannonMode }
  | { kind: "cannon-done" }
  | { kind: "fire"; row: number; col: number }
  | { kind: "pick-upgrade"; cardIdx: number };

/** Result of the last committed (or rejected) decision, surfaced back to the
 *  agent so it can see whether its placement/shot landed and why not. Same
 *  shape across every phase so the agent reads feedback uniformly. */
export interface AgentResult {
  kind: AgentDecision["kind"];
  success: boolean;
  /** Why a placement was rejected (pre-flight legality). Absent on success. */
  reason?: string;
}

/** Shared mailbox between the driver (which sets `pending`) and the brain
 *  (which consumes it and publishes `waiting` / `lastResult`). One instance per
 *  agent slot, owned by the driver. */
export interface AgentBridge {
  /** Set by the driver on `act`, consumed by the brain's next matching tick. */
  pending: AgentDecision | null;
  /** Set true by the brain whenever it ticked in an actionable sub-state with
   *  nothing pending — i.e. the agent owes a move. The driver resets it to
   *  false before each tick burst and parks the clock once it flips true. */
  waiting: boolean;
  /** Outcome of the most recently committed decision. */
  lastResult: AgentResult | null;
}

/** Default cannon mode used when the agent omits one. */
export const DEFAULT_CANNON_MODE = CannonMode.NORMAL;

/** Create a fresh `AgentBridge` in its idle state. */
export function createAgentBridge(): AgentBridge {
  return { pending: null, waiting: false, lastResult: null };
}

/** Build an `AiBrain` that reads its decisions from `bridge`. Each brain
 *  instance owns one slot; per-phase scratch (chosen tower, cannon slot count)
 *  is captured in the closure, exactly like `createDefaultAiBrain`. */
export function createMcpBrain(bridge: AgentBridge): AiBrain {
  // ── Selection scratch ──
  let selectionZone = -1;
  let selectionConfirmed = false;
  // ── Cannon scratch ──
  let cannonMaxSlots = 0;
  let cannonDone = false;

  return {
    selection: {
      init: (_host, _state, zone) => {
        selectionZone = zone;
        selectionConfirmed = false;
      },
      tick: (host, state) => {
        if (selectionConfirmed || !state) return;
        const decision = bridge.pending;
        if (decision?.kind === "select") {
          const player = state.players[host.playerId];
          const tower = state.map.towers[decision.towerIdx];
          // Only honor a tower in this player's zone; otherwise keep waiting so
          // a bad index from the agent is a no-op, not a broken auto-build.
          if (player && tower && tower.zone === selectionZone) {
            selectPlayerTower(player, tower);
            selectionConfirmed = true;
            bridge.pending = null;
            bridge.waiting = false;
            bridge.lastResult = { kind: "select", success: true };
            return;
          }
          // Reject the malformed decision and re-ask.
          bridge.pending = null;
          bridge.lastResult = { kind: "select", success: false };
        }
        bridge.waiting = true;
      },
      confirmed: () => selectionConfirmed,
      reset: () => {
        selectionConfirmed = false;
      },
    },

    build: {
      init: () => {},
      tick: (host, state) => {
        const decision = bridge.pending;
        const piece = state.players[host.playerId]?.currentPiece;
        if (decision?.kind === "build" && piece) {
          let shape = piece;
          const turns = (((decision.rotation % 4) + 4) % 4) as 0 | 1 | 2 | 3;
          for (let i = 0; i < turns; i++) shape = rotateCW(shape);
          bridge.pending = null;
          bridge.waiting = false;
          return {
            phantoms: [],
            commit: {
              playerId: host.playerId,
              piece: shape,
              row: decision.row,
              col: decision.col,
            },
          };
        }
        bridge.waiting = true;
        return { phantoms: [] };
      },
      onPlaceResult: (_host, _state, success) => {
        bridge.lastResult = { kind: "build", success };
      },
      finalize: () => {},
      reset: () => {},
    },

    cannon: {
      init: (_host, _state, maxSlots) => {
        cannonMaxSlots = maxSlots;
        cannonDone = false;
      },
      tick: (host) => {
        const decision = bridge.pending;
        if (decision?.kind === "cannon") {
          bridge.pending = null;
          bridge.waiting = false;
          return {
            phantom: null,
            commit: {
              playerId: host.playerId,
              row: decision.row,
              col: decision.col,
              mode: decision.mode,
            },
          };
        }
        if (decision?.kind === "cannon-done") {
          bridge.pending = null;
          bridge.waiting = false;
          cannonDone = true;
          return { phantom: null };
        }
        // Once the agent has ended cannon placement, stop re-parking so the
        // driver advances through the rest of the phase instead of re-asking.
        if (!cannonDone) bridge.waiting = true;
        return { phantom: null };
      },
      // The agent places cannons explicitly one at a time; there is nothing to
      // batch-flush at end of phase.
      flush: function* () {},
      isDone: () => cannonDone,
      reset: () => {
        cannonDone = false;
      },
      get maxSlots() {
        return cannonMaxSlots;
      },
    },

    battle: {
      init: () => {},
      tick: (host, state) => {
        const decision = bridge.pending;
        if (decision?.kind === "fire") {
          bridge.pending = null;
          bridge.waiting = false;
          // Snap the agent's tile aim through the SAME occlusion seam the
          // default AI uses (controller.aim → occludedAimWorld). Under the
          // battle tilt a taller camera-near obstacle hides the target, so a
          // shot at an occluded grunt lands on the wall/tower in front instead
          // — the agent can't hit a tile a human couldn't see. A clear shot
          // returns verbatim, so this is a no-op for unobstructed targets.
          const center = tileCenterPx(decision.row, decision.col);
          const aimed = host.aim(state, center.x, center.y);
          return {
            commit: {
              playerId: host.playerId,
              targetRow: pxToTile(aimed.wy),
              targetCol: pxToTile(aimed.wx),
            },
          };
        }
        bridge.waiting = true;
        return {};
      },
      onFireResult: (_host, _state, success) => {
        bridge.lastResult = { kind: "fire", success };
      },
      // Crosshair orbit is cosmetic; the agent aims by absolute tile.
      resetKeepOrbit: () => {},
      setOrbitAngle: () => {},
    },

    // v1: keep playing through every life-lost prompt. Surfacing CONTINUE/ABANDON
    // as an agent decision is a future extension.
    chooseLifeLost: () => LifeLostChoice.CONTINUE,

    // Modern UPGRADE_PICK: the agent's entry auto-resolves through this brain
    // (its controller is an AiController), so the dialog calls us every frame for
    // the agent's pending entry. Commit a submitted `pick-upgrade` decision by
    // writing the entry exactly as the AI auto-pick does (choice + focusedCard +
    // pickedAtTimer drives the reveal pulse); otherwise park so the frozen-clock
    // driver stops and asks the agent to choose. No force-resolve backstop fires:
    // an auto-resolving entry is never touched by the dialog's max-timer loop, so
    // parking holds the phase indefinitely until the agent acts (turn-based).
    tickUpgradePick: (entry, _entryIdx, _autoDelayTicks, dialogTimer) => {
      // Already resolved (agent picked on an earlier tick) — don't re-park.
      if (entry.choice !== null) return;
      const decision = bridge.pending;
      if (decision?.kind === "pick-upgrade") {
        const idx = decision.cardIdx;
        if (idx >= 0 && idx < entry.offers.length) {
          entry.choice = entry.offers[idx]!;
          entry.focusedCard = idx;
          entry.pickedAtTimer = dialogTimer;
          bridge.pending = null;
          bridge.waiting = false;
          bridge.lastResult = { kind: "pick-upgrade", success: true };
          return;
        }
        // Out-of-range card — reject and re-ask (pre-flight should catch this).
        bridge.pending = null;
        bridge.lastResult = { kind: "pick-upgrade", success: false };
      }
      bridge.waiting = true;
    },
  };
}
