/**
 * Network layer validation — runs the same game twice and asserts both
 * runs produce equivalent outcomes:
 *
 *   1. Local: one runtime, no network.
 *   2. Networked: host runtime + pure watcher runtime, both running the
 *      same `tickGame` locally (clone-everywhere). Host broadcasts wire
 *      messages for the human-input deltas; watcher applies them via
 *      the production `handleServerMessage` dispatcher.
 *
 * Convergence invariants asserted at game end:
 *   - `host.state.round` === `local.state.round` (host plays the same
 *     game the local run would).
 *   - `watcher.state` matches `host.state` on every slot (lives, walls
 *     count, cannons count, enclosedTowers count, score) — proves the wire
 *     faithfully mirrors host state to the watcher.
 *
 * Covers two code paths:
 *   - Pure AI: all slots AI on both runtimes. Deterministic by seed.
 *   - AI-assisted human: slot 1 on the host runs as an
 *     AiAssistedHumanController (kind:"human", AI brain), so its
 *     placements + fires + life-lost choices flow through the human
 *     action wire path (`sendOpponentPiecePlaced` /
 *     `OPPONENT_CANNON_PLACED` / `CANNON_FIRED` / `LIFE_LOST_CHOICE`).
 *     Same convergence invariants must hold.
 *
 * If the watcher diverges from the host, the failure is a real network-
 * layer bug (missing broadcast, wrong payload shape, or dispatcher
 * misapplication). Test-wrapper-shape artifacts are architecturally
 * excluded — both runtimes use production-grade wiring.
 */

import { assert, assertEquals } from "@std/assert";
import { createScenario, type Scenario } from "./scenario.ts";
import { createNetworkedPair, runNetworkedToEnd } from "./network-setup.ts";
import { DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS } from "../src/shared/core/action-schedule.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";
import { PLAYER_NAMES } from "../src/shared/ui/player-config.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";
import type { PieceShape } from "../src/shared/core/pieces.ts";

interface PlayerSnapshot {
  readonly id: number;
  readonly lives: number;
  readonly walls: number;
  readonly cannons: number;
  readonly enclosedTowers: number;
  readonly score: number;
  readonly currentPiece: PieceShape | undefined;
  readonly bagQueueLen: number | null;
}

interface StateSnapshot {
  readonly rngState: number;
  readonly players: readonly PlayerSnapshot[];
}

// Parameterized stress — a handful of (seed, mode, rounds) triples to
// catch divergences that only appear over longer play or on specific
// seeds. If this table fails a row, that row is a real network-layer
// bug reproducer.
const STRESS_TRIPLES: {
  readonly seed: number;
  readonly mode: "classic" | "modern";
  readonly rounds: number;
}[] = [
  { seed: 1, mode: "classic", rounds: 5 },
  { seed: 13, mode: "classic", rounds: 5 },
  { seed: 7, mode: "modern", rounds: 5 },
  { seed: 42, mode: "modern", rounds: 5 },
];
// Stress for the assisted-human code path — longer runs + modern mode
// so the LIFE_LOST_CHOICE / UPGRADE_PICK wire paths get exercised too.
const ASSISTED_STRESS: {
  readonly seed: number;
  readonly mode: "classic" | "modern";
  readonly rounds: number;
}[] = [
  { seed: 1, mode: "classic", rounds: 8 },
  { seed: 42, mode: "modern", rounds: 5 },
  { seed: 7, mode: "modern", rounds: 5 },
];

Deno.test(
  "network vs local (pure AI, classic): watcher mirrors host end-to-end",
  async () => {
    const seed = 42;
    const mode = "classic" as const;
    const rounds = 3;

    // Local baseline.
    const local = await createScenario({ seed, mode, rounds });
    local.runGame();
    const localSnap = snapshotState(local);
    assertEquals(local.mode(), Mode.STOPPED);

    // Networked run.
    const { host, watcher, pump } = await createNetworkedPair({
      seed,
      mode,
      rounds,
    });
    await runNetworkedToEnd(host, watcher, pump);

    const hostSnap = snapshotState(host);
    const watcherSnap = snapshotState(watcher);

    // Host should match local (deterministic AI, same seed).
    assertStateConverges(hostSnap, localSnap, "host vs local");
    // Watcher should match host (network layer faithful).
    assertStateConverges(watcherSnap, hostSnap, "watcher vs host");

    assertEquals(
      watcher.state.round,
      host.state.round,
      `round diverged: host=${host.state.round} watcher=${watcher.state.round}`,
    );

    assertWireExercised(host, "classic pure AI");
  },
);

Deno.test(
  "network vs local (pure AI, modern): watcher mirrors host end-to-end",
  async () => {
    const seed = 7;
    const mode = "modern" as const;
    const rounds = 3;

    const local = await createScenario({ seed, mode, rounds });
    local.runGame();
    const localSnap = snapshotState(local);

    const { host, watcher, pump } = await createNetworkedPair({
      seed,
      mode,
      rounds,
    });
    await runNetworkedToEnd(host, watcher, pump);

    const hostSnap = snapshotState(host);
    const watcherSnap = snapshotState(watcher);

    assertStateConverges(hostSnap, localSnap, "host vs local");
    assertStateConverges(watcherSnap, hostSnap, "watcher vs host");

    assertWireExercised(host, "modern pure AI");
  },
);

for (const stress of STRESS_TRIPLES) {
  Deno.test(
    `network vs local (pure AI stress, seed=${stress.seed} ${stress.mode} r${stress.rounds}): watcher mirrors host`,
    async () => {
      const local = await createScenario({
        seed: stress.seed,
        mode: stress.mode,
        rounds: stress.rounds,
      });
      local.runGame();

      const { host, watcher, pump } = await createNetworkedPair({
        seed: stress.seed,
        mode: stress.mode,
        rounds: stress.rounds,
      });
      await runNetworkedToEnd(host, watcher, pump);

      const hostSnap = snapshotState(host);
      const watcherSnap = snapshotState(watcher);
      const localSnap = snapshotState(local);

      assertStateConverges(hostSnap, localSnap, "host vs local");
      assertStateConverges(watcherSnap, hostSnap, "watcher vs host");
      assertWireExercised(host, `stress seed=${stress.seed} ${stress.mode}`);
    },
  );
}

/** Sanity check: the host must have broadcast lifecycle checkpoints
 *  during the run. Under clone-everywhere, AI placements are recomputed
 *  locally on every peer (wire = uncomputable inputs only), so pure-AI
 *  runs only emit lifecycle messages — that's the only host-side proof
 *  that the wire was actually used. The assisted-human tests have their
 *  own bespoke assertion for slot-specific human-input broadcasts. */
Deno.test(
  "network: a local human's castle confirm broadcasts exactly once (in-flight guard)",
  async () => {
    const slot = 1 as ValidPlayerId;
    const { host, watcher, pump } = await createNetworkedPair({
      seed: 42,
      mode: "classic",
      rounds: 3,
      assistedSlots: [slot],
    });

    const confirmsSent = () =>
      host.sentMessages.filter((msg) => {
        const m = msg as { type: string; playerId?: number; confirmed?: boolean };
        return (
          m.type === "opponentTowerSelected" &&
          m.playerId === slot &&
          m.confirmed === true
        );
      }).length;

    // Drive round-1 CASTLE_SELECT until the assisted slot's confirm has
    // first hit the wire. The slot is a `kind:"human"` controller, so the
    // confirm takes the lockstep broadcast path; its AI brain keeps
    // reporting "done" every tick of the send→applyAt window, which without
    // an in-flight guard re-broadcasts the confirm on each of those ticks.
    for (
      let step = 0;
      step < 60_000 && confirmsSent() === 0;
      step++
    ) {
      host.tick(1);
      await pump();
      watcher.tick(1);
    }
    assert(confirmsSent() >= 1, "assisted slot never broadcast its confirm");
    // Let the full send→applyAt window (and then some) elapse so any
    // per-tick duplicate sends would have all fired.
    host.tick(DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS * 3);

    assertEquals(
      confirmsSent(),
      1,
      "the lockstep confirm should broadcast exactly once, not once per " +
        "tick of the send→applyAt window",
    );
  },
);

function assertWireExercised(host: Scenario, label: string): void {
  const lifecycleTypes = new Set(["cannonStart", "battleStart", "buildStart"]);
  const lifecycle = host.sentMessages.filter((msg) =>
    lifecycleTypes.has((msg as { type: string }).type),
  );
  assert(
    lifecycle.length > 0,
    `${label}: no lifecycle checkpoints broadcast — the wire wasn't exercised`,
  );
}

Deno.test(
  "network vs local (assisted human slot 1, classic): watcher mirrors host end-to-end",
  async () => {
    const seed = 42;
    const mode = "classic" as const;
    const rounds = 3;
    const assistedSlot = 1 as ValidPlayerId;

    // Local baseline — assisted human runs locally, broadcasts land in
    // `local.sentMessages` but are never delivered to any peer.
    const local = await createScenario({
      seed,
      mode,
      rounds,
      assistedSlots: [assistedSlot],
    });
    local.runGame();
    const localSnap = snapshotState(local);

    // Networked — host runs the assisted controller, broadcasts flow to
    // the watcher through `pump()`. The watcher runs regular AI for every
    // slot (no `assistedSlots`) so its strategy.rng stays in lockstep with
    // the host's same-seeded slot 1 strategy.
    const { host, watcher, pump } = await createNetworkedPair({
      seed,
      mode,
      rounds,
      assistedSlots: [assistedSlot],
    });
    await runNetworkedToEnd(host, watcher, pump);

    const hostSnap = snapshotState(host);
    const watcherSnap = snapshotState(watcher);

    assertStateConverges(hostSnap, localSnap, "host vs local");
    assertStateConverges(watcherSnap, hostSnap, "watcher vs host");

    // The assisted slot must actually have broadcast something — if its
    // placements never reached the wire, the watcher would still
    // "converge" trivially by running its own AI, and this test would
    // pass for the wrong reason. Check the host's sentMessages for at
    // least one piece/cannon/fire originating from the assisted slot.
    const assistedBroadcasts = host.sentMessages.filter((msg) => {
      const m = msg as { type: string; playerId?: number };
      return (
        (m.type === "opponentPiecePlaced" ||
          m.type === "opponentCannonPlaced" ||
          m.type === "cannonFired") &&
        m.playerId === assistedSlot
      );
    });
    assert(
      assistedBroadcasts.length > 0,
      `expected at least one assisted-slot broadcast; got 0 — ` +
        `the human wire path wasn't exercised`,
    );
  },
);

for (const stress of ASSISTED_STRESS) {
  Deno.test(
    `network vs local (assisted human stress, seed=${stress.seed} ${stress.mode} r${stress.rounds}): watcher mirrors host`,
    async () => {
      const slot = 1 as ValidPlayerId;
      const local = await createScenario({
        seed: stress.seed,
        mode: stress.mode,
        rounds: stress.rounds,
        assistedSlots: [slot],
      });
      local.runGame();

      const { host, watcher, pump } = await createNetworkedPair({
        seed: stress.seed,
        mode: stress.mode,
        rounds: stress.rounds,
        assistedSlots: [slot],
      });
      await runNetworkedToEnd(host, watcher, pump);

      const hostSnap = snapshotState(host);
      const watcherSnap = snapshotState(watcher);
      const localSnap = snapshotState(local);

      assertStateConverges(hostSnap, localSnap, "host vs local");
      assertStateConverges(watcherSnap, hostSnap, "watcher vs host");
    },
  );
}

Deno.test(
  "network: a remote human's upgrade entry waits for the wire pick (no local AI prediction)",
  async () => {
    const slot = 1 as ValidPlayerId;
    const { host, watcher, pump } = await createNetworkedPair({
      seed: 42,
      mode: "modern",
      rounds: 5,
      assistedSlots: [slot],
    });

    // Lockstep-pump until the watcher's pick dialog is interactable
    // (round 3), stopping the moment it opens — before the host's
    // assisted slot has had time to commit + broadcast its pick.
    for (
      let step = 0;
      step < 60_000 && watcher.mode() !== Mode.UPGRADE_PICK;
      step++
    ) {
      host.tick(1);
      await pump();
      watcher.tick(1);
    }
    assertEquals(
      watcher.mode(),
      Mode.UPGRADE_PICK,
      "watcher never reached the upgrade-pick dialog",
    );
    const pickSent = () =>
      host.sentMessages.some((msg) => {
        const m = msg as { type: string; playerId?: number };
        return m.type === "upgradePick" && m.playerId === slot;
      });
    assert(!pickSent(), "host must not have broadcast its pick yet");

    // Starve the wire: tick ONLY the watcher well past the AI auto-delay
    // (~2s; 300 frames = 5s, safely under the 17s grace backstop). The
    // assisted slot is a remote human from the watcher's view, so its
    // entry must stay pending — the old shouldAutoResolve non-host
    // branch had the watcher's local AI controller fill it right here,
    // forking the sims whenever the prediction disagreed with the
    // owner's actual pick.
    const remoteEntry = () =>
      watcher.overlay().ui?.upgradePick?.entries.find(
        (entry) => entry.playerName === PLAYER_NAMES[slot],
      );
    watcher.tick(300);
    const starved = remoteEntry();
    assert(starved, "watcher overlay should still show the pick dialog");
    assertEquals(
      starved.resolved,
      false,
      "remote human's entry must wait for the wire, not a local AI prediction",
    );

    // Resume the wire: the host commits + broadcasts; the watcher's
    // entry resolves from the message (or the dialog closes fully
    // resolved, which implies the same).
    for (
      let step = 0;
      step < 10_000 && !(remoteEntry()?.resolved ?? true);
      step++
    ) {
      host.tick(1);
      await pump();
      watcher.tick(1);
    }
    assert(pickSent(), "host should have broadcast the assisted pick");
    assert(
      remoteEntry()?.resolved ?? true,
      "the wire pick should resolve the watcher's entry",
    );
  },
);

// NOTE: there is no sibling test for a stale upgrade-pick / life-lost
// DIALOG leaking onto a frozen watcher's game-over screen. Those dialogs
// are dismissed independently by the phase-transition handler
// (online-server-lifecycle.ts) — a frozen watcher still receives the next
// round's BUILD_START before GAME_OVER, which clears the modal — so any
// such test would pass even with `resetUpgradePickDialog` removed from
// teardownSession (the clear there is defense-in-depth symmetry with
// `resetLifeLostDialog`, not the sole guard). The BANNER has no phase-
// transition dismissal, which is why only it gets a regression test.
Deno.test(
  "network: GAME_OVER on a frozen watcher clears the stale banner",
  async () => {
    const { host, watcher, pump } = await createNetworkedPair({
      seed: 1,
      mode: "classic",
      rounds: 3,
      broadcastGameOver: true,
    });

    // Lockstep-pump until a final-round banner is on the watcher's screen.
    for (
      let step = 0;
      step <
        60_000 &&
        !(watcher.banner() !== null && watcher.state.round === 3);
      step++
    ) {
      host.tick(1);
      await pump();
      watcher.tick(1);
    }
    assert(
      watcher.banner() !== null && watcher.state.round === 3,
      "watcher never showed a final-round banner",
    );

    // Freeze the watcher mid-banner; host plays the final round to the end.
    for (
      let step = 0;
      step < 120_000 && host.mode() !== Mode.STOPPED;
      step++
    ) {
      host.tick(1);
      await pump();
    }
    assertEquals(host.mode(), Mode.STOPPED, "host never finished the game");
    await pump();

    assertEquals(
      watcher.mode(),
      Mode.STOPPED,
      "GAME_OVER message should stop the frozen watcher",
    );
    assert(
      watcher.overlay().ui?.gameOver,
      "game-over screen should be painted",
    );
    assertEquals(
      watcher.banner(),
      null,
      "stale banner leaked onto the game-over screen",
    );
  },
);

function snapshotState(sc: Scenario): StateSnapshot {
  return {
    rngState: sc.state.rng.getState(),
    players: snapshotPlayers(sc),
  };
}

function snapshotPlayers(sc: Scenario): PlayerSnapshot[] {
  return sc.state.players.map((player) => ({
    id: player.id,
    lives: player.lives,
    walls: player.walls.size,
    cannons: player.cannons.length,
    enclosedTowers: player.enclosedTowers.length,
    score: player.score,
    currentPiece: player.currentPiece,
    bagQueueLen: player.bag ? player.bag.queue.length : null,
  }));
}

function assertStateConverges(
  actual: StateSnapshot,
  expected: StateSnapshot,
  label: string,
): void {
  assertEquals(
    actual.rngState,
    expected.rngState,
    `${label}: state.rng position diverged ` +
      `(actual=${actual.rngState} expected=${expected.rngState}) — ` +
      `parity break, downstream stochastic outcomes will desync`,
  );
  assertPlayersConverge(actual.players, expected.players, label);
}

function assertPlayersConverge(
  watcher: readonly PlayerSnapshot[],
  host: readonly PlayerSnapshot[],
  label: string,
): void {
  assertEquals(
    watcher.length,
    host.length,
    `${label}: player count diverged`,
  );
  for (let i = 0; i < host.length; i++) {
    assertEquals(
      watcher[i],
      host[i],
      `${label}: player ${i} state diverged`,
    );
  }
}
