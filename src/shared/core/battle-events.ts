// ---------------------------------------------------------------------------
// Battle event types — game-domain events emitted during battle phase.
// Used by game systems, sound, haptics, and combo scoring.
// Network protocol (protocol.ts) re-exports these via MESSAGE spread.
// ---------------------------------------------------------------------------

import type { CannonIdx, TowerIdx } from "./geometry-types.ts";
import type { TileKey } from "./grid.ts";
import type { ValidPlayerId } from "./player-slot.ts";

/** Originator-pinned trajectory parameters for a cannonball. Computed at
 *  fire time and frozen — every peer that re-runs the parametric flight
 *  must see the same values. Both the runtime `Cannonball` (with its
 *  per-tick mutable cursor: x/y/elapsed/altitude) and the wire-format
 *  `CannonFiredMessage` (with type tag + applyAt) extend this so the 20
 *  shared trajectory fields live in one place. */
export interface BallisticTrajectory {
  cannonIdx: CannonIdx;
  playerId: ValidPlayerId;
  /** Set when fired through a captured-cannon path: the capturer who scores
   *  for this ball's effects. `playerId` stays the original cannon owner so
   *  receiver-side `canFireOwnCannon` lookups resolve against the right slot. */
  scoringPlayerId?: ValidPlayerId;
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  speed: number;
  launchX: number;
  launchY: number;
  launchAltitude: number;
  impactX: number;
  impactY: number;
  impactRow: number;
  impactCol: number;
  impactAltitude: number;
  vy0: number;
  flightTime: number;
  incendiary?: true;
  mortar?: true;
  /** True only when this shot's mortar mode came from the supply_ship
   *  `mortar_shot` bonus (the cannon itself is non-mortar at fire time).
   *  Drives the cross-peer bonus consume in applyCannonFired without
   *  depending on the cannon being alive at apply time — see the bug
   *  this replaces, where a natively-mortar cannon destroyed mid-flight
   *  caused `!cannon?.mortar` to spuriously consume a queued bonus. */
  mortarBonus?: true;
}

/** A cannon was fired (own or opponent). Client creates local cannonball.
 *  Carries the originator-pinned ballistic trajectory so receivers spawn an
 *  identical parametric flight and land on the same tile — no state reads
 *  happen on the receiver side for physics. */
export interface CannonFiredMessage extends BallisticTrajectory {
  type: "cannonFired";
  /** Lockstep apply tick: `senderSimTick + SAFETY`. Both originator and
   *  receiver enqueue the ball-push for this stamp; the action schedule
   *  fires it at the matching tick on every peer, so cross-peer scoring,
   *  conscription, and impact ordering line up. Optional during the step-3
   *  rollout — local-only emits (bus replay, host fanout from
   *  battle-system.ts) leave it undefined; the wire path always sets it. */
  applyAt?: number;
}

/** A wall tile was destroyed by impact. */
export interface WallDestroyedMessage {
  type: "wallDestroyed";
  row: number;
  col: number;
  playerId: ValidPlayerId;
  shooterId?: ValidPlayerId;
}

/** A cannon took damage (destroyed when newHp <= 0). */
export interface CannonDamagedMessage {
  type: "cannonDamaged";
  playerId: ValidPlayerId;
  cannonIdx: CannonIdx;
  newHp: number;
  shooterId?: ValidPlayerId;
}

export interface GruntKilledMessage {
  type: "gruntKilled";
  row: number;
  col: number;
  shooterId?: ValidPlayerId;
}

/** A frosted grunt absorbed its first hit (ice chip — grunt survives with
 *  `grunt.chipped = true`; the next hit on the same tile kills). */
export interface GruntChippedMessage {
  type: "gruntChipped";
  row: number;
  col: number;
  shooterId?: ValidPlayerId;
}

export interface HouseDestroyedMessage {
  type: "houseDestroyed";
  row: number;
  col: number;
}

/** A grunt was spawned (from house destruction or inter-battle).
 *  victimPlayerId = the zone owner where the grunt spawned. */
export interface GruntSpawnedMessage {
  type: "gruntSpawned";
  row: number;
  col: number;
  victimPlayerId: ValidPlayerId;
}

/** A burning pit was created by an incendiary cannonball. */
export interface PitCreatedMessage {
  type: "pitCreated";
  row: number;
  col: number;
  roundsLeft: number;
}

/** A frozen water tile was thawed by a cannonball impact. */
export interface IceThawedMessage {
  type: "iceThawed";
  row: number;
  col: number;
}

/** A reinforced wall absorbed a hit (first hit only — wall survives, marked as damaged). */
export interface WallAbsorbedMessage {
  type: "wallAbsorbed";
  playerId: ValidPlayerId;
  tileKey: TileKey;
}

/** A rampart shielded a nearby wall from destruction (wall survives, rampart loses 1 shield HP). */
export interface WallShieldedMessage {
  type: "wallShielded";
  playerId: ValidPlayerId;
  cannonIdx: CannonIdx;
  newShieldHp: number;
}

/** A tower was destroyed by a grunt. `playerId` is the slot that owned
 *  the tower at the time of death — lets POV-filtered consumers (haptics)
 *  react only to the local player's losses, matching wallDestroyed /
 *  cannonDamaged. Undefined when the victim was an unenclosed neutral
 *  secondary tower (no owner to notify). */
export interface TowerKilledMessage {
  type: "towerKilled";
  towerIdx: TowerIdx;
  playerId?: ValidPlayerId;
}

/** A supply ship was hit by a cannonball. `shipId` is stable across
 *  ticks; `shooterId` is the scoring player (cannonball.scoringPlayerId
 *  for captured-cannon fires, else cannonball.playerId). */
export interface ShipHitMessage {
  type: "shipHit";
  shipId: number;
  shooterId: ValidPlayerId;
  /** Remaining HP after this hit. 0 means the hit also triggered sink
   *  — a `shipSunk` event follows for the same shipId. */
  newHp: number;
}

/** A supply ship's HP reached zero and the sink animation started.
 *  Awarded `bonus` queues for the last-hitter (`shooterId`) via
 *  `pendingSupplyBonuses`; consumption happens at the relevant
 *  phase-entry hook. */
export interface ShipSunkMessage {
  type: "shipSunk";
  shipId: number;
  shooterId: ValidPlayerId;
}

/** Impact events — effects from cannonball/grunt interactions. */
export type ImpactEvent =
  | WallDestroyedMessage
  | WallAbsorbedMessage
  | WallShieldedMessage
  | CannonDamagedMessage
  | HouseDestroyedMessage
  | GruntKilledMessage
  | GruntChippedMessage
  | GruntSpawnedMessage
  | PitCreatedMessage
  | IceThawedMessage;

/** All events emitted during battle — fire, tower kill, and impact.
 *  Discriminated on `type` (BATTLE_MESSAGE.* string literal). */
export type BattleEvent =
  | CannonFiredMessage
  | TowerKilledMessage
  | ShipHitMessage
  | ShipSunkMessage
  | ImpactEvent;

/** Launch payload — every CannonFiredMessage field except the `type` tag. */
type CannonFiredPayload = Omit<CannonFiredMessage, "type">;

export const BATTLE_MESSAGE = {
  CANNON_FIRED: "cannonFired",
  WALL_DESTROYED: "wallDestroyed",
  CANNON_DAMAGED: "cannonDamaged",
  GRUNT_KILLED: "gruntKilled",
  GRUNT_CHIPPED: "gruntChipped",
  HOUSE_DESTROYED: "houseDestroyed",
  GRUNT_SPAWNED: "gruntSpawned",
  PIT_CREATED: "pitCreated",
  ICE_THAWED: "iceThawed",
  TOWER_KILLED: "towerKilled",
  WALL_ABSORBED: "wallAbsorbed",
  WALL_SHIELDED: "wallShielded",
  SHIP_HIT: "shipHit",
  SHIP_SUNK: "shipSunk",
} as const;
/** Consumer files for each battle event, keyed by the role the file plays.
 *
 * The `satisfies Record<BattleEvent["type"], ...>` clause forces exhaustiveness:
 * adding a new member to the BattleEvent union without a matching consumer
 * map is a compile error. Role names are free-form strings (used as
 * documentation); lint-registries only verifies file existence.
 *
 * See FEATURE_CONSUMERS in feature-defs.ts for the pattern rationale. */
export const BATTLE_EVENT_CONSUMERS = {
  cannonFired: {
    stateApply: "src/game/battle-system.ts",
    networkHandle: "src/online/online-server-events.ts",
    networkRelay: "server/game-room.ts",
  },
  wallDestroyed: {
    stateApply: "src/game/battle-system.ts",
    haptics: "src/runtime/runtime-haptics.ts",
    networkHandle: "src/online/online-server-events.ts",
    networkRelay: "server/game-room.ts",
    orchestrator: "src/game/battle-system.ts",
    combo: "src/game/combos.ts",
  },
  cannonDamaged: {
    stateApply: "src/game/battle-system.ts",
    haptics: "src/runtime/runtime-haptics.ts",
    networkHandle: "src/online/online-server-events.ts",
    networkRelay: "server/game-room.ts",
    orchestrator: "src/game/battle-system.ts",
    combo: "src/game/combos.ts",
  },
  gruntKilled: {
    stateApply: "src/game/battle-system.ts",
    networkHandle: "src/online/online-server-events.ts",
    networkRelay: "server/game-room.ts",
    combo: "src/game/combos.ts",
  },
  gruntChipped: {
    stateApply: "src/game/battle-system.ts",
    networkHandle: "src/online/online-server-events.ts",
    networkRelay: "server/game-room.ts",
  },
  houseDestroyed: {
    stateApply: "src/game/battle-system.ts",
    networkHandle: "src/online/online-server-events.ts",
    networkRelay: "server/game-room.ts",
  },
  gruntSpawned: {
    stateApply: "src/game/battle-system.ts",
    networkHandle: "src/online/online-server-events.ts",
    networkRelay: "server/game-room.ts",
  },
  pitCreated: {
    stateApply: "src/game/battle-system.ts",
    networkHandle: "src/online/online-server-events.ts",
    networkRelay: "server/game-room.ts",
  },
  iceThawed: {
    stateApply: "src/game/battle-system.ts",
    networkHandle: "src/online/online-server-events.ts",
    networkRelay: "server/game-room.ts",
  },
  wallAbsorbed: {
    stateApply: "src/game/battle-system.ts",
    networkHandle: "src/online/online-server-events.ts",
    networkRelay: "server/game-room.ts",
  },
  wallShielded: {
    stateApply: "src/game/battle-system.ts",
    networkHandle: "src/online/online-server-events.ts",
    networkRelay: "server/game-room.ts",
  },
  towerKilled: {
    stateApply: "src/game/battle-system.ts",
    haptics: "src/runtime/runtime-haptics.ts",
    networkHandle: "src/online/online-server-events.ts",
    networkRelay: "server/game-room.ts",
  },
  // Supply-ship events are mirror-simulated on every peer (positions +
  // hp + bonus credit derive deterministically from RNG + tick +
  // CANNON_FIRED stream), so no networkHandle/networkRelay entries —
  // they're emitted locally on each peer via the bus from
  // tryHitSupplyShip and observed by sound/haptics consumers only.
  shipHit: {
    emit: "src/game/modifiers/supply-ship.ts",
    sfx: "src/runtime/sfx-player.ts",
  },
  shipSunk: {
    emit: "src/game/modifiers/supply-ship.ts",
    sfx: "src/runtime/sfx-player.ts",
  },
} as const satisfies Record<
  BattleEvent["type"],
  Readonly<Record<string, string>>
>;

/** Create a CANNON_FIRED message from a cannonball's launch data.
 *  Carries the pinned ballistic trajectory so the watcher can replay
 *  the flight deterministically — no state lookups on receive.
 *
 *  Builds the message field-by-field (rather than spreading `ball`) so
 *  ball-only runtime fields like `whistleVariant` (per-side cosmetic
 *  SFX pick — see `selectWhistleVariant`) don't leak into the wire /
 *  bus payload, which would make the determinism event log sensitive
 *  to a non-deterministic value. */
export function createCannonFiredMsg(
  ball: CannonFiredPayload,
): CannonFiredMessage {
  return {
    type: BATTLE_MESSAGE.CANNON_FIRED,
    playerId: ball.playerId,
    cannonIdx: ball.cannonIdx,
    scoringPlayerId: ball.scoringPlayerId,
    startX: ball.startX,
    startY: ball.startY,
    targetX: ball.targetX,
    targetY: ball.targetY,
    speed: ball.speed,
    launchX: ball.launchX,
    launchY: ball.launchY,
    launchAltitude: ball.launchAltitude,
    impactX: ball.impactX,
    impactY: ball.impactY,
    impactRow: ball.impactRow,
    impactCol: ball.impactCol,
    impactAltitude: ball.impactAltitude,
    vy0: ball.vy0,
    flightTime: ball.flightTime,
    incendiary: ball.incendiary,
    mortar: ball.mortar,
    mortarBonus: ball.mortarBonus,
  };
}
