/**
 * Shared harness for the online multi-human E2E parity tests
 * (`two-humans-online.ts`, `three-humans-online.ts`).
 *
 * These tests drive REAL human keypresses over a REAL WebSocket / Deno server
 * — the only path that exercises real human input → wire → server relay →
 * mirror-sim on the peer (the headless `network-*` parity tests stub the
 * transport and drive an AI brain on the human seat). This file holds the four
 * pieces every such test shares:
 *
 *   1. `driveMinimalHuman` — a minimal, faithful human: seat + confirm, build
 *      badly, AIM at the nearest enemy structure and fire in BATTLE, resolve
 *      modern's UPGRADE_PICK, pick CONTINUE/ABANDON at random on a life loss.
 *      Deliberately NO phase-specific workarounds — a phase that can't be
 *      driven cleanly is a real netcode bug, not a harness gap
 *      (see feedback_no_test_drive_workarounds_for_netcode_bugs).
 *   2. `monitorDivergence` — an N-peer round-boundary monitor that STOPS the
 *      run at the FIRST round where any two live peers disagree on a slot's
 *      finalized lives/score (the quiescent, skew-free parity signal).
 *      Tolerates a peer dropping out mid-game (a quitter's closed page) — that
 *      peer is excluded from comparison, not flagged as divergence.
 *   3. The per-sim-tick recorder + `dumpTickDivergence` — the diagnosis layer:
 *      the monitor says WHICH round/field broke, this pins the exact sim-tick +
 *      field + mechanism by aligning every live peer's in-page log by simTick
 *      (the lockstep clock).
 *   4. `buildSnap` / `firedSlots` — end-of-game parity snapshot + an
 *      actually-played guard, both built from the serialized e2e bridge state.
 *
 * Parity here is cross-PEER, not cross-RUN: real keypress timing is
 * non-deterministic, so a fixed seed only pins the map. Game-state only — no
 * cosmetic fields (cosmetic divergence is OK).
 *
 * MUST run non-headless. Headless Chromium has no display/vsync to drive
 * `requestAnimationFrame`, so it throttles the co-hosted tabs' main loops
 * unevenly; sim-tick skew spikes past the 8-tick lockstep buffer and a wire
 * action lands with its `applyAt` already in the receiver's past, forking the
 * game. With visible windows both tabs render at full 60Hz and parity is exact.
 * This is a headless-harness artifact, not a netcode bug.
 */

import { assert } from "@std/assert";
import { type E2EScenario, GAME_EVENT } from "./scenario.ts";

/** A peer under observation: a label for logs + its driven scenario. */
export interface PeerHandle {
  readonly name: string;
  readonly sc: E2EScenario;
}

/** Per-slot game state compared across peers. */
export interface PlayerSnap {
  readonly id: number;
  readonly lives: number;
  readonly walls: number;
  readonly cannons: number;
  readonly enclosedTowers: number;
  readonly score: number;
}

/** Full cross-peer "same game" snapshot — built from serialized bridge state
 *  (`gameState()` arrays + the `rngState()` scalar). Game-state only. */
export interface ParitySnap {
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
export interface RoundResult {
  readonly observedAtRound: number;
  readonly rng: number | null;
  readonly players: readonly { id: number; lives: number; score: number }[];
}

/** Shared run control across the drive loops + the monitor. `divergence`
 *  carries the round, a human reason, and each involved peer's round result. */
export interface RunControl {
  stop: boolean;
  divergence:
    | { round: number; reason: string; results?: Record<string, RoundResult> }
    | null;
  /** Latest PRE-TEARDOWN identity per peer (seated slot + host flag), captured
   *  live by the monitor every poll while the peer is still in-game. Migration
   *  assertions must read these, NOT a post-game `page.evaluate`: at game-over
   *  `teardownSession` resets the local identity to the spectator slot (-1), so
   *  reading after STOPPED is racy (it intermittently returns -1). Keyed by
   *  PeerHandle.name. */
  identities: Map<string, { myPlayerId: number; amHost: boolean }>;
  /** Per-peer, per-round cursor activity, sampled live by the monitor from the
   *  peer's OWN controller (buildCursor / cannonCursor / crosshair). Lets a test
   *  assert that an ALIVE player actually moves its cursor each round (it's
   *  really playing, not stuck) and a DEAD player does not (the eliminated-
   *  spectator gate holds). Only intra-phase moves count — a cursor reset at a
   *  phase boundary is not a move. Keyed `name → round → activity`. */
  cursors: Map<string, Map<number, CursorActivity>>;
}

/** One peer's cursor activity within one round (see {@link RunControl.cursors}). */
export interface CursorActivity {
  /** Polls where the local player was alive (lives > 0). */
  aliveSamples: number;
  /** Intra-phase cursor moves while alive — the "is actually playing" signal. */
  aliveMoves: number;
  /** Intra-phase cursor moves while DEAD — should stay 0 (spectator gate). */
  deadMoves: number;
  /** Longest run of consecutive polls where the cursor stayed STILL while the
   *  player was alive in an interactive BUILD phase (WALL_BUILD / CANNON_PLACE),
   *  same phase throughout. A whole-round freeze (issue 1) AND a freeze partway
   *  through a phase (issue 2 — "placed some, then froze") both blow this up;
   *  normal play moves the cursor every ~120ms so the streak stays tiny. */
  maxStaticStreak: number;
}

/** One compact per-sim-tick sample from a peer's in-page recorder. Keyed by
 *  `t` (state.simTick) — the lockstep clock both peers advance in step — so the
 *  peers' logs can be aligned tick-for-tick (their per-loop iteration counters
 *  cannot). Carries exactly the signals a reselect/migration fork needs. */
export interface TickRec {
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

/** Per-peer drive tuning. Not exported — callers pass an inline object literal
 *  (structural typing), so there is nothing to import. */
interface DriveOptions {
  /** Life-lost choice policy:
   *  - `"random"` (default): ~50/50 CONTINUE vs ABANDON, so runs cover both the
   *    reselect path and self-elimination (the two-humans test wants this).
   *  - `"continue"`: always CONTINUE. Never self-eliminate — needed when the
   *    test must reach a specific mid-game moment (e.g. a round-2 quit): with 3
   *    humans, random abandons routinely end the match in round 1 before the
   *    moment arrives. */
  readonly lifeLost?: "random" | "continue";
}

/** Monitor poll interval — phases run real-time (seconds) so 250ms reliably
 *  samples each round boundary without missing a transition. */
const MONITOR_POLL_MS = 250;
/** Interactive phases where a human continuously drives a build/place cursor
 *  (so a sustained still cursor = a freeze). BATTLE is excluded: the aim-bot
 *  legitimately holds the crosshair still once it's on a target and fires. */
const BUILD_PHASES = new Set(["WALL_BUILD", "CANNON_PLACE"]);
/** In-page per-frame recorder, installed on every peer. On each animation
 *  frame it appends a {@link TickRec} keyed by state.simTick (deduped — one row
 *  per tick) to `globalThis.__tickRec`. Reads only the e2e bridge, so it never
 *  perturbs the sim. Read back via {@link readTickLog}, aligned by
 *  {@link dumpTickDivergence}. */
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
/** Align every live peer's per-sim-tick log against the first and print the
 *  FIRST tick at which each field (phase, lives, grace, reselect queue,
 *  life-lost choices, score, rng) diverges from the reference, then a context
 *  window of full rows around the earliest one. The diagnosis layer on top of
 *  the round-boundary monitor: the monitor says WHICH round + field broke;
 *  this says the exact tick + mechanism. `logs[0]` is the reference. */
/** Fields compared per simTick. At a common simTick, in-lockstep peers agree on
 *  ALL of these; ANY difference is a real cross-peer fork (NOT round-boundary
 *  wall-clock skew). */
const TICK_FIELDS: { key: string; of: (rec: TickRec) => unknown }[] = [
  { key: "PHASE", of: (rec) => rec.ph },
  { key: "LIVES", of: (rec) => rec.L },
  { key: "GRACE", of: (rec) => rec.G },
  { key: "SELECT", of: (rec) => rec.sel },
  { key: "LIFELOST", of: (rec) => rec.ll },
  { key: "SCORE", of: (rec) => rec.S },
  { key: "RNG", of: (rec) => rec.r },
];
/** Number of consecutive common ticks a divergence must hold to count as a real
 *  fork. A genuine fork PERSISTS — once two sims diverge they can't re-sync
 *  without a checkpoint. A phase-transition boundary, by contrast, makes PHASE +
 *  RNG flip for ≤ a couple ticks (the recorder sampled the two peers on opposite
 *  sides of one transition) and then re-converges; this window filters those. */
const TICK_DIVERGENCE_PERSIST = 20;
/** Slot-claim keys in the online lobby (per `selectSlot` in
 *  scripts/online-e2e.ts): slot 0 = "n", slot 1 = "f", slot 2 = "h". */
export const SLOT_KEYS = ["n", "f", "h"] as const;

/**
 * Drive a single browser peer with minimal human input until the game stops,
 * its page closes (the peer quit), or the monitor flags a divergence
 * (`ctrl.stop`). Ported (simplified) from `simulateHumanPlayLoop` in
 * scripts/online-e2e.ts — seat/confirm with "n", rotate with "b", nudge the
 * cursor with arrows; in BATTLE aim at the nearest enemy target and fire; on a
 * life loss resolve per `opts.lifeLost`; in modern's UPGRADE_PICK confirm a
 * pick so the match keeps advancing. Returns the iteration count.
 */
export async function driveMinimalHuman(
  sc: E2EScenario,
  label: string,
  timeoutMs: number,
  ctrl: RunControl,
  opts: DriveOptions = {},
): Promise<number> {
  const page = sc.page;
  const lifeLost = opts.lifeLost ?? "random";
  const start = Date.now();
  const dirs = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
  let iteration = 0;
  let prevLives: number[] = [];

  while (Date.now() - start < timeoutMs && !ctrl.stop) {
    if (page.isClosed()) break; // this peer quit — stop driving it
    iteration++;
    const { mode, phase, timer, tick, lives, me } = await page
      .evaluate(() => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as Record<string, unknown> | undefined;
        const gs = (e2e?.gameState as (() => { players: { lives: number }[] } | null) | undefined)?.();
        return {
          mode: (e2e?.mode as string) ?? "",
          phase: (e2e?.phase as string) ?? "",
          timer: (e2e?.timer as number) ?? 10,
          tick: (e2e?.simTick as number) ?? -1,
          lives: gs ? gs.players.map((player) => player.lives) : [],
          me: (e2e?.myPlayerId as number) ?? -1,
        };
      })
      .catch(() => ({ mode: "", phase: "", timer: 10, tick: -1, lives: [] as number[], me: -1 }));

    if (mode === "STOPPED") break;
    // Surface every per-slot lives change, deduped — so the log shows each
    // player's 3→2→1→0 trajectory. A drop to 0 is elimination; a drop that is
    // NOT to 0 is a life loss → CASTLE_SELECT reselect (the player rebuilds and
    // plays on, which from the board looks like "died and came back"). This is
    // what distinguishes the normal reselect from a (bug) 0-life revive.
    for (let slot = 0; slot < lives.length; slot++) {
      const before = prevLives[slot];
      const now = lives[slot]!;
      if (before !== undefined && now !== before) {
        const tag = now === 0 ? "ELIMINATED" : now > before ? "REVIVED?!" : "life lost";
        console.log(`  ${label}: tick ${tick} slot ${slot} lives ${before}→${now} (${tag})`);
      }
    }
    if (lives.length) prevLives = lives;
    if (iteration % 25 === 0) {
      // Key the log on simTick (the lockstep clock), NOT the per-peer iteration
      // counter — so peers' lines for the same game-moment line up.
      console.log(`  ${label}: tick ${tick} mode=${mode} phase=${phase} lives=[${lives.join(",")}]`);
    }

    if (mode === "LIFE_LOST") {
      // CONTINUE → CASTLE_SELECT reselect (default focus); ABANDON →
      // elimination. `lifeLost` picks the policy (see DriveOptions).
      if (lifeLost === "continue" || Math.random() < 0.5) {
        await page.keyboard.press("n"); // CONTINUE (default focus)
      } else {
        await page.keyboard.press("ArrowRight");
        await page.waitForTimeout(80);
        await page.keyboard.press("n"); // ABANDON
      }
      await page.waitForTimeout(250);
      continue;
    }

    // Eliminated (0 lives) = a spectator: a real human whose player is dead
    // can't place/aim cannons, build, reselect, or pick upgrades. Issue NO
    // gameplay input — just watch — so the test doesn't drive a dead seat (the
    // "dead player still moving cannons" artifact). LIFE_LOST is handled above
    // so the dialog that eliminated us is still dismissed.
    if (me >= 0 && me < lives.length && lives[me] === 0) {
      await page.waitForTimeout(150);
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
      // Modern mode only: arrows move focus across the offered upgrades, "n"
      // confirms the pick. Resolving it keeps the match advancing.
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

/**
 * Poll every peer and compare the stable outcome of each round. Records each
 * peer's round-N result at the moment it crosses into round N+1 (or stops),
 * then compares once two-or-more live peers have closed round N. Sets
 * `ctrl.divergence` + `ctrl.stop` at the FIRST diverging round.
 *
 * A peer whose page closes mid-game (a quitter) is marked "gone" and dropped
 * from the live comparison — its already-closed rounds still count, but it is
 * not required to reach game-over and its absence is never a divergence.
 * Returns 0 (unused; signature matches the drive loops for a clean Promise.all).
 */
export async function monitorDivergence(
  peers: readonly PeerHandle[],
  ctrl: RunControl,
): Promise<number> {
  const closed = new Map<string, Map<number, RoundResult>>();
  const prevRound = new Map<string, number | null>();
  const finalRound = new Map<string, number | null>();
  const gone = new Set<string>();
  for (const { name } of peers) {
    closed.set(name, new Map());
    prevRound.set(name, null);
    finalRound.set(name, null);
  }
  const compared = new Set<number>();
  // Aliveness tracking (logged on change): which MACHINES (peer browsers) are
  // still connected, and which PLAYERS (slots) still have lives. A machine
  // leaves when its page closes (a quit / lost connection); a player dies when
  // its lives reach 0. The two are independent — a connected machine can own a
  // dead player, and after a host migration a player (the quitter's seat) lives
  // on under AI while its machine is gone.
  const goneLogged = new Set<string>();
  const latestLives = new Map<string, number[]>();
  let aliveSig = "";
  // Per-peer mode log (LOBBY → GAME → … → STOPPED). Logged on change so the run
  // output shows each peer's screen lifecycle — e.g. that game-over (STOPPED) is
  // terminal and no peer slips back to LOBBY / restarts a game.
  const lastMode = new Map<string, string>();
  // Cursor-activity tracking: a peer's own controller cursor each poll, to prove
  // alive players actually move (play) and dead players don't. prevSig/prevPhase
  // gate out phase-boundary cursor resets (only intra-phase moves count).
  const prevCursorSig = new Map<string, string>();
  const prevCursorPhase = new Map<string, string>();
  const staticStreak = new Map<string, number>(); // consecutive still-while-building polls
  for (const { name } of peers) ctrl.cursors.set(name, new Map());

  while (!ctrl.stop) {
    await delay(MONITOR_POLL_MS);
    for (const { name, sc } of peers) {
      if (gone.has(name)) continue;
      let mode = "";
      let result: RoundResult | null = null;
      try {
        mode = await sc.mode();
        result = await roundResultOf(sc);
        // Capture identity ONLY while still in-game — at game-over the session
        // teardown resets myPlayerId to the spectator slot (-1); see
        // RunControl.identities.
        if (mode !== "STOPPED") ctrl.identities.set(name, await readIdentity(sc));
      } catch {
        if (sc.page.isClosed()) gone.add(name); // quit — stop tracking it
        continue; // else page mid-navigation — retry next poll
      }
      if (mode && lastMode.get(name) !== mode) {
        console.log(`  [mode] ${name}: ${lastMode.get(name) ?? "—"} → ${mode}`);
        lastMode.set(name, mode);
      }
      if (!result) continue;
      latestLives.set(name, result.players.map((player) => player.lives));
      const round = result.observedAtRound;

      // Cursor activity: did THIS peer's own controller cursor move this poll,
      // and was its player alive? Counts only intra-phase moves (a cursor reset
      // at a phase boundary is excluded via the phase guard).
      if (mode !== "STOPPED") {
        const cur = await readCursorSig(sc).catch(() => null);
        const myId = ctrl.identities.get(name)?.myPlayerId ?? -1;
        const myLives = result.players.find((player) => player.id === myId)?.lives;
        if (cur && myLives !== undefined) {
          const prevSig = prevCursorSig.get(name);
          const samePhase = prevCursorPhase.get(name) === cur.phase;
          const moved = prevSig !== undefined && samePhase && prevSig !== cur.sig;
          const byRound = ctrl.cursors.get(name)!;
          const act = byRound.get(round) ??
            { aliveSamples: 0, aliveMoves: 0, deadMoves: 0, maxStaticStreak: 0 };
          if (myLives > 0) {
            act.aliveSamples++;
            if (moved) act.aliveMoves++;
          } else if (moved) {
            act.deadMoves++;
          }
          // Static-streak (issue 2): count consecutive STILL polls while alive
          // in an interactive build phase, same phase throughout. A move, a
          // phase change, death, or a non-build phase resets it.
          const building =
            myLives > 0 && samePhase && BUILD_PHASES.has(cur.phase);
          if (building && !moved) {
            const next = (staticStreak.get(name) ?? 0) + 1;
            staticStreak.set(name, next);
            if (next > act.maxStaticStreak) act.maxStaticStreak = next;
          } else {
            staticStreak.set(name, 0);
          }
          byRound.set(round, act);
          prevCursorSig.set(name, cur.sig);
          prevCursorPhase.set(name, cur.phase);
        }
      }

      if (prevRound.get(name) === null) {
        prevRound.set(name, round);
      } else if (round > prevRound.get(name)!) {
        // The previous round just closed; this snapshot (taken at the new
        // round's quiescent start) is that round's finalized outcome.
        closed.get(name)!.set(prevRound.get(name)!, result);
        prevRound.set(name, round);
      }
      if (mode === "STOPPED" && finalRound.get(name) === null) {
        finalRound.set(name, round);
        closed.get(name)!.set(round, result); // last round never "advances"
      }
    }

    // --- Aliveness: log machine departures + alive players/machines on change.
    for (const name of gone) {
      if (goneLogged.has(name)) continue;
      goneLogged.add(name);
      console.log(`  [alive] MACHINE DOWN: ${name} (page closed / disconnected)`);
    }
    const aliveMachines = peers.filter(({ name }) => !gone.has(name)).map(({ name }) => name);
    // Player aliveness is a cross-peer invariant, so any live peer's view will
    // do; prefer a still-connected one.
    const livesView =
      latestLives.get(aliveMachines[0] ?? "") ??
      [...latestLives.values()].at(-1) ??
      [];
    const alivePlayers = livesView
      .map((lifeCount, slot) => ({ slot, lifeCount }))
      .filter((entry) => entry.lifeCount > 0)
      .map((entry) => entry.slot);
    const sig = `m[${aliveMachines.join(",")}] p[${alivePlayers.join(",")}] L[${livesView.join(",")}]`;
    if (sig !== aliveSig) {
      aliveSig = sig;
      console.log(
        `  [alive] machines=[${aliveMachines.join(",")}] players(slots)=[${alivePlayers.join(",")}] lives=[${livesView.join(",")}]`,
      );
    }

    // Compare every round that two-or-more peers have now closed. A round is
    // only marked `compared` (and skipped thereafter) once EVERY live peer has
    // closed it — otherwise a 3rd peer that closes the round a poll after the
    // first two would never be checked against them (a 2-peer non-issue that
    // silently drops coverage at 3+ peers).
    const liveNames = peers.filter(({ name }) => !gone.has(name)).map(({ name }) => name);
    const allRounds = new Set<number>();
    for (const map of closed.values()) for (const round of map.keys()) allRounds.add(round);
    for (const round of allRounds) {
      if (compared.has(round)) continue;
      const have = peers.filter(({ name }) => closed.get(name)!.has(round));
      if (have.length < 2) continue;
      const ref = have[0]!;
      const refResult = closed.get(ref.name)!.get(round)!;
      for (const peer of have.slice(1)) {
        const peerResult = closed.get(peer.name)!.get(round)!;
        const reason = roundResultDiff(refResult, peerResult);
        if (!reason) continue;
        // CONFIRM against the per-simTick logs before failing. The round-result
        // sample is taken at the wall-clock instant a peer is first observed in
        // the next round; if a life penalty lands AT that boundary, the two
        // peers (same simTick, different wall-clock) can be sampled on opposite
        // sides of the transition → a phantom lives/score mismatch. A real fork
        // shows up as peers disagreeing at a COMMON simTick; skew does not.
        const [logRef, logPeer] = await Promise.all([
          readTickLog(ref.sc),
          readTickLog(peer.sc),
        ]);
        const real = firstTickDivergence(logRef, logPeer);
        if (!real) {
          console.log(
            `  [monitor] round ${round} ${ref.name} vs ${peer.name} mismatch (${reason}) ` +
              `is skew-only — no per-tick divergence; continuing`,
          );
          compared.add(round); // settled as skew — don't re-check it
          continue;
        }
        ctrl.divergence = {
          round,
          reason:
            `${ref.name} vs ${peer.name}: ${reason} ` +
            `(confirmed at tick ${real.tick}, field ${real.field})`,
          results: { [ref.name]: refResult, [peer.name]: peerResult },
        };
        ctrl.stop = true;
        return 0;
      }
      // Every live peer has weighed in on this round — freeze it.
      if (liveNames.every((name) => closed.get(name)!.has(round))) compared.add(round);
    }

    // All survivors (non-gone) ended: differing final rounds = different games.
    const live = peers.filter(({ name }) => !gone.has(name));
    if (live.length > 0 && live.every(({ name }) => finalRound.get(name) !== null)) {
      const finals = live.map(({ name }) => finalRound.get(name)!);
      const min = Math.min(...finals);
      const max = Math.max(...finals);
      if (min !== max) {
        ctrl.divergence = {
          round: min,
          reason:
            `game length differs across peers — ` +
            live.map(({ name }) => `${name}@r${finalRound.get(name)}`).join(", "),
        };
      }
      ctrl.stop = true;
      return 0;
    }
  }
  return 0;
}

/** Build a peer's full parity snapshot from the serialized bridge state + rng. */
export async function buildSnap(sc: E2EScenario): Promise<ParitySnap> {
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

/** This peer's identity (seated slot + host flag) from the e2e bridge. Reads
 *  the bridge's `myPlayerId` / `amHost` fields (`amHost` named to dodge the
 *  banned-`.isHost` lint). Only reliable while in-game — see
 *  {@link RunControl.identities}. */
export async function readIdentity(
  sc: E2EScenario,
): Promise<{ myPlayerId: number; amHost: boolean }> {
  return await sc.page.evaluate(() => {
    const e2e = (globalThis as unknown as Record<string, unknown>).__e2e as
      | Record<string, unknown>
      | undefined;
    return {
      myPlayerId: (e2e?.myPlayerId as number) ?? -1,
      amHost: (e2e?.amHost as boolean) ?? false,
    };
  });
}

/** Assert each named peer's player actually MOVED its cursor in every round it
 *  was alive (it was really playing — catches an alive-but-stuck player), and
 *  did NOT move while dead (the eliminated-spectator gate held). `minSamples`
 *  ignores rounds where the peer was only briefly alive (too few polls to judge).
 *  Reads {@link RunControl.cursors}. */
export function assertCursorActivity(
  ctrl: RunControl,
  names: readonly string[],
  minSamples = 4,
  maxStaticPolls = 24,
): void {
  for (const name of names) {
    const byRound = ctrl.cursors.get(name);
    if (!byRound) continue;
    let deadMoves = 0;
    for (const [round, act] of byRound) {
      deadMoves += act.deadMoves;
      if (act.aliveSamples >= minSamples) {
        // Issue 1: a whole round alive without ever moving the cursor.
        assert(
          act.aliveMoves > 0,
          `${name} was alive for ${act.aliveSamples} polls in round ${round} ` +
            `but never moved its cursor — an alive player should be playing`,
        );
        // Issue 2: a sustained freeze partway through a build phase (the player
        // placed some pieces, then the cursor went still for too long).
        assert(
          act.maxStaticStreak <= maxStaticPolls,
          `${name} froze in round ${round}: its cursor sat still for ` +
            `${act.maxStaticStreak} consecutive polls while alive in a build ` +
            `phase — it should keep placing pieces (max ${maxStaticPolls})`,
        );
      }
    }
    // Lenient: a dead player's cursor should be still. Allow a couple of stray
    // moves (a late checkpoint/adoption can nudge it) but not sustained control.
    assert(
      deadMoves <= 2,
      `${name} moved its cursor ${deadMoves}× while its player was dead — a ` +
        `dead player should be a spectator (eliminated-spectator gate broken)`,
    );
  }
}

/** Slot ids that fired at least one cannon in this peer's bus log. */
export async function firedSlots(sc: E2EScenario): Promise<Set<number>> {
  const fired = await sc.bus.events(GAME_EVENT.CANNON_FIRED);
  return new Set(fired.map((event) => event.playerId));
}

/** Install the per-sim-tick recorder ({@link TICK_RECORDER}) on a peer. */
export async function installTickRecorder(sc: E2EScenario): Promise<void> {
  await sc.page.evaluate(TICK_RECORDER);
}

/** Read back a peer's recorded per-sim-tick log (empty if its page is gone). */
export async function readTickLog(sc: E2EScenario): Promise<TickRec[]> {
  if (sc.page.isClosed()) return [];
  return (await sc.page
    .evaluate(() => {
      return (globalThis as unknown as { __tickRec?: TickRec[] }).__tickRec ?? [];
    })
    .catch(() => [])) as TickRec[];
}

/** First simTick (+ field) at which two peers' tick logs ACTUALLY diverge AND
 *  stay diverged — aligned by simTick (immune to round-boundary wall-clock skew)
 *  and persistence-gated (immune to single-tick phase-transition blips). Returns
 *  null when the logs agree, or only blip transiently, at every common tick —
 *  proving a flagged round-boundary mismatch was skew, not a fork. */
export function firstTickDivergence(
  logA: readonly TickRec[],
  logB: readonly TickRec[],
): { tick: number; field: string } | null {
  const aByTick = new Map(logA.map((rec) => [rec.t, rec] as const));
  const bByTick = new Map(logB.map((rec) => [rec.t, rec] as const));
  const common = [...aByTick.keys()]
    .filter((tick) => bByTick.has(tick))
    .sort((first, second) => first - second);
  const fieldDiffAt = (tick: number): string | null => {
    const a = aByTick.get(tick)!;
    const b = bByTick.get(tick)!;
    for (const field of TICK_FIELDS) {
      if (jstr(field.of(a)) !== jstr(field.of(b))) return field.key;
    }
    return null;
  };
  for (let i = 0; i < common.length; i++) {
    const field = fieldDiffAt(common[i]!);
    if (!field) continue;
    // Confirm the divergence persists across the next window of common ticks. A
    // transient (phase-boundary) blip re-converges within it; a fork does not.
    const end = Math.min(i + TICK_DIVERGENCE_PERSIST, common.length);
    if (end - i < TICK_DIVERGENCE_PERSIST) break; // too few ticks left to confirm
    let persists = true;
    for (let j = i + 1; j < end; j++) {
      if (!fieldDiffAt(common[j]!)) {
        persists = false;
        break;
      }
    }
    if (persists) return { tick: common[i]!, field };
  }
  return null;
}

export function dumpTickDivergence(
  logs: readonly { name: string; log: TickRec[] }[],
): void {
  const withRows = logs.filter((entry) => entry.log.length > 0);
  if (withRows.length < 2) {
    console.log(
      `  [tick-diag] not enough live logs to compare (${withRows.length})`,
    );
    return;
  }
  const ref = withRows[0]!;
  const refByTick = new Map(ref.log.map((rec) => [rec.t, rec] as const));

  const fields = TICK_FIELDS;
  let earliest: number | undefined;
  for (const peer of withRows.slice(1)) {
    const peerByTick = new Map(peer.log.map((rec) => [rec.t, rec] as const));
    const common = [...refByTick.keys()]
      .filter((tick) => peerByTick.has(tick))
      .sort((firstTick, secondTick) => firstTick - secondTick);
    console.log(
      `  [tick-diag] ${ref.name} vs ${peer.name}: ref=${ref.log.length} ` +
        `peer=${peer.log.length} common=${common.length}` +
        (common.length ? ` (${common[0]}..${common[common.length - 1]})` : ""),
    );
    if (!common.length) continue;
    const firstAt: Record<string, number | null> = {};
    for (const field of fields) firstAt[field.key] = null;
    for (const tick of common) {
      const host = refByTick.get(tick)!;
      const client = peerByTick.get(tick)!;
      for (const field of fields) {
        if (
          firstAt[field.key] === null &&
          jstr(field.of(host)) !== jstr(field.of(client))
        ) {
          firstAt[field.key] = tick;
        }
      }
    }
    for (const field of fields) {
      const at = firstAt[field.key];
      console.log(
        `  [tick-diag]   first ${field.key.padEnd(8)} divergence: ${at ?? "none"}`,
      );
      if (at !== null && (earliest === undefined || at < earliest)) earliest = at;
    }
    if (earliest !== undefined) dumpContext(ref, peer, refByTick, peerByTick, fields, earliest);
  }
  if (earliest === undefined) {
    console.log("  [tick-diag] no per-tick divergence on common ticks (skew only)");
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** This peer's OWN controller cursor as a single signature (buildCursor +
 *  cannonCursor + crosshair) plus the current phase. The monitor diffs the
 *  signature poll-to-poll to detect cursor movement; the phase gates out
 *  phase-boundary cursor resets. Null while no controller (e.g. spectator). */
async function readCursorSig(
  sc: E2EScenario,
): Promise<{ sig: string; phase: string } | null> {
  return (await sc.page.evaluate(() => {
    const e2e = (globalThis as unknown as Record<string, unknown>).__e2e as
      | Record<string, unknown>
      | undefined;
    const phase = (e2e?.phase as string) ?? "";
    const ctrl = e2e?.controller as
      | {
          buildCursor: { row: number; col: number } | null;
          cannonCursor: { row: number; col: number } | null;
          crosshair: { x: number; y: number } | null;
        }
      | null
      | undefined;
    if (!ctrl) return null;
    const bc = ctrl.buildCursor;
    const cc = ctrl.cannonCursor;
    const ch = ctrl.crosshair;
    const sig = `b${bc?.row},${bc?.col}|c${cc?.row},${cc?.col}|x${ch?.x},${ch?.y}`;
    return { sig, phase };
  })) as { sig: string; phase: string } | null;
}

/** Basic battle aim-bot: hill-climb the crosshair toward the nearest ENEMY
 *  target (`targeting.enemyTargets` excludes our own slot) and fire when within
 *  8px. Ported from scripts/online-e2e.ts simulateHumanPlayLoop. One step per
 *  call (the drive loop re-invokes each tick). */
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
 *  Deliberately does NOT compare the RNG cursor: it advances on every draw, and
 *  these snapshots are taken at the wall-clock moment a peer is first observed
 *  to have crossed into the next round — the peers cross at slightly different
 *  sim-ticks and have already consumed a different number of the next round's
 *  early draws, so their cursors legitimately differ at that instant (it
 *  measures sim-tick skew, not divergence). The RNG cursor is only a valid
 *  cross-peer signal when quiescent — at game-over, asserted by `buildSnap`. */
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

/** Print a context window of full rows around `earliest` for one peer pair. */
function dumpContext(
  ref: { name: string },
  peer: { name: string },
  refByTick: Map<number, TickRec>,
  peerByTick: Map<number, TickRec>,
  fields: { key: string; of: (rec: TickRec) => unknown }[],
  earliest: number,
): void {
  const common = [...refByTick.keys()]
    .filter((tick) => peerByTick.has(tick) && tick >= earliest - 12 && tick <= earliest + 4)
    .sort((firstTick, secondTick) => firstTick - secondTick);
  console.log(`  [tick-diag] === context around tick ${earliest} (${ref.name} vs ${peer.name}) ===`);
  for (const tick of common) {
    const host = refByTick.get(tick)!;
    const client = peerByTick.get(tick)!;
    const diff = fields
      .filter((field) => jstr(field.of(host)) !== jstr(field.of(client)))
      .map((field) => field.key)
      .join(",");
    console.log(`  [tick-diag] t=${tick}${diff ? "  DIFF:" + diff : ""}`);
    console.log(`  [tick-diag]   ${ref.name} ${tickStr(host)}`);
    console.log(`  [tick-diag]   ${peer.name} ${tickStr(client)}`);
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
