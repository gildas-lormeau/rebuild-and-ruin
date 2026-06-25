/**
 * replay.ts — deterministic replay/debug harness for the mcp-play server.
 *
 * Feeds a `.jsonl` of bare tool calls ({"name": ..., "arguments": {...}}, one
 * per line — exactly the shape an agent emits) through the SAME dispatch the
 * stdio server uses (`callTool` from server.ts), printing each resulting board
 * so you can watch a whole session evolve in one run. The game is seeded and
 * deterministic, so a moves file is a reproducible fixture: change the harness,
 * replay, diff the boards. No subprocess, no JSON-RPC plumbing — it drives the
 * real harness + renderer in-process.
 *
 * Usage:
 *   deno run -A scripts/mcp-play/replay.ts <moves.jsonl> [options]
 *   deno run -A scripts/mcp-play/replay.ts -            # read moves from stdin
 *   deno task replay <moves.jsonl> [options]
 *
 * Move file: one JSON object per line — {"name": "<tool>", "arguments": {...}}.
 *   Blank lines and lines starting with `#` or `//` are skipped (comments).
 *   If the first call isn't `new_game`, one is synthesized from the flags below.
 *
 * Options:
 *   --seed N      map seed for the synthesized new_game (default 42)
 *   --mode M      game mode for the synthesized new_game: classic|modern (default classic)
 *   --rounds N    rounds for the synthesized new_game (default 3)
 *   --ticks N     actionTicks for the synthesized new_game (default 30)
 *   --only-last   print only the final board (skip intermediate steps)
 *   --quiet       per step print only the ROUND / STANDINGS / LAST lines, not the
 *                 whole board (the result-at-a-glance view)
 *   --diff        replay against the recorded baseline digest (the
 *                 `.expected.jsonl` sidecar written next to the journal during
 *                 live play) and report the FIRST call where the game state
 *                 diverges — "first divergence at call N, round R, phase P" with
 *                 the changed fields. Exit 1 on any divergence, 0 if identical.
 *                 This is how you tell whether a code change affects the recorded
 *                 game, and exactly where. Needs a journal FILE, not stdin.
 *
 * Exit code is 1 if any call errored (so a committed journal doubles as a smoke
 * test); a `check_placement` returning { valid:false } is a normal result, NOT
 * an error, so intentional-rejection fixtures still exit 0.
 *
 * dev/research tool — never wired into determinism or parity suites.
 */

import { callTool, observationDigest } from "./server.ts";

interface Call {
  name: string;
  arguments?: Record<string, unknown>;
}

type Digest = ReturnType<typeof observationDigest>;

const VALUE_FLAGS = new Set(["seed", "mode", "rounds", "ticks"]);

// Replaying drives the same callTool dispatch the live server uses — but it must
// NOT write the auto-journal, or replaying a saved journal would clobber
// `tmp/mcp-play/last.jsonl` (the live game being debugged) with this re-run.
Deno.env.set("MCP_PLAY_NO_JOURNAL", "1");

await main();

async function main(): Promise<void> {
  const { positionals, opts } = parseArgv(Deno.args);
  if (opts.help || positionals.length === 0) {
    console.error(
      "usage: deno run -A scripts/mcp-play/replay.ts <moves.jsonl|-> " +
        "[--seed N] [--mode classic|modern] [--rounds N] [--ticks N] [--only-last] [--quiet] [--diff]",
    );
    Deno.exit(opts.help ? 0 : 2);
  }

  const raw =
    positionals[0] === "-"
      ? await new Response(Deno.stdin.readable).text()
      : await Deno.readTextFile(positionals[0]!);
  const calls = parseCalls(raw);

  // Synthesize new_game from the flags unless the file opens with one.
  if (calls.length === 0 || calls[0]!.name !== "new_game") {
    calls.unshift({
      name: "new_game",
      arguments: {
        seed: numOpt(opts.seed, 42),
        ...(opts.mode === "modern" ? { mode: "modern" } : {}),
        rounds: numOpt(opts.rounds, 3),
        actionTicks: numOpt(opts.ticks, 30),
      },
    });
  }

  // --diff: replay against the recorded baseline digest and report the FIRST
  // divergence (call index + round/phase + field deltas) instead of boards.
  if (opts.diff) {
    await runDiff(calls, positionals[0]!);
    return;
  }

  let errors = 0;
  for (let i = 0; i < calls.length; i++) {
    const { name, arguments: args = {} } = calls[i]!;
    const { text, isError } = await callTool(name, args);
    if (isError) errors++;
    const isLast = i === calls.length - 1;
    if (opts["only-last"] && !isLast) continue;
    console.log(
      `\n━━ [${i}] ${name}${summarizeArgs(args)}${isError ? "  ✗ ERROR" : ""} ━━`,
    );
    console.log(opts.quiet ? concise(text) : text);
  }

  if (errors > 0) console.error(`\nreplay: ${errors} call(s) errored`);
  Deno.exit(errors > 0 ? 1 : 0);
}

/** Replay the journal against its recorded baseline digest, reporting the FIRST
 *  call where the resulting game state diverges (or confirming identity). The
 *  baseline is the `.expected.jsonl` sidecar written next to the journal during
 *  live play. Exits 1 on any divergence (or errored call), 0 if identical, 2 on
 *  a usage/baseline problem. */
async function runDiff(calls: Call[], journalPath: string): Promise<void> {
  if (journalPath === "-") {
    console.error(
      "replay --diff needs a journal FILE (to find its .expected.jsonl sidecar), not stdin",
    );
    Deno.exit(2);
  }
  const expectedPath = journalPath.endsWith(".jsonl")
    ? journalPath.replace(/\.jsonl$/, ".expected.jsonl")
    : `${journalPath}.expected.jsonl`;
  let expectedRaw: string;
  try {
    expectedRaw = await Deno.readTextFile(expectedPath);
  } catch {
    console.error(
      `replay --diff: baseline not found: ${expectedPath}\n` +
        "(it's written next to the journal during live play)",
    );
    Deno.exit(2);
  }
  const expected = new Map<number, Digest>();
  for (const line of expectedRaw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const digest = JSON.parse(trimmed) as Digest & { i: number };
    expected.set(digest.i, digest);
  }

  for (let i = 0; i < calls.length; i++) {
    const { name, arguments: args = {} } = calls[i]!;
    const { text, isError } = await callTool(name, args);
    if (isError) {
      console.log(
        `✗ call [${i}] ${name}${summarizeArgs(args)} ERRORED under current code:`,
      );
      console.log(`    ${text.split("\n")[0]}`);
      Deno.exit(1);
    }
    const baseline = expected.get(i);
    if (!baseline) continue; // no recorded digest (non-observation call)
    const actual = await currentDigest();
    const diffs = digestDiffs(baseline, actual);
    if (diffs.length > 0) {
      console.log(
        `✗ DIVERGENCE at call [${i}] ${name}${summarizeArgs(args)} — ` +
          `round ${actual.round} ${actual.phase}`,
      );
      for (const diff of diffs) console.log(`    ${diff}`);
      console.log(`(${i} call(s) reproduced identically before this point)`);
      Deno.exit(1);
    }
  }
  const last = expected.get(calls.length - 1);
  console.log(
    `✓ identical to baseline through ${calls.length} call(s)` +
      (last ? ` (ended round ${last.round} ${last.phase})` : ""),
  );
  Deno.exit(0);
}

/** The digest of the CURRENT game state, via a read-only observe (no clock
 *  advance) so the comparison never perturbs the replay. */
async function currentDigest(): Promise<Digest> {
  const { text } = await callTool("observe", { format: "json" });
  return observationDigest(
    JSON.parse(text) as Parameters<typeof observationDigest>[0],
  );
}

/** Human-readable field deltas between a baseline digest and the replayed one —
 *  empty array = identical. */
function digestDiffs(expected: Digest, actual: Digest): string[] {
  const diffs: string[] = [];
  if (expected.round !== actual.round) {
    diffs.push(`round ${expected.round} → ${actual.round}`);
  }
  if (expected.phase !== actual.phase) {
    diffs.push(`phase ${expected.phase} → ${actual.phase}`);
  }
  if (expected.gameOver !== actual.gameOver) {
    diffs.push(`gameOver ${expected.gameOver} → ${actual.gameOver}`);
  }
  const count = Math.max(expected.players.length, actual.players.length);
  for (let slot = 0; slot < count; slot++) {
    const before = expected.players[slot];
    const after = actual.players[slot];
    if (!before || !after) {
      diffs.push(`player[${slot}] ${before ? "removed" : "added"}`);
      continue;
    }
    const keys = [
      "lives",
      "eliminated",
      "score",
      "projected",
      "walls",
      "cannons",
      "enclosedTowers",
    ] as const;
    for (const key of keys) {
      if (before[key] !== after[key]) {
        diffs.push(`P${after.slot}.${key} ${before[key]} → ${after[key]}`);
      }
    }
  }
  return diffs;
}

/** Split positionals from flags. Flags in VALUE_FLAGS consume the next token as
 *  their value; everything else is a boolean switch (so `--only-last <path>`
 *  doesn't swallow the path). */
function parseArgv(argv: string[]): {
  positionals: string[];
  opts: Record<string, string | boolean>;
} {
  const positionals: string[] = [];
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (VALUE_FLAGS.has(key)) opts[key] = argv[++i] ?? "";
      else opts[key] = true;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, opts };
}

/** Parse the move lines, skipping blanks and `#` / `//` comment lines. */
function parseCalls(raw: string): Call[] {
  const calls: Call[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    try {
      calls.push(JSON.parse(line) as Call);
    } catch {
      throw new Error(`replay: line ${i + 1} is not valid JSON: ${line}`);
    }
  }
  return calls;
}

/** The result-at-a-glance lines from a rendered board (or the whole text for a
 *  non-board JSON payload). */
function concise(text: string): string {
  const picked = text
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("ROUND ") ||
        line.startsWith("STANDINGS") ||
        line.startsWith("LAST:"),
    );
  return picked.length > 0 ? picked.join("\n") : text;
}

/** Compact one-line render of a call's args, e.g. `(slot=1)`. */
function summarizeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  return `(${keys.map((key) => `${key}=${JSON.stringify(args[key])}`).join(", ")})`;
}

function numOpt(value: string | boolean | undefined, fallback: number): number {
  return typeof value === "string" && value !== "" ? Number(value) : fallback;
}
