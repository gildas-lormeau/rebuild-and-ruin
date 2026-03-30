import { MESSAGE, type ServerMessage } from "../server/protocol.ts";
import type { ImpactEvent } from "./battle-system.ts";
import { selectPlayerTower } from "./game-engine.ts";
import type { OnlineSession } from "./online-session.ts";
import { toCannonMode, type WatcherNetworkState } from "./online-types.ts";
import { inBoundsStrict } from "./spatial.ts";
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

interface HandleServerIncrementalDeps {
  log: (msg: string) => void;
  session: Pick<
    OnlineSession,
    "isHost" | "remoteHumanSlots" | "earlyLifeLostChoices"
  >;
  watcher: WatcherNetworkState;
  getState: () => GameState | undefined;
  selectionStates: Map<number, SelectionState>;
  syncSelectionOverlay: () => void;
  isCastleReselectPhase: () => boolean;
  onRemotePlayerReselected: (playerId: number) => void;
  confirmSelectionAndStartBuild: (
    playerId: number,
    isReselect: boolean,
  ) => void;
  allSelectionsConfirmed: () => boolean;
  finishReselection: () => void;
  finishSelection: () => void;
  applyPiecePlacement: (
    state: GameState,
    playerId: number,
    offsets: readonly [number, number][],
    row: number,
    col: number,
  ) => void;
  onFirstEnclosure?: (playerId: number) => void;
  applyCannonPlacement: (
    state: GameState,
    playerId: number,
    row: number,
    col: number,
    mode: string,
  ) => void;
  canApplyPiecePlacement: (
    state: GameState,
    playerId: number,
    offsets: readonly [number, number][],
    row: number,
    col: number,
  ) => boolean;
  canApplyCannonPlacement: (
    state: GameState,
    playerId: number,
    row: number,
    col: number,
    mode: string,
  ) => boolean;
  applyImpactEvent: (state: GameState, event: ImpactEvent) => void;
  gridCols: number;
  getLifeLostDialog: () => LifeLostChoiceDialog | null;
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

/** Dispatch incremental game messages from the server.
 *  Each case follows the same pattern: validate → isRemoteHumanAction guard → apply → return true.
 *  Returns true if handled, false if unrecognized.
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
): boolean {
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
    default:
      return false;
  }
}

function handleTowerSelected(
  msg: TowerSelectedMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): true {
  // Validation failed — silently drop invalid message (expected during reconnection/race conditions)
  if (!state || !validPid(msg.playerId, state)) return true;
  if (msg.towerIdx < 0 || msg.towerIdx >= state.map.towers.length) return true;
  if (isRemoteHumanAction(msg.playerId, deps)) {
    const tower = state.map.towers[msg.towerIdx];
    const expectedZone: number | undefined = state.playerZones[msg.playerId];
    if (tower && expectedZone !== undefined && tower.zone === expectedZone) {
      const player = state.players[msg.playerId]!;
      selectPlayerTower(player, tower);
      const selectionState = deps.selectionStates.get(msg.playerId);
      if (selectionState && !selectionState.confirmed) {
        selectionState.highlighted = msg.towerIdx;
        deps.syncSelectionOverlay();
        if (msg.confirmed && deps.session.isHost) {
          deps.confirmSelectionAndStartBuild(
            msg.playerId,
            deps.isCastleReselectPhase(),
          );
        } else if (msg.confirmed) {
          selectionState.confirmed = true;
        }
      }
    }
  }
  return true;
}

function handlePiecePlaced(
  msg: PiecePlacedMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): true {
  // Validation failed — silently drop invalid message (expected during reconnection/race conditions)
  if (!state || !validPid(msg.playerId, state)) return true;
  if (!inBoundsStrict(msg.row, msg.col)) return true;
  if (!Array.isArray(msg.offsets) || msg.offsets.length === 0) return true;
  if (isRemoteHumanAction(msg.playerId, deps)) {
    if (
      deps.session.isHost &&
      !deps.canApplyPiecePlacement(
        state,
        msg.playerId,
        msg.offsets,
        msg.row,
        msg.col,
      )
    ) {
      deps.log(`piece_placed: rejected invalid placement for P${msg.playerId}`);
      return true;
    }
    deps.log(
      `applying piece placement for P${msg.playerId} (${msg.offsets.length} tiles)`,
    );
    const hadInterior = state.players[msg.playerId]!.interior.size > 0;
    deps.applyPiecePlacement(
      state,
      msg.playerId,
      msg.offsets,
      msg.row,
      msg.col,
    );
    if (!hadInterior && state.players[msg.playerId]!.interior.size > 0) {
      deps.onFirstEnclosure?.(msg.playerId);
    }
  }
  return true;
}

function handleCannonPlaced(
  msg: CannonPlacedMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): true {
  // Validation failed — silently drop invalid message (expected during reconnection/race conditions)
  if (!state || !validPid(msg.playerId, state)) return true;
  if (!inBoundsStrict(msg.row, msg.col)) return true;
  if (!CANNON_MODES.has(msg.mode)) return true;
  if (isRemoteHumanAction(msg.playerId, deps)) {
    if (
      deps.session.isHost &&
      !deps.canApplyCannonPlacement(
        state,
        msg.playerId,
        msg.row,
        msg.col,
        msg.mode,
      )
    ) {
      deps.log(
        `cannon_placed: rejected invalid placement for P${msg.playerId}`,
      );
      return true;
    }
    deps.applyCannonPlacement(state, msg.playerId, msg.row, msg.col, msg.mode);
  }
  return true;
}

function handleCannonFired(
  msg: CannonFiredMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): true {
  // Validation failed — silently drop invalid message (expected during reconnection/race conditions)
  if (!state || !validPid(msg.playerId, state)) return true;
  if (!Number.isFinite(msg.speed) || msg.speed <= 0) return true;
  if (
    !Number.isFinite(msg.startX) ||
    !Number.isFinite(msg.startY) ||
    !Number.isFinite(msg.targetX) ||
    !Number.isFinite(msg.targetY)
  )
    return true;
  if (isRemoteHumanAction(msg.playerId, deps)) {
    const player = state.players[msg.playerId];
    if (!player || !player.cannons[msg.cannonIdx]) {
      deps.log(
        `cannon_fired: stale ref P${msg.playerId} cannon[${msg.cannonIdx}] — skipped`,
      );
      return true;
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
  }
  return true;
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
): true {
  if (!deps.session.isHost && state) {
    // Validation failed — silently drop invalid message (expected during reconnection/race conditions)
    if ("row" in msg && "col" in msg && !inBoundsStrict(msg.row, msg.col))
      return true;
    if ("playerId" in msg && !validPid(msg.playerId, state)) return true;
    if (msg.type === MESSAGE.WALL_DESTROYED) {
      const wallKey = msg.row * deps.gridCols + msg.col;
      const owner = state.players.find((player) => player.walls.has(wallKey));
      deps.log(
        `wall_destroyed: (${msg.row},${msg.col}) owner=P${owner?.id ?? "?"} shooter=P${msg.shooterId ?? "?"}`,
      );
    } else if (msg.type === MESSAGE.CANNON_DAMAGED) {
      deps.log(
        `cannon_damaged: P${msg.playerId} newHp=${msg.newHp} shooter=P${msg.shooterId ?? "?"}`,
      );
    }
    deps.applyImpactEvent(state, msg as ImpactEvent);
  }
  return true;
}

function handleAimUpdate(
  msg: AimUpdateMsg,
  deps: HandleServerIncrementalDeps,
): true {
  // Validation failed — silently drop invalid message (expected during reconnection/race conditions)
  if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return true;
  if (isRemoteHumanAction(msg.playerId, deps)) {
    deps.watcher.remoteCrosshairs.set(msg.playerId, { x: msg.x, y: msg.y });
    if (msg.orbit) deps.watcher.orbitParams.set(msg.playerId, msg.orbit);
  }
  return true;
}

function handleTowerKilled(
  msg: TowerKilledMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): true {
  if (!deps.session.isHost && state) {
    // Validation failed — silently drop invalid message (expected during reconnection/race conditions)
    if (msg.towerIdx < 0 || msg.towerIdx >= state.towerAlive.length)
      return true;
    state.towerAlive[msg.towerIdx] = false;
  }
  return true;
}

function handlePiecePhantom(
  msg: PiecePhantomMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): true {
  // Validation failed — silently drop invalid message (expected during reconnection/race conditions)
  if (state && !validPid(msg.playerId, state)) return true;
  if (!inBoundsStrict(msg.row, msg.col)) return true;
  if (isRemoteHumanAction(msg.playerId, deps)) {
    const updated = deps.watcher.remotePiecePhantoms.filter(
      (entry) => entry.playerId !== msg.playerId,
    );
    updated.push({
      offsets: msg.offsets,
      row: msg.row,
      col: msg.col,
      playerId: msg.playerId,
    });
    deps.watcher.remotePiecePhantoms = updated;
  }
  return true;
}

function handleCannonPhantom(
  msg: CannonPhantomMsg,
  state: GameState | undefined,
  deps: HandleServerIncrementalDeps,
): true {
  // Validation failed — silently drop invalid message (expected during reconnection/race conditions)
  if (state && !validPid(msg.playerId, state)) return true;
  if (!inBoundsStrict(msg.row, msg.col)) return true;
  if (isRemoteHumanAction(msg.playerId, deps)) {
    const updated = deps.watcher.remoteCannonPhantoms.filter(
      (entry) => entry.playerId !== msg.playerId,
    );
    updated.push({
      row: msg.row,
      col: msg.col,
      valid: msg.valid,
      mode: toCannonMode(msg.mode),
      playerId: msg.playerId,
      facing: msg.facing,
    });
    deps.watcher.remoteCannonPhantoms = updated;
  }
  return true;
}

function handleLifeLostChoice(
  msg: LifeLostChoiceMsg,
  deps: HandleServerIncrementalDeps,
): true {
  if (!deps.session.isHost) return true;
  deps.log(
    `life_lost_choice from P${msg.playerId}: ${msg.choice} (dialog=${deps.getLifeLostDialog() ? "active" : "null"})`,
  );
  const validated = parseLifeLostChoice(msg.choice);
  // Validation failed — silently drop invalid message (expected during reconnection/race conditions)
  if (validated === null) return true;
  const dialog = deps.getLifeLostDialog();
  if (dialog) {
    const entry = dialog.entries.find((e) => e.playerId === msg.playerId);
    if (entry && entry.choice === LifeLostChoice.PENDING) {
      entry.choice = validated;
    }
  } else {
    // Dialog not yet created — queue choice for when it appears
    deps.session.earlyLifeLostChoices.set(msg.playerId, validated);
  }
  return true;
}

/** Parse an untrusted value into a resolved LifeLostChoice, or null if invalid. */
function parseLifeLostChoice(raw: unknown): ResolvedChoice | null {
  if (raw === LifeLostChoice.CONTINUE) return LifeLostChoice.CONTINUE;
  if (raw === LifeLostChoice.ABANDON) return LifeLostChoice.ABANDON;
  return null;
}

/** Watchers accept all remote messages; hosts only accept from remote humans. */
function isRemoteHumanAction(
  pid: number,
  deps: Pick<HandleServerIncrementalDeps, "session">,
): boolean {
  return !deps.session.isHost || deps.session.remoteHumanSlots.has(pid);
}

function validPid(pid: number, state: GameState): boolean {
  return Number.isInteger(pid) && pid >= 0 && pid < state.players.length;
}
