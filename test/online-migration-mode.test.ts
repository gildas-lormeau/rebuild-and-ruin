import { restoreFullStateUiRecovery } from "../src/online-full-state-recovery.ts";
import { Mode, Phase } from "../src/types.ts";
import { assert, runTests, test } from "./test-helpers.ts";

test("full_state recovery clears stale banner mode into game mode", () => {
  const target = {
    mode: Mode.BANNER,
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

test("full_state recovery restores balloon animation mode when flights are present", () => {
  const target = {
    mode: Mode.GAME,
    battleFlights: [] as { flight: { startX: number; startY: number; endX: number; endY: number }; progress: number }[],
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

await runTests("Online full_state migration mode recovery");