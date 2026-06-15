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
import {
  createBidirectionalNetworkedPair,
  createMigrationTrio,
  createNetworkedPair,
  type MigrationTrio,
  type NetworkedPair,
  type PlayerParitySnapshot,
  runNetworkedToEnd,
} from "./network-setup.ts";
import { DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS } from "../src/shared/core/action-schedule.ts";
import { BATTLE_COUNTDOWN } from "../src/shared/core/game-constants.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { PLAYER_NAMES } from "../src/shared/ui/player-config.ts";
import { createFullStateMessage } from "../src/online/online-serialize.ts";
import {
  type FullStateMessage,
  MESSAGE,
  type ServerMessage,
} from "../src/protocol/protocol.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";
import type { PieceShape } from "../src/shared/core/pieces.ts";

interface PlayerSnapshot extends PlayerParitySnapshot {
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

// ── FULL_STATE timer adoption on a running watcher ───────────────────
// At host migration the new host broadcasts a FULL_STATE captured at an
// arbitrary mid-phase moment. A running watcher must ADOPT the message's
// authoritative `state.timer` — its local accumulators have to be
// resynced, or the next `advancePhaseTimer` overwrites the restored
// timer with `max - localAccum` and the watcher's phase exit lands on a
// different tick than every other peer (transition-timing divergence).
Deno.test(
  "running watcher adopts FULL_STATE timer instead of reverting to its local accumulators",
  async () => {
    const { host, watcher, pump } = await createNetworkedPair({
      seed: 42,
      mode: "classic",
      rounds: 3,
    });

    // Run the pair in lockstep until both sit early in round 1's closing
    // WALL_BUILD with plenty of timer left. Mode.GAME matters: the phase
    // flips during the transition banner, but the build timer only ticks
    // once the display chain ends and mode returns to GAME.
    let steps = 0;
    while (
      !(
        host.state.phase === Phase.WALL_BUILD &&
        watcher.state.phase === Phase.WALL_BUILD &&
        host.mode() === Mode.GAME &&
        watcher.mode() === Mode.GAME &&
        host.state.timer > 10
      )
    ) {
      host.tick(1);
      watcher.tick(1);
      await pump();
      if (++steps > 60_000) {
        throw new Error("pair never reached WALL_BUILD with timer > 10");
      }
    }

    // Skew: advance the host alone ~2s deeper into the build phase (the
    // watcher stalls, modelling the lag that makes migration broadcast a
    // timer the receiving peer does not have locally).
    for (let i = 0; i < 120; i++) host.tick(1);
    assertEquals(
      host.state.phase,
      Phase.WALL_BUILD,
      "host must still be in WALL_BUILD after the skew",
    );
    const authoritativeTimer = host.state.timer;
    const watcherLocalTimer = watcher.state.timer;
    assert(
      watcherLocalTimer - authoritativeTimer > 1.5,
      `precondition: timers must differ (watcher=${watcherLocalTimer}, host=${authoritativeTimer})`,
    );

    // Deliver the migration-style FULL_STATE and tick the watcher once.
    await watcher.deliverMessage(
      createFullStateMessage(host.state, 1) as ServerMessage,
    );
    watcher.tick(1);

    const adopted = Math.abs(watcher.state.timer - authoritativeTimer) < 0.5;
    assert(
      adopted,
      `watcher must continue from the FULL_STATE timer (${authoritativeTimer.toFixed(2)}), ` +
        `not revert toward its local accumulator value (${watcherLocalTimer.toFixed(2)}); ` +
        `got ${watcher.state.timer.toFixed(2)}`,
    );
  },
);

// ── FULL_STATE mid-score-overlay must not double-fire the display chain ──
// At host migration every surviving peer adopts the new host's FULL_STATE
// (phase WALL_BUILD, timer 0 when the old host died inside a round-end
// display) and re-dispatches `round-end` on its next tick. When the apply
// lands while the peer's OWN score overlay is still ticking, the re-run's
// `scoreDelta.show()` must REPLACE the in-flight overlay (banner-style):
// keeping the stale continuation armed fires BOTH display chains — the
// stale one then routes `advance-to-cannon` from the phase the fresh chain
// already advanced, and the phase machine's source-phase guard throws.
Deno.test(
  "running watcher adopting FULL_STATE mid-score-overlay does not double-fire the display chain",
  async () => {
    const { host, watcher, pump } = await createNetworkedPair({
      seed: 42,
      mode: "classic",
      rounds: 3,
    });

    let overlayActive = false;
    watcher.bus.on(GAME_EVENT.SCORE_OVERLAY_START, () => {
      overlayActive = true;
    });
    watcher.bus.on(GAME_EVENT.SCORE_OVERLAY_END, () => {
      overlayActive = false;
    });

    // Run the pair in lockstep until the watcher sits mid score-overlay
    // (round-end display). The host is at the same lockstep moment, so its
    // state is the mid-overlay WALL_BUILD snapshot a freshly promoted host
    // would broadcast.
    let steps = 0;
    while (!overlayActive) {
      host.tick(1);
      watcher.tick(1);
      await pump();
      if (++steps > 60_000) {
        throw new Error("watcher never reached a score overlay");
      }
    }
    assertEquals(
      watcher.state.phase,
      Phase.WALL_BUILD,
      "precondition: round-end displays with the phase still at WALL_BUILD",
    );

    // Migration-style apply landing mid-overlay.
    await watcher.deliverMessage(
      createFullStateMessage(host.state, 1) as ServerMessage,
    );

    // The watcher re-runs round-end from the restored snapshot. Tick it
    // alone (the experiment forks it from the host) through the replacement
    // overlay and the life-lost step; a stale second continuation throws
    // the source-phase guard inside tick().
    let ticks = 0;
    while (watcher.state.phase === Phase.WALL_BUILD) {
      watcher.tick(1);
      if (++ticks > 60_000) {
        throw new Error("watcher never advanced past WALL_BUILD");
      }
    }
    // Run well past the original overlay's expiry so a stale continuation
    // (which fires when the OLD deltaTimer drains) gets its chance to blow.
    watcher.tick(1_200);
  },
);

Deno.test(
  "watcher promoted while the pick modal is open force-resolves picks and continues",
  async () => {
    await promoteWatcherMidUpgradePick(
      (watcher) => watcher.mode() === Mode.UPGRADE_PICK,
      "modal window",
    );
  },
);

Deno.test(
  "watcher promoted during the upgrade-pick entry banner force-resolves picks and continues",
  async () => {
    await promoteWatcherMidUpgradePick(
      (watcher) =>
        watcher.state.phase === Phase.UPGRADE_PICK &&
        watcher.mode() === Mode.TRANSITION,
      "banner window",
    );
  },
);

async function promoteWatcherMidUpgradePick(
  windowReached: (watcher: Scenario) => boolean,
  label: string,
): Promise<void> {
  const pair = await createNetworkedPair({
    seed: 42,
    mode: "modern",
    rounds: 6,
  });
  const { watcher } = pair;
  await runPairUntil(pair, () => windowReached(watcher), label);
  const pickRound = watcher.state.round;

  // Seat the watcher and kill the host: the server names this peer the
  // new host (production seats peers at room-join; the harness boots
  // directly, so the seat is assigned here).
  pair.watcherSession.myPlayerId = 0 as ValidPlayerId;
  const sentBefore = watcher.sentMessages.length;
  await watcher.deliverMessage({
    type: MESSAGE.HOST_LEFT,
    newHostPlayerId: 0 as ValidPlayerId,
    disconnectedPlayerId: null,
  } as ServerMessage);

  // Promotion must land past the pick phase, in a self-ticking state...
  assertEquals(
    Phase[watcher.state.phase],
    Phase[Phase.WALL_BUILD],
    `${label}: promotion must force-resolve the pick phase into WALL_BUILD`,
  );
  assertEquals(
    watcher.mode(),
    Mode.GAME,
    `${label}: promotion must land in Mode.GAME`,
  );
  // ...and the FULL_STATE broadcast must carry the repaired phase — a
  // snapshot parked in UPGRADE_PICK would stall every watcher applying it.
  const fullState = watcher.sentMessages
    .slice(sentBefore)
    .find((msg) => msg.type === MESSAGE.FULL_STATE) as
    | FullStateMessage
    | undefined;
  assert(fullState, `${label}: promotion must broadcast FULL_STATE`);
  assertEquals(
    fullState.phase,
    Phase[Phase.WALL_BUILD],
    `${label}: FULL_STATE must carry the repaired phase`,
  );

  // The promoted peer now runs the match alone — the round must close
  // (round-end increments state.round), proving WALL_BUILD ticks forward.
  let ticks = 0;
  while (
    watcher.state.round === pickRound &&
    watcher.mode() !== Mode.STOPPED
  ) {
    watcher.tick(1);
    if (++ticks > 60_000) {
      throw new Error(
        `${label}: stalled after promotion ` +
          `(phase=${Phase[watcher.state.phase]} mode=${watcher.mode()})`,
      );
    }
  }
}

// ── FULL_STATE adoption mid-pick must clear the local dialog ─────────
// A watcher sitting in its own pick modal when the new host's
// (post-repair, WALL_BUILD) snapshot lands must drop the dialog at apply
// time: the promotion force-resolved the picks into the snapshot, so the
// local dialog is superseded. Left in place, the dead modal paints over
// the adopted build phase (resolution callback armed but untickable —
// Mode.GAME never ticks it) until the NEXT checkpoint's stale-dialog
// dismissal in online-server-lifecycle.ts, which doesn't run for
// FULL_STATE itself. Same teardown contract as `lifeLost.set(null)` in
// `applyFullStateToRunningRuntime`.
Deno.test(
  "running watcher adopting FULL_STATE mid-upgrade-pick drops the stale dialog",
  async () => {
    const pair = await createNetworkedPair({
      seed: 42,
      mode: "modern",
      rounds: 6,
    });
    const { host, watcher } = pair;

    await runPairUntil(
      pair,
      () =>
        host.mode() === Mode.UPGRADE_PICK &&
        watcher.mode() === Mode.UPGRADE_PICK,
      "both peers mid-pick",
    );

    // The host alone resolves its picks and lands in the build phase —
    // its state is now the snapshot a freshly promoted host would
    // broadcast (promotion force-resolves the pick phase before sending).
    let ticks = 0;
    while (
      !(host.state.phase === Phase.WALL_BUILD && host.mode() === Mode.GAME)
    ) {
      host.tick(1);
      if (++ticks > 60_000) {
        throw new Error("host never resolved its pick dialog");
      }
    }

    // Migration-style apply on the still-mid-pick watcher.
    assert(
      pair.watcherUpgradePickDialog() !== null,
      "precondition: the watcher's pick modal must be open",
    );
    await watcher.deliverMessage(
      createFullStateMessage(host.state, 1) as ServerMessage,
    );

    assertEquals(
      Phase[watcher.state.phase],
      Phase[Phase.WALL_BUILD],
      "watcher must adopt the snapshot phase",
    );
    assertEquals(watcher.mode(), Mode.GAME);
    assertEquals(
      pair.watcherUpgradePickDialog(),
      null,
      "the apply must tear down the superseded pick dialog — a survivor " +
        "paints over the adopted phase until the next checkpoint dismissal",
    );

    // The adopted snapshot must tick forward on its own: the round closes
    // (round-end increments state.round) without any further host input.
    const adoptedRound = watcher.state.round;
    ticks = 0;
    while (
      watcher.state.round === adoptedRound &&
      watcher.mode() !== Mode.STOPPED
    ) {
      watcher.tick(1);
      if (++ticks > 60_000) {
        throw new Error(
          `watcher stalled after adoption ` +
            `(phase=${Phase[watcher.state.phase]} mode=${watcher.mode()})`,
        );
      }
    }
  },
);

// ── FULL_STATE adoption must reconcile the camera pitch ──────────────
// Pitch is per-peer local state, but it GATES sim dispatch: battle-done
// waits for the untilt ease to settle (phase-ticks), which is
// deterministic only because every peer runs the same tilt choreography
// from the same transitions. A snapshot apply skips that choreography —
// without the reconcile, a peer that adopts mid-battle sits flat where
// every other peer is tilted (and renders the battle untilted); the
// next battle-done gate then dispatches at different sim ticks per
// peer, splitting where in-flight applyAt actions land relative to the
// mutate.
Deno.test(
  "running watcher adopting a mid-battle FULL_STATE snaps pitch to tilted",
  async () => {
    const pair = await createNetworkedPair({ seed: 42, mode: "classic", rounds: 3 });
    const { host, watcher } = pair;

    await runPairUntil(
      pair,
      () =>
        host.state.phase === Phase.WALL_BUILD &&
        watcher.state.phase === Phase.WALL_BUILD &&
        host.mode() === Mode.GAME &&
        watcher.mode() === Mode.GAME,
      "both peers mid-build",
    );
    assertEquals(
      watcher.camera.getPitchState(),
      "flat",
      "precondition: build phase runs flat",
    );

    // Host alone advances into the next round's battle (its own
    // transition choreography tilts it); the watcher stays parked
    // mid-build, flat.
    let ticks = 0;
    while (
      !(host.state.phase === Phase.BATTLE && host.mode() === Mode.GAME)
    ) {
      host.tick(1);
      if (++ticks > 60_000) throw new Error("host never reached BATTLE");
    }
    assertEquals(
      host.camera.getPitchState(),
      "tilted",
      "precondition: the host's own battle runs tilted",
    );

    await watcher.deliverMessage(
      createFullStateMessage(host.state, 1) as ServerMessage,
    );
    assertEquals(
      watcher.camera.getPitchState(),
      "tilted",
      "adopting a mid-battle snapshot must snap pitch to the battle pose — " +
        "a flat peer passes the next battle-done untilt gate instantly " +
        "while every tilted peer takes the full ease",
    );
  },
);

Deno.test(
  "running watcher adopting a mid-build FULL_STATE snaps pitch to flat",
  async () => {
    const pair = await createNetworkedPair({ seed: 42, mode: "classic", rounds: 3 });
    const { host, watcher } = pair;

    await runPairUntil(
      pair,
      () =>
        host.state.phase === Phase.BATTLE &&
        watcher.state.phase === Phase.BATTLE &&
        host.mode() === Mode.GAME &&
        watcher.mode() === Mode.GAME,
      "both peers mid-battle",
    );
    assertEquals(
      watcher.camera.getPitchState(),
      "tilted",
      "precondition: both peers tilted in battle",
    );

    // Host alone finishes the battle (untilting through its own
    // battle-done gate) and enters the build phase; the watcher stays
    // parked mid-battle, tilted.
    let ticks = 0;
    while (
      !(host.state.phase === Phase.WALL_BUILD && host.mode() === Mode.GAME)
    ) {
      host.tick(1);
      if (++ticks > 60_000) throw new Error("host never reached WALL_BUILD");
    }
    assertEquals(
      host.camera.getPitchState(),
      "flat",
      "precondition: the host untilted through its own battle-done",
    );

    await watcher.deliverMessage(
      createFullStateMessage(host.state, 1) as ServerMessage,
    );
    assertEquals(
      watcher.camera.getPitchState(),
      "flat",
      "adopting a mid-build snapshot must snap pitch flat — a tilted peer " +
        "spends untilt ease ticks at the next gate that no other peer spends",
    );
  },
);

Deno.test(
  "watcher promoted during the battle banner/tilt window begins the battle",
  async () => {
    await promoteWatcherDuringBattleIntro(
      (watcher) =>
        watcher.state.phase === Phase.BATTLE &&
        watcher.mode() === Mode.TRANSITION,
      "banner/tilt window",
      42,
    );
  },
);

Deno.test(
  "watcher promoted during the balloon flyover begins the battle",
  async () => {
    // Seed 1: a propaganda-balloon capture (the only producer of
    // balloon flights) resolves at round 4's battle entry. If AI
    // retuning drifts it, re-scan seeds for `mode() === BALLOON_ANIM`.
    await promoteWatcherDuringBattleIntro(
      (watcher) => watcher.mode() === Mode.BALLOON_ANIM,
      "balloon window",
      1,
    );
  },
);

async function promoteWatcherDuringBattleIntro(
  windowReached: (watcher: Scenario) => boolean,
  label: string,
  seed: number,
): Promise<void> {
  const pair = await createNetworkedPair({
    seed,
    mode: "classic",
    rounds: 6,
  });
  const { watcher } = pair;
  await runPairUntil(pair, () => windowReached(watcher), label);
  const promoteRound = watcher.state.round;

  pair.watcherSession.myPlayerId = 0 as ValidPlayerId;
  await watcher.deliverMessage({
    type: MESSAGE.HOST_LEFT,
    newHostPlayerId: 0 as ValidPlayerId,
    disconnectedPlayerId: null,
  } as ServerMessage);

  assertEquals(
    watcher.mode(),
    Mode.GAME,
    `${label}: promotion must land in Mode.GAME`,
  );
  assertEquals(
    watcher.state.battleCountdown,
    BATTLE_COUNTDOWN,
    `${label}: the repair must run beginBattle — without it the battle ` +
      "starts with no ready countdown (and no battleReady cue)",
  );
  assertEquals(
    watcher.camera.getPitchState(),
    "tilted",
    `${label}: the battle must run at the battle pose on the promoted peer`,
  );

  // The promoted peer runs the match alone — the battle must conclude
  // and the round close (round-end increments state.round).
  let ticks = 0;
  while (
    watcher.state.round === promoteRound &&
    watcher.mode() !== Mode.STOPPED
  ) {
    watcher.tick(1);
    if (++ticks > 60_000) {
      throw new Error(
        `${label}: stalled after promotion ` +
          `(phase=${Phase[watcher.state.phase]} mode=${watcher.mode()})`,
      );
    }
  }
}

// ── Two-survivor migration parity ────────────────────────────────────
// Host migration with a SECOND surviving watcher: post-migration, the
// promoted peer and the kept-controller watcher must keep playing the
// same game. AI identity is a cross-peer contract — if the promoted host
// re-derives AI rngs/personalities while the watcher keeps its
// state.rng-backed controllers, their decision streams differ AND the
// watcher keeps consuming shared-stream draws the host no longer makes,
// so every later stochastic outcome desyncs with no reconciliation
// (phase markers are ignored under clone-everywhere). The one-survivor
// promote tests above structurally can't see this — they run the
// promoted peer alone.
Deno.test(
  "host migration with a second surviving watcher: both survivors stay in parity",
  async () => {
    const trio = await createMigrationTrio({
      seed: 42,
      mode: "classic",
      rounds: 4,
    });
    const { host, promotable, observer, pumpHost, pumpPromoted } = trio;

    // Lockstep all three machines to a mid-build moment in round 2 —
    // brains mid-plan, so the migration lands in a live window.
    let steps = 0;
    while (
      !(
        host.state.round === 2 &&
        host.state.phase === Phase.WALL_BUILD &&
        host.mode() === Mode.GAME
      )
    ) {
      host.tick(1);
      await pumpHost();
      promotable.tick(1);
      observer.tick(1);
      if (host.mode() === Mode.STOPPED) {
        throw new Error("game ended before the migration window");
      }
      if (++steps > 120_000) {
        throw new Error("migration window never reached");
      }
    }

    // Kill the host: seat + promote one watcher; the other only learns
    // the host changed. Production message order — HOST_LEFT reaches
    // every peer before the new host's FULL_STATE exists.
    trio.promotableSession.myPlayerId = 0 as ValidPlayerId;
    const sentBefore = promotable.sentMessages.length;
    const hostLeft = {
      type: MESSAGE.HOST_LEFT,
      newHostPlayerId: 0 as ValidPlayerId,
      disconnectedPlayerId: null,
    } as ServerMessage;
    await promotable.deliverMessage(hostLeft);
    await observer.deliverMessage(hostLeft);
    assert(
      promotable.sentMessages
        .slice(sentBefore)
        .some((msg) => msg.type === MESSAGE.FULL_STATE),
      "promotion must broadcast FULL_STATE",
    );
    await pumpPromoted();

    // Both survivors run to game end, promoted-peer broadcasts flowing.
    await runNetworkedToEnd(promotable, observer, pumpPromoted);

    assertStateConverges(
      snapshotState(observer),
      snapshotState(promotable),
      "observer vs promoted host",
    );
  },
);

// ── Skewed adoption: strategy transients ─────────────────────────────
// Same trio topology, but the observer's sim runs PAST the snapshot
// before adopting it — the production shape, where the FULL_STATE
// arrives a wire-delay late and the apply rewinds GameState to the
// snapshot tick. Anything that ticked past the snapshot locally and is
// NOT in the snapshot re-diverges the match after an otherwise clean
// adoption. This test pinned three such survivors when written red:
// strategy/brain transients (lastTargetTowerIndex feeds the next build
// pick verbatim via planEnclosureTarget's anti-churn short-circuit →
// wiped by ctrl.reset() in the re-prime), the cross-phase grunt step
// clock (accum.grunt → now rides FullStateMessage.gruntAccum; kept, it
// stepped grunts at different ticks and deadlocked the round-end
// dialogs), and the piece bags (queue + currentPiece are past rng draws
// → re-dealt symmetrically at adoption). Promote mid-build and give the
// observer a ~3s head start (a few placements + grunt steps) before it
// adopts.
Deno.test(
  "host migration adopted with sim-tick skew: survivors stay in parity",
  async () => {
    const trio = await createMigrationTrio({
      seed: 7,
      mode: "classic",
      rounds: 4,
    });
    const { host, promotable, observer, pumpHost, pumpPromoted } = trio;

    // Lockstep all three to round 2's build, then ~1.5s further in so
    // the AIs are mid-plan with live pick cursors.
    let steps = 0;
    while (
      !(
        host.state.round === 2 &&
        host.state.phase === Phase.WALL_BUILD &&
        host.mode() === Mode.GAME
      )
    ) {
      host.tick(1);
      await pumpHost();
      promotable.tick(1);
      observer.tick(1);
      if (host.mode() === Mode.STOPPED) {
        throw new Error("game ended before the migration window");
      }
      if (++steps > 120_000) {
        throw new Error("migration window never reached");
      }
    }
    for (let i = 0; i < 90; i++) {
      host.tick(1);
      await pumpHost();
      promotable.tick(1);
      observer.tick(1);
    }

    // Promote one watcher now; its FULL_STATE freezes this tick.
    trio.promotableSession.myPlayerId = 0 as ValidPlayerId;
    const hostLeft = {
      type: MESSAGE.HOST_LEFT,
      newHostPlayerId: 0 as ValidPlayerId,
      disconnectedPlayerId: null,
    } as ServerMessage;
    await promotable.deliverMessage(hostLeft);

    // Wire delay: the observer keeps simulating ~3s past the snapshot
    // (fires land, transients mutate) before the migration reaches it.
    observer.tick(180);
    await observer.deliverMessage(hostLeft);
    await pumpPromoted();

    await runNetworkedToEnd(promotable, observer, pumpPromoted);

    assertStateConverges(
      snapshotState(observer),
      snapshotState(promotable),
      "skewed observer vs promoted host",
    );
  },
);

// ── Adoption in the battle-done untilt window ────────────────────────
// battle-done gates on the camera untilt settling flat — deterministic
// because every peer starts the ease at the same gate tick. A FULL_STATE
// landing mid-untilt snaps adopters to the settled battle pose
// (snapPitchToPhase maps BATTLE → "tilted"), so they restart the full
// 0.6s ease — while a promoted host keeping its partial ease settles
// (and dispatches battle-done) earlier. The next phase's timer then
// primes at offset sim ticks on each survivor: a permanent
// phase-boundary skew. The promoted host must snap to the same settled
// pose before serializing so every peer restarts the ease together.
Deno.test(
  "host migration during the battle-done untilt keeps the build-entry tick aligned",
  async () => {
    const trio = await createMigrationTrio({
      seed: 42,
      mode: "classic",
      rounds: 4,
    });
    const { host, promotable, observer, pumpHost, pumpPromoted } = trio;

    // Lockstep all three until the promotable sits inside the battle-done
    // untilt window (battle resolved, camera easing back toward flat).
    let steps = 0;
    while (
      !(
        promotable.state.phase === Phase.BATTLE &&
        promotable.mode() === Mode.GAME &&
        promotable.camera.getPitchState() === "untilting"
      )
    ) {
      host.tick(1);
      await pumpHost();
      promotable.tick(1);
      observer.tick(1);
      if (host.mode() === Mode.STOPPED) {
        throw new Error("game ended before the untilt window");
      }
      if (++steps > 200_000) {
        throw new Error("untilt window never reached");
      }
    }
    // Advance ~15 ticks INTO the 0.6s (~36-tick) ease so the promoted
    // peer holds a meaningful partial ease at the snapshot — the skew a
    // kept ease produces equals the elapsed portion, and a 1-tick-old
    // ease would make this test green-by-luck against an off-by-one.
    for (let i = 0; i < 15; i++) {
      host.tick(1);
      await pumpHost();
      promotable.tick(1);
      observer.tick(1);
    }
    assertEquals(
      promotable.camera.getPitchState(),
      "untilting",
      "staging: the promotable must still be mid-untilt at the migration",
    );

    // Capture each survivor's sim tick at its next build-phase entry —
    // the observable that pins the battle-done dispatch alignment.
    let promotedBuildTick: number | null = null;
    let observerBuildTick: number | null = null;
    promotable.bus.on(GAME_EVENT.PHASE_START, (ev) => {
      if (ev.phase === Phase.WALL_BUILD && promotedBuildTick === null) {
        promotedBuildTick = promotable.state.simTick;
      }
    });
    observer.bus.on(GAME_EVENT.PHASE_START, (ev) => {
      if (ev.phase === Phase.WALL_BUILD && observerBuildTick === null) {
        observerBuildTick = observer.state.simTick;
      }
    });

    // Kill the host mid-untilt; both watchers learn at the same tick.
    trio.promotableSession.myPlayerId = 0 as ValidPlayerId;
    const hostLeft = {
      type: MESSAGE.HOST_LEFT,
      newHostPlayerId: 0 as ValidPlayerId,
      disconnectedPlayerId: null,
    } as ServerMessage;
    await promotable.deliverMessage(hostLeft);
    await observer.deliverMessage(hostLeft);
    await pumpPromoted();

    let ticks = 0;
    while (promotedBuildTick === null || observerBuildTick === null) {
      promotable.tick(1);
      await pumpPromoted();
      observer.tick(1);
      if (++ticks > 30_000) {
        throw new Error(
          `build phase never reached after migration ` +
            `(promoted=${Phase[promotable.state.phase]} ` +
            `observer=${Phase[observer.state.phase]})`,
        );
      }
    }
    assertEquals(
      observerBuildTick,
      promotedBuildTick,
      "both survivors must dispatch battle-done (and prime the build " +
        "timer) at the same sim tick — a mid-untilt adoption must not " +
        "restart the ease on one peer only",
    );
  },
);

// ── Promotion fast-forward into a reselect cycle ─────────────────────
// A promotion landing in the round-end display chain fast-forwards it
// (resolveRoundEndNow); when the routing enters a reselect cycle, the
// AI selection arming draws state.rng (chooseBestTower + browse plan +
// delays) BEFORE the FULL_STATE serialize — so the snapshot carries the
// post-draw cursor. An adopter parked in its OWN round-end display
// never entered the cycle locally; its adoption entry re-runs the same
// arming AFTER applying, drawing again from the already-advanced
// cursor: a one-sided rng fork in every reselect with an AI seat. The
// serialize-first/draw-after contract requires every peer to draw the
// arming from the snapshot cursor — the promoted host re-arms
// post-serialize, adopters at the entry/re-arm — superseding any
// pre-serialize draws.
Deno.test(
  "promotion fast-forwarded into a reselect keeps survivors in rng parity",
  async () => {
    // Seed 0 classic reaches a reselect cycle (see seed-fixtures.json
    // "selection:reselect-cycle") — its round-end shows the life-lost
    // dialog. If AI retuning drifts it, re-scan for LIFE_LOST_DIALOG_SHOW.
    const trio = await createMigrationTrio({
      seed: 0,
      mode: "classic",
      rounds: 12,
    });
    const { host, promotable, observer, pumpHost, pumpPromoted } = trio;

    // Lockstep all three until the promotable is parked in the life-lost
    // dialog (round-end display chain; reselect entries pending).
    let steps = 0;
    while (promotable.mode() !== Mode.LIFE_LOST) {
      host.tick(1);
      await pumpHost();
      promotable.tick(1);
      observer.tick(1);
      if (host.mode() === Mode.STOPPED) {
        throw new Error("game ended before a life-lost dialog window");
      }
      if (++steps > 200_000) {
        throw new Error("life-lost dialog window never reached");
      }
    }

    trio.promotableSession.myPlayerId = 0 as ValidPlayerId;
    const hostLeft = {
      type: MESSAGE.HOST_LEFT,
      newHostPlayerId: 0 as ValidPlayerId,
      disconnectedPlayerId: null,
    } as ServerMessage;
    await promotable.deliverMessage(hostLeft);
    await observer.deliverMessage(hostLeft);
    await pumpPromoted();

    // Sanity: the fast-forward routed into the reselect cycle and the
    // observer adopted it (it was parked in its own dialog — the
    // never-entered-locally shape).
    assertEquals(Phase[promotable.state.phase], Phase[Phase.CASTLE_SELECT]);
    assertEquals(Phase[observer.state.phase], Phase[Phase.CASTLE_SELECT]);

    // Run the survivors through the reselect and the following round —
    // the double-drawn arming forks the shared cursor immediately, and
    // the diverged castle plans/walls follow.
    for (let i = 0; i < 3600; i++) {
      promotable.tick(1);
      await pumpPromoted();
      observer.tick(1);
      if (
        promotable.mode() === Mode.STOPPED &&
        observer.mode() === Mode.STOPPED
      ) {
        break;
      }
    }
    assertStateConverges(
      snapshotState(observer),
      snapshotState(promotable),
      "observer vs promoted host after reselect fast-forward",
    );
  },
);

// Skewed flavor of the same window: the observer's sim runs PAST the
// snapshot — it resolves its own round-end dialog locally, enters the
// reselect, and its AI brains browse (possibly confirm) before the
// migration reaches it. The adoption rewinds GameState to the snapshot,
// but kept brains sit at this peer's local browse progress and a local
// confirm the adopted timeline hasn't reached would stay flagged — the
// seat skips re-confirming here while every other peer replays it. The
// apply must re-derive confirmed flags from adopted state (both ways)
// and re-draw the unconfirmed seats' arming from the snapshot cursor.
Deno.test(
  "reselect adopted with sim-tick skew: survivors stay in rng parity",
  async () => {
    const trio = await createMigrationTrio({
      seed: 0,
      mode: "classic",
      rounds: 12,
    });
    const { host, promotable, observer, pumpHost, pumpPromoted } = trio;

    let steps = 0;
    while (promotable.mode() !== Mode.LIFE_LOST) {
      host.tick(1);
      await pumpHost();
      promotable.tick(1);
      observer.tick(1);
      if (host.mode() === Mode.STOPPED) {
        throw new Error("game ended before a life-lost dialog window");
      }
      if (++steps > 200_000) {
        throw new Error("life-lost dialog window never reached");
      }
    }

    // Promote now; the FULL_STATE freezes this tick (mid-dialog →
    // fast-forwarded into the reselect entry).
    trio.promotableSession.myPlayerId = 0 as ValidPlayerId;
    const hostLeft = {
      type: MESSAGE.HOST_LEFT,
      newHostPlayerId: 0 as ValidPlayerId,
      disconnectedPlayerId: null,
    } as ServerMessage;
    await promotable.deliverMessage(hostLeft);

    // Wire delay: the observer keeps simulating — it resolves its own
    // dialog, enters the reselect locally, and browses ~1.5s past it —
    // before the migration reaches it.
    let obsTicks = 0;
    while (observer.state.phase !== Phase.CASTLE_SELECT) {
      observer.tick(1);
      if (++obsTicks > 3000) {
        throw new Error("observer never entered the reselect locally");
      }
    }
    observer.tick(90);
    await observer.deliverMessage(hostLeft);
    await pumpPromoted();
    assertEquals(Phase[observer.state.phase], Phase[Phase.CASTLE_SELECT]);

    for (let i = 0; i < 3600; i++) {
      promotable.tick(1);
      await pumpPromoted();
      observer.tick(1);
      if (
        promotable.mode() === Mode.STOPPED &&
        observer.mode() === Mode.STOPPED
      ) {
        break;
      }
    }

    // Align sim-ticks before snapshotting. Cross-peer parity is defined at
    // sim-tick granularity, not wall-frame granularity: the main loop
    // converts each wall-frame into fixed sim-steps via a time accumulator
    // whose fractional residue is peer-local (frame-rate independence). The
    // observer's wire-delay skew (`observer.tick(90)`) gave it a different
    // residue than the promoted host, so their catch-up sim-steps land on
    // different wall-frames — a same-wall-frame snapshot can sample the two
    // peers up to one sim-tick apart (here the observer trails by one). That
    // is benign in production (each sim tick is identical regardless of which
    // RAF frame runs it; two browsers always carry independent residues), but
    // it breaks a byte-exact same-frame compare. Run the trailing peer the
    // extra tick(s) so both stand on the same simTick, then assert.
    let alignGuard = 0;
    while (
      promotable.state.simTick !== observer.state.simTick &&
      alignGuard++ < 600
    ) {
      if (promotable.state.simTick < observer.state.simTick) {
        promotable.tick(1);
        await pumpPromoted();
      } else {
        observer.tick(1);
      }
    }
    assertStateConverges(
      snapshotState(observer),
      snapshotState(promotable),
      "skewed observer vs promoted host after reselect adoption",
    );
  },
);

// ── Adoption mid castle-build animation ──────────────────────────────
// The FULL_STATE apply wipes `selection.castleBuilds` (runtime-local
// animation queue), and the only producer is the confirm apply — so an
// adoption landing while a confirmed player's ring is still animating
// orphans that ring on the adopter: the walls stop placing, the player
// never gains territory, and the adopter's selection brain re-confirms
// the seat (its reconcile predicate missed mid-build confirms), redrawing
// the castle plan from state.rng on one peer only. The apply must
// re-derive the in-flight builds from adopted state (castleWallTiles
// minus walls) on every peer — the promoted host included, so the
// re-started animations place walls at the same sim ticks everywhere.
Deno.test(
  "host migration mid castle-build animation re-queues the ring on every survivor",
  async () => {
    const trio = await createMigrationTrio({
      seed: 42,
      mode: "classic",
      rounds: 4,
    });
    const { host, promotable, observer, pumpHost, pumpPromoted } = trio;

    // Lockstep all three until a player's ring is mid-animation on the
    // promotable: plan committed (castleWallTiles seeded at confirm) but
    // not yet fully placed.
    const midBuild = () =>
      promotable.state.players.some(
        (player) =>
          player.castleWallTiles.size > 0 &&
          [...player.castleWallTiles].some((tile) => !player.walls.has(tile)),
      );
    let steps = 0;
    while (
      !(
        promotable.state.phase === Phase.CASTLE_SELECT &&
        promotable.mode() === Mode.SELECTION &&
        midBuild()
      )
    ) {
      host.tick(1);
      await pumpHost();
      promotable.tick(1);
      observer.tick(1);
      if (host.mode() === Mode.STOPPED) {
        throw new Error("game ended before the castle-build window");
      }
      if (++steps > 200_000) {
        throw new Error("castle-build window never reached");
      }
    }

    // Capture each survivor's sim tick at the cannon-phase entry — the
    // cycle exits only when every ring completes, so a dropped or
    // restarted-on-one-peer ring shows up here.
    let promotedCannonTick: number | null = null;
    let observerCannonTick: number | null = null;
    promotable.bus.on(GAME_EVENT.PHASE_START, (ev) => {
      if (ev.phase === Phase.CANNON_PLACE && promotedCannonTick === null) {
        promotedCannonTick = promotable.state.simTick;
      }
    });
    observer.bus.on(GAME_EVENT.PHASE_START, (ev) => {
      if (ev.phase === Phase.CANNON_PLACE && observerCannonTick === null) {
        observerCannonTick = observer.state.simTick;
      }
    });

    trio.promotableSession.myPlayerId = 0 as ValidPlayerId;
    const hostLeft = {
      type: MESSAGE.HOST_LEFT,
      newHostPlayerId: 0 as ValidPlayerId,
      disconnectedPlayerId: null,
    } as ServerMessage;
    await promotable.deliverMessage(hostLeft);
    await observer.deliverMessage(hostLeft);
    await pumpPromoted();

    let ticks = 0;
    while (promotedCannonTick === null || observerCannonTick === null) {
      promotable.tick(1);
      await pumpPromoted();
      observer.tick(1);
      if (++ticks > 30_000) {
        throw new Error(
          `cannon phase never reached after mid-build migration ` +
            `(promoted=${Phase[promotable.state.phase]} ` +
            `observer=${Phase[observer.state.phase]})`,
        );
      }
    }
    assertEquals(
      observerCannonTick,
      promotedCannonTick,
      "both survivors must finish the adopted castle builds and enter " +
        "CANNON_PLACE at the same sim tick",
    );

    // The orphaned-ring re-confirm also redrew the castle plan from
    // state.rng on the adopter only — run the survivors out and assert
    // full parity.
    await runNetworkedToEnd(promotable, observer, pumpPromoted);
    assertStateConverges(
      snapshotState(observer),
      snapshotState(promotable),
      "observer vs promoted host after mid-castle-build migration",
    );
  },
);

// ── Adoption in the cannon-banner window: self-human prime ───────────
// A FULL_STATE landing while the adopting peer is mid enter-cannon-place
// banner sweep tears the banner down (hideBanner), dropping the armed
// postDisplay that runs `initLocalCannonControllers`. AI slots recover
// via `reprimeAiControllersForPhase`, but that covers kind "ai" only —
// the peer's OWN seat (kind "human") must be primed by the apply itself,
// the same self-repair the promoted host runs in promote.ts. Un-primed,
// the seat keeps last round's exhausted cannon plan + stale cursor: the
// assisted-human stand-in (kind "human", AI brain) places nothing for
// the whole phase. Written red against the missing prime.
Deno.test(
  "FULL_STATE landing in the cannon-banner window primes the adopting peer's own seat",
  async () => {
    const pair = await createBidirectionalNetworkedPair({
      seed: 42,
      mode: "classic",
      rounds: 4,
      assistedSlotsHost: [],
      assistedSlotsWatcher: [1 as ValidPlayerId],
    });
    const { host, watcher, pump } = pair;

    // Lockstep both peers into round 2's enter-cannon-place banner sweep.
    let steps = 0;
    while (
      !(
        watcher.state.round === 2 &&
        watcher.state.phase === Phase.CANNON_PLACE &&
        watcher.mode() === Mode.TRANSITION
      )
    ) {
      host.tick(1);
      watcher.tick(1);
      await pump();
      if (host.mode() === Mode.STOPPED) {
        throw new Error("game ended before the cannon banner window");
      }
      if (++steps > 120_000) {
        throw new Error("cannon banner window never reached");
      }
    }

    const cannonsBefore = watcher.state.players[1]!.cannons.length;

    // A migration snapshot lands mid-sweep: serialize the lockstep host's
    // state at this tick and deliver it through the production receive
    // path (lifecycle FULL_STATE → applyFullStateToRunningRuntime).
    await watcher.deliverMessage(
      createFullStateMessage(host.state, 1) as ServerMessage,
    );
    assertEquals(
      watcher.mode(),
      Mode.GAME,
      "adoption must land in Mode.GAME (banner skipped)",
    );

    // The primed seat plans + places this round's cannons; run the
    // adopting peer to the end of its cannon phase and count them.
    let ticks = 0;
    while (watcher.state.phase === Phase.CANNON_PLACE) {
      host.tick(1);
      watcher.tick(1);
      await pump();
      if (++ticks > 30_000) {
        throw new Error("cannon phase never ended after adoption");
      }
    }
    const placed = watcher.state.players[1]!.cannons.length - cannonsBefore;
    assert(
      placed > 0,
      `the adopting peer's own seat must place cannons after a mid-banner ` +
        `adoption (placed=${placed})`,
    );
  },
);

Deno.test(
  "seat takeover: PLAYER_LEFT spread across a phase entry keeps peers in parity",
  async () => {
    const pair = await createBidirectionalNetworkedPair({
      seed: 42,
      mode: "classic",
      rounds: 3,
      assistedSlotsHost: [],
      assistedSlotsWatcher: [],
      extraRemoteSlots: [1 as ValidPlayerId],
    });
    const { host, watcher, pump } = pair;

    // Lockstep into round 1's BATTLE with the timer nearly out (the
    // phantom seat is guaranteed alive there; an AFK seat can be ground
    // down to elimination within a round or two, and eliminated slots
    // skip phase-init on every peer, hiding the race) — the
    // next boundary (WALL_BUILD entry, controller init in its mutate) is
    // ticks away. The phantom seat's round-1 selection confirm is
    // delivered by the stepper, as its absent machine would have.
    await runBidirPairUntil(
      pair,
      1 as ValidPlayerId,
      () =>
        watcher.state.round === 1 &&
        watcher.state.phase === Phase.BATTLE &&
        watcher.state.timer > 0 &&
        watcher.state.timer < 0.5,
    );

    // The leave reaches the HOST before the build entry...
    await host.deliverMessage({
      type: MESSAGE.PLAYER_LEFT,
      playerId: 1 as ValidPlayerId,
    } as ServerMessage);

    // ...and the WATCHER only well after it (exaggerated arrival spread).
    let steps = 0;
    while (watcher.state.phase !== Phase.WALL_BUILD) {
      host.tick(1);
      watcher.tick(1);
      await pump();
      if (++steps > 30_000) throw new Error("build entry never reached");
    }
    for (let i = 0; i < 30; i++) {
      host.tick(1);
      watcher.tick(1);
      await pump();
    }
    await watcher.deliverMessage({
      type: MESSAGE.PLAYER_LEFT,
      playerId: 1 as ValidPlayerId,
    } as ServerMessage);

    await runBidirPairUntil(
      pair,
      1 as ValidPlayerId,
      () => host.mode() === Mode.STOPPED && watcher.mode() === Mode.STOPPED,
    );

    // The takeover must actually have happened — a pair that never flips
    // the seat anywhere also "converges".
    assert(
      !pair.hostSession.remotePlayerSlots.has(1 as ValidPlayerId) &&
        !pair.watcherSession.remotePlayerSlots.has(1 as ValidPlayerId),
      "both peers must have handed the departed seat to local AI",
    );
    assertStateConverges(
      snapshotState(watcher),
      snapshotState(host),
      "watcher vs host after spread PLAYER_LEFT",
    );
  },
);

Deno.test(
  "seat takeover: host dying before stamping the flip — promoted host re-issues it",
  async () => {
    const trio = await createMigrationTrio({
      seed: 42,
      mode: "classic",
      rounds: 3,
      extraRemoteSlots: [2 as ValidPlayerId],
    });
    const { promotable, observer, pumpPromoted } = trio;

    await runTrioUntil(
      trio,
      2 as ValidPlayerId,
      () =>
        promotable.state.round === 1 &&
        promotable.state.phase === Phase.WALL_BUILD &&
        promotable.mode() === Mode.GAME,
    );

    // The leaver's PLAYER_LEFT reaches the promotable BEFORE the
    // migration, the observer only AFTER it adopted the FULL_STATE — the
    // exact spread that made the adoption re-prime asymmetric (3 brains
    // on one survivor, 2 on the other) under the wall-clock flip.
    await promotable.deliverMessage({
      type: MESSAGE.PLAYER_LEFT,
      playerId: 2 as ValidPlayerId,
    } as ServerMessage);

    trio.promotableSession.myPlayerId = 0 as ValidPlayerId;
    const hostLeft = {
      type: MESSAGE.HOST_LEFT,
      newHostPlayerId: 0 as ValidPlayerId,
      disconnectedPlayerId: null,
    } as ServerMessage;
    await promotable.deliverMessage(hostLeft);
    await observer.deliverMessage(hostLeft);
    await pumpPromoted();
    await observer.deliverMessage({
      type: MESSAGE.PLAYER_LEFT,
      playerId: 2 as ValidPlayerId,
    } as ServerMessage);

    await runSurvivorsToEnd(trio, 2 as ValidPlayerId);

    assert(
      !trio.promotableSession.remotePlayerSlots.has(2 as ValidPlayerId) &&
        !trio.observerSession.remotePlayerSlots.has(2 as ValidPlayerId),
      "both survivors must have handed the departed seat to local AI",
    );
    assertStateConverges(
      snapshotState(observer),
      snapshotState(promotable),
      "observer vs promoted host after re-issued takeover",
    );
  },
);

Deno.test(
  "seat takeover: flip already inside the snapshot — adoption reconciles the lagging peer",
  async () => {
    const trio = await createMigrationTrio({
      seed: 42,
      mode: "classic",
      rounds: 3,
      extraRemoteSlots: [2 as ValidPlayerId],
    });
    const { host, promotable, observer, pumpHost, pumpPromoted } = trio;

    await runTrioUntil(
      trio,
      2 as ValidPlayerId,
      () =>
        promotable.state.round === 1 &&
        promotable.state.phase === Phase.WALL_BUILD &&
        promotable.mode() === Mode.GAME,
    );

    // The live host stamped the flip (hand-delivered here — the trio's
    // one-way host has no handler), every peer scheduled it...
    const playerLeft = {
      type: MESSAGE.PLAYER_LEFT,
      playerId: 2 as ValidPlayerId,
    } as ServerMessage;
    await promotable.deliverMessage(playerLeft);
    await observer.deliverMessage(playerLeft);
    const takeover = {
      type: MESSAGE.SEAT_TAKEOVER,
      playerId: 2 as ValidPlayerId,
      applyAt:
        promotable.state.simTick + DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS,
    } as ServerMessage;
    await promotable.deliverMessage(takeover);
    await observer.deliverMessage(takeover);

    // ...but only the promotable's sim reaches the stamped tick before
    // the migration — the observer lags behind it (wire-delay skew). Its
    // queued flip is then discarded by the adoption (applyAt <= snapshot
    // tick), so the apply's reconcile must flip the slot sets instead.
    for (let i = 0; i < 12; i++) {
      host.tick(1);
      await pumpHost();
      promotable.tick(1);
    }
    assert(
      !trio.promotableSession.remotePlayerSlots.has(2 as ValidPlayerId),
      "precondition: the promotable's flip must have fired before promotion",
    );

    trio.promotableSession.myPlayerId = 0 as ValidPlayerId;
    const hostLeft = {
      type: MESSAGE.HOST_LEFT,
      newHostPlayerId: 0 as ValidPlayerId,
      disconnectedPlayerId: null,
    } as ServerMessage;
    await promotable.deliverMessage(hostLeft);
    await observer.deliverMessage(hostLeft);
    await pumpPromoted();

    assert(
      !trio.observerSession.remotePlayerSlots.has(2 as ValidPlayerId),
      "the adoption reconcile must flip the already-snapshotted takeover",
    );

    await runSurvivorsToEnd(trio, 2 as ValidPlayerId);
    assertStateConverges(
      snapshotState(observer),
      snapshotState(promotable),
      "lagging observer vs promoted host after reconciled takeover",
    );
  },
);

/** Lockstep the bidirectional pair until `predicate`, hand-confirming the
 *  phantom seat's selection whenever a CASTLE_SELECT cycle starts. */
async function runBidirPairUntil(
  pair: Awaited<ReturnType<typeof createBidirectionalNetworkedPair>>,
  seat: ValidPlayerId,
  predicate: () => boolean,
  maxSteps = 200_000,
): Promise<void> {
  let confirmed = false;
  for (let step = 0; step < maxSteps; step++) {
    if (predicate()) return;
    const selecting =
      pair.watcher.state.phase === Phase.CASTLE_SELECT &&
      pair.watcher.mode() === Mode.SELECTION;
    if (selecting && !confirmed) {
      await confirmPhantomSeat([pair.host, pair.watcher], seat);
    }
    confirmed = selecting;
    pair.host.tick(1);
    pair.watcher.tick(1);
    await pair.pump();
  }
  throw new Error("runPairUntil: predicate never satisfied");
}

/** Lockstep all three trio machines until `predicate`, hand-confirming
 *  the phantom seat's selection on both watchers per CASTLE_SELECT cycle.
 *  The one-way host plays the phantom seat as local AI (it has no
 *  message handler — see buildHostRuntime) and is allowed to drift; the
 *  window predicate must read the promotable's state. */
async function runTrioUntil(
  trio: MigrationTrio,
  seat: ValidPlayerId,
  predicate: () => boolean,
  maxSteps = 200_000,
): Promise<void> {
  let confirmed = false;
  for (let step = 0; step < maxSteps; step++) {
    if (predicate()) return;
    if (trio.promotable.mode() === Mode.STOPPED) {
      throw new Error("game ended before the takeover window");
    }
    const selecting =
      trio.promotable.state.phase === Phase.CASTLE_SELECT &&
      trio.promotable.mode() === Mode.SELECTION;
    if (selecting && !confirmed) {
      await confirmPhantomSeat([trio.promotable, trio.observer], seat);
    }
    confirmed = selecting;
    trio.host.tick(1);
    await trio.pumpHost();
    trio.promotable.tick(1);
    trio.observer.tick(1);
  }
  throw new Error("runTrioUntil: predicate never satisfied");
}

/** Post-promotion run-out for the trio survivors: tick promotable +
 *  observer to STOPPED with promoted broadcasts flowing, hand-confirming
 *  the phantom seat only while its takeover is still pending (post-flip
 *  it is local AI everywhere and drives its own reselects). */
async function runSurvivorsToEnd(
  trio: MigrationTrio,
  seat: ValidPlayerId,
  maxSteps = 200_000,
): Promise<void> {
  let confirmed = false;
  for (let step = 0; step < maxSteps; step++) {
    if (
      trio.promotable.mode() === Mode.STOPPED &&
      trio.observer.mode() === Mode.STOPPED
    ) {
      return;
    }
    const selecting =
      trio.promotable.state.phase === Phase.CASTLE_SELECT &&
      trio.promotable.mode() === Mode.SELECTION &&
      trio.promotableSession.remotePlayerSlots.has(seat);
    if (selecting && !confirmed) {
      await confirmPhantomSeat([trio.promotable, trio.observer], seat);
    }
    confirmed = selecting;
    trio.promotable.tick(1);
    trio.observer.tick(1);
    await trio.pumpPromoted();
  }
  throw new Error("runSurvivorsToEnd: survivors never reached STOPPED");
}

/** Deliver the selection confirm a phantom third-machine seat's absent
 *  client would have broadcast. CASTLE_SELECT's expiry auto-confirm
 *  deliberately skips remote humans (the owning peer re-broadcasts its
 *  own), so a seat with no machine in the harness needs the wire
 *  message hand-delivered — identically — to every receiving peer. */
async function confirmPhantomSeat(
  peers: readonly Scenario[],
  seat: ValidPlayerId,
): Promise<void> {
  const lead = peers[0]!;
  const zone = lead.state.playerZones[seat];
  const towerIdx = lead.state.map.towers.findIndex(
    (tower) => tower.zone === zone,
  );
  const msg = {
    type: MESSAGE.OPPONENT_TOWER_SELECTED,
    playerId: seat,
    towerIdx,
    confirmed: true,
    applyAt: lead.state.simTick + DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS,
  } as ServerMessage;
  for (const peer of peers) {
    await peer.deliverMessage(msg);
  }
}

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

Deno.test(
  "watcher promoted during the round-end score overlay routes past round-end",
  async () => {
    const pair = await createNetworkedPair({
      seed: 1,
      mode: "classic",
      rounds: 5,
    });
    let overlaySeen = false;
    pair.watcher.bus.on(GAME_EVENT.SCORE_OVERLAY_START, () => {
      overlaySeen = true;
    });
    await promoteWatcherDuringRoundEnd(
      pair,
      (watcher) =>
        overlaySeen &&
        watcher.state.phase === Phase.WALL_BUILD &&
        watcher.mode() === Mode.TRANSITION,
      "score-overlay window",
    );
  },
);

Deno.test(
  "watcher promoted during the life-lost dialog force-continues into reselect",
  async () => {
    // Seed 0 classic reaches a reselect cycle (see seed-fixtures.json
    // "selection:reselect-cycle") — its round-end shows the life-lost
    // dialog. If AI retuning drifts it, re-scan for LIFE_LOST_DIALOG_SHOW.
    const pair = await createNetworkedPair({
      seed: 0,
      mode: "classic",
      rounds: 12,
    });
    let reselectPids: readonly ValidPlayerId[] = [];
    pair.watcher.bus.on(GAME_EVENT.LIFE_LOST_DIALOG_SHOW, (ev) => {
      reselectPids = ev.needsReselect;
    });
    const fullState = await promoteWatcherDuringRoundEnd(
      pair,
      (watcher) => watcher.mode() === Mode.LIFE_LOST,
      "dialog window",
    );
    // A visible dialog implies pending (= reselect-eligible) entries; the
    // repair forces CONTINUE, so the route must be the reselect cycle and
    // the snapshot must carry it.
    assertEquals(fullState.phase, Phase[Phase.CASTLE_SELECT]);
    assert(reselectPids.length > 0, "dialog window implies reselect entries");
    for (const pid of reselectPids) {
      assert(
        pair.watcher.state.players[pid]!.homeTower !== null,
        `P${pid} must have re-picked a castle after the forced CONTINUE`,
      );
    }
  },
);

async function promoteWatcherDuringRoundEnd(
  pair: NetworkedPair,
  windowReached: (watcher: Scenario) => boolean,
  label: string,
): Promise<FullStateMessage> {
  const { watcher } = pair;
  await runPairUntil(pair, () => windowReached(watcher), label);
  // round++ already ran in round-end's mutate — the window's round value
  // is the NEW round; a re-dispatched mutate would increment it again.
  const roundAtWindow = watcher.state.round;
  const livesAtWindow = watcher.state.players.map((p) => p.lives);
  let roundEndsAfterWindow = 0;
  watcher.bus.on(GAME_EVENT.ROUND_END, () => {
    roundEndsAfterWindow++;
  });

  pair.watcherSession.myPlayerId = 0 as ValidPlayerId;
  const sentBefore = watcher.sentMessages.length;
  await watcher.deliverMessage({
    type: MESSAGE.HOST_LEFT,
    newHostPlayerId: 0 as ValidPlayerId,
    disconnectedPlayerId: null,
  } as ServerMessage);

  // The repair must route past round-end before broadcasting — a snapshot
  // parked at WALL_BUILD timer=0 makes every applying watcher re-dispatch
  // round-end and double-run its mutate.
  assert(
    watcher.state.phase !== Phase.WALL_BUILD,
    `${label}: promotion must route past round-end ` +
      `(phase=${Phase[watcher.state.phase]})`,
  );
  const fullState = watcher.sentMessages
    .slice(sentBefore)
    .find((msg) => msg.type === MESSAGE.FULL_STATE) as
    | FullStateMessage
    | undefined;
  assert(fullState, `${label}: promotion must broadcast FULL_STATE`);
  assert(
    fullState.phase !== Phase[Phase.WALL_BUILD],
    `${label}: FULL_STATE must carry the routed phase, not the closed ` +
      `WALL_BUILD`,
  );
  assertEquals(
    watcher.state.players.map((p) => p.lives),
    livesAtWindow,
    `${label}: the round-end life penalties must not re-apply`,
  );

  // The promoted peer runs the match alone — it must reach the next
  // battle WITHOUT closing another round on the way (a re-dispatched
  // round-end emits a second ROUND_END and skips a round number).
  let battleReached = false;
  watcher.bus.on(GAME_EVENT.PHASE_START, (ev) => {
    if (ev.phase === Phase.BATTLE) battleReached = true;
  });
  let ticks = 0;
  while (!battleReached && watcher.mode() !== Mode.STOPPED) {
    watcher.tick(1);
    if (++ticks > 60_000) {
      throw new Error(
        `${label}: stalled after promotion ` +
          `(phase=${Phase[watcher.state.phase]} mode=${watcher.mode()})`,
      );
    }
  }
  assertEquals(
    roundEndsAfterWindow,
    0,
    `${label}: round-end must not re-run after promotion`,
  );
  assertEquals(
    watcher.state.round,
    roundAtWindow,
    `${label}: the round counter must not advance again before the next ` +
      `battle`,
  );
  return fullState;
}

// ── FULL_STATE adoption mid-dialog must arm the reselect cycle ───────
// The repair above broadcasts a snapshot already INSIDE the reselect
// cycle while surviving watchers still sit in their own life-lost
// dialogs. Reselect entry is otherwise purely local (no SELECT_START is
// broadcast mid-game), so the apply must arm the local selection
// subsystem for the adopted CASTLE_SELECT phase — an unarmed watcher has
// zero selection entries, instantly "confirms" the cycle, and advances
// with the reselecting player's homeTower still null (it never re-picks).
Deno.test(
  "running watcher adopting a reselect FULL_STATE mid-dialog arms selection",
  async () => {
    const pair = await createNetworkedPair({
      seed: 0,
      mode: "classic",
      rounds: 12,
    });
    const { host, watcher } = pair;
    let reselectPids: readonly ValidPlayerId[] = [];
    watcher.bus.on(GAME_EVENT.LIFE_LOST_DIALOG_SHOW, (ev) => {
      reselectPids = ev.needsReselect;
    });

    await runPairUntil(
      pair,
      () =>
        host.mode() === Mode.LIFE_LOST && watcher.mode() === Mode.LIFE_LOST,
      "both peers mid-dialog",
    );
    assert(reselectPids.length > 0, "dialog window implies reselect entries");

    // The host alone resolves its dialog (AI entries auto-CONTINUE) and
    // enters the reselect cycle — its state is the snapshot shape a
    // promoted host's round-end repair broadcasts.
    let ticks = 0;
    while (host.state.phase !== Phase.CASTLE_SELECT) {
      host.tick(1);
      if (++ticks > 60_000) {
        throw new Error("host never resolved its life-lost dialog");
      }
    }

    await watcher.deliverMessage(
      createFullStateMessage(host.state, 1) as ServerMessage,
    );
    assertEquals(
      Phase[watcher.state.phase],
      Phase[Phase.CASTLE_SELECT],
      "watcher must adopt the snapshot phase",
    );
    assertEquals(watcher.mode(), Mode.SELECTION);

    // The adopted cycle must actually run: the reselecting player re-picks
    // a castle before the next cannon phase. An unarmed selection skips
    // the cycle and leaves homeTower null for good.
    ticks = 0;
    while (
      watcher.state.phase !== Phase.CANNON_PLACE &&
      watcher.mode() !== Mode.STOPPED
    ) {
      watcher.tick(1);
      if (++ticks > 60_000) {
        throw new Error(
          `watcher stalled after adoption ` +
            `(phase=${Phase[watcher.state.phase]} mode=${watcher.mode()})`,
        );
      }
    }
    for (const pid of reselectPids) {
      assert(
        watcher.state.players[pid]!.homeTower !== null,
        `P${pid} must have re-picked a castle in the adopted reselect cycle`,
      );
    }
  },
);

async function runPairUntil(
  pair: NetworkedPair,
  done: () => boolean,
  label: string,
): Promise<void> {
  let steps = 0;
  while (!done()) {
    pair.host.tick(1);
    await pair.pump();
    pair.watcher.tick(1);
    if (pair.host.mode() === Mode.STOPPED) {
      throw new Error(`${label}: game ended before the target condition`);
    }
    if (++steps > 120_000) {
      throw new Error(`${label}: condition never reached`);
    }
  }
}
