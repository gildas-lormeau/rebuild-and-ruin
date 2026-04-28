import {
  applyCheckpointModifierTiles,
  createCastle,
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
import { FID } from "../shared/core/feature-defs.ts";
import {
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
} from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import { GRID_COLS, GRID_ROWS, TILE_COUNT } from "../shared/core/grid.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import {
  type GameState,
  hasFeature,
  setGameMode,
  type UpgradeOfferTuple,
} from "../shared/core/types.ts";
import type { UpgradeId } from "../shared/core/upgrade-defs.ts";
import { Rng } from "../shared/platform/rng.ts";
import { toCannonMode } from "./online-types.ts";

interface FullStateResult {
  balloonFlights?: { flight: BalloonFlight; progress: number }[];
}

/** Returned when validation fails — no state was mutated. */
type FullStateApplyResult = FullStateResult | null;

/** Create a BUILD_START phase-marker message. The watcher runs
 *  `enterBuildFromBattle` locally on receipt — see `BuildStartData` in
 *  checkpoint-data.ts for the contract. */
export function createBuildStartMessage() {
  return { type: MESSAGE.BUILD_START };
}

/** Create a CANNON_START phase-marker message. The watcher runs the
 *  source-phase prefix (`finalizeRoundVisuals` / `finalizeReselectedPlayers` /
 *  `finalizeCastleConstruction`, depending on which phase it's leaving) plus
 *  `enterCannonPhase` locally on receipt — see `CANNON_ENTRY_WATCHER_STEP`
 *  in `runtime-phase-machine.ts`. No payload: every cannon-entry mutation
 *  (cannon limits, default facings, timer, bonus squares, salvage slots,
 *  modifier tiles) is derived locally on both sides from synced state.
 *  RNG sync at the previous BATTLE_START is the defense-in-depth guarantee. */
export function createCannonStartMessage() {
  return { type: MESSAGE.CANNON_START };
}

/** Create a BATTLE_START phase-marker message. The watcher runs
 *  `enterBattlePhase` locally on receipt — every battle-start mutation
 *  (modifier tiles, captured cannons, grunt wall-attack flags, balloon
 *  flights, combo tracker) is derived locally on both sides from synced
 *  state + RNG. No payload: clone-everywhere model means RNG advances in
 *  lockstep across peers, no resync required. */
export function createBattleStartMessage() {
  return { type: MESSAGE.BATTLE_START };
}

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
    cannonballs: state.cannonballs.map((b) => ({
      ...copyCannonballCore(b),
      incendiary: b.incendiary ? true : undefined,
    })),
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
  state.cannonLimits = msg.cannonLimits;
  state.cannonPlaceDone = new Set(msg.cannonPlaceDone as ValidPlayerSlot[]);
  state.salvageSlots = msg.salvageSlots ?? state.players.map(() => 0);
  state.playerZones = msg.playerZones;
  state.towerPendingRevive = new Set(msg.towerPendingRevive);
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
  }
  applyCheckpointModifierTiles(state, msg);
  if (hasFeature(state, FID.UPGRADES)) {
    state.modern!.pendingUpgradeOffers = msg.pendingUpgradeOffers
      ? new Map(
          msg.pendingUpgradeOffers.map(([pid, offers]) => [
            pid as ValidPlayerSlot,
            offers as UpgradeOfferTuple,
          ]),
        )
      : null;
    state.modern!.masterBuilderLockout = msg.masterBuilderLockout ?? 0;
    state.modern!.masterBuilderOwners = msg.masterBuilderOwners
      ? new Set(msg.masterBuilderOwners as ValidPlayerSlot[])
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

  // Restore RNG internal state
  const rng = new Rng(0);
  rng.setState(msg.rngState);
  state.rng = rng;

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
  winner: { id: number },
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

    player.walls = new Set(entry.walls);
    player.cannons = entry.cannons.map((c) => ({
      row: c.row,
      col: c.col,
      hp: c.hp,
      mode: toCannonMode(c.mode),
      facing: c.facing ?? player.defaultFacing,
      mortar: c.mortar || undefined,
      shielded: c.shielded || undefined,
      shieldHp: c.shieldHp || undefined,
      balloonHits: c.balloonHits || undefined,
      balloonCapturerIds: c.balloonCapturerIds?.length
        ? [...c.balloonCapturerIds]
        : undefined,
    }));
    // homeTowerIdx and castleWallTiles are immutable after castle selection.
    // Checkpoint messages omit them; only full-state (join/reconnect) sends them.
    const homeTowerIdx = entry.homeTowerIdx;
    if (homeTowerIdx !== undefined) {
      player.homeTower =
        homeTowerIdx !== null &&
        homeTowerIdx >= 0 &&
        homeTowerIdx < state.map.towers.length
          ? state.map.towers[homeTowerIdx]!
          : null;
      // Castle geometry depends on the original map tiles at selection time.
      // Rebuild only on full-state restore (join/reconnect), never on checkpoints.
      player.castle = player.homeTower
        ? createCastle(player.homeTower, state.map.tiles, state.map.towers)
        : null;
    }
    if (entry.castleWallTiles !== undefined) {
      player.castleWallTiles = new Set(entry.castleWallTiles);
    }
    player.lives = entry.lives;
    player.eliminated = entry.eliminated;
    player.score = entry.score;
    player.upgrades = new Map((entry.upgrades ?? []) as [UpgradeId, number][]);
    player.damagedWalls = new Set(entry.damagedWalls ?? []);
    player.freshCastle = entry.freshCastle ?? false;
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
    victimId: number;
    capturerId: number;
    cannonIdx: number;
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
      victimId: captured.victimId as ValidPlayerSlot,
      capturerId: captured.capturerId as ValidPlayerSlot,
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
    freshCastle: player.freshCastle || undefined,
  };
}

function serializeCannon(cannon: Cannon) {
  return {
    row: cannon.row,
    col: cannon.col,
    hp: cannon.hp,
    mode: cannon.mode,
    facing: cannon.facing ?? 0,
    mortar: cannon.mortar || undefined,
    shielded: cannon.shielded || undefined,
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
    masterBuilderLockout: state.modern?.masterBuilderLockout ?? 0,
    masterBuilderOwners: state.modern?.masterBuilderOwners
      ? [...state.modern.masterBuilderOwners]
      : null,
    ...serializeModifierTileSets(state),
  };
}

function serializeModifierTileSets(state: GameState) {
  return {
    frozenTiles: state.modern?.frozenTiles
      ? [...state.modern.frozenTiles]
      : null,
    highTideTiles: state.modern?.highTideTiles
      ? [...state.modern.highTideTiles]
      : null,
    sinkholeTiles: state.modern?.sinkholeTiles
      ? [...state.modern.sinkholeTiles]
      : null,
    lowWaterTiles: state.modern?.lowWaterTiles
      ? [...state.modern.lowWaterTiles]
      : null,
    chippedGrunts: state.modern?.chippedGrunts
      ? [...state.modern.chippedGrunts]
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
    ...gruntWireFields(grunt),
    blockedRounds: grunt.blockedRounds ?? 0,
  };
}

/** Pick the wire-format fields from a grunt. Accepts both runtime Grunt
 *  (required fields) and SerializedGrunt (optional fields) since runtime
 *  Grunt satisfies the wire format's optional shape. */
function gruntWireFields(grunt: SerializedGrunt): SerializedGrunt {
  return {
    row: grunt.row,
    col: grunt.col,
    victimPlayerId: grunt.victimPlayerId,
    targetTowerIdx: grunt.targetTowerIdx,
    attackCountdown: grunt.attackCountdown,
    blockedRounds: grunt.blockedRounds,
    attackingWall: grunt.attackingWall,
    facing: grunt.facing,
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
  const validBalls = msg.cannonballs.filter(
    (b) => state.players[b.playerId]?.cannons[b.cannonIdx],
  );
  if (validBalls.length < msg.cannonballs.length) {
    console.warn(
      `[checkpoint] dropped ${msg.cannonballs.length - validBalls.length} cannonballs with stale refs`,
    );
  }
  state.cannonballs = validBalls.map((b) => ({
    ...copyCannonballCore(b),
    incendiary: b.incendiary ?? false,
  }));
}

/** Copy the positional/kinematic fields shared by all cannonball
 *  representations — includes the full pinned ballistic trajectory so
 *  full-state checkpoints restore in-flight balls with identical
 *  arc + impact on host and watcher. */
function copyCannonballCore(b: Cannonball): Omit<Cannonball, "incendiary"> {
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
  };
}
