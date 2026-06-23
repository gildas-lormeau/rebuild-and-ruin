/**
 * mcp-play — a dependency-free MCP stdio server that lets an external agent
 * play a classic match of Rebuild & Ruin through the headless runtime.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout (the MCP stdio
 * transport). stdout is the protocol channel — all logging goes to stderr.
 * Implements the minimal MCP surface an agent host needs: `initialize`,
 * `tools/list`, `tools/call`, `ping`.
 *
 * Each tool returns the resulting board observation rendered as an annotated
 * ASCII board (pass observe's format:'json' for the raw observation object), so
 * the agent sees the new state immediately after acting. One game at a time.
 *
 * Run: deno run -A scripts/mcp-play/server.ts
 * (dev/research tool — never wired into determinism or parity suites.)
 */

import { toCannonMode } from "../../src/shared/core/cannon-mode-defs.ts";
import type { ValidPlayerId } from "../../src/shared/core/player-slot.ts";
import {
  type BuildBudget,
  createMcpGame,
  type McpGame,
  type Observation,
} from "./harness.ts";
import type { AgentDecision } from "./mcp-brain.ts";
import { renderObservation } from "./render.ts";

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
    | { t: "pass"; n: number; seconds?: number }
    | {
        t: "build";
        towerIdx?: number;
        maxSeconds?: number;
        maxPieces?: number;
      }
    | { t: "reinforce"; maxSeconds?: number; maxPieces?: number }
    | {
        t: "path";
        from: { row: number; col: number };
        to: { row: number; col: number };
        maxSeconds?: number;
        maxPieces?: number;
      }
    | { t: "bombard"; slot: number; quanta?: number }
    | { t: "breach"; slot: number; towerIdx?: number }
    | {
        t: "pit_strike";
        slot: number;
        targets?: { row: number; col: number }[];
      }
  )[];
}

// The running build is identified by the newest mtime across the mcp-play
// source files, captured at process launch. A stdio server reads its source
// once at spawn and never reloads, so if those files change afterwards the
// running process is stale — `serverBanner()` detects that by re-stat'ing.
// (Auto-derived rather than a hand-bumped semver, which rots and, frozen at
// spawn, can't tell you newer code exists — the exact trap that wasted time.)
const BUILD_STAMP_MS = sourceMtimeMs();
const BUILD_STAMP = formatStamp(BUILD_STAMP_MS);
const SERVER_INFO = { name: "rebuild-and-ruin-play", version: BUILD_STAMP };
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
      "Return the current board observation without taking an action (phase, timer, ASCII board, your pieces/cannons, opponents). Renders the annotated board as text by default; pass format:'json' for the raw structured observation.",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["text", "json"],
          description:
            "Output format. 'text' (default) = the annotated ASCII board; 'json' = the raw structured observation object.",
        },
      },
    },
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
    name: "placements",
    description:
      "WALL_BUILD: EVERY legal placement of the current piece whose footprint touches a zone (default = your wall frontier), best-first, each annotated with sealsTower (lands on a tile that closes that pocket — including inner-corner diagonal-leak seals), coversDrift (pre-empts a converging grunt), fillsGap, touchingWalls. The exhaustive answer to 'which placement closes/fills this here?' — retires guess-and-check check_placement loops. Focus a spot with aroundRow/aroundCol (+radius, default 3) or a rect (minRow/maxRow/minCol/maxCol); omit all for the whole frontier. Read-only, no clock.",
    inputSchema: {
      type: "object",
      properties: {
        aroundRow: {
          type: "number",
          description: "Center a square window here (with aroundCol + radius).",
        },
        aroundCol: { type: "number" },
        radius: {
          type: "number",
          description:
            "Half-size of the aroundRow/aroundCol window (default 3).",
        },
        minRow: { type: "number" },
        maxRow: { type: "number" },
        minCol: { type: "number" },
        maxCol: { type: "number" },
      },
    },
    handler: (args) => {
      let zone: {
        minRow?: number;
        maxRow?: number;
        minCol?: number;
        maxCol?: number;
      } | null = null;
      if (args.aroundRow !== undefined && args.aroundCol !== undefined) {
        const centerRow = num(args, "aroundRow");
        const centerCol = num(args, "aroundCol");
        const radius = args.radius === undefined ? 3 : num(args, "radius");
        zone = {
          minRow: centerRow - radius,
          maxRow: centerRow + radius,
          minCol: centerCol - radius,
          maxCol: centerCol + radius,
        };
      } else if (
        ["minRow", "maxRow", "minCol", "maxCol"].some(
          (key) => args[key] !== undefined,
        )
      ) {
        zone = {
          minRow: args.minRow === undefined ? undefined : num(args, "minRow"),
          maxRow: args.maxRow === undefined ? undefined : num(args, "maxRow"),
          minCol: args.minCol === undefined ? undefined : num(args, "minCol"),
          maxCol: args.maxCol === undefined ? undefined : num(args, "maxCol"),
        };
      }
      return requireGame().placements(zone);
    },
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
      "Advance game time WITHOUT committing anything ('nothing to do, let time run'). Units are SECONDS — the SAME number you read as timerSec: pass({ seconds: 5 }) advances ~5s. It STOPS EARLY the moment something actionable changes — the phase flips, the pre-battle countdown ends, or the game ends — so a big value cheaply skips to the next decision (e.g. run out a quiet build, wait out a countdown). Omit args to step one beat. In BATTLE you re-decide fire/pass each step. To end cannon placement early use end_cannon. (`count` = raw action-quanta is a legacy form; prefer seconds.)",
    inputSchema: {
      type: "object",
      properties: {
        seconds: {
          type: "number",
          description:
            "Game seconds to advance (matches timerSec). Stops early on a phase change. The intuitive unit.",
        },
        count: {
          type: "number",
          description:
            "Legacy: action-quanta to advance (one decision step each, default 1). Prefer `seconds`.",
        },
      },
    },
    handler: (args) =>
      recordPass(
        args.count === undefined ? 1 : num(args, "count"),
        args.seconds === undefined ? undefined : num(args, "seconds"),
      ),
  },
  {
    name: "build_toward",
    description:
      "WALL_BUILD: hand the whole build phase to the harness with one goal — enclose a tower (default: your home tower). It places each piece that arrives on the best min-cut tile (reacting to pieces, never peeking ahead), redirecting dud pieces onto the ring, until the tower seals, build time runs low, or it stalls. When the last gap is a sub-piece island that needs a smaller piece (or a mobile grunt that may wander off), it keeps cycling the bag toward a fitting draw instead of giving up. One call instead of dozens of place_piece calls. With NO maxSeconds it self-caps (≈ the seal estimate + buffer) so one big enclosure can't gamble the whole phase — it pauses with progress banked (outcome 'auto-paused'); just call it again to continue. Pass maxSeconds / maxPieces to STOP EARLY and reserve the rest of the phase for a second build. Read lastResult for the outcome (done/time/auto-paused/sec-budget/piece-budget/stuck/blocked/diverging + gaps left + seconds spent).",
    inputSchema: {
      type: "object",
      properties: {
        towerIdx: {
          type: "number",
          description:
            "Tower to enclose (see enclosureCandidates). Omit to repair/seal your home tower.",
        },
        maxSeconds: {
          type: "number",
          description:
            "Cap build-seconds spent THIS call (then it stops, reserving the rest). Omit to run to completion.",
        },
        maxPieces: {
          type: "number",
          description: "Cap pieces placed THIS call. Omit for no piece cap.",
        },
      },
    },
    handler: (args) =>
      recordBuild(
        args.towerIdx === undefined ? undefined : num(args, "towerIdx"),
        budgetArg(args),
      ),
  },
  {
    name: "reinforce",
    description:
      "WALL_BUILD: anchor the loose ends of an UN-CLOSED wall — it re-reads your fragile walls (≤1 wall-neighbour tiles the round-end sweep DELETES — see observation.fragileWalls) and places each arriving piece against them so every one gains a second neighbour. NARROW USE: a closed pocket is ALREADY sweep-proof — its ring walls always keep ≥2 neighbours, so the sweep can only ever shave dangling stubs, never open a sealed castle. Reinforcing a finished castle just spends pieces (and can bury a fat wall). Reach for this only to preserve a build_path PRE-CLAIM line you'll close a later round. Does NOT enclose a tower (build_toward) or lay a line (build_path). Read lastResult for fragile before→after. Optional maxSeconds / maxPieces.",
    inputSchema: {
      type: "object",
      properties: {
        maxSeconds: {
          type: "number",
          description: "Cap build-seconds spent THIS call (reserve the rest).",
        },
        maxPieces: {
          type: "number",
          description: "Cap pieces placed THIS call.",
        },
      },
    },
    handler: (args) => recordReinforce(budgetArg(args)),
  },
  {
    name: "build_path",
    description:
      "WALL_BUILD: lay a straight wall LINE (or an L, when the endpoints aren't row/col-aligned) from `from` to `to`, placing whatever pieces arrive over the route — the geometric counterpart to build_toward. Use it to pre-claim a flank, bridge two towers, or start a region you'll close next round. CRITICAL: partial walls survive the round-end sweep ONLY where each tile keeps ≥2 orthogonal wall-neighbours, so ANCHOR both ends on existing wall — a floating segment's open ends erode ~1 tile per sweep. lastResult reports tiles laid + any sweep-fragile ends; cross-check observation.fragileWalls. Optional maxSeconds / maxPieces to reserve time.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "object",
          properties: { row: { type: "number" }, col: { type: "number" } },
          required: ["row", "col"],
          description: "Line start — anchor it on (or next to) existing wall.",
        },
        to: {
          type: "object",
          properties: { row: { type: "number" }, col: { type: "number" } },
          required: ["row", "col"],
          description: "Line end — anchor it on (or next to) existing wall.",
        },
        maxSeconds: {
          type: "number",
          description: "Cap build-seconds spent THIS call (reserve the rest).",
        },
        maxPieces: {
          type: "number",
          description: "Cap pieces placed THIS call.",
        },
      },
      required: ["from", "to"],
    },
    handler: (args) =>
      recordPath(point(args, "from"), point(args, "to"), budgetArg(args)),
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
    name: "breach",
    description:
      "BATTLE: CONCENTRATE fire on the outer ring guarding ONE of an opponent's enclosed towers to de-enclose its pocket — denying that pocket's territory + bonus squares next build, where bombard just spreads damage they reseal. Omit towerIdx to auto-target their softest tower (fewest ringWalls / most bonus). See targets[].towers. Read lastResult for ring walls destroyed + whether the pocket opened.",
    inputSchema: {
      type: "object",
      properties: {
        slot: {
          type: "number",
          description: "Opponent slot to breach (see layout / targets).",
        },
        towerIdx: {
          type: "number",
          description:
            "Which of their enclosed towers to open (see targets[].towers). Omit for the softest.",
        },
      },
      required: ["slot"],
    },
    handler: (args) =>
      recordBreach(
        num(args, "slot"),
        args.towerIdx === undefined ? undefined : num(args, "towerIdx"),
      ),
  },
  {
    name: "pit_strike",
    description:
      "BATTLE: drive the whole battle like bombard, but AIM your SUPER cannon(s) at enemy wall tiles to plant burning PITS while normal cannons chip. A super ball pits a tile it hits AS A WALL, and the pit blocks rebuilding for several rounds — so a pit on a load-bearing / un-reroutable wall denies their reseal, unlike a bombard hit they patch next build. See observation.pitTargets for the best walls (ranked by choke = un-reroutable sides); omit targets to use them automatically. No super that can fire FOR you (none placed, or it was destroyed / unenclosed / CAPTURED by an enemy balloon — see observation.me.capturedCannons) → behaves as a plain bombard and lastResult says why. Read lastResult for pits planted + return fire.",
    inputSchema: {
      type: "object",
      properties: {
        slot: {
          type: "number",
          description: "Opponent slot to strike (see layout / targets).",
        },
        targets: {
          type: "array",
          description:
            "Enemy WALL tiles to plant pits on (super aims here). Omit to use observation.pitTargets for this slot.",
          items: {
            type: "object",
            properties: {
              row: { type: "number" },
              col: { type: "number" },
            },
            required: ["row", "col"],
          },
        },
      },
      required: ["slot"],
    },
    handler: (args) =>
      recordPitStrike(num(args, "slot"), points(args, "targets")),
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
        else if (move.t === "pass") game.pass(move.n, move.seconds);
        else if (move.t === "build") game.build(move.towerIdx, budgetOf(move));
        else if (move.t === "reinforce") game.reinforce(budgetOf(move));
        else if (move.t === "path") {
          game.path(move.from, move.to, budgetOf(move));
        } else if (move.t === "breach") game.breach(move.slot, move.towerIdx);
        else if (move.t === "pit_strike") {
          game.pitStrike(move.slot, move.targets);
        } else game.bombard(move.slot, move.quanta);
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

/** Advance time AND journal it (seconds is the agent-facing unit; n is the
 *  legacy quantum count the harness falls back to when seconds is absent). */
function recordPass(n: number, seconds?: number): unknown {
  const observation = requireGame().pass(n, seconds);
  journal?.moves.push({ t: "pass", n, seconds });
  return observation;
}

/** Run the build-toward executor AND journal the goal (replay re-derives placements). */
function recordBuild(towerIdx?: number, budget?: BuildBudget): unknown {
  const observation = requireGame().build(towerIdx, budget);
  journal?.moves.push({
    t: "build",
    towerIdx,
    maxSeconds: budget?.maxSeconds,
    maxPieces: budget?.maxPieces,
  });
  return observation;
}

/** Make the existing ring sweep-proof AND journal it. */
function recordReinforce(budget?: BuildBudget): unknown {
  const observation = requireGame().reinforce(budget);
  journal?.moves.push({
    t: "reinforce",
    maxSeconds: budget?.maxSeconds,
    maxPieces: budget?.maxPieces,
  });
  return observation;
}

/** Run the build-path executor AND journal the route (replay re-derives placements). */
function recordPath(
  from: { row: number; col: number },
  to: { row: number; col: number },
  budget?: BuildBudget,
): unknown {
  const observation = requireGame().path(from, to, budget);
  journal?.moves.push({
    t: "path",
    from,
    to,
    maxSeconds: budget?.maxSeconds,
    maxPieces: budget?.maxPieces,
  });
  return observation;
}

/** Run the bombard executor AND journal the target (replay re-derives the volley). */
function recordBombard(slot: number, quanta?: number): unknown {
  const observation = requireGame().bombard(slot, quanta);
  journal?.moves.push({ t: "bombard", slot, quanta });
  return observation;
}

/** Run the breach executor AND journal the target (replay re-derives the volley). */
function recordBreach(slot: number, towerIdx?: number): unknown {
  const observation = requireGame().breach(slot, towerIdx);
  journal?.moves.push({ t: "breach", slot, towerIdx });
  return observation;
}

/** Run the pit-strike executor AND journal it (replay re-derives the volley). */
function recordPitStrike(
  slot: number,
  targets?: { row: number; col: number }[],
): unknown {
  const observation = requireGame().pitStrike(slot, targets);
  journal?.moves.push({ t: "pit_strike", slot, targets });
  return observation;
}

function requireGame(): McpGame {
  if (!game) throw new Error("No active game — call new_game first.");
  return game;
}

function pathArg(args: Record<string, unknown>): string {
  return typeof args.path === "string" ? args.path : DEFAULT_SAVE_PATH;
}

/** Parse a `{ row, col }` argument (build_path endpoints). */
function point(
  args: Record<string, unknown>,
  key: string,
): { row: number; col: number } {
  const value = args[key];
  if (typeof value !== "object" || value === null) {
    throw new Error(`'${key}' must be { row, col }`);
  }
  const obj = value as Record<string, unknown>;
  return { row: num(obj, "row"), col: num(obj, "col") };
}

/** Parse an OPTIONAL array of { row, col } — undefined when the key is absent. */
function points(
  args: Record<string, unknown>,
  key: string,
): { row: number; col: number }[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`'${key}' must be an array of { row, col }`);
  }
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`'${key}' entries must be { row, col }`);
    }
    const obj = entry as Record<string, unknown>;
    return { row: num(obj, "row"), col: num(obj, "col") };
  });
}

/** Collect the optional build budget (maxSeconds / maxPieces) from tool args, or
 *  undefined when neither is set (so the executor runs to completion). */
function budgetArg(args: Record<string, unknown>): BuildBudget | undefined {
  const budget: BuildBudget = {};
  if (args.maxSeconds !== undefined) {
    budget.maxSeconds = num(args, "maxSeconds");
  }
  if (args.maxPieces !== undefined) budget.maxPieces = num(args, "maxPieces");
  return budget.maxSeconds === undefined && budget.maxPieces === undefined
    ? undefined
    : budget;
}

function num(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`'${key}' must be a number`);
  }
  return value;
}

/** Reconstruct a build budget from a journaled move during replay. */
function budgetOf(move: {
  maxSeconds?: number;
  maxPieces?: number;
}): BuildBudget | undefined {
  return move.maxSeconds === undefined && move.maxPieces === undefined
    ? undefined
    : { maxSeconds: move.maxSeconds, maxPieces: move.maxPieces };
}

// Only start the stdin JSON-RPC reader when run as the entry point — importing
// this module (e.g. from replay.ts) reuses the tool registry + callTool without
// blocking on stdin.
if (import.meta.main) await main();

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
      if (!TOOL_BY_NAME.has(name)) {
        replyError(req.id, -32602, `Unknown tool: ${name}`);
        return;
      }
      const args = (req.params?.arguments as Record<string, unknown>) ?? {};
      const { text, isError } = await callTool(name, args);
      reply(
        req.id,
        isError
          ? { isError: true, content: [{ type: "text", text }] }
          : { content: [{ type: "text", text }] },
      );
      return;
    }
    default:
      if (!isNotification) {
        replyError(req.id, -32601, `Method not found: ${req.method}`);
      }
  }
}

/** Run a tool by name and render its result exactly as the stdio server does:
 *  observation-shaped results become the annotated ASCII board (observe's
 *  format:'json' opts back to raw JSON), everything else is pretty JSON; unknown
 *  args and tool throws come back as { isError:true } with a message. The single
 *  dispatch shared by the JSON-RPC `tools/call` path AND the `replay.ts` harness,
 *  so both drive identical behaviour. */
export async function callTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return { text: `Unknown tool: ${name}`, isError: true };
  const unknown = unknownArgs(tool, args);
  if (unknown.length > 0) {
    const accepted = Object.keys(
      (tool.inputSchema as { properties?: Record<string, unknown> })
        .properties ?? {},
    );
    return {
      text: `Error: unknown argument(s) [${unknown.join(
        ", ",
      )}] for '${name}'. Accepted: [${accepted.join(", ") || "none"}].`,
      isError: true,
    };
  }
  try {
    const result = await tool.handler(args);
    // Observation-shaped results render to the annotated ASCII board so the agent
    // reads the new state directly; observe({format:'json'}) opts back into raw
    // JSON, and non-observation payloads (check/plan/save) stay JSON.
    const wantJson = name === "observe" && args.format === "json";
    const rendered =
      !wantJson && isObservation(result)
        ? renderObservation(result)
        : JSON.stringify(result, null, 2);
    // new_game opens a session, so it's the right place to surface the build
    // stamp and (critically) a staleness warning — a subprocess spawned from
    // now-edited source is caught the moment a game starts, not via ps/git.
    const text =
      name === "new_game" ? `${serverBanner()}\n${rendered}` : rendered;
    return { text, isError: false };
  } catch (error) {
    return {
      text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

/** Does a tool result look like a board observation (vs a check/plan/save
 *  payload)? Observation-shaped results render to the annotated ASCII board;
 *  everything else stays raw JSON. Keyed on the two fields only an observation
 *  has — a string `phase` and a string `board`. */
function isObservation(value: unknown): value is Observation {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { phase?: unknown }).phase === "string" &&
    typeof (value as { board?: unknown }).board === "string"
  );
}

/** Keys in `args` the tool's schema doesn't declare. A misspelled optional arg
 *  (e.g. pass `ticks` instead of `count`/`seconds`) otherwise silently defaults
 *  to "absent", so the call no-ops in a confusing way — reject it loudly with
 *  the accepted list instead. */
function unknownArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  const props =
    (tool.inputSchema as { properties?: Record<string, unknown> }).properties ??
    {};
  return Object.keys(args).filter((key) => !(key in props));
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

/** Build/staleness banner prepended to new_game output. If the source changed
 *  since launch the running stdio process is stale (it won't reload on its
 *  own) — say so and tell the agent to reconnect. */
function serverBanner(): string {
  const now = sourceMtimeMs();
  if (now > BUILD_STAMP_MS) {
    return `⚠ SERVER STALE — running build ${BUILD_STAMP}, source now ${formatStamp(
      now,
    )}. Reconnect the MCP server to load the latest code.`;
  }
  return `server build ${BUILD_STAMP} (current)`;
}

/** Newest mtime (epoch ms) across the mcp-play source files whose change means
 *  the live (spawn-frozen) process is stale; 0 if none can be stat'd (degrades
 *  to an "unknown" stamp rather than throwing). The list is inlined so this
 *  stays self-contained — it runs at module load, before most consts exist. */
function sourceMtimeMs(): number {
  const sourceFiles = ["server.ts", "harness.ts", "render.ts", "mcp-brain.ts"];
  let newest = 0;
  for (const name of sourceFiles) {
    try {
      const ms = Deno.statSync(new URL(name, import.meta.url)).mtime?.getTime();
      if (ms && ms > newest) newest = ms;
    } catch {
      // A missing/unreadable source file simply doesn't contribute to the stamp.
    }
  }
  return newest;
}

/** Format an mtime as a compact, sortable UTC stamp for the version string. */
function formatStamp(ms: number): string {
  return ms === 0 ? "unknown" : `${new Date(ms).toISOString().slice(0, 19)}Z`;
}
