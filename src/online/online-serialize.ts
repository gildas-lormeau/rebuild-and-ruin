import {
  applyCheckpointModifierTiles,
  recomputeAllTerritory,
} from "../game/index.ts";
// Deep import: setPhase is a network-state-conformance primitive used to
// reconcile watcher phase with server checkpoints. Allowlisted in
// scripts/lint-restricted-imports.ts.
import { setPhase } from "../game/phase-setup.ts";
import type {
  SerializedGrunt,
  SerializedHouse,
  SerializedPlayer,
} from "../protocol/checkpoint-data.ts";
import { type FullStateMessage, MESSAGE } from "../protocol/protocol.ts";
import type {
  BalloonFlight,
  Cannon,
  Cannonball,
} from "../shared/core/battle-types.ts";
import { toCannonMode } from "../shared/core/cannon-mode-defs.ts";
import { FID } from "../shared/core/feature-defs.ts";
import {
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
} from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { CannonIdx, TowerIdx } from "../shared/core/geometry-types.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  TILE_COUNT,
  type TileKey,
} from "../shared/core/grid.ts";
import type { SerializedModifierTiles } from "../shared/core/modifier-defs.ts";
import { getCannon } from "../shared/core/occupancy-queries.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import {
  type GameState,
  hasFeature,
  setGameMode,
  type UpgradeOfferTuple,
} from "../shared/core/types.ts";
import type { UpgradeId } from "../shared/core/upgrade-defs.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";

interface FullStateResult {
  balloonFlights?: { flight: BalloonFlight; progress: number }[];
}

/** Returned when validation fails — no state was mutated. */
type FullStateApplyResult = FullStateResult | null;

export function createFullStateMessage(
  state: GameState,
  migrationSeq: number,
  flights?: readonly { flight: BalloonFlight; progress: number }[],
): FullStateMessage {
  return {
    type: MESSAGE.FULL_STATE,
    migrationSeq,
    phase: Phase[state.phase],
    round: state.round,
    timer: state.timer,
    battleCountdown: state.battleCountdown,
    maxRounds: state.maxRounds,
    shotsFired: state.shotsFired,
    rngState: state.rng.getState(),
    simTick: state.simTick,
    players: serializePlayers(state),
    grunts: serializeGrunts(state),
    houses: state.map.houses.map((h) => ({
      row: h.row,
      col: h.col,
      zone: h.zone,
      alive: h.alive,
    })),
    bonusSquares: serializeBonusSquares(state),
    towerAlive: [...state.towerAlive],
    burningPits: serializeBurningPits(state),
    cannonLimits: [...state.cannonLimits],
    cannonPlaceDone: [...state.cannonPlaceDone],
    salvageSlots: state.salvageSlots.some((slot) => slot > 0)
      ? [...state.salvageSlots]
      : undefined,
    playerZones: [...state.playerZones],
    gameMode: state.gameMode,
    activeModifier: state.modern?.activeModifier ?? null,
    activeModifierChangedTiles: [
      ...(state.modern?.activeModifierChangedTiles ?? []),
    ],
    lastModifierId: state.modern?.lastModifierId ?? null,
    ...serializeModernFields(state),
    towerPendingRevive: [...state.towerPendingRevive],
    capturedCannons: state.capturedCannons.map((captured) => ({
      victimId: captured.victimId,
      capturerId: captured.capturerId,
      cannonIdx: captured.cannonIdx,
    })),
    cannonballs: state.cannonballs.map((b) => copyCannonballCore(b)),
    balloonFlights:
      flights && flights.length > 0
        ? flights.map((balloonFlight) => ({
            ...balloonFlight.flight,
            progress: balloonFlight.progress,
          }))
        : undefined,
  };
}

export function restoreFullStateSnapshot(
  state: GameState,
  msg: FullStateMessage,
): FullStateApplyResult {
  const error = validateFullState(state, msg);
  if (error) {
    console.error(`[checkpoint] validation failed: ${error}`);
    return null;
  }

  const nextPhase = Phase[msg.phase as keyof typeof Phase]!;
  setPhase(state, nextPhase);
  state.round = msg.round;
  state.timer = msg.timer;
  state.battleCountdown = msg.battleCountdown;
  state.maxRounds = msg.maxRounds;
  state.shotsFired = msg.shotsFired;
  state.simTick = msg.simTick;
  state.cannonLimits = msg.cannonLimits;
  state.cannonPlaceDone = new Set(msg.cannonPlaceDone as ValidPlayerId[]);
  state.salvageSlots = msg.salvageSlots ?? state.players.map(() => 0);
  state.playerZones = msg.playerZones as ZoneId[];
  state.towerPendingRevive = new Set(msg.towerPendingRevive as TowerIdx[]);
  state.towerAlive = msg.towerAlive;
  setGameMode(
    state,
    msg.gameMode === GAME_MODE_MODERN ? GAME_MODE_MODERN : GAME_MODE_CLASSIC,
  );
  if (hasFeature(state, FID.MODIFIERS)) {
    state.modern!.activeModifier =
      (msg.activeModifier as NonNullable<
        GameState["modern"]
      >["activeModifier"]) ?? null;
    state.modern!.activeModifierChangedTiles =
      (msg.activeModifierChangedTiles as readonly number[] | undefined) ?? [];
    state.modern!.lastModifierId =
      (msg.lastModifierId as NonNullable<
        GameState["modern"]
      >["lastModifierId"]) ?? null;
    state.modern!.precomputedDustStormJitters =
      (msg.precomputedDustStormJitters as readonly number[] | undefined) ?? [];
    state.modern!.rubbleClearingHeld = msg.rubbleClearingHeld ?? null;
    state.modern!.supplyShips = msg.supplyShips ?? null;
    state.modern!.pendingSupplyBonuses = msg.pendingSupplyBonuses
      ? new Map(
          msg.pendingSupplyBonuses.map(([pid, bonuses]) => [
            pid as ValidPlayerId,
            [...bonuses],
          ]),
        )
      : null;
  }
  applyCheckpointModifierTiles(state, msg);
  if (hasFeature(state, FID.UPGRADES)) {
    state.modern!.pendingUpgradeOffers = msg.pendingUpgradeOffers
      ? new Map(
          msg.pendingUpgradeOffers.map(([pid, offers]) => [
            pid as ValidPlayerId,
            offers as UpgradeOfferTuple,
          ]),
        )
      : null;
    state.modern!.precomputedUpgradePicks = msg.precomputedUpgradePicks
      ? new Map(
          msg.precomputedUpgradePicks.map(([pid, choice]) => [
            pid as ValidPlayerId,
            choice as UpgradeId,
          ]),
        )
      : null;
    state.modern!.masterBuilderLockout = msg.masterBuilderLockout ?? 0;
    state.modern!.masterBuilderOwners = msg.masterBuilderOwners
      ? new Set(msg.masterBuilderOwners as ValidPlayerId[])
      : null;
  }
  if (hasFeature(state, FID.COMBOS)) {
    // Counters only — cosmetic events are not wired (late joiners don't
    // render streak floats they missed; see protocol.ts comboTracker doc).
    state.modern!.comboTracker = msg.comboTracker
      ? {
          players: msg.comboTracker.map((player) => ({ ...player })),
          events: [],
        }
      : null;
  }
  state.burningPits = msg.burningPits.map((pit) => ({
    row: pit.row,
    col: pit.col,
    roundsLeft: pit.roundsLeft,
  }));
  state.bonusSquares = msg.bonusSquares.map((bonus) => ({
    row: bonus.row,
    col: bonus.col,
    zone: bonus.zone,
  }));

  // Restore RNG internal state in place — preserves the single per-game
  // Rng instance held by callers (piece bags, AI strategies of pure-AI
  // initial-bootstrap controllers).
  state.rng.setState(msg.rngState);

  // Reuse existing checkpoint helpers
  applyPlayersCheckpoint(state, msg.players);
  recomputeAllTerritory(state);
  applyGruntsCheckpoint(state, msg.grunts);

  applyHousesCheckpoint(state, msg.houses);

  restoreCannonballs(state, msg);
  applyCapturedCannons(state, msg.capturedCannons);

  return {
    balloonFlights: msg.balloonFlights?.map((flight) => ({
      flight: {
        startX: flight.startX,
        startY: flight.startY,
        endX: flight.endX,
        endY: flight.endY,
      },
      progress: flight.progress,
    })),
  };
}

export function createGameOverPayload(
  winner: { id: ValidPlayerId },
  state: GameState,
  playerNames: ReadonlyArray<string>,
) {
  const winnerName = playerNames[winner.id] ?? `Player ${winner.id + 1}`;
  return {
    winnerName,
    serverPayload: {
      type: MESSAGE.GAME_OVER,
      winner: winnerName,
      scores: state.players.map((player) => ({
        name: playerNames[player.id] ?? `P${player.id + 1}`,
        score: player.score,
        eliminated: player.eliminated,
      })),
    },
  };
}

/** Replace the full houses array from checkpoint data. */
function applyHousesCheckpoint(
  state: GameState,
  houses: readonly SerializedHouse[],
): void {
  state.map.houses = houses.map((h) => ({
    row: h.row,
    col: h.col,
    zone: h.zone,
    alive: h.alive,
  }));
}

/** Apply serialized player data to the game state.
 *  Does NOT recompute territory — callers decide whether to call
 *  recomputeTerritoryFromWalls based on phase context (interior is
 *  intentionally stale during battle). */
function applyPlayersCheckpoint(
  state: GameState,
  serialized: readonly SerializedPlayer[],
): void {
  for (const entry of serialized) {
    const player = state.players[entry.id];
    if (!player) continue;

    player.walls = new Set(entry.walls as TileKey[]);
    player.cannons = entry.cannons.map((c) => ({
      row: c.row,
      col: c.col,
      hp: c.hp,
      mode: toCannonMode(c.mode),
      facing: c.facing ?? player.defaultFacing,
      mortar: c.mortar,
      shielded: c.shielded,
      shieldHp: c.shieldHp || undefined,
      balloonHits: c.balloonHits || undefined,
      balloonCapturerIds: c.balloonCapturerIds?.length
        ? [...c.balloonCapturerIds]
        : undefined,
    }));
    // homeTowerIdx and castleWallTiles are stable across one castle's lifetime;
    // they reset only on life-loss reselect, which every peer runs
    // deterministically via `resetPlayerBoardState` + `prepareCastleWallsForPlayer`.
    // Checkpoint messages omit them; only full-state (join/reconnect) sends them.
    const homeTowerIdx = entry.homeTowerIdx;
    if (homeTowerIdx !== undefined) {
      player.homeTower =
        homeTowerIdx !== null &&
        homeTowerIdx >= 0 &&
        homeTowerIdx < state.map.towers.length
          ? state.map.towers[homeTowerIdx]!
          : null;
    }
    if (entry.castleWallTiles !== undefined) {
      player.castleWallTiles = new Set(entry.castleWallTiles as TileKey[]);
    }
    player.lives = entry.lives;
    player.eliminated = entry.eliminated;
    player.score = entry.score;
    player.upgrades = new Map((entry.upgrades ?? []) as [UpgradeId, number][]);
    player.damagedWalls = new Set((entry.damagedWalls ?? []) as TileKey[]);
    player.inGracePeriod = entry.inGracePeriod ?? false;
  }
}

function applyGruntsCheckpoint(
  state: GameState,
  serialized: readonly SerializedGrunt[],
): void {
  state.grunts = serialized.map(deserializeGrunt);
}

/** Restore captured cannon object references from serialized indices.
 *  Used by full-state recovery (`restoreFullStateSnapshot`).
 *  Validates victimId bounds and cannonIdx before resolving object references. */
function applyCapturedCannons(
  state: GameState,
  entries: readonly {
    victimId: ValidPlayerId;
    capturerId: ValidPlayerId;
    cannonIdx: CannonIdx;
  }[],
): void {
  state.capturedCannons = [];
  for (const captured of entries) {
    if (captured.victimId < 0 || captured.victimId >= state.players.length)
      continue;
    const victim = state.players[captured.victimId]!;
    if (captured.cannonIdx < 0 || captured.cannonIdx >= victim.cannons.length)
      continue;
    state.capturedCannons.push({
      cannon: victim.cannons[captured.cannonIdx]!,
      cannonIdx: captured.cannonIdx,
      victimId: captured.victimId as ValidPlayerId,
      capturerId: captured.capturerId as ValidPlayerId,
    });
  }
}

/** Full player serialization — includes all fields for join/reconnect (full-state). */
function serializePlayers(state: GameState) {
  return state.players.map((player) => ({
    ...serializePlayerCore(player),
    cannons: player.cannons.map(serializeCannon),
    homeTowerIdx: player.homeTower?.index ?? null,
    castleWallTiles: [...player.castleWallTiles],
  }));
}

/** Shared core fields for both full and checkpoint serialization. */
function serializePlayerCore(player: Player) {
  return {
    id: player.id,
    walls: [...player.walls],
    lives: player.lives,
    eliminated: player.eliminated,
    score: player.score,
    upgrades:
      player.upgrades.size > 0 ? [...player.upgrades.entries()] : undefined,
    damagedWalls:
      player.damagedWalls.size > 0 ? [...player.damagedWalls] : undefined,
    inGracePeriod: player.inGracePeriod || undefined,
  };
}

function serializeCannon(cannon: Cannon) {
  return {
    row: cannon.row,
    col: cannon.col,
    hp: cannon.hp,
    mode: cannon.mode,
    facing: cannon.facing ?? 0,
    mortar: cannon.mortar,
    shielded: cannon.shielded,
    shieldHp: cannon.shieldHp || undefined,
    balloonHits: cannon.balloonHits || undefined,
    balloonCapturerIds: cannon.balloonCapturerIds?.length
      ? cannon.balloonCapturerIds
      : undefined,
  };
}

/** Serialize modern-mode fields shared by build-start and full-state messages. */
function serializeModernFields(state: GameState) {
  return {
    pendingUpgradeOffers: state.modern?.pendingUpgradeOffers
      ? [...state.modern.pendingUpgradeOffers.entries()]
      : null,
    precomputedUpgradePicks: state.modern?.precomputedUpgradePicks
      ? [...state.modern.precomputedUpgradePicks.entries()]
      : null,
    precomputedDustStormJitters: state.modern?.precomputedDustStormJitters
      ? [...state.modern.precomputedDustStormJitters]
      : [],
    masterBuilderLockout: state.modern?.masterBuilderLockout ?? 0,
    masterBuilderOwners: state.modern?.masterBuilderOwners
      ? [...state.modern.masterBuilderOwners]
      : null,
    rubbleClearingHeld: state.modern?.rubbleClearingHeld ?? null,
    supplyShips: state.modern?.supplyShips ?? null,
    pendingSupplyBonuses: state.modern?.pendingSupplyBonuses
      ? [...state.modern.pendingSupplyBonuses.entries()]
      : null,
    comboTracker: state.modern?.comboTracker
      ? state.modern.comboTracker.players.map((player) => ({
          lastWallHitTime: player.lastWallHitTime,
          wallStreak: player.wallStreak,
          lastGruntKillTime: player.lastGruntKillTime,
          gruntStreak: player.gruntStreak,
          wallsDestroyedThisRound: player.wallsDestroyedThisRound,
        }))
      : null,
    ...serializeModifierTileSets(state),
  };
}

function serializeModifierTileSets(state: GameState): SerializedModifierTiles {
  return {
    frozenTiles: state.modern?.frozenTiles
      ? [...state.modern.frozenTiles]
      : null,
    sinkholeTiles: state.modern?.sinkholeTiles
      ? [...state.modern.sinkholeTiles]
      : null,
    exposedRiverbedTiles: state.modern?.exposedRiverbedTiles
      ? [...state.modern.exposedRiverbedTiles]
      : null,
  };
}

/**
 * Structural validation — rejects the message before any state mutation
 * if it contains out-of-bounds indices or mismatched array lengths.
 */
function validateFullState(
  state: GameState,
  msg: FullStateMessage,
): string | null {
  if (Phase[msg.phase as keyof typeof Phase] === undefined)
    return `invalid phase "${msg.phase}"`;
  if (!Number.isFinite(msg.rngState)) return "non-finite rngState";

  const playerCount = state.players.length;
  const towerCount = state.map.towers.length;

  if (msg.players.length !== playerCount)
    return `players length ${msg.players.length} != ${playerCount}`;
  if (msg.cannonLimits.length !== playerCount)
    return `cannonLimits length ${msg.cannonLimits.length} != ${playerCount}`;
  if (msg.cannonPlaceDone.some((id) => id < 0 || id >= playerCount))
    return `cannonPlaceDone slot id out of bounds`;
  if (msg.playerZones.length !== playerCount)
    return `playerZones length ${msg.playerZones.length} != ${playerCount}`;
  if (msg.towerAlive.length !== towerCount)
    return `towerAlive length ${msg.towerAlive.length} != ${towerCount}`;

  for (const entry of msg.players) {
    if (entry.id < 0 || entry.id >= playerCount)
      return `player id ${entry.id} out of bounds`;
    if (entry.walls.some((tile) => tile < 0 || tile >= TILE_COUNT))
      return `player ${entry.id} wall tile out of bounds`;
    for (const c of entry.cannons) {
      if (c.row < 0 || c.row >= GRID_ROWS || c.col < 0 || c.col >= GRID_COLS)
        return `player ${entry.id} cannon at ${c.row},${c.col} out of bounds`;
    }
    if (
      entry.homeTowerIdx != null &&
      (entry.homeTowerIdx < 0 || entry.homeTowerIdx >= towerCount)
    ) {
      return `player ${entry.id} homeTowerIdx ${entry.homeTowerIdx} out of bounds`;
    }
  }

  for (const grunt of msg.grunts) {
    if (
      grunt.row < 0 ||
      grunt.row >= GRID_ROWS ||
      grunt.col < 0 ||
      grunt.col >= GRID_COLS
    )
      return `grunt at ${grunt.row},${grunt.col} out of bounds`;
  }

  for (const towerIdx of msg.towerPendingRevive) {
    if (towerIdx < 0 || towerIdx >= towerCount)
      return `towerPendingRevive index ${towerIdx} out of bounds`;
  }

  return null;
}

function serializeGrunts(state: GameState) {
  return state.grunts.map(gruntWireFields);
}

function deserializeGrunt(grunt: SerializedGrunt): GameState["grunts"][number] {
  return {
    ...grunt,
    blockedRounds: grunt.blockedRounds ?? 0,
    chipped: grunt.chipped ? true : undefined,
  };
}

/** Pick the wire-format fields from a grunt. Accepts both runtime Grunt
 *  (required fields) and SerializedGrunt (optional fields) since runtime
 *  Grunt satisfies the wire format's optional shape. */
function gruntWireFields(grunt: SerializedGrunt): SerializedGrunt {
  return {
    row: grunt.row,
    col: grunt.col,
    targetTowerIdx: grunt.targetTowerIdx,
    attackCountdown: grunt.attackCountdown,
    blockedRounds: grunt.blockedRounds,
    attackingWall: grunt.attackingWall,
    facing: grunt.facing,
    chipped: grunt.chipped,
    kind: grunt.kind,
    slowSkip: grunt.slowSkip,
  };
}

function serializeBurningPits(state: GameState) {
  return state.burningPits.map((pit) => ({
    row: pit.row,
    col: pit.col,
    roundsLeft: pit.roundsLeft,
  }));
}

function serializeBonusSquares(state: GameState) {
  return state.bonusSquares.map((b) => ({
    row: b.row,
    col: b.col,
    zone: b.zone,
  }));
}

/** Restore cannonballs from a full-state message, dropping any with stale cannon references. */
function restoreCannonballs(state: GameState, msg: FullStateMessage): void {
  const validBalls = msg.cannonballs.filter((b) =>
    getCannon(state, b.playerId, b.cannonIdx),
  );
  if (validBalls.length < msg.cannonballs.length) {
    console.warn(
      `[checkpoint] dropped ${msg.cannonballs.length - validBalls.length} cannonballs with stale refs`,
    );
  }
  state.cannonballs = validBalls.map((b) => copyCannonballCore(b));
}

/** Copy the positional/kinematic fields shared by all cannonball
 *  representations — includes the full pinned ballistic trajectory so
 *  full-state checkpoints restore in-flight balls with identical
 *  arc + impact on host and watcher. */
function copyCannonballCore(b: Cannonball): Cannonball {
  return {
    cannonIdx: b.cannonIdx,
    startX: b.startX,
    startY: b.startY,
    x: b.x,
    y: b.y,
    targetX: b.targetX,
    targetY: b.targetY,
    speed: b.speed,
    playerId: b.playerId,
    scoringPlayerId: b.scoringPlayerId,
    launchX: b.launchX,
    launchY: b.launchY,
    launchAltitude: b.launchAltitude,
    impactX: b.impactX,
    impactY: b.impactY,
    impactRow: b.impactRow,
    impactCol: b.impactCol,
    impactAltitude: b.impactAltitude,
    vy0: b.vy0,
    flightTime: b.flightTime,
    elapsed: b.elapsed,
    altitude: b.altitude,
    incendiary: b.incendiary,
    mortar: b.mortar,
  };
}
