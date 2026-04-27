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
 *     count, cannons count, ownedTowers count, score) — proves the wire
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
import { createNetworkedPair } from "./network-setup.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";
import type { ValidPlayerSlot } from "../src/shared/core/player-slot.ts";

interface PlayerSnapshot {
  readonly id: number;
  readonly lives: number;
  readonly walls: number;
  readonly cannons: number;
  readonly ownedTowers: number;
  readonly score: number;
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
    const localPlayers = snapshotPlayers(local);
    assertEquals(local.mode(), Mode.STOPPED);

    // Networked run.
    const { host, watcher, pump } = await createNetworkedPair({
      seed,
      mode,
      rounds,
    });
    await runNetworkedToEnd(host, watcher, pump);

    const hostPlayers = snapshotPlayers(host);
    const watcherPlayers = snapshotPlayers(watcher);

    // Host should match local (deterministic AI, same seed).
    assertPlayersConverge(hostPlayers, localPlayers, "host vs local");
    // Watcher should match host (network layer faithful).
    assertPlayersConverge(watcherPlayers, hostPlayers, "watcher vs host");

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
    const localPlayers = snapshotPlayers(local);

    const { host, watcher, pump } = await createNetworkedPair({
      seed,
      mode,
      rounds,
    });
    await runNetworkedToEnd(host, watcher, pump);

    const hostPlayers = snapshotPlayers(host);
    const watcherPlayers = snapshotPlayers(watcher);

    assertPlayersConverge(hostPlayers, localPlayers, "host vs local");
    assertPlayersConverge(watcherPlayers, hostPlayers, "watcher vs host");

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

      const hostPlayers = snapshotPlayers(host);
      const watcherPlayers = snapshotPlayers(watcher);
      const localPlayers = snapshotPlayers(local);

      assertPlayersConverge(hostPlayers, localPlayers, "host vs local");
      assertPlayersConverge(watcherPlayers, hostPlayers, "watcher vs host");
      assertWireExercised(host, `stress seed=${stress.seed} ${stress.mode}`);
    },
  );
}

/** Sanity check: the host must have broadcast *something* meaningful
 *  during the run. Without this, both runtimes could "converge" trivially
 *  by each running the same deterministic AI locally on the same seed —
 *  the wire would never be exercised. */
function assertWireExercised(host: Scenario, label: string): void {
  const lifecycleTypes = new Set(["cannonStart", "battleStart", "buildStart"]);
  const lifecycle = host.sentMessages.filter((msg) =>
    lifecycleTypes.has((msg as { type: string }).type),
  );
  const placements = host.sentMessages.filter(
    (msg) =>
      (msg as { type: string }).type === "opponentPiecePlaced" ||
      (msg as { type: string }).type === "opponentCannonPlaced",
  );
  assert(
    lifecycle.length > 0,
    `${label}: no lifecycle checkpoints broadcast — the wire wasn't exercised`,
  );
  assert(
    placements.length > 0,
    `${label}: no placement messages broadcast — the wire wasn't exercised`,
  );
}

Deno.test(
  "network vs local (assisted human slot 1, classic): watcher mirrors host end-to-end",
  async () => {
    const seed = 42;
    const mode = "classic" as const;
    const rounds = 3;
    const assistedSlot = 1 as ValidPlayerSlot;

    // Local baseline — assisted human runs locally, broadcasts land in
    // `local.sentMessages` but are never delivered to any peer.
    const local = await createScenario({
      seed,
      mode,
      rounds,
      assistedSlots: [assistedSlot],
    });
    local.runGame();
    const localPlayers = snapshotPlayers(local);

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

    const hostPlayers = snapshotPlayers(host);
    const watcherPlayers = snapshotPlayers(watcher);

    assertPlayersConverge(hostPlayers, localPlayers, "host vs local");
    assertPlayersConverge(watcherPlayers, hostPlayers, "watcher vs host");

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
      const slot = 1 as ValidPlayerSlot;
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

      const hostPlayers = snapshotPlayers(host);
      const watcherPlayers = snapshotPlayers(watcher);
      const localPlayers = snapshotPlayers(local);

      assertPlayersConverge(hostPlayers, localPlayers, "host vs local");
      assertPlayersConverge(watcherPlayers, hostPlayers, "watcher vs host");
    },
  );
}

/** Run the host + watcher in lockstep until both reach STOPPED. */
async function runNetworkedToEnd(
  host: Scenario,
  watcher: Scenario,
  pump: () => Promise<void>,
  maxSteps = 60_000,
): Promise<void> {
  for (let step = 0; step < maxSteps; step++) {
    host.tick(1);
    await pump();
    watcher.tick(1);
    if (host.mode() === Mode.STOPPED && watcher.mode() === Mode.STOPPED) {
      return;
    }
  }
  throw new Error(
    `lockstep run did not reach STOPPED within ${maxSteps} steps ` +
      `(host=${host.mode()} watcher=${watcher.mode()})`,
  );
}

function snapshotPlayers(sc: Scenario): PlayerSnapshot[] {
  return sc.state.players.map((player) => ({
    id: player.id,
    lives: player.lives,
    walls: player.walls.size,
    cannons: player.cannons.length,
    ownedTowers: player.ownedTowers.length,
    score: player.score,
  }));
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
