/**
 * Per-session debugger daemon.
 *
 * Spawned by `cli.ts launch`. Holds the CDP connection to the debuggee for
 * the entire session, exposes commands over a Unix socket. Lives in its own
 * process so the CLI (one-shot Bash invocations) can reconnect across calls
 * without losing breakpoint / capture state.
 *
 * Lifecycle:
 *   1. Spawn debuggee (caller must include --inspect-brk in the command)
 *   2. Read stderr until "Debugger listening on ws://..." line
 *   3. Connect CDP, enable Debugger + Runtime, runIfWaitingForDebugger
 *   4. Open Unix socket at /tmp/debug-sessions/<id>/socket
 *   5. Touch ready file
 *   6. Process IPC commands until "close" or debuggee exits
 *
 * IPC protocol: line-delimited JSON.
 *   Request:  { id, method, params }
 *   Response: { id, ok, result } or { id, ok: false, error }
 *
 * Capture-points: a breakpoint that auto-resumes after recording specified
 * expressions. The killer feature for non-interactive debugging — set N
 * capture-points, run once, get a tabular trace.
 */

import { CdpClient } from "./cdp.ts";
import { SourceMapResolver } from "./source-map.ts";

interface Capture {
  bpId: string;
  file: string;
  line: number;
  exprs: string[];
  condition?: string;
}

interface CaptureHit {
  ts: number;
  bpId: string;
  file: string;
  line: number;
  values: Record<string, unknown>;
}

interface PausedFrame {
  callFrameId: string;
  functionName: string;
  url: string;
  line: number;
}

interface PausedState {
  reason: string;
  hitBreakpoints: string[];
  frames: PausedFrame[];
}

interface IpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

type IpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

type IpcHandler = (
  params: Record<string, unknown>,
) => Promise<unknown> | unknown;

interface ParsedScript {
  scriptId: string;
  url: string;
  sourceMapURL?: string;
}

interface PendingCapture {
  fallbackBpId: string;
  file: string;
  line: number;
  exprs: string[];
  condition?: string;
}

interface Session {
  id: string;
  dir: string;
  socketPath: string;
  readyPath: string;
  errorPath: string;
  cmd: string[];
  log: Deno.FsFile;
  scriptsLog: Deno.FsFile;
  captures: Map<string, Capture>;
  pendingCaptures: PendingCapture[];
  hits: CaptureHit[];
  paused: PausedState | null;
  exited: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  cdp: CdpClient | null;
  child: Deno.ChildProcess | null;
  scriptsByUrl: Map<string, ParsedScript>;
  scriptsById: Map<string, ParsedScript>;
  sourceMaps: SourceMapResolver;
  started: boolean;
}

interface BpResult {
  bpId: string;
  locations: unknown[];
  via: "sourceMap" | "scriptId" | "urlRegex";
}

await main();

async function main(): Promise<void> {
  const sessionId = Deno.args[0];
  const sepIdx = Deno.args.indexOf("--");
  if (!sessionId || sepIdx === -1 || Deno.args.length === sepIdx + 1) {
    console.error("usage: daemon.ts <session_id> -- <cmd> [args...]");
    Deno.exit(2);
  }
  const cmd = Deno.args.slice(sepIdx + 1);
  const dir = `/tmp/debug-sessions/${sessionId}`;
  await Deno.mkdir(dir, { recursive: true });
  for (const f of ["socket", "ready", "error"]) {
    try {
      await Deno.remove(`${dir}/${f}`);
    } catch {
      // not present
    }
  }
  const log = await Deno.open(`${dir}/daemon.log`, {
    create: true,
    write: true,
    truncate: true,
  });
  const scriptsLog = await Deno.open(`${dir}/scripts.log`, {
    create: true,
    write: true,
    truncate: true,
  });
  installLogger(log);

  const session: Session = {
    id: sessionId,
    dir,
    socketPath: `${dir}/socket`,
    readyPath: `${dir}/ready`,
    errorPath: `${dir}/error`,
    cmd,
    log,
    scriptsLog,
    captures: new Map(),
    pendingCaptures: [],
    hits: [],
    paused: null,
    exited: false,
    scriptsByUrl: new Map(),
    scriptsById: new Map(),
    sourceMaps: new SourceMapResolver(),
    exitCode: null,
    exitSignal: null,
    cdp: null,
    child: null,
    started: false,
  };

  const child = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  session.child = child;
  const childExit = child.status.then((s) => {
    session.exited = true;
    session.exitCode = s.code;
    session.exitSignal = s.signal;
  });

  const stdoutFile = await Deno.open(`${dir}/stdout.log`, {
    create: true,
    write: true,
    truncate: true,
  });
  const stderrFile = await Deno.open(`${dir}/stderr.log`, {
    create: true,
    write: true,
    truncate: true,
  });

  const inspectorUrlBox: { url: string | null } = { url: null };
  const stdoutReader = pipeToFile(child.stdout, stdoutFile);
  const stderrReader = pipeStderrAndCaptureUrl(
    child.stderr,
    stderrFile,
    inspectorUrlBox,
  );

  const startWait = Date.now();
  while (
    !inspectorUrlBox.url &&
    !session.exited &&
    Date.now() - startWait < 10_000
  ) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!inspectorUrlBox.url) {
    const msg = `inspector URL not found within 10s (debuggee exited: ${session.exited}, code: ${session.exitCode})`;
    await Deno.writeTextFile(session.errorPath, msg);
    console.error(`daemon: ${msg}`);
    Deno.exit(3);
  }

  const cdp = await CdpClient.connect(inspectorUrlBox.url);
  session.cdp = cdp;
  // Install listeners BEFORE Debugger.enable so we don't miss the burst of
  // scriptParsed events V8 sends in response to enable.
  cdp.on("Debugger.scriptParsed", (params) => {
    const script: ParsedScript = {
      scriptId: params.scriptId as string,
      url: (params.url as string) ?? "",
      sourceMapURL: (params.sourceMapURL as string) || undefined,
    };
    if (script.url) {
      session.scriptsByUrl.set(script.url, script);
    }
    session.scriptsById.set(script.scriptId, script);
    if (script.sourceMapURL && script.url) {
      try {
        session.sourceMaps.addScript(
          script.scriptId,
          script.url,
          script.sourceMapURL,
        );
      } catch (e) {
        console.error(
          `source-map decode failed for ${script.url}: ${(e as Error).message}`,
        );
      }
    }
    try {
      const enc = new TextEncoder();
      const line = `${script.scriptId}\t${script.url}${script.sourceMapURL ? `\tsm:${script.sourceMapURL}` : ""}\n`;
      session.scriptsLog.writeSync(enc.encode(line));
    } catch {
      // closed
    }
    // Re-resolve any pending captures that may now be bindable. Lazily
    // imported modules (e.g. AI controllers loaded on demand) often parse
    // long after the post-import init pause, so the one-shot retry there
    // misses them. retryPendingCaptures is a no-op for unbindable entries.
    if (session.pendingCaptures.length > 0) {
      void retryPendingCaptures(session).catch((e) =>
        console.error(`scriptParsed-retry failed: ${(e as Error).message}`),
      );
    }
  });
  cdp.on("Debugger.paused", (params) => {
    const reason = params.reason as string;
    const hits = (params.hitBreakpoints as string[]) ?? [];
    const top = ((params.callFrames as Array<Record<string, unknown>>) ??
      [])[0];
    const topUrl = top ? (top.url as string) : "<no-frame>";
    const topLine = top
      ? ((top.location as { lineNumber?: number })?.lineNumber ?? 0) + 1
      : 0;
    console.log(
      `paused reason=${reason} hits=${JSON.stringify(hits)} top=${topUrl}:${topLine}`,
    );
    void handlePaused(session, params);
  });
  cdp.on("Debugger.resumed", () => {
    session.paused = null;
  });
  cdp.on("Debugger.breakpointResolved", (params) => {
    console.log(
      `breakpointResolved bpId=${params.breakpointId} location=${JSON.stringify(params.location)}`,
    );
  });
  // When the main execution context is destroyed (script finished), the
  // debugger is keeping the process alive. Detach so it can exit.
  cdp.on("Runtime.executionContextDestroyed", () => {
    console.log("Runtime.executionContextDestroyed — closing CDP");
    try {
      cdp.close();
    } catch {
      // already closed
    }
  });
  await cdp.send("Debugger.enable");
  await cdp.send("Runtime.enable");
  // Defensive: some runners (deno test) may have disabled breakpoints or
  // skipped pauses by default. Explicitly turn them on.
  await cdp.send("Debugger.setBreakpointsActive", { active: true });
  await cdp.send("Debugger.setSkipAllPauses", { skip: false });
  // Do NOT call Runtime.runIfWaitingForDebugger here. With --inspect-brk and
  // --inspect-wait the runtime is paused waiting for that signal; we defer
  // it to the `run` handler so the CLI client can install captures /
  // breakpoints before any user code executes. (--inspect-with-no-wait will
  // simply ignore the deferred call — the script is already running.)

  const handlers = makeHandlers(session);
  const listener = Deno.listen({ transport: "unix", path: session.socketPath });
  await Deno.writeTextFile(session.readyPath, "");

  const acceptLoop = (async () => {
    for await (const conn of listener) {
      handleConn(conn, handlers).catch((e) =>
        console.error(`conn err: ${(e as Error).message}`),
      );
    }
  })();

  await Promise.race([
    childExit,
    new Promise((r) => setTimeout(r, 24 * 60 * 60 * 1000)),
  ]);
  await Promise.race([
    Promise.all([stderrReader, stdoutReader]),
    new Promise((r) => setTimeout(r, 500)),
  ]);
  // Linger so client can fetch final trace/status.
  await new Promise((r) => setTimeout(r, 30_000));
  shutdown(session, listener);
  void acceptLoop;
}

function installLogger(log: Deno.FsFile): void {
  const enc = new TextEncoder();
  const fmt = (level: string, args: unknown[]) =>
    `${new Date().toISOString()} ${level} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
  console.log = (...args: unknown[]) => {
    try {
      log.writeSync(enc.encode(fmt("LOG", args)));
    } catch {
      // file closed
    }
  };
  console.error = (...args: unknown[]) => {
    try {
      log.writeSync(enc.encode(fmt("ERR", args)));
    } catch {
      // file closed
    }
  };
}

async function pipeToFile(
  stream: ReadableStream<Uint8Array>,
  file: Deno.FsFile,
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      await file.write(value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function pipeStderrAndCaptureUrl(
  stream: ReadableStream<Uint8Array>,
  file: Deno.FsFile,
  box: { url: string | null },
): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      await file.write(value);
      if (box.url) continue;
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/Debugger listening on (ws:\/\/\S+)/);
      if (m) box.url = m[1];
    }
  } finally {
    reader.releaseLock();
  }
}

async function handlePaused(
  session: Session,
  params: Record<string, unknown>,
): Promise<void> {
  const cdp = session.cdp;
  if (!cdp) return;
  const rawFrames = (params.callFrames as Array<Record<string, unknown>>) ?? [];
  const hitBps = (params.hitBreakpoints as string[]) ?? [];
  const captureBps = hitBps.filter((id) => session.captures.has(id));

  if (captureBps.length > 0 && rawFrames.length > 0) {
    const callFrameId = rawFrames[0].callFrameId as string;
    for (const bpId of captureBps) {
      const cap = session.captures.get(bpId);
      if (!cap) continue;
      const values: Record<string, unknown> = {};
      for (const expr of cap.exprs) {
        values[expr] = await evalOnFrame(cdp, callFrameId, expr);
      }
      session.hits.push({
        ts: Date.now(),
        bpId,
        file: cap.file,
        line: cap.line,
        values,
      });
    }
    await cdp.send("Debugger.resume");
    return;
  }

  session.paused = {
    reason: params.reason as string,
    hitBreakpoints: hitBps,
    frames: rawFrames.map((f) => {
      const loc = (f.location as { lineNumber?: number }) ?? {};
      return {
        callFrameId: f.callFrameId as string,
        functionName: (f.functionName as string) || "<anonymous>",
        url: (f.url as string) || "",
        line: (loc.lineNumber ?? 0) + 1,
      };
    }),
  };
}

function makeHandlers(session: Session): Record<string, IpcHandler> {
  const cdp = () => {
    if (!session.cdp) throw new Error("CDP not connected");
    return session.cdp;
  };
  return {
    status: () => {
      const pendingByBpId = new Set(
        session.pendingCaptures.map((pc) => pc.fallbackBpId),
      );
      const captures = Array.from(session.captures.values()).map((c) => ({
        ...c,
        pending: pendingByBpId.has(c.bpId),
        ...(pendingByBpId.has(c.bpId)
          ? { hint: diagnoseBp(session, c.file, c.line) }
          : {}),
      }));
      return {
        sessionId: session.id,
        debuggeeExited: session.exited,
        exitCode: session.exitCode,
        exitSignal: session.exitSignal,
        paused: session.paused,
        captures,
        hitCount: session.hits.length,
      };
    },
    setBreakpoint: async (p) => {
      const file = p.file as string;
      const line = p.line as number;
      const condition = p.condition as string | undefined;
      const set = await setBpResolved(session, file, line, condition);
      const pending = set.via === "urlRegex" && set.locations.length === 0;
      return {
        bpId: set.bpId,
        locations: set.locations,
        via: set.via,
        pending,
        ...(pending ? { hint: diagnoseBp(session, file, line) } : {}),
      };
    },
    setCapture: async (p) => {
      const file = p.file as string;
      const line = p.line as number;
      const exprs = p.exprs as string[];
      const condition = p.condition as string | undefined;
      if (!Array.isArray(exprs) || exprs.length === 0) {
        throw new Error("setCapture requires non-empty exprs[]");
      }
      const set = await setBpResolved(session, file, line, condition);
      session.captures.set(set.bpId, {
        bpId: set.bpId,
        file,
        line,
        exprs,
        condition,
      });
      // urlRegex-based bps with no current matches are queued by V8, but
      // V8 doesn't always rebind them when the script parses later (esp.
      // for source-mapped TS). Track them so we can retry with scriptId
      // after the post-import init pause.
      const pending = set.via === "urlRegex" && set.locations.length === 0;
      if (pending) {
        session.pendingCaptures.push({
          fallbackBpId: set.bpId,
          file,
          line,
          exprs,
          condition,
        });
      }
      return {
        bpId: set.bpId,
        locations: set.locations,
        via: set.via,
        pending,
        ...(pending ? { hint: diagnoseBp(session, file, line) } : {}),
      };
    },
    removeBreakpoint: async (p) => {
      const arg = p.bpId as string;
      // Dual-dispatch: known bpId → remove that one; else parse as
      // file:line and remove every capture/pending matching it.
      if (session.captures.has(arg)) {
        try {
          await cdp().send("Debugger.removeBreakpoint", { breakpointId: arg });
        } catch {
          // already gone
        }
        session.captures.delete(arg);
        session.pendingCaptures = session.pendingCaptures.filter(
          (pc) => pc.fallbackBpId !== arg,
        );
        return { removed: [arg], count: 1, mode: "bpId" };
      }
      const m = arg.match(/^(.+):(\d+)$/);
      if (m) {
        const file = m[1];
        const line = Number(m[2]);
        const wantAbs = realPathSafe(file);
        const removed: string[] = [];
        for (const [bpId, cap] of session.captures) {
          if (realPathSafe(cap.file) !== wantAbs || cap.line !== line) continue;
          try {
            await cdp().send("Debugger.removeBreakpoint", {
              breakpointId: bpId,
            });
          } catch {
            // already gone
          }
          session.captures.delete(bpId);
          removed.push(bpId);
        }
        session.pendingCaptures = session.pendingCaptures.filter(
          (pc) => !(realPathSafe(pc.file) === wantAbs && pc.line === line),
        );
        if (removed.length > 0) {
          return { removed, count: removed.length, mode: "fileLine" };
        }
      }
      // Fall through: untracked bpId (e.g. one set via `bp`, not `capture`).
      // Just forward to CDP and let it succeed-or-error naturally.
      await cdp().send("Debugger.removeBreakpoint", { breakpointId: arg });
      return { removed: [arg], count: 1, mode: "bpId" };
    },
    continue: async () => {
      const notes: string[] = [];
      if (!session.started) {
        await cdp().send("Runtime.runIfWaitingForDebugger");
        session.started = true;
        notes.push("started runtime");
        // Wait for an init pause: --inspect-brk fires one immediately, the
        // run-test.ts shim hits a `debugger;` after imports complete.
        // Either way, by the time the pause lands the modules referenced
        // by pending captures are parsed and we can rebind via scriptId.
        const t0 = Date.now();
        while (!session.paused && !session.exited && Date.now() - t0 < 5_000) {
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      if (session.paused && session.pendingCaptures.length > 0) {
        const retried = await retryPendingCaptures(session);
        notes.push(
          `retried ${retried.bound} pending captures (${retried.stillPending} still pending)`,
        );
      }
      if (session.paused) {
        await cdp().send("Debugger.resume");
        notes.push("resumed");
      } else {
        notes.push("not paused; script running");
      }
      return { ok: true, notes };
    },
    step: async (p) => {
      const kind = (p.kind as string) ?? "over";
      const map: Record<string, string> = {
        over: "Debugger.stepOver",
        into: "Debugger.stepInto",
        out: "Debugger.stepOut",
      };
      const method = map[kind];
      if (!method) throw new Error(`unknown step kind: ${kind}`);
      await cdp().send(method);
      return { ok: true };
    },
    eval: async (p) => {
      const expr = p.expr as string;
      const frameDepth = (p.frameDepth as number | undefined) ?? 0;
      if (!session.paused) {
        const r = await cdp().send<{
          result: { value?: unknown; description?: string };
          exceptionDetails?: { text: string };
        }>("Runtime.evaluate", { expression: expr, returnByValue: true });
        if (r.exceptionDetails) return { error: r.exceptionDetails.text };
        return {
          value:
            r.result.value !== undefined
              ? r.result.value
              : r.result.description,
        };
      }
      const frame = session.paused.frames[frameDepth];
      if (!frame) throw new Error(`no frame at depth ${frameDepth}`);
      return { value: await evalOnFrame(cdp(), frame.callFrameId, expr) };
    },
    trace: (p) => {
      const since = (p.since as number | undefined) ?? 0;
      return { hits: session.hits.slice(since), total: session.hits.length };
    },
    waitForExit: async (p) => {
      const timeoutMs = (p.timeoutMs as number | undefined) ?? 30_000;
      const start = Date.now();
      while (!session.exited && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return {
        debuggeeExited: session.exited,
        exitCode: session.exitCode,
        exitSignal: session.exitSignal,
        hitCount: session.hits.length,
      };
    },
    close: () => {
      queueMicrotask(() => Deno.exit(0));
      return { ok: true };
    },
  };
}

async function retryPendingCaptures(
  session: Session,
): Promise<{ bound: number; stillPending: number }> {
  const cdp = session.cdp;
  if (!cdp) return { bound: 0, stillPending: session.pendingCaptures.length };
  const remaining: PendingCapture[] = [];
  let bound = 0;
  for (const pc of session.pendingCaptures) {
    // Cheap pre-check: only attempt rebind if a non-urlRegex resolution is
    // possible. Otherwise setBpResolved would create another urlRegex bp
    // (leaking — we'd discard the new bpId and keep the old fallback).
    const sourceUrl = `file://${realPathSafe(pc.file)}`;
    const canResolve =
      session.sourceMaps.resolve(sourceUrl, pc.line - 1) !== null ||
      findScriptForFile(session, pc.file) !== null;
    if (!canResolve) {
      remaining.push(pc);
      continue;
    }
    let result: BpResult;
    try {
      result = await setBpResolved(session, pc.file, pc.line, pc.condition);
    } catch (e) {
      console.error(
        `retryPendingCaptures: ${pc.file}:${pc.line} → ${(e as Error).message}`,
      );
      remaining.push(pc);
      continue;
    }
    if (result.via === "urlRegex" && result.locations.length === 0) {
      // Defensive: pre-check said yes but resolution returned urlRegex
      // anyway. Clean up the stray bp and keep waiting.
      try {
        await cdp.send("Debugger.removeBreakpoint", {
          breakpointId: result.bpId,
        });
      } catch {
        // already gone
      }
      remaining.push(pc);
      continue;
    }
    // Drop the urlRegex placeholder bp from before.
    try {
      await cdp.send("Debugger.removeBreakpoint", {
        breakpointId: pc.fallbackBpId,
      });
    } catch {
      // already gone
    }
    session.captures.delete(pc.fallbackBpId);
    session.captures.set(result.bpId, {
      bpId: result.bpId,
      file: pc.file,
      line: pc.line,
      exprs: pc.exprs,
      condition: pc.condition,
    });
    console.log(
      `retry bound ${pc.file}:${pc.line} via=${result.via} bpId=${result.bpId} locations=${JSON.stringify(result.locations)}`,
    );
    bound++;
  }
  session.pendingCaptures = remaining;
  return { bound, stillPending: remaining.length };
}

async function setBpResolved(
  session: Session,
  file: string,
  line: number,
  condition?: string,
): Promise<BpResult> {
  const cdp = session.cdp;
  if (!cdp) throw new Error("CDP not connected");
  // Strategy in order of reliability:
  //   1. Source-map resolution: decode the script's source map ourselves and
  //      set the bp at the JS coordinate. Bypasses Deno's broken column
  //      resolution for cross-module TS files.
  //   2. scriptId-based: Debugger.setBreakpoint on a parsed script.
  //   3. urlRegex: Debugger.setBreakpointByUrl, queues for future scripts.
  const sourceUrl = `file://${realPathSafe(file)}`;
  const sm = session.sourceMaps.resolve(sourceUrl, line - 1);
  if (sm) {
    const r = await cdp.send<{
      breakpointId: string;
      actualLocation: unknown;
    }>("Debugger.setBreakpoint", {
      location: {
        scriptId: sm.jsScriptId,
        lineNumber: sm.jsLine,
        columnNumber: sm.jsCol,
      },
      ...(condition ? { condition } : {}),
    });
    return {
      bpId: r.breakpointId,
      locations: [r.actualLocation],
      via: "sourceMap",
    };
  }
  const script = findScriptForFile(session, file);
  if (script) {
    const r = await cdp.send<{ breakpointId: string; actualLocation: unknown }>(
      "Debugger.setBreakpoint",
      {
        location: {
          scriptId: script.scriptId,
          lineNumber: line - 1,
          columnNumber: 0,
        },
        ...(condition ? { condition } : {}),
      },
    );
    return {
      bpId: r.breakpointId,
      locations: [r.actualLocation],
      via: "scriptId",
    };
  }
  const r = await cdp.send<{ breakpointId: string; locations: unknown[] }>(
    "Debugger.setBreakpointByUrl",
    {
      urlRegex: fileToUrlRegex(file),
      lineNumber: line - 1,
      ...(condition ? { condition } : {}),
    },
  );
  return { bpId: r.breakpointId, locations: r.locations, via: "urlRegex" };
}

function fileToUrlRegex(file: string): string {
  // Match the URL with or without macOS's /private prefix on /tmp paths.
  // V8 sees the URL Deno/Node passed in (not always realpath-resolved), so
  // /tmp/foo.js may show up as either /tmp/foo.js or /private/tmp/foo.js.
  const abs = realPathSafe(file);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const variants = new Set<string>([abs, file]);
  if (abs.startsWith("/private")) variants.add(abs.slice("/private".length));
  if (file.startsWith("/private")) variants.add(file.slice("/private".length));
  const alts = [...variants].map((v) => escape(`file://${v}`)).join("|");
  return `^(?:${alts})$`;
}

/** Explain why a bp didn't resolve cleanly, when it didn't. Returns
 *  undefined if everything is fine (script is parsed and binding worked).
 *  Distinguishes "file unknown" from "file known but line unbreakable" so
 *  the user gets actionable feedback (typo'd path? bad line? lazy import?). */
function diagnoseBp(
  session: Session,
  file: string,
  line: number,
): string | undefined {
  const sourceUrl = `file://${realPathSafe(file)}`;
  const indexedAsSource = session.sourceMaps.hasSource(sourceUrl);
  const directScript = findScriptForFile(session, file);
  if (!indexedAsSource && !directScript) {
    return "file not yet parsed; bp will retry when its script loads";
  }
  if (indexedAsSource) {
    const nearest = session.sourceMaps.nearestMappedLine(sourceUrl, line - 1);
    if (nearest === null) {
      return "file indexed but no source-map segments anywhere near this line";
    }
    if (nearest !== line - 1) {
      return `line ${line} has no source-map segment; nearest mapped line: ${nearest + 1}`;
    }
  }
  return undefined;
}

function findScriptForFile(
  session: Session,
  file: string,
): ParsedScript | null {
  const candidates = new Set<string>();
  const abs = realPathSafe(file);
  for (const v of [abs, file]) {
    candidates.add(`file://${v}`);
    if (v.startsWith("/private"))
      candidates.add(`file://${v.slice("/private".length)}`);
    else candidates.add(`file:///private${v}`);
  }
  for (const url of candidates) {
    const s = session.scriptsByUrl.get(url);
    if (s) return s;
  }
  return null;
}

function realPathSafe(p: string): string {
  try {
    return Deno.realPathSync(p);
  } catch {
    return p;
  }
}

async function evalOnFrame(
  cdp: CdpClient,
  callFrameId: string,
  expression: string,
): Promise<unknown> {
  try {
    const r = await cdp.send<{
      result: { value?: unknown; description?: string; type: string };
      exceptionDetails?: { text: string };
    }>("Debugger.evaluateOnCallFrame", {
      callFrameId,
      expression,
      returnByValue: true,
      throwOnSideEffect: false,
    });
    if (r.exceptionDetails) return `<exception: ${r.exceptionDetails.text}>`;
    if (r.result.value !== undefined) return r.result.value;
    return r.result.description ?? `<${r.result.type}>`;
  } catch (e) {
    return `<error: ${(e as Error).message}>`;
  }
}

async function handleConn(
  conn: Deno.Conn,
  handlers: Record<string, IpcHandler>,
): Promise<void> {
  const reader = conn.readable.getReader();
  const writer = conn.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let resp: IpcResponse;
        try {
          const req = JSON.parse(line) as IpcRequest;
          const handler = handlers[req.method];
          if (!handler) {
            resp = {
              id: req.id,
              ok: false,
              error: `unknown method: ${req.method}`,
            };
          } else {
            const result = await handler(req.params ?? {});
            resp = { id: req.id, ok: true, result };
          }
        } catch (e) {
          resp = { id: 0, ok: false, error: (e as Error).message };
        }
        await writer.write(encoder.encode(`${JSON.stringify(resp)}\n`));
      }
    }
  } catch (e) {
    console.error(`conn handler: ${(e as Error).message}`);
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

function shutdown(session: Session, listener: Deno.Listener): void {
  try {
    listener.close();
  } catch {
    // already closed
  }
  try {
    session.cdp?.close();
  } catch {
    // already closed
  }
  try {
    session.child?.kill("SIGTERM");
  } catch {
    // already dead
  }
  setTimeout(() => Deno.exit(0), 200);
}
