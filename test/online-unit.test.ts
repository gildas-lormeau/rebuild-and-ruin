/**
 * Online subsystem unit tests — fast, pure-logic tests for online infrastructure.
 *
 * Covers: DedupChannel, host-migration sequence, full-state UI recovery.
 *
 * Run with: deno test --no-check test/online-unit.test.ts
 */

import { assert, assertEquals } from "@std/assert";
import { MESSAGE, type FullStateMessage, type ServerMessage } from "../src/protocol/protocol.ts";
import { createDedupChannel } from "../src/shared/core/phantom-types.ts";
import { restoreFullStateUiRecovery } from "../src/online/online-full-state-recovery.ts";
import type { BalloonFlight } from "../src/shared/core/battle-types.ts";
import { handleServerLifecycleMessage } from "../src/online/online-server-lifecycle.ts";
import type { GameMode } from "../src/shared/core/game-constants.ts";
import type { GameState } from "../src/shared/core/types.ts";
import type { PlayerSlotId, ValidPlayerSlot } from "../src/shared/core/player-slot.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";

Deno.test("DedupChannel.shouldSend returns false on duplicate", () => {
  const ch = createDedupChannel();
  ch.shouldSend(0 as ValidPlayerSlot, "5,3,normal");
  assert(ch.shouldSend(0 as ValidPlayerSlot, "5,3,normal") === false, "duplicate should return false");
});

Deno.test("DedupChannel.shouldSend tracks players independently", () => {
  const ch = createDedupChannel();
  ch.shouldSend(0 as ValidPlayerSlot, "5,3,normal");
  assert(ch.shouldSend(1 as ValidPlayerSlot, "5,3,normal") === true, "different player same key should return true");
  assert(ch.shouldSend(0 as ValidPlayerSlot, "5,3,normal") === false, "player 0 unchanged should return false");
});

Deno.test("DedupChannel.shouldSend updates stored key on change", () => {
  const ch = createDedupChannel();
  ch.shouldSend(0 as ValidPlayerSlot, "first");
  ch.shouldSend(0 as ValidPlayerSlot, "second");
  assert(ch.shouldSend(0 as ValidPlayerSlot, "second") === false, "stored key should be 'second' after change");
  assert(ch.shouldSend(0 as ValidPlayerSlot, "first") === true, "reverting to 'first' should be a change");
});

Deno.test("full_state recovery clears stale transition mode into game mode", () => {
  const target = {
    mode: Mode.TRANSITION,
    castleBuilds: [1],
    announcement: "Battle!" as string | undefined,
    battleFlights: [{ flight: { startX: 0, startY: 0, endX: 10, endY: 10 }, progress: 0.5 }],
    lifeLostCleared: false,
  };

  restoreFullStateUiRecovery(
    {
      setMode: (mode) => {
        target.mode = mode;
      },
      clearCastleBuilds: () => {
        target.castleBuilds = [];
      },
      clearLifeLostDialog: () => {
        target.lifeLostCleared = true;
      },
      clearAnnouncement: () => {
        target.announcement = undefined;
      },
      setBattleFlights: (flights) => {
        target.battleFlights = [...flights];
      },
    },
    Phase.BATTLE,
  );

  assert(target.mode === Mode.GAME, `expected GAME mode, got ${Mode[target.mode]}`);
  assert(target.castleBuilds.length === 0, "expected castle build animation queue to be cleared");
  assert(target.announcement === undefined, "expected stale banner announcement to be cleared");
  assert(target.lifeLostCleared, "expected stale life-lost dialog to be cleared");
  assert(target.battleFlights.length === 0, "expected stale balloon flights to be cleared");
});

Deno.test("full_state recovery restores balloon animation mode when flights are present", () => {
  const target = {
    mode: Mode.GAME,
    battleFlights: [] as { flight: BalloonFlight; progress: number }[],
  };
  const flights = [{ flight: { startX: 1, startY: 2, endX: 3, endY: 4 }, progress: 0.25 }];

  restoreFullStateUiRecovery(
    {
      setMode: (mode) => {
        target.mode = mode;
      },
      clearCastleBuilds: () => {},
      clearLifeLostDialog: () => {},
      clearAnnouncement: () => {},
      setBattleFlights: (nextFlights) => {
        target.battleFlights = [...nextFlights];
      },
    },
    Phase.BATTLE,
    flights,
  );

  assert(target.mode === Mode.BALLOON_ANIM, `expected BALLOON_ANIM mode, got ${Mode[target.mode]}`);
  assert(target.battleFlights.length === 1, `expected 1 recovered flight, got ${target.battleFlights.length}`);
  assert(target.battleFlights[0]!.progress === 0.25, "expected recovered flight progress to be preserved");
});

Deno.test("lifecycle drops stale full_state after host migration", () => {
  let migrationSeq = 0;
  let applyCalls = 0;

  const deps = {
    log: () => {},
    now: () => 0,
    session: {
      isHost: false,
      myPlayerId: 0 as PlayerSlotId,
      get hostMigrationSeq() { return migrationSeq; },
      set hostMigrationSeq(seq: number) { migrationSeq = seq; },
      roomWaitTimerSec: 0,
      roomMaxRounds: 0,
      roomCannonMaxHp: 3,
      roomGameMode: "classic" as GameMode,
      lobbyStartTime: 0,
      occupiedSlots: new Set<ValidPlayerSlot>(),
      remotePlayerSlots: new Set<ValidPlayerSlot>(),
    },
    lobby: {
      showWaitingRoom: () => {},
      joined: [] as boolean[],
    },
    ui: {
      getLifeLostDialog: () => null,
      clearLifeLostDialog: () => {},
      isLifeLostMode: () => false,
      getUpgradePickDialog: () => null,
      clearUpgradePickDialog: () => {},
      isUpgradePickMode: () => false,
      setModeToGame: () => {},
      setAnnouncement: () => {},
      createErrorEl: { textContent: "" } as HTMLElement,
      joinErrorEl: { textContent: "" } as HTMLElement,
    },
    game: {
      getState: () => ({}) as unknown as GameState,
      initFromServer: async () => {},
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
      promoteToHost: async () => {},
      restoreFullState: () => {
        applyCalls++;
      },
    },
  };

  // Migration event moves sequence from 0 -> 1.
  handleServerLifecycleMessage(
    {
      type: MESSAGE.HOST_LEFT,
      newHostPlayerId: 1,
      disconnectedPlayerId: 0,
    } as ServerMessage,
    deps,
  );
  assert(migrationSeq === 1, `expected migrationSeq=1, got ${migrationSeq}`);

  // Stale full state (seq 0) must be ignored.
  handleServerLifecycleMessage(makeFullState(0), deps);
  assertEquals(applyCalls, 0, `expected stale full_state to be ignored, calls=${applyCalls}`);

  // Current sequence should apply.
  handleServerLifecycleMessage(makeFullState(1), deps);
  assertEquals(applyCalls, 1, `expected current full_state to apply once, calls=${applyCalls}`);

  // Newer sequence should apply and advance sequence.
  handleServerLifecycleMessage(makeFullState(2), deps);
  assertEquals(applyCalls, 2, `expected newer full_state to apply, calls=${applyCalls}`);
  assertEquals(migrationSeq, 2, `expected migrationSeq to advance to 2, got ${migrationSeq}`);
});

function makeFullState(migrationSeq: number): FullStateMessage {
  return {
    type: MESSAGE.FULL_STATE,
    migrationSeq,
    phase: "BATTLE",
    round: 3,
    timer: 10,
    battleCountdown: 0,
    maxRounds: 5,
    shotsFired: 2,
    rngState: 123,
    players: [],
    grunts: [],
    houses: [],
    bonusSquares: [],
    towerAlive: [],
    burningPits: [],
    cannonLimits: [],
    playerZones: [],
    towerPendingRevive: [],
    capturedCannons: [],
    cannonballs: [],
    gameMode: "classic",
    activeModifier: null,
    activeModifierChangedTiles: [],
    lastModifierId: null,
    frozenTiles: null,
  };
}
