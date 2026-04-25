# debug — non-interactive CDP debugger CLI

A small CLI that drives a Chrome DevTools Protocol (CDP) session against
Node, Deno, or any V8-based runtime. The headline feature is **capture
points**: a breakpoint that auto-resumes after recording a snapshot of
named expressions, returning a tabular trace at the end. One launch, one
run, one trace — replaces a `console.log` + edit + rerun loop with a
single deterministic pass.

## Why this exists

For an LLM agent, `console.log` debugging is structurally inefficient:
each iteration is a full recompile + repro, and you have to guess what
to log before knowing what's wrong. A debugger flips the cost model:
many observations per run instead of one log per run. But interactive
step-debugging doesn't suit a one-shot tool environment, so this is
shaped around **capture points** (set N → run once → tabular output).
Real interactive primitives (eval, frames, step) are also exposed.

## Subcommands

```
debug launch [--session ID] [--node|--deno-run|--deno-test] -- <cmd> [args...]
debug capture [--session ID] <file>:<line> <expr> [<expr>...]
debug bp      [--session ID] <file>:<line> [--cond <expr>]
debug rm      [--session ID] <bpId>
debug run     [--session ID] [--wait <ms>]        # resume + wait for exit
debug continue [--session ID]
debug step    [--session ID] [over|into|out]
debug eval    [--session ID] <expr> [--frame N]
debug trace   [--session ID] [--since N] [--format json|table]
debug status  [--session ID]
debug logs    [--session ID] [--daemon|--stderr|--stdout]
debug close   [--session ID]
debug list
```

Sessions are identified by a short id (default `default`). Multiple
concurrent sessions are supported — each gets its own daemon and Unix
socket under `/tmp/debug-sessions/<id>/`.

## Convenience launch flags

| flag | expands to |
|---|---|
| `--node` | `node --inspect-brk=127.0.0.1:0 ARGS...` |
| `--deno-run` | `deno run --inspect-wait=127.0.0.1:0 -A ARGS...` |
| `--deno-test` | `deno run --inspect-wait=...:0 -A run-test.ts ARGS...` (test shim — see below) |

Without a flag, the command runs as-is and the caller must include
`--inspect-brk=127.0.0.1:0` (or `--inspect-wait`) themselves.

## Quick example (Node)

```sh
$ debug launch --node -- /tmp/sample.js
$ debug capture sample.js:5  i  acc  seed
$ debug run
$ debug trace --format table

#  +ms  loc          i  acc  seed
0  0    sample.js:5  0  0    7
1  1    sample.js:5  1  14   7
2  2    sample.js:5  2  44   7
3  3    sample.js:5  3  106  7
4  4    sample.js:5  4  232  7
```

## Real example (this repo's tests)

Capture every phase transition in a scenario test:

```sh
$ debug launch --deno-test -- test/scenario.test.ts "runGame plays a full game"
$ debug capture src/game/phase-setup.ts:253  state.phase  phase  state.round
$ debug run
$ debug trace --format table

#  +ms  loc                          state.phase    phase         state.round
0  0    src/game/phase-setup.ts:253  CASTLE_SELECT  CANNON_PLACE  1
1  10   src/game/phase-setup.ts:253  CANNON_PLACE   BATTLE        1
2  41   src/game/phase-setup.ts:253  BATTLE         WALL_BUILD    2
3  786  src/game/phase-setup.ts:253  WALL_BUILD     CANNON_PLACE  2
4  797  src/game/phase-setup.ts:253  CANNON_PLACE   BATTLE        2
5  824  src/game/phase-setup.ts:253  BATTLE         WALL_BUILD    3
```

Multiple captures across different src/ files compose:

```sh
$ debug capture src/game/phase-setup.ts:253        state.phase  phase
$ debug capture src/shared/core/game-event-bus.ts:406  type
$ debug run
$ debug trace --format table
# 120-row interleaved trace of every event + every transition
```

## Architecture

```
   CLI (one-shot)        Daemon (per session)              Debuggee
   ─────────────         ────────────────────              ────────
   debug launch  ──spawn──►  daemon.ts  ──spawn (--inspect-wait)──►  node/deno
   debug capture ─────IPC───►   │                                       │
   debug run     ─────IPC───►   ├──CDP (WebSocket, JSON)────────────────┤
   debug trace   ─────IPC───►   │
                                ▼
                         /tmp/debug-sessions/<id>/
                           ├─ socket    (Unix socket — IPC server)
                           ├─ ready     (touch file: signals daemon online)
                           ├─ daemon.log
                           ├─ scripts.log    (every Debugger.scriptParsed)
                           ├─ stdout.log     (debuggee stdout)
                           └─ stderr.log     (debuggee stderr)
```

Each CLI invocation is a thin client that connects to the daemon's Unix
socket, sends one JSON request, prints the response. State (breakpoints,
captures, hit log, paused frames) lives in the daemon process.

The daemon defers `Runtime.runIfWaitingForDebugger` to the `run`
command, giving the CLI a clean window to set captures *before* any
user code executes.

## Files

| file | role |
|---|---|
| [cli.ts](cli.ts) | Subcommand dispatcher + IPC client |
| [daemon.ts](daemon.ts) | Per-session daemon: spawns debuggee, holds CDP, serves IPC |
| [cdp.ts](cdp.ts) | Minimal CDP WebSocket client (no deps) |
| [source-map.ts](source-map.ts) | Source-map decoder (base64 + VLQ + reverse index) |
| [run-test.ts](run-test.ts) | `Deno.test` shim — runs registered tests as plain function calls |

## Why the `Deno.test` shim?

Deno's test runner has two CDP-affecting behaviors that we work around:

1. **`deno test --inspect-brk` wedges**: the runner ignores
   `Runtime.runIfWaitingForDebugger`, so the runtime never starts. We
   use `--inspect-wait` instead.
2. **`deno test` blocks user breakpoints inside test bodies**: bps fire
   only at the `Deno.test(...)` line, never inside the body. We
   sidestep this by intercepting `Deno.test`, collecting registrations,
   and invoking them ourselves under `deno run`. Same surface, real
   bps.

Implementation: [run-test.ts](run-test.ts). Imports the test file,
`Deno.test` is shimmed to push `{name, fn}` into a list, then we loop
and call each `fn` directly. After all imports resolve, a `debugger;`
statement gives the daemon a chance to rebind any breakpoints whose
target scripts weren't yet parsed at capture-set time.

## Why our own source-map decoder?

V8's built-in `setBreakpointByUrl` source-map resolution produces
broken column numbers for cross-module TS files under Deno (e.g.
returns `columnNumber=802` for a 50-char line — bp fires in the wrong
scope, captured locals come back as `<exception>`). The fix is to
decode the source map ourselves (it's attached as a `data:` URI on
each `Debugger.scriptParsed` event), build a `(tsFile, tsLine) →
(jsScriptId, jsLine, jsCol)` reverse index, and call
`Debugger.setBreakpoint` with the JS coordinate directly. JS files and
plain `node` scripts skip this path entirely.

Resolution order in [setBpResolved](daemon.ts):
1. **sourceMap** — if a parsed script has a source map covering the
   user-given file, use the resolved JS coordinate.
2. **scriptId** — if the file maps directly to a parsed script (plain
   JS, or no source map), use `Debugger.setBreakpoint` with the
   script's own scriptId.
3. **urlRegex** — fallback `Debugger.setBreakpointByUrl` for scripts
   not yet parsed. Re-resolved later via `retryPendingCaptures` after
   the post-import init pause.

## Session files

`/tmp/debug-sessions/<id>/` contents are useful for debugging the
debugger:

- `daemon.log` — daemon's own logs (pause events, retry binds, errors)
- `scripts.log` — every `Debugger.scriptParsed` event,
  one per line: `<scriptId>\t<url>\t[sm:<sourceMapURL>]`
- `stdout.log` / `stderr.log` — debuggee's piped output
- `socket` — the Unix socket (gone when daemon exits)
- `ready` — touch file written when the daemon finishes connecting
- `error` — only present when the daemon failed to start

`debug logs --daemon|--stderr|--stdout` reads the corresponding file.

## Known limitations / future work

- 30-second linger after debuggee exits is hard-coded — `close` is the
  only clean session terminator.
- `close` IPC reply doesn't reach the client because the daemon
  `Deno.exit`s before the response lands. Cosmetic.
- No CLI subcommand for **logpoints** (eval-without-pause, no
  breakpoint surface). The underlying CDP primitive supports it via the
  `condition` field.
- `findScriptForFile` is mostly superseded by the source-map path for
  TS files. Could be unified.
- The shim's `debugger;` statement is the only way the daemon learns
  "imports complete, retry pending captures." A more elegant signal
  (a final `scriptParsed` quiescence period?) would remove the need
  for editing the shim source to add `debugger;`.
