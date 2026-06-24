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
 *
 * Exit code is 1 if any call errored (so a committed journal doubles as a smoke
 * test); a `check_placement` returning { valid:false } is a normal result, NOT
 * an error, so intentional-rejection fixtures still exit 0.
 *
 * dev/research tool — never wired into determinism or parity suites.
 */

import { callTool } from "./server.ts";

interface Call {
  name: string;
  arguments?: Record<string, unknown>;
}

const VALUE_FLAGS = new Set(["seed", "mode", "rounds", "ticks"]);

await main();

async function main(): Promise<void> {
  const { positionals, opts } = parseArgv(Deno.args);
  if (opts.help || positionals.length === 0) {
    console.error(
      "usage: deno run -A scripts/mcp-play/replay.ts <moves.jsonl|-> " +
        "[--seed N] [--mode classic|modern] [--rounds N] [--ticks N] [--only-last] [--quiet]",
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
