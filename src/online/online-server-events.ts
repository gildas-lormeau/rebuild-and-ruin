// Deep imports: these are network-replay primitives used only here. They are
// intentionally not exposed via ../game/index.ts — see
// scripts/lint-restricted-imports.ts for the allowlist that pins this exemption.

import {
  applyImpactEvent,
  applyTowerKilled,
  spawnCannonballFromMessage,
} from "../game/battle-system.ts";
import { applyPiecePlacement } from "../game/build-system.ts";
import { applyCannonPlacement } from "../game/cannon-system.ts";
import {
  cannonSlotsUsed,
  canPlaceCannon,
  canPlacePiece,
  consumeRapidEmplacement,
  effectivePlacementCost,
  highlightTowerSelection,
} from "../game/index.ts";
import { MESSAGE, type ServerMessage } from "../protocol/protocol.ts";
import {
  isHostInContext,
  isRemotePlayer,
} from "../runtime/runtime-tick-context.ts";
import type { ImpactEvent } from "../shared/core/battle-events.ts";
import { CANNON_MODE_IDS } from "../shared/core/cannon-mode-defs.ts";
import { getInterior } from "../shared/core/player-interior.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import { inBoundsStrict, packTile } from "../shared/core/spatial.ts";
import { type GameState, type SelectionState } from "../shared/core/types.ts";
import {
  LifeLostChoice,
  type ResolvedChoice,
} from "../shared/ui/interaction-types.ts";
import type { OnlineSession } from "./online-session.ts";
import { toCannonMode, type WatcherNetworkState } from "./online-types.ts";

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
  watcher: WatcherNetworkState;
  getState: () => GameState | undefined;
  selectionStates: Map<number, SelectionState>;
  syncSelectionOverlay: () => void;
  isCastleReselectPhase: () => boolean;
  confirmSelectionAndStartBuild: (
    playerId: ValidPlayerSlot,
    isReselect: boolean,
  ) => void;
  allSelectionsConfirmed: () => boolean;
  finishReselection: () => void;
  finishSelection: () => void;
  onFirstEnclosure?: (playerId: ValidPlayerSlot) => void;
  getLifeLostDialog: () => LifeLostChoiceDialog | null;
  getUpgradePickDialog: () => UpgradePickChoiceDialog | null;
}

type TowerSelectedMsg = Extract<
  ServerMessage,
  { type: "opponentTowerSelected" }
>;

type PiecePlacedMsg = Extract<ServerMessage, { type: "opponentPiecePlaced" }>;

type CannonPlacedMsg = Extract<ServerMessage, { type: "opponentCannonPlaced" }>;

type CannonFiredMsg = Extract<ServerMessage, { type: "cannonFired" }>;

type ImpactMsg = Extract<
  ServerMessage,
  {
    type:
      | "wallDestroyed"
      | "wallAbsorbed"
      | "wallShielded"
      | "cannonDamaged"
      | "houseDestroyed"
      | "gruntKilled"
      | "gruntChipped"
      | "gruntSpawned"
      | "pitCreated"
      | "iceThawed";
  }
>;

type AimUpdateMsg = Extract<ServerMessage, { type: "aimUpdate" }>;

type TowerKilledMsg = Extract<ServerMessage, { type: "towerKilled" }>;

type PiecePhantomMsg = Extract<ServerMessage, { type: "opponentPhantom" }>;

type CannonPhantomMsg = Extract<
  ServerMessage,
  { type: "opponentCannonPhantom" }
>;

type LifeLostChoiceMsg = Extract<ServerMessage, { type: "lifeLostChoice" }>;

/** Result of handling a server message.
 *  `applied` = true when the message mutated game state.
 *  `applied` = false when it was silently dropped (validation failed,
 *  not a remote-human action, host-only filter, etc.). */
interface HandleResult {
  applied: boolean;
}

type UpgradePickMsg = Extract<ServerMessage, { type: "upgradePick" }>;

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
    case MESSAGE.CANNON_FIRED:
      return handleCannonFired(msg, state, deps);
    case MESSAGE.WALL_DESTROYED:
    case MESSAGE.WALL_ABSORBED:
    case MESSAGE.WALL_SHIELDED:
    case MESSAGE.CANNON_DAMAGED:
    case MESSAGE.HOUSE_DESTROYED:
    case MESSAGE.GRUNT_KILLED:
    case MESSAGE.GRUNT_CHIPPED:
    case MESSAGE.GRUNT_SPAWNED:
    case MESSAGE.PIT_CREATED:
    case MESSAGE.ICE_THAWED:
      return handleImpactEvent(msg, state, deps);
    case MESSAGE.AIM_UPDATE:
      return handleAimUpdate(msg, state, deps);
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
  if (isPlayerEliminated(state.players[msg.playerId])) return DROPPED;
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
      if (isHostInContext(deps.session)) {
        deps.confirmSelectionAndStartBuild(
          msg.playerId,
          deps.isCastleReselectPhase(),
        );
      } else {
        selectionState.confirmed = true;
      }
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
  if (isPlayerEliminated(state.players[msg.playerId])) return DROPPED;
  if (!inBoundsStrict(msg.row, msg.col)) return DROPPED;
  if (!Array.isArray(msg.offsets) || msg.offsets.length === 0) return DROPPED;
  if (!isRemoteHumanAction(msg.playerId, deps)) return DROPPED;
  if (
    isHostInContext(deps.session) &&
    !canPlacePiece(state, msg.playerId, msg.offsets, msg.row, msg.col)
  ) {
    deps.log(`piece_placed: rejected invalid placement for P${msg.playerId}`);
    return DROPPED;
  }
  deps.log(
    `applying piece placement for P${msg.playerId} (${msg.offsets.length} tiles)`,
  );
  // Read interior size directly (not via getInterior) — the fanfare-trigger
  // check is cosmetic, and the interior may legitimately be stale on the
  // receive side immediately after a castle build animation or mid-round
  // reselect. applyPiecePlacement runs recheckTerritory afterward, so the
  // post-state read is always fresh.
  const hadInterior = state.players[msg.playerId]!.interior.size > 0;
  applyPiecePlacement(state, msg.playerId, msg.offsets, msg.row, msg.col);
  if (!hadInterior && getInterior(state.players[msg.playerId]!).size > 0) {
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
  if (isPlayerEliminated(state.players[msg.playerId])) return DROPPED;
  if (!inBoundsStrict(msg.row, msg.col)) return DROPPED;
  if (!CANNON_MODE_IDS.has(msg.mode)) return DROPPED;
  if (!isRemoteHumanAction(msg.playerId, deps)) return DROPPED;
  if (isHostInContext(deps.session)) {
    const player = state.players[msg.playerId];
    if (!player) return DROPPED;
    const maxCannons = state.cannonLimits[msg.playerId] ?? 0;
    const normalizedMode = toCannonMode(msg.mode);
    if (
      cannonSlotsUsed(player) + effectivePlacementCost(player, normalizedMode) >
      maxCannons
    ) {
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
  consumeRapidEmplacement(cannonPlayer);
  return APPLIED;
}

function handleCannonFired(
  msg: CannonFiredMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  if (!state || !validPid(msg.playerId, state)) return DROPPED;
  if (isPlayerEliminated(state.players[msg.playerId])) return DROPPED;
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
  spawnCannonballFromMessage(state, msg);
  state.bus.emit(msg.type, msg);
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
    const wallKey = packTile(msg.row, msg.col);
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
  state.bus.emit(msg.type as ImpactEvent["type"], msg as ImpactEvent);
  return APPLIED;
}

function handleAimUpdate(
  msg: AimUpdateMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): HandleResult {
  if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return DROPPED;
  if (state && !validPid(msg.playerId, state)) return DROPPED;
  if (isPlayerEliminated(state?.players[msg.playerId])) return DROPPED;
  if (!isRemoteHumanAction(msg.playerId, deps)) return DROPPED;
  deps.watcher.remoteCrosshairs.set(msg.playerId, { x: msg.x, y: msg.y });
  if (msg.orbit) deps.watcher.watcherOrbitParams.set(msg.playerId, msg.orbit);
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
  applyTowerKilled(state, msg);
  state.bus.emit(msg.type, msg);
  return APPLIED;
}

/** Phantoms use explicit filter+push array replacement for dedup (latest preview wins).
 *  Contrast with crosshairs in online-host-crosshairs.ts which use DedupChannel's
 *  atomic shouldSend() mechanism — crosshairs are fire-and-forget, phantoms accumulate. */
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

function validPid(pid: number, state: GameState): boolean {
  return Number.isInteger(pid) && pid >= 0 && pid < state.players.length;
}
