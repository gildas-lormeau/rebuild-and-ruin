/**
 * Incremental message validation patterns (host vs watcher):
 *
 * SELECTION, PLACEMENT, AIM_UPDATE:
 *   Host validates remote-human actions (guards against invalid input).
 *   Watcher applies them directly (trusts host-relayed events).
 *
 * IMPACTS (WALL_DESTROYED, TOWER_HIT, etc.):
 *   Host computes these locally — drops incoming impact messages.
 *   Watcher applies them (host is authoritative for battle outcomes).
 *
 * PHANTOM UPDATES:
 *   No validation needed — UI-only, no state mutation.
 *
 * Rule of thumb: if (isHostInContext(session)) { validate then apply }; if not host { apply directly }.
 *
 * NOTE: session.isHost is VOLATILE — it can flip from false to true during
 * host promotion (see OnlineSession in online-session.ts). All reads go
 * through isHostInContext() from tick-context.ts (enforced by ESLint).
 */

import {
  type ImpactEvent,
  MESSAGE,
  type ServerMessage,
} from "../server/protocol.ts";
import { applyImpactEvent } from "./battle-system.ts";
import { applyPiecePlacement, canPlacePieceOffsets } from "./build-system.ts";
import {
  applyCannonPlacement,
  cannonSlotCost,
  cannonSlotsUsed,
  canPlaceCannon,
} from "./cannon-system.ts";
import { selectPlayerTower } from "./game-engine.ts";
import { GRID_COLS } from "./grid.ts";
import type { OnlineSession } from "./online-session.ts";
import { toCannonMode, type WatcherNetworkState } from "./online-types.ts";
import { isSelectionPending } from "./selection.ts";
import { inBoundsStrict } from "./spatial.ts";
import { isHostInContext } from "./tick-context.ts";
import {
  CANNON_MODES,
  type GameState,
  LifeLostChoice,
  type ResolvedChoice,
  type SelectionState,
} from "./types.ts";

interface LifeLostChoiceEntry {
  playerId: number;
  choice: LifeLostChoice;
}

interface LifeLostChoiceDialog {
  entries: LifeLostChoiceEntry[];
}

interface UpgradePickChoiceEntry {
  playerId: number;
  choice: string | null;
  offers: readonly string[];
}

interface UpgradePickChoiceDialog {
  entries: UpgradePickChoiceEntry[];
}

interface HandleServerIncrementalDeps {
  log: (msg: string) => void;
  session: Pick<
    OnlineSession,
    | "isHost"
    | "remoteHumanSlots"
    | "earlyLifeLostChoices"
    | "earlyUpgradePickChoices"
  >;
  watcher: WatcherNetworkState;
  getState: () => GameState | undefined;
  selectionStates: Map<number, SelectionState>;
  syncSelectionOverlay: () => void;
  isCastleReselectPhase: () => boolean;
  confirmSelectionAndStartBuild: (
    playerId: number,
    isReselect: boolean,
  ) => void;
  allSelectionsConfirmed: () => boolean;
  finishReselection: () => void;
  finishSelection: () => void;
  onFirstEnclosure?: (playerId: number) => void;
  getLifeLostDialog: () => LifeLostChoiceDialog | null;
  getUpgradePickDialog: () => UpgradePickChoiceDialog | null;
}

type TowerSelectedMsg = Extract<
  ServerMessage,
  { type: typeof MESSAGE.OPPONENT_TOWER_SELECTED }
>;

type PiecePlacedMsg = Extract<
  ServerMessage,
  { type: typeof MESSAGE.OPPONENT_PIECE_PLACED }
>;

type CannonPlacedMsg = Extract<
  ServerMessage,
  { type: typeof MESSAGE.OPPONENT_CANNON_PLACED }
>;

type CannonFiredMsg = Extract<
  ServerMessage,
  { type: typeof MESSAGE.CANNON_FIRED }
>;

type ImpactMsg = Extract<
  ServerMessage,
  {
    type:
      | typeof MESSAGE.WALL_DESTROYED
      | typeof MESSAGE.CANNON_DAMAGED
      | typeof MESSAGE.HOUSE_DESTROYED
      | typeof MESSAGE.GRUNT_KILLED
      | typeof MESSAGE.GRUNT_SPAWNED
      | typeof MESSAGE.PIT_CREATED;
  }
>;

type AimUpdateMsg = Extract<ServerMessage, { type: typeof MESSAGE.AIM_UPDATE }>;

type TowerKilledMsg = Extract<
  ServerMessage,
  { type: typeof MESSAGE.TOWER_KILLED }
>;

type PiecePhantomMsg = Extract<
  ServerMessage,
  { type: typeof MESSAGE.OPPONENT_PHANTOM }
>;

type CannonPhantomMsg = Extract<
  ServerMessage,
  { type: typeof MESSAGE.OPPONENT_CANNON_PHANTOM }
>;

type LifeLostChoiceMsg = Extract<
  ServerMessage,
  { type: typeof MESSAGE.LIFE_LOST_CHOICE }
>;

/** Result of handling a server message.
 *  `applied` = true when the message mutated game state.
 *  `applied` = false when it was silently dropped (validation failed,
 *  not a remote-human action, host-only filter, etc.). */
interface HandleResult {
  applied: boolean;
}

type UpgradePickMsg = Extract<
  ServerMessage,
  { type: typeof MESSAGE.UPGRADE_PICK }
>;

const APPLIED: HandleResult = { applied: true };
const DROPPED: HandleResult = { applied: false };

/** Dispatch incremental game messages from the server.
 *  Each case follows the same pattern: validate → isRemoteHumanAction guard → apply.
 *  Returns `{ applied }` for observability; returns `null` if unrecognized.
 *
 *  Case groups:
 *    Selection:  OPPONENT_TOWER_SELECTED
 *    Placement:  OPPONENT_PIECE_PLACED, OPPONENT_CANNON_PLACED
 *    Battle:     CANNON_FIRED, impact events (WALL_DESTROYED etc.), AIM_UPDATE, TOWER_KILLED
 *    Phantoms:   OPPONENT_PHANTOM, OPPONENT_CANNON_PHANTOM
 *    Life-lost:  LIFE_LOST_CHOICE */
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
    case MESSAGE.CANNON_FIRED:
      return handleCannonFired(msg, state, deps);
    case MESSAGE.WALL_DESTROYED:
    case MESSAGE.CANNON_DAMAGED:
    case MESSAGE.HOUSE_DESTROYED:
    case MESSAGE.GRUNT_KILLED:
    case MESSAGE.GRUNT_SPAWNED:
    case MESSAGE.PIT_CREATED:
      return handleImpactEvent(msg, state, deps);
    case MESSAGE.AIM_UPDATE:
      return handleAimUpdate(msg, deps);
    case MESSAGE.TOWER_KILLED:
      return handleTowerKilled(msg, state, deps);
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
  if (!state || !validPid(msg.playerId, state)) return DROPPED;
  if (msg.towerIdx < 0 || msg.towerIdx >= state.map.towers.length)
    return DROPPED;
  if (!isRemoteHumanAction(msg.playerId, deps)) return DROPPED;
  const tower = state.map.towers[msg.towerIdx];
  const expectedZone: number | undefined = state.playerZones[msg.playerId];
  if (!tower || expectedZone === undefined || tower.zone !== expectedZone)
    return DROPPED;
  const player = state.players[msg.playerId]!;
  selectPlayerTower(player, tower);
  const selectionState = deps.selectionStates.get(msg.playerId);
  if (isSelectionPending(selectionState)) {
    selectionState.highlighted = msg.towerIdx;
    deps.syncSelectionOverlay();
    if (msg.confirmed && isHostInContext(deps.session)) {
      // Host: immediately finalize selection for the remote player
      deps.confirmSelectionAndStartBuild(
        msg.playerId,
        deps.isCastleReselectPhase(),
      );
    } else if (msg.confirmed) {
      // Non-host watcher: mark confirmed locally; host's next checkpoint drives phase change
      selectionState.confirmed = true;
    }
  }
  return APPLIED;
}

function handlePiecePlaced(
  msg: PiecePlacedMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  if (!state || !validPid(msg.playerId, state)) return DROPPED;
  if (!inBoundsStrict(msg.row, msg.col)) return DROPPED;
  if (!Array.isArray(msg.offsets) || msg.offsets.length === 0) return DROPPED;
  if (!isRemoteHumanAction(msg.playerId, deps)) return DROPPED;
  if (
    isHostInContext(deps.session) &&
    !canPlacePieceOffsets(state, msg.playerId, msg.offsets, msg.row, msg.col)
  ) {
    deps.log(`piece_placed: rejected invalid placement for P${msg.playerId}`);
    return DROPPED;
  }
  deps.log(
    `applying piece placement for P${msg.playerId} (${msg.offsets.length} tiles)`,
  );
  const hadInterior = state.players[msg.playerId]!.interior.size > 0;
  applyPiecePlacement(state, msg.playerId, msg.offsets, msg.row, msg.col);
  if (!hadInterior && state.players[msg.playerId]!.interior.size > 0) {
    deps.onFirstEnclosure?.(msg.playerId);
  }
  return APPLIED;
}

function handleCannonPlaced(
  msg: CannonPlacedMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  if (!state || !validPid(msg.playerId, state)) return DROPPED;
  if (!inBoundsStrict(msg.row, msg.col)) return DROPPED;
  if (!CANNON_MODES.has(msg.mode)) return DROPPED;
  if (!isRemoteHumanAction(msg.playerId, deps)) return DROPPED;
  if (isHostInContext(deps.session)) {
    const player = state.players[msg.playerId];
    if (!player) return DROPPED;
    const maxCannons = state.cannonLimits[msg.playerId] ?? 0;
    const normalizedMode = toCannonMode(msg.mode);
    if (cannonSlotsUsed(player) + cannonSlotCost(normalizedMode) > maxCannons) {
      deps.log(
        `cannon_placed: rejected invalid placement for P${msg.playerId}`,
      );
      return DROPPED;
    }
    if (!canPlaceCannon(player, msg.row, msg.col, normalizedMode, state)) {
      deps.log(
        `cannon_placed: rejected invalid placement for P${msg.playerId}`,
      );
      return DROPPED;
    }
  }
  const cannonPlayer = state.players[msg.playerId]!;
  applyCannonPlacement(
    cannonPlayer,
    msg.row,
    msg.col,
    toCannonMode(msg.mode),
    state,
  );
  return APPLIED;
}

function handleCannonFired(
  msg: CannonFiredMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  if (!state || !validPid(msg.playerId, state)) return DROPPED;
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
  state.cannonballs.push({
    cannonIdx: msg.cannonIdx,
    startX: msg.startX,
    startY: msg.startY,
    x: msg.startX,
    y: msg.startY,
    targetX: msg.targetX,
    targetY: msg.targetY,
    speed: msg.speed,
    playerId: msg.playerId,
    incendiary: msg.incendiary,
  });
  return APPLIED;
}

/** Watcher-only: the host computes impacts locally, so it never applies
 *  incoming impact messages. Watchers apply all impacts unconditionally.
 *  This is intentionally different from other handlers that use
 *  `isRemoteHumanAction()` — impacts are authoritative host events, not
 *  player actions that need remote-human filtering. */
function handleImpactEvent(
  msg: ImpactMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  if (isHostInContext(deps.session) || !state) return DROPPED;
  if ("row" in msg && "col" in msg && !inBoundsStrict(msg.row, msg.col))
    return DROPPED;
  if ("playerId" in msg && !validPid(msg.playerId, state)) return DROPPED;
  if (msg.type === MESSAGE.WALL_DESTROYED) {
    const wallKey = msg.row * GRID_COLS + msg.col;
    const owner = state.players.find((player) => player.walls.has(wallKey));
    deps.log(
      `wall_destroyed: (${msg.row},${msg.col}) owner=P${owner?.id ?? "?"} shooter=P${msg.shooterId ?? "?"}`,
    );
  } else if (msg.type === MESSAGE.CANNON_DAMAGED) {
    deps.log(
      `cannon_damaged: P${msg.playerId} newHp=${msg.newHp} shooter=P${msg.shooterId ?? "?"}`,
    );
  }
  applyImpactEvent(state, msg as ImpactEvent);
  return APPLIED;
}

function handleAimUpdate(
  msg: AimUpdateMsg,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return DROPPED;
  if (!isRemoteHumanAction(msg.playerId, deps)) return DROPPED;
  deps.watcher.remoteCrosshairs.set(msg.playerId, { x: msg.x, y: msg.y });
  if (msg.orbit) deps.watcher.orbitParams.set(msg.playerId, msg.orbit);
  return APPLIED;
}

function handleTowerKilled(
  msg: TowerKilledMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  if (isHostInContext(deps.session) || !state) return DROPPED;
  if (msg.towerIdx < 0 || msg.towerIdx >= state.towerAlive.length)
    return DROPPED;
  state.towerAlive[msg.towerIdx] = false;
  return APPLIED;
}

function handlePiecePhantom(
  msg: PiecePhantomMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  if (state && !validPid(msg.playerId, state)) return DROPPED;
  if (!inBoundsStrict(msg.row, msg.col)) return DROPPED;
  if (!isRemoteHumanAction(msg.playerId, deps)) return DROPPED;
  // Replace existing phantom for this player (latest preview wins, not accumulated).
  // filter() removes the old entry; push() adds the new one.
  const updated = deps.watcher.remotePiecePhantoms.filter(
    (entry) => entry.playerId !== msg.playerId,
  );
  updated.push({
    offsets: msg.offsets,
    row: msg.row,
    col: msg.col,
    playerId: msg.playerId,
    valid: msg.valid,
  });
  deps.watcher.remotePiecePhantoms = updated;
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
  const updated = deps.watcher.remoteCannonPhantoms.filter(
    (entry) => entry.playerId !== msg.playerId,
  );
  updated.push({
    row: msg.row,
    col: msg.col,
    valid: msg.valid,
    mode: toCannonMode(msg.mode),
    playerId: msg.playerId,
  });
  deps.watcher.remoteCannonPhantoms = updated;
  return APPLIED;
}

function handleLifeLostChoice(
  msg: LifeLostChoiceMsg,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  if (!isHostInContext(deps.session)) return DROPPED;
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

function handleUpgradePick(
  msg: UpgradePickMsg,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  if (!isHostInContext(deps.session)) return DROPPED;
  deps.log(
    `upgrade_pick from P${msg.playerId}: ${msg.choice} (dialog=${deps.getUpgradePickDialog() ? "active" : "null"})`,
  );
  const dialog = deps.getUpgradePickDialog();
  if (dialog) {
    const entry = dialog.entries.find(
      (en) =>
        en.playerId === msg.playerId &&
        en.choice === null &&
        en.offers.includes(msg.choice),
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
  pid: number,
  deps: Pick<HandleServerIncrementalDeps, "session">,
): boolean {
  return (
    !isHostInContext(deps.session) || deps.session.remoteHumanSlots.has(pid)
  );
}

function validPid(pid: number, state: GameState): boolean {
  return Number.isInteger(pid) && pid >= 0 && pid < state.players.length;
}
