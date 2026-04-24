// ---------------------------------------------------------------------------
// Battle event types — game-domain events emitted during battle phase.
// Used by game systems, sound, haptics, and combo scoring.
// Network protocol (protocol.ts) re-exports these via MESSAGE spread.
// ---------------------------------------------------------------------------

import type { ValidPlayerSlot } from "./player-slot.ts";

/** A cannon was fired (own or opponent). Client creates local cannonball.
 *  Carries the host-pinned ballistic trajectory so the watcher spawns an
 *  identical parametric flight and lands on the same tile — no state
 *  reads happen on the watcher side for physics. */
export interface CannonFiredMessage {
  type: "cannonFired";
  playerId: ValidPlayerSlot;
  cannonIdx: number;
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
}

/** A wall tile was destroyed by impact. */
export interface WallDestroyedMessage {
  type: "wallDestroyed";
  row: number;
  col: number;
  playerId: ValidPlayerSlot;
  shooterId?: number;
}

/** A cannon took damage (destroyed when newHp <= 0). */
export interface CannonDamagedMessage {
  type: "cannonDamaged";
  playerId: ValidPlayerSlot;
  cannonIdx: number;
  newHp: number;
  shooterId?: number;
}

/** A grunt was killed by a cannonball. */
export interface GruntKilledMessage {
  type: "gruntKilled";
  row: number;
  col: number;
  shooterId?: number;
}

/** A house was destroyed by a cannonball. */
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
  victimPlayerId: ValidPlayerSlot;
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
  playerId: ValidPlayerSlot;
  tileKey: number;
}

/** A rampart shielded a nearby wall from destruction (wall survives, rampart loses 1 shield HP). */
export interface WallShieldedMessage {
  type: "wallShielded";
  playerId: ValidPlayerSlot;
  cannonIdx: number;
  newShieldHp: number;
}

/** A tower was destroyed by a grunt. `playerId` is the slot that owned
 *  the tower at the time of death — lets POV-filtered consumers (haptics)
 *  react only to the local player's losses, matching wallDestroyed /
 *  cannonDamaged. Undefined when the victim was an unenclosed neutral
 *  secondary tower (no owner to notify). */
export interface TowerKilledMessage {
  type: "towerKilled";
  towerIdx: number;
  playerId?: ValidPlayerSlot;
}

/** Impact events — effects from cannonball/grunt interactions. */
export type ImpactEvent =
  | WallDestroyedMessage
  | WallAbsorbedMessage
  | WallShieldedMessage
  | CannonDamagedMessage
  | HouseDestroyedMessage
  | GruntKilledMessage
  | GruntSpawnedMessage
  | PitCreatedMessage
  | IceThawedMessage;

/** All events emitted during battle — fire, tower kill, and impact.
 *  Discriminated on `type` (BATTLE_MESSAGE.* string literal). */
export type BattleEvent = CannonFiredMessage | TowerKilledMessage | ImpactEvent;

/** Launch payload — every CannonFiredMessage field except `type`.
 *  Accepts `boolean` for the optional flags (the wire message narrows
 *  them to `true` via the builder below). */
type CannonFiredPayload = Omit<
  CannonFiredMessage,
  "type" | "incendiary" | "mortar"
> & {
  incendiary?: boolean;
  mortar?: boolean;
};

export const BATTLE_MESSAGE = {
  CANNON_FIRED: "cannonFired",
  WALL_DESTROYED: "wallDestroyed",
  CANNON_DAMAGED: "cannonDamaged",
  GRUNT_KILLED: "gruntKilled",
  HOUSE_DESTROYED: "houseDestroyed",
  GRUNT_SPAWNED: "gruntSpawned",
  PIT_CREATED: "pitCreated",
  ICE_THAWED: "iceThawed",
  TOWER_KILLED: "towerKilled",
  WALL_ABSORBED: "wallAbsorbed",
  WALL_SHIELDED: "wallShielded",
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
    combo: "src/game/combo-system.ts",
  },
  cannonDamaged: {
    stateApply: "src/game/battle-system.ts",
    haptics: "src/runtime/runtime-haptics.ts",
    networkHandle: "src/online/online-server-events.ts",
    networkRelay: "server/game-room.ts",
    orchestrator: "src/game/battle-system.ts",
    combo: "src/game/combo-system.ts",
  },
  gruntKilled: {
    stateApply: "src/game/battle-system.ts",
    networkHandle: "src/online/online-server-events.ts",
    networkRelay: "server/game-room.ts",
    combo: "src/game/combo-system.ts",
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
} as const satisfies Record<
  BattleEvent["type"],
  Readonly<Record<string, string>>
>;

/** Create a CANNON_FIRED message from a cannonball's launch data.
 *  Carries the pinned ballistic trajectory so the watcher can replay
 *  the flight deterministically — no state lookups on receive. */
export function createCannonFiredMsg(
  ball: CannonFiredPayload,
): CannonFiredMessage {
  return {
    ...ball,
    type: BATTLE_MESSAGE.CANNON_FIRED,
    incendiary: ball.incendiary ? true : undefined,
    mortar: ball.mortar ? true : undefined,
  };
}
