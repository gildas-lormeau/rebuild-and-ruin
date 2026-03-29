/**
 * Host-migration sequence regression checks.
 *
 * Run with:
 *   bun test/online-migration-seq.test.ts
 */

import { MESSAGE, type FullStateMessage, type ServerMessage } from "../server/protocol.ts";
import type { GameState } from "../src/types.ts";
import { handleServerLifecycleMessage } from "../src/online-server-lifecycle.ts";
import { assert, runTests, test } from "./test-helpers.ts";

function makeFullState(migrationSeq: number): FullStateMessage {
  return {
    type: MESSAGE.FULL_STATE,
    migrationSeq,
    phase: "BATTLE",
    round: 3,
    timer: 10,
    battleCountdown: 0,
    battleLength: 5,
    shotsFired: 2,
    rngState: 123,
    players: [],
    grunts: [],
    housesAlive: [],
    bonusSquares: [],
    towerAlive: [],
    burningPits: [],
    cannonLimits: [],
    playerZones: [],
    activePlayer: 0,
    towerPendingRevive: [],
    capturedCannons: [],
    balloonHits: [],
    cannonballs: [],
  };
}

test("lifecycle drops stale full_state after host migration", () => {
  let migrationSeq = 0;
  let applyCalls = 0;

  const deps = {
    log: () => {},
    now: () => 0,
    session: {
      isHost: () => false,
      getMyPlayerId: () => 0,
      setMyPlayerId: () => {},
      getHostMigrationSeq: () => migrationSeq,
      setHostMigrationSeq: (seq: number) => {
        migrationSeq = seq;
      },
      bumpHostMigrationSeq: () => {
        migrationSeq++;
      },
    },
    lobby: {
      setWaitTimer: () => {},
      setRoomSettings: () => {},
      showWaitingRoom: () => {},
      setStartTime: () => {},
      joined: [] as boolean[],
      occupiedSlots: new Set<number>(),
      remoteHumanSlots: new Set<number>(),
    },
    ui: {
      getLifeLostDialog: () => null,
      clearLifeLostDialog: () => {},
      isLifeLostMode: () => false,
      setGameMode: () => {},
      setAnnouncement: () => {},
      createErrorEl: { textContent: "" } as HTMLElement,
      joinErrorEl: { textContent: "" } as HTMLElement,
    },
    game: {
      getState: () => ({}) as unknown as GameState,
      initFromServer: () => {},
      enterTowerSelection: () => {},
    },
    transitions: {
      onCastleWalls: () => {},
      onCannonStart: () => {},
      onBattleStart: () => {},
      onBuildStart: () => {},
      onBuildEnd: () => {},
      onGameOver: () => {},
    },
    migration: {
      playerNames: ["P1", "P2", "P3"],
      promoteToHost: () => {},
      applyFullState: () => {
        applyCalls++;
      },
    },
  };

  // Migration event moves sequence from 0 -> 1.
  handleServerLifecycleMessage(
    {
      type: MESSAGE.HOST_LEFT,
      newHostPlayerId: 1,
      previousHostPlayerId: 0,
    } as ServerMessage,
    deps,
  );
  assert(migrationSeq === 1, `expected migrationSeq=1, got ${migrationSeq}`);

  // Stale full state (seq 0) must be ignored.
  handleServerLifecycleMessage(makeFullState(0), deps);
  assert(applyCalls === 0, `expected stale full_state to be ignored, calls=${applyCalls}`);

  // Current sequence should apply.
  handleServerLifecycleMessage(makeFullState(1), deps);
  assert(applyCalls === 1, `expected current full_state to apply once, calls=${applyCalls}`);

  // Newer sequence should apply and advance sequence.
  handleServerLifecycleMessage(makeFullState(2), deps);
  assert(applyCalls === 2, `expected newer full_state to apply, calls=${applyCalls}`);
  assert(migrationSeq === 2, `expected migrationSeq to advance to 2, got ${migrationSeq}`);
});

await runTests("Online lifecycle migration sequence");
