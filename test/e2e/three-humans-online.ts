/**
 * E2E network test: THREE real human players, one quits mid-game, and the two
 * survivors must keep playing the SAME game to the end.
 *
 * Models three humans on three browsers, connected through the real Deno server:
 *   - host  → creates a room, seats itself in slot 0
 *   - peer1 → joins, seats itself in slot 1
 *   - peer2 → joins, seats itself in slot 2
 *
 * Partway through the match one peer CLOSES ITS BROWSER (the quit), the same
 * way a real player closing the tab / losing their connection would. The
 * default quitter is the HOST (slot 0) — its socket closing is the
 * host-migration edge case: the server promotes the lowest-slot survivor
 * (slot 1) to host, that peer broadcasts a FULL_STATE checkpoint, and every
 * survivor adopts it (see src/online/runtime/promote.ts). The quit moment
 * (round + phase) is a parameter so multiple disconnection windows can be
 * exercised — mid-BATTLE vs mid-WALL_BUILD land in different promotion-repair
 * branches of promote.ts.
 *
 * After the quit the two survivors play on (the quitter's seat becomes AI via
 * the seat-takeover the new host stamps). The test asserts:
 *   1. the promotion happened — exactly one survivor reports `isHost`, and it is
 *      the lowest-slot survivor (a broken migration otherwise only surfaces as a
 *      slow game-over timeout);
 *   2. the survivors never diverge — the same N-peer round-boundary monitor as
 *      two-humans-online.ts watches per-slot lives/score every round and stops
 *      at the first disagreement (the quitter is dropped from comparison, not
 *      flagged); and
 *   3. both survivors reach game-over with byte-identical state (rng cursor,
 *      per-slot state, towers, grunts, cannonballs) and agree on the winner.
 *
 * The minimal-human drive, the divergence monitor + per-sim-tick diagnosis, and
 * the parity snapshot all live in the shared harness (./online-humans.ts). Like
 * its two-human sibling it drives REAL keypresses over a REAL WebSocket /
 * server, MUST run non-headless (headless RAF throttling forks the co-hosted
 * sims — see ./online-humans.ts), is slow, and lives outside the pre-commit lane.
 *
 * Run: deno test --no-check -A test/e2e/three-humans-online.ts
 *      (E2E_HEADFUL=1 to watch the three browsers play)
 * Requires: npm run dev (vite on port 5173) AND deno task server (port 8001)
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildSnap,
  delay,
  driveMinimalHuman,
  dumpTickDivergence,
  firedSlots,
  installTickRecorder,
  monitorDivergence,
  type PeerHandle,
  readTickLog,
  type RunControl,
  SLOT_KEYS,
} from "./online-humans.ts";
import { createE2EScenario, GAME_EVENT } from "./scenario.ts";

/** When + who quits the match. `phase` is matched against the bridge's `phase`
 *  (the Phase enum string) the first time the quitter is at-or-past `round`. */
interface QuitMoment {
  readonly quitterSlot: 0 | 1 | 2;
  readonly round: number;
  readonly phase: "BATTLE" | "WALL_BUILD";
}

/** Fixed seed → stable map (parity here is cross-PEER, not cross-RUN). */
const SEED = 42;
/** Three rounds: enough to quit mid-match (round 2) and still run on to
 *  game-over. Valid lobby "Battle Length" value. MUST run non-headless. */
const ROUNDS = 3;
/** Non-headless is REQUIRED for parity — see ./online-humans.ts. */
const HEADLESS = false;
/** Wall-clock budget per peer's input loop (real-time phases, fastMode off). */
const DRIVE_TIMEOUT_MS = 300_000;
/** Quit-watcher poll interval. */
const QUIT_POLL_MS = 150;

// Host (slot 0) quits — the host-migration cases. Two moments, two distinct
// promotion-repair windows in promote.ts (battle-intro vs round-end/build).
Deno.test("e2e online: host quits mid-BATTLE, two survivors finish in sync (migration)", () =>
  runThreeHumansGame("modern", { quitterSlot: 0, round: 2, phase: "BATTLE" }));

Deno.test("e2e online: host quits mid-WALL_BUILD, two survivors finish in sync (migration)", () =>
  runThreeHumansGame("modern", { quitterSlot: 0, round: 2, phase: "WALL_BUILD" }));

async function runThreeHumansGame(
  mode: "classic" | "modern",
  quit: QuitMoment,
): Promise<void> {
  // --- Seat three humans -------------------------------------------------
  await using host = await createE2EScenario({
    seed: SEED,
    rounds: ROUNDS,
    mode,
    online: "host",
    humans: 0, // online path seats slots manually below
    headless: HEADLESS,
    fastMode: false, // real-time phases so human input lands
  });
  await host.input.pressKey(SLOT_KEYS[0]); // claim slot 0

  const code = await host.roomCode();

  await using peer1 = await createE2EScenario({
    seed: SEED,
    rounds: ROUNDS,
    mode,
    online: "join",
    roomCode: code,
    humans: 0,
    headless: HEADLESS,
    fastMode: false,
  });
  await peer1.input.pressKey(SLOT_KEYS[1]); // claim slot 1

  await using peer2 = await createE2EScenario({
    seed: SEED,
    rounds: ROUNDS,
    mode,
    online: "join",
    roomCode: code,
    humans: 0,
    headless: HEADLESS,
    fastMode: false,
  });
  await peer2.input.pressKey(SLOT_KEYS[2]); // claim slot 2

  const peers: readonly PeerHandle[] = [
    { name: "HOST", sc: host },
    { name: "PEER1", sc: peer1 },
    { name: "PEER2", sc: peer2 },
  ];
  const quitter = peers[quit.quitterSlot]!;
  const survivors = peers.filter((peer) => peer !== quitter);

  // Per-sim-tick recorder on every peer (no-ops until state is ready).
  await Promise.all(peers.map(({ sc }) => installTickRecorder(sc)));

  // --- Drive all three + monitor divergence + trigger the quit -----------
  // The quitter's drive is wrapped so the in-flight keypress that races the
  // page-close resolves cleanly instead of rejecting the whole Promise.all.
  const ctrl: RunControl = { stop: false, divergence: null, identities: new Map() };
  // Always CONTINUE on a life loss: random abandons would routinely end a
  // 3-human match in round 1, before the quitter reaches its mid-game quit
  // moment. The quit (a closed socket) is the disconnection event under test
  // here; abandon-coverage lives in two-humans-online.ts.
  const drives = peers.map(({ name, sc }) => {
    const loop = driveMinimalHuman(sc, name, DRIVE_TIMEOUT_MS, ctrl, {
      lifeLost: "continue",
    });
    return name === quitter.name ? ignoreClosed(loop) : loop;
  });
  const actions = await Promise.all([
    ...drives,
    monitorDivergence(peers, ctrl),
    quitAtMoment(quitter, quit, ctrl),
  ]);
  console.log(
    `  actions: ${peers.map((peer, idx) => `${peer.name}=${actions[idx]}`).join(", ")}`,
  );

  // --- First divergence wins: fail fast with diagnosis -------------------
  if (ctrl.divergence) {
    const { round, reason, results } = ctrl.divergence;
    console.log(`  DIVERGENCE at round ${round}: ${reason}`);
    if (results) {
      for (const [name, result] of Object.entries(results)) {
        console.log(`    ${name} round ${round}: ${JSON.stringify(result)}`);
      }
    }
    const logs = await Promise.all(
      peers.map(async ({ name, sc }) => ({ name, log: await readTickLog(sc) })),
    );
    dumpTickDivergence(logs);
    throw new Error(
      `survivors diverged at round ${round}: ${reason} — the quit forked the game`,
    );
  }

  // --- The quitter is gone; the survivors carry the match ----------------
  assert(quitter.sc.page.isClosed(), `${quitter.name} should have quit`);

  // 1. Migration happened: exactly one survivor is host, and it is the
  //    lowest-slot survivor (server promotes the lowest-slot alive player).
  //    Identities come from the monitor's LIVE capture (ctrl.identities), not a
  //    post-game read — see RunControl.identities (teardown resets the slot).
  const hostFlags = survivors.map((peer) => {
    const id = ctrl.identities.get(peer.name);
    assert(id, `${peer.name} identity was never captured live`);
    return { peer, ...id };
  });
  const hostsAmong = hostFlags.filter((entry) => entry.amHost);
  assertEquals(
    hostsAmong.length,
    1,
    `exactly one survivor should be host after migration (got ${hostsAmong.length})`,
  );
  const lowestSurvivorSlot = Math.min(...hostFlags.map((entry) => entry.myPlayerId));
  assertEquals(
    hostsAmong[0]!.myPlayerId,
    lowestSurvivorSlot,
    "the promoted host should be the lowest-slot survivor",
  );

  // 2. Both survivors reached game-over.
  for (const peer of survivors) {
    assertEquals(await peer.sc.mode(), "STOPPED", `${peer.name} reached game-over`);
  }

  // 3. Byte-identical end-of-game state across the survivors.
  const snaps = await Promise.all(
    survivors.map(async (peer) => ({ name: peer.name, snap: await buildSnap(peer.sc) })),
  );
  for (const { name, snap } of snaps) {
    console.log(`  ${name} snap:`, JSON.stringify(snap));
  }
  const ref = snaps[0]!;
  assert(ref.snap.rng !== null, `${ref.name} rng cursor readable at game-over`);
  for (const { name, snap } of snaps.slice(1)) {
    assertEquals(snap.rng, ref.snap.rng, `RNG cursor diverged: ${ref.name} vs ${name}`);
    assertEquals(snap.round, ref.snap.round, `round diverged: ${ref.name} vs ${name}`);
    assertEquals(snap.players, ref.snap.players, `per-player state diverged: ${ref.name} vs ${name}`);
    assertEquals(snap.towerAlive, ref.snap.towerAlive, `tower-alive diverged: ${ref.name} vs ${name}`);
    assertEquals(snap.grunts, ref.snap.grunts, `grunts diverged: ${ref.name} vs ${name}`);
    assertEquals(snap.cannonballs, ref.snap.cannonballs, `cannonballs diverged: ${ref.name} vs ${name}`);
  }

  // Every peer emits GAME_END exactly once, at the single finalizeGameOver
  // chokepoint: the new host via its local game-over dispatch, a watcher via the
  // wire GAME_OVER (which now reaches the chokepoint too). So BOTH survivors see
  // exactly one and agree on the winner. This guards the watcher-GAME_END fix
  // (game-lifecycle.ts:finalizeGameOver) — before it, a watcher whose local
  // round-end was preempted by the wire GAME_OVER saw 0 on the round-exhaustion
  // game-over path.
  const ends = await Promise.all(
    survivors.map(async (peer) => ({
      name: peer.name,
      events: await peer.sc.bus.events(GAME_EVENT.GAME_END),
    })),
  );
  for (const { name, events } of ends) {
    assertEquals(events.length, 1, `${name} saw exactly one game-end`);
  }
  const refWinner = ends[0]!.events[0]!.winner;
  for (const { name, events } of ends.slice(1)) {
    assertEquals(events[0]!.winner, refWinner, `winner diverged: ${ends[0]!.name} vs ${name}`);
  }

  // Guard: each surviving human actually acted before the end. Slot from the
  // live-captured identity (post-game read would be the spectator slot).
  for (const peer of survivors) {
    const fired = await firedSlots(peer.sc);
    const slot = ctrl.identities.get(peer.name)!.myPlayerId;
    assert(fired.has(slot), `${peer.name} (slot ${slot}) never fired a cannon`);
  }
}

/** Poll the quitter until it is at-or-past the target round in the target phase,
 *  then CLOSE its page (the quit). Returns 1 once it has quit, 0 if the game
 *  ended first or the monitor stopped the run. */
async function quitAtMoment(
  quitter: PeerHandle,
  quit: QuitMoment,
  ctrl: RunControl,
): Promise<number> {
  const { name, sc } = quitter;
  while (!ctrl.stop) {
    await delay(QUIT_POLL_MS);
    if (sc.page.isClosed()) return 0;
    let st: { round: number; phase: string; mode: string };
    try {
      st = await sc.page.evaluate(() => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as Record<string, unknown> | undefined;
        return {
          round: (e2e?.round as number) ?? 0,
          phase: (e2e?.phase as string) ?? "",
          mode: (e2e?.mode as string) ?? "",
        };
      });
    } catch {
      continue; // page mid-navigation — retry
    }
    if (st.mode === "STOPPED") return 0; // game ended before the quit moment
    if (st.round >= quit.round && st.phase === quit.phase) {
      console.log(`  QUIT: ${name} leaving at round ${st.round} phase ${st.phase}`);
      await sc.page.close().catch(() => {});
      return 1;
    }
  }
  return 0;
}

/** Swallow the "target/page closed" rejection a drive loop throws when its peer
 *  quits mid-keypress; re-throw anything else. Resolves to 0 actions. */
function ignoreClosed(promise: Promise<number>): Promise<number> {
  return promise.catch((err: unknown) => {
    const msg = String((err as { message?: string })?.message ?? err);
    if (msg.includes("closed") || msg.includes("Target")) return 0;
    throw err;
  });
}
