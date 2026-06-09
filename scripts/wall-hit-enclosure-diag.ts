/**
 * Wall-hit vs enclosure diagnostic.
 *
 * Runs a modern game end-to-end (like watch-game), saves the event narrative
 * to a log file, AND captures per-round enclosure snapshots so it can answer:
 *
 *   "Which rounds had a player's walls destroyed by an ENEMY during battle,
 *    yet the player's enclosure count did NOT drop by the end of the battle?"
 *
 * Why the snapshots are needed: `enclosedTowers` is only recomputed at phase
 * boundaries (`recheckTerritory`), never mid-battle. `prepareBattleState`
 * (cannon-place-done) rechecks just before BATTLE starts, and `finalizeBattle`
 * (battle-done) rechecks again. So the enclosure count visible at:
 *   - BATTLE PHASE_START          = enclosures at battle START
 *   - the FIRST phase after BATTLE = enclosures at battle END (post-destruction)
 * Walls only get removed during battle, never added, so enclEnd <= enclStart
 * always; "did not decrease" means enclEnd === enclStart.
 *
 * An "enemy" wall destruction is a WALL_DESTROYED whose `shooterId` is set and
 * differs from the wall owner (`playerId`). Grunt melee (shooterId undefined)
 * and self-wall fire (shooterId === playerId) are tracked separately for
 * context but do NOT count as enemy hits.
 *
 * Usage:
 *   deno run -A scripts/wall-hit-enclosure-diag.ts --seed 42
 *   deno run -A scripts/wall-hit-enclosure-diag.ts --seed 42 --log /tmp/g.log
 *
 * Body wrapped in main() because Biome hoists top-level consts past their
 * init-order dependencies.
 */

import { BATTLE_MESSAGE } from "../src/shared/core/battle-events.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { createNarrativeObserver } from "../test/narrative-observer.ts";
import { createScenario, ScenarioTimeoutError } from "../test/scenario.ts";

interface Args {
  seed: number;
  mode: "classic" | "modern";
  log: string | undefined;
}

interface RoundRecord {
  round: number;
  enclStart: number[];
  enclEnd: number[];
  /** Enemy (other-player cannon) wall destructions during battle, per victim. */
  enemyDestroys: number[];
  /** Per-victim breakdown: shooter -> count. */
  enemyDestroyBy: Array<Map<number, number>>;
  /** Grunt / non-cannon wall destructions during battle, per victim. */
  gruntDestroys: number[];
  /** Self-wall destructions during battle (intentional pocket cuts), per owner. */
  selfDestroys: number[];
}

interface HeldVia {
  round: number;
  victim: number;
  enemyDestroys: number;
  enclStart: number;
  via: Record<string, number>;
  byShooterTier: Record<string, number>;
}

const PLAYER_NAMES = ["RED", "BLUE", "GOLD"] as const;

await main();

async function main(): Promise<void> {
  const args = parseArgs();
  const sc = await createScenario({
    seed: args.seed,
    mode: args.mode,
    rounds: Number.POSITIVE_INFINITY,
  });

  const narrative = createNarrativeObserver();
  narrative.attach(sc);

  const playerCount = sc.state.players.length;
  const records = new Map<number, RoundRecord>();
  // The round whose BATTLE is currently in progress (enclEnd not yet captured),
  // or null when we're outside a battle window.
  let battleRound: number | null = null;
  let lastRoundEnded = 0;
  let winnerId: number | undefined;
  let gameEnded = false;

  const blankRecord = (round: number): RoundRecord => ({
    round,
    enclStart: new Array(playerCount).fill(0),
    enclEnd: new Array(playerCount).fill(0),
    enemyDestroys: new Array(playerCount).fill(0),
    enemyDestroyBy: Array.from({ length: playerCount }, () => new Map()),
    gruntDestroys: new Array(playerCount).fill(0),
    selfDestroys: new Array(playerCount).fill(0),
  });

  const snapshotEnclosures = (): number[] =>
    sc.state.players.map((player) => player.enclosedTowers.length);

  sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
    if (ev.phase === Phase.BATTLE) {
      // Battle starting: enclosedTowers reflects prepareBattleState's recheck.
      const record = records.get(ev.round) ?? blankRecord(ev.round);
      record.enclStart = snapshotEnclosures();
      records.set(ev.round, record);
      battleRound = ev.round;
      return;
    }
    // First non-battle phase after a battle: enclosedTowers reflects
    // finalizeBattle's recheck (post-destruction). MODIFIER_REVEAL only
    // precedes BATTLE, never follows it, so any non-battle phase here is the
    // post-battle boundary. Capture once, then close the window.
    if (battleRound !== null) {
      const record = records.get(battleRound);
      if (record) record.enclEnd = snapshotEnclosures();
      battleRound = null;
    }
  });

  sc.bus.on(BATTLE_MESSAGE.WALL_DESTROYED, (ev) => {
    // Only battle-phase destructions count (grunts move walls during
    // WALL_BUILD, outside the window).
    if (battleRound === null) return;
    const record = records.get(battleRound);
    if (!record) return;
    const owner = ev.playerId;
    if (ev.shooterId === undefined) {
      record.gruntDestroys[owner]!++;
    } else if (ev.shooterId === owner) {
      record.selfDestroys[owner]!++;
    } else {
      record.enemyDestroys[owner]!++;
      const by = record.enemyDestroyBy[owner]!;
      by.set(ev.shooterId, (by.get(ev.shooterId) ?? 0) + 1);
    }
  });

  sc.bus.on(GAME_EVENT.ROUND_END, (ev) => {
    lastRoundEnded = ev.round;
  });
  sc.bus.on(GAME_EVENT.GAME_END, (ev) => {
    gameEnded = true;
    winnerId = ev.winner;
  });

  try {
    // Generous sim-ms budget (mock clock) — full to-the-death matches can run
    // dozens of rounds. ~200s sim/round, allow up to 120 rounds of headroom.
    sc.runGame({ timeoutMs: 200_000 * 120 });
  } catch (err) {
    if (!(err instanceof ScenarioTimeoutError)) throw err;
    console.error(
      `[diag] seed=${args.seed} runGame timed out (last ROUND_END r${lastRoundEnded}, gameEnded=${gameEnded}) — reporting partial`,
    );
  } finally {
    narrative.detach();
  }

  // ── Save the narrative log ──────────────────────────────────────────────
  const logPath = args.log ?? `/tmp/wall-hit-diag-seed-${args.seed}.log`;
  await Deno.writeTextFile(logPath, `${narrative.lines.join("\n")}\n`);

  // ── Report ──────────────────────────────────────────────────────────────
  const winnerLabel =
    winnerId !== undefined ? (PLAYER_NAMES[winnerId] ?? `P${winnerId}`) : "—";
  console.log(
    `\n=== seed=${args.seed} mode=${args.mode} — game ${gameEnded ? `ended r${lastRoundEnded}, winner ${winnerLabel}` : `incomplete (last r${lastRoundEnded})`} ===`,
  );
  console.log(`narrative log: ${logPath}`);

  // Per-player rolled archetype. At Normal difficulty (the headless default)
  // the archetype fixes the battleTactics tier — BUILDER/CHAOTIC → tier 1
  // (NO enclosure-breaking tactics: deny_enclosure / structural / fat_breach
  // all have probability 0), BALANCED/AGGRESSIVE → tier 2, TACTICIAN → tier 3.
  // So a wall-siege that never breaches an enclosure usually means the SHOOTER
  // is a tier-1 archetype doing pure `default` perimeter demolition.
  const archetypes = [...sc.aiArchetypes()];
  const tierOf = (arch: string | undefined): string => {
    const a = arch?.toLowerCase();
    if (a === undefined) return "?";
    if (a === "builder" || a === "chaotic") return "1 (no breach tactics)";
    if (a === "tactician") return "3";
    return "2";
  };
  console.log("archetypes (Normal difficulty → battleTactics tier):");
  for (let pid = 0; pid < playerCount; pid++) {
    console.log(
      `  ${PLAYER_NAMES[pid]}: ${archetypes[pid] ?? "?"}  tier ${tierOf(archetypes[pid])}`,
    );
  }
  const archLabel = (pid: number): string =>
    `${archetypes[pid] ?? "?"}/t${tierOf(archetypes[pid]).charAt(0)}`;

  const ordered = [...records.values()].sort((a, b) => a.round - b.round);
  // held: enemy destroyed walls, player kept a NON-ZERO enclosure (the answer
  //   to the question — enemy fire failed to break any standing enclosure).
  // trivial: enemy destroyed walls but the player had 0 enclosures anyway
  //   (nothing to lose — reported separately so it doesn't inflate the signal).
  // decreased: enemy fire actually cut the enclosure count (contrast).
  const held: string[] = [];
  const trivial: string[] = [];
  const decreased: string[] = [];

  for (const record of ordered) {
    for (let pid = 0; pid < playerCount; pid++) {
      const enemy = record.enemyDestroys[pid]!;
      if (enemy === 0) continue;
      const start = record.enclStart[pid]!;
      const end = record.enclEnd[pid]!;
      const breakdown = [...record.enemyDestroyBy[pid]!.entries()]
        .map(
          ([shooter, n]) =>
            `${PLAYER_NAMES[shooter]}(${archLabel(shooter)})×${n}`,
        )
        .join(",");
      const line = `  r${record.round} ${PLAYER_NAMES[pid]}: ${enemy} wall(s) destroyed by [${breakdown}] | enclosures ${start}→${end}`;
      if (end < start) {
        decreased.push(`${line}  (lost ${start - end})`);
      } else if (start > 0) {
        held.push(`${line}  ⟵ enclosures HELD`);
      } else {
        trivial.push(line);
      }
    }
  }

  console.log(
    `\n--- ENEMY DESTROYED WALLS BUT PLAYER KEPT A NON-ZERO ENCLOSURE (${held.length}) ---`,
  );
  if (held.length === 0) console.log("  (none)");
  else for (const line of held) console.log(line);

  console.log(
    `\n--- (trivial) enemy destroyed walls but player held 0 enclosures anyway (${trivial.length}) ---`,
  );
  if (trivial.length === 0) console.log("  (none)");
  else for (const line of trivial) console.log(line);

  console.log(
    `\n--- (contrast) enemy wall destruction THAT cut enclosures (${decreased.length}) ---`,
  );
  if (decreased.length === 0) console.log("  (none)");
  else for (const line of decreased) console.log(line);

  await emitViaAnalysis({
    seed: args.seed,
    lines: narrative.lines,
    ordered,
    playerCount,
    tierNum: (pid) => Number(tierOf(archetypes[pid]).charAt(0)),
    archetypes,
    gameEnded,
    lastRoundEnded,
    winnerId,
  });

  Deno.exit(0);
}

/** Parse the narrative's FIRE lines (each carries the AI fire-decision origin
 *  as `via:<origin>`) and histogram, per held round, the decision origin of the
 *  enemy shots aimed at the held defender's walls. Answers "why did the AI play
 *  like this" at scale: `default`/`focus_fire` = no enclosure-break plan
 *  (perimeter spray); `deny_enclosure`/`structural`/`fat_breach` = an actual
 *  min-cut attempt that nonetheless failed to drop the ring. Also writes a
 *  machine-readable per-seed JSON for cross-seed aggregation. */
async function emitViaAnalysis(opts: {
  seed: number;
  lines: readonly string[];
  ordered: RoundRecord[];
  playerCount: number;
  tierNum: (pid: number) => number;
  archetypes: (string | undefined)[];
  gameEnded: boolean;
  lastRoundEnded: number;
  winnerId: number | undefined;
}): Promise<void> {
  const { seed, ordered, playerCount, tierNum } = opts;
  const firesByRound = parseFireOrigins(opts.lines);
  const heldVia: HeldVia[] = [];
  const grandVia: Record<string, number> = {};
  const grandViaByTier: Record<string, Record<string, number>> = {};

  for (const record of ordered) {
    for (let pid = 0; pid < playerCount; pid++) {
      if (record.enemyDestroys[pid]! === 0) continue;
      const start = record.enclStart[pid]!;
      if (!(record.enclEnd[pid]! >= start && start > 0)) continue; // held only
      const fires = (firesByRound.get(record.round) ?? []).filter(
        (fire) => fire.victim === pid && fire.shooter !== pid,
      );
      const via: Record<string, number> = {};
      const byShooterTier: Record<string, number> = {};
      for (const fire of fires) {
        via[fire.origin] = (via[fire.origin] ?? 0) + 1;
        grandVia[fire.origin] = (grandVia[fire.origin] ?? 0) + 1;
        const tierKey = `t${tierNum(fire.shooter)}`;
        byShooterTier[tierKey] = (byShooterTier[tierKey] ?? 0) + 1;
        (grandViaByTier[tierKey] ??= {})[fire.origin] =
          (grandViaByTier[tierKey]?.[fire.origin] ?? 0) + 1;
      }
      heldVia.push({
        round: record.round,
        victim: pid,
        enemyDestroys: record.enemyDestroys[pid]!,
        enclStart: start,
        via,
        byShooterTier,
      });
    }
  }

  console.log(
    `\n--- "via" ORIGIN of enemy wall-aimed shots in HELD rounds (${heldVia.length}) ---`,
  );
  for (const entry of heldVia) {
    console.log(
      `  r${entry.round} ${PLAYER_NAMES[entry.victim]} (held ${entry.enclStart}e): ${histStr(entry.via) || "(no wall-aimed FIRE lines parsed)"}`,
    );
  }
  console.log(
    `\n  SEED ${seed} grand via histogram (held rounds): ${histStr(grandVia)}`,
  );

  await Deno.writeTextFile(
    `/tmp/wall-hit-via-${seed}.json`,
    JSON.stringify(
      {
        seed,
        ended: opts.gameEnded,
        lastRound: opts.lastRoundEnded,
        winner: opts.winnerId,
        archetypes: opts.archetypes.map((arch, pid) => ({
          name: arch ?? "?",
          tier: tierNum(pid),
        })),
        heldVia,
        grandVia,
        grandViaByTier,
      },
      null,
      2,
    ),
  );
}

/** Histogram → "a×3, b×1" sorted desc. */
function histStr(hist: Record<string, number>): string {
  return (
    Object.entries(hist)
      .sort((a, b) => b[1] - a[1])
      .map(([key, n]) => `${key}×${n}`)
      .join(", ") || "(empty)"
  );
}

/** Parse the narrative's FIRE lines into per-round enemy-wall-aimed shots.
 *  A FIRE line reads `  [FIRE] SHOOTER fires#N → (r,c) [TAG]` where TAG carries
 *  the impact classification (`wall:VICTIM`, `cannon:…`, `water`, …) and the AI
 *  decision origin `via:ORIGIN`. We keep only shots whose TAG aims at an enemy
 *  player's WALL (`wall:VICTIM`, VICTIM ≠ shooter), since those are the shots
 *  that chip a defender's enclosure. Round/phase context comes from the
 *  `── rN PHASE ──` header lines; only BATTLE-phase fires are collected. */
function parseFireOrigins(
  lines: readonly string[],
): Map<number, Array<{ shooter: number; victim: number; origin: string }>> {
  const out = new Map<
    number,
    Array<{ shooter: number; victim: number; origin: string }>
  >();
  const nameToPid = (name: string): number =>
    PLAYER_NAMES.indexOf(name as never);
  let round = 0;
  let inBattle = false;
  const headerRe = /^── r(\d+) (\w+)/;
  const fireRe =
    /^\s*\[FIRE\] (\w+) fires(?: \w+)?#\d+ → \(\d+,\d+\) \[(.+)\]$/;
  for (const line of lines) {
    const header = headerRe.exec(line);
    if (header) {
      round = Number(header[1]);
      inBattle = header[2] === "BATTLE";
      continue;
    }
    if (!inBattle) continue;
    const fire = fireRe.exec(line);
    if (!fire) continue;
    const shooter = nameToPid(fire[1]!);
    const tag = fire[2]!;
    const wallMatch = /\bwall:(\w+)/.exec(tag);
    const viaMatch = /\bvia:(\w+)/.exec(tag);
    if (!wallMatch || !viaMatch) continue;
    const victim = nameToPid(wallMatch[1]!);
    if (victim < 0 || shooter < 0 || victim === shooter) continue;
    const list = out.get(round) ?? [];
    list.push({ shooter, victim, origin: viaMatch[1]! });
    out.set(round, list);
  }
  return out;
}

function parseArgs(): Args {
  const argv = Deno.args;
  let seed: number | undefined;
  let mode: "classic" | "modern" = "modern";
  let log: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--seed") seed = Number(argv[++i]);
    else if (flag === "--mode") {
      const value = argv[++i];
      if (value !== "classic" && value !== "modern") {
        console.error(`Invalid --mode: ${value}`);
        Deno.exit(1);
      }
      mode = value;
    } else if (flag === "--log") log = argv[++i];
    else {
      console.error(`Unknown flag: ${flag}`);
      Deno.exit(1);
    }
  }
  if (seed === undefined) {
    console.error(
      "Usage: deno run -A scripts/wall-hit-enclosure-diag.ts --seed N [--mode modern|classic] [--log PATH]",
    );
    Deno.exit(1);
  }
  return { seed, mode, log };
}
