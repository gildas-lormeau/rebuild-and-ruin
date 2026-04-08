/**
 * Host-side tick functions for the cannon placement and wall build phases.
 *
 * Contains the pure tick logic (tickHostCannonPhase, tickHostBuildPhase)
 * consumed by runtime-phase-ticks.ts.
 *
 * Network-agnostic: callers pre-filter controllers into local vs remote
 * arrays and provide optional callbacks for event broadcasting. The game
 * domain has zero knowledge of host/watcher topology or remote human slots.
 *
 * PASS 1 / PASS 2 pattern (tickHostCannonPhase & tickHostBuildPhase):
 *   PASS 1 (per-frame): tick `localControllers` only — remote human placements
 *     arrive via network messages and are applied by the server-event handler.
 *   PASS 2 (phase end): finalize controllers. The finalization method differs
 *     by phase — see CONTRAST comments inside each function.
 */

import { getInterior, snapshotAllWalls } from "../shared/board-occupancy.ts";
import type { SerializedPlayer } from "../shared/checkpoint-data.ts";
import { FID } from "../shared/feature-defs.ts";
import { MASTER_BUILDER_BONUS_SECONDS } from "../shared/game-constants.ts";
import type { EntityOverlay } from "../shared/overlay-types.ts";
import {
  type BuildEndPayload,
  type CannonPhantom,
  type CannonPhantomPayload,
  type CannonPlacedPayload,
  cannonPhantomKey,
  type DedupChannel,
  NOOP_DEDUP_CHANNEL,
  type PiecePhantom,
  type PiecePhantomPayload,
  type PiecePlacedPayload,
  phantomWireMode,
  piecePhantomKey,
} from "../shared/phantom-types.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import { unpackTile } from "../shared/spatial.ts";
import type { PlayerController } from "../shared/system-interfaces.ts";
import {
  ACCUM_CANNON,
  advancePhaseTimer,
  tickGruntsIfDue,
} from "../shared/tick-context.ts";
import {
  type GameState,
  hasFeature,
  isMasterBuilderLocked,
} from "../shared/types.ts";
import { snapshotEntities } from "./phase-banner.ts";
import { runBuildEndSequence } from "./phase-transition-steps.ts";

interface HostFrame {
  phantoms: {
    cannonPhantoms?: CannonPhantom[];
    piecePhantoms?: PiecePhantom[];
    defaultFacings?: ReadonlyMap<number, number>;
  };
}

interface TickHostCannonPhaseDeps {
  dt: number;
  state: GameState;
  accum: { cannon: number };
  frame: HostFrame;
  /** Pre-filtered to local controllers only (PASS 1: per-frame tick). */
  localControllers: PlayerController[];
  /** Remote controllers that get initCannons-only finalization (PASS 2). */
  remoteControllers: PlayerController[];
  render: () => void;
  startBattle: () => void;
  /** Optional: called when a local controller places a cannon. */
  onCannonPlaced?: (msg: CannonPlacedPayload) => void;
  /** Optional: called when a local controller produces a phantom.
   *  Dedup is handled internally via lastSentCannonPhantom. */
  onCannonPhantom?: (msg: CannonPhantomPayload) => void;
  /** Remote cannon phantoms to merge into the frame (pre-filtered by caller). */
  remoteCannonPhantoms?: readonly CannonPhantom[];
  /** Dedup channel for phantom broadcasts. Defaults to no-op. */
  lastSentCannonPhantom?: DedupChannel;
}

interface TickHostBuildPhaseDeps {
  dt: number;
  state: GameState;
  banner: { wallsBeforeSweep?: Set<number>[]; prevEntities?: EntityOverlay };
  accum: { build: number; grunt: number };
  frame: HostFrame;
  /** Pre-filtered to local controllers only (PASS 1: per-frame tick + PASS 2: finalize). */
  localControllers: PlayerController[];
  /** Full controller array indexed by player slot (for pid-keyed lookups like onLifeLost). */
  allControllers: PlayerController[];
  render: () => void;
  tickGrunts: (state: GameState) => void;
  isHuman: (controller: PlayerController) => boolean;
  finalizeBuildPhase: (state: GameState) => {
    needsReselect: ValidPlayerSlot[];
    eliminated: ValidPlayerSlot[];
  };
  showLifeLostDialog: (
    needsReselect: readonly ValidPlayerSlot[],
    eliminated: readonly ValidPlayerSlot[],
  ) => void;
  onLifeLostResolved: () => boolean;
  showScoreDeltas: (onDone: () => void) => void;
  onFirstEnclosure?: (playerId: ValidPlayerSlot) => void;
  /** Whether a controller should NOT receive onLifeLost notification
   *  (e.g. remote humans whose notifications arrive via network). */
  shouldSkipLifeLostNotify?: (pid: ValidPlayerSlot) => boolean;
  /** Optional: called when a local AI controller places walls. */
  onPiecePlaced?: (msg: PiecePlacedPayload) => void;
  /** Optional: called when a local controller produces a phantom. */
  onPhantom?: (msg: PiecePhantomPayload) => void;
  /** Whether this client should broadcast AI wall diffs (host only). */
  shouldBroadcastWalls?: boolean;
  /** Remote piece phantoms to merge into the frame (pre-filtered by caller). */
  remotePiecePhantoms?: readonly PiecePhantom[];
  /** Dedup channel for phantom broadcasts. Defaults to no-op. */
  lastSentPiecePhantom?: DedupChannel;
  /** Serialize players for the build-end checkpoint. */
  serializePlayers?: (state: GameState) => SerializedPlayer[];
  /** Optional: called at end of build phase with the build-end payload. */
  onBuildEnd?: (msg: BuildEndPayload) => void;
}

/** Sentinel channel for local play — never blocks sends.
 *  Used as fallback when networking deps are absent. */
const LOCAL_CHANNEL = NOOP_DEDUP_CHANNEL;
/** Protocol placeholder — broadcastNewWalls sends absolute tile positions in `offsets`,
 *  so `row`/`col` are unused. This constant documents the intent. */
const PLACEHOLDER_ORIGIN = { row: 0, col: 0 } as const;

/** Tick the cannon phase. Returns true when the phase ends (all controllers
 *  done or timer expired → transitions to battle), false while still ticking.
 *
 * Controller cannon lifecycle per frame:
 *   cannonTick(state, dt) — called each frame (AI places, Human updates cursor)
 *   isCannonPhaseDone(state, max) — check if controller is finished
 *   flushCannons(state, max) — finalize remaining placements (called once at phase end)
 *   initCannons(state, max) — auto-place round-1 cannons if none placed (called once after flush)
 * flush + init are combined in finalizeCannonPhase() which guarantees correct ordering.
 *
 * Remote vs local dispatch:
 *   Pass 1 (per-frame): ticks LOCAL controllers only (remoteHumanSlots are skipped).
 *   Pass 2 (phase end): calls flushCannons on LOCAL only, initCannons on ALL
 *     (remote humans get initCannons only — their placements arrive via network).
 *
 * Remote human finalization — CONTRAST with tickHostBuildPhase:
 *   Cannon: remote humans call initCannons() because cannon state must be ready
 *     for the immediate battle transition — there is no "startCannonPhase" re-init.
 *   Build: remote humans are SKIPPED entirely because bag state is re-initialized
 *     at the start of the next build phase via startBuildPhase().
 *   Using the wrong method corrupts state. Do NOT unify these two approaches.
 */
export function tickHostCannonPhase(deps: TickHostCannonPhaseDeps): boolean {
  const {
    dt,
    state,
    accum,
    frame,
    localControllers,
    remoteControllers,
    render,
    startBattle,
  } = deps;
  const lastSentCannonPhantom = deps.lastSentCannonPhantom ?? LOCAL_CHANNEL;

  advancePhaseTimer(accum, ACCUM_CANNON, state, dt, state.cannonPlaceTimer);

  const defaultFacings = new Map<number, number>();
  for (const player of state.players) {
    defaultFacings.set(player.id, player.defaultFacing);
  }
  frame.phantoms = { cannonPhantoms: [], defaultFacings };
  // ── PASS 1: Tick local controllers (process input & AI decisions) ──
  for (const ctrl of localControllers) {
    const cannonsBefore = state.players[ctrl.playerId]!.cannons.length;
    const phantom = ctrl.cannonTick(state, dt);

    if (deps.onCannonPlaced) {
      const cannonsAfter = state.players[ctrl.playerId]!.cannons.length;
      for (
        let cannonIdx = cannonsBefore;
        cannonIdx < cannonsAfter;
        cannonIdx++
      ) {
        const cannon = state.players[ctrl.playerId]!.cannons[cannonIdx]!;
        deps.onCannonPlaced({
          playerId: ctrl.playerId,
          row: cannon.row,
          col: cannon.col,
          mode: cannon.mode,
        });
      }
    }

    if (!phantom) continue;

    frame.phantoms.cannonPhantoms!.push(phantom);
    if (!deps.onCannonPhantom) continue;

    if (
      !lastSentCannonPhantom.shouldSend(
        ctrl.playerId,
        cannonPhantomKey(phantom),
      )
    )
      continue;
    deps.onCannonPhantom({
      playerId: ctrl.playerId,
      row: phantom.row,
      col: phantom.col,
      mode: phantomWireMode(phantom),
      valid: phantom.valid,
    });
  }

  // Merge remote phantoms (pre-filtered by caller)
  const remoteCannonPhantoms = deps.remoteCannonPhantoms ?? [];
  if (remoteCannonPhantoms.length > 0) {
    frame.phantoms.cannonPhantoms!.push(...remoteCannonPhantoms);
  }

  render();

  const allDone = localControllers.every((ctrl) => {
    const player = state.players[ctrl.playerId]!;
    if (player.eliminated) return true;
    const max = state.cannonLimits[player.id] ?? 0;
    return ctrl.isCannonPhaseDone(state, max);
  });

  if (state.timer > 0 && !allDone) return false;

  // ── PASS 2: Finalize all controllers for phase transition ──
  // LOAD-BEARING SPLIT (do not merge):
  // Remote humans: call initCannons() only (their cannons were flushed client-side).
  // Local controllers (AI + local human): call finalizeCannonPhase() which flushes then inits.
  // Using the wrong method corrupts cannon state — finalizeCannonPhase on a remote
  // double-flushes; initCannons on a local skips the flush entirely.
  // CONTRAST with build finalization: build skips remote humans entirely because bag
  // state is re-initialized via startBuildPhase. Cannon has no equivalent re-init step.
  // NOTE: Intentionally includes eliminated players — they need cannon state
  // cleanup (flush + round-1 init) for potential castle reselection.
  for (const ctrl of remoteControllers) {
    const max = state.cannonLimits[ctrl.playerId] ?? 0;
    ctrl.initCannons(state, max);
  }
  for (const ctrl of localControllers) {
    const max = state.cannonLimits[ctrl.playerId] ?? 0;
    ctrl.finalizeCannonPhase(state, max);
  }

  startBattle();
  return true;
}

/** Tick the build phase. Returns true when the phase ends (timer expired,
 *  controllers finalized, life-loss dialogs queued), false while still ticking.
 *
 *  Remote vs local dispatch:
 *    Per-frame: ticks LOCAL controllers only (remoteHumanSlots skipped — their
 *      placements arrive via network and are applied by the message handler).
 *    Phase end (finalizeBuildAndShowDialogs): calls finalizeBuildPhase on LOCAL only —
 *      remote clients finalize their own controllers independently.
 *
 *  Remote human finalization — CONTRAST with tickHostCannonPhase:
 *    Build: remote humans are SKIPPED (bag state is re-initialized via startBuildPhase).
 *    Cannon: remote humans call initCannons() (no equivalent re-init step exists).
 *    Using the wrong method corrupts state. Do NOT unify these two approaches. */
export function tickHostBuildPhase(deps: TickHostBuildPhaseDeps): boolean {
  const { dt, state, accum, frame, localControllers, render } = deps;

  // --- Timer + grunt tick ---
  const hasMB = (state.modern?.masterBuilderOwners?.size ?? 0) > 0;
  const buildMax =
    state.buildTimer + (hasMB ? MASTER_BUILDER_BONUS_SECONDS : 0);
  advancePhaseTimer(accum, "build", state, dt, buildMax);
  // Decrement Master Builder lockout (non-owners can't build until it reaches 0)
  if (
    hasFeature(state, FID.UPGRADES) &&
    state.modern!.masterBuilderLockout > 0
  ) {
    state.modern!.masterBuilderLockout = Math.max(
      0,
      state.modern!.masterBuilderLockout - dt,
    );
  }
  tickGruntsIfDue(accum, dt, state, deps.tickGrunts);

  // --- Process each controller's build actions, collect phantoms ---
  frame.phantoms = { piecePhantoms: [] };
  processControllerBuildActions(deps, frame);

  // --- Merge remote phantoms (pre-filtered by caller) ---
  const remotePiecePhantoms = deps.remotePiecePhantoms ?? [];
  if (remotePiecePhantoms.length > 0) {
    frame.phantoms.piecePhantoms!.push(...remotePiecePhantoms);
  }

  render();
  if (state.timer > 0) return false;

  // --- End of phase: finalize and handle life loss ---
  finalizeBuildAndShowDialogs(deps, localControllers);
  return true;
}

/** Tick each local controller's build logic, detect new walls, collect phantoms. */
function processControllerBuildActions(
  deps: TickHostBuildPhaseDeps,
  frame: HostFrame,
): void {
  const { state, dt, localControllers } = deps;
  const lastSentPiecePhantom = deps.lastSentPiecePhantom ?? LOCAL_CHANNEL;

  // ── PASS 1: Tick local controllers (process input & AI decisions) ──
  for (const ctrl of localControllers) {
    // Master Builder lockout: skip non-owners during the exclusive window
    if (isMasterBuilderLocked(state, ctrl.playerId)) continue;
    const player = state.players[ctrl.playerId];
    if (!player) continue;
    const hadInterior = getInterior(player).size > 0;

    const phantoms = buildTickWithWallBroadcast(
      ctrl,
      player,
      state,
      dt,
      !!deps.shouldBroadcastWalls && !deps.isHuman(ctrl),
      deps.onPiecePlaced,
    );

    if (!hadInterior && getInterior(player).size > 0) {
      deps.onFirstEnclosure?.(ctrl.playerId);
    }

    collectBuildPhantoms(phantoms, frame, lastSentPiecePhantom, deps.onPhantom);
  }
}

/** Snapshot walls, run buildTick, and broadcast any new AI walls.
 *  Enforces the invariant that the snapshot is captured BEFORE the tick —
 *  reversing the order silently produces empty diffs with no compile error. */
function buildTickWithWallBroadcast(
  ctrl: PlayerController,
  player: { readonly walls: ReadonlySet<number> },
  state: GameState,
  dt: number,
  shouldSnapshot: boolean,
  onPiecePlaced?: (msg: {
    playerId: ValidPlayerSlot;
    row: number;
    col: number;
    offsets: [number, number][];
  }) => void,
): readonly (PiecePhantom & { valid?: boolean })[] {
  const wallSnapshot = shouldSnapshot ? new Set(player.walls) : null;
  const phantoms = ctrl.buildTick(state, dt);
  if (wallSnapshot && onPiecePlaced) {
    emitNewWalls(state, ctrl.playerId, wallSnapshot, onPiecePlaced);
  }
  return phantoms;
}

/** Collect build-phase phantoms into the frame and emit new ones via callback. */
function collectBuildPhantoms(
  phantoms: readonly (PiecePhantom & { valid?: boolean })[],
  frame: HostFrame,
  lastSentPiecePhantom: DedupChannel,
  onPhantom: ((msg: PiecePhantomPayload) => void) | undefined,
): void {
  for (const phantom of phantoms) {
    frame.phantoms.piecePhantoms!.push({
      offsets: phantom.offsets,
      row: phantom.row,
      col: phantom.col,
      playerId: phantom.playerId,
      valid: phantom.valid ?? true,
    });

    if (!onPhantom) continue;
    if (
      !lastSentPiecePhantom.shouldSend(
        phantom.playerId,
        piecePhantomKey(phantom),
      )
    )
      continue;
    onPhantom({
      playerId: phantom.playerId,
      row: phantom.row,
      col: phantom.col,
      offsets: phantom.offsets,
      valid: phantom.valid ?? true,
    });
  }
}

/** Detect walls added by an AI controller tick and emit them via callback. */
function emitNewWalls(
  state: GameState,
  playerId: ValidPlayerSlot,
  wallSnapshot: ReadonlySet<number>,
  onPiecePlaced: (msg: {
    playerId: ValidPlayerSlot;
    row: number;
    col: number;
    offsets: [number, number][];
  }) => void,
): void {
  const player = state.players[playerId]!;
  if (player.walls.size <= wallSnapshot.size) return;
  const offsets: [number, number][] = [];
  for (const key of player.walls) {
    if (!wallSnapshot.has(key)) {
      const { r, c } = unpackTile(key);
      offsets.push([r, c]);
    }
  }
  if (offsets.length > 0) {
    onPiecePlaced({ playerId, ...PLACEHOLDER_ORIGIN, offsets });
  }
}

/** End build phase: finalize, emit build-end, and show life-lost dialogs. */
function finalizeBuildAndShowDialogs(
  deps: TickHostBuildPhaseDeps,
  localControllers: readonly PlayerController[],
): void {
  const { state } = deps;
  const serializePlayers = deps.serializePlayers ?? (() => []);

  // ── PASS 2: Finalize local controllers for phase transition ──
  // Remote humans: skipped (their build was finalized client-side; bag state is
  // re-initialized at the start of the next build phase via startBuildPhase).
  // Local controllers (AI + local human): call finalizeBuildPhase().
  // CONTRAST with cannon finalization: cannon calls initCannons() on remote
  // humans because cannon state must be ready for the immediate battle transition.
  // NOTE: Intentionally includes eliminated players — they need state cleanup
  // (bag/piece nulling) for potential castle reselection.
  for (const ctrl of localControllers) {
    ctrl.finalizeBuildPhase(state);
  }

  // Snapshot MUST precede finalize — finalize calls sweepAllPlayersWalls
  // (deletes isolated walls) and reviveEnclosedTowers (mutates towerAlive).
  // The banner needs pre-finalize snapshots for both.
  const { wallsBeforeSweep, prevEntities, needsReselect, eliminated } =
    snapshotThenFinalize(state, deps.finalizeBuildPhase);
  deps.banner.wallsBeforeSweep = wallsBeforeSweep;
  deps.banner.prevEntities = prevEntities;
  if (deps.onBuildEnd) {
    deps.onBuildEnd({
      needsReselect,
      eliminated,
      scores: state.players.map((player) => player.score),
      players: serializePlayers(state),
    });
  }

  const shouldSkipNotify = deps.shouldSkipLifeLostNotify ?? (() => false);
  runBuildEndSequence({
    needsReselect,
    eliminated,
    showScoreDeltas: deps.showScoreDeltas,
    notifyLifeLost: (pid) => {
      if (!shouldSkipNotify(pid)) deps.allControllers[pid]!.onLifeLost();
    },
    showLifeLostDialog: deps.showLifeLostDialog,
    onLifeLostResolved: deps.onLifeLostResolved,
  });
}

/** Snapshot all walls THEN finalize the build phase. Enforces the invariant
 *  that the snapshot is captured before sweepAllPlayersWalls deletes isolated walls.
 *
 *  INVARIANT: Snapshot MUST precede finalizeBuildPhase(). Wall sweeping deletes
 *  isolated walls during finalization — snapshotting after would show post-sweep state
 *  in the banner, hiding destroyed walls from the player.
 *
 *  Zone-dependent entities (grunts, houses, pits, bonuses) are re-snapshotted
 *  AFTER finalize so that resetZoneState changes are reflected. Without this,
 *  the banner old-scene would flash stale grunts that were already removed
 *  before the life-lost dialog appeared. */
function snapshotThenFinalize(
  state: GameState,
  finalizeBuildPhase: (state: GameState) => {
    needsReselect: ValidPlayerSlot[];
    eliminated: ValidPlayerSlot[];
  },
): {
  wallsBeforeSweep: Set<number>[];
  prevEntities: EntityOverlay;
  needsReselect: ValidPlayerSlot[];
  eliminated: ValidPlayerSlot[];
} {
  const wallsBeforeSweep = snapshotAllWalls(state);
  const prevEntities = snapshotEntities(state);
  const { needsReselect, eliminated } = finalizeBuildPhase(state);

  // Re-snapshot zone-dependent entities after finalize — resetZoneState
  // removes grunts/houses/pits/bonuses from eliminated/reselect zones,
  // and the player already sees them gone during the life-lost dialog.
  // towerAlive is also re-snapshotted: resetZoneState revives all zone
  // towers, and during CASTLE_RESELECT no banner plays to reveal the
  // change — so the snapshot must match the post-reset state.
  // Walls keep their pre-finalize snapshot (wall sweep is banner-visualized).
  if (needsReselect.length > 0 || eliminated.length > 0) {
    prevEntities.grunts = state.grunts.map((grunt) => ({ ...grunt }));
    prevEntities.houses = state.map.houses.map((house) => ({ ...house }));
    prevEntities.burningPits = state.burningPits.map((pit) => ({ ...pit }));
    prevEntities.bonusSquares = state.bonusSquares.map((bonus) => ({
      ...bonus,
    }));
    prevEntities.towerAlive = [...state.towerAlive];
  }

  return { wallsBeforeSweep, prevEntities, needsReselect, eliminated };
}
