/**
 * Behavioral spec for the AI declutter tactic: once a player's redundant
 * inner ("fat") walls accumulate past the trigger threshold, the AI spends a
 * bounded battle chain shooting them out — WITHOUT ever opening an enclosure.
 *
 * A fat wall's every 8-neighbour is the shooter's own wall or interior, so
 * removing it can never connect interior to the outside flood (which is
 * 8-connected). The test re-verifies that invariant against LIVE state at
 * each declutter fire decision — so it also catches the plan-to-fire
 * staleness window (a neighbour destroyed by enemy fire mid-chain would make
 * the target load-bearing and the shot enclosure-opening).
 *
 * Probed seed (tmp/probe-declutter-gates.ts over classic r10): seed 8 crosses
 * the fat threshold from round 5 and fires declutter chains every round after.
 *
 * Run with: deno test --no-check test/ai-declutter.test.ts
 */

import { assert, assertEquals } from "@std/assert";
import { setAiBattleDiagHook } from "../src/ai/ai-battle-diag.ts";
import { computeLiveInterior } from "../src/ai/ai-strategy-battle.ts";
import {
  DIRS_8,
  inBounds,
  packTile,
} from "../src/shared/core/spatial.ts";
import { createScenario } from "./scenario.ts";

Deno.test(
  "AI declutter: fires at own fat walls once bloated, never at an enclosure-load-bearing tile",
  async () => {
    using sc = await createScenario({
      seed: 8,
      mode: "classic",
      rounds: Number.POSITIVE_INFINITY,
    });

    let declutterFires = 0;
    const violations: string[] = [];

    setAiBattleDiagHook((ev) => {
      if (ev.origin !== "declutter") return;
      const target = ev.intendedTarget;
      if (!target) return;
      declutterFires++;
      // Declutter targets are pre-filtered to unoccluded tiles, so the aim
      // seam must pass them through verbatim — a redirect would land the
      // ball on a tile the safety invariant was never checked for.
      if (
        ev.aimTarget &&
        (ev.aimTarget.row !== target.row || ev.aimTarget.col !== target.col)
      ) {
        violations.push(
          `r${sc.state.round} aim redirected (${target.row},${target.col}) -> ` +
            `(${ev.aimTarget.row},${ev.aimTarget.col})`,
        );
        return;
      }
      // The target must be someone's OWN wall (walls are disjoint per player,
      // so ownership identifies the shooter), and — against LIVE state at
      // fire time — still fat: every 8-neighbour the owner's wall/interior.
      const key = packTile(target.row, target.col);
      const owner = sc.state.players.find((p) => p.walls.has(key));
      if (!owner) return; // target died during the aim dwell — harmless
      const interior = computeLiveInterior(owner.walls);
      for (const [dr, dc] of DIRS_8) {
        const nr = target.row + dr;
        const nc = target.col + dc;
        const nkey = packTile(nr, nc);
        if (
          !inBounds(nr, nc) ||
          (!owner.walls.has(nkey) && !interior.has(nkey))
        ) {
          violations.push(
            `r${sc.state.round} p${owner.id} fired own wall ` +
              `(${target.row},${target.col}) that is load-bearing at ` +
              `(${nr},${nc}) — enclosure-opening self-shot`,
          );
          break;
        }
      }
    });

    try {
      // Round 8 means three post-threshold battles (r5-r7) completed.
      sc.runUntil(() => sc.state.round >= 8, { timeoutMs: 900_000 });
    } finally {
      setAiBattleDiagHook(undefined);
    }

    assert(
      declutterFires > 0,
      "expected declutter fires by round 7 (probed seed) — the tactic never " +
        "triggered (vacuous)",
    );
    assertEquals(
      violations,
      [],
      `${violations.length} unsafe declutter fire(s) of ${declutterFires}`,
    );

    console.log(
      `\n  ${declutterFires} declutter fire(s), all at live fat walls — ` +
        `no enclosure-opening self-shot`,
    );
  },
);
