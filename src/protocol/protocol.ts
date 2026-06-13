// ---------------------------------------------------------------------------
// Network protocol — lobby, checkpoints, build/cannon events, host migration.
// Battle event types live in battle-events.ts (game-domain, lower layer).
// ---------------------------------------------------------------------------

import {
  BATTLE_MESSAGE,
  type BallisticTrajectory,
  type CannonDamagedMessage,
  type CannonFiredMessage,
  type GruntChippedMessage,
  type GruntKilledMessage,
  type GruntSpawnedMessage,
  type HouseDestroyedMessage,
  type IceThawedMessage,
  type PitCreatedMessage,
  type TowerKilledMessage,
  type WallAbsorbedMessage,
  type WallDestroyedMessage,
  type WallShieldedMessage,
} from "../shared/core/battle-events.ts";
import { GAME_MODE_MODERN } from "../shared/core/game-constants.ts";
import type { CannonIdx, TowerIdx } from "../shared/core/geometry-types.ts";
// Serialized sub-types and checkpoint data — defined in shared/core/* and
// the sibling checkpoint-data.ts. Imported here for local use in message types.
import type {
  RubbleClearingHeld,
  SerializedModifierTiles,
  SupplyBonusId,
  SupplyShip,
} from "../shared/core/modifier-defs.ts";
import type {
  CannonPhantomPayload,
  CannonPlacedPayload,
  PiecePhantomPayload,
  PiecePlacedPayload,
} from "../shared/core/phantom-types.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { ResolvedChoice } from "../shared/ui/interaction-types.ts";
import type {
  SerializedBonusSquare,
  SerializedBurningPit,
  SerializedGrunt,
  SerializedHouse,
  SerializedPlayer,
} from "./checkpoint-data.ts";

export interface RoomSettings {
  maxRounds: number; // 0 (unlimited), 1 (e2e testing), 3, 5, 8, or 12
  cannonMaxHp: number; // 3, 6, 9, or 12
  waitTimerSec: number; // lobby wait duration before auto-start (seconds)
  seed?: number; // optional map seed (server generates random if omitted)
  gameMode?: string; // "classic" or "modern" (default "modern")
}

export type ClientMessage =
  // Lobby (pre-game)
  | { type: "createRoom"; settings: RoomSettings }
  | { type: "joinRoom"; code: string }
  // Lobby (in room)
  | { type: "selectSlot"; playerId: ValidPlayerId }
  // In-game
  | {
      type: "lifeLostChoice";
      choice: ResolvedChoice;
      playerId?: ValidPlayerId;
      applyAt: number;
      round: number;
    }
  | {
      type: "upgradePick";
      playerId: ValidPlayerId;
      choice: string;
      applyAt: number;
      round: number;
    }
  // A rejoined peer asks the host to hand its seat back from the AI that
  // took it over (see SeatReclaimMessage). Relayed to the host, which
  // validates ownership + liveness and broadcasts the lockstep flip.
  | { type: "requestSeatReclaim"; playerId: ValidPlayerId }
  | { type: "ping" };

/** Sent once when a client connects. All clients derive map/houses/zones from the seed. */
export interface InitMessage {
  type: "init";
  seed: number;
  playerCount: number;
  settings: {
    maxRounds: number;
    cannonMaxHp: number;
    buildTimer: number;
    cannonPlaceTimer: number;
    firstRoundCannons: number;
    gameMode: string;
    /** Host's AI difficulty. Bootstrap personality rolls draw from the
     *  shared `state.rng` with a difficulty-dependent draw COUNT, so every
     *  peer must roll with the host's value — a peer using its own local
     *  setting skews the shared-stream cursor and desyncs the mirror sim. */
    difficulty: number;
  };
}

/** Sent when a player joins and is assigned a slot. */
interface JoinedMessage {
  type: "joined";
  playerId: ValidPlayerId;
  /** Slot the player occupied before this selection, or undefined if this is
   *  their first slot pick. Set to undefined in broadcasts when the player
   *  reselected the same slot (avoids UI thrashing on no-op reselections). */
  previousPlayerId?: ValidPlayerId;
}

interface RoomCreatedMessage {
  type: "roomCreated";
  code: string;
  settings: RoomSettings;
  seed: number;
}

/** Player successfully joined a room. */
interface RoomJoinedMessage {
  type: "roomJoined";
  code: string;
  players: { playerId: ValidPlayerId; name: string }[];
  settings: RoomSettings;
  /** PlayerId of the host, or null if the host hasn't selected a slot yet. */
  hostId: ValidPlayerId | null;
  seed: number;
  /** Seconds elapsed since room creation (for lobby timer sync). */
  elapsedSec: number;
}

interface PlayerJoinedMessage {
  type: "playerJoined";
  playerId: ValidPlayerId;
  name: string;
  /** Slot the player occupied before this selection, or undefined if this is
   *  their first slot pick. Undefined when reselecting the same slot. */
  previousPlayerId?: ValidPlayerId;
}

interface PlayerLeftMessage {
  type: "playerLeft";
  playerId: ValidPlayerId;
}

/** Lobby error (room not found, full, etc.). */
interface RoomErrorMessage {
  type: "roomError";
  message: string;
}

/** Start tower selection (first round or reselection after life loss). */
interface SelectStartMessage {
  type: "selectStart";
  timer: number;
}

/** Start of CANNON_PLACE — payload-less phase marker. Receivers IGNORE it
 *  on the wire (`online-server-lifecycle.ts` acks but runs no engine work);
 *  under clone-everywhere they already ran `enterCannonPhase` from their own
 *  `castle-done` / `advance-to-cannon` tick. The marker is a host liveness /
 *  trace signal, not a state driver. */
interface CannonStartMessage {
  type: "cannonStart";
}

/** Start of BATTLE — payload-less phase marker. Receivers ignore it on the
 *  wire, having already run `prepareBattle` from their own `cannon-place-done`
 *  tick. */
interface BattleStartMessage {
  type: "battleStart";
}

/** Start of WALL_BUILD — payload-less phase marker. Receivers ignore it on
 *  the wire, having already run `finalizeBattle` + `prepareNextRound` from
 *  their own `battle-done` / `ceasefire` tick. */
interface BuildStartMessage {
  type: "buildStart";
}

/** End of build phase — phase-marker signal. Also marks the round-end
 *  barrier under the post-2026-04-29 round-numbering: WALL_BUILD-end is
 *  where the score is finalized and `ROUND_END` fires. The wire-message
 *  name stays `buildEnd` because that's still phase-accurate (the
 *  WALL_BUILD phase has ended) and renaming would churn every serializer /
 *  handler / online-compat check; semantically it's also the round-end
 *  barrier.
 *
 *  Payload-less phase marker; receivers ignore it on the wire, having run
 *  `finalizeRound` (score + life penalties + ROUND_END emit) from their own
 *  `round-end` mutate. That same mutate peeks game-over against the closing
 *  round and — when the game continues — increments `state.round` + emits
 *  ROUND_START, all BEFORE the score-overlay / life-lost dialog display (not
 *  in `resolveAfterLifeLost`). Every peer dispatches the same way. */
interface BuildEndMessage {
  type: "buildEnd";
}

interface GameOverMessage {
  type: "gameOver";
  winner: string;
  scores: { name: string; score: number; eliminated: boolean }[];
}

/** Host disconnected — server tells all clients who the new host is. */
interface HostLeftMessage {
  type: "hostLeft";
  /** PlayerId of the promoted player, or null if no human available (watcher fallback). */
  newHostPlayerId: ValidPlayerId | null;
  /** PlayerId of the departed host, or null if the host never selected a slot. */
  disconnectedPlayerId: ValidPlayerId | null;
}

/** Full game state snapshot sent by new host after promotion for watcher reconciliation. */
export interface FullStateMessage extends SerializedModifierTiles {
  type: "fullState";
  /** Monotonic host-migration sequence used to reject stale snapshots. */
  migrationSeq?: number;
  phase: string;
  round: number;
  timer: number;
  battleCountdown: number;
  maxRounds: number;
  shotsFired: number;
  rngState: number;
  /** Monotonic logical-tick counter (state.simTick). Carried so a peer
   *  joining mid-game or a post-migration host picks up the
   *  authoritative tick count for the lockstep action-queue. */
  simTick: number;
  /** The promoting host's cross-phase grunt step clock (accum.grunt) at
   *  serialize time. Not derivable from GameState: an adopting peer's
   *  local clock ticked past the snapshot by its own wire-delay skew,
   *  and a skewed clock steps grunts at different sim ticks than the
   *  host — board divergence inside the next WALL_BUILD. Optional for
   *  recorded-fixture back-compat; absent means keep the local clock
   *  (the zero-skew assumption older captures were recorded under). */
  gruntAccum?: number;
  players: SerializedPlayer[];
  grunts: SerializedGrunt[];
  /** Match-lifetime grunt-spawn rotation counter
   *  (state.gruntSpawnSeq). Carried so a late-joining peer rotates the
   *  next pick at the same offset as the surviving host. */
  gruntSpawnSeq: number;
  /** Per-zone tiles already used for grunt spawns in the current round
   *  (state.gruntSpawnUsedTiles). Serialized as `[zoneId, tileKey[]]`
   *  pairs; empty when no zone has spawned this round. */
  gruntSpawnUsedTiles?: [number, number[]][];
  houses: SerializedHouse[];
  bonusSquares: SerializedBonusSquare[];
  towerAlive: boolean[];
  burningPits: SerializedBurningPit[];
  cannonLimits: number[];
  /** Per-slot CANNON_PLACE done flags (slot ids of finished controllers).
   *  Drives the phase-exit predicate so a peer joining mid-CANNON_PLACE
   *  sees the same done set as the host. */
  cannonPlaceDone: number[];
  salvageSlots?: number[];
  playerZones: number[];
  gameMode: string;
  activeModifier: string | null;
  /** Tile keys changed by the active modifier. Empty array when no
   *  modifier is active or the modifier touched nothing. */
  activeModifierChangedTiles: number[];
  lastModifierId: string | null;
  pendingUpgradeOffers?: [number, [string, string, string]][] | null;
  /** Precomputed dust-storm jitter angles (radians), drawn from
   *  `state.rng` at `prepareBattleState` when the rolled modifier is
   *  dust-storm. Indexed by `state.shotsFired` at fire time on every
   *  peer. Empty array when dust-storm isn't active this round.
   *  Late-joiners receive this because they restore the post-prepare
   *  `state.rng` state and can't recompute the jitters themselves. */
  precomputedDustStormJitters?: number[];
  masterBuilderLockout?: number;
  masterBuilderOwners?: number[] | null;
  /** Per-player combo counters from `state.modern.comboTracker.players`.
   *  Late-joiners mid-battle need these to compute the demolition bonus
   *  correctly at battle-end — the tracker is created on every peer at
   *  battle start and populated via mirror-simulated impact events, but
   *  a peer joining mid-battle misses the early impacts and would
   *  otherwise see `wallsDestroyedThisRound: 0`. Cosmetic `events`
   *  (floating-text queue) intentionally omitted — late joiners don't
   *  need to render streak floats they missed. */
  comboTracker?:
    | {
        lastWallHitTime: number;
        wallStreak: number;
        lastGruntKillTime: number;
        gruntStreak: number;
        wallsDestroyedThisRound: number;
      }[]
    | null;
  // Modifier tile sets (frozenTiles, sinkholeTiles, exposedRiverbedTiles)
  // come from `extends SerializedModifierTiles` above. high_tide is
  // computed (see `computeFloodedTiles`), not serialized.
  /** Pre-removal entity snapshot from `rubble_clearing` modifier — drives
   *  the post-reveal fade animation. Cleared at BATTLE_END so most
   *  checkpoints carry null; only present on a host migration during the
   *  brief reveal window. */
  rubbleClearingHeld?: RubbleClearingHeld | null;
  /** Active supply ships during battle. Positions are mirror-simulated
   *  from RNG + tick, so every peer reaches the same state without this
   *  field — but late joiners need the snapshot to render in-flight
   *  ships and to credit subsequent sinks correctly. Cleared at
   *  BATTLE_END. */
  supplyShips?: SupplyShip[] | null;
  /** Per-player queue of one-round supply-ship bonuses pending
   *  consumption. Serialized as `[playerId, bonusIds[]][]` (Map →
   *  entries array). Same checkpoint rationale as `supplyShips` — the
   *  field is mirror-simulated cross-peer but joiners need the
   *  snapshot. */
  pendingSupplyBonuses?: [number, SupplyBonusId[]][] | null;
  /** Seconds added to the current round's WALL_BUILD timer from drained
   *  supply-ship `extra_build_time` bonuses. Needed by a snapshot
   *  captured mid-build: the receiver recomputes the build timer's max
   *  (`wallBuildTimerMax`) every tick, and without this term it would
   *  clip the restored timer back to the no-bonus length. */
  extraBuildTimeSeconds?: number;
  towerPendingRevive: number[];
  capturedCannons: {
    victimId: ValidPlayerId;
    capturerId: ValidPlayerId;
    cannonIdx: CannonIdx;
  }[];
  cannonballs: (BallisticTrajectory & {
    /** Current parametric cursor — needed so a checkpoint restores
     *  in-flight balls at the right position/altitude on the watcher. */
    x: number;
    y: number;
    elapsed: number;
    altitude: number;
  })[];
  /** In-flight balloon animations (present only during BALLOON_ANIM mode). */
  balloonFlights?: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    progress: number;
  }[];
}

/** An opponent (AI) placed a wall piece. The inherited `applyAt` lockstep
 *  tick fires the action schedule at the matching tick on every peer, so
 *  the order-sensitive `recheckTerritory → removeEnclosedGruntsAndRespawn`
 *  cascade consumes RNG identically across peers. */
interface OpponentPiecePlacedMessage extends PiecePlacedPayload {
  type: "opponentPiecePlaced";
}

/** An opponent's phantom piece position (for rendering ghost). */
interface OpponentPhantomMessage extends PiecePhantomPayload {
  type: "opponentPhantom";
}

/** An opponent (AI) placed a cannon. The inherited `applyAt` lockstep tick
 *  aligns cannon-slot occupancy and the consequent `cannonPlaceDone`
 *  checkpointing across peers. */
interface OpponentCannonPlacedMessage extends CannonPlacedPayload {
  type: "opponentCannonPlaced";
}

/** An opponent's phantom cannon position (for rendering ghost). */
interface OpponentCannonPhantomMessage extends CannonPhantomPayload {
  type: "opponentCannonPhantom";
}

/** An opponent confirmed their tower selection. */
interface OpponentTowerSelectedMessage {
  type: "opponentTowerSelected";
  playerId: ValidPlayerId;
  towerIdx: TowerIdx;
  confirmed?: boolean;
  /** Lockstep apply tick: `senderSimTick + SAFETY`. Only set when
   *  `confirmed=true` — highlight-only messages are cosmetic and apply
   *  immediately on receipt. Both originator and receiver enqueue the
   *  `confirmTowerSelection + startPlayerCastleBuild` work for this stamp,
   *  so castle wall generation (which consumes `state.rng` via
   *  `prepareCastleWallsForPlayer`) and `selectionStates.confirmed`
   *  transitions fire at the same logical sim tick on every peer. */
  applyAt?: number;
}

/** A remote-driven slot has finished placing cannons (final placement may be
 *  zero or more `OPPONENT_CANNON_PLACED` messages earlier this phase). The
 *  watcher uses this to know when slot-N has stopped placing so the phase
 *  exit predicate doesn't trigger before the host's final wire messages
 *  arrive. Broadcast only for `kind: "human"` controllers — AI controllers
 *  produce identical placements deterministically on every peer.
 *
 *  Lockstep `applyAt`: both originator and receiver schedule the
 *  `state.cannonPlaceDone.add(playerId)` for the same logical sim tick,
 *  so the phase-exit predicate (`allCannonPlaceDone`) fires at the same
 *  simTick on every peer. Without `applyAt` the originator marks the
 *  slot done at simTick=N while the receiver marks it at simTick=N+
 *  wireDelay, opening a window where one peer exits CANNON_PLACE while
 *  the other is still in it — drifting subsequent RNG draws (modifier
 *  roll, AI upgrade-pick, grunt spawn) by exactly that gap. */
interface OpponentCannonPhaseDoneMessage {
  type: "opponentCannonPhaseDone";
  playerId: ValidPlayerId;
  applyAt: number;
}

/** Life-lost choice forwarded from a non-host client to the host.
 *
 *  Lockstep `applyAt`: originator stamps `applyAt = senderSimTick + SAFETY`
 *  and schedules its own `entry.choice = validated` for that tick; receiver
 *  schedules the same apply at the same tick. `Mode.LIFE_LOST` is a
 *  gameplay mode (simTick advances + action schedule drains during the
 *  dialog), so the scheduled apply fires on every peer at the same logical
 *  tick — `dialogResolved` + `eliminatePlayers` (which mutates
 *  `state.players[pid].lives`) land in lockstep. */
interface LifeLostChoiceForwardedMessage {
  type: "lifeLostChoice";
  playerId: ValidPlayerId;
  choice: ResolvedChoice;
  applyAt: number;
  /** Sender's `state.round` at decision time. Receivers stamp it onto
   *  early-queued choices so the show-time drain can reject a choice
   *  whose own dialog already closed (it must not leak into a future
   *  round's dialog). */
  round: number;
}

/** Upgrade pick choice, relayed to every peer.
 *
 *  Lockstep `applyAt`: originator stamps `applyAt = senderSimTick + SAFETY`
 *  and schedules its own apply for that tick; receivers schedule an
 *  identical apply at `msg.applyAt`, so `entry.choice` flips at the same
 *  logical tick on every peer (same shape as `lifeLostChoice` above —
 *  `Mode.UPGRADE_PICK` is likewise a gameplay mode, so simTick advances
 *  and the action schedule drains during the dialog). */
interface UpgradePickForwardedMessage {
  type: "upgradePick";
  playerId: ValidPlayerId;
  choice: string;
  applyAt: number;
  /** Sender's `state.round` at decision time — same stale-round guard
   *  as `lifeLostChoice` above. */
  round: number;
}

/** Crosshair position update (for spectator rendering, not validated). */
interface AimUpdateMessage {
  type: "aimUpdate";
  playerId: ValidPlayerId;
  x: number;
  y: number;
}

/** Host-only: hand a departed non-host player's seat to local AI at a
 *  lockstep tick. PLAYER_LEFT receipt is wall-clock — each peer flipping
 *  `remotePlayerSlots` at its own arrival instant races the
 *  tick-synchronized boundary instants that read the set (phase-entry
 *  controller init, dialog `shouldAutoResolve` freeze, selection entry):
 *  an arrival spread crossing one initializes the seat on one peer only,
 *  a permanent desync. Instead PLAYER_LEFT only parks the seat in
 *  `pendingSeatTakeovers`; the host stamps `applyAt = simTick + SAFETY`
 *  and every peer (host included) flips the seat sets AND phase-inits
 *  its takeover brain inside the scheduled apply at that tick. The
 *  departing-host case rides the same path: the promoted host re-issues
 *  stamps for still-unstamped pending seats right after its FULL_STATE
 *  broadcast (see promote.ts). */
interface SeatTakeoverMessage {
  type: "seatTakeover";
  /** The departed player's seat — the slot being handed to local AI. */
  playerId: ValidPlayerId;
  /** Lockstep apply tick: host `simTick + SAFETY`. */
  applyAt: number;
}

/** Host-only: hand a seat BACK from the AI that took it over to a
 *  rejoined human, at a lockstep tick. The exact inverse of
 *  SeatTakeoverMessage — every peer flips the seat sets at `applyAt`,
 *  stopping its mirror-simulated AI for that slot; the OWNER (the
 *  rejoiner, `playerId === myPlayerId`) additionally swaps the dormant AI
 *  controller for its human controller. The stamp is what keeps the
 *  state.rng draw counts equal: the AI being reclaimed draws from the
 *  shared stream every decision on every peer, so all peers must stop
 *  simulating it on the same tick. Host issues this only after the
 *  rejoiner has bootstrapped from the replayed INIT and adopted the
 *  room-wide resync FULL_STATE (so it is already in lockstep, mirror-
 *  simulating its own seat as AI like everyone else). */
interface SeatReclaimMessage {
  type: "seatReclaim";
  /** The seat being handed back to its returning human owner. */
  playerId: ValidPlayerId;
  /** Lockstep apply tick: host `simTick + SAFETY`. */
  applyAt: number;
}

export type ServerMessage =
  // Connection
  | InitMessage
  | JoinedMessage
  // Lobby
  | RoomCreatedMessage
  | RoomJoinedMessage
  | PlayerJoinedMessage
  | PlayerLeftMessage
  | RoomErrorMessage
  // Checkpoints
  | SelectStartMessage
  | BuildStartMessage
  | CannonStartMessage
  | BattleStartMessage
  | BuildEndMessage
  | GameOverMessage
  // Build/Cannon events
  | OpponentPiecePlacedMessage
  | OpponentPhantomMessage
  | OpponentCannonPlacedMessage
  | OpponentCannonPhantomMessage
  | OpponentTowerSelectedMessage
  | OpponentCannonPhaseDoneMessage
  // Battle events
  | CannonFiredMessage
  | WallDestroyedMessage
  | CannonDamagedMessage
  | GruntKilledMessage
  | GruntChippedMessage
  | HouseDestroyedMessage
  | GruntSpawnedMessage
  | PitCreatedMessage
  | IceThawedMessage
  | WallAbsorbedMessage
  | WallShieldedMessage
  | TowerKilledMessage
  | AimUpdateMessage
  // Forwarded client messages
  | LifeLostChoiceForwardedMessage
  | UpgradePickForwardedMessage
  // Host migration / membership
  | SeatTakeoverMessage
  | SeatReclaimMessage
  | HostLeftMessage
  | FullStateMessage;

/** Any message sent over the wire (client or server). */
export type GameMessage = ClientMessage | ServerMessage;

/** Union of every protocol message `type` string. Used by server validation
 *  tables (HOST_ONLY, RATE_LIMITED_TYPES, PHASE_GATES in server/game-room.ts)
 *  so a typo or rename of a MESSAGE constant becomes a compile error there. */
export type MessageType = (typeof MESSAGE)[keyof typeof MESSAGE];

const VALID_MAX_ROUNDS = [0, 1, 3, 5, 8, 12];
const VALID_CANNON_HP = [3, 6, 9, 12];
const MAX_WAIT_TIMER_SEC = 120;
const DEFAULT_WAIT_TIMER_SEC = 60;
const VALID_GAME_MODES = ["classic", "modern"];
export const MESSAGE = {
  ...BATTLE_MESSAGE,
  // Client → Server
  CREATE_ROOM: "createRoom",
  JOIN_ROOM: "joinRoom",
  SELECT_SLOT: "selectSlot",
  LIFE_LOST_CHOICE: "lifeLostChoice",
  UPGRADE_PICK: "upgradePick",
  REQUEST_SEAT_RECLAIM: "requestSeatReclaim",
  PING: "ping",
  // Lobby
  ROOM_CREATED: "roomCreated",
  ROOM_JOINED: "roomJoined",
  ROOM_ERROR: "roomError",
  JOINED: "joined",
  PLAYER_JOINED: "playerJoined",
  PLAYER_LEFT: "playerLeft",
  // Checkpoints
  INIT: "init",
  SELECT_START: "selectStart",
  BUILD_START: "buildStart",
  CANNON_START: "cannonStart",
  BATTLE_START: "battleStart",
  BUILD_END: "buildEnd",
  GAME_OVER: "gameOver",
  FULL_STATE: "fullState",
  // Build/Cannon events
  OPPONENT_PIECE_PLACED: "opponentPiecePlaced",
  OPPONENT_PHANTOM: "opponentPhantom",
  OPPONENT_CANNON_PLACED: "opponentCannonPlaced",
  OPPONENT_CANNON_PHANTOM: "opponentCannonPhantom",
  OPPONENT_TOWER_SELECTED: "opponentTowerSelected",
  OPPONENT_CANNON_PHASE_DONE: "opponentCannonPhaseDone",
  AIM_UPDATE: "aimUpdate",
  // Host migration / membership
  SEAT_TAKEOVER: "seatTakeover",
  SEAT_RECLAIM: "seatReclaim",
  HOST_LEFT: "hostLeft",
} as const;
export const DEFAULT_CANNON_HP = 3;

/** Clamp untrusted client settings to valid ranges. */
export function sanitizeRoomSettings(raw: Partial<RoomSettings>): RoomSettings {
  const maxRounds = Number(raw.maxRounds);
  const cannonMaxHp = Number(raw.cannonMaxHp);
  const wait = Number(raw.waitTimerSec);
  const seed = raw.seed != null ? Math.floor(Number(raw.seed)) : undefined;
  const gameMode = String(raw.gameMode ?? GAME_MODE_MODERN);
  return {
    maxRounds: VALID_MAX_ROUNDS.includes(maxRounds) ? maxRounds : 0,
    cannonMaxHp: VALID_CANNON_HP.includes(cannonMaxHp)
      ? cannonMaxHp
      : DEFAULT_CANNON_HP,
    waitTimerSec:
      Number.isFinite(wait) && wait >= 0
        ? Math.min(wait, MAX_WAIT_TIMER_SEC)
        : DEFAULT_WAIT_TIMER_SEC,
    seed: Number.isFinite(seed) ? seed : undefined,
    gameMode: VALID_GAME_MODES.includes(gameMode) ? gameMode : GAME_MODE_MODERN,
  };
}
