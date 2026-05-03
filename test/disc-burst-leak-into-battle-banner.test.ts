/**
 * Runtime contract: the disc-burst gate stays open for the entire
 * MODIFIER_REVEAL phase. The dwell is enough for one disc cycle to
 * finish, but the gate doesn't auto-close — so the renderer-side
 * burst manager MUST handle one-shot semantics itself (latch a
 * `released` flag per paletteKey), otherwise the burst loops and
 * leaks into the next banner's `prevScene` snapshot.
 *
 * Parameterized over every modifier still using
 * `createModifierRevealBurstManager`. Disc total = `discDurationMs +
 * staggerSpanMs` per wrapper:
 *
 *   - low_water / high_tide / frozen_river / sinkhole: 1100 + 600 = 1700ms
 *   - wildfire: 900 + 900 = 1800ms
 *   - dry_lightning: 600 + 1300 = 1900ms
 *
 * `MODIFIER_REVEAL_TIMER = 2000ms` is the phase dwell, so each total
 * fits with 100-300ms of slack.
 *
 * What this headless test verifies (renderer state is not directly
 * observable here — fix verification is browser-side):
 *   - Dwell > disc total (one-shot CAN finish in time).
 *   - `overlay.ui.modifierReveal` stays set through to BATTLE entry
 *     (the gate is open the whole phase, not auto-closed by runtime).
 *
 * If either property regresses, the disc-burst manager's
 * `released`-latch fix would no longer be sufficient.
 *
 * Run with: deno test --no-check test/disc-burst-leak-into-battle-banner.test.ts
 */

import { assert } from "@std/assert";
import type { ModifierId } from "../src/shared/core/game-constants.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { loadSeed } from "./scenario.ts";

interface BurstCase {
  readonly modifierId: ModifierId;
  readonly seed: string;
  readonly discTotalMs: number;
}

const MAX_TIMEOUT_MS = 1_200_000;
const CASES: readonly BurstCase[] = [
  { modifierId: "low_water", seed: "modifier:low_water", discTotalMs: 1700 },
  { modifierId: "high_tide", seed: "modifier:high_tide", discTotalMs: 1700 },
  {
    modifierId: "frozen_river",
    seed: "modifier:frozen_river",
    discTotalMs: 1700,
  },
  { modifierId: "sinkhole", seed: "modifier:sinkhole", discTotalMs: 1700 },
  { modifierId: "wildfire", seed: "modifier:wildfire", discTotalMs: 1800 },
  {
    modifierId: "dry_lightning",
    seed: "modifier:dry_lightning",
    discTotalMs: 1900,
  },
];

for (const burstCase of CASES) {
  Deno.test(
    `disc-burst leak: ${burstCase.modifierId} (disc total ${burstCase.discTotalMs}ms)`,
    async () => {
      const { dwellMs, modifierRevealActiveAtBattleEntry } =
        await captureRevealTiming(burstCase);

      console.log(
        [
          "",
          `  ${burstCase.modifierId}:`,
          `    post-sweep dwell                 = ${dwellMs} ms`,
          `    disc-burst total                 = ${burstCase.discTotalMs} ms`,
          `    overlay.ui.modifierReveal still set at BATTLE entry: ${modifierRevealActiveAtBattleEntry}`,
          "",
        ].join("\n"),
      );

      // Property 1: the dwell is sufficient for one disc cycle. If
      // this regressed, the renderer's released-latch wouldn't even
      // get a chance to fire before BATTLE entry.
      assert(
        dwellMs > burstCase.discTotalMs,
        `${burstCase.modifierId}: dwell ${dwellMs}ms <= disc-burst total ` +
          `${burstCase.discTotalMs}ms. The renderer's released-latch can't ` +
          `fix this — would need a longer MODIFIER_REVEAL_TIMER.`,
      );

      // Property 2: the gate (`overlay.ui.modifierReveal`) stays set
      // through BATTLE entry. Confirms the runtime does NOT auto-
      // close the gate, so the renderer's per-paletteKey latch is
      // doing the one-shot work.
      assert(
        modifierRevealActiveAtBattleEntry,
        `${burstCase.modifierId}: \`overlay.ui.modifierReveal\` was cleared ` +
          `before BATTLE entry — the runtime contract changed. The ` +
          `renderer's released-latch is no longer load-bearing; either ` +
          `update the latch logic to match, or remove it.`,
      );
    },
  );
}

async function captureRevealTiming(burstCase: BurstCase): Promise<{
  dwellMs: number;
  modifierRevealActiveAtBattleEntry: boolean;
}> {
  using sc = await loadSeed(burstCase.seed);

  let modifierApplied = false;
  let revealSweepEndAt: number | undefined;
  let battlePhaseStartAt: number | undefined;
  let modifierRevealActiveAtBattleEntry = false;
  let lastModifierRevealActive = false;

  sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
    if (ev.modifierId === burstCase.modifierId) modifierApplied = true;
  });

  sc.bus.on(GAME_EVENT.BANNER_SWEEP_END, (ev) => {
    if (
      modifierApplied &&
      ev.bannerKind === "modifier-reveal" &&
      revealSweepEndAt === undefined
    ) {
      revealSweepEndAt = sc.now();
    }
  });

  sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
    if (
      modifierApplied &&
      ev.phase === Phase.BATTLE &&
      revealSweepEndAt !== undefined &&
      battlePhaseStartAt === undefined
    ) {
      battlePhaseStartAt = sc.now();
      modifierRevealActiveAtBattleEntry = lastModifierRevealActive;
    }
  });

  sc.bus.on(GAME_EVENT.TICK, () => {
    lastModifierRevealActive =
      sc.overlay()?.ui?.modifierReveal !== undefined;
  });

  sc.runUntil(
    () => battlePhaseStartAt !== undefined,
    { timeoutMs: MAX_TIMEOUT_MS },
  );

  assert(
    revealSweepEndAt !== undefined,
    `${burstCase.modifierId}: modifier-reveal banner should have swept`,
  );
  assert(
    battlePhaseStartAt !== undefined,
    `${burstCase.modifierId}: BATTLE phase should have started`,
  );

  return {
    dwellMs: battlePhaseStartAt - revealSweepEndAt,
    modifierRevealActiveAtBattleEntry,
  };
}
