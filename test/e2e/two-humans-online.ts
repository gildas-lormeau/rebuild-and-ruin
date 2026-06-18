/**
 * E2E network test: two real human players run a game to the end and must
 * observe the SAME game.
 *
 * Models two humans on two browsers, connected through the real Deno server:
 *   - host  → creates a room, seats itself in slot 0
 *   - client→ joins the room, seats itself in slot 1
 *   - slot 2 is left empty → the lobby fills it with an AI on start
 *
 * Each human plays *minimally*: seat, build poorly (random nudges), but in
 * battle AIM at the nearest enemy structure and fire (so opponent damage is
 * exercised), and on a life loss pick CONTINUE or ABANDON at random (~50/50,
 * so both the reselect and elimination paths get covered over many runs). They
 * still build badly, so the slot-2 AI beats them and the match runs to
 * game-over.
 *
 * Divergence detection: a concurrent monitor compares the two peers at every
 * ROUND boundary (the quiescent point where scores are finalized and there is
 * no wire-lag transient) and STOPS the whole test at the FIRST round where they
 * disagree — reporting which round and what differed. The keystone signal is
 * the RNG cursor (`sc.rngState()`): every AI/RNG draw is mirror-simulated on
 * every peer, so identical cursors prove lockstep; per-slot lives + score
 * localize the divergence. A full end-of-game parity check (towers, grunts,
 * cannonballs, winner) backs it up when no per-round divergence fires.
 *
 * Divergence DIAGNOSIS: the round-boundary monitor can only say which round +
 * field broke. To find the mechanism, each peer also runs an in-page
 * per-sim-tick recorder (`TICK_RECORDER` → `globalThis.__tickRec`) capturing
 * phase, per-slot lives/score/grace, the RNG cursor, the reselect queue
 * (runtime-owned selectionStates, surfaced via the bridge's `selection` field)
 * and the life-lost dialog choices. On a flagged divergence the test aligns
 * both logs by simTick — the lockstep clock, not the non-comparable per-peer
 * loop counter — and dumps the FIRST diverging tick + field + a context window
 * (`dumpTickDivergence`). This is what lets the open life-lost CONTINUE →
 * reselect fork be root-caused from the test itself instead of a throwaway
 * script.
 *
 * This is the only test that drives REAL human keypresses over a REAL
 * WebSocket / server (the headless parity tests stub the transport and drive an
 * AI brain on the human seat). It is slow and lives outside the pre-commit lane.
 *
 * Run: deno test --no-check -A test/e2e/two-humans-online.ts
 *      (E2E_HEADFUL=1 to watch the two browsers play)
 * Requires: npm run dev (vite on port 5173) AND deno task server (port 8001)
 */

import { assert, assertEquals } from "@std/assert";
import {
  createE2EScenario,
  type E2EScenario,
  GAME_EVENT,
} from "./scenario.ts";

/** Per-slot game state compared across peers. */
interface PlayerSnap {
  readonly id: number;
  readonly lives: number;
  readonly walls: number;
  readonly cannons: number;
  readonly enclosedTowers: number;
  readonly score: number;
}

/** Full cross-peer "same game" snapshot — mirrors the headless `Snap` in
 *  test/debug-net-divergence.test.ts, built from serialized bridge state
 *  (`gameState()` arrays + the `rngState()` scalar). Game-state only — no
 *  cosmetic fields (cosmetic divergence is OK). */
interface ParitySnap {
  readonly rng: number | null;
  readonly round: number;
  readonly phase: string;
  readonly players: readonly PlayerSnap[];
  readonly towerAlive: readonly boolean[];
  readonly grunts: readonly { row: number; col: number }[];
  readonly cannonballs: number;
}

/** The stable outcome of one round — captured at the round boundary (start of
 *  the next round / game-over), where scores are finalized and the RNG cursor
 *  is between draws. lives + score + rng is the minimal robust triple. */
interface RoundResult {
  readonly observedAtRound: number;
  readonly rng: number | null;
  readonly players: readonly { id: number; lives: number; score: number }[];
}

/** Shared run control across the two drive loops + the monitor. */
interface RunControl {
  stop: boolean;
  divergence:
    | { round: number; reason: string; host?: RoundResult; client?: RoundResult }
    | null;
}

/** One compact per-sim-tick sample from a peer's in-page recorder. Keyed by
 *  `t` (state.simTick) — the lockstep clock both peers advance in step — so the
 *  two peers' logs can be aligned tick-for-tick (their per-loop iteration
 *  counters cannot). Carries exactly the signals the reselect fork needs:
 *  phase, per-slot lives/score/grace, the RNG cursor, the reselect queue
 *  (`sel`, from the runtime-owned selectionStates), and the life-lost dialog
 *  choices (`ll`). */
interface TickRec {
  /** state.simTick. */
  t: number;
  /** Game phase. */
  ph: string;
  /** Round number. */
  rnd: number;
  /** Lives per slot. */
  L: number[];
  /** Score per slot. */
  S: number[];
  /** inGracePeriod per slot (1/0). */
  G: number[];
  /** RNG cursor (state.rng.getState()). */
  r: number | null;
  /** Reselect queue: selectionStates participants ("0c" = slot 0 confirmed). */
  sel: string[];
  /** Life-lost dialog entries ("0:CONTINUE"). */
  ll: string[];
}

/** In-page per-frame recorder, installed on both peers. On every animation
 *  frame it appends a {@link TickRec} keyed by state.simTick (deduped — one
 *  row per tick) to `globalThis.__tickRec`. Reads only the e2e bridge, so it
 *  never perturbs the sim. Read back after the run via {@link readTickLog} and
 *  aligned by {@link dumpTickDivergence}. */
const TICK_RECORDER = `
(() => {
  const w = globalThis;
  if (w.__tickRec) return;
  w.__tickRec = [];
  const e2e = w.__e2e;
  const loop = () => {
    try {
      const gs = e2e && e2e.gameState ? e2e.gameState() : null;
      if (gs) {
        const rec = w.__tickRec;
        const prev = rec.length ? rec[rec.length - 1] : null;
        if (!prev || prev.t !== gs.simTick) {
          const ui = e2e.overlay && e2e.overlay.ui ? e2e.overlay.ui : null;
          const ll = ui && ui.lifeLostDialog ? ui.lifeLostDialog.entries : [];
          rec.push({
            t: gs.simTick,
            ph: gs.phase,
            rnd: gs.round,
            L: gs.players.map((p) => p.lives),
            S: gs.players.map((p) => p.score),
            G: gs.players.map((p) => (p.inGracePeriod ? 1 : 0)),
            r: e2e.rngState ? e2e.rngState() : null,
            sel: (e2e.selection || []).map((s) => s.pid + (s.confirmed ? "c" : "")),
            ll: ll.map((en) => en.playerId + ":" + en.choice),
          });
        }
      }
    } catch (err) { /* bridge mid-rebuild — skip this frame */ }
    w.requestAnimationFrame(loop);
  };
  w.requestAnimationFrame(loop);
})();
`;
/** Fixed seed → stable map. The run is NOT bit-reproducible (real keypress
 *  timing is non-deterministic); parity here is cross-PEER, not cross-RUN. */
const SEED = 42;
/** Valid lobby "Battle Length" values are 1/3/5/8/12/Infinity.
 *
 *  ROUND 1 is fully parity-clean (host/client snapshots byte-identical). Two
 *  cross-peer divergences were fixed to get here: a joiner double-entering
 *  CASTLE_SELECT (RNG seed skew — SELECT_START is now an ack-only marker) and
 *  the server's phase gate dropping late WALL_BUILD pieces (grace window in
 *  server/game-room.ts). The online room also honors the `mode` + `seed`
 *  options via the host-create flow now.
 *
 *  Runs the full multi-round game: two humans + an AI, byte-identical state on
 *  both peers through to game-over.
 *
 *  MUST run non-headless. Headless Chromium has no display/vsync to drive
 *  `requestAnimationFrame`, so it throttles the sim's main loop unevenly across
 *  the two co-hosted tabs — measured sim-tick skew spikes to ~64 ticks, far past
 *  the 8-tick lockstep buffer (DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS). A wire
 *  action then lands with its `applyAt` already in the receiver's past and
 *  applies late, forking the game. With visible windows both tabs render at full
 *  60Hz, skew stays <= 7 ticks (p99=1), and parity is exact across all rounds.
 *  This is purely a headless-harness artifact: the netcode is sound (the
 *  deterministic headless `network-bidirectional` test covers multi-round parity
 *  under a mock clock; this test covers the real human -> WebSocket -> server ->
 *  mirror-sim path that the in-memory relay stubs out). Anti-throttle launch
 *  flags do not help — headless has no frame source to un-throttle. */
const ROUNDS = 3;
/** Non-headless is REQUIRED for parity — see the file header (headless RAF
 *  throttling forks the two co-hosted sims). Not env-overridable: a headless
 *  run would fail with a false divergence, which is a footgun, not a feature. */
const HEADLESS = false;
/** Wall-clock budget for each peer's minimal-input loop. fastMode is OFF so
 *  phases run at real duration and the human loop has time to inject input. */
const DRIVE_TIMEOUT_MS = 240_000;
/** Monitor poll interval — phases run real-time (seconds) so 250ms reliably
 *  samples each round boundary without missing a transition. */
const MONITOR_POLL_MS = 250;
/** Slot-claim keys in the online lobby (per `selectSlot` in
 *  scripts/online-e2e.ts): slot 0 = "n", slot 1 = "f", slot 2 = "h". */
const SLOT_KEYS = ["n", "f", "h"] as const;

// Modern by default — it's the superset: classic's flow PLUS the
// MODIFIER_REVEAL (waited through) and UPGRADE_PICK (driven in
// driveMinimalHuman) phases, whose modifier/upgrade RNG is mirror-simmed on
// every peer, so parity must hold there too. The body is parameterized by mode
// so a `runTwoHumansGame("classic")` test is one line away if needed.
Deno.test("e2e online: two humans play a full modern game and see the same game", () =>
  runTwoHumansGame("modern"));

async function runTwoHumansGame(mode: "classic" | "modern"): Promise<void> {
  // --- Seat two humans + leave slot 2 for the AI -------------------------
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

  await using client = await createE2EScenario({
    seed: SEED,
    rounds: ROUNDS,
    mode,
    online: "join",
    roomCode: code,
    humans: 0,
    headless: HEADLESS,
    fastMode: false,
  });
  await client.input.pressKey(SLOT_KEYS[1]); // claim slot 1

  // Install the per-sim-tick recorder on both peers up front (it no-ops until
  // state is ready, so it captures from round 1). On a flagged divergence we
  // read these back and align by simTick to pin the FIRST diverging tick +
  // field — the diagnosis the round-boundary monitor can't give on its own.
  await installTickRecorder(host);
  await installTickRecorder(client);

  // --- Both humans play minimally + a monitor watches for divergence -----
  const ctrl: RunControl = { stop: false, divergence: null };
  const [hostActs, clientActs] = await Promise.all([
    driveMinimalHuman(host, "HOST", DRIVE_TIMEOUT_MS, ctrl),
    driveMinimalHuman(client, "CLIENT", DRIVE_TIMEOUT_MS, ctrl),
    monitorDivergence(host, client, ctrl),
  ]);
  console.log(`  HOST actions=${hostActs}, CLIENT actions=${clientActs}`);

  // --- First divergence wins: fail fast with the diverging round ---------
  if (ctrl.divergence) {
    const { round, reason, host: h, client: c } = ctrl.divergence;
    console.log(`  DIVERGENCE at round ${round}: ${reason}`);
    if (h) console.log(`    HOST   round ${round}: ${JSON.stringify(h)}`);
    if (c) console.log(`    CLIENT round ${round}: ${JSON.stringify(c)}`);
    // Pin the mechanism: align both peers' per-tick logs and dump the first
    // diverging sim-tick + field + a context window around it.
    const [hLog, cLog] = await Promise.all([
      readTickLog(host),
      readTickLog(client),
    ]);
    dumpTickDivergence(hLog, cLog);
    throw new Error(
      `peers diverged at round ${round}: ${reason} — the two humans did not ` +
        `play the same game`,
    );
  }

  // --- No per-round divergence: full end-of-game parity backstop ---------
  assertEquals(await host.mode(), "STOPPED", "host reached game-over");
  assertEquals(await client.mode(), "STOPPED", "client reached game-over");

  const hSnap = await buildSnap(host);
  const cSnap = await buildSnap(client);
  console.log("  HOST  snap:", JSON.stringify(hSnap));
  console.log("  CLIENT snap:", JSON.stringify(cSnap));

  assert(hSnap.rng !== null, "host rng cursor readable at game-over");
  assertEquals(hSnap.rng, cSnap.rng, "RNG cursors diverged between peers");
  assertEquals(hSnap.round, cSnap.round, "round diverged");
  assertEquals(hSnap.players, cSnap.players, "per-player state diverged");
  assertEquals(hSnap.towerAlive, cSnap.towerAlive, "tower-alive set diverged");
  assertEquals(hSnap.grunts, cSnap.grunts, "grunt positions diverged");
  assertEquals(hSnap.cannonballs, cSnap.cannonballs, "cannonball count diverged");

  // Same outcome + same per-round sequence on both peers' bus logs.
  const hEnd = await host.bus.events(GAME_EVENT.GAME_END);
  const cEnd = await client.bus.events(GAME_EVENT.GAME_END);
  assertEquals(hEnd.length, 1, "host saw exactly one game-end");
  assertEquals(cEnd.length, 1, "client saw exactly one game-end");
  assertEquals(hEnd[0].winner, cEnd[0].winner, "winners diverged between peers");

  // Guard: each human actually acted (test can't pass on idle/unseated peers).
  const hostFired = await firedSlots(host);
  const clientFired = await firedSlots(client);
  assert(hostFired.has(0), "host's human (slot 0) never fired a cannon");
  assert(clientFired.has(1), "client's human (slot 1) never fired a cannon");
}

;

/**
 * Poll both peers and compare the stable outcome of each round. Records each
 * peer's round-N result at the moment it crosses into round N+1 (or stops),
 * then compares once both peers have closed round N. Sets `ctrl.divergence`
 * and `ctrl.stop` at the FIRST diverging round so the drive loops halt.
 * Returns 0 (its return value is unused; signature matches the drive loops for
 * a clean `Promise.all`).
 */
async function monitorDivergence(
  host: E2EScenario,
  client: E2EScenario,
  ctrl: RunControl,
): Promise<number> {
  const peers: readonly [string, E2EScenario][] = [
    ["HOST", host],
    ["CLIENT", client],
  ];
  const closed: Record<string, Map<number, RoundResult>> = {
    HOST: new Map<number, RoundResult>(),
    CLIENT: new Map<number, RoundResult>(),
  };
  const prevRound: Record<string, number | null> = { HOST: null, CLIENT: null };
  const finalRound: Record<string, number | null> = { HOST: null, CLIENT: null };
  const compared = new Set<number>();

  while (!ctrl.stop) {
    await delay(MONITOR_POLL_MS);
    for (const [name, sc] of peers) {
      let mode = "";
      let result: RoundResult | null = null;
      try {
        mode = await sc.mode();
        result = await roundResultOf(sc);
      } catch {
        continue; // page mid-navigation / closed — retry next poll
      }
      if (!result) continue;
      const round = result.observedAtRound;
      if (prevRound[name] === null) {
        prevRound[name] = round;
      } else if (round > prevRound[name]!) {
        // The previous round just closed; this snapshot (taken at the new
        // round's quiescent start) is that round's finalized outcome.
        closed[name].set(prevRound[name]!, result);
        prevRound[name] = round;
      }
      if (mode === "STOPPED" && finalRound[name] === null) {
        finalRound[name] = round;
        closed[name].set(round, result); // last round never "advances"
      }
    }

    // Compare every round both peers have now closed.
    for (const round of closed.HOST.keys()) {
      if (compared.has(round) || !closed.CLIENT.has(round)) continue;
      compared.add(round);
      const h = closed.HOST.get(round)!;
      const c = closed.CLIENT.get(round)!;
      const reason = roundResultDiff(h, c);
      if (reason) {
        ctrl.divergence = { round, reason, host: h, client: c };
        ctrl.stop = true;
        return 0;
      }
    }

    // Both ended: a different final round = one peer played a different game.
    if (finalRound.HOST !== null && finalRound.CLIENT !== null) {
      if (finalRound.HOST !== finalRound.CLIENT) {
        ctrl.divergence = {
          round: Math.min(finalRound.HOST, finalRound.CLIENT),
          reason:
            `game length differs — HOST ended at round ${finalRound.HOST}, ` +
            `CLIENT ended at round ${finalRound.CLIENT}`,
        };
      }
      ctrl.stop = true;
      return 0;
    }
  }
  return 0;
}

/** Read a peer's current round outcome (round + rng + per-slot lives/score). */
async function roundResultOf(sc: E2EScenario): Promise<RoundResult | null> {
  const rng = await sc.rngState();
  const state = (await sc.gameState()) as {
    round: number;
    players: { id: number; lives: number; score: number }[];
  } | null;
  if (!state) return null;
  return {
    observedAtRound: state.round,
    rng,
    players: state.players.map((player) => ({
      id: player.id,
      lives: player.lives,
      score: player.score,
    })),
  };
}

/** Human-readable description of how two round results differ, or "" if equal.
 *  Compares each slot's finalized lives + score for the closed round.
 *
 *  Deliberately does NOT compare the RNG cursor here. The cursor advances on
 *  every draw, and this snapshot is taken at the wall-clock moment a peer is
 *  first *observed* to have crossed into the next round — the two peers cross
 *  at slightly different sim-ticks and have already consumed a different number
 *  of the next round's early draws, so their cursors legitimately differ at
 *  that instant (it measures sim-tick skew, not divergence). The RNG cursor is
 *  only a valid cross-peer signal when quiescent — i.e. at game-over, where no
 *  further draws occur — and is asserted there by `buildSnap` (`hSnap.rng ===
 *  cSnap.rng`). Per-round, finalized lives + score are the stable, skew-free
 *  parity signals. (`rng` is kept on RoundResult for the divergence log only.) */
function roundResultDiff(a: RoundResult, b: RoundResult): string {
  if (a.players.length !== b.players.length) {
    return `player count ${a.players.length} vs ${b.players.length}`;
  }
  for (let i = 0; i < a.players.length; i++) {
    const ap = a.players[i]!;
    const bp = b.players[i]!;
    if (ap.lives !== bp.lives) {
      return `slot ${ap.id} lives ${ap.lives} vs ${bp.lives}`;
    }
    if (ap.score !== bp.score) {
      return `slot ${ap.id} score ${ap.score} vs ${bp.score}`;
    }
  }
  return "";
}

/** Build a peer's full parity snapshot from the serialized bridge state + rng. */
async function buildSnap(sc: E2EScenario): Promise<ParitySnap> {
  const rng = await sc.rngState();
  const state = (await sc.gameState()) as {
    round: number;
    phase: string;
    players: {
      id: number;
      lives: number;
      walls: unknown[];
      cannons: { hp: number }[];
      enclosedTowers: unknown[];
      score: number;
    }[];
    towerAlive: boolean[];
    grunts: { row: number; col: number }[];
    cannonballs: unknown[];
  } | null;
  assert(state !== null, "game state readable at game-over");
  return {
    rng,
    round: state.round,
    phase: String(state.phase),
    players: state.players.map((player) => ({
      id: player.id,
      lives: player.lives,
      walls: player.walls.length,
      cannons: player.cannons.filter((cannon) => cannon.hp > 0).length,
      enclosedTowers: player.enclosedTowers.length,
      score: player.score,
    })),
    towerAlive: [...state.towerAlive],
    grunts: state.grunts.map((grunt) => ({ row: grunt.row, col: grunt.col })),
    cannonballs: state.cannonballs.length,
  };
}

/** Slot ids that fired at least one cannon in this peer's bus log. */
async function firedSlots(sc: E2EScenario): Promise<Set<number>> {
  const fired = await sc.bus.events(GAME_EVENT.CANNON_FIRED);
  return new Set(fired.map((event) => event.playerId));
}

/**
 * Drive a single browser peer with minimal human input until the game stops or
 * the monitor flags a divergence (`ctrl.stop`). Ported (simplified) from
 * `simulateHumanPlayLoop` in scripts/online-e2e.ts — seat/confirm with "n",
 * rotate with "b", nudge the cursor with arrows; in BATTLE aim at the nearest
 * enemy target and fire (`aimAtEnemyAndFire`); on a life loss pick CONTINUE or
 * ABANDON at random; and in modern's UPGRADE_PICK confirm a pick so the match
 * keeps advancing. Returns the number of action iterations taken.
 */
async function driveMinimalHuman(
  sc: E2EScenario,
  label: string,
  timeoutMs: number,
  ctrl: RunControl,
): Promise<number> {
  const page = sc.page;
  const start = Date.now();
  const dirs = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
  let iteration = 0;

  while (Date.now() - start < timeoutMs && !ctrl.stop) {
    iteration++;
    const { mode, phase, timer, tick } = await page
      .evaluate(() => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as Record<string, unknown> | undefined;
        return {
          mode: (e2e?.mode as string) ?? "",
          phase: (e2e?.phase as string) ?? "",
          timer: (e2e?.timer as number) ?? 10,
          tick: (e2e?.simTick as number) ?? -1,
        };
      })
      .catch(() => ({ mode: "", phase: "", timer: 10, tick: -1 }));

    if (mode === "STOPPED") break;
    if (iteration % 25 === 0) {
      // Key the log on simTick (the lockstep clock), NOT the per-peer iteration
      // counter — so HOST and CLIENT lines for the same game-moment line up.
      console.log(`  ${label}: tick ${tick} mode=${mode} phase=${phase}`);
    }

    if (mode === "LIFE_LOST") {
      // ~50/50 CONTINUE vs ABANDON so runs exercise BOTH the reselect path
      // (CONTINUE → CASTLE_SELECT, default focus) and elimination (ABANDON).
      // The reselect fork is fixed (host now re-broadcasts SELECT_START), so
      // CONTINUE is a real path to cover, not a workaround.
      if (Math.random() < 0.5) {
        await page.keyboard.press("n"); // CONTINUE (default focus)
      } else {
        await page.keyboard.press("ArrowRight");
        await page.waitForTimeout(80);
        await page.keyboard.press("n"); // ABANDON
      }
      await page.waitForTimeout(250);
      continue;
    }

    if (mode === "SELECTION") {
      if (timer > 4) {
        await page.keyboard.press(Math.random() < 0.5 ? "ArrowRight" : "ArrowLeft");
        await page.waitForTimeout(400);
      } else {
        await page.keyboard.press("n"); // confirm castle/tower selection
        await page.waitForTimeout(250);
      }
      continue;
    }

    if (mode === "UPGRADE_PICK") {
      // Modern mode only: arrows move focus across the offered upgrades,
      // "n" confirms the pick. Resolving it keeps the match advancing.
      await page.keyboard.press(Math.random() < 0.5 ? "ArrowRight" : "ArrowLeft");
      await page.waitForTimeout(150);
      await page.keyboard.press("n"); // confirm upgrade pick
      await page.waitForTimeout(250);
      continue;
    }

    if (phase === "CANNON_PLACE") {
      await page.keyboard.press(dirs[Math.floor(Math.random() * dirs.length)]);
      await page.waitForTimeout(40);
      await page.keyboard.press("n"); // place a cannon
      await page.waitForTimeout(150);
      continue;
    }

    if (phase === "WALL_BUILD") {
      for (let nudge = 0; nudge < 1 + Math.floor(Math.random() * 3); nudge++) {
        await page.keyboard.press(dirs[Math.floor(Math.random() * dirs.length)]);
        await page.waitForTimeout(30);
      }
      if (Math.random() < 0.3) await page.keyboard.press("b"); // rotate piece
      await page.keyboard.press("n"); // place piece
      await page.waitForTimeout(120);
      continue;
    }

    if (phase === "BATTLE") {
      // Aim at the nearest ENEMY target and fire, so the humans actually
      // damage opponents' walls/cannons (not their own structures).
      await aimAtEnemyAndFire(page);
      continue;
    }

    // MODIFIER_REVEAL / transitions / banners — wait it out.
    await page.waitForTimeout(150);
  }
  return iteration;
}

/** Install the per-sim-tick recorder ({@link TICK_RECORDER}) on a peer. */
async function installTickRecorder(sc: E2EScenario): Promise<void> {
  await sc.page.evaluate(TICK_RECORDER);
}

/** Read back a peer's recorded per-sim-tick log. */
async function readTickLog(sc: E2EScenario): Promise<TickRec[]> {
  return (await sc.page.evaluate(() => {
    return (globalThis as unknown as { __tickRec?: TickRec[] }).__tickRec ?? [];
  })) as TickRec[];
}

/** Align both peers' per-sim-tick logs and print the FIRST tick at which each
 *  field (phase, lives, grace, reselect queue, life-lost choices, score, rng)
 *  diverges, then a context window of full rows around the earliest one. This
 *  is the diagnosis layer on top of the round-boundary monitor: the monitor
 *  says WHICH round + field broke; this says the exact tick + mechanism. */
function dumpTickDivergence(hLog: TickRec[], cLog: TickRec[]): void {
  const hByTick = new Map(hLog.map((rec) => [rec.t, rec] as const));
  const cByTick = new Map(cLog.map((rec) => [rec.t, rec] as const));
  const common = [...hByTick.keys()]
    .filter((tick) => cByTick.has(tick))
    .sort((firstTick, secondTick) => firstTick - secondTick);
  console.log(
    `  [tick-diag] host ticks=${hLog.length} client ticks=${cLog.length} ` +
      `common=${common.length}` +
      (common.length ? ` (${common[0]}..${common[common.length - 1]})` : ""),
  );
  if (!common.length) return;

  const fields: { key: string; of: (rec: TickRec) => unknown }[] = [
    { key: "PHASE", of: (rec) => rec.ph },
    { key: "LIVES", of: (rec) => rec.L },
    { key: "GRACE", of: (rec) => rec.G },
    { key: "SELECT", of: (rec) => rec.sel },
    { key: "LIFELOST", of: (rec) => rec.ll },
    { key: "SCORE", of: (rec) => rec.S },
    { key: "RNG", of: (rec) => rec.r },
  ];
  const firstAt: Record<string, number | null> = {};
  for (const field of fields) firstAt[field.key] = null;
  for (const tick of common) {
    const host = hByTick.get(tick)!;
    const client = cByTick.get(tick)!;
    for (const field of fields) {
      if (firstAt[field.key] === null && jstr(field.of(host)) !== jstr(field.of(client))) {
        firstAt[field.key] = tick;
      }
    }
  }
  for (const field of fields) {
    console.log(
      `  [tick-diag] first ${field.key.padEnd(8)} divergence: ${firstAt[field.key] ?? "none"}`,
    );
  }

  const earliest = fields
    .map((field) => firstAt[field.key])
    .filter((tick): tick is number => tick !== null)
    .sort((firstTick, secondTick) => firstTick - secondTick)[0];
  if (earliest === undefined) {
    console.log("  [tick-diag] no per-tick divergence on common ticks (skew only)");
    return;
  }
  console.log(`  [tick-diag] === context around tick ${earliest} ===`);
  for (const tick of common.filter((tick) => tick >= earliest - 12 && tick <= earliest + 4)) {
    const host = hByTick.get(tick)!;
    const client = cByTick.get(tick)!;
    const diff = fields
      .filter((field) => jstr(field.of(host)) !== jstr(field.of(client)))
      .map((field) => field.key)
      .join(",");
    console.log(`  [tick-diag] t=${tick}${diff ? "  DIFF:" + diff : ""}`);
    console.log(`  [tick-diag]   H ${tickStr(host)}`);
    console.log(`  [tick-diag]   C ${tickStr(client)}`);
  }
}

/** Compact one-line rendering of a {@link TickRec} for the context dump. */
function tickStr(rec: TickRec): string {
  return (
    `r${rec.rnd} [${rec.ph}] L${jstr(rec.L)} S${jstr(rec.S)} G${jstr(rec.G)} ` +
    `rng=${rec.r} sel[${rec.sel.join(" ")}] ll[${rec.ll.join(" ")}]`
  );
}

function jstr(value: unknown): string {
  return JSON.stringify(value);
}

/** Basic battle aim-bot: hill-climb the crosshair toward the nearest ENEMY
 *  target (`targeting.enemyTargets` excludes our own slot) and fire when within
 *  8px — so the simulated humans damage opponents instead of their own zone.
 *  Ported from scripts/online-e2e.ts simulateHumanPlayLoop. One step per call
 *  (the drive loop re-invokes each tick). */
async function aimAtEnemyAndFire(page: E2EScenario["page"]): Promise<void> {
  const aim = await page
    .evaluate(() => {
      const e2e = (globalThis as unknown as Record<string, unknown>).__e2e as
        | Record<string, Record<string, unknown>>
        | undefined;
      const targets = e2e?.targeting?.enemyTargets as
        | { x: number; y: number }[]
        | undefined;
      const ch = e2e?.controller?.crosshair as
        | { x: number; y: number }
        | undefined;
      if (!targets || targets.length === 0 || !ch) return null;
      let best = targets[0]!;
      let bestDist = Infinity;
      for (const target of targets) {
        const dist = Math.hypot(target.x - ch.x, target.y - ch.y);
        if (dist < bestDist) {
          bestDist = dist;
          best = target;
        }
      }
      return { dx: best.x - ch.x, dy: best.y - ch.y, dist: bestDist };
    })
    .catch(() => null);
  if (aim && aim.dist > 8) {
    const key =
      Math.abs(aim.dx) > Math.abs(aim.dy)
        ? aim.dx > 0
          ? "ArrowRight"
          : "ArrowLeft"
        : aim.dy > 0
          ? "ArrowDown"
          : "ArrowUp";
    await page.keyboard.down(key);
    await page.waitForTimeout(150);
    await page.keyboard.up(key);
  } else {
    await page.keyboard.press("n"); // crosshair on an enemy target — fire
    await page.waitForTimeout(100);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
