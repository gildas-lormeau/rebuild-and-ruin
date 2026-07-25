# MCP play server (dev/research)

An MCP stdio server that lets an external LLM agent play a classic match by driving ONE slot through the real controller/intent path. An `McpBrain` is brain-swapped onto the agent slot via `RuntimeConfig.controllerFactory`; the other slots stay default AI. Turn-based `observe`/`act`/`pass` over the headless mock clock, which is frozen while the agent "thinks" and burns a fixed per-action time budget when it acts.

- Run: `deno run -A scripts/mcp-play/server.ts` (or `deno task play`). Registered in `.mcp.json` so the VSCode extension / CLI connects to it as a live MCP server — approve it once, then the tools surface as deferred tools.
- Impl: `scripts/mcp-play/harness.ts` (`createMcpGame`).
- Tools: observe, check_placement, select_castle, place_cannon/end_cannon, place_piece, fire, `build_toward`/`build_path`/`bombard`/`breach`/`pit_strike` (intent actions = one call per build/battle), pass, enclose_plan, save/load.
- NOT in determinism/parity suites (the agent slot is non-deterministic by design).

## Rendering and observations

Each tool returns the resulting state rendered by `scripts/mcp-play/render.ts` (the TS port of the `tmp/show.py` lens): the annotation sections that drive every decision (STANDINGS, SURVIVAL, ENCLOSURE CANDIDATES, CANNON SPOTS, TARGETS, SUGGESTIONS, …).

**The full ASCII board is OFF action returns by default** (it's ~1k–1.8k chars the agent reasons past — a played-through game showed decisions come from the annotations, not the grid); instead each return ends with a `VIEWS:` line of precomputed regions of interest, pulled by name via `observe({ roi })` (`reseal-gap`/`gap`, `threat:N`, `enclose-kill`, `target:<slot>`, `home`, `bonus` — computed in `computeRois` from the same min-cut/threats/clusters/targets the annotations carry, resolved to a padded crop by `resolveRoi` in `server.ts`).

`observe()` renders the full board on demand; `observe({ format: 'json' })` returns the raw structured `Observation` (what the headless tests consume). `MCP_PLAY_ACTION_BOARD=1` forces the board back onto every return (`replay.ts` sets it so the human watch flow keeps per-move boards; `--diff` is unaffected — it compares the structured digest).

## Fairness invariant

Any agent action whose COUNT is bounded by game-time — not by slots or reload — must be charged the *real* per-action cost, or the frozen-clock model becomes an exploit. Two such levers exist and must stay honest:

- Build pieces cost `BUILD_PIECE_TICKS` (the measured AI per-piece cadence, ~78t).
- Firing is gated to the live battle window (`battleCountdown <= 0 && timer > 0`, matching `BaseController.fire` + the `weaponsActive` lockout in `runtime/subsystems/phase-ticks.ts` — once the timer expires ALL players are locked out, cursor movement included, while in-flight balls land) so the agent can't out-build or out-fire opponents on clock speed.

Cannon placement (slot-capped) and fire rate (reload-capped) are self-limiting and need no extra charge.

## Debugging the server (agent-friendly)

`deno task replay <moves.jsonl>` (`scripts/mcp-play/replay.ts`) deterministically replays a `.jsonl` of bare tool calls (`{"name":..., "arguments":{...}}`, one per line — the shape an agent emits; `#`/`//` lines are comments) through the SAME dispatch the stdio server uses (`callTool`, exported from `server.ts`; `main()` is gated behind `import.meta.main` so importing it doesn't start the stdin reader), printing each rendered board so you can watch a session evolve in-process — no subprocess, no JSON-RPC plumbing.

- `new_game` is auto-synthesized from `--seed`/`--rounds`/`--ticks` unless the file opens with one.
- `--quiet` prints just the ROUND/STANDINGS/LAST lines; `--only-last` just the final board.
- Exit code is 1 if any call errored (so a journal doubles as a smoke test).
- Example/template: `scripts/mcp-play/examples/round1-smoke.jsonl`.

## Auto-journal (debug the last LIVE game)

Every live session auto-records its tool-call stream to a replay-compatible `.jsonl` — `tmp/mcp-play/journal/seed-<seed>-<n>.jsonl`, mirrored to a stable `tmp/mcp-play/last.jsonl` (rotates at each `new_game`; read-only/meta tools like observe/check/save are skipped; the opener bakes in the resolved seed so a no-seed random game stays reproducible; `tmp/` is gitignored so it's always-on, no env gate).

Alongside each journal a **baseline digest sidecar** is written — `last.expected.jsonl` (+ the per-session `.expected.jsonl`): one `{i, round, phase, per-player score/lives/walls/cannons/enclosedTowers}` line per journaled call (`observationDigest` in `server.ts`).

So after a live game:

- `deno task replay tmp/mcp-play/last.jsonl --quiet` re-runs it against current code.
- `deno task replay tmp/mcp-play/last.jsonl --diff` reports the FIRST call where the game state diverges from the recorded baseline ("DIVERGENCE at call N, round R, phase P" + changed fields; exit 1 on any divergence, 0 if identical) — that's how you tell whether a code change affects the recorded game and exactly where.

`replay.ts` sets `MCP_PLAY_NO_JOURNAL=1` so replaying never clobbers `last.jsonl`. To branch on state (e.g. pick a valid super-cannon coord), write a `tmp/` scratch that imports `callTool` and reads `observe({format:'json'})` between calls.

The legacy `tmp/play.sh` + `tmp/show.py` flow is superseded by this (rendering moved server-side into `render.ts`).
