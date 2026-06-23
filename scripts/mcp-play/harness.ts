/**
 * McpGame — the driver that lets one external agent play a full classic match
 * through the headless runtime. It installs an `McpBrain` on the agent's slot
 * (the other slots stay default AI), then exposes a turn-based `observe` /
 * `act` / `pass` surface on top of the mock clock.
 *
 * Pacing model: the mock clock only advances when we tick, so while the agent
 * "thinks" (between calls) game time is frozen — no phase can time out on it.
 * Each `act`/`pass` applies the decision, then burns a fixed `actionTicks`
 * budget of sim-frames so phase timers still progress and timed phases end
 * naturally, then settles onto the next point where the agent owes a move
 * (auto-skipping banners, countdowns, score overlays, and opponent-only ticks).
 *
 * Dev/research tool: lives in `scripts/`, never wired into determinism or
 * parity suites (the agent slot is non-deterministic by design).
 */

import { asciiSnapshot } from "../../dev/dev-console-grid.ts";
import { castleRect, isTowerEnclosable } from "../../src/ai/ai-castle-rect.ts";
import { findEnclosureCut } from "../../src/ai/ai-min-cut.ts";
import { DefaultStrategy } from "../../src/ai/ai-strategy.ts";
import { AiController } from "../../src/controllers/controller-ai.ts";
import { createController } from "../../src/controllers/controller-factory.ts";
import { canFireOwnCannon } from "../../src/game/battle-system.ts";
import { canPlacePiece } from "../../src/game/build-system.ts";
import {
  cannonSlotsUsed,
  canPlaceCannon,
} from "../../src/game/cannon-system.ts";
import type { CannonMode } from "../../src/shared/core/battle-types.ts";
import { cannonModesForGame } from "../../src/shared/core/cannon-mode-defs.ts";
import { Phase } from "../../src/shared/core/game-phase.ts";
import type { TileRect } from "../../src/shared/core/geometry-types.ts";
import { type PieceShape, rotateCW } from "../../src/shared/core/pieces.ts";
import type { ValidPlayerId } from "../../src/shared/core/player-slot.ts";
import {
  cannonSize,
  distanceToTower,
  inBounds,
  packTile,
  unpackTile,
  zoneAt,
} from "../../src/shared/core/spatial.ts";
import type { ControllerFactory } from "../../src/shared/core/system-interfaces.ts";
import { cannonSlotsFor } from "../../src/shared/core/types.ts";
import { PLAYER_NAMES } from "../../src/shared/ui/player-config.ts";
import { Mode } from "../../src/shared/ui/ui-mode.ts";
import { createScenario, type Scenario } from "../../test/scenario.ts";
import {
  type AgentBridge,
  type AgentDecision,
  type AgentResult,
  createAgentBridge,
  createMcpBrain,
  DEFAULT_CANNON_MODE,
} from "./mcp-brain.ts";

export interface McpGameOptions {
  /** Map seed. Controls terrain + the opponent AIs' rolls. Default 42. */
  seed?: number;
  /** Which slot the agent drives. Default 0. */
  agentSlot?: ValidPlayerId;
  /** Rounds before the match ends. Default 3. */
  rounds?: number;
  /** Sim-frames advanced per agent action — the "time cost" of a move, which
   *  lets timed phases (build 25s, cannon 15s, battle 10s) end naturally.
   *  Default 30 (≈0.5s at 60fps). Lower it to give the agent more moves per
   *  phase. In BATTLE this doubles as the reaction quantum: the agent re-decides
   *  fire-or-pass every `actionTicks` frames, so smaller = finer reaction to
   *  cannonballs/grunts, larger = faster but coarser. (A separate battle quantum
   *  is a clean future split if build and battle want different granularity.) */
  actionTicks?: number;
}

export interface TowerHint {
  index: number;
  row: number;
  col: number;
  enclosed: boolean;
}

/** Inclusive bounding box of a player's wall ring — lets the agent place each
 *  castle on the map at a glance without parsing the undifferentiated ASCII. */
export interface CastleBounds {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}

/** A suggested placement for the current piece (WALL_BUILD helper). */
export interface BuildSuggestion {
  row: number;
  col: number;
  rotation: number;
  /** Piece tiles that plug a 1-wide hole (existing walls on both opposite
   *  sides). This is what re-closes a breached ring — the primary sort key. */
  fillsGap: number;
  /** Total adjacencies between the piece's tiles and existing walls — the
   *  tiebreak (higher = hugs the ring more rather than floating loose). */
  touchingWalls: number;
}

/** An enclosure option in my zone: a tower I could wall in, with the exact
 *  min-cut tiles to do it. Computed via the engine's own `findEnclosureCut`, so
 *  `tiles` is a deterministic placement plan, not a heuristic. */
export interface EnclosureCandidate {
  towerIdx: number;
  isHome: boolean;
  /** "enclosed" = already sealed; "enclosable" = needs `tiles`; "unenclosable"
   *  = no wallable ring (leaks to the map edge through water/pit/etc.). */
  status: "enclosed" | "enclosable" | "unenclosable";
  /** Number of new wall tiles needed to close it (0 if already enclosed). */
  tilesNeeded: number;
  /** The exact tiles to wall — the min-cut. Fill these and the tower encloses. */
  tiles: { row: number; col: number }[];
  /** Enclosable within one build phase (cut ≤ SOLO_MAX_GAPS). */
  feasible: boolean;
}

/** A battle aim-assist entry: one opponent and a sample of their wall tiles. */
export interface BattleTarget {
  slot: number;
  name: string;
  score: number;
  /** Intact wall tiles remaining (watch it drop as your shots land). */
  walls: number;
  /** A contiguous sample of their wall tiles (top-to-bottom) to fire at. */
  sampleTiles: { row: number; col: number }[];
}

/** A legal cannon placement in CANNON_PLACE — the green-phantom shortlist so the
 *  agent need not probe the interior tile by tile (and so it can SEE whether a
 *  super 3×3 fits at all). */
export interface CannonSuggestion {
  /** Mode string ("normal" | "super" | "balloon" | "rampart"). */
  mode: CannonMode;
  /** Top-left anchor of the footprint. */
  row: number;
  col: number;
  /** Footprint side: 2 (normal/balloon/rampart) or 3 (super). */
  size: number;
  /** Cannon slots this placement consumes. */
  slotCost: number;
  /** Footprint edges abutting walls/tower/other cannons — higher = more compact
   *  (tucked into a corner, leaving the interior less fragmented). */
  hugs: number;
}

/** A grunt bearing down on one of my towers — the defensive signal that, when
 *  ignored, lets a grunt walk through a breach and kill the tower. */
export interface ThreatInfo {
  grunt: { row: number; col: number };
  /** "catapult" reaches a tower from up to 3 tiles (bypasses shielding cannons). */
  kind: "grunt" | "catapult";
  /** My tower it's heading for (it kills towers, not walls, ultimately). */
  tower: { idx: number; row: number; col: number };
  /** Manhattan distance to the nearest tile of that 2×2 tower. */
  distance: number;
  /** Is the tower walled in right now? If false, the grunt has a clear path —
   *  the urgent case. If true, it must breach a wall first. */
  towerEnclosed: boolean;
  /** Grunt is adjacent and counting down to a kill/break. */
  attacking: boolean;
  /** The specific wall tile it will strike (engine's end-of-build pick), if set —
   *  the tile to defend. */
  targetedWall?: { row: number; col: number };
}

/** One row of the at-a-glance roster: who is where, how big, how armed. */
export interface PlayerLayout {
  slot: number;
  name: string;
  isMe: boolean;
  lives: number;
  eliminated: boolean;
  home: { row: number; col: number } | null;
  castle: CastleBounds | null;
  walls: number;
  cannons: number;
  enclosedTowers: number;
}

export interface Observation {
  phase: string;
  round: number;
  timerSec: number;
  /** Pre-battle "Ready/Aim/Fire" countdown (seconds). While > 0 the battle is
   *  NOT live yet — `timerSec` is frozen and shots are wasted; wait it out. 0
   *  outside BATTLE and once the battle has started. */
  battleCountdown: number;
  gameOver: boolean;
  /** One-line description of the decision the agent is expected to make. */
  expected: string;
  /** Every player's castle at a glance: home + wall bounding box + armament.
   *  The fast way to read the battlefield without decoding the ASCII grid. */
  layout: PlayerLayout[];
  /** Cannonballs currently in flight (battle only) — how many shots are still
   *  travelling before their damage lands. */
  cannonballsInFlight: number;
  /** ASCII board: cropped to the agent's zone (with coords) during build /
   *  cannon / select; full map during battle so the agent can aim at rivals. */
  board: string;
  me: {
    slot: number;
    lives: number;
    score: number;
    eliminated: boolean;
    /** Home tower top-left (the centre of your castle), or null pre-selection. */
    homeTower: { row: number; col: number } | null;
    currentPiece: string | null;
    cannons: number;
    /** Cannon slots: how many you've used and your cap this round. Each cannon
     *  costs slots by footprint (normal/balloon 2×2, super 3×3). */
    cannonSlots: { used: number; max: number };
    /** Top-left of each cannon you've placed (so you know your guns in battle). */
    cannonPositions: { row: number; col: number; mode: CannonMode }[];
    /** BATTLE: how many of your cannons can fire THIS INSTANT. A cannon reloads
     *  only when its previous ball lands (one ball in flight per cannon), so
     *  firing more than this many in a burst just wastes actions on reload —
     *  fire up to `cannonsReady`, then `pass` a beat to let balls land. */
    cannonsReady: number;
    walls: number;
    interior: number;
    enclosedTowers: number;
    homeTowerEnclosed: boolean;
  };
  opponents: {
    slot: number;
    lives: number;
    score: number;
    eliminated: boolean;
    walls: number;
    /** Opponent home tower top-left — a visible target to aim at in battle. */
    homeTower: { row: number; col: number } | null;
  }[];
  /** Selection-phase only: the towers in the agent's zone it may pick. */
  towers?: TowerHint[];
  /** CANNON_PLACE only: legal placements you can afford this round, grouped by
   *  mode (only modes whose slotCost fits your remaining slots appear), best
   *  ("most compact") first. If no `super` entry appears, no 3×3 fits your
   *  interior — place normals instead. */
  cannonSuggestions?: CannonSuggestion[];
  /** WALL_BUILD only: every tower in your zone you could enclose (home first,
   *  then cheapest). The strategic layer — there can be several. `tiles` here is
   *  a sample (≤ ENCLOSURE_TILE_SAMPLE); `tilesNeeded` is the true count, and the
   *  full min-cut plan comes from the `enclose_plan` tool. */
  enclosureCandidates?: EnclosureCandidate[];
  /** WALL_BUILD only: legal placements for the CURRENT piece, ranked best-first
   *  by how many of its tiles touch your existing ring (so ring repairs sort
   *  above isolated drops). A ready-made shortlist so you needn't hunt the grid. */
  suggestions?: BuildSuggestion[];
  /** BATTLE only: each living opponent with intact walls, leader first, plus a
   *  contiguous sample of their wall tiles to aim at — so you can point-and-shoot
   *  without decoding the ASCII grid. Hitting any wall both scores you points and
   *  taxes that player's next build (they must repair it). */
  targets?: BattleTarget[];
  /** Grunts in your zone bearing down on your towers, most urgent first
   *  (exposed tower, then nearest). Grunts move in WALL_BUILD and KILL towers —
   *  ignore one near an unenclosed tower and you lose the tower (and a life).
   *  Omitted when nothing threatens you. */
  threats?: ThreatInfo[];
  /** Outcome of the previous committed decision (null at phase start). */
  lastResult: AgentResult | null;
}

/** Result of a read-only placement legality check (no commit, no time cost) —
 *  the agent's equivalent of the green/red phantom a human sees before clicking. */
export interface CheckResult {
  valid: boolean;
  reason?: string;
}

export interface McpGame {
  observe(): Observation;
  act(decision: AgentDecision): Observation;
  /** Advance up to `count` action-quanta (default 1), stopping early on a phase
   *  change, battle going live, or game over. */
  pass(count?: number): Observation;
  /** WALL_BUILD: drive the whole phase toward enclosing `towerIdx` (default your
   *  home tower) — the harness places each arriving piece on the best min-cut
   *  tile until it seals, time runs low, or it stalls. One call ≈ a whole build. */
  build(towerIdx?: number): Observation;
  /** BATTLE: fire every ready cannon at `slot`'s nearest walls, pacing reload,
   *  for the rest of the battle (or `quanta` action-quanta). One call ≈ a whole
   *  battle of fire/pass. */
  bombard(slot: number, quanta?: number): Observation;
  /** Full min-cut plan (all tiles) to enclose one tower — the un-sampled form
   *  of an `enclosureCandidates` entry. Returns null if that tower isn't a
   *  candidate in your zone. */
  enclosurePlan(towerIdx: number): EnclosureCandidate | null;
  /** Validate a placement at the current phase WITHOUT committing or advancing
   *  the clock. In WALL_BUILD checks the current piece at (row,col,rotation);
   *  in CANNON_PLACE checks a cannon at (row,col,mode). */
  check(
    row: number,
    col: number,
    rotation?: number,
    mode?: CannonMode,
  ): CheckResult;
  readonly agentSlot: ValidPlayerId;
  readonly scenario: Scenario;
}

/** Safety cap so a wedged predicate can't spin forever (60s of sim-frames). */
const MAX_SETTLE_FRAMES = 60 * 60;
/** Margin (tiles) for a fresh castle rect when proposing a secondary tower's
 *  enclosure — matches the AI's build-target margin band. */
const ENCLOSURE_MARGIN = 3;
/** A cut wider than this can't realistically close in one build phase — mirrors
 *  the planner's SOLO_MAX_GAPS closeability cap (ai-build-target.ts). */
const SOLO_MAX_GAPS = 30;
/** How many cut tiles each enclosure candidate carries IN THE OBSERVATION — a
 *  token-cheap preview. The full list (for big captures) comes from the
 *  `enclose_plan` tool / `enclosurePlan()` on demand. */
const ENCLOSURE_TILE_SAMPLE = 8;
/** How many of an opponent's wall tiles to surface as aim-assist in BATTLE. */
const BATTLE_TARGET_SAMPLE = 10;
/** How many placements to surface per cannon mode in CANNON_PLACE. */
const CANNON_SUGGESTION_PER_MODE = 3;
/** `build_toward` stops with this much build time left, so the phase-end sweep
 *  doesn't fire mid-placement and the agent isn't surprised by a phase flip. */
const MIN_BUILD_LEFT_SEC = 1.5;
/** Hard cap on placements per `build_toward` call — a runaway-loop backstop. */
const MAX_BUILD_PIECES = 60;
/** Consecutive non-progress placements before `build_toward` reports "stuck". */
const BUILD_STALL_LIMIT = 4;

export async function createMcpGame(
  opts: McpGameOptions = {},
): Promise<McpGame> {
  const agentSlot = (opts.agentSlot ?? 0) as ValidPlayerId;
  const actionTicks = opts.actionTicks ?? 30;
  const bridge: AgentBridge = createAgentBridge();
  const brain = createMcpBrain(bridge);

  // Install the McpBrain on the agent slot; everyone else gets the default
  // controller. The agent slot is a normal AI slot (isAi=true) — only its
  // brain differs, so the bootstrap RNG draw sequence is unchanged and the
  // opponents stay deterministic.
  const controllerFactory: ControllerFactory = (
    slot,
    isAi,
    keys,
    sharedRng,
    privateSeed,
    personality,
    humanAimResolver,
  ) => {
    if (slot !== agentSlot) {
      return createController(
        slot,
        isAi,
        keys,
        sharedRng,
        privateSeed,
        personality,
        humanAimResolver,
      );
    }
    if (!sharedRng || !personality) {
      throw new Error(
        "mcp-play: agent slot must be an AI slot (rng + personality required)",
      );
    }
    // Strategy is inert for the McpBrain (it never reads it for decisions) but
    // AiController's constructor requires one; build the default.
    const strategy = new DefaultStrategy(sharedRng, personality);
    return Promise.resolve(new AiController(slot, strategy, brain));
  };

  const sc = await createScenario({
    seed: opts.seed ?? 42,
    mode: "classic",
    rounds: opts.rounds ?? 3,
    renderer: "ascii",
    controllerFactory,
  });

  const gameOver = (): boolean => sc.mode() === Mode.STOPPED;

  /** Tick until the agent owes a move (brain parked) or the game ends. */
  function settleToDecision(): void {
    bridge.waiting = false;
    let frames = 0;
    while (!bridge.waiting && !gameOver() && frames < MAX_SETTLE_FRAMES) {
      sc.tick(1);
      frames++;
    }
  }

  /** Advance the mock clock by `frames` sim-frames (the per-action time cost).
   *  The decision (if any) commits within the first frame; the rest let phase
   *  timers progress. */
  function advance(frames: number): void {
    for (let i = 0; i < frames && !gameOver(); i++) sc.tick(1);
  }

  // Drive to the first decision (castle selection).
  settleToDecision();

  function wallBounds(walls: ReadonlySet<number>): CastleBounds | null {
    if (walls.size === 0) return null;
    let minRow = Infinity;
    let maxRow = -Infinity;
    let minCol = Infinity;
    let maxCol = -Infinity;
    for (const key of walls) {
      const { row, col } = unpackTile(key as Parameters<typeof unpackTile>[0]);
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
    }
    return { minRow, maxRow, minCol, maxCol };
  }

  /** Legal placements for the current piece around my castle, ranked best-first
   *  by ring-adjacency (repairs over loose drops). A shortlist, not exhaustive. */
  function buildSuggestionsFor(): BuildSuggestion[] {
    const state = sc.state;
    const player = state.players[agentSlot]!;
    const piece = player.currentPiece;
    const bounds = wallBounds(player.walls);
    if (!piece || !bounds) return [];
    const seen = new Set<string>();
    const out: BuildSuggestion[] = [];
    for (let rotation = 0; rotation < 4; rotation++) {
      const offsets = rotatedOffsets(piece, rotation);
      for (let row = bounds.minRow - 1; row <= bounds.maxRow + 1; row++) {
        for (let col = bounds.minCol - 1; col <= bounds.maxCol + 1; col++) {
          if (!canPlacePiece(state, agentSlot, offsets, row, col)) continue;
          const tiles = offsets.map(
            ([dr, dc]) => [row + dr, col + dc] as const,
          );
          const key = tiles
            .map(([r, c]) => `${r},${c}`)
            .sort()
            .join("|");
          if (seen.has(key)) continue;
          seen.add(key);
          const isWall = (tileRow: number, tileCol: number): boolean =>
            inBounds(tileRow, tileCol) &&
            player.walls.has(packTile(tileRow, tileCol));
          let touching = 0;
          let fillsGap = 0;
          for (const [tileRow, tileCol] of tiles) {
            const up = isWall(tileRow - 1, tileCol);
            const down = isWall(tileRow + 1, tileCol);
            const left = isWall(tileRow, tileCol - 1);
            const right = isWall(tileRow, tileCol + 1);
            touching += [up, down, left, right].filter(Boolean).length;
            if ((up && down) || (left && right)) fillsGap++;
          }
          out.push({ row, col, rotation, fillsGap, touchingWalls: touching });
        }
      }
    }
    out.sort(
      (a, b) => b.fillsGap - a.fillsGap || b.touchingWalls - a.touchingWalls,
    );
    return out.slice(0, 6);
  }

  /** For every tower in my zone, the engine min-cut to enclose it: the exact
   *  tiles to wall, the cost, and feasibility. Home first, then cheapest. This
   *  is the strategic layer — there can be several candidates (capture a
   *  neighbour, not just repair home). */
  function enclosureCandidatesFor(): EnclosureCandidate[] {
    const state = sc.state;
    const player = state.players[agentSlot]!;
    const zone = state.playerZones[agentSlot];
    if (zone === undefined) return [];
    const homeIdx = player.homeTower?.index;
    const bounds = wallBounds(player.walls);
    const out: EnclosureCandidate[] = [];
    for (const tower of state.map.towers) {
      if (tower.zone !== zone) continue;
      const isHome = tower.index === homeIdx;
      const base = { towerIdx: tower.index as number, isHome };
      // Ground truth first: if the tower is already enclosed, say so. The
      // min-cut below derives the home interior from the wall bounding box,
      // which outward wall nubs distort into a bogus non-zero cut — so an
      // already-sealed home would otherwise read as "needs N more tiles".
      if (player.enclosedTowers.some((enc) => enc.index === tower.index)) {
        out.push({
          ...base,
          status: "enclosed",
          tilesNeeded: 0,
          tiles: [],
          feasible: true,
        });
        continue;
      }
      if (!isTowerEnclosable(tower, state, false)) {
        out.push({
          ...base,
          status: "unenclosable",
          tilesNeeded: 0,
          tiles: [],
          feasible: false,
        });
        continue;
      }
      // Home reuses its existing ring's interior so the cut is just the gaps;
      // other towers get a fresh proposed castle rect.
      const interior: TileRect =
        isHome && bounds
          ? {
              top: bounds.minRow + 1,
              bottom: bounds.maxRow - 1,
              left: bounds.minCol + 1,
              right: bounds.maxCol - 1,
            }
          : castleRect(
              tower,
              state.map.tiles,
              state.map.towers,
              ENCLOSURE_MARGIN,
              true,
            );
      const cut = findEnclosureCut(
        [{ tower, interior }],
        state,
        player.walls,
        false,
      );
      if (cut === null) {
        out.push({
          ...base,
          status: "unenclosable",
          tilesNeeded: 0,
          tiles: [],
          feasible: false,
        });
      } else if (cut.size === 0) {
        out.push({
          ...base,
          status: "enclosed",
          tilesNeeded: 0,
          tiles: [],
          feasible: true,
        });
      } else {
        const tiles = [...cut].map((key) => {
          const pos = unpackTile(key);
          return { row: pos.row, col: pos.col };
        });
        out.push({
          ...base,
          status: "enclosable",
          tilesNeeded: cut.size,
          tiles,
          feasible: cut.size <= SOLO_MAX_GAPS,
        });
      }
    }
    out.sort(
      (a, b) =>
        Number(b.isHome) - Number(a.isHome) || a.tilesNeeded - b.tilesNeeded,
    );
    return out;
  }

  /** Grunts in my zone bearing down on my towers — the defensive read. For each
   *  grunt in my zone, the tower it targets (the engine's sticky pathing target
   *  if set, else the nearest alive one), the distance, and whether that tower is
   *  walled in. Most urgent first: exposed tower, then closest grunt. */
  function threatsFor(): ThreatInfo[] {
    const state = sc.state;
    const myZone = state.playerZones[agentSlot];
    if (myZone === undefined) return [];
    const player = state.players[agentSlot];
    const out: ThreatInfo[] = [];
    for (const grunt of state.grunts) {
      if (zoneAt(state.map, grunt.row, grunt.col) !== myZone) continue;
      const target = threatTarget(grunt, myZone);
      if (!target) continue;
      const enclosed =
        player?.enclosedTowers.some((tower) => tower.index === target.index) ??
        false;
      const wall =
        grunt.targetedWall === undefined
          ? undefined
          : unpackTile(grunt.targetedWall);
      out.push({
        grunt: { row: grunt.row, col: grunt.col },
        kind: grunt.kind === "catapult" ? "catapult" : "grunt",
        tower: { idx: target.index, row: target.row, col: target.col },
        distance: distanceToTower(target, grunt.row, grunt.col),
        towerEnclosed: enclosed,
        attacking:
          grunt.attackCountdown !== undefined && grunt.attackCountdown > 0,
        targetedWall: wall ? { row: wall.row, col: wall.col } : undefined,
      });
    }
    out.sort(
      (a, b) =>
        Number(a.towerEnclosed) - Number(b.towerEnclosed) ||
        a.distance - b.distance,
    );
    return out;
  }

  /** The tower a grunt threatens: its sticky pathing target if alive & in `zone`,
   *  else the nearest alive tower in `zone`. */
  function threatTarget(
    grunt: { row: number; col: number; targetTowerIdx?: number },
    zone: number,
  ) {
    const towers = sc.state.map.towers;
    const locked = grunt.targetTowerIdx;
    if (locked !== undefined && sc.state.towerAlive[locked]) {
      const tower = towers[locked];
      if (tower && tower.zone === zone) return tower;
    }
    let best: (typeof towers)[number] | undefined;
    let bestDist = Infinity;
    for (let i = 0; i < towers.length; i++) {
      const tower = towers[i]!;
      if (tower.zone !== zone || !sc.state.towerAlive[i]) continue;
      const dist = distanceToTower(tower, grunt.row, grunt.col);
      if (dist < bestDist) {
        bestDist = dist;
        best = tower;
      }
    }
    return best;
  }

  /** Legal cannon placements the agent can afford this round, grouped by mode and
   *  ranked "most compact first" (footprint tucked against walls/tower/cannons,
   *  leaving the interior least fragmented). Modes too expensive for the remaining
   *  slots are dropped, so a missing `super` line means no 3×3 fits. */
  function cannonSuggestionsFor(): CannonSuggestion[] {
    const state = sc.state;
    const me = state.players[agentSlot];
    const bounds = me ? wallBounds(me.walls) : null;
    if (!me || !bounds) return [];
    const remaining = cannonSlotsFor(state, agentSlot) - cannonSlotsUsed(me);
    const solid = solidTiles(me);
    const out: CannonSuggestion[] = [];
    for (const def of cannonModesForGame(state.modern !== null)) {
      if (def.slotCost > remaining) continue;
      const spots: { row: number; col: number; hugs: number }[] = [];
      for (
        let row = bounds.minRow;
        row + def.size - 1 <= bounds.maxRow;
        row++
      ) {
        for (
          let col = bounds.minCol;
          col + def.size - 1 <= bounds.maxCol;
          col++
        ) {
          if (!canPlaceCannon(me, row, col, def.id, state)) continue;
          spots.push({
            row,
            col,
            hugs: footprintHug(row, col, def.size, solid),
          });
        }
      }
      spots.sort((a, b) => b.hugs - a.hugs);
      for (const spot of spots.slice(0, CANNON_SUGGESTION_PER_MODE)) {
        out.push({
          mode: def.id,
          row: spot.row,
          col: spot.col,
          size: def.size,
          slotCost: def.slotCost,
          hugs: spot.hugs,
        });
      }
    }
    return out;
  }

  /** Tiles that "anchor" a cannon footprint: my walls, every tower, my cannons. */
  function solidTiles(me: (typeof sc.state.players)[number]): Set<number> {
    const solid = new Set<number>();
    for (const wall of me.walls) solid.add(wall);
    for (const tower of sc.state.map.towers) {
      for (let dr = 0; dr < 2; dr++) {
        for (let dc = 0; dc < 2; dc++) {
          solid.add(packTile(tower.row + dr, tower.col + dc));
        }
      }
    }
    for (const cannon of me.cannons) {
      const size = cannonSize(cannon.mode);
      for (let dr = 0; dr < size; dr++) {
        for (let dc = 0; dc < size; dc++) {
          solid.add(packTile(cannon.row + dr, cannon.col + dc));
        }
      }
    }
    return solid;
  }

  /** Count footprint-border tiles abutting a solid tile — the compactness score. */
  function footprintHug(
    row: number,
    col: number,
    size: number,
    solid: ReadonlySet<number>,
  ): number {
    let hug = 0;
    for (let dr = 0; dr < size; dr++) {
      for (let dc = 0; dc < size; dc++) {
        for (const [nr, nc] of [
          [row + dr - 1, col + dc],
          [row + dr + 1, col + dc],
          [row + dr, col + dc - 1],
          [row + dr, col + dc + 1],
        ]) {
          const inside =
            nr >= row && nr < row + size && nc >= col && nc < col + size;
          if (!inside && solid.has(packTile(nr, nc))) hug++;
        }
      }
    }
    return hug;
  }

  /** How many of the agent's cannons can fire this instant (no ball in flight). */
  function cannonsReadyCount(): number {
    const state = sc.state;
    const me = state.players[agentSlot];
    if (!me) return 0;
    return me.cannons.reduce(
      (ready, _cannon, idx) =>
        ready +
        (canFireOwnCannon(
          state,
          agentSlot,
          idx as Parameters<typeof canFireOwnCannon>[2],
        )
          ? 1
          : 0),
      0,
    );
  }

  /** The best legal placement of `piece` that covers the most `targets` (min-cut
   *  tiles) with the least waste — the per-piece executor for `build_toward`. It
   *  reacts to whatever piece arrived (never peeks the bag), so a plan is honest. */
  function bestBuildPlacement(
    piece: PieceShape,
    targets: ReadonlySet<number>,
  ): { row: number; col: number; rotation: number } | null {
    const state = sc.state;
    const player = state.players[agentSlot];
    if (!player || targets.size === 0) return null;
    let minRow = Infinity;
    let maxRow = -Infinity;
    let minCol = Infinity;
    let maxCol = -Infinity;
    for (const key of targets) {
      const { row, col } = unpackTile(key as Parameters<typeof unpackTile>[0]);
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
    }
    let best: { row: number; col: number; rotation: number } | null = null;
    let bestScore = [-1, -Infinity, -1];
    for (let rotation = 0; rotation < 4; rotation++) {
      const offsets = rotatedOffsets(piece, rotation);
      for (let row = minRow - 2; row <= maxRow + 2; row++) {
        for (let col = minCol - 2; col <= maxCol + 2; col++) {
          if (!canPlacePiece(state, agentSlot, offsets, row, col)) continue;
          const score = scorePlacement(
            offsets,
            row,
            col,
            targets,
            player.walls,
          );
          if (score && lexGreater(score, bestScore)) {
            best = { row, col, rotation };
            bestScore = score;
          }
        }
      }
    }
    return best;
  }

  /** Lexicographic [coverage, -waste, ringTouch] score for one placement, or
   *  null if it covers no target tile (so it's never chosen for a goal). */
  function scorePlacement(
    offsets: readonly [number, number][],
    row: number,
    col: number,
    targets: ReadonlySet<number>,
    walls: ReadonlySet<number>,
  ): [number, number, number] | null {
    const isWall = (tileRow: number, tileCol: number): boolean =>
      inBounds(tileRow, tileCol) && walls.has(packTile(tileRow, tileCol));
    let coverage = 0;
    let touching = 0;
    for (const [dr, dc] of offsets) {
      if (targets.has(packTile(row + dr, col + dc))) coverage++;
      touching += [
        isWall(row + dr - 1, col + dc),
        isWall(row + dr + 1, col + dc),
        isWall(row + dr, col + dc - 1),
        isWall(row + dr, col + dc + 1),
      ].filter(Boolean).length;
    }
    if (coverage === 0) return null;
    return [coverage, -(offsets.length - coverage), touching];
  }

  function observe(): Observation {
    const state = sc.state;
    const phase = state.phase;
    const me = state.players[agentSlot]!;
    const zone = state.playerZones[agentSlot];
    const battle = phase === Phase.BATTLE;
    const board = asciiSnapshot(
      state,
      battle
        ? { coords: true }
        : { cropTo: agentSlot, cropPad: 2, coords: true },
    );

    const observation: Observation = {
      phase,
      round: state.round,
      timerSec: Math.round(state.timer * 10) / 10,
      battleCountdown: Math.round(state.battleCountdown * 10) / 10,
      gameOver: gameOver(),
      expected: expectedFor(phase),
      layout: state.players.map((player, slot) => ({
        slot,
        name: PLAYER_NAMES[slot] ?? `P${slot}`,
        isMe: slot === agentSlot,
        lives: player.lives,
        eliminated: player.eliminated,
        home: player.homeTower
          ? { row: player.homeTower.row, col: player.homeTower.col }
          : null,
        castle: wallBounds(player.walls),
        walls: player.walls.size,
        cannons: player.cannons.length,
        enclosedTowers: player.enclosedTowers.length,
      })),
      cannonballsInFlight: state.cannonballs.length,
      board,
      me: {
        slot: agentSlot,
        lives: me.lives,
        score: me.score,
        eliminated: me.eliminated,
        homeTower: me.homeTower
          ? { row: me.homeTower.row, col: me.homeTower.col }
          : null,
        currentPiece: me.currentPiece?.name ?? null,
        cannons: me.cannons.length,
        cannonSlots: {
          used: cannonSlotsUsed(me),
          max: cannonSlotsFor(state, agentSlot),
        },
        cannonPositions: me.cannons.map((cannon) => ({
          row: cannon.row,
          col: cannon.col,
          mode: cannon.mode,
        })),
        cannonsReady: cannonsReadyCount(),
        walls: me.walls.size,
        interior: me.interior.size,
        enclosedTowers: me.enclosedTowers.length,
        homeTowerEnclosed:
          me.homeTower !== null &&
          me.enclosedTowers.some((tower) => tower === me.homeTower),
      },
      opponents: state.players
        .map((player, slot) => ({ player, slot }))
        .filter(({ slot }) => slot !== agentSlot)
        .map(({ player, slot }) => ({
          slot,
          lives: player.lives,
          score: player.score,
          eliminated: player.eliminated,
          walls: player.walls.size,
          homeTower: player.homeTower
            ? { row: player.homeTower.row, col: player.homeTower.col }
            : null,
        })),
      lastResult: bridge.lastResult,
    };

    const threats = threatsFor();
    if (threats.length > 0) observation.threats = threats;

    if (phase === Phase.CASTLE_SELECT && zone !== undefined) {
      observation.towers = state.map.towers
        .filter((tower) => tower.zone === zone)
        .map((tower) => ({
          index: tower.index,
          row: tower.row,
          col: tower.col,
          enclosed: me.enclosedTowers.some((enc) => enc.index === tower.index),
        }));
    }

    if (phase === Phase.CANNON_PLACE) {
      observation.cannonSuggestions = cannonSuggestionsFor();
    }

    if (phase === Phase.WALL_BUILD) {
      // Sample the cut tiles in the observation to keep build turns token-cheap;
      // `tilesNeeded` stays the true count, full list via enclosurePlan().
      observation.enclosureCandidates = enclosureCandidatesFor().map(
        (candidate) => ({
          ...candidate,
          tiles: candidate.tiles.slice(0, ENCLOSURE_TILE_SAMPLE),
        }),
      );
      observation.suggestions = buildSuggestionsFor();
    }

    if (phase === Phase.BATTLE) {
      // Origin for "nearest wall" = centroid of my cannons (they're clustered),
      // so the aim-assist favours the shortest flight path.
      const origin = cannonCentroid();
      observation.targets = state.players
        .map((player, slot) => ({ player, slot }))
        .filter(
          ({ player, slot }) =>
            slot !== agentSlot && !player.eliminated && player.walls.size > 0,
        )
        .sort((a, b) => b.player.score - a.player.score)
        .map(({ player, slot }) => ({
          slot,
          name: PLAYER_NAMES[slot] ?? `P${slot}`,
          score: player.score,
          walls: player.walls.size,
          sampleTiles: sampleWallTiles(
            player.walls,
            BATTLE_TARGET_SAMPLE,
            origin,
          ),
        }));
    }

    return observation;
  }

  /** A readable sample of a wall set, CLOSEST to `origin` first. Shots from my
   *  cannons to a distant wall spend the whole battle in flight, so surfacing the
   *  nearest wall tiles (shortest flight = most shots actually land) makes the
   *  aim-assist flight-efficient, not just a topmost dump. */
  function sampleWallTiles(
    walls: ReadonlySet<number>,
    limit: number,
    origin: { row: number; col: number },
  ): { row: number; col: number }[] {
    const dist2 = (row: number, col: number): number =>
      (row - origin.row) ** 2 + (col - origin.col) ** 2;
    return [...walls]
      .map((key) => unpackTile(key as Parameters<typeof unpackTile>[0]))
      .sort(
        (a, b) =>
          dist2(a.row, a.col) - dist2(b.row, b.col) ||
          a.row - b.row ||
          a.col - b.col,
      )
      .slice(0, limit)
      .map(({ row, col }) => ({ row, col }));
  }

  function rotatedOffsets(
    piece: PieceShape,
    rotation: number,
  ): readonly [number, number][] {
    let shape = piece;
    const turns = ((rotation % 4) + 4) % 4;
    for (let i = 0; i < turns; i++) shape = rotateCW(shape);
    return shape.offsets;
  }

  /** Static legality of a decision at the current phase. Mirrors the rules the
   *  executor enforces (`canPlacePiece` / `canPlaceCannon`), plus a phase gate
   *  so a wrong-phase decision is reported rather than left to linger. */
  function checkDecision(decision: AgentDecision): CheckResult {
    const state = sc.state;
    const me = state.players[agentSlot]!;
    const phase = state.phase;
    switch (decision.kind) {
      case "select": {
        if (phase !== Phase.CASTLE_SELECT) {
          return { valid: false, reason: "not in CASTLE_SELECT" };
        }
        const tower = state.map.towers[decision.towerIdx];
        if (!tower) return { valid: false, reason: "no such tower index" };
        if (tower.zone !== state.playerZones[agentSlot]) {
          return { valid: false, reason: "tower is not in your zone" };
        }
        return { valid: true };
      }
      case "build": {
        if (phase !== Phase.WALL_BUILD) {
          return { valid: false, reason: "not in WALL_BUILD" };
        }
        const piece = me.currentPiece;
        if (!piece) return { valid: false, reason: "no current piece" };
        const ok = canPlacePiece(
          state,
          agentSlot,
          rotatedOffsets(piece, decision.rotation),
          decision.row,
          decision.col,
        );
        return ok
          ? { valid: true }
          : {
              valid: false,
              reason:
                "blocked — off-grid, occupied, not on your grass, or sealed by a grunt",
            };
      }
      case "cannon": {
        if (phase !== Phase.CANNON_PLACE) {
          return { valid: false, reason: "not in CANNON_PLACE" };
        }
        const ok = canPlaceCannon(
          me,
          decision.row,
          decision.col,
          decision.mode,
          state,
        );
        return ok
          ? { valid: true }
          : {
              valid: false,
              reason:
                "blocked — off-grid, outside your interior, or on water/wall/tower/cannon/pit",
            };
      }
      case "cannon-done":
        return phase === Phase.CANNON_PLACE
          ? { valid: true }
          : { valid: false, reason: "not in CANNON_PLACE" };
      case "fire":
        return phase === Phase.BATTLE
          ? { valid: true }
          : { valid: false, reason: "not in BATTLE" };
    }
  }

  function check(
    row: number,
    col: number,
    rotation = 0,
    mode: CannonMode = DEFAULT_CANNON_MODE,
  ): CheckResult {
    const phase = sc.state.phase;
    if (phase === Phase.WALL_BUILD) {
      return checkDecision({ kind: "build", row, col, rotation });
    }
    if (phase === Phase.CANNON_PLACE) {
      return checkDecision({ kind: "cannon", row, col, mode });
    }
    return { valid: false, reason: `nothing to place in ${phase}` };
  }

  function act(decision: AgentDecision): Observation {
    if (gameOver()) return observe();
    // Pre-flight: an illegal or wrong-phase decision is a cheap no-op (the
    // human's red phantom) — report failure WITHOUT advancing the game clock,
    // so blind attempts can't drain the phase timer.
    const verdict = checkDecision(decision);
    if (!verdict.valid) {
      bridge.lastResult = {
        kind: decision.kind,
        success: false,
        reason: verdict.reason,
      };
      return observe();
    }
    bridge.lastResult = null;
    const cannonsBefore = sc.state.players[agentSlot]!.cannons.length;
    bridge.pending = decision;
    advance(actionTicks);
    // The controller never reports cannon-commit success to the brain, so
    // derive it from the cannon-count delta.
    if (decision.kind === "cannon" && bridge.lastResult === null) {
      const after = sc.state.players[agentSlot]!.cannons.length;
      bridge.lastResult = { kind: "cannon", success: after > cannonsBefore };
    }
    settleToDecision();
    return observe();
  }

  /** Advance up to `count` action-quanta, stopping early when something
   *  actionable changes — the phase flips, a pre-battle countdown finishes (so
   *  you can fire the moment battle goes live), or the game ends. Lets the agent
   *  skip dead time (a whole countdown, a quiet build) in ONE call instead of N,
   *  which keeps long matches token-cheap. */
  function pass(count = 1): Observation {
    const startPhase = sc.state.phase;
    const wasCountdown = sc.state.battleCountdown > 0;
    for (let i = 0; i < count && !gameOver(); i++) {
      advance(actionTicks);
      settleToDecision();
      if (sc.state.phase !== startPhase) break;
      if (wasCountdown && sc.state.battleCountdown <= 0) break;
    }
    return observe();
  }

  function enclosurePlan(towerIdx: number): EnclosureCandidate | null {
    return (
      enclosureCandidatesFor().find((c) => c.towerIdx === towerIdx) ?? null
    );
  }

  /** Commit one build placement and burn one action quantum. Returns whether the
   *  piece actually landed (so the executor can detect a dud/blocked attempt). */
  function commitBuildPiece(
    row: number,
    col: number,
    rotation: number,
  ): boolean {
    if (!checkDecision({ kind: "build", row, col, rotation }).valid)
      return false;
    // Success = the wall count grew (a piece adds tiles). Derived from state
    // rather than bridge.lastResult so it survives the advance cleanly.
    const before = sc.state.players[agentSlot]?.walls.size ?? 0;
    bridge.pending = { kind: "build", row, col, rotation };
    advance(actionTicks);
    settleToDecision();
    return (sc.state.players[agentSlot]?.walls.size ?? 0) > before;
  }

  /** Drive the WHOLE build phase toward a goal: enclose a tower (default home).
   *  Each step it reads the current piece, places it on the min-cut tile it best
   *  covers (or, for a piece that fits no gap, redirects it onto the ring to
   *  advance the bag), and repeats until the tower seals, build time runs low, or
   *  it stalls. The agent commits a strategy in one call; the harness executes it
   *  against whatever pieces arrive — batch building with no bag-peeking. */
  function buildToward(towerIdx?: number): Observation {
    if (sc.state.phase !== Phase.WALL_BUILD) {
      bridge.lastResult = {
        kind: "build",
        success: false,
        reason: "not in WALL_BUILD",
      };
      return observe();
    }
    const goalIdx = towerIdx ?? sc.state.players[agentSlot]?.homeTower?.index;
    let placed = 0;
    let stall = 0;
    let outcome = "done";
    while (!gameOver() && sc.state.phase === Phase.WALL_BUILD) {
      if (sc.state.timer < MIN_BUILD_LEFT_SEC) {
        outcome = "time";
        break;
      }
      if (placed >= MAX_BUILD_PIECES) {
        outcome = "budget";
        break;
      }
      const candidate = enclosureCandidatesFor().find(
        (cand) => cand.towerIdx === goalIdx,
      );
      if (!candidate || candidate.status === "enclosed") break;
      if (candidate.status === "unenclosable") {
        outcome = "unenclosable";
        break;
      }
      const piece = sc.state.players[agentSlot]?.currentPiece;
      if (!piece) {
        advance(actionTicks);
        settleToDecision();
        continue;
      }
      const targets = new Set(
        candidate.tiles.map((tile) => packTile(tile.row, tile.col)),
      );
      const aim = bestBuildPlacement(piece, targets);
      const fallback = aim ?? buildSuggestionsFor()[0] ?? null;
      if (
        fallback &&
        commitBuildPiece(fallback.row, fallback.col, fallback.rotation)
      ) {
        placed++;
        stall = aim ? 0 : stall + 1;
      } else {
        stall++;
        advance(actionTicks);
        settleToDecision();
      }
      if (stall >= BUILD_STALL_LIMIT) {
        outcome = "stuck";
        break;
      }
    }
    const remaining =
      enclosureCandidatesFor().find((cand) => cand.towerIdx === goalIdx)
        ?.tilesNeeded ?? 0;
    bridge.lastResult = {
      kind: "build",
      success: outcome === "done",
      reason: `${outcome}: placed ${placed}, ${remaining} gaps left`,
    };
    return observe();
  }

  /** Bombard one opponent's walls for the rest of the battle (or `quanta` action
   *  quanta): waits out the countdown, then fires every ready cannon at their
   *  nearest walls, pacing to reload, until their walls clear, the battle ends,
   *  or the budget runs out. Collapses a whole battle of fire/pass micro into one
   *  call. Returns the walls destroyed + points scored. */
  function bombardSlot(targetSlot: number, quanta?: number): Observation {
    if (sc.state.phase !== Phase.BATTLE) {
      bridge.lastResult = {
        kind: "fire",
        success: false,
        reason: "not in BATTLE",
      };
      return observe();
    }
    const me = sc.state.players[agentSlot];
    const wallsBefore = sc.state.players[targetSlot]?.walls.size ?? 0;
    const scoreBefore = me?.score ?? 0;
    const budget = quanta ?? Infinity;
    let spent = 0;
    let fired = 0;
    while (!gameOver() && sc.state.phase === Phase.BATTLE && spent < budget) {
      if (sc.state.battleCountdown > 0) {
        advance(actionTicks);
        settleToDecision();
        spent++;
        continue;
      }
      const target = sc.state.players[targetSlot];
      if (!target || target.eliminated || target.walls.size === 0) break;
      if (cannonsReadyCount() === 0) {
        advance(actionTicks);
        settleToDecision();
        spent++;
        continue;
      }
      const origin = cannonCentroid();
      const tiles = sampleWallTiles(target.walls, target.walls.size, origin);
      const ready = cannonsReadyCount();
      for (let shot = 0; shot < ready && shot < tiles.length; shot++) {
        if (sc.state.phase !== Phase.BATTLE || gameOver()) break;
        const tile = tiles[shot]!;
        bridge.pending = { kind: "fire", row: tile.row, col: tile.col };
        advance(actionTicks);
        settleToDecision();
        fired++;
        spent++;
      }
    }
    const wallsDestroyed =
      wallsBefore - (sc.state.players[targetSlot]?.walls.size ?? 0);
    const pointsGained =
      (sc.state.players[agentSlot]?.score ?? 0) - scoreBefore;
    bridge.lastResult = {
      kind: "fire",
      success: fired > 0,
      // pointsGained is MY attributed score; the wall delta is the target's
      // total loss in the window (other players may have hit it too).
      reason: `fired ${fired}, +${pointsGained} pts (target lost ${wallsDestroyed} walls)`,
    };
    return observe();
  }

  /** Centroid of the agent's cannons — the flight origin for nearest-wall aim. */
  function cannonCentroid(): { row: number; col: number } {
    const me = sc.state.players[agentSlot];
    const cannons = me?.cannons ?? [];
    if (cannons.length === 0) {
      return { row: me?.homeTower?.row ?? 0, col: me?.homeTower?.col ?? 0 };
    }
    return {
      row:
        cannons.reduce((sum, cannon) => sum + cannon.row, 0) / cannons.length,
      col:
        cannons.reduce((sum, cannon) => sum + cannon.col, 0) / cannons.length,
    };
  }

  return {
    observe,
    act,
    pass,
    build: buildToward,
    bombard: bombardSlot,
    enclosurePlan,
    check,
    agentSlot,
    scenario: sc,
  };
}

/** True iff tuple `a` is lexicographically greater than `b` (element by element). */
function lexGreater(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return false;
}

function expectedFor(phase: Phase): string {
  switch (phase) {
    case Phase.CASTLE_SELECT:
      return "Pick a home tower — act { kind: 'select', towerIdx }.";
    case Phase.WALL_BUILD:
      return "Re-seal/expand your castle. Fastest: build_toward({ towerIdx }) hands the WHOLE phase to the harness to enclose a tower (omit towerIdx = your home) — one call. Or place pieces by hand: act { kind: 'build', row, col, rotation }. Or pass.";
    case Phase.CANNON_PLACE:
      return "Place a cannon at its top-left — act { kind: 'cannon', row, col, mode }. See cannonSuggestions for legal spots you can afford, grouped by mode (no 'super' line = no 3x3 fits). Footprint: normal/balloon 2x2, super 3x3. Watch me.cannonSlots (used/max). End early with { kind: 'cannon-done' }, or pass.";
    case Phase.BATTLE:
      return "Tax an opponent's walls (scores points + slows their next build). Fastest: bombard({ slot }) fires every ready cannon at that opponent's nearest walls for the whole battle — one call (see targets, leader first). Or aim by hand: act { kind: 'fire', row, col } (wait out battleCountdown > 0; fire at most me.cannonsReady per burst, then pass to reload).";
    default:
      return "No agent action this phase; call pass to advance.";
  }
}
