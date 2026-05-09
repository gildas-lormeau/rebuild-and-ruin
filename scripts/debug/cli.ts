#!/usr/bin/env -S deno run -A
/**
 * CLI for the per-session debugger daemon.
 *
 * Each subcommand is a one-shot Bash invocation; persistent state lives in
 * the daemon process spawned by `launch`. Sessions are identified by a short
 * id (default "default" — single-session is the common case).
 *
 * Usage:
 *   debug launch  [--session ID] [--restart] [--node | --deno-test | --deno-run] -- <cmd> [args...]
 *   debug rerun   [--session ID]                       # close + relaunch with prior cmd
 *   debug bp      [--session ID] <file>:<line-or-snippet> [--cond <expr>]
 *   debug capture [--session ID] <file>:<line-or-snippet> <expr> [<expr>...] [--cond <expr>]
 *   debug rm      [--session ID] <bpId | file:line-or-snippet>
 *   debug run     [--session ID] [--wait <ms>]   # resume + wait for exit
 *   debug continue [--session ID]
 *   debug step    [--session ID] [over|into|out]
 *   debug eval    [--session ID] <expr> [--frame N]
 *   debug trace   [--session ID] [--since N] [--format json|table] [--mark-stack-changes]
 *                 [--partition-by <expr> --out <prefix> [--sort] [--with-caller]]   # diffable per-partition logs
 *   debug stacks  [--session ID] [--format json]
 *   debug stack   [--session ID] <hit#>
 *   debug status  [--session ID]
 *   debug logs    [--session ID] [--stderr | --stdout | --daemon]
 *   debug close   [--session ID]
 *   debug list                                    # list active sessions
 *
 * Targets (bp/capture/rm) accept either `file:N` (line number) or
 * `file:snippet` (substring of the line's source — line-drift-resistant).
 * Snippet form reads the file at command time, finds the unique line, and
 * submits that line number; errors on 0 or >1 matches. Quote in shell to
 * preserve spaces/parens, e.g.
 *   debug capture 'src/foo.ts:if (state.phase ===' state.phase
 *
 * Convenience launch flags inject --inspect-brk in the right position:
 *   --node       node --inspect-brk=127.0.0.1:0 ARGS...
 *   --deno-run   deno run --inspect-brk=127.0.0.1:0 -A ARGS...
 *   --deno-test  deno test --inspect-brk=127.0.0.1:0 --no-check ARGS...
 *
 * Without a convenience flag, the user's command is run as-is — they are
 * responsible for including --inspect-brk=127.0.0.1:0 (port 0 is required;
 * fixed ports collide across sessions).
 */

interface ParsedArgs {
  session: string;
  flags: Map<string, string | boolean>;
  positional: string[];
  rest: string[];
}

interface IpcResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface TraceFrame {
  name: string;
  url: string;
  line: number;
}

interface TraceHit {
  ts: number;
  bpId: string;
  file: string;
  line: number;
  values: Record<string, unknown>;
  frames?: TraceFrame[];
}

const SESSIONS_ROOT = "/tmp/debug-sessions";
const DAEMON_PATH = new URL("./daemon.ts", import.meta.url).pathname;
const [subcommand, ...rest] = Deno.args;
const parsed = parseArgs(rest);
const dispatch: Record<string, (p: ParsedArgs) => Promise<void>> = {
  launch: cmdLaunch,
  rerun: cmdRerun,
  bp: cmdBp,
  capture: cmdCapture,
  rm: cmdRm,
  run: cmdRun,
  continue: cmdContinue,
  step: cmdStep,
  eval: cmdEval,
  trace: cmdTrace,
  stacks: cmdStacks,
  stack: cmdStack,
  status: cmdStatus,
  logs: cmdLogs,
  close: cmdClose,
  list: () => cmdList(),
};
const fn = dispatch[subcommand];
// Repo root = two dirs up from cli.ts (scripts/debug/cli.ts → repo root).
// Computed once at load so frame-URL → repo-relative conversion is a
// pure string strip with no per-hit filesystem calls. The daemon already
// snapshots frames inline with each pause event (free, no CDP round-trip),
// so embedding caller in the trace adds zero latency on the hot path —
// we just reach into hit.frames[1] (frames[0] is the bp itself).
const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

function parseArgs(args: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  let rest: string[] = [];
  let session = "default";
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "--") {
      rest = args.slice(i + 1);
      break;
    }
    if (a === "--session") {
      session = args[++i];
    } else if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(a.slice(2), next);
        i++;
      } else {
        flags.set(a.slice(2), true);
      }
    } else {
      positional.push(a);
    }
    i++;
  }
  return { session, flags, positional, rest };
}

async function cmdLaunch(parsed: ParsedArgs): Promise<void> {
  if (parsed.flags.has("restart")) {
    await killExistingSession(parsed.session);
  }
  const cmd = buildLaunchCmd(parsed);
  await launchWithCmd(parsed.session, cmd);
}

async function cmdRerun(parsed: ParsedArgs): Promise<void> {
  const sessionDir = `${SESSIONS_ROOT}/${parsed.session}`;
  let cmd: string[];
  try {
    const json = await Deno.readTextFile(`${sessionDir}/cmd.json`);
    cmd = JSON.parse(json) as string[];
  } catch {
    throw new Error(
      `no prior cmd recorded for session "${parsed.session}". Run \`debug launch\` first.`,
    );
  }
  await killExistingSession(parsed.session);
  await launchWithCmd(parsed.session, cmd);
}

async function launchWithCmd(session: string, cmd: string[]): Promise<void> {
  const sessionDir = `${SESSIONS_ROOT}/${session}`;
  await Deno.mkdir(sessionDir, { recursive: true });

  // Clean stale state from a prior session of the same name.
  for (const f of ["socket", "ready", "error", "daemon.log"]) {
    try {
      await Deno.remove(`${sessionDir}/${f}`);
    } catch {
      // not present
    }
  }
  // Persist the cmd so `rerun` can replay it.
  await Deno.writeTextFile(`${sessionDir}/cmd.json`, JSON.stringify(cmd));

  const child = new Deno.Command("deno", {
    args: ["run", "-A", DAEMON_PATH, session, "--", ...cmd],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  // Detach so the CLI process can exit independently of the daemon.
  child.unref();
  await Deno.writeTextFile(`${sessionDir}/daemon.pid`, String(child.pid));

  const readyPath = `${sessionDir}/ready`;
  const errorPath = `${sessionDir}/error`;
  const start = Date.now();
  while (Date.now() - start < 12_000) {
    try {
      await Deno.stat(readyPath);
      console.log(
        JSON.stringify({ session, cmd, pid: child.pid, status: "ready" }),
      );
      return;
    } catch {
      // not ready
    }
    try {
      const err = await Deno.readTextFile(errorPath);
      throw new Error(`daemon failed: ${err}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("daemon failed")) throw e;
      // error file not present yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `daemon did not become ready within 12s (see ${sessionDir}/daemon.log)`,
  );
}

async function killExistingSession(session: string): Promise<void> {
  const sessionDir = `${SESSIONS_ROOT}/${session}`;
  const socketPath = `${sessionDir}/socket`;
  try {
    await Deno.stat(socketPath);
  } catch {
    return; // not running
  }
  // Try graceful close via IPC.
  try {
    await sendIpc(session, "close");
  } catch {
    // socket dead or daemon already gone
  }
  // Wait for the socket file to disappear.
  const start = Date.now();
  while (Date.now() - start < 2_000) {
    try {
      await Deno.stat(socketPath);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      return; // gone
    }
  }
  // Hard kill if still alive.
  try {
    const pid = Number(await Deno.readTextFile(`${sessionDir}/daemon.pid`));
    if (Number.isFinite(pid) && pid > 0) Deno.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
  // Clear lingering socket file so the next listen() doesn't EADDRINUSE.
  try {
    await Deno.remove(socketPath);
  } catch {
    // already gone
  }
}

function buildLaunchCmd(parsed: ParsedArgs): string[] {
  if (parsed.rest.length === 0) {
    throw new Error("launch requires a command after --");
  }
  if (parsed.flags.has("node")) {
    return ["node", "--inspect-brk=127.0.0.1:0", ...parsed.rest];
  }
  // Deno test wedges under --inspect-brk (test runner ignores
  // runIfWaitingForDebugger), so we use --inspect-wait: runtime waits for
  // the debugger to attach but doesn't break on first user line.
  if (parsed.flags.has("deno-run")) {
    return ["deno", "run", "--inspect-wait=127.0.0.1:0", "-A", ...parsed.rest];
  }
  if (parsed.flags.has("deno-test")) {
    // The Deno test runner wraps test bodies so user breakpoints don't fire
    // inside them. Run via our shim instead — same Deno.test API, but
    // tests execute as plain function calls under `deno run`, which makes
    // bps behave normally. First positional arg = test file; second
    // (optional) = filter substring.
    const runner = new URL("./run-test.ts", import.meta.url).pathname;
    return [
      "deno",
      "run",
      "--inspect-wait=127.0.0.1:0",
      "-A",
      runner,
      ...parsed.rest,
    ];
  }
  return parsed.rest;
}

async function cmdBp(parsed: ParsedArgs): Promise<void> {
  const target = parsed.positional[0];
  if (!target) throw new Error("bp requires <file>:<line-or-snippet>");
  const { file, line, via } = await resolveTarget(target);
  const condition = parsed.flags.get("cond");
  const result = await sendIpc(parsed.session, "setBreakpoint", {
    file,
    line,
    ...(typeof condition === "string" ? { condition } : {}),
  });
  console.log(JSON.stringify(enrichWithResolved(result, via, line)));
}

async function cmdCapture(parsed: ParsedArgs): Promise<void> {
  const target = parsed.positional[0];
  const exprs = parsed.positional.slice(1);
  if (!target) throw new Error("capture requires <file>:<line-or-snippet>");
  if (exprs.length === 0)
    throw new Error("capture requires at least one expression");
  const { file, line, via } = await resolveTarget(target);
  const condition = parsed.flags.get("cond");
  const result = await sendIpc(parsed.session, "setCapture", {
    file,
    line,
    exprs,
    ...(typeof condition === "string" ? { condition } : {}),
  });
  console.log(JSON.stringify(enrichWithResolved(result, via, line)));
}

function enrichWithResolved(
  result: unknown,
  via: { snippet: string } | undefined,
  line: number,
): unknown {
  if (!via) return result;
  if (typeof result !== "object" || result === null) return result;
  return {
    ...(result as Record<string, unknown>),
    resolvedFrom: { snippet: via.snippet, line },
  };
}

async function cmdRm(parsed: ParsedArgs): Promise<void> {
  const arg = parsed.positional[0];
  if (!arg) throw new Error("rm requires <bpId> or <file>:<line-or-snippet>");
  // V8-issued bpIds can contain colons (e.g. "1:0:0:file:///..."), so we only
  // attempt snippet resolution when the prefix names a real file. This keeps
  // opaque bpIds passing straight through to the daemon.
  let bpId = arg;
  const idx = arg.indexOf(":");
  if (idx > 0 && !/^.+:\d+$/.test(arg)) {
    const candidateFile = arg.slice(0, idx);
    const stat = await Deno.stat(candidateFile).catch(() => null);
    if (stat?.isFile) {
      const { file, line } = await resolveTarget(arg);
      bpId = `${file}:${line}`;
    }
  }
  const result = await sendIpc(parsed.session, "removeBreakpoint", { bpId });
  console.log(JSON.stringify(result));
}

async function resolveTarget(
  arg: string,
): Promise<{ file: string; line: number; via?: { snippet: string } }> {
  // Line form is tried first so existing `file:N` invocations are unchanged.
  const lineMatch = arg.match(/^(.+):(\d+)$/);
  if (lineMatch) return { file: lineMatch[1], line: Number(lineMatch[2]) };
  // First-colon split: paths on darwin/linux don't contain colons, but a
  // snippet might (e.g. `state.phase: BATTLE`), so split on the first one.
  const idx = arg.indexOf(":");
  if (idx <= 0) {
    throw new Error(`expected <file>:<line> or <file>:<snippet>, got "${arg}"`);
  }
  const file = arg.slice(0, idx);
  const snippet = arg.slice(idx + 1);
  const line = await resolveSnippet(file, snippet);
  return { file, line, via: { snippet } };
}

async function resolveSnippet(file: string, snippet: string): Promise<number> {
  let text: string;
  try {
    text = await Deno.readTextFile(file);
  } catch (e) {
    throw new Error(`cannot read ${file}: ${(e as Error).message}`);
  }
  const lines = text.split("\n");
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(snippet)) matches.push(i + 1);
  }
  if (matches.length === 0) {
    throw new Error(`no line matched ${JSON.stringify(snippet)} in ${file}`);
  }
  if (matches.length > 1) {
    const preview = matches
      .slice(0, 10)
      .map((l) => `${file}:${l}`)
      .join(", ");
    const rest = matches.length > 10 ? `, … (${matches.length - 10} more)` : "";
    throw new Error(
      `snippet ${JSON.stringify(snippet)} matched ${matches.length} lines: ${preview}${rest}; refine`,
    );
  }
  return matches[0];
}

async function cmdRun(parsed: ParsedArgs): Promise<void> {
  const cont = await sendIpc(parsed.session, "continue");
  console.log(JSON.stringify(cont));
  const wait = parsed.flags.get("wait");
  const timeoutMs = typeof wait === "string" ? Number(wait) : 30_000;
  const result = await sendIpc(parsed.session, "waitForExit", { timeoutMs });
  console.log(JSON.stringify(result));
}

async function cmdContinue(parsed: ParsedArgs): Promise<void> {
  const result = await sendIpc(parsed.session, "continue");
  console.log(JSON.stringify(result));
}

async function cmdStep(parsed: ParsedArgs): Promise<void> {
  const kind = parsed.positional[0] ?? "over";
  const result = await sendIpc(parsed.session, "step", { kind });
  console.log(JSON.stringify(result));
}

async function cmdEval(parsed: ParsedArgs): Promise<void> {
  const expr = parsed.positional.join(" ");
  if (!expr) throw new Error("eval requires <expr>");
  const frame = parsed.flags.get("frame");
  const params: Record<string, unknown> = { expr };
  if (typeof frame === "string") params.frameDepth = Number(frame);
  const result = await sendIpc(parsed.session, "eval", params);
  console.log(JSON.stringify(result));
}

async function cmdTrace(parsed: ParsedArgs): Promise<void> {
  const since = parsed.flags.get("since");
  const params: Record<string, unknown> = {};
  if (typeof since === "string") params.since = Number(since);
  const result = (await sendIpc(parsed.session, "trace", params)) as {
    hits: TraceHit[];
    total: number;
  };
  // `--partition-by <expr> --out <prefix>` writes one file per unique
  // value of <expr>, each containing that partition's hits in arrival
  // order — formatted so two files can be `diff`d directly. Designed
  // for multi-peer parity testing: partition by `state.debugTag` (or
  // similar discriminator captured at every hit) and the Nth line of
  // each peer's file represents the Nth equivalent event for that peer.
  // First differing line in `diff` = first divergent event. Add `--sort`
  // for set-style diffing (lines sorted per partition; `diff` reports the
  // symmetric difference regardless of arrival order). Add `--with-caller`
  // to embed the immediate caller frame (one frame above the bp) on each
  // line — turns "this draw N differs from the other side's draw N"
  // questions into a single-pass diagnosis (different caller? different
  // phase? same caller, different inputs?) without round-tripping through
  // `debug stack <hit#>` for each side.
  const partitionExpr = parsed.flags.get("partition-by");
  const outPrefix = parsed.flags.get("out");
  if (typeof partitionExpr === "string") {
    if (typeof outPrefix !== "string") {
      throw new Error("--partition-by requires --out <prefix>");
    }
    const sortLines = parsed.flags.get("sort") === true;
    const withCaller = parsed.flags.get("with-caller") === true;
    writePartitionedTrace(
      result.hits,
      partitionExpr,
      outPrefix,
      sortLines,
      withCaller,
    );
    return;
  }
  if (parsed.flags.get("format") === "table") {
    const markStack = parsed.flags.get("mark-stack-changes") === true;
    printTrace(result.hits, { markStack });
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

/** Group hits by `<partitionExpr>` value, write one diffable file per
 *  partition. Each line: `file:line [caller=<file>:<line>] <expr1>=<value1> ...`
 *  (sorted user keys, JSON-stable values; the partition discriminator
 *  is omitted since it's redundant within a partition). LINES PRESERVE
 *  ARRIVAL ORDER within each partition — when both peers hit the same
 *  breakpoint the same number of times in lockstep, line N of each
 *  file is the Nth equivalent event, so the first `<` / `>` line in
 *  `diff` is the chronologically first divergent event. That's the
 *  whole point of the workflow.
 *
 *  Pass `--sort` for set-style diffing instead: lines are sorted
 *  alphabetically per partition, so `diff` reports the symmetric
 *  difference of values regardless of when each side produced them.
 *  Useful when the same code path fires in slightly different temporal
 *  orders across peers (async timing, wire-vs-local) and you only care
 *  whether the same set of events occurred — not when. The default is
 *  arrival order; users who want set-mode opt in.
 *
 *  Pass `--with-caller` to embed the immediate caller frame (the
 *  function that called the function holding the bp) on each line as
 *  `caller=<repo-relative-file>:<line>`. The frame data is already
 *  captured per-hit by the daemon (zero extra CDP traffic — same data
 *  powers `debug stack <hit#>`), so this flag is free at trace time.
 *  Placed as a fixed token immediately after `file:line`, BEFORE the
 *  alphabetized user keys, because it's a meta-field that contextualizes
 *  the hit rather than a captured value — sorting it among user keys
 *  would scatter it depending on which other names the user picked.
 *
 *  Whatever expressions the user captured ARE the diff — the tool
 *  doesn't filter, doesn't add fields beyond the opt-in `caller`. To
 *  remove a captured field from the diff, don't capture it. */
function writePartitionedTrace(
  hits: TraceHit[],
  partitionExpr: string,
  outPrefix: string,
  sortLines: boolean,
  withCaller: boolean,
): void {
  const partitions = new Map<string, string[]>();
  for (const h of hits) {
    const partKey = formatValue(h.values[partitionExpr]);
    let lines = partitions.get(partKey);
    if (!lines) {
      lines = [];
      partitions.set(partKey, lines);
    }
    const exprs = Object.keys(h.values)
      .filter((k) => k !== partitionExpr)
      .sort();
    const values = exprs
      .map((e) => `${e}=${formatValue(h.values[e])}`)
      .join(" ");
    // Default-mode line shape preserved exactly: `file:line <space> <values>`
    // (trailing space when no other captures exist beyond the partition
    // discriminator — kept as-is so prior diffs remain byte-identical).
    // With `--with-caller` we insert ` caller=<file>:<line>` between
    // `file:line` and the user keys; the values may still be empty.
    const callerToken = withCaller ? ` caller=${formatCaller(h)}` : "";
    lines.push(`${h.file}:${h.line}${callerToken} ${values}`);
  }
  if (partitions.size === 0) {
    console.log("(no captures)");
    return;
  }
  const written: string[] = [];
  for (const [partKey, lines] of partitions) {
    if (sortLines) lines.sort();
    const safe = partKey.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${outPrefix}-${safe}.log`;
    Deno.writeTextFileSync(path, lines.join("\n") + "\n");
    written.push(`  ${path} (${lines.length} hits)`);
  }
  console.log(`partitioned trace by ${partitionExpr}:`);
  for (const w of written) console.log(w);
  if (partitions.size === 2) {
    const [a, b] = [...partitions.keys()].sort();
    const safeA = a.replace(/[^a-zA-Z0-9._-]/g, "_");
    const safeB = b.replace(/[^a-zA-Z0-9._-]/g, "_");
    console.log(`\nfirst-divergence diff:`);
    console.log(`  diff ${outPrefix}-${safeA}.log ${outPrefix}-${safeB}.log`);
  }
}

async function cmdStacks(parsed: ParsedArgs): Promise<void> {
  const result = (await sendIpc(parsed.session, "stacks")) as {
    stacks: Array<{
      key: string;
      count: number;
      firstHit: number;
      lastHit: number;
      frames: TraceFrame[];
    }>;
    totalHits: number;
  };
  if (parsed.flags.get("format") === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.stacks.length === 0) {
    console.log("(no captures)");
    return;
  }
  const header = ["count", "first", "last", "stack"];
  const rows = result.stacks.map((s) => [
    String(s.count),
    String(s.firstHit),
    String(s.lastHit),
    s.key || "<no frames>",
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(fmt(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(fmt(r));
  console.log(
    `\n${result.stacks.length} unique stacks across ${result.totalHits} hits`,
  );
}

async function cmdStack(parsed: ParsedArgs): Promise<void> {
  const arg = parsed.positional[0];
  if (arg === undefined) throw new Error("stack requires <hit-index>");
  const hit = Number(arg);
  if (!Number.isFinite(hit)) throw new Error(`invalid hit index: "${arg}"`);
  const result = (await sendIpc(parsed.session, "stack", { hit })) as {
    hit: number;
    loc: string;
    frames: TraceFrame[];
  };
  console.log(`hit ${result.hit} @ ${result.loc}`);
  for (const f of result.frames) {
    const where = f.url ? `${f.url}:${f.line}` : `(line ${f.line})`;
    console.log(`  ${f.name}  ${where}`);
  }
}

function printTrace(
  hits: TraceHit[],
  opts: { markStack: boolean } = { markStack: false },
): void {
  if (hits.length === 0) {
    console.log("(no captures)");
    return;
  }
  const exprs = Array.from(new Set(hits.flatMap((h) => Object.keys(h.values))));
  const t0 = hits[0].ts;
  // Stack-change marker: '*' on rows where frames differ from the previous hit.
  const stackMark = (i: number): string => {
    if (!opts.markStack) return "";
    const cur = (hits[i].frames ?? []).map((f) => f.name).join("|");
    const prev =
      i === 0 ? null : (hits[i - 1].frames ?? []).map((f) => f.name).join("|");
    return prev === null || prev !== cur ? "*" : " ";
  };
  const header = opts.markStack
    ? ["#", "△", "+ms", "loc", ...exprs]
    : ["#", "+ms", "loc", ...exprs];
  const rows = hits.map((h, i) => {
    const base = [
      String(i),
      String(h.ts - t0),
      `${h.file}:${h.line}`,
      ...exprs.map((e) => formatValue(h.values[e])),
    ];
    return opts.markStack ? [base[0], stackMark(i), ...base.slice(1)] : base;
  });
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(fmt(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(fmt(r));
}

function formatValue(v: unknown): string {
  if (v === undefined) return "—";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function formatCaller(h: TraceHit): string {
  const callerFrame = h.frames?.[1];
  if (!callerFrame || !callerFrame.url) return "<unknown>";
  return `${frameUrlToRepoRelative(callerFrame.url)}:${callerFrame.line}`;
}

function frameUrlToRepoRelative(url: string): string {
  // Frame URLs from CDP are file:// URLs. Strip the scheme + repo prefix
  // (handling macOS's /private/tmp realpath quirk) so the token reads as
  // `caller=src/foo.ts:42` — same shape as the user-supplied bp paths
  // already shown in `file:line` at the start of every line. Built-ins,
  // node:internal, data: URIs and other non-file URLs fall through to
  // <unknown>.
  if (!url.startsWith("file://")) return "<unknown>";
  let path = url.slice("file://".length);
  if (path.startsWith("/private")) path = path.slice("/private".length);
  let root = REPO_ROOT;
  if (root.startsWith("/private")) root = root.slice("/private".length);
  if (path.startsWith(root + "/")) return path.slice(root.length + 1);
  return path; // outside repo (npm dep, deno cache, etc.) — keep absolute
}

async function cmdStatus(parsed: ParsedArgs): Promise<void> {
  const result = await sendIpc(parsed.session, "status");
  console.log(JSON.stringify(result, null, 2));
}

async function cmdLogs(parsed: ParsedArgs): Promise<void> {
  const which = parsed.flags.get("daemon")
    ? "daemon.log"
    : parsed.flags.get("stderr")
      ? "stderr.log"
      : "stdout.log";
  const path = `${SESSIONS_ROOT}/${parsed.session}/${which}`;
  const text = await Deno.readTextFile(path);
  console.log(text);
}

async function cmdClose(parsed: ParsedArgs): Promise<void> {
  try {
    await sendIpc(parsed.session, "close");
  } catch (e) {
    console.error(`close warning: ${(e as Error).message}`);
  }
  const sessionDir = `${SESSIONS_ROOT}/${parsed.session}`;
  await new Promise((r) => setTimeout(r, 300));
  try {
    await Deno.remove(sessionDir, { recursive: true });
  } catch {
    // already gone
  }
  console.log(JSON.stringify({ session: parsed.session, closed: true }));
}

async function sendIpc(
  session: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const socketPath = `${SESSIONS_ROOT}/${session}/socket`;
  try {
    await Deno.stat(socketPath);
  } catch {
    throw new Error(
      `no daemon for session "${session}" (socket not found at ${socketPath}). Run \`debug launch\` first.`,
    );
  }
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  const writer = conn.writable.getWriter();
  const reader = conn.readable.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  try {
    await writer.write(
      encoder.encode(`${JSON.stringify({ id: 1, method, params })}\n`),
    );
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const nl = buf.indexOf("\n");
      if (nl === -1) continue;
      const line = buf.slice(0, nl);
      const resp = JSON.parse(line) as IpcResponse;
      if (!resp.ok) throw new Error(resp.error ?? "ipc failure");
      return resp.result;
    }
    throw new Error("daemon closed connection without response");
  } finally {
    try {
      writer.releaseLock();
      reader.releaseLock();
      conn.close();
    } catch {
      // already closed
    }
  }
}

async function cmdList(): Promise<void> {
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const e of Deno.readDir(SESSIONS_ROOT)) entries.push(e);
  } catch {
    console.log("[]");
    return;
  }
  const sessions: Array<{ session: string; alive: boolean }> = [];
  for (const e of entries) {
    if (!e.isDirectory) continue;
    let alive = false;
    try {
      await Deno.stat(`${SESSIONS_ROOT}/${e.name}/socket`);
      alive = true;
    } catch {
      // socket gone
    }
    sessions.push({ session: e.name, alive });
  }
  console.log(JSON.stringify(sessions, null, 2));
}

if (!subcommand) usage();

if (!fn) usage();

function usage(): never {
  console.error(
    `usage: debug <subcommand> [args]

  launch  [--session ID] [--restart] [--node|--deno-run|--deno-test] -- <cmd> [args...]
  rerun   [--session ID]                       # close existing + relaunch with the prior cmd
  bp      [--session ID] <file>:<line> [--cond <expr>]
  capture [--session ID] <file>:<line> <expr> [<expr>...] [--cond <expr>]
  rm      [--session ID] <bpId | file:line>
  run     [--session ID] [--wait <ms>]
  continue [--session ID]
  step    [--session ID] [over|into|out]
  eval    [--session ID] <expr> [--frame N]
  trace   [--session ID] [--since N] [--format json|table] [--mark-stack-changes]
          [--partition-by <expr> --out <prefix> [--sort] [--with-caller]]
  stacks  [--session ID] [--format json]                         # histogram of unique stacks across hits
  stack   [--session ID] <hit#>                                  # full call stack for one hit
  status  [--session ID]
  logs    [--session ID] [--daemon|--stderr|--stdout]
  close   [--session ID]
  list
`,
  );
  Deno.exit(2);
}

try {
  await fn(parsed);
} catch (e) {
  console.error(`debug ${subcommand}: ${(e as Error).message}`);
  Deno.exit(1);
}
