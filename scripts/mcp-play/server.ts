/**
 * mcp-play — a dependency-free MCP stdio server that lets an external agent
 * play a classic match of Rebuild & Ruin through the headless runtime.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout (the MCP stdio
 * transport). stdout is the protocol channel — all logging goes to stderr.
 * Implements the minimal MCP surface an agent host needs: `initialize`,
 * `tools/list`, `tools/call`, `ping`.
 *
 * Each tool returns the resulting board observation as pretty JSON, so the
 * agent sees the new state immediately after acting. One game at a time.
 *
 * Run: deno run -A scripts/mcp-play/server.ts
 * (dev/research tool — never wired into determinism or parity suites.)
 */

import { toCannonMode } from "../../src/shared/core/cannon-mode-defs.ts";
import type { ValidPlayerId } from "../../src/shared/core/player-slot.ts";
import { createMcpGame, type McpGame } from "./harness.ts";
import type { AgentDecision } from "./mcp-brain.ts";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

/** The replayable history of a game: its new-game config + every mutating move.
 *  The game is deterministic (seeded map + AI; the agent's moves are the only
 *  uncomputable input), so replaying this reconstructs the exact state. */
interface Journal {
  config: {
    seed?: number;
    agentSlot?: number;
    rounds?: number;
    actionTicks?: number;
  };
  moves: (
    | { t: "act"; decision: AgentDecision }
    | { t: "pass"; n: number }
    | { t: "build"; towerIdx?: number }
    | { t: "bombard"; slot: number; quanta?: number }
  )[];
}

const SERVER_INFO = { name: "rebuild-and-ruin-play", version: "0.1.0" };
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_SAVE_PATH = "mcp-play-save.json";
const TOOLS: ToolDef[] = [
  {
    name: "new_game",
    description:
      "Start a new classic match. The agent drives one slot; the other slots are the built-in AI. Returns the first observation (castle selection).",
    inputSchema: {
      type: "object",
      properties: {
        seed: { type: "number", description: "Map seed (default 42)." },
        agentSlot: {
          type: "number",
          description: "Slot the agent drives, 0-based (default 0).",
        },
        rounds: { type: "number", description: "Rounds to play (default 3)." },
        actionTicks: {
          type: "number",
          description:
            "Sim-frames of game time each action costs (default 30 ≈ 0.5s). Lower = more moves per phase.",
        },
      },
    },
    handler: async (args) => {
      const config = {
        seed: args.seed === undefined ? undefined : num(args, "seed"),
        agentSlot:
          args.agentSlot === undefined ? undefined : num(args, "agentSlot"),
        rounds: args.rounds === undefined ? undefined : num(args, "rounds"),
        actionTicks:
          args.actionTicks === undefined ? undefined : num(args, "actionTicks"),
      };
      game = await startGame(config);
      journal = { config, moves: [] };
      return game.observe();
    },
  },
  {
    name: "observe",
    description:
      "Return the current board observation without taking an action (phase, timer, ASCII board, your pieces/cannons, opponents).",
    inputSchema: { type: "object", properties: {} },
    handler: () => requireGame().observe(),
  },
  {
    name: "check_placement",
    description:
      "Read-only legality check for the current phase — your green/red phantom. In WALL_BUILD checks the current piece at (row,col,rotation); in CANNON_PLACE checks a cannon at (row,col,mode). Does NOT commit or advance the clock. Returns { valid, reason? }.",
    inputSchema: {
      type: "object",
      properties: {
        row: { type: "number" },
        col: { type: "number" },
        rotation: {
          type: "number",
          description: "Build only: 0-3, default 0.",
        },
        mode: {
          type: "string",
          enum: ["normal", "super", "balloon", "rampart"],
          description: "Cannon only, default normal.",
        },
      },
      required: ["row", "col"],
    },
    handler: (args) =>
      requireGame().check(
        num(args, "row"),
        num(args, "col"),
        args.rotation === undefined ? 0 : num(args, "rotation"),
        toCannonMode(typeof args.mode === "string" ? args.mode : undefined),
      ),
  },
  {
    name: "select_castle",
    description:
      "CASTLE_SELECT: choose your home tower by its index (see observation.towers).",
    inputSchema: {
      type: "object",
      properties: { towerIdx: { type: "number" } },
      required: ["towerIdx"],
    },
    handler: (args) =>
      recordAct({ kind: "select", towerIdx: num(args, "towerIdx") }),
  },
  {
    name: "place_piece",
    description:
      "WALL_BUILD: place the current piece. row/col is the top-left anchor; rotation is 0-3 (90° CW each). Check observation.lastResult.success.",
    inputSchema: {
      type: "object",
      properties: {
        row: { type: "number" },
        col: { type: "number" },
        rotation: { type: "number", description: "0-3, default 0." },
      },
      required: ["row", "col"],
    },
    handler: (args) =>
      recordAct({
        kind: "build",
        row: num(args, "row"),
        col: num(args, "col"),
        rotation: args.rotation === undefined ? 0 : num(args, "rotation"),
      }),
  },
  {
    name: "place_cannon",
    description:
      "CANNON_PLACE: place a cannon at row/col. mode is one of normal|super|balloon|rampart (default normal).",
    inputSchema: {
      type: "object",
      properties: {
        row: { type: "number" },
        col: { type: "number" },
        mode: {
          type: "string",
          enum: ["normal", "super", "balloon", "rampart"],
        },
      },
      required: ["row", "col"],
    },
    handler: (args) =>
      recordAct({
        kind: "cannon",
        row: num(args, "row"),
        col: num(args, "col"),
        mode: toCannonMode(
          typeof args.mode === "string" ? args.mode : undefined,
        ),
      }),
  },
  {
    name: "end_cannon",
    description: "CANNON_PLACE: finish placing cannons early.",
    inputSchema: { type: "object", properties: {} },
    handler: () => recordAct({ kind: "cannon-done" }),
  },
  {
    name: "fire",
    description:
      "BATTLE: fire one shot at tile row/col. One cannon fires per call (whichever is ready).",
    inputSchema: {
      type: "object",
      properties: { row: { type: "number" }, col: { type: "number" } },
      required: ["row", "col"],
    },
    handler: (args) =>
      recordAct({
        kind: "fire",
        row: num(args, "row"),
        col: num(args, "col"),
      }),
  },
  {
    name: "pass",
    description:
      "Advance game time WITHOUT committing anything ('nothing to commit, let time run'). `count` advances up to that many action-quanta in one call, stopping early on a phase change, battle going live, or game over — use it to skip a whole countdown or a quiet stretch cheaply (default 1). In BATTLE you re-decide fire/pass each quantum. To finish cannon placement before the timer, use end_cannon.",
    inputSchema: {
      type: "object",
      properties: {
        count: {
          type: "number",
          description: "Quanta to advance, default 1. Stops early on change.",
        },
      },
    },
    handler: (args) =>
      recordPass(args.count === undefined ? 1 : num(args, "count")),
  },
  {
    name: "build_toward",
    description:
      "WALL_BUILD: hand the whole build phase to the harness with one goal — enclose a tower (default: your home tower). It places each piece that arrives on the best min-cut tile (reacting to pieces, never peeking ahead), redirecting dud pieces onto the ring, until the tower seals, build time runs low, or it stalls. One call instead of dozens of place_piece calls. Read lastResult for the outcome (done/time/stuck + gaps left).",
    inputSchema: {
      type: "object",
      properties: {
        towerIdx: {
          type: "number",
          description:
            "Tower to enclose (see enclosureCandidates). Omit to repair/seal your home tower.",
        },
      },
    },
    handler: (args) =>
      recordBuild(
        args.towerIdx === undefined ? undefined : num(args, "towerIdx"),
      ),
  },
  {
    name: "bombard",
    description:
      "BATTLE: fire every ready cannon at one opponent's nearest walls, pacing reload, for the rest of the battle (or `quanta` action-quanta). Waits out the countdown first. One call instead of a whole battle of fire/pass. Read lastResult for walls destroyed + points scored.",
    inputSchema: {
      type: "object",
      properties: {
        slot: {
          type: "number",
          description: "Opponent slot to bombard (see layout / targets).",
        },
        quanta: {
          type: "number",
          description:
            "Cap on action-quanta to spend. Omit to run the battle out.",
        },
      },
      required: ["slot"],
    },
    handler: (args) =>
      recordBombard(
        num(args, "slot"),
        args.quanta === undefined ? undefined : num(args, "quanta"),
      ),
  },
  {
    name: "enclose_plan",
    description:
      "WALL_BUILD: the FULL min-cut plan (all tiles) to enclose one tower in your zone — the un-sampled form of an enclosureCandidates entry. Call after picking a candidate to get the complete tile list to fill.",
    inputSchema: {
      type: "object",
      properties: { towerIdx: { type: "number" } },
      required: ["towerIdx"],
    },
    handler: (args) =>
      requireGame().enclosurePlan(num(args, "towerIdx")) ?? {
        towerIdx: num(args, "towerIdx"),
        status: "not-a-candidate",
      },
  },
  {
    name: "save",
    description:
      "Persist the current game (its seed + move journal) to a file so it survives a restart. Deterministic — load replays the journal to reconstruct exact state.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: `File path (default ${DEFAULT_SAVE_PATH}).`,
        },
      },
    },
    handler: async (args) => {
      if (!journal) throw new Error("No active game to save.");
      const path = pathArg(args);
      await Deno.writeTextFile(path, JSON.stringify(journal));
      return {
        saved: path,
        moves: journal.moves.length,
        config: journal.config,
      };
    },
  },
  {
    name: "load",
    description:
      "Restore a game saved with `save` (replays its move journal). Returns the current observation at the restored point.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: `File path (default ${DEFAULT_SAVE_PATH}).`,
        },
      },
    },
    handler: async (args) => {
      const path = pathArg(args);
      const loaded = JSON.parse(await Deno.readTextFile(path)) as Journal;
      game = await startGame(loaded.config);
      for (const move of loaded.moves) {
        if (move.t === "act") game.act(move.decision);
        else if (move.t === "pass") game.pass(move.n);
        else if (move.t === "build") game.build(move.towerIdx);
        else game.bombard(move.slot, move.quanta);
      }
      journal = loaded;
      return game.observe();
    },
  },
];
const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

let game: McpGame | null = null;
let journal: Journal | null = null;

function startGame(config: Journal["config"]): Promise<McpGame> {
  return createMcpGame({
    seed: config.seed,
    agentSlot: config.agentSlot as ValidPlayerId | undefined,
    rounds: config.rounds,
    actionTicks: config.actionTicks,
  });
}

/** Apply a decision to the live game AND append it to the journal. */
function recordAct(decision: AgentDecision): unknown {
  const observation = requireGame().act(decision);
  journal?.moves.push({ t: "act", decision });
  return observation;
}

/** Advance time AND journal it. */
function recordPass(n: number): unknown {
  const observation = requireGame().pass(n);
  journal?.moves.push({ t: "pass", n });
  return observation;
}

/** Run the build-toward executor AND journal the goal (replay re-derives placements). */
function recordBuild(towerIdx?: number): unknown {
  const observation = requireGame().build(towerIdx);
  journal?.moves.push({ t: "build", towerIdx });
  return observation;
}

/** Run the bombard executor AND journal the target (replay re-derives the volley). */
function recordBombard(slot: number, quanta?: number): unknown {
  const observation = requireGame().bombard(slot, quanta);
  journal?.moves.push({ t: "bombard", slot, quanta });
  return observation;
}

function requireGame(): McpGame {
  if (!game) throw new Error("No active game — call new_game first.");
  return game;
}

function pathArg(args: Record<string, unknown>): string {
  return typeof args.path === "string" ? args.path : DEFAULT_SAVE_PATH;
}

function num(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`'${key}' must be a number`);
  }
  return value;
}

await main();

async function main(): Promise<void> {
  log("server up — waiting for JSON-RPC on stdin");
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Deno.stdin.readable) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          await handleRequest(JSON.parse(line) as JsonRpcRequest);
        } catch (error) {
          log(`bad message: ${error instanceof Error ? error.message : error}`);
        }
      }
      newline = buffer.indexOf("\n");
    }
  }
}

function log(message: string): void {
  // stdout is the protocol channel — diagnostics must go to stderr.
  console.error(`[mcp-play] ${message}`);
}

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  const isNotification = req.id === undefined;
  switch (req.method) {
    case "initialize": {
      const requested =
        (req.params?.protocolVersion as string) ?? DEFAULT_PROTOCOL_VERSION;
      reply(req.id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    case "notifications/initialized":
      return; // notification, no response
    case "ping":
      reply(req.id, {});
      return;
    case "tools/list":
      reply(req.id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
      return;
    case "tools/call": {
      const name = req.params?.name as string;
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) {
        replyError(req.id, -32602, `Unknown tool: ${name}`);
        return;
      }
      const args = (req.params?.arguments as Record<string, unknown>) ?? {};
      try {
        const result = await tool.handler(args);
        reply(req.id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (error) {
        // Tool-level failure: report as an error result so the agent sees it.
        reply(req.id, {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        });
      }
      return;
    }
    default:
      if (!isNotification) {
        replyError(req.id, -32601, `Method not found: ${req.method}`);
      }
  }
}

function reply(id: JsonRpcRequest["id"], result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function send(message: Record<string, unknown>): void {
  const line = `${JSON.stringify(message)}\n`;
  Deno.stdout.writeSync(new TextEncoder().encode(line));
}
