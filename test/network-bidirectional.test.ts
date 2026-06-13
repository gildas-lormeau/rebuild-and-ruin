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
import { Phase } from "../src/shared/core/game-phase.ts";
import { SIM_TICK_DT } from "../src/shared/core/game-constants.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";
import {
  createBidirectionalNetworkedPair,
  type PlayerParitySnapshot,
  snapshotPlayers,
} from "./network-setup.ts";

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
/** ~2s hidden — well past the 8-tick safety window, so a dropped gap
 *  forks unconditionally. */
const FREEZE_FRAMES = 120;
/** Wall-clock ms the harness advances per `tick(1)` cadence frame (its
 *  inner frames are 1 sim tick each — see `tickFrames`). The freeze gap
 *  is denominated in these so the frozen peer misses exactly the wall
 *  time the running peer's clock advanced. */
const HARNESS_FRAME_MS = Math.round(SIM_TICK_DT * 1000);
const FREEZE_TRIAL = { seed: 42, mode: "classic" } as const;
// ── Uneven-cadence (frame-rate jitter) sub-step pattern ───────────────
// `simTick` is locked to wall-clock time, not frame rate: the per-frame
// SimTickAccumulator drains accumulated wall-time into fixed 1/60s ticks,
// so two machines at 30fps and 144fps advance the SAME number of sim
// ticks per wall-second — they only differ in how many ticks each render
// frame batches. The standard cadence (`tick(1)` per peer per pump) never
// exercises that batching variance: every frame drains exactly one tick.
//
// These patterns feed each peer an uneven, wall-time-CONSERVING cadence —
// 4 ticks over each 4-pump period (average exactly 1 tick/pump, so neither
// peer drifts from the shared pump-frame clock that gates wire delivery),
// but distributed as a 2-tick burst, a 0-tick stall, then two singles. The
// bursts are staggered (host on pump%4==0, watcher on pump%4==2) so the
// peers are never more than one tick apart and neither ever trails the
// pump frame.
//
// Safety: a fire stamps `applyAt = senderSimTick + SAFETY` (=8). Worst
// case the receiver is `maxRecvLead(2) - minSendLead(1) + wireDelay(5) = 6`
// ticks past the sender's fire tick when it arrives — 2 ticks inside the
// 8-tick window, so the skew never pushes a stamp into the receiver's
// past. Raising the burst (e.g. [3,0,…]) breaches that margin and would
// fork by construction, not by bug — keep bursts at 2.
const JITTER_HOST_STEPS = [2, 0, 1, 1] as const;
const JITTER_WATCHER_STEPS = [1, 1, 2, 0] as const;
const JITTER_SWEEP: typeof SWEEP = [
  { seed: 1, mode: "classic", rounds: 3 },
  { seed: 42, mode: "classic", rounds: 3 },
  { seed: 99, mode: "classic", rounds: 3 },
  { seed: 7, mode: "modern", rounds: 5 },
];

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
        assistedSlotsHost: [0 as ValidPlayerId],
        assistedSlotsWatcher: [1 as ValidPlayerId],
        wireDelayFrames: WIRE_DELAY_FRAMES,
      });
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
      assertWireFiredFor(pair.host, [0], "host", trial);
      assertWireFiredFor(pair.watcher, [1], "watcher", trial);
      if (dumpMode && result) {
        const tag = `2h1ai-d${WIRE_DELAY_FRAMES}-s${trial.seed}-${trial.mode}`;
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
          assistedSlotsHost: [0 as ValidPlayerId, 2 as ValidPlayerId],
          assistedSlotsWatcher: [1 as ValidPlayerId],
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
  // Write what we have before throwing so the agent can inspect the
  // pre-hang state.
  Deno.writeTextFileSync(
    `/tmp/bidir-host-hang.log`,
    hostSnaps.join("\n") + "\n",
  );
  Deno.writeTextFileSync(
    `/tmp/bidir-watcher-hang.log`,
    watcherSnaps.join("\n") + "\n",
  );
  throw new Error(
    `bidirectional run did not reach STOPPED within ${maxSteps} steps ` +
      `(dumped /tmp/bidir-{host,watcher}-hang.log)`,
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
    `p${p.id}{l${p.lives}s${p.score}w${p.walls.size}c${p.cannons.length}t${p.enclosedTowers.length}}`
  ).join(" ");
  const rng = (s.rng.getState() >>> 0).toString(16).padStart(8, "0");
  return `${s.phase} m${sc.mode()} r${s.round} st=${s.simTick} rng=${rng} g=${s.grunts.length} b=${s.cannonballs.length} pits=${s.burningPits.length} ${players}`;
}

Deno.test(
  "hidden-tab freeze (watcher): gap is banked and replayed back into lockstep",
  () => runFreezeTrial({ freezeHost: false }),
);

Deno.test(
  "hidden-tab freeze (host): same recovery — the host has no special sim role",
  () => runFreezeTrial({ freezeHost: true }),
);

// Both peers play the whole match on an uneven, wall-time-conserving
// cadence (see JITTER_*_STEPS). The convergence assertion is the contract:
// applyAt scheduling must land every wire action on the same sim tick on
// both peers regardless of how each peer batched its local ticks — and the
// stale-stamp tripwire must stay silent, proving the bounded skew never
// pushes a stamp outside the lockstep SAFETY window.
for (const trial of JITTER_SWEEP) {
  Deno.test(
    `bidirectional 2H+1AI uneven cadence (seed=${trial.seed} ${trial.mode} r${trial.rounds})`,
    () => runJitterTrial(trial),
  );
}

async function runFreezeTrial(opts: { freezeHost: boolean }): Promise<void> {
  // The receive-path tripwire (deps.ts:warnIfStaleWireStamp) console.errors
  // on any wire stamp at or before the receiver's simTick. Zero hits is
  // part of this trial's contract: it pins the quarantine + debt-corrected
  // stamps (a board action committed mid-replay without them reaches the
  // other peer in its past — a fork even when the parity fields happen to
  // survive).
  await withStaleStampCapture((staleStamps) =>
    runFreezeTrialInner(opts, staleStamps)
  );
}

async function runJitterTrial(
  trial: { seed: number; mode: "classic" | "modern"; rounds: number },
): Promise<void> {
  await withStaleStampCapture((staleStamps) =>
    runJitterTrialInner(trial, staleStamps)
  );
}

/** Run `body` with `console.error` intercepted, collecting any
 *  `[lockstep] STALE` tripwire lines (the receive-path
 *  `warnIfStaleWireStamp`). A non-empty array means a wire stamp landed at
 *  or before the receiver's simTick — a fork even when the parity snapshot
 *  happens to survive. `body` gets the live array so it can assert on it
 *  before the restore; `console.error` is always restored on the way out. */
async function withStaleStampCapture(
  body: (staleStamps: string[]) => Promise<void>,
): Promise<void> {
  const staleStamps: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("[lockstep] STALE")) staleStamps.push(line);
    else originalConsoleError(...args);
  };
  try {
    await body(staleStamps);
  } finally {
    console.error = originalConsoleError;
  }
}

async function runJitterTrialInner(
  trial: { seed: number; mode: "classic" | "modern"; rounds: number },
  staleStamps: readonly string[],
): Promise<void> {
  const pair = await createBidirectionalNetworkedPair({
    seed: trial.seed,
    mode: trial.mode,
    rounds: trial.rounds,
    assistedSlotsHost: [0 as ValidPlayerId],
    assistedSlotsWatcher: [1 as ValidPlayerId],
    wireDelayFrames: WIRE_DELAY_FRAMES,
  });
  await runBidirectionalToEnd(
    pair.host,
    pair.watcher,
    pair.pump,
    60_000,
    jitterCadence,
  );
  assertWireFiredFor(pair.host, [0], "host", trial);
  assertWireFiredFor(pair.watcher, [1], "watcher", trial);
  assertPlayersConverge(
    snapshotPlayers(pair.watcher),
    snapshotPlayers(pair.host),
    `jitter seed=${trial.seed} ${trial.mode}`,
  );
  assertEquals(
    staleStamps,
    [],
    "a wire stamp landed in a peer's past — uneven cadence pushed a stamp " +
      "outside the lockstep SAFETY window",
  );
}

/** Uneven per-pump cadence for `runBidirectionalToEnd` — see the
 *  JITTER_*_STEPS note for the wall-time-conservation + safety argument. */
function jitterCadence(step: number): readonly [number, number] {
  const phase = step % JITTER_HOST_STEPS.length;
  return [JITTER_HOST_STEPS[phase]!, JITTER_WATCHER_STEPS[phase]!];
}

async function runFreezeTrialInner(
  opts: { freezeHost: boolean },
  staleStamps: readonly string[],
): Promise<void> {
  const pair = await createBidirectionalNetworkedPair({
    seed: FREEZE_TRIAL.seed,
    mode: FREEZE_TRIAL.mode,
    rounds: 3,
    assistedSlotsHost: [0 as ValidPlayerId],
    assistedSlotsWatcher: [1 as ValidPlayerId],
    wireDelayFrames: WIRE_DELAY_FRAMES,
  });
  const { host, watcher, pump } = pair;
  const frozen = opts.freezeHost ? host : watcher;
  const running = opts.freezeHost ? watcher : host;

  // Reach the first BATTLE on both peers, then settle a few frames in —
  // in-flight cannonballs and live fire windows make this the spiciest
  // moment for a freeze to corrupt.
  let guard = 0;
  while (
    host.state.phase !== Phase.BATTLE ||
    watcher.state.phase !== Phase.BATTLE
  ) {
    host.tick(1);
    watcher.tick(1);
    await pump();
    if (++guard > 30_000) {
      throw new Error("freeze trial never reached BATTLE on both peers");
    }
  }
  for (let i = 0; i < 30; i++) {
    host.tick(1);
    watcher.tick(1);
    await pump();
  }

  // Freeze one peer. The other keeps playing, and the wire keeps
  // delivering into the frozen peer's queue — hidden tabs still receive
  // WebSocket messages; only rAF stops.
  for (let i = 0; i < FREEZE_FRAMES; i++) {
    running.tick(1);
    await pump();
  }

  // Tab returns: one frame whose dt is the whole gap (exactly what the
  // first post-show rAF measures in a browser). The gap equals the wall
  // time the running peer's clock advanced during the freeze, so the two
  // peers' injected sim time stays µs-conserving. `tick()` cannot model
  // this — see `Scenario.stall`.
  frozen.stall(FREEZE_FRAMES * HARNESS_FRAME_MS);
  await pump();

  // The frozen peer must fast-forward back to tick parity within the
  // catch-up window (~gap/32 frames; 30 is generous). ±1 tick tolerance:
  // the debt bank floors to whole ticks, so a sub-tick residue parks
  // there permanently — inside the 8-tick lockstep jitter budget.
  for (let i = 0; i < 30; i++) {
    host.tick(1);
    watcher.tick(1);
    await pump();
  }
  const tickGap = Math.abs(host.state.simTick - watcher.state.simTick);
  assert(
    tickGap <= 1,
    `frozen ${opts.freezeHost ? "host" : "watcher"} still ${tickGap} sim ` +
      `ticks behind after the catch-up window — gap was dropped, not banked`,
  );

  // Play out the rest of the match: the recovered peer's later actions
  // (and the other peer's) must keep both boards converged.
  await runBidirectionalToEnd(host, watcher, pump);
  assertWireFiredFor(host, [0], "host", FREEZE_TRIAL);
  assertWireFiredFor(watcher, [1], "watcher", FREEZE_TRIAL);
  assertPlayersConverge(
    snapshotPlayers(watcher),
    snapshotPlayers(host),
    opts.freezeHost ? "host-freeze" : "watcher-freeze",
  );
  assertEquals(
    staleStamps,
    [],
    "a wire stamp landed in a peer's past — quarantine / debt-corrected " +
      "stamps failed during the catch-up replay",
  );
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

/** Drive both peers in lockstep until both reach STOPPED. Both peers tick,
 *  then the pump delivers — so wire-arrival is frame-aligned (and
 *  `wireDelayFrames` is measured in those simulation frames).
 *
 *  `cadence` returns the [hostSteps, watcherSteps] sub-step counts for a
 *  given pump index. The default `[1, 1]` is the even 60Hz cadence every
 *  caller but the jitter trial wants; `jitterCadence` feeds an uneven,
 *  wall-time-conserving pattern to model two machines at different frame
 *  rates. */
async function runBidirectionalToEnd(
  host: Scenario,
  watcher: Scenario,
  pump: () => Promise<void>,
  maxSteps = 60_000,
  cadence: (step: number) => readonly [number, number] = () => [1, 1],
): Promise<void> {
  for (let step = 0; step < maxSteps; step++) {
    const [hostSteps, watcherSteps] = cadence(step);
    host.tick(hostSteps);
    watcher.tick(watcherSteps);
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

function assertPlayersConverge(
  watcher: readonly PlayerParitySnapshot[],
  host: readonly PlayerParitySnapshot[],
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
