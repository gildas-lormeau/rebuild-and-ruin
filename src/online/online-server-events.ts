// Deep imports: these are network-replay primitives used only here. They are
// intentionally not exposed via ../game/index.ts — see
// scripts/lint-restricted-imports.ts for the allowlist that pins this exemption.

import { applyCannonFired } from "../game/battle-system.ts";
import { applyPiecePlacement } from "../game/build-system.ts";
import { applyCannonAtDrain } from "../game/cannon-system.ts";
import {
  canPlacePiece,
  highlightTowerSelection,
  markCannonPlaceDoneAtDrain,
} from "../game/index.ts";
import { MESSAGE, type ServerMessage } from "../protocol/protocol.ts";
import { applyLifeLostChoiceToDialog } from "../runtime/dialogs/life-lost-core.ts";
import { applyUpgradePickChoiceToDialog } from "../runtime/dialogs/upgrade-pick-core.ts";
import { isHostInContext, isRemotePlayer } from "../runtime/tick-context.ts";
import type { ScheduledAction } from "../shared/core/action-schedule.ts";
import {
  CANNON_MODE_IDS,
  toCannonMode,
} from "../shared/core/cannon-mode-defs.ts";
import type { TowerIdx } from "../shared/core/geometry-types.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import { inBoundsStrict } from "../shared/core/spatial.ts";
import type { PlayerController } from "../shared/core/system-interfaces.ts";
import { type GameState, type SelectionState } from "../shared/core/types.ts";
import {
  LifeLostChoice,
  type LifeLostDialogState,
  type ResolvedChoice,
  type UpgradePickDialogState,
} from "../shared/ui/interaction-types.ts";
import type { OnlineSession } from "./online-session.ts";
import { type RemoteCrosshairTargets } from "./online-types.ts";

export interface HandleServerIncrementalDeps {
  log: (msg: string) => void;
  session: Pick<
    OnlineSession,
    | "isHost"
    | "remotePlayerSlots"
    | "earlyLifeLostChoices"
    | "earlyUpgradePickChoices"
  >;
  presence: RemoteCrosshairTargets;
  getState: () => GameState | undefined;
  /** Lockstep queue. State-mutating wire messages enqueue with the
   *  originator-stamped `applyAt`; the action fires at the same logical
   *  tick on every peer (originator and receivers). */
  schedule: (action: ScheduledAction<GameState>) => void;
  /** Per-slot controllers — phantom messages for remote-controlled slots
   *  write directly into `controllers[msg.playerId].current{Build,Cannon}Phantom(s)`. */
  getControllers: () => readonly PlayerController[];
  selectionStates: Map<ValidPlayerId, SelectionState>;
  syncSelectionOverlay: () => void;
  confirmSelectionAndStartBuild: (
    playerId: ValidPlayerId,
    source?: "local" | "network",
    applyAt?: number,
    towerIdx?: TowerIdx,
  ) => void;
  allSelectionsConfirmed: () => boolean;
  getLifeLostDialog: () => LifeLostDialogState | null;
  getUpgradePickDialog: () => UpgradePickDialogState | null;
}

type TowerSelectedMsg = Extract<
  ServerMessage,
  { type: "opponentTowerSelected" }
>;

type PiecePlacedMsg = Extract<ServerMessage, { type: "opponentPiecePlaced" }>;

type CannonPlacedMsg = Extract<ServerMessage, { type: "opponentCannonPlaced" }>;

type CannonPhaseDoneMsg = Extract<
  ServerMessage,
  { type: "opponentCannonPhaseDone" }
>;

type CannonFiredMsg = Extract<ServerMessage, { type: "cannonFired" }>;

type AimUpdateMsg = Extract<ServerMessage, { type: "aimUpdate" }>;

type PiecePhantomMsg = Extract<ServerMessage, { type: "opponentPhantom" }>;

type CannonPhantomMsg = Extract<
  ServerMessage,
  { type: "opponentCannonPhantom" }
>;

type LifeLostChoiceMsg = Extract<ServerMessage, { type: "lifeLostChoice" }>;

type UpgradePickMsg = Extract<ServerMessage, { type: "upgradePick" }>;

/** Result of handling a server message.
 *  `applied` = true when the message mutated game state.
 *  `applied` = false when it was silently dropped (validation failed,
 *  not a remote-human action, host-only filter, etc.). */
interface HandleResult {
  applied: boolean;
}

const APPLIED: HandleResult = { applied: true };
const DROPPED: HandleResult = { applied: false };

/** Dispatch incremental game messages from the server.
 *  Returns `{ applied }` for observability; returns `null` if unrecognized.
 *  See file header for the three handler categories and their validation patterns. */
export function handleServerIncrementalMessage(
  msg: ServerMessage,
  deps: HandleServerIncrementalDeps,
): HandleResult | null {
  const state = deps.getState();

  switch (msg.type) {
    case MESSAGE.OPPONENT_TOWER_SELECTED:
      return handleTowerSelected(msg, state, deps);
    case MESSAGE.OPPONENT_PIECE_PLACED:
      return handlePiecePlaced(msg, state, deps);
    case MESSAGE.OPPONENT_CANNON_PLACED:
      return handleCannonPlaced(msg, state, deps);
    case MESSAGE.OPPONENT_CANNON_PHASE_DONE:
      return handleCannonPhaseDone(msg, state, deps);
    case MESSAGE.CANNON_FIRED:
      return handleCannonFired(msg, state, deps);
    case MESSAGE.AIM_UPDATE:
      return handleAimUpdate(msg, state, deps);
    case MESSAGE.OPPONENT_PHANTOM:
      return handlePiecePhantom(msg, state, deps);
    case MESSAGE.OPPONENT_CANNON_PHANTOM:
      return handleCannonPhantom(msg, state, deps);
    case MESSAGE.LIFE_LOST_CHOICE:
      return handleLifeLostChoice(msg, deps);
    case MESSAGE.UPGRADE_PICK:
      return handleUpgradePick(msg, deps);
    default:
      return null;
  }
}

function handleTowerSelected(
  msg: TowerSelectedMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  if (!isActivePlayer(state, msg.playerId)) return DROPPED;
  if (msg.towerIdx < 0 || msg.towerIdx >= state.map.towers.length)
    return DROPPED;
  if (!isRemoteHumanAction(msg.playerId, deps)) return DROPPED;
  const expectedZone = state.playerZones[msg.playerId];
  if (expectedZone === undefined) return DROPPED;

  // Route through the selection system — validates zone, confirmed, same-idx
  const changed = highlightTowerSelection(
    state,
    deps.selectionStates,
    msg.towerIdx,
    expectedZone,
    msg.playerId,
  );
  if (changed) deps.syncSelectionOverlay();

  // Handle confirmation (separate from highlighting — confirm even if same tower)
  if (msg.confirmed) {
    const selectionState = deps.selectionStates.get(msg.playerId);
    if (selectionState && !selectionState.confirmed) {
      // Lockstep: both host and watcher schedule
      // `confirmTowerSelection + startPlayerCastleBuild` for the wire-
      // supplied `applyAt`, so castle-wall RNG consumption fires at the
      // same logical sim tick on every peer. `msg.towerIdx` rides along
      // so the scheduled apply commits the originator's broadcast tower
      // even when a later hover message crosses the drain boundary and
      // moves the live highlight. The "network" source skips
      // sendTowerSelected (the server already relayed the message; an
      // echo would be redundant). When `applyAt` is missing (older wire
      // shape, defensive), the immediate-apply fallback inside
      // `confirmSelectionAndStartBuild` runs.
      deps.confirmSelectionAndStartBuild(
        msg.playerId,
        "network",
        msg.applyAt,
        msg.towerIdx,
      );
    }
  }
  return APPLIED;
}

function handlePiecePlaced(
  msg: PiecePlacedMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  if (!isActivePlayer(state, msg.playerId)) return DROPPED;
  if (!inBoundsStrict(msg.row, msg.col)) return DROPPED;
  if (!Array.isArray(msg.offsets) || msg.offsets.length === 0) return DROPPED;
  if (!isRemoteHumanAction(msg.playerId, deps)) return DROPPED;
  // No validation at receive time — host's state at simTick=N+wireDelay
  // differs from watcher's at simTick=N (originator's schedule tick), so
  // a `canPlacePiece` check here would reject placements that the
  // originator's apply (at applyAt=N+SAFETY) will accept against
  // identical drain-time state. The validation moves into the `apply`
  // closure, which runs at applyAt with cross-peer-identical state.
  deps.log(
    `scheduling piece placement for P${msg.playerId} at applyAt=${msg.applyAt} (${msg.offsets.length} tiles)`,
  );
  const { playerId, offsets, row, col, applyAt } = msg;
  deps.schedule({
    applyAt,
    playerId,
    apply: (drainState) => {
      // Build-end gate — see scheduled-actions.ts for rationale.
      if (!drainState.players[playerId]?.bag) return;
      if (!canPlacePiece(drainState, playerId, offsets, row, col)) return;
      applyPiecePlacement(drainState, playerId, offsets, row, col);
    },
  });
  return APPLIED;
}

function handleCannonPlaced(
  msg: CannonPlacedMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  if (!isActivePlayer(state, msg.playerId)) return DROPPED;
  if (!inBoundsStrict(msg.row, msg.col)) return DROPPED;
  if (!CANNON_MODE_IDS.has(msg.mode)) return DROPPED;
  if (!isRemoteHumanAction(msg.playerId, deps)) return DROPPED;
  const player = state.players[msg.playerId];
  if (!player) return DROPPED;
  const normalizedMode = toCannonMode(msg.mode);
  // Validation moved into the apply closure — see `handlePiecePlaced`
  // for the same rationale (lockstep state at applyAt vs receive-time
  // state asymmetry). `applyCannonAtDrain` re-validates internally.
  const { row, col, applyAt, playerId } = msg;
  deps.schedule({
    applyAt,
    playerId,
    apply: (drainState) => {
      applyCannonAtDrain(drainState, playerId, row, col, normalizedMode);
    },
  });
  return APPLIED;
}

/** Mark a remote-driven slot as done placing cannons. The phase-exit
 *  predicate in `tickCannonPhase` waits for `state.cannonPlaceDone` to cover
 *  every non-eliminated slot, so without this signal the watcher would
 *  exit CANNON_PLACE before the host's final placements arrived.
 *
 *  Lockstep `applyAt`: the originator stamps `applyAt = senderSimTick +
 *  SAFETY` and schedules its own `cannonPlaceDone.add` for that tick;
 *  this receiver schedules the same add for the same `applyAt`, so the
 *  phase-exit predicate flips at identical sim ticks across peers. The
 *  mirror schedule for the originator side lives in
 *  `runtime/subsystems/phase-ticks.ts:tickCannonPhase`'s broadcast block. */
function handleCannonPhaseDone(
  msg: CannonPhaseDoneMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  if (!isActivePlayer(state, msg.playerId)) return DROPPED;
  if (!isRemoteHumanAction(msg.playerId, deps)) return DROPPED;
  const playerId = msg.playerId;
  deps.schedule({
    applyAt: msg.applyAt,
    playerId,
    apply: (drainState) => markCannonPlaceDoneAtDrain(drainState, playerId),
  });
  return APPLIED;
}

function handleCannonFired(
  msg: CannonFiredMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  if (!isActivePlayer(state, msg.playerId)) return DROPPED;
  if (!Number.isFinite(msg.speed) || msg.speed <= 0) return DROPPED;
  if (
    !Number.isFinite(msg.startX) ||
    !Number.isFinite(msg.startY) ||
    !Number.isFinite(msg.targetX) ||
    !Number.isFinite(msg.targetY)
  )
    return DROPPED;
  if (!isRemoteHumanAction(msg.scoringPlayerId ?? msg.playerId, deps))
    return DROPPED;
  const player = state.players[msg.playerId];
  if (!player || !player.cannons[msg.cannonIdx]) {
    deps.log(
      `cannon_fired: stale ref P${msg.playerId} cannon[${msg.cannonIdx}] — skipped`,
    );
    return DROPPED;
  }
  if (msg.applyAt === undefined) {
    deps.log(
      `cannon_fired: missing applyAt for P${msg.playerId} — falling back to immediate apply`,
    );
    if (applyCannonFired(state, msg)) state.bus.emit(msg.type, msg);
    return APPLIED;
  }
  const applyAt = msg.applyAt;
  deps.schedule({
    applyAt,
    playerId: msg.playerId,
    apply: (drainState) => {
      // Emit only when the ball actually spawned — the phase gate in
      // `applyCannonFired` swallows fires draining after battle-done.
      if (applyCannonFired(drainState, msg)) drainState.bus.emit(msg.type, msg);
    },
  });
  return APPLIED;
}

function handleAimUpdate(
  msg: AimUpdateMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return DROPPED;
  if (!isActivePlayer(state, msg.playerId)) return DROPPED;
  if (!isRemoteHumanAction(msg.playerId, deps)) return DROPPED;
  deps.presence.remoteCrosshairs.set(msg.playerId, { x: msg.x, y: msg.y });
  return APPLIED;
}

/** Phantoms write the latest preview directly onto the remote slot's
 *  controller. The controller's own `current{Build,Cannon}Phantom(s)`
 *  field is the single source of truth for both render and broadcast,
 *  so there is no separate "remote slot" to upsert into.
 *  Contrast with crosshairs in online-remote-crosshairs.ts which use
 *  DedupChannel's atomic shouldSend() mechanism — crosshairs are
 *  fire-and-forget, phantoms accumulate. */
function handlePiecePhantom(
  msg: PiecePhantomMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  if (state && !validPid(msg.playerId, state)) return DROPPED;
  if (!inBoundsStrict(msg.row, msg.col)) return DROPPED;
  if (!isRemoteHumanAction(msg.playerId, deps)) return DROPPED;
  const ctrl = deps.getControllers()[msg.playerId];
  if (!ctrl) return DROPPED;
  ctrl.currentBuildPhantoms = [
    {
      offsets: msg.offsets,
      row: msg.row,
      col: msg.col,
      playerId: msg.playerId,
      valid: msg.valid,
    },
  ];
  return APPLIED;
}

function handleCannonPhantom(
  msg: CannonPhantomMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  if (state && !validPid(msg.playerId, state)) return DROPPED;
  if (!inBoundsStrict(msg.row, msg.col)) return DROPPED;
  if (!isRemoteHumanAction(msg.playerId, deps)) return DROPPED;
  const ctrl = deps.getControllers()[msg.playerId];
  if (!ctrl) return DROPPED;
  ctrl.currentCannonPhantom = {
    row: msg.row,
    col: msg.col,
    valid: msg.valid,
    mode: toCannonMode(msg.mode),
    playerId: msg.playerId,
  };
  return APPLIED;
}

/** Apply a remote slot's life-lost choice via the lockstep action queue.
 *  Same clone-everywhere shape as `handleUpgradePick`: a remote human's
 *  entry never auto-resolves on any peer (`shouldAutoResolve`), so this
 *  wire signal is its only resolution path — pure-AI entries resolve
 *  locally from state on every peer and are never broadcast. The
 *  `entry.choice === LifeLostChoice.PENDING` guard inside
 *  `applyLifeLostChoiceToDialog` silently drops a self-echo (the relay
 *  bouncing the originator's own broadcast back).
 *
 *  Lockstep `applyAt`: originator stamps `applyAt = senderSimTick +
 *  SAFETY` and schedules its own apply for the same tick; this receiver
 *  schedules an identical apply at `msg.applyAt`. `Mode.LIFE_LOST` is a
 *  gameplay mode (simTick + schedule drain run during the dialog), so the
 *  apply fires at the same logical tick on every peer — `dialogResolved`
 *  + `eliminatePlayers` (which mutates `state.players[pid].lives`) land in
 *  lockstep.
 *
 *  Ownership: hosts only accept choices for slots they see as remote
 *  humans — same check as `handleUpgradePick` and the action handlers. */
function handleLifeLostChoice(
  msg: LifeLostChoiceMsg,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  deps.log(
    `life_lost_choice from P${msg.playerId}: ${msg.choice} applyAt=${msg.applyAt} (dialog=${deps.getLifeLostDialog() ? "active" : "null"})`,
  );
  if (!isRemoteHumanAction(msg.playerId, deps)) return DROPPED;
  const validated = parseLifeLostChoice(msg.choice);
  if (validated === null) return DROPPED;
  const playerId = msg.playerId;
  const round = msg.round;
  deps.schedule({
    applyAt: msg.applyAt,
    playerId,
    apply: () => {
      const dialog = deps.getLifeLostDialog();
      if (!dialog) {
        // Dialog not built yet on this peer — queue for the show()-time
        // drain, round-stamped so a stale choice (own dialog already
        // closed) can't resolve a future round's dialog.
        deps.session.earlyLifeLostChoices.set(playerId, {
          choice: validated,
          round,
        });
        return;
      }
      applyLifeLostChoiceToDialog(playerId, validated, dialog);
    },
  });
  return APPLIED;
}

/** Parse an untrusted value into a resolved LifeLostChoice, or null if invalid. */
function parseLifeLostChoice(raw: unknown): ResolvedChoice | null {
  if (raw === LifeLostChoice.CONTINUE) return LifeLostChoice.CONTINUE;
  if (raw === LifeLostChoice.ABANDON) return LifeLostChoice.ABANDON;
  return null;
}

/** Apply a remote slot's upgrade pick via the lockstep action queue.
 *  Runs on host AND watcher under clone-everywhere — a remote human's
 *  entry never auto-resolves on any peer (`shouldAutoResolve`), so this
 *  wire signal is its only resolution path. Pure-AI entries resolve
 *  locally from state on every peer (`aiPickUpgrade` derives a private
 *  Rng from state.rng.seed + round + playerId) and are never broadcast.
 *  The pending-entry guard in `applyUpgradePickChoiceToDialog` silently
 *  drops a self-echo (the relay bouncing the originator's own broadcast
 *  back).
 *
 *  Lockstep `applyAt`: originator stamps `applyAt = senderSimTick +
 *  SAFETY` and schedules its own apply for that tick (see
 *  `scheduleOrApplyPick` in subsystems/upgrade-pick.ts); this receiver
 *  schedules an identical apply at `msg.applyAt`, so `entry.choice`
 *  flips at the same logical tick on every peer.
 *
 *  Ownership: hosts only accept picks for slots they see as remote
 *  humans — a spectating client must not decide a slot the host owns
 *  locally or an AI slot it mirror-simulates. */
function handleUpgradePick(
  msg: UpgradePickMsg,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  deps.log(
    `upgrade_pick from P${msg.playerId}: ${msg.choice} applyAt=${msg.applyAt} (dialog=${deps.getUpgradePickDialog() ? "active" : "null"})`,
  );
  if (!isRemoteHumanAction(msg.playerId, deps)) return DROPPED;
  const playerId = msg.playerId;
  const choice = msg.choice;
  const round = msg.round;
  deps.schedule({
    applyAt: msg.applyAt,
    playerId,
    apply: () => {
      const dialog = deps.getUpgradePickDialog();
      if (!dialog) {
        // Dialog not built yet on this peer — queue for the tryShow()-
        // time drain, round-stamped so a stale pick (own dialog already
        // closed) can't resolve a future round's dialog.
        deps.session.earlyUpgradePickChoices.set(playerId, { choice, round });
        return;
      }
      applyUpgradePickChoiceToDialog(playerId, choice, dialog);
    },
  });
  return APPLIED;
}

/** Watchers accept all remote messages; hosts only accept from remote humans. */
function isRemoteHumanAction(
  pid: ValidPlayerId,
  deps: Pick<HandleServerIncrementalDeps, "session">,
): boolean {
  return (
    !isHostInContext(deps.session) ||
    isRemotePlayer(pid, deps.session.remotePlayerSlots)
  );
}

/** Type guard: state exists, pid is in range, and the player is not eliminated.
 *  Used by the five "real action / aim" handlers (tower/piece/cannon/fire/aim)
 *  which all require a live player to apply. Phantom handlers are intentionally
 *  looser (state-optional, no eliminated check) — phantoms are cosmetic and
 *  tolerate late arrival before state init or after elimination. */
function isActivePlayer(
  state: GameState | undefined,
  pid: ValidPlayerId,
): state is GameState {
  return (
    state !== undefined &&
    validPid(pid, state) &&
    !isPlayerEliminated(state.players[pid])
  );
}

function validPid(pid: number, state: GameState): boolean {
  return Number.isInteger(pid) && pid >= 0 && pid < state.players.length;
}
