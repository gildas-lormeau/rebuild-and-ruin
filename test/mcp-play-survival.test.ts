/**
 * MCP-play harness: dead-vs-alive tower accounting in enclosure candidates.
 *
 * Regression guard for the footgun that the agent hit in live play: the survival
 * life-penalty clears only when an ALIVE tower is enclosed
 * (`filterAliveEnclosedTowers`), but the enclosure-candidate list used to surface
 * a dead tower as a normal "enclosable ★+BONUS / SEAL NOW" row with no flag — so
 * sealing it looked safe, the roster flipped to `encl1`, the survival warning
 * stayed on, and the round finalized into a lost life.
 *
 * The fix adds `alive` + `satisfiesSurvival` to every candidate. This test plays
 * a modern game, deliberately walling ONLY the home tower so the exposed outer
 * towers get killed by grunts and show up as DEAD candidates, then asserts the
 * accounting stays internally consistent — the check that would have caught the
 * original gap and guards against it returning.
 */

import { assert } from "@std/assert";
import { createMcpGame } from "../scripts/mcp-play/harness.ts";
import { renderObservation } from "../scripts/mcp-play/render.ts";

Deno.test("mcp-play: enclosure candidates carry honest alive/survival flags", async () => {
  const game = await createMcpGame({ mode: "modern", rounds: 12, seed: 99 });

  let sawDead = false;
  let sawEnclosedDead = false;
  let wallBuilds = 0;

  // Drive the whole game. Wall ONLY the home tower each build so the exposed
  // outer towers die to grunts and appear as DEAD candidates over time.
  for (let step = 0; step < 400; step++) {
    const obs = game.observe();
    if (obs.gameOver) break;

    switch (obs.phase) {
      case "CASTLE_SELECT": {
        const towerIdx = obs.towers?.[0]?.index ?? 0;
        game.act({ kind: "select", towerIdx });
        break;
      }
      case "CANNON_PLACE": {
        game.act({ kind: "cannon-done" });
        break;
      }
      case "UPGRADE_PICK": {
        game.act({ kind: "pick-upgrade", cardIdx: 0 });
        break;
      }
      case "WALL_BUILD": {
        wallBuilds++;
        const seen = assertCandidateAccounting(obs);
        sawDead ||= seen.sawDead;
        sawEnclosedDead ||= seen.sawEnclosedDead;
        // Early rounds: wall ONLY the home tower, leaving outer towers exposed so
        // grunts kill them (→ dead candidates). Once dead towers exist, switch to
        // buildOut so they get ENCLOSED too — that's what exercises INV3 on a dead
        // enclosed entry (the seal that must NOT bump aliveEnclosedTowers).
        if (sawDead) game.buildOut();
        else game.build();
        const after = assertCandidateAccounting(game.observe());
        sawDead ||= after.sawDead;
        sawEnclosedDead ||= after.sawEnclosedDead;
        game.pass(undefined, 60);
        break;
      }
      default: {
        // MODIFIER_REVEAL / BATTLE / countdowns — nothing for the agent to do.
        game.pass(undefined, 30);
        break;
      }
    }
  }

  assert(wallBuilds > 0, "expected to reach at least one WALL_BUILD phase");
  // The whole point: the game must actually produce DEAD tower candidates, or the
  // alive/survival branch of the accounting was never exercised.
  assert(
    sawDead,
    "expected at least one DEAD tower candidate over the game (home-only build " +
      "should let grunts kill the exposed outer towers)",
  );
  // Best-effort: note whether we also hit the exact bug state (a dead tower
  // enclosed). INV3 already guarantees it's accounted correctly if so.
  if (!sawEnclosedDead) {
    console.log(
      "(note) never enclosed a dead tower this run — INV3 still guards the count",
    );
  }
});

/** Assert the per-candidate alive/survival accounting is internally consistent
 *  with the survival counter the round-end life penalty actually uses. */
function assertCandidateAccounting(
  obs: ReturnType<Awaited<ReturnType<typeof createMcpGame>>["observe"]>,
): { sawDead: boolean; sawEnclosedDead: boolean } {
  const candidates = obs.enclosureCandidates ?? [];
  const holdsRestorationCrew = (obs.me.activeUpgrades ?? []).some(
    (upgrade) => upgrade.id === "restoration_crew",
  );
  let sawDead = false;
  let sawEnclosedDead = false;

  for (const candidate of candidates) {
    // INV1: the new fields exist and are booleans on every candidate.
    assert(
      typeof candidate.alive === "boolean",
      `candidate ${candidate.towerIdx} missing boolean alive`,
    );
    assert(
      typeof candidate.satisfiesSurvival === "boolean",
      `candidate ${candidate.towerIdx} missing boolean satisfiesSurvival`,
    );
    // INV2: a seal clears the life-loss iff the tower is alive, or it's dead but
    // Restoration Crew will revive it on enclose.
    assert(
      candidate.satisfiesSurvival === (candidate.alive || holdsRestorationCrew),
      `candidate ${candidate.towerIdx}: satisfiesSurvival ${candidate.satisfiesSurvival} ` +
        `≠ alive(${candidate.alive}) || restorationCrew(${holdsRestorationCrew})`,
    );
    if (!candidate.alive) sawDead = true;
    if (!candidate.alive && candidate.status === "enclosed") {
      sawEnclosedDead = true;
    }
  }

  // INV3 (the core fix): the survival counter equals the number of ALIVE enclosed
  // towers — a DEAD enclosed tower must NOT be counted. This is the exact
  // divergence that cost a life: encl-count up, aliveEnclosedTowers flat.
  const aliveEnclosedCandidates = candidates.filter(
    (candidate) => candidate.status === "enclosed" && candidate.alive,
  ).length;
  assert(
    aliveEnclosedCandidates === obs.me.aliveEnclosedTowers,
    `alive-enclosed candidate count ${aliveEnclosedCandidates} ≠ ` +
      `me.aliveEnclosedTowers ${obs.me.aliveEnclosedTowers}`,
  );

  // The rendered board must visibly flag dead candidates, so a "SEAL NOW ★+BONUS"
  // row can't be misread as survival-safe.
  if (sawDead) {
    assert(
      renderObservation(obs).includes("⚑DEAD"),
      "expected a ⚑DEAD marker in the rendered board when a dead candidate exists",
    );
  }

  // INV4 (the render footgun): when no alive tower is enclosed, the survival
  // warning must render, and any tower it names as the saver must actually clear
  // the loss (never a plain dead tower).
  if (obs.me.aliveEnclosedTowers === 0) {
    const board = renderObservation(obs);
    assert(
      board.includes("☠ SURVIVAL"),
      "expected ☠ SURVIVAL warning when no alive tower is enclosed",
    );
    const sealMatch = board.match(/Seal (home|tower (\d+))/);
    if (sealMatch) {
      const named = sealMatch[2] === undefined
        ? candidates.find((candidate) => candidate.isHome)
        : candidates.find(
          (candidate) => candidate.towerIdx === Number(sealMatch[2]),
        );
      assert(
        named !== undefined && named.satisfiesSurvival,
        `survival hint named a tower that does not satisfy survival: ${sealMatch[0]}`,
      );
    }
  }

  return { sawDead, sawEnclosedDead };
}
