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
  type ViewOptions,
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
    mode?: "classic" | "modern";
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
    | { t: "build_out"; maxSeconds?: number; maxPieces?: number }
    | {
        t: "build_region";
        rect: { top: number; bottom: number; left: number; right: number };
        maxSeconds?: number;
        maxPieces?: number;
      }
    | {
        t: "path";
        from: { row: number; col: number };
        to: { row: number; col: number };
        maxSeconds?: number;
        maxPieces?: number;
      }
    | { t: "bombard"; slot: number; quanta?: number; mode?: "spread" | "choke" }
    | { t: "breach"; slot: number; towerIdx?: number }
    | {
        t: "pit_strike";
        slot: number;
        targets?: { row: number; col: number }[];
      }
    | { t: "cull"; quanta?: number }
    | { t: "declutter"; quanta?: number }
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
      "Start a new match. The agent drives one slot; the other slots are the built-in AI. Returns the first observation (castle selection). mode 'modern' adds the UPGRADE_PICK decision (rounds ≥ 3, and only when a later round exists to spend it — so set rounds ≥ 4 to reach it) plus passive modifiers/combos/catapults; default 'classic'.",
    inputSchema: {
      type: "object",
      properties: {
        seed: { type: "number", description: "Map seed (default 42)." },
        mode: {
          type: "string",
          enum: ["classic", "modern"],
          description:
            "Game mode (default 'classic'). 'modern' enables the upgrade draft + modifiers.",
        },
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
        verbose: {
          type: "boolean",
          description:
            "Repeat the full static explainers (per-phase EXPECTED menus, board legend, how-to tails) on EVERY observation instead of showing each once then collapsing to a terse pointer. Default false — leave it off for a stateful session that remembers prior turns; set true for a stateless caller or a human reading a single board.",
        },
      },
    },
    handler: async (args) => {
      // Omitting `seed` rolls a fresh random one so each session differs — but
      // we resolve it to a concrete value HERE and bake it into the journal, so
      // a random game stays fully reproducible via save/replay.
      const explicitSeed =
        args.seed === undefined ? undefined : num(args, "seed");
      const seed = explicitSeed ?? randomSeed();
      if (explicitSeed === undefined) log(`new_game: random seed ${seed}`);
      const config = {
        seed,
        mode: args.mode === "modern" ? ("modern" as const) : undefined,
        agentSlot:
          args.agentSlot === undefined ? undefined : num(args, "agentSlot"),
        rounds: args.rounds === undefined ? undefined : num(args, "rounds"),
        actionTicks:
          args.actionTicks === undefined ? undefined : num(args, "actionTicks"),
      };
      game = await startGame(config);
      journal = { config, moves: [] };
      // Fresh session → fresh show-once gate (each static explainer re-emits in
      // full the first time it's seen this game). `verbose:true` defeats it.
      seenBlocks = new Set<string>();
      renderVerbose = args.verbose === true;
      return game.observe();
    },
  },
  {
    name: "observe",
    description:
      "Return the current board observation without taking an action (phase, timer, ASCII board, your pieces/cannons, opponents). Renders the annotated board as text by default; pass format:'json' for the raw structured observation. DRIVE YOUR OWN VIEW (cheap, no clock): zoom with aroundRow/aroundCol(+radius) or a rect (minRow/maxRow/minCol/maxCol, missing edges = board bounds) for reliable tile reading without counting wide rows; pick a cumulative layer ('walls'|'terrain'|'all'); or isolate an entity subset with show (e.g. ['walls'] = just the ring, ['grunts'] = just the swarm, ['walls','grunts'] = both) to read one system without the others' clutter.",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["text", "json"],
          description:
            "Output format. 'text' (default) = the annotated ASCII board; 'json' = the raw structured observation object.",
        },
        aroundRow: {
          type: "number",
          description: "Center a square crop here (with aroundCol + radius).",
        },
        aroundCol: { type: "number" },
        radius: {
          type: "number",
          description: "Half-size of the aroundRow/aroundCol crop (default 4).",
        },
        minRow: { type: "number" },
        maxRow: { type: "number" },
        minCol: { type: "number" },
        maxCol: { type: "number" },
        layer: {
          type: "string",
          enum: ["all", "walls", "terrain"],
          description:
            "Cumulative layer depth: 'terrain' (base), 'walls' (+ ring/interior), 'all' (default, everything).",
        },
        show: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "walls",
              "bonuses",
              "pits",
              "houses",
              "towers",
              "cannons",
              "grunts",
              "cannonballs",
            ],
          },
          description:
            "Paint ONLY these entity layers over terrain (arbitrary subset; wins over layer).",
        },
      },
    },
    handler: (args) => {
      const view: ViewOptions = {};
      if (args.aroundRow !== undefined && args.aroundCol !== undefined) {
        const centerRow = num(args, "aroundRow");
        const centerCol = num(args, "aroundCol");
        const radius = args.radius === undefined ? 4 : num(args, "radius");
        view.crop = {
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
        view.crop = {
          minRow: args.minRow === undefined ? undefined : num(args, "minRow"),
          maxRow: args.maxRow === undefined ? undefined : num(args, "maxRow"),
          minCol: args.minCol === undefined ? undefined : num(args, "minCol"),
          maxCol: args.maxCol === undefined ? undefined : num(args, "maxCol"),
        };
      }
      if (typeof args.layer === "string") {
        view.layer = args.layer as ViewOptions["layer"];
      }
      if (Array.isArray(args.show)) {
        view.show = args.show as ViewOptions["show"];
      }
      const hasView = view.crop || view.layer || view.show;
      return requireGame().observe(hasView ? view : undefined);
    },
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
    name: "list_placements",
    description:
      "WALL_BUILD: EVERY legal placement of the current piece whose footprint touches a zone (default = your wall frontier), best-first, each annotated with sealsTower ('HOME' or 'tower N' — set when the placement lands on a tile that closes that pocket outright, including inner-corner diagonal-leak seals; absent otherwise), coversDrift (pre-empts a converging grunt), fillsGap, touchingWalls. The exhaustive answer to 'which placement closes/fills this here?' — retires guess-and-check check_placement loops. Focus a spot with aroundRow/aroundCol (+radius, default 3) or a rect (minRow/maxRow/minCol/maxCol); omit all for the whole frontier. Read-only, no clock.",
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
    name: "pick_upgrade",
    description:
      "MODERN, UPGRADE_PICK only: choose one of your three upgrade offers. cardIdx is the index into observation.upgradeOffers (0, 1, or 2). The pick applies for the next round only. Check observation.lastResult.success.",
    inputSchema: {
      type: "object",
      properties: {
        cardIdx: {
          type: "number",
          description: "Offer to pick: 0, 1, or 2 (index into upgradeOffers).",
        },
      },
      required: ["cardIdx"],
    },
    handler: (args) =>
      recordAct({ kind: "pick-upgrade", cardIdx: num(args, "cardIdx") }),
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
    name: "build_out",
    description:
      "WALL_BUILD: enclose your WHOLE castle in one call — the greedy form of build_toward. It seals your home, then keeps enclosing the next best tower that fits the time left (home first, then cheapest / most-bonus), so you never leave a tower unbuilt while the clock runs. When no full enclosure fits the remaining time, it PRE-CLAIMS — banks partial ring progress on the cheapest not-yet-reachable tower so next round's enclosure is cheaper — so spare build time is never idled away (idle build scores 0). Reach for this instead of chaining build_toward({towerIdx}) per tower and budgeting time by hand: one call expands as far as the clock allows. Pass maxSeconds / maxPieces to cap total spend and reserve the rest (e.g. for a defensive build). Read lastResult for which towers sealed + any pre-claim.",
    inputSchema: {
      type: "object",
      properties: {
        maxSeconds: {
          type: "number",
          description:
            "Cap TOTAL build-seconds spent across all the towers this call seals (then it stops, reserving the rest). Omit to expand until the phase nearly ends.",
        },
        maxPieces: {
          type: "number",
          description: "Cap TOTAL pieces placed this call. Omit for no cap.",
        },
      },
    },
    handler: (args) => recordBuildOut(budgetArg(args)),
  },
  {
    name: "build_region",
    description:
      "WALL_BUILD: enclose an arbitrary FOOTPRINT by position — build_toward generalised past towers. Walls the min-cut ring around `rect` (inclusive top/bottom/left/right tile coords), so any grunts inside get ENCLOSED-KILLED and the ground is claimed. Use it to ring a grunt cluster (see observation.gruntClusters — the ⚔ ENCLOSE-KILL candidates give you the box), grab a bonus square, or pre-claim open ground — the action the cluster hint always implied but had no tool for. CAVEATS: grunts MOVE during WALL_BUILD, so a cluster footprint goes stale — commit promptly and accept it can miss; the rect must have a finite cut (no leak to the map edge through water/pit) or it reports unenclosable. Read lastResult for gaps left + grunts killed. Optional maxSeconds / maxPieces.",
    inputSchema: {
      type: "object",
      properties: {
        rect: {
          type: "object",
          properties: {
            top: { type: "number" },
            bottom: { type: "number" },
            left: { type: "number" },
            right: { type: "number" },
          },
          required: ["top", "bottom", "left", "right"],
          description:
            "Footprint to enclose, inclusive tile coords. For a grunt cluster use its bounding box (gruntClusters gives minRow/maxRow/minCol/maxCol).",
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
      required: ["rect"],
    },
    handler: (args) =>
      recordBuildRegion(rectArg(args, "rect"), budgetArg(args)),
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
      "BATTLE: fire every ready cannon at one opponent's walls, pacing reload, for the rest of the battle (or `quanta` action-quanta). Waits out the countdown first. One call instead of a whole battle of fire/pass. `mode` (default 'spread') picks the aim: 'spread' hits their walls NEAREST your battery — maximises raw wall count destroyed (points + general tax); 'choke' concentrates fire on their load-bearing OUTER-RING walls ranked by un-reroutability (the same choke ranking pit_strike plants pits on — walls pinched against water/edge) — fewer walls but each costlier for them to patch (no burning pit — that effect stays super-only). 'choke' is a HEAVIER wall-tax, NOT a de-enclosure: the AI re-routes its ring and re-encloses next build either way (~90%), choke just makes the re-route pricier. Use 'choke' to tax their rebuild harder; 'spread' for raw points/wall count. Read lastResult for walls destroyed + points scored.",
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
        mode: {
          type: "string",
          enum: ["spread", "choke"],
          description:
            "Aim strategy (default 'spread'). 'spread' = nearest walls, max raw count. 'choke' = load-bearing ring walls (a heavier wall-tax, costlier to patch — NOT a de-enclosure; the normal-cannon version of pit_strike's aim).",
        },
      },
      required: ["slot"],
    },
    handler: (args) =>
      recordBombard(
        num(args, "slot"),
        args.quanta === undefined ? undefined : num(args, "quanta"),
        args.mode === "choke" ? "choke" : undefined,
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
      "BATTLE: drive the whole battle like bombard, but AIM your pit-capable gun(s) at enemy wall tiles to plant burning PITS while normal cannons chip. A pit gun is a SUPER (3×3 splash) OR a normal cannon the MORTAR upgrade elected this battle — either pits a tile it hits AS A WALL, and the pit blocks rebuilding for several rounds. A pit on a load-bearing wall TAXES their reseal (forces a costlier re-route, denies a sliver of territory) more than a random bombard hit — but it does NOT reliably deny the reseal: the AI re-encloses ~90% of pit-targeted towers next build by routing the ring around the pit (only a true geographic pinch, a 1-wide neck walled by water/edge, actually blocks it — rare). See observation.pitTargets for the best walls — drawn from the engine MIN-CUT (the load-bearing seal breach drills), so a pit there costs them more than an outer-fringe wall they never needed; omit targets to use them automatically. No pit gun that can fire FOR you (no super placed AND no Mortar gun elected, or it was destroyed / unenclosed / CAPTURED by an enemy balloon — see observation.me.capturedCannons) → behaves as a plain bombard and lastResult says why. Read lastResult for pits planted + return fire.",
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
            "Enemy WALL tiles to plant pits on (your pit gun — super or Mortar-elected normal — aims here). Omit to use observation.pitTargets for this slot.",
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
    name: "cull",
    description:
      "BATTLE (defensive): aim every ready cannon at the GRUNTS menacing YOUR OWN towers instead of an opponent — the counterpart to bombard/breach. Grunts are FROZEN during BATTLE (they move only in WALL_BUILD), so the swarm that will box your reseal next build is sitting at known tiles you can kill NOW (one shot each; no self-wall damage — grunts stand on grass). Fires the closest threats first (see observation.threats), skips out-of-range survivors, and stops once your zone is clear — handing the rest of the battle back so you can bombard the leftover time (or pass `quanta` to cap it yourself). Same live-gated, reload-paced fairness as bombard. The answer when 'grunts behind your walls' keeps climbing or a reseal is grunt-locked. Read lastResult for grunts culled + return fire.",
    inputSchema: {
      type: "object",
      properties: {
        quanta: {
          type: "number",
          description:
            "Cap on action-quanta to spend. Omit to cull until the zone is clear, then hand the rest of the battle back.",
        },
      },
    },
    handler: (args) =>
      recordCull(args.quanta === undefined ? undefined : num(args, "quanta")),
  },
  {
    name: "declutter",
    description:
      "BATTLE (self-maintenance): fire YOUR OWN battery at YOUR redundant inner ('fat') walls to shoot a build pocket back open — the structural sibling of cull. Cull clears the GRUNTS that box a reseal; declutter clears the WALLS that box your piece bag. Over-building (repeated build_out) packs a castle into single-tile seams until a dealt S/Z/C/+ piece has ZERO legal placements — a BAG-LOCK that forfeits the build and, with no alive tower enclosed, costs a LIFE. Walls can't be removed in WALL_BUILD, but a cannonball CAN shoot one out in BATTLE, so declutter is the proactive escape: it targets only NON-LOAD-BEARING fat (every 8-neighbour is your own wall/interior, so removal never breaks an enclosure), skips tower-occluded tiles a ball can't reach, and clears a CONTIGUOUS block so you get one usable 2×2+ dump pocket. It scores NOTHING (own walls) — a deliberate tempo trade of battle offense for the build room that prevents the lock. Use it the battle BEFORE you'd otherwise pack tight (watch observation.fatClearable / a climbing compactness fat/100). Same live-gated, reload-paced fairness as bombard. Read lastResult for fat cleared + tiles freed.",
    inputSchema: {
      type: "object",
      properties: {
        quanta: {
          type: "number",
          description:
            "Cap on action-quanta to spend. Omit to clear the reachable fat front, then hand the rest of the battle back (bombard it).",
        },
      },
    },
    handler: (args) =>
      recordDeclutter(
        args.quanta === undefined ? undefined : num(args, "quanta"),
      ),
  },
  {
    name: "enclosure_plan",
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
      // A restored session is a fresh render context — re-show each explainer once.
      seenBlocks = new Set<string>();
      for (const move of loaded.moves) {
        if (move.t === "act") game.act(move.decision);
        else if (move.t === "pass") game.pass(move.n, move.seconds);
        else if (move.t === "build") game.build(move.towerIdx, budgetOf(move));
        else if (move.t === "build_out") game.buildOut(budgetOf(move));
        else if (move.t === "build_region") {
          game.buildRegion(move.rect, budgetOf(move));
        } else if (move.t === "path") {
          game.path(move.from, move.to, budgetOf(move));
        } else if (move.t === "breach") game.breach(move.slot, move.towerIdx);
        else if (move.t === "pit_strike") {
          game.pitStrike(move.slot, move.targets);
        } else if (move.t === "cull") game.cull(move.quanta);
        else if (move.t === "declutter") game.declutter(move.quanta);
        else game.bombard(move.slot, move.quanta, move.mode);
      }
      journal = loaded;
      return game.observe();
    },
  },
];
const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
const AUTO_JOURNAL_DIR = "tmp/mcp-play/journal";
const AUTO_JOURNAL_LAST = "tmp/mcp-play/last.jsonl";
/** Read-only / session-meta tools excluded from the auto-journal — they don't
 *  mutate game state or advance the clock, so a clean reproduction script omits
 *  them. Everything NOT listed here is journaled (safe default: a new gameplay
 *  tool is recorded automatically). new_game/load are handled explicitly. */
const NON_JOURNALED_TOOLS = new Set([
  "observe",
  "check_placement",
  "list_placements",
  "enclosure_plan",
  "save",
]);
const AUTO_JOURNAL_LAST_EXPECTED = "tmp/mcp-play/last.expected.jsonl";

let game: McpGame | null = null;
let journal: Journal | null = null;
/** Session-scoped show-once gate for the renderer: keys of static explainer
 *  blocks already emitted this session. The MCP session is stateful (the agent
 *  retains every prior turn), so a per-phase EXPECTED menu, the board legend, and
 *  the constant how-to tails only need to be shown once — `renderObservation`
 *  collapses them to a terse pointer on every later turn. Reset at new_game.
 *  `verbose: true` on new_game keeps it empty-on-every-render (full text always),
 *  for a genuinely stateless caller or a human reading a single board. */
let seenBlocks = new Set<string>();
let renderVerbose = false;
/** Live-watch sink: when `MCP_PLAY_WATCH=<path>` is set, every board snapshot is
 *  mirrored to three sibling files so a human can watch the agent play:
 *    - `<path>` — the BOARD GRID ONLY (fits a screen without scrolling). Open it
 *      in VSCode and leave it (it auto-reverts on disk change — don't edit the
 *      buffer, a dirty buffer suppresses the reload), or `watch -n0.3 cat <path>`.
 *    - `<path>.html` — the board in an auto-refreshing page (browser / VSCode
 *      Simple Browser; self-refreshes, no dirty-buffer caveat).
 *    - `<path>.info.txt` — the analysis sections (standings, roster, battery,
 *      aim-assist) split off so they don't push the grid off-screen.
 *  Resolved once and cached. No-op when the env var is unset, so tests / CI /
 *  normal play are unaffected, and it never throws into the tool flow. */
let watchPath: string | null | undefined;
/** Auto-journal sink: every new_game opens a fresh replay-compatible `.jsonl`
 *  (the bare `{name, arguments}` tool-call shape `replay.ts` consumes) under
 *  `tmp/mcp-play/journal/`, mirrored to a stable `tmp/mcp-play/last.jsonl`. So
 *  the moment a live session ends you can replay/debug it with zero ceremony:
 *    deno task replay tmp/mcp-play/last.jsonl --quiet
 *  Holds the active session's rotated path; null between new_game and after a
 *  `load` (a restored session is reconstructed from its structured save, not
 *  this stream, so we stop appending rather than corrupt the file). tmp/ is
 *  gitignored, so this is always-on and free — no env gate to forget. */
let autoJournalPath: string | null = null;
let autoJournalSession = 0;
/** Sidecar that pairs with the active journal: one state DIGEST per journaled
 *  call (round/phase/per-player score/lives/...), keyed by call index `i`. This
 *  is the BASELINE `replay.ts --diff` compares a re-run against, so a code change
 *  is reported as "first divergence at call N, round R, phase P". Derived from
 *  `autoJournalPath` (.jsonl → .expected.jsonl). */
let autoJournalExpectedPath: string | null = null;
/** Next journaled-call index — keeps journal lines and digest lines aligned. */
let autoJournalIndex = 0;
/** Cached `MCP_PLAY_NO_JOURNAL` gate. replay.ts sets it so replaying a journal
 *  doesn't clobber `last.jsonl` (the live game you're debugging) with its own
 *  re-run. undefined = unread; resolved lazily on first call. */
let autoJournalOff: boolean | undefined;

/** The live game after the most recent `callTool` (or null before any new_game).
 *  Lets an importer (`load-game.ts`) replay a journal through `callTool` and then
 *  take the resulting harness to inspect its full hidden state + keep playing —
 *  without exposing the mutable module singleton itself. */
export function peekCurrentGame(): McpGame | null {
  return game;
}

function startGame(config: Journal["config"]): Promise<McpGame> {
  return createMcpGame({
    seed: config.seed,
    mode: config.mode,
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

/** Run the greedy whole-castle build AND journal it. */
function recordBuildOut(budget?: BuildBudget): unknown {
  const observation = requireGame().buildOut(budget);
  journal?.moves.push({
    t: "build_out",
    maxSeconds: budget?.maxSeconds,
    maxPieces: budget?.maxPieces,
  });
  return observation;
}

/** Enclose an arbitrary footprint by position AND journal it. */
function recordBuildRegion(
  rect: { top: number; bottom: number; left: number; right: number },
  budget?: BuildBudget,
): unknown {
  const observation = requireGame().buildRegion(rect, budget);
  journal?.moves.push({
    t: "build_region",
    rect,
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
function recordBombard(
  slot: number,
  quanta?: number,
  mode?: "spread" | "choke",
): unknown {
  const observation = requireGame().bombard(slot, quanta, mode);
  journal?.moves.push({ t: "bombard", slot, quanta, mode });
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

/** Run the cull executor AND journal it (replay re-derives the volley). */
function recordCull(quanta?: number): unknown {
  const observation = requireGame().cull(quanta);
  journal?.moves.push({ t: "cull", quanta });
  return observation;
}

/** Run the declutter executor AND journal it (replay re-derives the volley). */
function recordDeclutter(quanta?: number): unknown {
  const observation = requireGame().declutter(quanta);
  journal?.moves.push({ t: "declutter", quanta });
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
function rectArg(
  args: Record<string, unknown>,
  key: string,
): { top: number; bottom: number; left: number; right: number } {
  const value = args[key];
  if (typeof value !== "object" || value === null) {
    throw new Error(`'${key}' must be { top, bottom, left, right }`);
  }
  const obj = value as Record<string, unknown>;
  return {
    top: num(obj, "top"),
    bottom: num(obj, "bottom"),
    left: num(obj, "left"),
    right: num(obj, "right"),
  };
}

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

/** A fresh map seed for a no-seed new_game. Non-determinism is the point here
 *  (variety across sessions); the chosen value is recorded in the journal so
 *  the game stays reproducible. Out of the entropy lint's scope (src/game,
 *  src/ai only) — this is dev tooling, not simulation. */
function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
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
    // Mirror the call into the replay-compatible auto-journal + its digest
    // sidecar (after the handler runs, so new_game's resolved seed is available).
    // Read-only/meta calls are skipped inside; failures never reach here.
    recordAutoJournal(name, args, result);
    // Observation-shaped results render to the annotated ASCII board so the agent
    // reads the new state directly; observe({format:'json'}) opts back into raw
    // JSON, and non-observation payloads (check/plan/save) stay JSON.
    const wantJson = name === "observe" && args.format === "json";
    // `verbose` mode passes a throwaway empty Set each render, so every block
    // gets its full text every turn; otherwise the persistent session Set
    // collapses already-seen static blocks to their terse pointers.
    const rendered =
      !wantJson && isObservation(result)
        ? renderObservation(
            result,
            renderVerbose ? new Set<string>() : seenBlocks,
          )
        : JSON.stringify(result, null, 2);
    // new_game opens a session, so it's the right place to surface the build
    // stamp and (critically) a staleness warning — a subprocess spawned from
    // now-edited source is caught the moment a game starts, not via ps/git.
    const text =
      name === "new_game" ? `${serverBanner()}\n${rendered}` : rendered;
    // Mirror board snapshots to the live-watch file(s) so a human can follow
    // along (no-op unless MCP_PLAY_WATCH is set). Only boards, not check/save
    // JSON, so the watch view always holds the latest game state. The board
    // grid alone goes to the watch file (fits a screen without scrolling); the
    // analysis sections go to the `.info` sibling. The agent's own board stays
    // zone-cropped (token economy); the watch view re-renders the FULL map so a
    // human watching sees the whole battlefield, not just the agent's zone.
    if (isObservation(result)) writeWatchSnapshot(fullWatchBoard(result), text);
    return { text, isError: false };
  } catch (error) {
    return {
      text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

/** The full-map board for the watch view. The agent's tool result carries a
 *  zone-cropped board (cheaper tokens), but a human watching wants the whole
 *  battlefield — so re-render at full crop via the read-only `observe` (no clock
 *  advance). Falls back to the cropped board if anything goes wrong. */
function fullWatchBoard(cropped: Observation): string {
  if (!watchTarget()) return cropped.board; // not watching — skip the re-render
  try {
    return game?.observe({ crop: {} }).board ?? cropped.board;
  } catch {
    return cropped.board;
  }
}

/** Route a successful tool call into the auto-journal. new_game rotates a fresh
 *  file; load stops journaling (the restored session lives in its save); every
 *  other gameplay tool is appended verbatim. Never throws into the call flow. */
function recordAutoJournal(
  name: string,
  args: Record<string, unknown>,
  result: unknown,
): void {
  if (autoJournalDisabled()) return;
  if (name === "new_game") {
    if (journal) startAutoJournal(journal.config, result);
    return;
  }
  if (name === "load") {
    autoJournalPath = null;
    return;
  }
  if (NON_JOURNALED_TOOLS.has(name)) return;
  autoJournalAppend(name, args, result);
}

/** Whether auto-journaling is disabled for this process (replay context). Read
 *  once and cached; a disallowed env read falls back to enabled. */
function autoJournalDisabled(): boolean {
  if (autoJournalOff === undefined) {
    try {
      autoJournalOff = Deno.env.get("MCP_PLAY_NO_JOURNAL") != null;
    } catch {
      autoJournalOff = false;
    }
  }
  return autoJournalOff;
}

/** Open a fresh auto-journal for a new_game, seeding it with the RESOLVED opener
 *  (concrete seed baked in, so a no-seed random game stays reproducible). Writes
 *  both the rotated per-session file and the stable last.jsonl mirror. */
function startAutoJournal(config: Journal["config"], result: unknown): void {
  try {
    Deno.mkdirSync(AUTO_JOURNAL_DIR, { recursive: true });
    const path = `${AUTO_JOURNAL_DIR}/seed-${config.seed}-${autoJournalSession++}.jsonl`;
    const opener = `${JSON.stringify({
      name: "new_game",
      arguments: {
        seed: config.seed,
        ...(config.mode ? { mode: config.mode } : {}),
        ...(config.agentSlot !== undefined
          ? { agentSlot: config.agentSlot }
          : {}),
        ...(config.rounds !== undefined ? { rounds: config.rounds } : {}),
        ...(config.actionTicks !== undefined
          ? { actionTicks: config.actionTicks }
          : {}),
      },
    })}\n`;
    Deno.writeTextFileSync(path, opener); // truncate + write the opener
    Deno.writeTextFileSync(AUTO_JOURNAL_LAST, opener);
    autoJournalPath = path;
    autoJournalExpectedPath = path.replace(/\.jsonl$/, ".expected.jsonl");
    autoJournalIndex = 0;
    // Truncate the digest sidecars, then record the opener's digest as index 0.
    Deno.writeTextFileSync(autoJournalExpectedPath, "");
    Deno.writeTextFileSync(AUTO_JOURNAL_LAST_EXPECTED, "");
    appendDigest(result);
    log(`auto-journal: ${path} (mirror ${AUTO_JOURNAL_LAST})`);
  } catch {
    autoJournalPath = null; // FS not writable — disable silently.
    autoJournalExpectedPath = null;
  }
}

function log(message: string): void {
  // stdout is the protocol channel — diagnostics must go to stderr.
  console.error(`[mcp-play] ${message}`);
}

/** Append one bare tool-call line to the active auto-journal and its mirror,
 *  then record the resulting state digest at the matching index. No-op unless a
 *  new_game-started session is active. */
function autoJournalAppend(
  name: string,
  args: Record<string, unknown>,
  result: unknown,
): void {
  if (!autoJournalPath) return;
  const line = `${JSON.stringify({ name, arguments: args })}\n`;
  try {
    Deno.writeTextFileSync(autoJournalPath, line, { append: true });
    Deno.writeTextFileSync(AUTO_JOURNAL_LAST, line, { append: true });
  } catch {
    autoJournalPath = null; // a write failed — stop rather than retry-spam.
    return;
  }
  appendDigest(result);
}

/** Append the state digest for the just-journaled call, keyed by its index so a
 *  later `--diff` matches it to the replayed call positionally. Always advances
 *  the index (even for a non-observation result) so it stays aligned with the
 *  journal line count; a non-observation call simply has no baseline digest. */
function appendDigest(result: unknown): void {
  if (!autoJournalExpectedPath) return;
  const index = autoJournalIndex++;
  if (!isObservation(result)) return;
  const line = `${JSON.stringify({ i: index, ...observationDigest(result) })}\n`;
  try {
    Deno.writeTextFileSync(autoJournalExpectedPath, line, { append: true });
    Deno.writeTextFileSync(AUTO_JOURNAL_LAST_EXPECTED, line, { append: true });
  } catch {
    autoJournalPath = null;
    autoJournalExpectedPath = null;
  }
}

/** A deterministic state projection used as the replay-diff baseline: round /
 *  phase / game-over plus each player's lives, score, projected score, walls,
 *  cannons and enclosed towers. Cosmetic fields (board crop, cursor, timers)
 *  are deliberately excluded — a diff should flag GAME divergence, not render
 *  jitter. Exported so replay.ts computes the comparison digest the same way. */
export function observationDigest(obs: Observation): {
  round: number;
  phase: string;
  gameOver: boolean;
  players: {
    slot: number;
    lives: number;
    eliminated: boolean;
    score: number;
    projected: number;
    walls: number;
    cannons: number;
    enclosedTowers: number;
  }[];
} {
  return {
    round: obs.round,
    phase: obs.phase,
    gameOver: obs.gameOver,
    players: obs.layout
      .slice()
      .sort((a, b) => a.slot - b.slot)
      .map((player) => ({
        slot: player.slot,
        lives: player.lives,
        eliminated: player.eliminated,
        score: player.score,
        projected: player.projected,
        walls: player.walls,
        cannons: player.cannons,
        enclosedTowers: player.enclosedTowers,
      })),
  };
}

function writeWatchSnapshot(board: string, full: string): void {
  const path = watchTarget();
  if (!path) return;
  const stem = path.replace(/\.(txt|log|board)$/, "");
  // The "additional data" = the full render minus the trailing board grid.
  const info = full.endsWith(board)
    ? full.slice(0, full.length - board.length).trimEnd()
    : full;
  try {
    Deno.writeTextFileSync(path, board); // board only — fits a screen
    Deno.writeTextFileSync(`${stem}.html`, watchHtml(board));
    Deno.writeTextFileSync(`${stem}.info.txt`, info); // standings/roster/aim-assist
  } catch {
    // A bad path / transient FS error must never break the agent's call — drop it.
  }
}

function watchTarget(): string | null {
  if (watchPath === undefined) {
    try {
      watchPath = Deno.env.get("MCP_PLAY_WATCH") ?? null;
    } catch {
      watchPath = null; // env read not permitted — silently disable.
    }
  }
  return watchPath;
}

/** Wrap the board in a minimal dark-mode page that re-reads itself every 0.5s. */
function watchHtml(board: string): string {
  const escaped = board
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="refresh" content="0.5"><title>mcp-play live</title>` +
    `<style>body{margin:0;background:#0d0d10;color:#d8d8d8}` +
    `pre{font:13px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace;padding:12px;white-space:pre}</style>` +
    `</head><body><pre>${escaped}</pre></body></html>`
  );
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
