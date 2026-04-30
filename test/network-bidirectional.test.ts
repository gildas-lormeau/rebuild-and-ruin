/**
 * Bidirectional network test — both peers drive a local assisted-human
 * slot whose actions broadcast via wire to the other peer. Models a real
 * "2 humans on different machines" online setup, where the existing
 * one-way `network-vs-local` parity test is structurally blind: only the
 * host has assisted slots, watcher just receives.
 *
 * Hypothesis under test: when both peers fire at overlapping windows
 * with non-zero wire delay, the wire-applied ball spawns at a later frame
 * than the local-fire ball. If both balls target the same wall, the
 * destruction-attribution can differ between peers → score divergence,
 * downstream RNG drift via house→grunt spawn / conscription / ricochet
 * draws on different ticks.
 *
 * The canonical sort in `tickCannonballs`
 * ([src/game/battle-system.ts:530](src/game/battle-system.ts#L530))
 * handles SAME-FRAME impact ordering only — not cross-frame timing. The
 * `applyCannonFired` path pushes balls with `elapsed: 0` regardless of
 * how stale the wire message is, so a 5-frame-delayed fire on one peer
 * lands 5 frames later than the originating peer.
 *
 * If "luck" is sufficient to trigger this with deterministic AI
 * strategies and modest latency, at least one seed in the sweep should
 * produce divergent host/watcher state.
 *
 * If the sweep passes, either:
 *   (a) AI strategies rarely converge on the same wall in adjacent
 *       frames within the latency window, OR
 *   (b) some other mechanism prevents the divergence, OR
 *   (c) the divergence is real but smaller than my coverage.
 */

// `scenario.ts` MUST be evaluated before `network-setup.ts`: scenario
// pulls in `render-canvas.ts` while `document` is still undefined, so
// the 3D-sprite module-load code (`elevation.ts` → `boundsYOf` →
// `procedural-texture.ts`) takes its SSR-safe early return.
// network-setup.ts then installs `online-dom-shim.ts`'s stub `document`,
// by which point render-canvas has already evaluated. Reverse the order
// and the shim's bare-bones `document.createElement("canvas")` falls
// through to `canvas.getContext("2d")`, which crashes.
// `import type { Scenario }` would be elided at runtime, so we import
// `createScenario` as a value (even though we don't call it) to force
// scenario.ts to evaluate first.

import { createScenario, type Scenario } from "./scenario.ts";
import { assert, assertEquals } from "@std/assert";
import { Mode } from "../src/shared/ui/ui-mode.ts";
import type { ValidPlayerSlot } from "../src/shared/core/player-slot.ts";
import { createBidirectionalNetworkedPair } from "./network-setup.ts";

interface PlayerSnapshot {
  readonly id: number;
  readonly lives: number;
  readonly walls: number;
  readonly cannons: number;
  readonly ownedTowers: number;
  readonly score: number;
}

type SnapshotMode = "phase" | "tick";

// 5 frames @ 60Hz ≈ 83ms — realistic LAN/WAN latency.
const WIRE_DELAY_FRAMES = 5;
const SWEEP: {
  readonly seed: number;
  readonly mode: "classic" | "modern";
  readonly rounds: number;
}[] = [
  { seed: 1, mode: "classic", rounds: 3 },
  { seed: 7, mode: "classic", rounds: 3 },
  { seed: 13, mode: "classic", rounds: 3 },
  { seed: 42, mode: "classic", rounds: 3 },
  { seed: 99, mode: "classic", rounds: 3 },
  { seed: 123, mode: "classic", rounds: 3 },
  { seed: 256, mode: "classic", rounds: 3 },
  { seed: 1024, mode: "classic", rounds: 3 },
  // Modern needs ≥5 rounds to actually exercise upgrade-pick (which
  // fires from round 3) across multiple cycles. Seeds match the modern
  // entries in network-vs-local.test.ts.
  { seed: 7, mode: "modern", rounds: 5 },
  { seed: 42, mode: "modern", rounds: 5 },
  { seed: 99, mode: "modern", rounds: 5 },
  { seed: 256, mode: "modern", rounds: 5 },
];
// ── Variant B: 3 humans (no AI) ───────────────────────────────────
// Every slot is assisted-human, distributed across the two peers — host
// drives [0, 2], watcher drives [1]. This removes the clone-everywhere
// AI from the mix entirely so that ANY divergence has to come from the
// wire path itself, not from a hypothetical AI/RNG drift. Run at delay=0
// AND delay=5 to separate same-frame wire-arrival reordering (delay=0
// case) from cross-frame fire-timing (delay=5 case).
//
// Why this split (host=[0,2] / watcher=[1]) instead of [0,1]/[2] or
// [0]/[1,2]: any 2/1 split exercises both "1 broadcaster on this peer"
// and "2 broadcasters on this peer" simultaneously; the specific slot
// assignment shouldn't matter for the bug class. If a test only fails
// under one specific split, that's a separate signal worth chasing.
const ALL_HUMAN_DELAYS: readonly number[] = [0, WIRE_DELAY_FRAMES];

// Touch the value import so module elision can't drop scenario.ts.
void createScenario;

// ── Variant A: 2 humans + 1 AI ────────────────────────────────────
// Slot 0 assisted on host, slot 1 assisted on watcher, slot 2 regular AI
// (clone-everywhere on both peers — no wire). Models the original "2
// humans on different machines" case. The AI being clone-everywhere
// means slot 2's actions never traverse the wire path; any divergence
// here is purely from the human-fire-timing race between slots 0 and 1.
for (const trial of SWEEP) {
  Deno.test(
    `bidirectional 2H+1AI (${WIRE_DELAY_FRAMES}f delay, seed=${trial.seed} ${trial.mode} r${trial.rounds})`,
    async () => {
      const pair = await createBidirectionalNetworkedPair({
        seed: trial.seed,
        mode: trial.mode,
        rounds: trial.rounds,
        assistedSlotsHost: [0 as ValidPlayerSlot],
        assistedSlotsWatcher: [1 as ValidPlayerSlot],
        wireDelayFrames: WIRE_DELAY_FRAMES,
      });
      await runBidirectionalToEnd(pair.host, pair.watcher, pair.pump);
      assertWireFiredFor(pair.host, [0], "host", trial);
      assertWireFiredFor(pair.watcher, [1], "watcher", trial);
      assertPlayersConverge(
        snapshotPlayers(pair.watcher),
        snapshotPlayers(pair.host),
        `2H+1AI seed=${trial.seed} ${trial.mode}`,
      );
    },
  );
}

for (const delay of ALL_HUMAN_DELAYS) {
  for (const trial of SWEEP) {
    Deno.test(
      `bidirectional 3H (${delay}f delay, seed=${trial.seed} ${trial.mode} r${trial.rounds})`,
      async () => {
        const pair = await createBidirectionalNetworkedPair({
          seed: trial.seed,
          mode: trial.mode,
          rounds: trial.rounds,
          assistedSlotsHost: [0 as ValidPlayerSlot, 2 as ValidPlayerSlot],
          assistedSlotsWatcher: [1 as ValidPlayerSlot],
          wireDelayFrames: delay,
        });
        // Opt-in state-snapshot dump for first-divergence investigation.
        //   BIDIR_DUMP=1 → one snapshot per phase TRANSITION on each peer
        //                  (default; agent-friendly: no wire-lag noise
        //                  because both peers are quiescent at phase end,
        //                  so line N on each file = same logical event).
        //   BIDIR_DUMP=2 → one snapshot per TICK on each peer (deep human
        //                  inspection; ~12k lines per game; intra-phase
        //                  drift like the 1-tick wire-vs-local spawn lag
        //                  shows up as transient diffs that re-converge).
        // Files: /tmp/bidir-<peer>-d<delay>-s<seed>.log. State snapshots
        // are immune to bus-emit asymmetry (placement events emit only on
        // the originating peer's local path).
        const dumpEnv = Deno.env.get("BIDIR_DUMP");
        const dumpMode: SnapshotMode | null =
          dumpEnv === "1" ? "phase" : dumpEnv === "2" ? "tick" : null;
        const result = dumpMode
          ? await runWithSnapshots(
            pair.host,
            pair.watcher,
            pair.pump,
            dumpMode,
          )
          : (await runBidirectionalToEnd(pair.host, pair.watcher, pair.pump),
            null);

        assertWireFiredFor(pair.host, [0, 2], "host", trial);
        assertWireFiredFor(pair.watcher, [1], "watcher", trial);

        if (dumpMode && result) {
          const tag = `d${delay}-s${trial.seed}`;
          Deno.writeTextFileSync(
            `/tmp/bidir-host-${tag}.log`,
            result.hostSnaps.join("\n") + "\n",
          );
          Deno.writeTextFileSync(
            `/tmp/bidir-watcher-${tag}.log`,
            result.watcherSnaps.join("\n") + "\n",
          );
          console.log(`dumped /tmp/bidir-{host,watcher}-${tag}.log`);
        }

        assertPlayersConverge(
          snapshotPlayers(pair.watcher),
          snapshotPlayers(pair.host),
          `3H delay=${delay} seed=${trial.seed} ${trial.mode}`,
        );
      },
    );
  }
}

/** Tick both peers in lockstep, recording state snapshots according to
 *  `mode`:
 *   - "phase": one row per phase TRANSITION on each peer, tagged with a
 *     per-peer transition counter. Both peers traverse the same phase
 *     sequence (CASTLE_SELECT → CANNON_PLACE → BATTLE → WALL_BUILD …),
 *     so line N on each file represents the same logical event with
 *     post-transition (quiescent) state on each peer. Diff lines = real
 *     divergence; intra-phase wire-vs-local lag never appears.
 *   - "tick": one row per simulation tick on each peer, tag = absolute
 *     tick number. Same-length tick-aligned streams; ~12k lines per
 *     game, with transient 1-tick drift visible. Use when you suspect
 *     a divergence that re-converges within a phase. */
async function runWithSnapshots(
  host: Scenario,
  watcher: Scenario,
  pump: () => Promise<void>,
  mode: SnapshotMode,
  maxSteps = 60_000,
): Promise<{ hostSnaps: string[]; watcherSnaps: string[] }> {
  const hostSnaps: string[] = [];
  const watcherSnaps: string[] = [];
  let hostPrevPhase: string | null = null;
  let watcherPrevPhase: string | null = null;
  let hostTransitions = 0;
  let watcherTransitions = 0;
  for (let step = 0; step < maxSteps; step++) {
    host.tick(1);
    watcher.tick(1);
    await pump();
    if (mode === "tick") {
      const tag = `t${step.toString().padStart(5, "0")}`;
      hostSnaps.push(`${tag} ${snapshotState(host)}`);
      watcherSnaps.push(`${tag} ${snapshotState(watcher)}`);
    } else {
      const hostPhase = host.state.phase;
      if (hostPhase !== hostPrevPhase) {
        const tag = `p${hostTransitions.toString().padStart(3, "0")}-${hostPhase}`;
        hostSnaps.push(`${tag} ${snapshotState(host)}`);
        hostPrevPhase = hostPhase;
        hostTransitions++;
      }
      const watcherPhase = watcher.state.phase;
      if (watcherPhase !== watcherPrevPhase) {
        const tag =
          `p${watcherTransitions.toString().padStart(3, "0")}-${watcherPhase}`;
        watcherSnaps.push(`${tag} ${snapshotState(watcher)}`);
        watcherPrevPhase = watcherPhase;
        watcherTransitions++;
      }
    }
    if (host.mode() === Mode.STOPPED && watcher.mode() === Mode.STOPPED) {
      return { hostSnaps, watcherSnaps };
    }
  }
  throw new Error(
    `bidirectional run did not reach STOPPED within ${maxSteps} steps`,
  );
}

/** State snapshot — every field that should match across peers if the
 *  simulation is in lockstep. NO timer, NO tick number — those drift
 *  by 1 frame across peers because of the local-vs-wire spawn
 *  asymmetry, but the drift isn't a divergence in game state. Combined
 *  with change-only logging in `runWithSnapshots`, a `diff` between the
 *  two streams reveals real state divergences without 1-tick-offset
 *  noise.
 *
 *  Why not bus events? Placement events (CANNON_PLACED, PIECE_PLACED)
 *  emit only on the originating peer — `placeCannon` calls
 *  `emitGameEvent` but the wire-apply path goes straight to
 *  `applyCannonPlacement` without emitting. Bus-stream diff would
 *  flag those as divergent when they're just unobserved. State
 *  snapshots are immune. */
function snapshotState(sc: Scenario): string {
  const s = sc.state;
  const players = s.players.map((p) =>
    `p${p.id}{l${p.lives}s${p.score}w${p.walls.size}c${p.cannons.length}t${p.ownedTowers.length}}`
  ).join(" ");
  const rng = (s.rng.getState() >>> 0).toString(16).padStart(8, "0");
  return `${s.phase} m${sc.mode()} r${s.round} rng=${rng} g=${s.grunts.length} b=${s.cannonballs.length} pits=${s.burningPits.length} ${players}`;
}

/** Verify a peer's local assisted slots actually fired during the run.
 *  A test that "passes" because nobody fired would prove nothing about
 *  cross-peer parity. */
function assertWireFiredFor(
  peer: Scenario,
  expectedSlots: readonly number[],
  peerLabel: string,
  trial: { seed: number; mode: string },
): void {
  for (const slot of expectedSlots) {
    const fires = peer.sentMessages.filter((msg) => {
      const m = msg as { type: string; playerId?: number };
      return m.type === "cannonFired" && m.playerId === slot;
    });
    assert(
      fires.length > 0,
      `seed=${trial.seed} ${trial.mode}: ${peerLabel}'s slot ${slot} never ` +
        `fired — wire wasn't exercised for that slot`,
    );
  }
}

/** Drive both peers in lockstep until both reach STOPPED. The
 *  tick→pump→tick cadence interleaves message delivery with simulation
 *  steps so wire-arrival is frame-aligned (and `wireDelayFrames` is
 *  measured in those simulation frames). */
async function runBidirectionalToEnd(
  host: Scenario,
  watcher: Scenario,
  pump: () => Promise<void>,
  maxSteps = 60_000,
): Promise<void> {
  for (let step = 0; step < maxSteps; step++) {
    host.tick(1);
    watcher.tick(1);
    await pump();
    if (host.mode() === Mode.STOPPED && watcher.mode() === Mode.STOPPED) {
      return;
    }
  }
  throw new Error(
    `bidirectional run did not reach STOPPED within ${maxSteps} steps ` +
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
