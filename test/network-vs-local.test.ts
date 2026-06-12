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
  createNetworkedPair,
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

// ── Host promotion during UPGRADE_PICK must not stall the match ──────
// UPGRADE_PICK is the only phase with no self-driving timer: its exit is
// dispatched by the pick dialog's resolution callback (modal window) or
// by the enter-upgrade-pick banner's postDisplay arming that dialog
// (banner window). Promotion tears both down and forces Mode.GAME, where
// tickGame no-ops the UPGRADE_PICK phase — without the phase repair in
// promote.ts, `enter-wall-build` is never dispatched again and every
// peer hangs forever. The promoted peer must force-resolve the picks and
// advance to WALL_BUILD BEFORE broadcasting FULL_STATE, so watchers
// receive a snapshot that ticks forward on its own.

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

// ── Host promotion during the battle intro must begin the battle ─────
// The battle-entry display chain owns the intro: the enter-battle
// banner's sweep-end runs proceedToBattleFromCtx (tilt + balloon flip),
// and the tilt/balloon steps end in beginBattle (controller
// battle-state init, ready countdown + battleReady cue, battle accum
// reset, Mode.GAME). Promotion landing in any of those windows tears
// the owning step down (hideBanner / forced mode), so without the
// repair the promoted peer runs the battle with no ready countdown, a
// flat camera, and lingering balloon flights — and broadcasts that
// half-begun state to every watcher.

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
    // Seed 104: a propaganda-balloon capture (the only producer of
    // balloon flights) resolves at round 3's battle entry. If AI
    // retuning drifts it, re-scan seeds for `mode() === BALLOON_ANIM`.
    await promoteWatcherDuringBattleIntro(
      (watcher) => watcher.mode() === Mode.BALLOON_ANIM,
      "balloon window",
      104,
    );
  },
);
