/**
 * load-game.ts — load a recorded mcp-play game into a LIVE, inspectable harness.
 *
 * The auto-journal (`tmp/mcp-play/last.jsonl`) and any hand-written bare-call
 * `.jsonl` record a game as a stream of `{name, arguments}` tool calls. This
 * replays that stream through the SAME `callTool` dispatch the stdio server and
 * `replay.ts` use, then hands back the resulting `McpGame` so an agent can read
 * its FULL hidden state (`game.scenario.state` — grunts, bag, frozenTiles,
 * pendingUpgradeOffers, comboTracker, damagedWalls, RNG cursor …) and keep
 * PLAYING it (`game.buildOut()`, `game.act()`, `game.scenario.bus`/`tick`/
 * `tileAt`/`runUntil`) — exactly the surface a headless test drives.
 *
 * Replays under CURRENT code: identical to the recording up to the first
 * divergence, then it follows today's behaviour (the same caveat as
 * `replay --diff`). For the game EXACTLY as recorded, load at the recording
 * commit. `untilCall` shares its index with the `.expected.jsonl` digest's `i`,
 * so `jq` the digest to find "round R / phase P → call N", then load to N.
 *
 * Usage (a `tmp/` scratch — `deno run -A tmp/inspect.ts`):
 *   import { loadMcpGame } from "../scripts/mcp-play/load-game.ts";
 *   const { game } = await loadMcpGame("tmp/mcp-play/last.jsonl", { untilCall: 280 });
 *   console.log(game.scenario.state.grunts.length);   // hidden state, ground truth
 *   game.buildOut();                                  // branch + keep playing
 */

import type { McpGame } from "./harness.ts";
import { callTool, peekCurrentGame } from "./server.ts";

interface BareCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface LoadMcpGameOptions {
  /** Stop after applying the call at this index (0 = the `new_game` opener,
   *  matching the `.expected.jsonl` digest's `i`). Default: replay everything. */
  untilCall?: number;
}

export interface LoadedMcpGame {
  /** The live harness, positioned at the replayed point. Drive it like a test:
   *  `game.scenario.state` (full hidden state), `game.observe()`,
   *  `game.buildOut()`, `game.scenario.bus`/`tick`/`tileAt`/`runUntil`. */
  game: McpGame;
  /** How many calls were applied, including the `new_game` opener. */
  applied: number;
}

/** Load a recorded bare-call game (`last.jsonl` or any `{name,arguments}` .jsonl)
 *  and replay it into a live `McpGame`. Throws if the stream is empty, doesn't
 *  open with `new_game`, a call errors, or no game results. */
export async function loadMcpGame(
  path: string,
  opts: LoadMcpGameOptions = {},
): Promise<LoadedMcpGame> {
  // Replaying must NOT write the auto-journal, or loading `last.jsonl` would
  // clobber it with a fresh opener (callTool's `new_game` rotates the journal).
  // The same guard `replay.ts` sets; do it before the first `callTool` so the
  // disabled-gate caches as off.
  Deno.env.set("MCP_PLAY_NO_JOURNAL", "1");
  const calls = parseCalls(await Deno.readTextFile(path));
  if (calls.length === 0) throw new Error(`load: no calls in ${path}`);
  if (calls[0]!.name !== "new_game") {
    throw new Error(`load: ${path} must open with a new_game call`);
  }
  const until = opts.untilCall ?? calls.length - 1;
  let applied = 0;
  for (let i = 0; i < calls.length && i <= until; i++) {
    const { name, arguments: args = {} } = calls[i]!;
    const { text, isError } = await callTool(name, args);
    if (isError) throw new Error(`load: call [${i}] ${name} failed — ${text}`);
    applied++;
  }
  const game = peekCurrentGame();
  if (!game) throw new Error("load: no game after replay");
  return { game, applied };
}

/** Parse a bare-call `.jsonl`: one `{name,arguments}` per line; blank lines and
 *  `#`/`//` comments skipped (the shape an agent emits / the auto-journal writes). */
function parseCalls(raw: string): BareCall[] {
  const calls: BareCall[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
      continue;
    }
    calls.push(JSON.parse(trimmed) as BareCall);
  }
  return calls;
}
