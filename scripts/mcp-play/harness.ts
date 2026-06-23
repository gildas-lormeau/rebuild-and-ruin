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
 * One exception: placing a build piece burns `BUILD_PIECE_TICKS` (the real
 * per-piece cost), because build-piece COUNT is time-bounded — letting it run at
 * the cheap quantum would out-build the AI opponents on clock speed alone.
 *
 * Dev/research tool: lives in `scripts/`, never wired into determinism or
 * parity suites (the agent slot is non-deterministic by design).
 */

import { asciiSnapshot, zoneBounds } from "../../dev/dev-console-grid.ts";
import { castleRect, isTowerEnclosable } from "../../src/ai/ai-castle-rect.ts";
import { findEnclosureCut } from "../../src/ai/ai-min-cut.ts";
import { DefaultStrategy } from "../../src/ai/ai-strategy.ts";
import { AiController } from "../../src/controllers/controller-ai.ts";
import { createController } from "../../src/controllers/controller-factory.ts";
import {
  canFireOwnCannon,
  nextReadyCannon,
} from "../../src/game/battle-system.ts";
import {
  canPlacePiece,
  projectedFinalizeDelta,
} from "../../src/game/build-system.ts";
import {
  cannonSlotsUsed,
  canPlaceCannon,
} from "../../src/game/cannon-system.ts";
import { isGruntPassableTile } from "../../src/game/grunt-movement.ts";
import {
  type Cannon,
  type CannonMode,
  isBalloonCannon,
  isCannonAlive,
  isRampartCannon,
  isSuperCannon,
} from "../../src/shared/core/battle-types.ts";
import { cannonModesForGame } from "../../src/shared/core/cannon-mode-defs.ts";
import { SIM_TICK_DT } from "../../src/shared/core/game-constants.ts";
import { Phase } from "../../src/shared/core/game-phase.ts";
import type { TileRect } from "../../src/shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS } from "../../src/shared/core/grid.ts";
import { type PieceShape, rotateCW } from "../../src/shared/core/pieces.ts";
import type { ValidPlayerId } from "../../src/shared/core/player-slot.ts";
import {
  cannonSize,
  countWallNeighbors,
  DIRS_4,
  distanceToTower,
  hasPitAt,
  inBounds,
  isWater,
  packTile,
  unpackTile,
  zoneAt,
} from "../../src/shared/core/spatial.ts";
import type { ControllerFactory } from "../../src/shared/core/system-interfaces.ts";
import { cannonSlotsFor } from "../../src/shared/core/types.ts";
import { isCannonEnclosed } from "../../src/shared/sim/board-occupancy.ts";
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

/** Optional stop conditions for a build executor (`build_toward` / `build_path`):
 *  bank partial progress and RESERVE the rest of the phase for a follow-up build
 *  instead of gambling the whole timer on one enclosure (the round-2 over-commit
 *  this exists to prevent). Omit both = run to completion (the old behaviour).
 *  `maxSeconds` caps wall-build seconds spent in THIS call; `maxPieces` caps
 *  pieces placed in THIS call — both still under the hard runaway backstop. */
export interface BuildBudget {
  maxSeconds?: number;
  maxPieces?: number;
}

/** Why one min-cut tile can't be walled right now. `grunt-boxed`: a grunt sits
 *  on it AND has no legal move (penned by walls/cannons/grunts) — it won't leave
 *  this phase. `grunt-mobile`: a grunt sits on it but could step away, so it may
 *  free up. `pit`: a burning pit occupies it (clears after its battle-round
 *  timer, not this build). `needs-small-piece`: the tile's buildable-ground
 *  island is 1–3 cells, so the 4-cell pieces can't cover it — but a smaller
 *  piece (1×1/1×2/1×3) still can, so `build_toward` cycles the bag until one
 *  arrives rather than giving up. `unfillable`: the tile has no buildable ground
 *  at all (a cannon/tower/water on the ring line), so NO piece can ever cover
 *  it. The hard kinds (`grunt-boxed`, `pit`, `unfillable`) can't clear this
 *  phase; the soft kinds (`grunt-mobile`, `needs-small-piece`) may resolve with
 *  time or the right draw. */
export interface SealBlocker {
  row: number;
  col: number;
  kind:
    | "grunt-boxed"
    | "grunt-mobile"
    | "pit"
    | "needs-small-piece"
    | "unfillable";
  /** Can't clear this build phase → kills `feasible` and triggers the early-out.
   *  True for `grunt-boxed` / `pit` / `unfillable`; false for the soft kinds. */
  hard: boolean;
}

/** An enclosure option in my zone: a tower I could wall in, with the exact
 *  min-cut tiles to do it. Computed via the engine's own `findEnclosureCut`, so
 *  `tiles` is a deterministic placement plan, not a heuristic. */
export interface EnclosureCandidate {
  towerIdx: number;
  isHome: boolean;
  /** "enclosed" = already sealed; "enclosable" = needs `tiles`; "unenclosable"
   *  = no piece-fillable ring this build (see `reason`). */
  status: "enclosed" | "enclosable" | "unenclosable";
  /** Number of new wall tiles needed to close it (0 if already enclosed). */
  tilesNeeded: number;
  /** The exact tiles to wall — the min-cut. Fill these and the tower encloses. */
  tiles: { row: number; col: number }[];
  /** Estimated build seconds to close the cut at the fair per-piece cadence
   *  (0 if already enclosed / unenclosable). Compare against the phase timer. */
  estSeconds: number;
  /** TRUE if you can realistically finish this enclosure THIS phase — both
   *  `estSeconds <= timer` AND no seal tile carries a HARD blocker (see
   *  `blockers`). A grunt boxed on a min-cut tile, a burning pit, or an
   *  unfillable slot all force this false even with hours on the clock — the
   *  time-only read was a footgun that sent the executor thrashing into a jam. */
  feasible: boolean;
  /** Per-tile placement blockers on the min-cut (empty = every seal tile is
   *  free to build now). HARD blockers (`grunt-boxed`, `pit`, `unfillable`)
   *  can't clear this phase, so they force `feasible` false and make
   *  `build_toward` early-out instead of burning piece-time discovering the jam
   *  at runtime; `grunt-mobile` is soft (the grunt may wander off). Absent for
   *  non-enclosable statuses. */
  blockers: SealBlocker[];
  /** Why `status` is "unenclosable" — a topology block ("leaks to the map edge")
   *  vs. a piece-fit block ("a 1-tile gap is pinched between solids, often a
   *  cannon on the ring — plug it by hand"). Absent for other statuses. */
  reason?: string;
  /** Uncaptured bonus squares that fall inside this tower's pocket — enclosing
   *  it banks them too. Each bonus square scores 10×√territory (100–1000 by
   *  territory size — far more per tile than plain grass), so a pocket with
   *  bonuses is worth prioritising even over a cheaper empty one. */
  bonusSquares: number;
}

/** A bonus square in my zone — the highest points-per-tile build target. Each
 *  scores `territoryBonusSquarePoints` (10×√territory, quantised to 100, clamped
 *  [100,1000]) the instant it falls inside my enclosed interior, then it's
 *  consumed and the zone replenishes to 3 next round. Invisible on the raw board
 *  ('+'), so surfaced here with its value and how to capture it. */
export interface BonusTarget {
  row: number;
  col: number;
  /** Points if captured at the CURRENT territory size (grows as you enclose
   *  more — re-observe after a build to see it rise). */
  value: number;
  /** Already inside my interior → it banks at build end, no action needed. */
  enclosed: boolean;
  /** Zone tower whose pocket contains this square (enclose it to capture the
   *  bonus for free), or null if it sits in open grass needing dedicated walls. */
  capturedByTower: number | null;
}

/** One enclosed tower of an opponent — a `breach` target. De-enclosing its
 *  pocket (open its outer ring) makes that pocket score zero next build unless
 *  they reseal it, and ejects any bonus squares it holds from their interior. */
export interface OpponentTower {
  towerIdx: number;
  row: number;
  col: number;
  /** Outer-ring (boundary) wall tiles guarding it within `BREACH_RADIUS` —
   *  the load-bearing barrier a `breach` chews through. Fewer = softer target. */
  ringWalls: number;
  /** Bonus squares sitting in this pocket — denied to them if you de-enclose it. */
  bonusSquares: number;
}

/** A high-value pit target: one enemy wall tile where a super-cannon pit would
 *  deny rebuilding for `BURNING_PIT_DURATION` rounds. Ranked by `choke` — how
 *  many orthogonal sides are water/edge (impassable), i.e. how impossible it is
 *  to reroute the wall around the pit. A choke-2 tile in a 1-wide neck between
 *  rivers is a near-permanent breach; a choke-0 tile they just rebuild beside. */
export interface PitTarget {
  slot: number;
  row: number;
  col: number;
  /** Orthogonal sides that are water or off-board (0–4). Higher = less
   *  reroutable = better pit. */
  choke: number;
  /** This tile guards an enclosed tower (within BREACH_RADIUS) — a load-bearing
   *  ring wall, so the pit also helps de-enclose the pocket. */
  towerIdx: number | null;
}

/** A battle aim-assist entry: one opponent, a sample of their wall tiles, and
 *  their enclosed towers as breach targets. */
export interface BattleTarget {
  slot: number;
  name: string;
  score: number;
  /** Intact wall tiles remaining (watch it drop as your shots land). */
  walls: number;
  /** A contiguous sample of their wall tiles (top-to-bottom) to fire at. */
  sampleTiles: { row: number; col: number }[];
  /** Their enclosed towers, softest (thinnest ring) first — pick one to
   *  `breach({ slot, towerIdx })`, or omit towerIdx to auto-target the softest. */
  towers: OpponentTower[];
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
  /** Boundary-wall sides the footprint touches (a wall facing OUT of the
   *  interior). A cannon flush against the outer ring becomes a wall-line
   *  obstacle the moment that ring is breached: the re-seal must detour around
   *  it and can orphan a 1-tile gap no piece fits (the silent "inert cannon"
   *  trap). 0 = buffered interior spot (safe); ≥1 = on the ring (risk). Safe
   *  spots sort first; this number is the tiebreak/penalty, NOT compactness. */
  wallLineSides: number;
}

/** My cannons grouped by the nearest of my zone's towers — the per-castle
 *  battery rollup for a rebuild decision. `dead` cannons are debris (hp 0; only a
 *  zone reset clears them, so they're permanent dead weight blocking the pocket);
 *  `inert` are alive but stranded outside a sealed ring (can't fire until you
 *  reseal); `byMode` counts the ALIVE cannons by type. A pocket that's mostly
 *  dead/inert is a weak rebuild — the walls would reseal few working guns. */
export interface TowerCannons {
  towerIdx: number;
  row: number;
  col: number;
  /** Is this tower currently enclosed (its pocket sealed)? */
  enclosed: boolean;
  /** All cannons nearest this tower (alive + dead). */
  total: number;
  /** hp > 0 — can fire once its pocket is sealed. */
  alive: number;
  /** hp 0 — debris that blocks space and won't fire again until a zone reset. */
  dead: number;
  /** Alive but outside a sealed ring — fires again only once you reseal. */
  inert: number;
  /** Alive cannons by type (normal / super / balloon / rampart). */
  byMode: Partial<Record<CannonMode, number>>;
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
  /** Banked score: territory from PAST rounds' finalizes + battle points. The
   *  live number — it does NOT yet include the in-progress round's territory. */
  score: number;
  /** score + the territory this player would bank if the build finalized NOW
   *  (enclosed interior + capturable bonus squares + castle bonus). THE
   *  standings number: the live `score` hides the current round's territory
   *  until finalize, so two players can look level mid-build while one is far
   *  ahead on enclosed-but-unbanked ground. Sort by this to read who's winning. */
  projected: number;
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
  /** Absolute tile range the `board` covers — top-left glyph = (minRow, minCol).
   *  Cropped build/cannon/select board = your zone + 2-tile margin; battle = the
   *  full map. Anchors the stacked column header so a glyph maps to (row, col)
   *  without miscounting. (Precise coords for anything actionable already arrive
   *  structured — threats, bonusTargets, suggestions, enclosureCandidates,
   *  fragileWalls, cannonsByTower — so reach for those before counting glyphs.) */
  boardBounds: {
    minRow: number;
    maxRow: number;
    minCol: number;
    maxCol: number;
  };
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
    /** Each cannon you've placed: top-left + whether it can fire right now and,
     *  if not, why. `canFire: false, reason: "unenclosed …"` means the cannon's
     *  castle ring was breached — it's INERT and won't contribute to a bombard
     *  until you reseal that territory. Watch this: a breached castle silently
     *  disarms every cannon inside it. */
    cannonPositions: {
      row: number;
      col: number;
      mode: CannonMode;
      /** hp > 0. A dead cannon (false) is debris until a zone reset — distinct
       *  from a live cannon that merely `canFire: false` (reloading/inert). */
      alive: boolean;
      canFire: boolean;
      reason?: string;
    }[];
    /** My cannons grouped by nearest tower: total / alive / dead / inert + types
     *  per castle pocket — the battery health a rebuild decision turns on. Empty
     *  until you place cannons. */
    cannonsByTower: TowerCannons[];
    /** BATTLE: how many of your cannons can fire THIS INSTANT. A cannon reloads
     *  only when its previous ball lands (one ball in flight per cannon), so
     *  firing more than this many in a burst just wastes actions on reload —
     *  fire up to `cannonsReady`, then `pass` a beat to let balls land. */
    cannonsReady: number;
    /** How many of your cannons are stranded OUTSIDE a sealed ring — inert dead
     *  weight that can't fire until you reseal. `> 0` means your effective
     *  battery is smaller than your cannon count; reseal or rebalance. */
    cannonsUnenclosed: number;
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
   *  mode (only modes whose slotCost fits your remaining slots appear), SAFE
   *  first — spots off the outer wall ring (`wallLineSides` 0) before ring-
   *  huggers, which go inert if that wall is breached. If no `super` entry
   *  appears, no 3×3 fits your interior — place normals instead. */
  cannonSuggestions?: CannonSuggestion[];
  /** WALL_BUILD only: every tower in your zone you could enclose (home first,
   *  then cheapest). The strategic layer — there can be several. `tiles` here is
   *  a sample (≤ ENCLOSURE_TILE_SAMPLE); `tilesNeeded` is the true count, and the
   *  full min-cut plan comes from the `enclose_plan` tool. */
  enclosureCandidates?: EnclosureCandidate[];
  /** WALL_BUILD only: bonus squares in your zone — the highest points-per-tile
   *  target (10×√territory each, 3 per zone, replenished each round) and invisible on
   *  the raw board. Capture one by enclosing the tower whose pocket holds it
   *  (`capturedByTower`); enclosureCandidates carry a matching `bonusSquares`
   *  count so you can prioritise a pocket that banks one. */
  bonusTargets?: BonusTarget[];
  /** WALL_BUILD only: legal placements for the CURRENT piece, ranked best-first
   *  by how many of its tiles touch your existing ring (so ring repairs sort
   *  above isolated drops). A ready-made shortlist so you needn't hunt the grid. */
  suggestions?: BuildSuggestion[];
  /** WALL_BUILD only: MY wall tiles with ≤1 orthogonal wall-neighbour — exactly
   *  what the round-end sweep (`sweepIsolatedWalls`) deletes. A lone segment's
   *  open ends sit here; give each a 2nd wall neighbour (extend or anchor it) or
   *  it erodes next round. The durability lens for cross-round building — empty
   *  means nothing of yours is sweep-fragile. Omitted when there's nothing. */
  fragileWalls?: { row: number; col: number }[];
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
  /** BATTLE: the best enemy wall tiles to plant a super-cannon PIT on, ranked by
   *  denial value (un-reroutable chokepoints first). Feed these to
   *  `pitStrike(slot, targets)`. Omitted outside BATTLE / when you have no super. */
  pitTargets?: PitTarget[];
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
  /** Advance time, stopping early on a phase change, battle going live, or game
   *  over. Pass `seconds` (the unit you read as timerSec) to advance ~that long;
   *  `count` is the legacy action-quanta form. Omit both = one decision step. */
  pass(count?: number, seconds?: number): Observation;
  /** WALL_BUILD: drive the whole phase toward enclosing `towerIdx` (default your
   *  home tower) — the harness places each arriving piece on the best min-cut
   *  tile until it seals, time runs low, or it stalls. One call ≈ a whole build.
   *  Pass a `budget` (maxSeconds / maxPieces) to stop early and reserve the rest
   *  of the phase for a second build instead of gambling the whole timer. */
  build(towerIdx?: number, budget?: BuildBudget): Observation;
  /** WALL_BUILD: lay a wall LINE from `from` to `to` (straight when aligned, else
   *  an L) using whatever pieces arrive — the geometric counterpart to `build`'s
   *  enclose. For pre-claiming a flank, bridging two towers, or splitting a
   *  captured region across rounds. Partial progress survives the round-end sweep
   *  only where each tile keeps ≥2 wall neighbours, so the result flags any
   *  sweep-fragile path tiles (anchor both ends or they erode). Honours `budget`. */
  path(
    from: { row: number; col: number },
    to: { row: number; col: number },
    budget?: BuildBudget,
  ): Observation;
  /** BATTLE: SPREAD fire over `slot`'s nearest walls, pacing reload, for the rest
   *  of the battle (or `quanta` action-quanta) — maximises wall count destroyed
   *  (points + general tax). One call ≈ a whole battle of fire/pass. */
  bombard(slot: number, quanta?: number): Observation;
  /** BATTLE: CONCENTRATE fire on the outer ring guarding one of `slot`'s enclosed
   *  towers (the softest by ringWalls/bonus if `towerIdx` omitted) to de-enclose
   *  its pocket — denies that pocket's territory + bonus squares next build,
   *  where bombard just spreads damage they reseal. One call ≈ a whole battle. */
  breach(slot: number, towerIdx?: number): Observation;
  /** BATTLE: drive the whole battle like bombard, but AIM your super cannon(s) at
   *  `targets` (enemy wall tiles) to plant burning PITS there while normal cannons
   *  spread-chip `slot`'s walls. A super ball only pits a tile it HITS AS A WALL,
   *  and the pit blocks rebuilding for BURNING_PIT_DURATION rounds — so a pit on a
   *  load-bearing / un-reroutable wall denies their reseal for rounds, unlike a
   *  bombard hit they patch next build. Omit `targets` to use the ranked
   *  `pitTargets` for that slot. Normals + supers still fire only while the battle
   *  is live and paced to reload — same fairness as bombard. */
  pitStrike(
    slot: number,
    targets?: { row: number; col: number }[],
  ): Observation;
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
/** How many cut tiles each enclosure candidate carries IN THE OBSERVATION — a
 *  token-cheap preview. The full list (for big captures) comes from the
 *  `enclose_plan` tool / `enclosurePlan()` on demand. */
const ENCLOSURE_TILE_SAMPLE = 8;
/** How many of an opponent's wall tiles to surface as aim-assist in BATTLE. */
const BATTLE_TARGET_SAMPLE = 10;
/** How many ranked pit targets to surface per opponent in BATTLE. */
const PIT_TARGETS_PER_OPPONENT = 3;
/** Chebyshev radius around an opponent tower that counts as its guarding ring —
 *  the band a `breach` concentrates fire on to de-enclose that pocket. */
const BREACH_RADIUS = 6;
/** How many placements to surface per cannon mode in CANNON_PLACE. */
const CANNON_SUGGESTION_PER_MODE = 3;
/** Tile margin around the agent's zone in the cropped board — kept in one place
 *  so the rendered crop and the reported `boardBounds` can't drift apart. */
const BOARD_CROP_PAD = 2;
/** `build_toward` stops with this much build time left, so the phase-end sweep
 *  doesn't fire mid-placement and the agent isn't surprised by a phase flip. */
const MIN_BUILD_LEFT_SEC = 1.5;
/** Hard cap on placements per `build_toward` call — a runaway-loop backstop. */
const MAX_BUILD_PIECES = 60;
/** Consecutive non-progress placements before `build_toward` reports "stuck". */
const BUILD_STALL_LIMIT = 4;
/** Consecutive LANDED placements with no new low in tiles-to-seal before
 *  `build_toward` reports "diverging": pieces are landing on-target yet the goal
 *  isn't getting closer, so the min-cut ring is routing outward (around a
 *  grunt/obstacle) faster than the agent closes it — bail rather than burn the
 *  whole phase on a ring that never seals. Looser than BUILD_STALL_LIMIT because
 *  a healthy build still dips to a new low every piece or two. */
const BUILD_DIVERGE_LIMIT = 8;
/** When `build_toward` is called with no explicit `maxSeconds`, it still caps
 *  itself so a big enclosure can't silently gamble the whole phase: the cap is
 *  the fair-cadence estimate to seal the cut (`estSeconds`) times this factor,
 *  plus a fixed buffer, clamped to the time left. A clean seal finishes well
 *  inside it; a thrash (small cut burning many seconds, or a long bag-cycle for
 *  a small piece) is paused so the agent regains control and banks the partial
 *  progress instead of losing the phase. The buffer covers dud-redirects and
 *  bag-cycling so Fix-1's small-piece wait isn't cut short. */
const BUILD_AUTOCAP_FACTOR = 1.5;
const BUILD_AUTOCAP_BUFFER_SEC = 8;
/** A one-cell "piece" — probes a single tile's buildability via `canPlacePiece`
 *  for the buildable-island walk behind `needs-small-piece`/`unfillable`. */
const SINGLE_CELL: readonly [number, number][] = [[0, 0]];
/** Game-time cost (ticks) of placing ONE build piece — deliberately NOT the
 *  generic `actionTicks`. A build piece is the only action whose COUNT is
 *  time-bounded (cannons are capped by slots, fires by reload), so its per-piece
 *  cost is the fairness lever: the real AI/human spends ~1.3s on a piece (cursor
 *  travel + rotation animation + pre/post-place delays). Measured median across
 *  the three AI players = 78 ticks per piece (counting `wallPlaced` gaps in an
 *  all-AI run); charge the agent the same, or it out-builds opponents on clock
 *  speed alone — placing ~4× the pieces per build phase (the round-1 "3 towers
 *  vs 1" gap). */
const BUILD_PIECE_TICKS = 78;
/** Sim ticks per second (`advance(1)` = one `sc.tick(1)` = one SIM_TICK_DT). The
 *  bridge between `BUILD_PIECE_TICKS` (ticks) and `state.timer` (seconds). */
const SIM_TICKS_PER_SEC = Math.round(1 / SIM_TICK_DT);
/** Cut tiles a single placed piece closes, on average — an evidence-based divisor
 *  (a 31-tile cut took `build_toward` 11 pieces to get within 4, i.e. ~27 tiles /
 *  11 ≈ 2.5). Lets `enclosureSeconds` turn a tile count into a real time cost so
 *  `feasible` means "fits in the build time left", not "under a planner cap". */
const CUT_TILES_PER_PIECE = 2.5;

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

  /** Memoised count of my zone's land tiles — static for the match (zones +
   *  water never change). -1 = not yet computed. */
  let zoneLandCache = -1;

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

  /** The interior rect a tower's enclosure fills: home reuses its existing wall
   *  bbox (so its bonuses/cut track the real ring); other towers get a fresh
   *  proposed castle rect. Null only when home has no walls yet. */
  function pocketRectFor(
    tower: (typeof sc.state.map.towers)[number],
    isHome: boolean,
    bounds: CastleBounds | null,
  ): TileRect {
    if (isHome && bounds) {
      return {
        top: bounds.minRow + 1,
        bottom: bounds.maxRow - 1,
        left: bounds.minCol + 1,
        right: bounds.maxCol - 1,
      };
    }
    return castleRect(
      tower,
      sc.state.map.tiles,
      sc.state.map.towers,
      ENCLOSURE_MARGIN,
      true,
    );
  }

  /** My zone's enclosable land tile count — static for the match, so computed
   *  once. The ceiling on my per-build territory; projects bonus value. */
  function myZoneLand(): number {
    if (zoneLandCache >= 0) return zoneLandCache;
    const state = sc.state;
    const zone = state.playerZones[agentSlot];
    let land = 0;
    if (zone !== undefined) {
      for (let row = 0; row < GRID_ROWS; row++) {
        for (let col = 0; col < GRID_COLS; col++) {
          if (
            zoneAt(state.map, row, col) === zone &&
            !isWater(state.map.tiles, row, col)
          ) {
            land++;
          }
        }
      }
    }
    zoneLandCache = land;
    return land;
  }

  /** Points one bonus square scores when captured — the engine's
   *  `territoryBonusSquarePoints` (10×√territory, quantised to 100, clamped
   *  [100,1000]; build-system.ts). A bonus banks at END of build with the FINAL
   *  interior, so value off the current (often breached / pre-enclosure)
   *  interior understates it. Project from the larger of the current interior
   *  and my zone's enclosable land — the territory I'm building toward. (On a
   *  small zone the √ formula floors at 100; bigger zones/modes scale up.) */
  function bonusValueNow(): number {
    const interior = sc.state.players[agentSlot]?.interior.size ?? 0;
    const size = Math.max(interior, myZoneLand());
    const raw = Math.floor((10 * Math.sqrt(size)) / 100) * 100;
    return Math.max(100, Math.min(1000, raw));
  }

  /** Bonus squares in my zone that are NOT yet inside my interior — the ones
   *  still worth chasing this build. */
  function uncapturedZoneBonuses(): (typeof sc.state.bonusSquares)[number][] {
    const state = sc.state;
    const player = state.players[agentSlot];
    const zone = state.playerZones[agentSlot];
    if (!player || zone === undefined) return [];
    return state.bonusSquares.filter(
      (bonus) =>
        bonus.zone === zone &&
        !player.interior.has(packTile(bonus.row, bonus.col)),
    );
  }

  /** True if (row,col) sits inside the rect (inclusive). */
  function rectHas(rect: TileRect, row: number, col: number): boolean {
    return (
      row >= rect.top &&
      row <= rect.bottom &&
      col >= rect.left &&
      col <= rect.right
    );
  }

  /** Can a wall cell legally sit on (row,col) right now? The engine's placement
   *  rule (grass, my zone, no wall/cannon/tower/grunt/pit) probed one cell at a
   *  time — the ground truth the `unfillable` island flood walks over. */
  function isBuildableGround(row: number, col: number): boolean {
    return canPlacePiece(sc.state, agentSlot, SINGLE_CELL, row, col);
  }

  /** Size of the 4-connected buildable-ground island containing (row,col),
   *  capped at `cap`. A min-cut tile whose island is <4 cells can't be covered
   *  by the 4-cell pieces; size 0 means no buildable ground at all (a hard
   *  `unfillable` — cannon/tower/water on the ring line), while 1–3 means a
   *  smaller piece still fits (a soft `needs-small-piece`). Capped so it stays
   *  O(cap), not O(map). */
  function buildableIslandSize(row: number, col: number, cap: number): number {
    if (!isBuildableGround(row, col)) return 0;
    const seen = new Set<number>([packTile(row, col)]);
    const stack: [number, number][] = [[row, col]];
    while (stack.length > 0 && seen.size < cap) {
      const [cr, cc] = stack.pop()!;
      for (const [dr, dc] of DIRS_4) {
        const nr = cr + dr;
        const nc = cc + dc;
        if (!inBounds(nr, nc)) continue;
        const key = packTile(nr, nc);
        if (seen.has(key) || !isBuildableGround(nr, nc)) continue;
        seen.add(key);
        stack.push([nr, nc]);
      }
    }
    return seen.size;
  }

  /** A grunt is "boxed" when no orthogonal neighbour is a tile it could step to
   *  (every side is a wall, water, another grunt, a living tower, or enclosed
   *  interior). A boxed grunt on a min-cut tile won't leave this phase, so the
   *  seal is permanently blocked — the exact jam that cost the seed-88421 final.
   *  Skips the living-tower case (rare next to a gap) so the bias is toward
   *  calling it `mobile`/feasible, never a false `boxed`. */
  function isGruntBoxed(grunt: { row: number; col: number }): boolean {
    const state = sc.state;
    for (const [dr, dc] of DIRS_4) {
      const nr = grunt.row + dr;
      const nc = grunt.col + dc;
      if (!inBounds(nr, nc)) continue;
      if (!isGruntPassableTile(state, nr, nc)) continue;
      const key = packTile(nr, nc);
      if (state.grunts.some((other) => other.row === nr && other.col === nc)) {
        continue;
      }
      if (state.players.some((other) => other?.interior.has(key))) continue;
      return false;
    }
    return true;
  }

  /** Classify why each still-open min-cut tile can't be walled now (free tiles
   *  omitted). The blocker-aware core: a tile already walled is skipped, a grunt
   *  on it is boxed-or-mobile, a pit on it is `pit`, an island <4 cells is
   *  `unfillable`. Order matters — grunt/pit are checked before the island walk
   *  because an occupant makes the cell read as non-buildable-ground. */
  function classifySealBlockers(
    tiles: readonly { row: number; col: number }[],
  ): SealBlocker[] {
    const state = sc.state;
    const walls = state.players[agentSlot]?.walls;
    const out: SealBlocker[] = [];
    for (const { row, col } of tiles) {
      if (walls?.has(packTile(row, col))) continue;
      const grunt = state.grunts.find(
        (other) => other.row === row && other.col === col,
      );
      if (grunt) {
        const boxed = isGruntBoxed(grunt);
        out.push({
          row,
          col,
          kind: boxed ? "grunt-boxed" : "grunt-mobile",
          hard: boxed,
        });
        continue;
      }
      if (hasPitAt(state.burningPits, row, col)) {
        out.push({ row, col, kind: "pit", hard: true });
        continue;
      }
      // Island size splits the piece-fit block: 0 cells = no buildable ground
      // here at all (a cannon/tower/water sits on the ring tile) → truly
      // `unfillable`, hard. 1–3 cells = too small for the 4-cell pieces, but a
      // 1×1/1×2/1×3 still fits, so it's a soft `needs-small-piece` and
      // `build_toward` cycles the bag for a fitting draw instead of bailing.
      const island = buildableIslandSize(row, col, 4);
      if (island < 4) {
        out.push({
          row,
          col,
          kind: island === 0 ? "unfillable" : "needs-small-piece",
          hard: island === 0,
        });
      }
    }
    return out;
  }

  /** One-line blocker summary for a `stuck`/`blocked` build reason. */
  function describeBlockers(blockers: readonly SealBlocker[]): string {
    if (blockers.length === 0) return "";
    const shown = blockers
      .slice(0, 4)
      .map((blocker) => `(${blocker.row},${blocker.col}) ${blocker.kind}`)
      .join(", ");
    const extra = blockers.length > 4 ? ` +${blockers.length - 4} more` : "";
    return ` — ${shown}${extra}`;
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
    const bonuses = uncapturedZoneBonuses();
    const out: EnclosureCandidate[] = [];
    for (const tower of state.map.towers) {
      if (tower.zone !== zone) continue;
      const isHome = tower.index === homeIdx;
      const pocket = pocketRectFor(tower, isHome, bounds);
      // Bonus squares this tower's pocket would bank (only meaningful while the
      // tower isn't yet enclosed — once enclosed, whatever it holds is already
      // counted in the interior).
      const bonusSquares = bonuses.filter((bonus) =>
        rectHas(pocket, bonus.row, bonus.col),
      ).length;
      const base = { towerIdx: tower.index as number, isHome, bonusSquares };
      // Ground truth first: if the tower is already enclosed, say so. The
      // min-cut below derives the home interior from the wall bounding box,
      // which outward wall nubs distort into a bogus non-zero cut — so an
      // already-sealed home would otherwise read as "needs N more tiles".
      if (player.enclosedTowers.some((enc) => enc.index === tower.index)) {
        out.push({
          ...base,
          bonusSquares: 0,
          status: "enclosed",
          tilesNeeded: 0,
          tiles: [],
          estSeconds: 0,
          feasible: true,
          blockers: [],
        });
        continue;
      }
      if (!isTowerEnclosable(tower, state, false)) {
        out.push({
          ...base,
          bonusSquares: 0,
          status: "unenclosable",
          tilesNeeded: 0,
          tiles: [],
          estSeconds: 0,
          feasible: false,
          blockers: [],
          reason: "no wallable ring — leaks to the map edge through water/pit",
        });
        continue;
      }
      const cutFor = (interior: TileRect) =>
        findEnclosureCut([{ tower, interior }], state, player.walls, false);
      // Home tries its existing-ring bbox first; if that sprawled into an
      // unfillable rect (outward nubs, multi-tower extension), retry a fresh
      // tight rect before calling home unenclosable — the bbox, not the
      // geometry, is usually what failed.
      const freshPocket = pocketRectFor(tower, false, null);
      let cut = cutFor(pocket);
      if (cut === null && isHome && bounds) cut = cutFor(freshPocket);
      if (cut === null) {
        out.push({
          ...base,
          bonusSquares: 0,
          status: "unenclosable",
          tilesNeeded: 0,
          tiles: [],
          estSeconds: 0,
          feasible: false,
          blockers: [],
          reason:
            "no piece-fillable ring: a 1-tile gap is pinched between solids " +
            "(often a cannon on the ring line) — plug it by hand",
        });
      } else if (cut.size === 0) {
        out.push({
          ...base,
          bonusSquares: 0,
          status: "enclosed",
          tilesNeeded: 0,
          tiles: [],
          estSeconds: 0,
          feasible: true,
          blockers: [],
        });
      } else {
        const tiles = [...cut].map((key) => {
          const pos = unpackTile(key);
          return { row: pos.row, col: pos.col };
        });
        const estSeconds = enclosureSeconds(cut.size);
        const blockers = classifySealBlockers(tiles);
        out.push({
          ...base,
          status: "enclosable",
          tilesNeeded: cut.size,
          tiles,
          estSeconds,
          feasible:
            estSeconds <= state.timer &&
            !blockers.some((blocker) => blocker.hard),
          blockers,
        });
      }
    }
    out.sort(
      (a, b) =>
        Number(b.isHome) - Number(a.isHome) || a.tilesNeeded - b.tilesNeeded,
    );
    return out;
  }

  /** Bonus squares in my zone — the highest points-per-tile build target, and
   *  invisible on the raw board. For each: its value at the current territory,
   *  whether it's already banked (inside my interior), and which tower's pocket
   *  would capture it. Uncaptured + capturable first. */
  function bonusTargetsFor(): BonusTarget[] {
    const state = sc.state;
    const player = state.players[agentSlot];
    const zone = state.playerZones[agentSlot];
    if (!player || zone === undefined) return [];
    const homeIdx = player.homeTower?.index;
    const bounds = wallBounds(player.walls);
    const zoneTowers = state.map.towers.filter((tower) => tower.zone === zone);
    const value = bonusValueNow();
    const out: BonusTarget[] = [];
    for (const bonus of state.bonusSquares) {
      if (bonus.zone !== zone) continue;
      const enclosed = player.interior.has(packTile(bonus.row, bonus.col));
      let capturedByTower: number | null = null;
      if (!enclosed) {
        // Prefer home, then any tower whose pocket contains it.
        const containing = zoneTowers
          .filter((tower) =>
            rectHas(
              pocketRectFor(tower, tower.index === homeIdx, bounds),
              bonus.row,
              bonus.col,
            ),
          )
          .sort(
            (a, b) => Number(b.index === homeIdx) - Number(a.index === homeIdx),
          );
        capturedByTower = containing[0]?.index ?? null;
      }
      out.push({
        row: bonus.row,
        col: bonus.col,
        value,
        enclosed,
        capturedByTower,
      });
    }
    // Uncaptured first, then ones a tower pocket can grab, then by position.
    out.sort(
      (a, b) =>
        Number(a.enclosed) - Number(b.enclosed) ||
        Number(b.capturedByTower !== null) - Number(a.capturedByTower !== null),
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

  /** Walls on the OUTER ring — a wall with a cardinal neighbour that is neither
   *  wall nor interior (it faces grass / the map edge). A cannon flush against
   *  one of these is the wall-line trap: breach that wall and the cannon becomes
   *  an obstacle the re-seal must detour around. Walls between interior and a
   *  tower (both non-outside) are NOT boundary. */
  function boundaryWalls(me: (typeof sc.state.players)[number]): Set<number> {
    const ring = new Set<number>();
    for (const key of me.walls) {
      const { row, col } = unpackTile(key as Parameters<typeof unpackTile>[0]);
      for (const [nr, nc] of [
        [row - 1, col],
        [row + 1, col],
        [row, col - 1],
        [row, col + 1],
      ]) {
        const facesOut =
          !inBounds(nr, nc) ||
          (!me.walls.has(packTile(nr, nc)) &&
            !me.interior.has(packTile(nr, nc)));
        if (facesOut) {
          ring.add(key);
          break;
        }
      }
    }
    return ring;
  }

  /** Legal cannon placements the agent can afford this round, grouped by mode.
   *  Ranked SAFE-first: spots that don't sit on the outer wall ring come before
   *  ring-huggers (`wallLineSides` > 0), and compactness (`hugs`) is only the
   *  tiebreak. A cannon on the ring goes inert the moment that wall is breached
   *  (the re-seal can't route around it without orphaning a 1-tile gap), so the
   *  old "most compact first" sort was steering placements straight into the
   *  trap. Modes too expensive for the remaining slots are dropped, so a missing
   *  `super` line means no 3×3 fits. */
  function cannonSuggestionsFor(): CannonSuggestion[] {
    const state = sc.state;
    const me = state.players[agentSlot];
    const bounds = me ? wallBounds(me.walls) : null;
    if (!me || !bounds) return [];
    const remaining = cannonSlotsFor(state, agentSlot) - cannonSlotsUsed(me);
    const solid = solidTiles(me);
    const ring = boundaryWalls(me);
    const out: CannonSuggestion[] = [];
    for (const def of cannonModesForGame(state.modern !== null)) {
      if (def.slotCost > remaining) continue;
      const spots: {
        row: number;
        col: number;
        hugs: number;
        wallLineSides: number;
      }[] = [];
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
            wallLineSides: footprintHug(row, col, def.size, ring),
          });
        }
      }
      spots.sort(
        (a, b) => a.wallLineSides - b.wallLineSides || b.hugs - a.hugs,
      );
      for (const spot of spots.slice(0, CANNON_SUGGESTION_PER_MODE)) {
        out.push({
          mode: def.id,
          row: spot.row,
          col: spot.col,
          size: def.size,
          slotCost: def.slotCost,
          hugs: spot.hugs,
          wallLineSides: spot.wallLineSides,
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

  /** Why a cannon can or can't fire right now. The load-bearing case is
   *  `unenclosed`: a cannon whose castle ring was breached is INERT — it
   *  silently drops out of every bombard until you reseal the territory. That
   *  failure was invisible (you'd just see a weak bombard), so each cannon now
   *  carries its own verdict + reason. `reloading` is transient (ball in
   *  flight); the rest are edge cases (destroyed, modern arc cannons). */
  function cannonFireStatus(
    cannon: Cannon,
    idx: number,
  ): { canFire: boolean; reason?: string } {
    const me = sc.state.players[agentSlot];
    if (!me) return { canFire: false, reason: "no player" };
    if (!isCannonAlive(cannon)) return { canFire: false, reason: "destroyed" };
    if (isBalloonCannon(cannon) || isRampartCannon(cannon)) {
      return {
        canFire: false,
        reason: "arc cannon — not on the direct-fire path",
      };
    }
    if (!isCannonEnclosed(cannon, me)) {
      return {
        canFire: false,
        reason: "unenclosed — castle breached, reseal to re-arm",
      };
    }
    if (
      !canFireOwnCannon(
        sc.state,
        agentSlot,
        idx as Parameters<typeof canFireOwnCannon>[2],
      )
    ) {
      return { canFire: false, reason: "reloading" };
    }
    return { canFire: true };
  }

  /** My cannons rolled up by the nearest of my zone's towers — total / alive /
   *  dead / inert + alive-by-type per castle pocket. The battery-health view a
   *  rebuild decision turns on (a pocket that's mostly dead debris + inert guns
   *  isn't worth resealing). Nearest-tower grouping is a proxy for "which castle
   *  this cannon belongs to" — exact for single-tower pockets, best-effort for
   *  merged ones. */
  function cannonsByTowerFor(): TowerCannons[] {
    const me = sc.state.players[agentSlot];
    const myZone = sc.state.playerZones[agentSlot];
    if (!me || me.cannons.length === 0) return [];
    const myTowers = sc.state.map.towers.filter(
      (tower) => tower.zone === myZone,
    );
    if (myTowers.length === 0) return [];
    const rollup = new Map<number, TowerCannons>();
    for (const cannon of me.cannons) {
      let nearest = myTowers[0]!;
      let bestDist = Infinity;
      for (const tower of myTowers) {
        const dist = distanceToTower(tower, cannon.row, cannon.col);
        if (dist < bestDist) {
          bestDist = dist;
          nearest = tower;
        }
      }
      let entry = rollup.get(nearest.index);
      if (!entry) {
        entry = {
          towerIdx: nearest.index,
          row: nearest.row,
          col: nearest.col,
          enclosed: me.enclosedTowers.some(
            (tower) => tower.index === nearest.index,
          ),
          total: 0,
          alive: 0,
          dead: 0,
          inert: 0,
          byMode: {},
        };
        rollup.set(nearest.index, entry);
      }
      entry.total++;
      if (isCannonAlive(cannon)) {
        entry.alive++;
        entry.byMode[cannon.mode] = (entry.byMode[cannon.mode] ?? 0) + 1;
        if (!isCannonEnclosed(cannon, me)) entry.inert++;
      } else {
        entry.dead++;
      }
    }
    return [...rollup.values()].sort((a, b) => a.towerIdx - b.towerIdx);
  }

  /** Cannons stranded outside a sealed ring — inert dead weight until you
   *  reseal. The at-a-glance "your battery is crippled" signal. */
  function cannonsUnenclosedCount(): number {
    const me = sc.state.players[agentSlot];
    if (!me) return 0;
    return me.cannons.reduce(
      (count, cannon) => count + (isCannonEnclosed(cannon, me) ? 0 : 1),
      0,
    );
  }

  /** What happened to ME this battle — the return-fire I take while a one-call
   *  bombard/breach runs (and can't react to). Walls lost, and whether my own
   *  ring was breached (cannons going inert is the live tell — enclosedTowers
   *  only recomputes next build). Appended to the attack result so a breached
   *  castle + disarmed battery isn't a surprise at the next build. */
  function battleSelfReport(
    myWallsBefore: number,
    inertBefore: number,
  ): string {
    const me = sc.state.players[agentSlot];
    const wallsLost = myWallsBefore - (me?.walls.size ?? myWallsBefore);
    const inertNow = cannonsUnenclosedCount();
    const total = me?.cannons.length ?? 0;
    const parts: string[] = [];
    if (wallsLost > 0) parts.push(`you lost ${wallsLost} walls`);
    if (inertNow > inertBefore) {
      parts.push(
        `ring breached — ${inertNow}/${total} cannons now inert (reseal first this build)`,
      );
    } else if (inertNow > 0) {
      parts.push(
        `${inertNow}/${total} cannons inert (unenclosed — reseal to re-arm)`,
      );
    }
    return parts.length > 0 ? `; ${parts.join(", ")}` : "";
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
    const box = { minRow, maxRow, minCol, maxCol };
    let best: { row: number; col: number; rotation: number } | null = null;
    let bestScore = [-1, -Infinity, -Infinity, -1];
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
            box,
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

  /** Lexicographic [coverage, -waste, -overshoot, ringTouch] score for one
   *  placement, or null if it covers no target tile (so it's never chosen for a
   *  goal). `overshoot` = piece tiles beyond `box` (the target tiles' bounding
   *  box): a tile outside it grows the castle's wall bbox outward, which inflates
   *  the home pocket on the NEXT plan, so the min-cut chases an ever-larger ring
   *  that never closes (the seed-42 R5 reseal that burned the whole phase). Rank
   *  it above ringTouch so a tight on-the-gap placement beats one that overshoots
   *  into open space — for an expansion the targets already sit at the far tower,
   *  so its in-box placements stay zero-overshoot and this never fights it. */
  function scorePlacement(
    offsets: readonly [number, number][],
    row: number,
    col: number,
    targets: ReadonlySet<number>,
    walls: ReadonlySet<number>,
    box: { minRow: number; maxRow: number; minCol: number; maxCol: number },
  ): [number, number, number, number] | null {
    const isWall = (tileRow: number, tileCol: number): boolean =>
      inBounds(tileRow, tileCol) && walls.has(packTile(tileRow, tileCol));
    let coverage = 0;
    let touching = 0;
    let overshoot = 0;
    for (const [dr, dc] of offsets) {
      const tileRow = row + dr;
      const tileCol = col + dc;
      if (targets.has(packTile(tileRow, tileCol))) coverage++;
      if (
        tileRow < box.minRow ||
        tileRow > box.maxRow ||
        tileCol < box.minCol ||
        tileCol > box.maxCol
      ) {
        overshoot++;
      }
      touching += [
        isWall(tileRow - 1, tileCol),
        isWall(tileRow + 1, tileCol),
        isWall(tileRow, tileCol - 1),
        isWall(tileRow, tileCol + 1),
      ].filter(Boolean).length;
    }
    if (coverage === 0) return null;
    return [coverage, -(offsets.length - coverage), -overshoot, touching];
  }

  /** The absolute tile window the `board` covers — mirrors asciiSnapshot's crop
   *  (battle = full map; otherwise the agent's zone padded by BOARD_CROP_PAD,
   *  clamped) so the agent can anchor a glyph to (row, col) without recounting
   *  the stacked header. Reuses the renderer's own `zoneBounds` to stay in sync. */
  function boardBoundsFor(battle: boolean): {
    minRow: number;
    maxRow: number;
    minCol: number;
    maxCol: number;
  } {
    const full = {
      minRow: 0,
      maxRow: GRID_ROWS - 1,
      minCol: 0,
      maxCol: GRID_COLS - 1,
    };
    if (battle) return full;
    const zone = sc.state.playerZones[agentSlot];
    const base = zone !== undefined ? zoneBounds(sc.state, zone) : undefined;
    if (!base) return full;
    return {
      minRow: Math.max(0, base.minRow - BOARD_CROP_PAD),
      maxRow: Math.min(GRID_ROWS - 1, base.maxRow + BOARD_CROP_PAD),
      minCol: Math.max(0, base.minCol - BOARD_CROP_PAD),
      maxCol: Math.min(GRID_COLS - 1, base.maxCol + BOARD_CROP_PAD),
    };
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
        : { cropTo: agentSlot, cropPad: BOARD_CROP_PAD, coords: true },
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
        score: player.score,
        projected: player.score + projectedFinalizeDelta(state, player),
      })),
      cannonballsInFlight: state.cannonballs.length,
      board,
      boardBounds: boardBoundsFor(battle),
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
        cannonPositions: me.cannons.map((cannon, idx) => {
          const status = cannonFireStatus(cannon, idx);
          return {
            row: cannon.row,
            col: cannon.col,
            mode: cannon.mode,
            alive: isCannonAlive(cannon),
            canFire: status.canFire,
            ...(status.reason ? { reason: status.reason } : {}),
          };
        }),
        cannonsByTower: cannonsByTowerFor(),
        cannonsReady: cannonsReadyCount(),
        cannonsUnenclosed: cannonsUnenclosedCount(),
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
      observation.bonusTargets = bonusTargetsFor();
      observation.suggestions = buildSuggestionsFor();
      const fragile = fragileWallsFor();
      if (fragile.length > 0) observation.fragileWalls = fragile;
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
          towers: opponentTowersFor(slot),
        }));
      // Pit targets only matter if I have a super to plant them with.
      const haveSuper = (state.players[agentSlot]?.cannons ?? []).some(
        (cannon) => isSuperCannon(cannon) && isCannonAlive(cannon),
      );
      if (haveSuper) {
        const pits = pitTargetsFor();
        if (pits.length > 0) observation.pitTargets = pits;
      }
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
      case "fire": {
        // Firing is legal ONLY while the battle is live: countdown finished AND
        // the round timer still running. The engine technically accepts fires
        // during the post-timer ball-landing window, but the AI never does
        // (ai-phase-battle gates on `battleCountdown <= 0 && timer > 0`), so the
        // agent must match — otherwise it fires dozens of extra shots a battle.
        if (phase !== Phase.BATTLE) {
          return { valid: false, reason: "not in BATTLE" };
        }
        if (sc.state.battleCountdown > 0) {
          return {
            valid: false,
            reason: "battle not live yet — wait out the countdown",
          };
        }
        if (sc.state.timer <= 0) {
          return {
            valid: false,
            reason:
              "battle timer expired — firing is closed, only in-flight balls land now",
          };
        }
        return { valid: true };
      }
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
    // A build piece costs its real placement time (cursor travel + rotation +
    // place delays), not the generic per-action quantum — see BUILD_PIECE_TICKS.
    // Cannons (slot-capped) and fires (reload-capped) can't be rushed for unfair
    // gain, so they keep the cheap quantum.
    advance(decision.kind === "build" ? BUILD_PIECE_TICKS : actionTicks);
    // The controller never reports cannon-commit success to the brain, so
    // derive it from the cannon-count delta.
    if (decision.kind === "cannon" && bridge.lastResult === null) {
      const after = sc.state.players[agentSlot]!.cannons.length;
      bridge.lastResult = { kind: "cannon", success: after > cannonsBefore };
    }
    settleToDecision();
    return observe();
  }

  /** Advance time, stopping early when something actionable changes — the phase
   *  flips, a pre-battle countdown finishes (so you can fire the moment battle
   *  goes live), or the game ends. Lets the agent skip dead time (a whole
   *  countdown, a quiet build) in ONE call. `seconds` is the agent-facing unit
   *  (matches timerSec); `count` is the legacy action-quanta form it converts to. */
  function pass(count = 1, seconds?: number): Observation {
    const startPhase = sc.state.phase;
    const wasCountdown = sc.state.battleCountdown > 0;
    // `seconds` (the unit the agent reads as timerSec) wins when given; convert
    // to action-quanta via the game's per-action tick cost. Each iteration still
    // advances exactly one quantum and stops early on a phase change.
    const iterations =
      seconds !== undefined
        ? Math.max(1, Math.round((seconds * SIM_TICKS_PER_SEC) / actionTicks))
        : count;
    for (let i = 0; i < iterations && !gameOver(); i++) {
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
    if (!checkDecision({ kind: "build", row, col, rotation }).valid) {
      return false;
    }
    // Success = the wall count grew (a piece adds tiles). Derived from state
    // rather than bridge.lastResult so it survives the advance cleanly.
    const before = sc.state.players[agentSlot]?.walls.size ?? 0;
    bridge.pending = { kind: "build", row, col, rotation };
    advance(BUILD_PIECE_TICKS);
    settleToDecision();
    return (sc.state.players[agentSlot]?.walls.size ?? 0) > before;
  }

  /** Place the current piece to best cover `targets` (a min-cut tile or a path
   *  tile). A dud that covers no target is redirected onto the ring to advance
   *  the bag without waste. Returns whether a piece landed, whether it was
   *  on-target, and whether there was no piece to place (a transient gap that
   *  should NOT count as a stall) — the shared inner step of the build drivers. */
  function placeTowardTargets(targets: ReadonlySet<number>): {
    landed: boolean;
    onTarget: boolean;
    noPiece: boolean;
  } {
    const piece = sc.state.players[agentSlot]?.currentPiece;
    if (!piece) {
      advance(actionTicks);
      settleToDecision();
      return { landed: false, onTarget: false, noPiece: true };
    }
    const aim = targets.size > 0 ? bestBuildPlacement(piece, targets) : null;
    const fallback = aim ?? buildSuggestionsFor()[0] ?? null;
    if (
      fallback &&
      commitBuildPiece(fallback.row, fallback.col, fallback.rotation)
    ) {
      return { landed: true, onTarget: aim !== null, noPiece: false };
    }
    advance(actionTicks);
    settleToDecision();
    return { landed: false, onTarget: false, noPiece: false };
  }

  /** Hit the budget/time/cap stop? Returns the outcome label, or null to keep
   *  going. Shared by both build drivers so their stop semantics stay identical. */
  function buildStop(
    placed: number,
    startTimer: number,
    pieceCap: number,
    budget: BuildBudget | undefined,
  ): string | null {
    if (sc.state.timer < MIN_BUILD_LEFT_SEC) return "time";
    if (placed >= pieceCap) {
      return budget?.maxPieces !== undefined && pieceCap === budget.maxPieces
        ? "piece-budget"
        : "cap";
    }
    if (
      budget?.maxSeconds !== undefined &&
      startTimer - sc.state.timer >= budget.maxSeconds
    ) {
      return "sec-budget";
    }
    return null;
  }

  /** Default `build_toward` time cap (seconds) when the caller named no
   *  `maxSeconds`: the goal's fair-cadence seal estimate × `BUILD_AUTOCAP_FACTOR`
   *  + a fixed buffer, clamped to the time left. A clean seal finishes inside it;
   *  a thrash is paused with partial progress banked. `undefined` = no cap (goal
   *  already enclosed/unenclosable, or no estimate yet). */
  function autoBuildCapSec(
    goalIdx: number | undefined,
    startTimer: number,
  ): number | undefined {
    const initial = enclosureCandidatesFor().find(
      (cand) => cand.towerIdx === goalIdx,
    );
    if (!initial || initial.estSeconds <= 0) return undefined;
    return Math.min(
      startTimer,
      initial.estSeconds * BUILD_AUTOCAP_FACTOR + BUILD_AUTOCAP_BUFFER_SEC,
    );
  }

  /** The placement loop behind `buildToward`: keep placing the arriving piece on
   *  the goal's min-cut until it seals, the budget/time stops it, or it jams.
   *  Returns the piece count placed and the stop `outcome`. Pulled out of
   *  `buildToward` so each stays within the per-function complexity budget.
   *
   *  Cycling: when EVERY still-open seal tile is soft-blocked (a `grunt-mobile`
   *  that may wander off, or a `needs-small-piece` sub-piece island awaiting a
   *  smaller draw), there is no on-target placement this step — so redirecting
   *  the current piece onto the ring to advance the bag/clock is deliberate
   *  cycling toward a resolvable state, NOT a stall or divergence. That's the fix
   *  for `build_toward` bailing the instant the last gap needed a 1×1 it didn't
   *  hold. The auto-cap (or any caller budget) bounds the cycle so an unlucky bag
   *  still terminates with partial progress banked. */
  function driveBuildLoop(
    goalIdx: number | undefined,
    startTimer: number,
    pieceCap: number,
    budget: BuildBudget | undefined,
  ): { placed: number; outcome: string } {
    let placed = 0;
    let stall = 0;
    let bestNeeded = Number.POSITIVE_INFINITY;
    let sinceImprove = 0;
    let outcome = "done";
    while (!gameOver() && sc.state.phase === Phase.WALL_BUILD) {
      const stop = buildStop(placed, startTimer, pieceCap, budget);
      if (stop) {
        outcome = stop;
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
      // Every remaining seal tile is HARD-blocked (boxed grunt / pit /
      // unfillable) → no piece will ever land. Stop now instead of thrashing
      // redirect pieces into the stall limit and burning real build seconds.
      if (
        candidate.blockers.length === candidate.tiles.length &&
        candidate.blockers.every((blocker) => blocker.hard)
      ) {
        outcome = "blocked";
        break;
      }
      // Every still-open seal tile is SOFT-blocked → no on-target placement this
      // step; redirecting to advance the bag/clock is productive cycling, not a
      // stall or divergence (see the function doc).
      const cyclingForPiece =
        candidate.blockers.length === candidate.tiles.length &&
        candidate.blockers.every((blocker) => !blocker.hard);
      // Divergence guard (skipped while cycling — tilesNeeded can't fall until a
      // blocker clears): pieces land but the ring routes outward faster than we
      // close it, so bail rather than burn the phase on a ring that never seals
      // (the seed-42 R5 reseal that grew r12→r6 and timed out).
      if (!cyclingForPiece) {
        if (candidate.tilesNeeded < bestNeeded) {
          bestNeeded = candidate.tilesNeeded;
          sinceImprove = 0;
        } else if (sinceImprove >= BUILD_DIVERGE_LIMIT) {
          outcome = "diverging";
          break;
        }
      }
      const targets = new Set(
        candidate.tiles.map((tile) => packTile(tile.row, tile.col)),
      );
      const step = placeTowardTargets(targets);
      if (step.noPiece) continue;
      if (step.landed) {
        placed++;
        // On-target resets the stall; an off-target redirect counts as a stall
        // (and toward divergence) ONLY when not deliberately cycling for a soft
        // blocker — otherwise a long, legitimate bag-cycle would trip "stuck".
        if (step.onTarget) stall = 0;
        else if (!cyclingForPiece) stall++;
        if (!cyclingForPiece) sinceImprove++;
      } else {
        stall++;
      }
      if (stall >= BUILD_STALL_LIMIT) {
        outcome = "stuck";
        break;
      }
    }
    return { placed, outcome };
  }

  /** Drive the WHOLE build phase toward a goal: enclose a tower (default home).
   *  Each step it reads the current piece, places it on the min-cut tile it best
   *  covers (or, for a piece that fits no gap, redirects it onto the ring to
   *  advance the bag), and repeats until the tower seals, build time runs low, or
   *  it stalls. When the only open seal tiles are sub-piece islands
   *  (`needs-small-piece`) or mobile grunts, redirecting the current piece onto
   *  the ring is deliberate bag-cycling toward a fitting/cleared draw — not a
   *  stall (see `driveBuildLoop`). The agent commits a strategy in one call; the
   *  harness executes it against whatever pieces arrive — batch building with no
   *  bag-peeking. A `budget` stops it early (banking partial progress, reserving
   *  the rest); with no explicit `maxSeconds` it self-caps (see `autoBuildCapSec`)
   *  so a big enclosure can't silently gamble the whole phase. */
  function buildToward(towerIdx?: number, budget?: BuildBudget): Observation {
    if (sc.state.phase !== Phase.WALL_BUILD) {
      bridge.lastResult = {
        kind: "build",
        success: false,
        reason: "not in WALL_BUILD",
      };
      return observe();
    }
    const goalIdx = towerIdx ?? sc.state.players[agentSlot]?.homeTower?.index;
    const startTimer = sc.state.timer;
    const pieceCap = Math.min(
      budget?.maxPieces ?? MAX_BUILD_PIECES,
      MAX_BUILD_PIECES,
    );
    // Default self-cap when the caller named no maxSeconds (banks partial
    // progress on a thrash instead of losing the phase — see autoBuildCapSec).
    const autoCapSec =
      budget?.maxSeconds === undefined
        ? autoBuildCapSec(goalIdx, startTimer)
        : undefined;
    const effectiveBudget =
      autoCapSec !== undefined ? { ...budget, maxSeconds: autoCapSec } : budget;
    const { placed, outcome } = driveBuildLoop(
      goalIdx,
      startTimer,
      pieceCap,
      effectiveBudget,
    );
    const finalCandidate = enclosureCandidatesFor().find(
      (cand) => cand.towerIdx === goalIdx,
    );
    const remaining = finalCandidate?.tilesNeeded ?? 0;
    const elapsed = Math.round((startTimer - sc.state.timer) * 10) / 10;
    // A "sec-budget" stop is the DEFAULT self-cap (not a caller budget) whenever
    // we injected autoCapSec — relabel it so the agent reads it as a pause, not
    // a jam, and knows to call again to continue.
    const autoPaused = outcome === "sec-budget" && autoCapSec !== undefined;
    const label = autoPaused ? "auto-paused" : outcome;
    const why =
      outcome === "diverging"
        ? " — ring keeps expanding instead of closing (an obstacle, usually a grunt on the cheap seal tile, is forcing a longer detour); clear it, target a tighter tower, or place by hand"
        : outcome === "stuck" || outcome === "blocked"
          ? describeBlockers(finalCandidate?.blockers ?? [])
          : autoPaused
            ? " — hit the default time cap so one enclosure doesn't eat the whole phase; call build_toward again to continue (it cycles the bag for any small-piece gap), or pass maxSeconds to override"
            : "";
    bridge.lastResult = {
      // Placing pieces IS progress — only a no-op (placed 0 and not already
      // sealed) is a real REJECT. A budget/time stop mid-plan is an OK partial:
      // the `outcome:` prefix carries whether the goal was reached.
      kind: "build",
      success: placed > 0 || outcome === "done",
      reason: `${label}: placed ${placed}, ${remaining} gaps left, ~${elapsed}s${why}`,
    };
    return observe();
  }

  /** Lay a wall LINE from `from` to `to` (straight when aligned, else an L),
   *  placing whatever pieces arrive over the route — the geometric counterpart to
   *  `buildToward`. For pre-claiming a flank or splitting a captured region across
   *  rounds. Tiles already walled / off your grass / on water are dropped from the
   *  route up front, so the executor never stalls on an unbuildable target. The
   *  result reports how many route tiles ended up sweep-fragile (≤1 wall-neighbour
   *  → the round-end sweep deletes them): anchor both ends on existing wall or the
   *  segment erodes. Honours the same `budget` as `buildToward`. */
  function buildPath(
    from: { row: number; col: number },
    to: { row: number; col: number },
    budget?: BuildBudget,
  ): Observation {
    if (sc.state.phase !== Phase.WALL_BUILD) {
      bridge.lastResult = {
        kind: "build",
        success: false,
        reason: "not in WALL_BUILD",
      };
      return observe();
    }
    const plan = pathTiles(from, to);
    if (plan.length === 0) {
      bridge.lastResult = {
        kind: "build",
        success: false,
        reason:
          "no buildable path tiles (route is off your grass / on water, or already walled)",
      };
      return observe();
    }
    const remainingTargets = (): Set<number> => {
      const walls = sc.state.players[agentSlot]?.walls;
      const out = new Set<number>();
      for (const key of plan) if (!walls?.has(key)) out.add(key);
      return out;
    };
    const startTimer = sc.state.timer;
    const pieceCap = Math.min(
      budget?.maxPieces ?? MAX_BUILD_PIECES,
      MAX_BUILD_PIECES,
    );
    let placed = 0;
    let stall = 0;
    let outcome = "done";
    let lastBlockers: SealBlocker[] = [];
    while (!gameOver() && sc.state.phase === Phase.WALL_BUILD) {
      const targets = remainingTargets();
      if (targets.size === 0) break;
      const stop = buildStop(placed, startTimer, pieceCap, budget);
      if (stop) {
        outcome = stop;
        break;
      }
      // Same early-out as build_toward: if every unlaid route tile is
      // HARD-blocked (boxed grunt / pit / unfillable slot), no piece can land —
      // stop before thrashing into the stall limit and burning build seconds.
      lastBlockers = classifySealBlockers(
        [...targets].map((key) =>
          unpackTile(key as ReturnType<typeof packTile>),
        ),
      );
      if (
        lastBlockers.length === targets.size &&
        lastBlockers.every((blocker) => blocker.hard)
      ) {
        outcome = "blocked";
        break;
      }
      const step = placeTowardTargets(targets);
      if (step.noPiece) continue;
      if (step.landed) {
        placed++;
        stall = step.onTarget ? 0 : stall + 1;
      } else {
        stall++;
      }
      if (stall >= BUILD_STALL_LIMIT) {
        outcome = "stuck";
        break;
      }
    }
    const laid = plan.length - remainingTargets().size;
    const fragile = fragilePathTiles(plan);
    const elapsed = Math.round((startTimer - sc.state.timer) * 10) / 10;
    const why =
      outcome === "stuck" || outcome === "blocked"
        ? describeBlockers(lastBlockers)
        : "";
    bridge.lastResult = {
      // Same partial-success rule as buildToward: laying any piece is progress.
      kind: "build",
      success: placed > 0 || outcome === "done",
      reason:
        `${outcome}: laid ${laid}/${plan.length} path tiles, ${placed} pieces, ~${elapsed}s${why}` +
        (fragile > 0
          ? `; ⚠ ${fragile} path tile(s) sweep-fragile (≤1 wall-neighbor — anchor or they erode next round)`
          : ""),
    };
    return observe();
  }

  /** The route tiles for `build_path`: the L-path (straight when aligned) whose
   *  elbow keeps the most tiles on the agent's own grass, with off-zone / water /
   *  already-walled tiles dropped. Packed keys, in build order. */
  function pathTiles(
    from: { row: number; col: number },
    to: { row: number; col: number },
  ): ReturnType<typeof packTile>[] {
    const myZone = sc.state.playerZones[agentSlot];
    const walls = sc.state.players[agentSlot]?.walls;
    const buildable = (row: number, col: number): boolean =>
      inBounds(row, col) &&
      !isWater(sc.state.map.tiles, row, col) &&
      zoneAt(sc.state.map, row, col) === myZone;
    const variants = [lPath(from, to, true), lPath(from, to, false)];
    const coverage = (tiles: readonly [number, number][]): number =>
      tiles.filter(([row, col]) => buildable(row, col)).length;
    const chosen =
      coverage(variants[0]!) >= coverage(variants[1]!)
        ? variants[0]!
        : variants[1]!;
    const seen = new Set<number>();
    const out: ReturnType<typeof packTile>[] = [];
    for (const [row, col] of chosen) {
      if (!buildable(row, col)) continue;
      const key = packTile(row, col);
      if (walls?.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    return out;
  }

  /** Of `plan`'s tiles already laid as wall, how many are sweep-fragile (≤1
   *  orthogonal wall-neighbour) — the open ends the round-end sweep will delete. */
  function fragilePathTiles(
    plan: readonly ReturnType<typeof packTile>[],
  ): number {
    const walls = sc.state.players[agentSlot]?.walls;
    if (!walls) return 0;
    let count = 0;
    for (const key of plan) {
      if (!walls.has(key)) continue;
      const { row, col } = unpackTile(key);
      if (countWallNeighbors(walls, row, col) <= 1) count++;
    }
    return count;
  }

  /** My wall tiles with ≤1 orthogonal wall-neighbour — exactly what the round-end
   *  `sweepIsolatedWalls` deletes (mirrors its `countWallNeighbors(...) <= 1`
   *  rule). A lone segment's open ends live here; give each a 2nd wall neighbour
   *  (extend or anchor it) or it erodes. */
  function fragileWallsFor(): { row: number; col: number }[] {
    const me = sc.state.players[agentSlot];
    if (!me) return [];
    const out: { row: number; col: number }[] = [];
    for (const key of me.walls) {
      const { row, col } = unpackTile(key as Parameters<typeof unpackTile>[0]);
      if (countWallNeighbors(me.walls, row, col) <= 1) out.push({ row, col });
    }
    return out;
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
    const myWallsBefore = me?.walls.size ?? 0;
    const inertBefore = cannonsUnenclosedCount();
    const budget = quanta ?? Infinity;
    let spent = 0;
    let fired = 0;
    while (!gameOver() && sc.state.phase === Phase.BATTLE && spent < budget) {
      const target = sc.state.players[targetSlot];
      // Fire ONLY while the battle is live: countdown finished AND timer still
      // running. The phase lingers past timer 0 while in-flight balls land, but
      // the AI never fires then (ai-phase-battle gates on the same condition), so
      // firing on would rain dozens of free post-timer shots. In every non-firing
      // case — counting down, winding down post-timer, target razed, or all
      // cannons reloading — just let time pass so the battle ends on its own (this
      // keeps "one bombard call = the whole battle" without the exploit).
      const live = sc.state.battleCountdown <= 0 && sc.state.timer > 0;
      const canFire =
        live &&
        target !== undefined &&
        !target.eliminated &&
        target.walls.size > 0 &&
        cannonsReadyCount() > 0;
      if (!canFire) {
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
      // pointsGained is MY attributed score; the target wall delta is its total
      // loss in the window (other players may have hit it too); the self-report
      // is the return fire I took while this ran.
      reason: `fired ${fired}, +${pointsGained} pts (target lost ${wallsDestroyed} walls)${battleSelfReport(
        myWallsBefore,
        inertBefore,
      )}`,
    };
    return observe();
  }

  /** Orthogonal sides of (row,col) that are water or off-board — the un-reroutable
   *  score for a pit: a wall pinched against rivers/edge can't be rebuilt one tile
   *  over, so a pit there is a near-permanent breach. */
  function chokeScore(row: number, col: number): number {
    let choke = 0;
    for (const [dr, dc] of DIRS_4) {
      const nr = row + dr;
      const nc = col + dc;
      if (!inBounds(nr, nc) || isWater(sc.state.map.tiles, nr, nc)) choke++;
    }
    return choke;
  }

  /** The best enemy wall tiles to plant a super-cannon pit on. Restricts to each
   *  opponent's tower-guarding ring walls (load-bearing — a pit there denies the
   *  reseal AND helps de-enclose the pocket), ranked by `choke` so the
   *  least-reroutable necks come first. A few per opponent. */
  function pitTargetsFor(): PitTarget[] {
    const out: PitTarget[] = [];
    const near = (row: number, col: number, tr: number, tc: number) =>
      Math.max(Math.abs(row - tr), Math.abs(col - tc)) <= BREACH_RADIUS;
    for (let slot = 0; slot < sc.state.players.length; slot++) {
      if (slot === agentSlot) continue;
      const opponent = sc.state.players[slot];
      if (!opponent || opponent.eliminated || opponent.walls.size === 0) {
        continue;
      }
      const ranked = [...boundaryWalls(opponent)]
        .map((key) => unpackTile(key as Parameters<typeof unpackTile>[0]))
        .map(({ row, col }) => {
          const tower = opponent.enclosedTowers.find((entry) =>
            near(row, col, entry.row, entry.col),
          );
          return {
            slot,
            row,
            col,
            choke: chokeScore(row, col),
            towerIdx: tower ? (tower.index as number) : null,
          };
        })
        .filter((target) => target.towerIdx !== null)
        .sort((a, b) => b.choke - a.choke);
      out.push(...ranked.slice(0, PIT_TARGETS_PER_OPPONENT));
    }
    return out.sort((a, b) => b.choke - a.choke);
  }

  /** An opponent's enclosed towers as breach targets, softest (thinnest guarding
   *  ring) first. `ringWalls` = their outer-ring walls within BREACH_RADIUS of
   *  the tower; `bonusSquares` = bonus squares in that pocket (denied on
   *  de-enclosure). */
  function opponentTowersFor(slot: number): OpponentTower[] {
    const opponent = sc.state.players[slot];
    if (!opponent) return [];
    const ring = boundaryWalls(opponent);
    const oppZone = sc.state.playerZones[slot];
    const near = (row: number, col: number, tr: number, tc: number) =>
      Math.max(Math.abs(row - tr), Math.abs(col - tc)) <= BREACH_RADIUS;
    return opponent.enclosedTowers
      .map((tower) => {
        let ringWalls = 0;
        for (const key of ring) {
          const { row, col } = unpackTile(
            key as Parameters<typeof unpackTile>[0],
          );
          if (near(row, col, tower.row, tower.col)) ringWalls++;
        }
        const bonusSquares = sc.state.bonusSquares.filter(
          (bonus) =>
            bonus.zone === oppZone &&
            opponent.interior.has(packTile(bonus.row, bonus.col)) &&
            near(bonus.row, bonus.col, tower.row, tower.col),
        ).length;
        return {
          towerIdx: tower.index as number,
          row: tower.row,
          col: tower.col,
          ringWalls,
          bonusSquares,
        };
      })
      .sort(
        (a, b) => b.bonusSquares - a.bonusSquares || a.ringWalls - b.ringWalls,
      );
  }

  /** The outer-ring wall tiles guarding one opponent tower — what a `breach`
   *  hammers. Boundary walls within BREACH_RADIUS of the tower, nearest the
   *  tower first (so fire concentrates on one arc and punches a contiguous hole
   *  rather than nibbling all round). */
  function breachTilesFor(
    slot: number,
    tower: { row: number; col: number },
  ): { row: number; col: number }[] {
    const opponent = sc.state.players[slot];
    if (!opponent) return [];
    const dist2 = (row: number, col: number) =>
      (row - tower.row) ** 2 + (col - tower.col) ** 2;
    return [...boundaryWalls(opponent)]
      .map((key) => unpackTile(key as Parameters<typeof unpackTile>[0]))
      .filter(
        ({ row, col }) =>
          Math.max(Math.abs(row - tower.row), Math.abs(col - tower.col)) <=
          BREACH_RADIUS,
      )
      .sort((a, b) => dist2(a.row, a.col) - dist2(b.row, b.col));
  }

  /** Concentrate fire to DE-ENCLOSE one opponent tower's pocket — the targeted
   *  counterpart to `bombard`'s spread. Where bombard maximises raw wall count
   *  destroyed (points + general tax), breach hammers the outer ring guarding
   *  ONE tower so the pocket opens: that pocket scores zero next build unless
   *  they reseal it, and its bonus squares fall out of their interior. Picks the
   *  softest / most-bonus enclosed tower if `towerIdx` is omitted. Same fairness
   *  as bombard — fires only while the battle is live, one ready cannon per
   *  shot, paced to reload. */
  function breachSlot(targetSlot: number, towerIdx?: number): Observation {
    if (sc.state.phase !== Phase.BATTLE) {
      bridge.lastResult = {
        kind: "fire",
        success: false,
        reason: "not in BATTLE",
      };
      return observe();
    }
    const towers = opponentTowersFor(targetSlot);
    const tower =
      towerIdx !== undefined
        ? towers.find((entry) => entry.towerIdx === towerIdx)
        : towers[0];
    if (!tower) {
      bridge.lastResult = {
        kind: "fire",
        success: false,
        reason:
          towers.length === 0
            ? "target has no enclosed tower to breach (bombard instead)"
            : `slot ${targetSlot} has no enclosed tower ${towerIdx}`,
      };
      return observe();
    }
    const me = sc.state.players[agentSlot];
    const wallsBefore = sc.state.players[targetSlot]?.walls.size ?? 0;
    const scoreBefore = me?.score ?? 0;
    const myWallsBefore = me?.walls.size ?? 0;
    const inertBefore = cannonsUnenclosedCount();
    const stillEnclosed = () =>
      sc.state.players[targetSlot]?.enclosedTowers.some(
        (enc) => enc.index === tower.towerIdx,
      ) ?? false;
    let fired = 0;
    while (!gameOver() && sc.state.phase === Phase.BATTLE) {
      const target = sc.state.players[targetSlot];
      const live = sc.state.battleCountdown <= 0 && sc.state.timer > 0;
      const tiles = breachTilesFor(targetSlot, tower);
      const canFire =
        live &&
        target !== undefined &&
        !target.eliminated &&
        tiles.length > 0 &&
        cannonsReadyCount() > 0;
      if (!canFire) {
        advance(actionTicks);
        settleToDecision();
        continue;
      }
      const ready = cannonsReadyCount();
      for (let shot = 0; shot < ready && shot < tiles.length; shot++) {
        if (sc.state.phase !== Phase.BATTLE || gameOver()) break;
        const tile = tiles[shot]!;
        bridge.pending = { kind: "fire", row: tile.row, col: tile.col };
        advance(actionTicks);
        settleToDecision();
        fired++;
      }
    }
    const wallsDestroyed =
      wallsBefore - (sc.state.players[targetSlot]?.walls.size ?? 0);
    const pointsGained =
      (sc.state.players[agentSlot]?.score ?? 0) - scoreBefore;
    // enclosedTowers only recomputes at their next build, so de-enclosure shows
    // up THEN, not mid-battle — report the ring damage, which is what carries.
    // battleSelfReport is the return fire I took while this volley ran.
    bridge.lastResult = {
      kind: "fire",
      success: fired > 0,
      reason: `breached tower ${tower.towerIdx}: fired ${fired}, +${pointsGained} pts (ring lost ${wallsDestroyed} walls${
        stillEnclosed() ? "" : ", pocket OPEN"
      })${battleSelfReport(myWallsBefore, inertBefore)}`,
    };
    return observe();
  }

  /** Drive the whole battle like bombard, but AIM super cannons at `targets`
   *  (enemy wall tiles) to plant burning pits while normals spread-chip `slot`.
   *  Each shot peeks `nextReadyCannon` (own roster — fair) and, when the super is
   *  next, redirects it onto the next still-walled, not-yet-pitted target;
   *  everything else spreads like bombard. A pit only forms on a WALL hit and
   *  blocks rebuilding for BURNING_PIT_DURATION rounds, so this denies a reseal a
   *  bombard hit wouldn't. Same fairness as bombard (live-gated, reload-paced). */
  function pitStrike(
    targetSlot: number,
    targets?: { row: number; col: number }[],
  ): Observation {
    if (sc.state.phase !== Phase.BATTLE) {
      bridge.lastResult = {
        kind: "fire",
        success: false,
        reason: "not in BATTLE",
      };
      return observe();
    }
    const me = sc.state.players[agentSlot];
    const haveSuper = (me?.cannons ?? []).some(
      (cannon) => isSuperCannon(cannon) && isCannonAlive(cannon),
    );
    // No super → this is just a bombard; say so by delegating rather than
    // pretending to plant pits a normal ball can't make.
    if (!haveSuper) return bombardSlot(targetSlot);
    // Auto-aim (no explicit targets) lets the super RE-AIM once its initial picks
    // are razed; explicit targets are honoured verbatim (no re-aim).
    const autoTargets = !(targets && targets.length > 0);
    const pitTiles = (
      targets && targets.length > 0
        ? targets
        : pitTargetsFor().filter((target) => target.slot === targetSlot)
    ).map((target) => ({ row: target.row, col: target.col }));
    // A pit forms only where a super ball hits a standing WALL not already pitted.
    const stillPittable = (row: number, col: number): boolean =>
      (sc.state.players[targetSlot]?.walls.has(packTile(row, col)) ?? false) &&
      !hasPitAt(sc.state.burningPits, row, col);
    // The next still-standing pit tile for a super shot: round-robin the bound
    // picks; once they're all razed, re-rank the opponent's CURRENT tower-ring
    // walls (auto mode only, highest choke first) so the super keeps planting
    // instead of wasting the shot on a spread tile a normal ball already covers.
    const nextPitAim = (idx: number): { row: number; col: number } | null => {
      const live = pitTiles.filter((tile) => stillPittable(tile.row, tile.col));
      if (live.length > 0) return live[idx % live.length]!;
      if (!autoTargets) return null;
      const fresh = pitTargetsFor().find(
        (target) =>
          target.slot === targetSlot && stillPittable(target.row, target.col),
      );
      return fresh ? { row: fresh.row, col: fresh.col } : null;
    };
    const wallsBefore = sc.state.players[targetSlot]?.walls.size ?? 0;
    const scoreBefore = me?.score ?? 0;
    const myWallsBefore = me?.walls.size ?? 0;
    const inertBefore = cannonsUnenclosedCount();
    // Every tile a super shot actually aimed at (bound or re-aimed) — counting
    // pits over THIS set credits re-aimed fresh tiles too, which a fixed
    // pitTiles snapshot would miss.
    const superAims = new Set<number>();
    let fired = 0;
    let superShots = 0;
    let superDry = 0;
    let pitIdx = 0;
    while (!gameOver() && sc.state.phase === Phase.BATTLE) {
      const target = sc.state.players[targetSlot];
      const live = sc.state.battleCountdown <= 0 && sc.state.timer > 0;
      const canFire =
        live &&
        target !== undefined &&
        !target.eliminated &&
        target.walls.size > 0 &&
        cannonsReadyCount() > 0;
      if (!canFire) {
        advance(actionTicks);
        settleToDecision();
        continue;
      }
      const origin = cannonCentroid();
      const spread = sampleWallTiles(target.walls, target.walls.size, origin);
      const ready = cannonsReadyCount();
      for (let shot = 0; shot < ready && shot < spread.length; shot++) {
        if (sc.state.phase !== Phase.BATTLE || gameOver()) break;
        const shooter = sc.state.players[agentSlot];
        const next = shooter
          ? nextReadyCannon(sc.state, agentSlot, shooter.cannonRotationIdx)
          : null;
        const superNext =
          next?.type === "own" && isSuperCannon(shooter!.cannons[next.ownIdx]!);
        let aim = spread[shot]!;
        if (superNext) {
          const pit = nextPitAim(pitIdx);
          if (pit) {
            aim = pit;
            pitIdx++;
            superShots++;
            superAims.add(packTile(pit.row, pit.col));
          } else {
            superDry++;
          }
        }
        bridge.pending = { kind: "fire", row: aim.row, col: aim.col };
        advance(actionTicks);
        settleToDecision();
        fired++;
      }
    }
    const wallsDestroyed =
      wallsBefore - (sc.state.players[targetSlot]?.walls.size ?? 0);
    const pointsGained =
      (sc.state.players[agentSlot]?.score ?? 0) - scoreBefore;
    const pitsPlanted = [...superAims].filter((key) => {
      const { row, col } = unpackTile(key as Parameters<typeof unpackTile>[0]);
      return hasPitAt(sc.state.burningPits, row, col);
    }).length;
    const superNote = pitDryNote(superShots, superDry, autoTargets);
    bridge.lastResult = {
      kind: "fire",
      success: fired > 0,
      reason: `pit-strike slot ${targetSlot}: fired ${fired} (${superShots} super→pit), +${pointsGained} pts, target lost ${wallsDestroyed} walls, ${pitsPlanted} pit(s) planted${superNote}${battleSelfReport(
        myWallsBefore,
        inertBefore,
      )}`,
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
    path: buildPath,
    bombard: bombardSlot,
    breach: breachSlot,
    pitStrike,
    enclosurePlan,
    check,
    agentSlot,
    scenario: sc,
  };
}

/** Why a pit-strike planted 0 pits — appended to the result line ONLY when the
 *  super truly planted nothing, so a working strike stays terse. A 0-pit super
 *  was previously indistinguishable from a successful one; this names the cause
 *  (razed targets vs stale explicit aim vs the super never getting a live shot). */
function pitDryNote(
  superShots: number,
  superDry: number,
  autoTargets: boolean,
): string {
  if (superShots > 0) return "";
  if (superDry > 0) {
    return autoTargets
      ? "; ⚠ super planted no pits — no standing tower-ring wall left to pit (the choke walls were already razed)"
      : "; ⚠ super planted no pits — your target tiles weren't standing enemy walls when it fired (omit targets to auto-aim live ring walls)";
  }
  return "; ⚠ super never fired a pit shot (reloading, inert/unenclosed, or the battle ended first)";
}

/** Estimated build seconds to close a `cut`-tile enclosure at the fair per-piece
 *  cadence — `feasible` compares this against `state.timer`. */
function enclosureSeconds(cutTiles: number): number {
  const pieces = Math.ceil(cutTiles / CUT_TILES_PER_PIECE);
  return (pieces * BUILD_PIECE_TICKS) / SIM_TICKS_PER_SEC;
}

/** An L-shaped tile route from `from` to `to` — straight when the endpoints share
 *  a row or column. `horizFirst` picks which leg comes first (so the caller can
 *  choose the elbow that stays on its own grass). Both endpoints are inclusive. */
function lPath(
  from: { row: number; col: number },
  to: { row: number; col: number },
  horizFirst: boolean,
): [number, number][] {
  const range = (start: number, end: number): number[] => {
    const step = Math.sign(end - start) || 1;
    const out: number[] = [];
    for (let value = start; value !== end + step; value += step) {
      out.push(value);
    }
    return out;
  };
  const tiles: [number, number][] = [];
  if (horizFirst) {
    for (const col of range(from.col, to.col)) tiles.push([from.row, col]);
    for (const row of range(from.row, to.row)) tiles.push([row, to.col]);
  } else {
    for (const row of range(from.row, to.row)) tiles.push([row, from.col]);
    for (const col of range(from.col, to.col)) tiles.push([to.row, col]);
  }
  return tiles;
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
      return "Re-seal/expand your castle. Fastest: build_toward({ towerIdx }) hands the WHOLE phase to the harness to enclose a tower (omit towerIdx = your home) — one call; add { maxSeconds | maxPieces } to stop early and reserve time for a second build. build_path({ from, to }) lays a straight/L wall line to pre-claim or compartmentalise across rounds — anchor both ends on existing wall or it erodes (watch fragileWalls: your ≤1-neighbor tiles the round-end sweep deletes). Or place pieces by hand: act { kind: 'build', row, col, rotation }. Or pass.";
    case Phase.CANNON_PLACE:
      return "Place a cannon at its top-left — act { kind: 'cannon', row, col, mode }. See cannonSuggestions for legal spots you can afford, grouped by mode (no 'super' line = no 3x3 fits). Footprint: normal/balloon 2x2, super 3x3. Watch me.cannonSlots (used/max). End early with { kind: 'cannon-done' }, or pass.";
    case Phase.BATTLE:
      return "Attack an opponent for the whole battle (one call). Strategies: bombard({ slot }) SPREADS fire over their nearest walls — maximises wall count destroyed (points + general tax). breach({ slot, towerIdx? }) CONCENTRATES fire on the outer ring guarding one tower to de-enclose its pocket (deny its territory + bonus squares; omit towerIdx for the softest). pit_strike({ slot, targets? }) aims your SUPER cannon(s) at enemy wall tiles to plant burning PITS (block their rebuild for rounds) while normals chip — see pitTargets for the best un-reroutable walls; omit targets to use them. See targets (leader first; each lists towers with ringWalls + bonusSquares). Or aim by hand: act { kind: 'fire', row, col } (wait out battleCountdown > 0; fire at most me.cannonsReady per burst, then pass to reload).";
    default:
      return "No agent action this phase; call pass to advance.";
  }
}
