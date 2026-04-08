// ---------------------------------------------------------------------------
// Battle event types — game-domain events emitted during battle phase.
// Used by game systems, sound, haptics, and combo scoring.
// Network protocol (protocol.ts) re-exports these via MESSAGE spread.
// ---------------------------------------------------------------------------

import type { ValidPlayerSlot } from "./player-slot.ts";

/** A cannon was fired (own or opponent). Client creates local cannonball. */
export interface CannonFiredMessage {
  type: "cannonFired";
  playerId: ValidPlayerSlot;
  cannonIdx: number;
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  speed: number;
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

/** A tower was destroyed by a grunt. */
export interface TowerKilledMessage {
  type: "towerKilled";
  towerIdx: number;
}

/** Impact events — effects from cannonball/grunt interactions. */
export type ImpactEvent =
  | WallDestroyedMessage
  | WallAbsorbedMessage
  | CannonDamagedMessage
  | HouseDestroyedMessage
  | GruntKilledMessage
  | GruntSpawnedMessage
  | PitCreatedMessage
  | IceThawedMessage;

/** All events emitted during battle — fire, tower kill, and impact.
 *  Discriminated on `type` (BATTLE_MESSAGE.* string literal). */
export type BattleEvent = CannonFiredMessage | TowerKilledMessage | ImpactEvent;

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
} as const;
