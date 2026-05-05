// Deep imports: these are network-replay primitives used only here. They are
// intentionally not exposed via ../game/index.ts — see
// scripts/lint-restricted-imports.ts for the allowlist that pins this exemption.

import { applyCannonFired } from "../game/battle-system.ts";
import { applyPiecePlacement } from "../game/build-system.ts";
import { applyCannonAtDrain } from "../game/cannon-system.ts";
import { canPlacePiece, highlightTowerSelection } from "../game/index.ts";
import { MESSAGE, type ServerMessage } from "../protocol/protocol.ts";
import {
  isHostInContext,
  isRemotePlayer,
} from "../runtime/runtime-tick-context.ts";
import type { ScheduledAction } from "../shared/core/action-schedule.ts";
import { CANNON_MODE_IDS } from "../shared/core/cannon-mode-defs.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import { inBoundsStrict } from "../shared/core/spatial.ts";
import type { PlayerController } from "../shared/core/system-interfaces.ts";
import { type GameState, type SelectionState } from "../shared/core/types.ts";
import {
  LifeLostChoice,
  type ResolvedChoice,
} from "../shared/ui/interaction-types.ts";
import type { OnlineSession } from "./online-session.ts";
import { type RemoteCrosshairTargets, toCannonMode } from "./online-types.ts";

interface LifeLostChoiceEntry {
  playerId: ValidPlayerSlot;
  choice: LifeLostChoice;
}

interface LifeLostChoiceDialog {
  entries: LifeLostChoiceEntry[];
}

interface UpgradePickChoiceEntry {
  playerId: ValidPlayerSlot;
  choice: string | null;
  offers: readonly string[];
}

interface UpgradePickChoiceDialog {
  entries: UpgradePickChoiceEntry[];
}

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
  schedule: (action: ScheduledAction) => void;
  /** Per-slot controllers — phantom messages for remote-controlled slots
   *  write directly into `controllers[msg.playerId].current{Build,Cannon}Phantom(s)`. */
  getControllers: () => readonly PlayerController[];
  selectionStates: Map<number, SelectionState>;
  syncSelectionOverlay: () => void;
  isCastleReselectPhase: () => boolean;
  confirmSelectionAndStartBuild: (
    playerId: ValidPlayerSlot,
    isReselect: boolean,
    source?: "local" | "network",
    applyAt?: number,
  ) => void;
  allSelectionsConfirmed: () => boolean;
  finishReselection: () => void;
  finishSelection: () => void;
  getLifeLostDialog: () => LifeLostChoiceDialog | null;
  getUpgradePickDialog: () => UpgradePickChoiceDialog | null;
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
      // same logical sim tick on every peer. The "network" source skips
      // sendTowerSelected (the server already relayed the message; an
      // echo would be redundant). When `applyAt` is missing (older wire
      // shape, defensive), the immediate-apply fallback inside
      // `confirmSelectionAndStartBuild` runs.
      deps.confirmSelectionAndStartBuild(
        msg.playerId,
        deps.isCastleReselectPhase(),
        "network",
        msg.applyAt,
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
 *  mirror schedule for the originator side lives in `runtime-phase-ticks
 *  .ts:tickCannonPhase`'s broadcast block. */
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
    apply: (drainState) => {
      drainState.cannonPlaceDone.add(playerId);
    },
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
  if (!isRemoteHumanAction(msg.playerId, deps)) return DROPPED;
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
    applyCannonFired(state, msg);
    state.bus.emit(msg.type, msg);
    return APPLIED;
  }
  const applyAt = msg.applyAt;
  deps.schedule({
    applyAt,
    playerId: msg.playerId,
    apply: (drainState) => {
      applyCannonFired(drainState, msg);
      drainState.bus.emit(msg.type, msg);
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
 *  Contrast with crosshairs in online-host-crosshairs.ts which use
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

/** Apply a remote slot's life-lost choice. Same clone-everywhere shape
 *  as `handleUpgradePick`: runs on host AND watcher because a real human's
 *  controller has no local AI brain to fill `entry.choice`. AI / assisted
 *  controllers fill `entry.choice` deterministically (state.rng-derived)
 *  on every peer, so a wire-arrived duplicate is silently dropped by the
 *  `entry.choice === LifeLostChoice.PENDING` guard below. */
function handleLifeLostChoice(
  msg: LifeLostChoiceMsg,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  deps.log(
    `life_lost_choice from P${msg.playerId}: ${msg.choice} (dialog=${deps.getLifeLostDialog() ? "active" : "null"})`,
  );
  const validated = parseLifeLostChoice(msg.choice);
  if (validated === null) return DROPPED;
  const dialog = deps.getLifeLostDialog();
  if (dialog) {
    const entry = dialog.entries.find((e) => e.playerId === msg.playerId);
    if (entry && entry.choice === LifeLostChoice.PENDING) {
      entry.choice = validated;
      return APPLIED;
    }
    return DROPPED;
  }
  // Dialog not yet created — queue choice for when it appears
  deps.session.earlyLifeLostChoices.set(msg.playerId, validated);
  return APPLIED;
}

/** Parse an untrusted value into a resolved LifeLostChoice, or null if invalid. */
function parseLifeLostChoice(raw: unknown): ResolvedChoice | null {
  if (raw === LifeLostChoice.CONTINUE) return LifeLostChoice.CONTINUE;
  if (raw === LifeLostChoice.ABANDON) return LifeLostChoice.ABANDON;
  return null;
}

/** Apply a remote slot's upgrade pick. Runs on host AND watcher under
 *  clone-everywhere — the watcher needs the wire signal because a real
 *  human's controller has no local AI brain to fill `entry.choice`
 *  itself. AI / assisted-human controllers also tick locally on every
 *  peer and pick deterministically (state.rng-derived), so a wire-arrived
 *  pick that matches an already-filled entry is a harmless duplicate. */
function handleUpgradePick(
  msg: UpgradePickMsg,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  deps.log(
    `upgrade_pick from P${msg.playerId}: ${msg.choice} (dialog=${deps.getUpgradePickDialog() ? "active" : "null"})`,
  );
  const dialog = deps.getUpgradePickDialog();
  if (dialog) {
    const entry = dialog.entries.find(
      (entry) =>
        entry.playerId === msg.playerId &&
        entry.choice === null &&
        entry.offers.includes(msg.choice),
    );
    if (entry) {
      entry.choice = msg.choice;
      return APPLIED;
    }
    return DROPPED;
  }
  deps.session.earlyUpgradePickChoices.set(msg.playerId, msg.choice);
  return APPLIED;
}

/** Watchers accept all remote messages; hosts only accept from remote humans. */
function isRemoteHumanAction(
  pid: ValidPlayerSlot,
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
  pid: number,
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
