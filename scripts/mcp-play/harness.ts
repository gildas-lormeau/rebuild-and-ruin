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

import {
  type AsciiSnapshotOptions,
  asciiSnapshot,
  type EntityLayer,
  type MapLayer,
  zoneBounds,
} from "../../dev/dev-console-grid.ts";
import { castleRect, isTowerEnclosable } from "../../src/ai/ai-castle-rect.ts";
import { findEnclosureCut } from "../../src/ai/ai-min-cut.ts";
import { DefaultStrategy } from "../../src/ai/ai-strategy.ts";
import {
  findMinBreach,
  findTowerBreach,
} from "../../src/ai/ai-strategy-battle.ts";
import { AiController } from "../../src/controllers/controller-ai.ts";
import { createController } from "../../src/controllers/controller-factory.ts";
import { aimReachesTile } from "../../src/game/aim-occlusion.ts";
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
import {
  isGruntPassableTile,
  moveGrunts,
} from "../../src/game/grunt-movement.ts";
import { SUPPLY_SHIP_SPEED } from "../../src/game/modifiers/supply-ship.ts";
import { shouldSkipBattle } from "../../src/game/upgrade-system.ts";
import {
  type Cannon,
  CannonMode,
  isBalloonCannon,
  isCannonAlive,
  isRampartCannon,
  isSuperCannon,
} from "../../src/shared/core/battle-types.ts";
import {
  cannonModeDef,
  cannonModesForGame,
} from "../../src/shared/core/cannon-mode-defs.ts";
import {
  BALLOON_HITS_NEEDED,
  type ModifierId,
  SIM_TICK_DT,
  SUPER_BALLOON_HITS_NEEDED,
  TOWER_SIZE,
} from "../../src/shared/core/game-constants.ts";
import { Phase } from "../../src/shared/core/game-phase.ts";
import type { TileRect } from "../../src/shared/core/geometry-types.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  type TileKey,
} from "../../src/shared/core/grid.ts";
import { modifierDef } from "../../src/shared/core/modifier-defs.ts";
import {
  type PieceShape,
  piecesInRoundPool,
  rotateCW,
} from "../../src/shared/core/pieces.ts";
import type { ValidPlayerId } from "../../src/shared/core/player-slot.ts";
import type { Player } from "../../src/shared/core/player-types.ts";
import {
  cannonSize,
  computeOutside,
  computeOutsideAfterAdd,
  countWallNeighbors,
  DIRS_4,
  DIRS_8,
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
import { UID, UPGRADE_POOL } from "../../src/shared/core/upgrade-defs.ts";
import {
  filterAliveEnclosedTowers,
  isCannonEnclosed,
} from "../../src/shared/sim/board-occupancy.ts";
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
  /** Game mode. "modern" turns on modifiers + upgrade draft + combos +
   *  catapults; the only EXTRA agent decision it adds is the UPGRADE_PICK phase
   *  (rounds ≥ 3, and only when the match has a later round to spend the upgrade
   *  in — so a 3-round match never reaches it; use `rounds` ≥ 4 to exercise it).
   *  Modifiers / combos / catapults are passive — observe-only. Default "classic". */
  mode?: "classic" | "modern";
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
  /** DEV/DEBUG only (modern): force a specific environmental modifier every round
   *  instead of the RNG roll — short-circuits `rollModifier` via the scenario's
   *  `testHooks.forceModifier`. Lets a session reproduce a modifier on demand
   *  (e.g. `"supply_ship"` to exercise the river-ship hunt, `"dust_storm"` to test
   *  aim jitter) without re-rolling for it. Test-only, never serialized. Ignored
   *  in classic. */
  forceModifier?: ModifierId;
}

export interface TowerHint {
  index: number;
  row: number;
  col: number;
  enclosed: boolean;
  /** CASTLE_SELECT headroom for picking THIS tower as home: the buildable pocket
   *  the engine's own `castleRect` carves around it (height × width), clipped by
   *  rivers / the map edge / neighbouring towers. The measured form of "a central
   *  tower has plenty of room, an edge/river tower is hemmed in" — pick the roomy
   *  one and you can afford cannons + a 3×3 dump pocket; a thin one bag-locks
   *  sooner. `min(h, w) >= 3` ⇒ a generic 3×3 dump fits. */
  pocket: { h: number; w: number };
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

/** One legal placement of the current piece within a queried zone, annotated
 *  with what it accomplishes — the exhaustive, decision-linked counterpart to
 *  the top-6 `buildSuggestions`. Replaces guess-and-check `check_placement`
 *  loops: ask once, get every option in the window scored against the live
 *  seal/drift signals. */
export interface ZonePlacement extends BuildSuggestion {
  /** Human-readable label of the tower this placement single-tile-SEALS —
   *  `"HOME"` or `"tower N"` — set when any of the piece's tiles lands on a
   *  `sealTiles` entry (a tile that, walled, encloses that tower, INCLUDING
   *  inner-corner diagonal-leak seals). A string (never a bare index) so the
   *  home tower reads `"HOME"` instead of a falsy-looking `0`. The headline:
   *  a placement with `sealsTower` set closes a pocket outright. Absent otherwise. */
  sealsTower?: string;
  /** True if any tile lands on a grunt-DRIFT tile — placing it pre-empts a
   *  converging grunt (the "wall these FIRST" move). */
  coversDrift: boolean;
}

/** Result of a zone-placement query: the current piece, the resolved window,
 *  and every legal placement within it (capped, best-first). `total` is the
 *  pre-cap count so a truncation is visible. */
export interface ZonePlacements {
  piece: string | null;
  zone: { minRow: number; maxRow: number; minCol: number; maxCol: number };
  total: number;
  shown: number;
  placements: ZonePlacement[];
}

/** Render overrides for an on-demand `observe` — let the agent drive its OWN
 *  view instead of the fixed full board: `crop` a tight window (reliable tile
 *  reading without counting 35-wide rows), pick a cumulative `layer`, or
 *  isolate an arbitrary entity subset with `show` (`["walls"]` = just the ring,
 *  `["grunts"]` = just the swarm). Omitted = the default zone-cropped board. */
export interface ViewOptions {
  /** Partial — missing edges default to the board bounds, so a half-rect reads
   *  as a band (e.g. only minRow/maxRow = full-width strip). */
  crop?: { minRow?: number; maxRow?: number; minCol?: number; maxCol?: number };
  layer?: MapLayer;
  show?: readonly EntityLayer[];
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
  /** Ground truth from `state.towerAlive`: is this tower alive right now? The
   *  round-end life penalty only clears when an ALIVE tower is enclosed at
   *  finalize (`filterAliveEnclosedTowers`), so enclosing a DEAD tower — bonus
   *  stars and all — does NOT by itself avoid the life loss. A dead tower still
   *  banks its pocket's territory/bonus, so it stays a valid candidate; this flag
   *  just keeps the survival accounting honest. */
  alive: boolean;
  /** Does enclosing this tower clear the "no alive tower enclosed → lose a life"
   *  check at THIS round's finalize? True when the tower is alive, OR it's dead
   *  but the player holds Restoration Crew (which revives one enclosed dead tower
   *  immediately, before the life check). A freshly-dead tower WITHOUT that
   *  upgrade only revives at the end of the NEXT build, so sealing it this round
   *  still costs a life — the footgun this flag surfaces. Conservative on purpose:
   *  it does NOT credit the delayed pending-revive (a dead tower enclosed the
   *  PREVIOUS build), so it never reads "safe" off a not-yet-revived tower. The
   *  honest, finalize-accurate survival gate (which DOES credit pending) is the
   *  per-player `me.survivesRoundEnd`; this per-candidate flag is the conservative
   *  "which tower should I seal to be sure" companion. */
  satisfiesSurvival: boolean;
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
  /** Min-cut tiles a grunt is FORECAST to sit on by the time this seal would
   *  complete — the pre-emption signal the snapshot `blockers` miss. Computed by
   *  rolling the REAL `moveGrunts` model forward `estSeconds` ticks (grunts move
   *  1 tile/sec) with walls held fixed, then keeping the tiles a grunt occupies
   *  at the seal-completion tick. Catches BOTH facets that bit seed 37: a free
   *  tile a grunt is converging on, AND a `grunt-mobile` tile that won't actually
   *  clear (the optimistic soft-block that became a permanent box). `etaSeconds`
   *  is the first second a grunt lands on it. Empty when no grunt is on a
   *  collision course. Advisory only — does NOT change `feasible`/`blockers`; it
   *  says "seal these FIRST, reroute the cut, or clear them in battle." */
  driftTiles: { row: number; col: number; etaSeconds: number }[];
  /** BUILDABLE tiles where placing ONE wall right now would enclose this tower —
   *  the structural answer to "how do I close this?", computed by test-placing a
   *  wall and re-running the ENGINE's own 8-connected outside-flood
   *  (`computeOutside`), never a reimplementation. `kind: "gap"` is a tile on the
   *  min-cut (an orthogonal boundary opening); `kind: "inner-corner"` is a tile
   *  the min-cut MISSES — an interior/grass tile whose wall blocks an 8-dir
   *  DIAGONAL leak through a corner (the (12,25)-seals-around-boxed-(13,26) trick).
   *  Only the placeable ones are listed, so when the min-cut gap is grunt-boxed
   *  this surfaces the open alternate that still seals. Non-empty only when the
   *  pocket is ~1 tile from closing; empty when many gaps remain (no single-tile
   *  seal) or every seal tile is currently blocked. */
  sealTiles: { row: number; col: number; kind: "gap" | "inner-corner" }[];
}

/** A productive extension for a loose wall end: place at `next` to grow the stub
 *  at `from` toward `toward` — the nearest un-closed enclosure gap. The actionable
 *  flip-side of a fragile stub: rather than erode, extend it into the cut. */
export interface WallExtension {
  /** The loose wall end (a fragile, ≤1-neighbour tile) this hint extends. */
  from: { row: number; col: number };
  /** The buildable tile to place next — one step from `from` toward `toward`. */
  next: { row: number; col: number };
  /** The nearest un-closed enclosure gap (min-cut tile) the stub heads for. */
  toward: { row: number; col: number };
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
  /** What this mode DOES — the registry `description` (sourced from
   *  CANNON_MODE_POOL so it can't drift). Surfaced at the placement decision
   *  point so the agent weighs ROLE, not just slot COST: e.g. a balloon reads as
   *  "captures enemy cannons", not just a pricier normal. */
  role: string;
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
   *  interior). A ring-adjacent cannon goes INERT the moment that wall is
   *  breached and re-arms only at reseal — recoverable, but a deep-interior
   *  cannon (0) stays armed THROUGH a breach. 0 = buffered interior (best); ≥1
   *  = ring-adjacent (fine, just inert-on-breach). This is the arm-through-breach
   *  preference, NOT a hazard — see `routable` for the real risk. */
  wallLineSides: number;
  /** Whether the castle can still be walled AROUND this footprint after a
   *  breach. Computed by the engine's own min-cut (`findEnclosureCut`) on bare
   *  terrain with the cannon injected as an obstacle: `true` = a re-seal ring
   *  exists that routes around it (safe — the centred-tower rectangle case is
   *  always true); `false` = the footprint pinches the wall route so a re-seal
   *  would orphan a gap → the castle can become UNSEALABLE (the genuine hazard,
   *  only in tight spaces / against the edge). Routable spots sort first. */
  routable: boolean;
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

/** A dense pack of grunts — a connected blob that contains at least one full 2×2
 *  block of grunts. Two reads of the same signal:
 *  - In YOUR zone (`mine`): an enclose-kill candidate. Walling a ring AROUND the
 *    blob traps it inside your territory; the enclosed-kill clears every grunt in
 *    it AND banks the seal in one move — do it BEFORE they reach a chokepoint, not
 *    after they're plugging it (then only `cull` frees you).
 *  - In an OPPONENT's zone: a weakness read. Their reseal / towers there are under
 *    grunt pressure, so a `breach`/deny on that side compounds with the grunts. */
export interface GruntCluster {
  /** Bounding box of the connected grunt blob (the 2×2 block plus anything
   *  4-connected to it). */
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
  /** Grunts in the blob. */
  count: number;
  /** River zone the blob sits in. */
  zone: number;
  /** Slot whose castle owns that zone, or null for a neutral zone. */
  owner: number | null;
  /** Display name of the owner (null for a neutral zone). */
  ownerName: string | null;
  /** True when this is YOUR zone — the defensive enclose-kill framing. */
  mine: boolean;
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
  /** Can a cannon actually LAND a shot on this grunt right now? False when a
   *  taller camera-near obstacle (a wall or alive tower on the tile one row
   *  toward the camera) visually occludes it under the battle tilt — the same
   *  aim-occlusion rule a human/the default AI obeys, so `cull` skips it rather
   *  than whiffing a volley on the cover in front. The grunt still appears on
   *  the board; it just isn't a valid target until the occluder clears. */
  hittable: boolean;
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

/** One upgrade a player holds in force this round (modern mode). `stacks` > 1
 *  when the same upgrade was drafted more than once. */
export interface ActiveUpgrade {
  id: string;
  label: string;
  description: string;
  stacks: number;
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
  /** Severity-ranked verdict digest, derived from the detailed sections below
   *  (survival, bag-lock, cannon routability, exposed grunts, fat, headroom). The
   *  detailed sections stay; this is the "read this FIRST" header so the one line
   *  that matters isn't buried among always-on context. Omitted when nothing is
   *  flagged. Rendered at the top, right after STANDINGS. */
  alerts?: string[];
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
    /** How many of your towers are BOTH alive AND currently enclosed. A factual
     *  count — but it is NOT the survival gate on its own: finalize revives
     *  pending / Restoration-Crew dead towers first, so a `0` here can still
     *  survive. Use `survivesRoundEnd` to decide whether passing costs a life. */
    aliveEnclosedTowers: number;
    /** WOULD you keep your life if the round finalized right now? Mirrors the
     *  engine (revive-then-check): true when an alive enclosed tower exists, OR a
     *  dead enclosed tower would revive at finalize (pending-revive, or you hold
     *  Restoration Crew). `false` during WALL_BUILD = finalize like this and you
     *  LOSE A LIFE + your whole zone resets; seal a survival-clearing tower
     *  first. This is the honest survival signal (the old `aliveEnclosedTowers ===
     *  0` gate false-alarmed while Restoration Crew was held). */
    survivesRoundEnd: boolean;
    /** WALL_BUILD only: your CURRENT piece has ZERO legal placements anywhere in
     *  your zone. The bag advances ONLY by placing (pass does NOT cycle it), so
     *  this is a hard deadlock — you can build nothing this phase. If
     *  `survivesRoundEnd` is also false you'll lose a life when the clock runs
     *  out. Caused by a near-sealed castle whose only gaps need a different piece
     *  shape/size than the one dealt. `false` outside WALL_BUILD. */
    bagLocked: boolean;
    /** WALL_BUILD only: bag-lock tightness. `bagLocked` reports the terminal
     *  deadlock for the CURRENT piece; `dumpCapacity` quantifies how packed the
     *  castle is by sweeping the WHOLE round draw pool — `placeable` of `pool`
     *  distinct shapes (this round's draw set, derived from `bag.round` +
     *  `bag.smallPieces`, scalar flags — NOT the queued shapes, so no asymmetric
     *  bag peek) still have at least one legal placement; `largestBlocked` names
     *  the biggest shape with none (null if all fit). The generic-dump pocket
     *  that admits ANY piece is 3×3 (the `+` needs a 3×3 bbox). CAVEAT: with an
     *  atomic build_out this is effectively BINARY — it reads full (placeable ==
     *  pool) until the packing call locks it, with no tight-but-placeable window.
     *  It pre-warns only between INCREMENTAL place_piece calls; otherwise it's a
     *  diagnosis + next-build lesson, not a forecast. `null` outside WALL_BUILD
     *  or before a bag exists. */
    dumpCapacity: {
      pool: number;
      placeable: number;
      largestBlocked: string | null;
    } | null;
    /** Home tower top-left (the centre of your castle), or null pre-selection. */
    homeTower: { row: number; col: number } | null;
    currentPiece: string | null;
    cannons: number;
    /** Cannon slots: how many you've used and your cap this round. Each cannon
     *  costs slots by footprint (normal 1, balloon/rampart 3, super 4), so a
     *  cannon COUNT rarely equals slots USED — `byMode` reconciles the two
     *  (its `slots` sum to `used`), so "can I afford another super?" is readable
     *  without knowing the per-mode costs. Counts alive cannons only. */
    cannonSlots: {
      used: number;
      max: number;
      byMode: { mode: CannonMode; count: number; slots: number }[];
    };
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
    /** Cannons an opponent's balloon has CAPTURED from you this battle — they
     *  fire for the captor, not you, so they silently drop out of your own
     *  bombard/breach/pit. A balloon (launched in the cannon→battle gap) takes a
     *  normal gun with one hit, a super with TWO. Empty in the normal case;
     *  non-empty means your effective battery is smaller than it looks — and a
     *  captured super means `pit_strike` has no gun to plant pits with. */
    capturedCannons: {
      row: number;
      col: number;
      mode: CannonMode;
      /** Name of the opponent now firing this cannon. */
      by: string;
    }[];
    /** Enemy cannons YOUR balloon has CAPTURED this battle — they now fire for
     *  YOU (the mirror of `capturedCannons`). Capture resolves at the
     *  cannon→battle transition, so it's settled before any battle action; the
     *  seized gun fires inside your bombard/cull automatically. Empty in the
     *  normal case; non-empty means your effective battery is BIGGER than your
     *  placed count — and a captured enemy super is a free pit_strike gun.
     *  Surfaced so a successful balloon is visible (placing one and seeing this
     *  still empty next battle means it found no enclosed enemy gun to take). */
    capturedByMe: {
      row: number;
      col: number;
      mode: CannonMode;
      /** Name of the opponent you took this cannon from. */
      from: string;
    }[];
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
    /** Build headroom for your castle: how much enclosable land remains
     *  unconsumed, plus the largest empty buildable rectangle still open in your
     *  zone (the dump-pocket gauge). The MEASURED form of "a center tower has
     *  plenty of free land, an edge/river tower doesn't" — a per-castle quantity,
     *  not a center-vs-edge rule. Drives the cannon-count call: a fat `openPocket`
     *  (min side ≥ 3) means you can spend slots on cannons and still keep a
     *  bag-lock-proof 3×3 dump; a thin one means place fewer and reserve the
     *  pocket. `null` before a castle exists. */
    headroom: {
      /** Static enclosable land in your zone — the per-build territory ceiling. */
      zoneLand: number;
      /** Land already consumed by your interior + walls. */
      used: number;
      /** zoneLand − used — your remaining elbow room. */
      free: number;
      /** Largest all-open buildable rectangle (height × width) in your zone.
       *  `min(h, w) >= 3` ⇒ a 3×3 dump pocket (admits any piece) still fits. */
      openPocket: { h: number; w: number };
    } | null;
    enclosedTowers: number;
    homeTowerEnclosed: boolean;
    /** MODERN only: the upgrades you have in force THIS round (the picks you
     *  drafted in earlier UPGRADE_PICK phases, reset each round in
     *  prepareNextRound). Each lists what it does so you can plan around it —
     *  e.g. master_builder = +5s exclusive build (opponents locked out),
     *  reinforced_walls = your walls take 2 hits this battle. Omitted in classic
     *  / when you hold none. */
    activeUpgrades?: ActiveUpgrade[];
  };
  opponents: {
    slot: number;
    lives: number;
    score: number;
    eliminated: boolean;
    walls: number;
    /** Opponent home tower top-left — a visible target to aim at in battle. */
    homeTower: { row: number; col: number } | null;
    /** MODERN only: the upgrades this opponent has in force this round (the
     *  upgrade screen is shared, so their picks are visible to you). Lets you
     *  read e.g. a rival's rapid_fire (2× ball speed) or reinforced_walls
     *  (their walls need 2 hits — bombard/breach will score slower). Omitted in
     *  classic / when they hold none. */
    activeUpgrades?: ActiveUpgrade[];
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
   *  full min-cut plan comes from the `enclosure_plan` tool. */
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
  /** WALL_BUILD only: MY wall tiles with ≤1 orthogonal wall-neighbour — the loose
   *  ends of my wall network, exactly what the round-end sweep (`sweepIsolatedWalls`)
   *  deletes. HARMLESS to a sealed castle: a wall on a closed ring always keeps ≥2
   *  neighbours, so the sweep can only ever remove dangling stubs — it can never
   *  open an enclosure. So these only matter for a cross-round PRE-CLAIM line (a
   *  `build_path` segment you haven't closed yet): its open ends erode ~1 tile/round
   *  until anchored. On a finished pocket they're free real estate — a fine place to
   *  dump a dud piece. Omitted when there's nothing. */
  fragileWalls?: { row: number; col: number }[];
  /** WALL_BUILD only: MY interior wall tiles — every 8-dir neighbour is my own wall
   *  or interior, so NONE faces outside. These are "fat" (thickness past a single
   *  shell), but in CLASSIC a placed wall can NEVER be removed (fat walls keep ≥2
   *  neighbours, so even the round-end sweep skips them; `demolition`/`erosion` are
   *  modern-only) — so every entry here is SUNK, not a to-do, and not a real
   *  defensive liability (a sealed ring is sweep-proof regardless). They're the
   *  former perimeters of rings you expanded past, plus piece-overflow — the price
   *  of accumulation. The only AVOIDABLE fat is the fat not yet placed: send new
   *  pieces to the frontier (build_toward / wallExtensions), never into interior.
   *  Surfaced as a count-only signal that you've been over-building, not a fix
   *  list. Omitted when there's none. NOTE: a placed wall can't be removed during
   *  WALL_BUILD, but it CAN be shot out by a cannonball in BATTLE — `declutter()`
   *  fires your own battery at the non-load-bearing fat to reopen a build pocket
   *  (see `fatClearable`). That's the proactive escape from a looming bag-lock. */
  fatWalls?: { row: number; col: number }[];
  /** WALL_BUILD only: the standing compactness read — `interior` enclosed
   *  scoring tiles, `fat` sunk interior walls, `fatPer100` = fat per 100 interior
   *  (the trend number). This is the PRE-COMMIT lever: in classic placed fat can't
   *  be removed, so the only avoidable fat is fat not yet placed. Check this BEFORE
   *  reaching for `build_out` — a climbing `fatPer100` round-over-round means you're
   *  expanding past old shells; prefer a compact `build_toward(<nearest>)` instead.
   *  The expanding builders (`build_out`/`build_region`) report the per-call delta
   *  they cause, so the cost of each expansion is visible at the moment you pay it.
   *  Omitted outside WALL_BUILD or before any interior exists. */
  compactness?: { interior: number; fat: number; fatPer100: number };
  /** BATTLE only: how many of my redundant inner ("fat") walls a cannonball can
   *  actually reach right now (non-load-bearing AND not tower-occluded) — i.e. how
   *  many interior tiles `declutter()` could free for the next build. Surfaced as
   *  the BATTLE-phase mirror of `fatWalls`: when this is high it's the window to
   *  pre-empt a bag-lock by shooting your own fat out before you pack into a
   *  single-tile seam. Omitted outside BATTLE or when there's no reachable fat. */
  fatClearable?: number;
  /** WALL_BUILD: for each loose wall end that sits near an un-closed enclosure gap,
   *  the next tile to place to EXTEND it toward closing — `from` the stub, `next`
   *  the buildable step, `toward` the gap it heads for. The constructive read of a
   *  fragile stub: don't anchor it in place, grow it into the cut. EMPTY on a sealed
   *  castle (no open gaps), so a finished castle's stubs are left alone. Omitted
   *  when there's nothing to extend toward. */
  wallExtensions?: WallExtension[];
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
  /** Dense grunt clusters (each contains ≥ a full 2×2 block), densest first.
   *  In YOUR zone they're enclose-kill candidates; in an opponent's they flag a
   *  grunt-pressure weakness to exploit. WALL_BUILD + BATTLE only; omitted when
   *  none. */
  gruntClusters?: GruntCluster[];
  /** BATTLE: the best enemy wall tiles to plant a super-cannon PIT on, ranked by
   *  denial value (un-reroutable chokepoints first). Feed these to
   *  `pitStrike(slot, targets)`. Omitted outside BATTLE / when you have no super. */
  pitTargets?: PitTarget[];
  /** BATTLE: a CONDITIONAL nudge to SNIPE enemy cannons with `fire(row,col)`
   *  instead of the default bombard — surfaced ONLY when it actually beats
   *  spreading fire over walls: you hold Salvage (each enemy cannon you destroy
   *  banks you +1 slot, max +2), OR an opponent fields a targetable SUPER / Mortar
   *  gun (a disproportionate threat — it 3×3-splashes + pit-strikes you). A
   *  cannonball on a cannon's tile damages it (1 HP, 2 for a super ball); kill it
   *  and the wreck leaves DEBRIS that blocks their rebuild. There is NO one-call
   *  aimer — `fire` each tile, ~`hitsToKill` normal hits per gun, reload-paced.
   *  Omitted otherwise, because plain bombard out-scores it (don't snipe by
   *  default). */
  cannonSnipe?: {
    slot: number;
    name: string;
    /** Why it's worth a shot right now (Salvage held / their super gun). */
    reason: string;
    /** Normal-ball hits to destroy a fresh gun (= cannonMaxHp; a super ball
     *  deals 2/hit, so halve it when firing supers). */
    hitsToKill: number;
    /** Targetable enemy cannon top-lefts (alive, not balloon, not shielded this
     *  battle), high-value guns (`heavy`: super/Mortar) first. */
    tiles: { row: number; col: number; heavy: boolean }[];
  };
  /** CANNON_PLACE: a nudge to spend SPARE slots on a BALLOON — a near-free steal.
   *  Surfaced whenever a balloon is affordable (≥1 legal 2×2 spot fits the slots
   *  you have left) AND any enclosed enemy gun is still capturable. A balloon
   *  auto-seizes the opponent's MOST DANGEROUS enclosed cannon at battle start
   *  (`gun`), fires it FOR you that battle, denies it to them, then is spent
   *  (removed, slots free next round). On slots you'd otherwise leave idle it's
   *  pure upside — even seizing a plain gun is a +1/−1 swing — so this does NOT
   *  gate on the enemy holding a super (unlike `cannonSnipe`). The one catch is in
   *  the math: a SUPER needs `balloonsToSeize` = 2 balloon hits (a normal/Mortar
   *  needs 1), and hits PERSIST across battles — so if you can only afford 1 vs a
   *  super, that balloon banks 1/2 (captures nothing THIS battle; finish it next
   *  round). Compare `balloonsToSeize` to `balloonsAffordable` to know whether you
   *  can capture `gun` now. Omitted when no balloon is affordable or no enclosed
   *  enemy gun is capturable. */
  balloonOpportunity?: {
    /** Opponent slot the balloon would target (most dangerous enclosed gun). */
    slot: number;
    name: string;
    /** The gun the balloon will fly at — the engine's actual most-dangerous pick
     *  (super preferred, then HP), so you know what one balloon does. */
    gun: { row: number; col: number; mode: CannonMode };
    /** Balloon HITS still needed to seize `gun` (super = 2, normal/Mortar = 1;
     *  minus any hits already banked from prior rounds). 1 = one balloon captures
     *  it this battle. */
    balloonsToSeize: number;
    /** How many balloons you can place right now (floor(freeSlots / 3-slot cost)).
     *  ≥ `balloonsToSeize` means you can capture `gun` outright this round. */
    balloonsAffordable: number;
    /** A legal 2×2 balloon top-left you can place at right now. */
    spot: { row: number; col: number };
  };
  /** MODERN only: the environmental modifier in force this round (wildfire,
   *  frozen river, …), or null/omitted in classic and when none rolled. Passive
   *  — you make no decision about it, but it changes the board (e.g. frozen river
   *  freezes water you can build over; wildfire scars grass). Surfaced from
   *  MODIFIER_REVEAL through the round so battle/build plans can account for it. */
  activeModifier?: { id: string; label: string } | null;
  /** MODERN, BATTLE only (Supply Ship modifier active): the neutral cargo ships
   *  sailing the river RIGHT NOW — the same hulls a human sees on the water, so
   *  fair game to surface (the bonus each carries stays HIDDEN until you sink it).
   *  Each has 2 HP; land a cannonball within ~1 tile of a hull and SINK it (2
   *  hits) to win the SHOOTER a hidden one-round bonus (an extra cannon, +5s
   *  build, a free mortar shot, or a small-pieces bias). Ships move ~0.9 tiles/s
   *  along the river, so lead them: aim a `fire(row,col)` AHEAD of the hull by
   *  roughly (ball-flight-time × `velTilesPerSec`). Any ship still afloat
   *  auto-sinks with ~1.5s left on the battle clock, awarding nobody — the AI
   *  opponents actively hunt them, so an unclaimed ship is a bonus handed to a
   *  rival or wasted. `sinking: true` = already going down, no longer targetable.
   *  Omitted outside BATTLE / when the Supply Ship modifier isn't active. */
  supplyShips?: {
    id: number;
    /** Sub-tile hull centre (floats, may sit on a river tile between zones). */
    row: number;
    col: number;
    /** Remaining hit points: 2 = fresh, 1 = damaged (one more hit sinks it). */
    hp: number;
    /** True once sunk/sinking — ignore it, the bonus (if any) is already settled. */
    sinking: boolean;
    /** River velocity in tiles/sec — multiply by your shot's flight time to lead. */
    velTilesPerSec: { dCol: number; dRow: number };
  }[];
  /** MODERN only: true when a player owns Ceasefire, which skips the WHOLE
   *  battle phase this round for EVERYONE (it's global). Surfaced in CANNON_PLACE
   *  as a heads-up — end_cannon goes straight to the next phase, so there is no
   *  attack/cull/fire turn this round. Omitted when no battle skip is in force. */
  battleSkipped?: boolean;
  /** MODERN, UPGRADE_PICK only: your three upgrade offers, in card order. Pick
   *  one with act { kind: 'pick-upgrade', cardIdx } where cardIdx is 0, 1, or 2
   *  (the index into THIS list — don't reorder it). Omitted outside the phase. */
  upgradeOffers?: {
    cardIdx: number;
    id: string;
    label: string;
    description: string;
  }[];
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
  observe(view?: ViewOptions): Observation;
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
  /** WALL_BUILD, survival escape: ONE call to avoid the "no alive tower enclosed
   *  → lose a life + zone reset" round-end penalty. Picks the cheapest tower whose
   *  seal actually CLEARS the life check (alive, or dead-but-Restoration-Crew;
   *  tie-broken by bonus) and drives `build` at it — sealing a tight compartment
   *  around it via the min-cut even when the whole outer ring is too big to close
   *  in time. No coordinates, no tower pick. When no survival-clearing tower is
   *  reachable this build it does nothing and says why (the life is unavoidable).
   *  The zero-jargon front door for the ☠ SURVIVAL warning. Honours `budget`. */
  sealSurvivor(budget?: BuildBudget): Observation;
  /** WALL_BUILD: enclose EVERYTHING reachable in one call — the greedy form of
   *  `build`. Seals your home, then keeps enclosing the next best feasible tower
   *  (home-first, then cheapest / most-bonus) until no full enclosure fits the
   *  time left. With time still to spare it then PRE-CLAIMS: it banks partial
   *  ring progress on the cheapest not-yet-reachable tower so next round's
   *  enclosure is cheaper — so spare build time is never idled away (idle build
   *  scores 0). One call instead of chaining build({towerIdx}) per tower and
   *  budgeting time by hand. Honours `budget` (maxSeconds / maxPieces). */
  buildOut(budget?: BuildBudget): Observation;
  /** WALL_BUILD: enclose an arbitrary FOOTPRINT by position — the generalisation
   *  of `build` past towers. Walls the min-cut ring around `rect` (inclusive
   *  top/bottom/left/right), so any grunts inside get enclosed-killed and the
   *  ground is claimed. Use it to ring a grunt cluster (see gruntClusters), grab
   *  a bonus square, or pre-claim open ground. Caveats: grunts MOVE during build
   *  (a cluster footprint goes stale — commit promptly), and the rect must have a
   *  finite cut (no leak to the map edge through water). Honours `budget`. */
  buildRegion(
    rect: { top: number; bottom: number; left: number; right: number },
    budget?: BuildBudget,
  ): Observation;
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
  /** BATTLE: fire over `slot`'s walls, pacing reload, for the rest of the battle
   *  (or `quanta` action-quanta). `mode` picks the aim (default `spread`):
   *  `spread` hits the walls NEAREST my battery — maximises raw wall count
   *  destroyed (points + general tax); `choke` concentrates normal fire on their
   *  load-bearing outer-ring walls ranked by un-reroutability (the same choke
   *  ranking `pit_strike` plants pits on) — fewer walls but each costlier to
   *  patch, so a HEAVIER wall-tax than spread. It does NOT de-enclose: like
   *  bombard, the AI re-routes its ring and re-encloses next build (~90%); choke
   *  just makes the re-route pricier (no pit — that stays super-only). One call
   *  ≈ a whole battle of fire/pass. */
  bombard(
    slot: number,
    quanta?: number,
    mode?: "spread" | "choke",
  ): Observation;
  /** BATTLE: drill the engine's MIN-CUT to de-enclose `slot`'s territory — the
   *  fewest walls whose removal lets the 8-dir flood reach a defended interior.
   *  `towerIdx` cuts exactly that tower's ring; omitted, the whole-castle min-cut
   *  opens every intact tower-ring it can afford (tower-rings first, cheapest
   *  first). Denies that pocket's territory + bonus squares next build, where
   *  bombard just spreads damage they reseal. One call ≈ a whole battle. */
  breach(slot: number, towerIdx?: number): Observation;
  /** BATTLE: drive the whole battle like bombard, but AIM your super cannon(s) at
   *  `targets` (enemy wall tiles) to plant burning PITS there while normal cannons
   *  spread-chip `slot`'s walls. A super ball only pits a tile it HITS AS A WALL,
   *  and the pit blocks rebuilding for BURNING_PIT_DURATION rounds — so a pit on a
   *  load-bearing wall TAXES their reseal (forces a costlier re-route, denies a
   *  sliver of territory) more than a random bombard hit. It does NOT reliably
   *  deny the reseal: the AI re-encloses ~90% of pit-targeted towers next build by
   *  routing the ring around the pit (only a true geographic pinch — a 1-wide neck
   *  walled by water/edge — actually blocks it, and those are rare). Omit
   *  `targets` to use the ranked `pitTargets` for that slot. Normals + supers
   *  still fire only while the battle is live and paced to reload — same fairness
   *  as bombard. */
  pitStrike(
    slot: number,
    targets?: { row: number; col: number }[],
  ): Observation;
  /** BATTLE: the DEFENSIVE counterpart to bombard/breach — aim every ready
   *  cannon at the GRUNTS menacing your own towers (see `observation.threats`)
   *  instead of an opponent. Grunts are frozen during BATTLE, so the swarm that
   *  would box your reseal next build is killable RIGHT NOW (one shot each, no
   *  self-wall damage — they stand on grass). Fires closest-threat first, stops
   *  when the zone is clear (bombard the leftover battle) or at `quanta`. Same
   *  live-gated, reload-paced fairness as bombard. The answer to a grunt-lock. */
  cull(quanta?: number): Observation;
  /** BATTLE: the STRUCTURAL counterpart to cull — fire my OWN battery at my
   *  redundant inner ("fat") walls to clear a build pocket. Cull clears the
   *  grunts that box a reseal; declutter clears the walls that box the piece bag.
   *  Only non-load-bearing fat is targeted — every such wall has all 8 neighbours
   *  wall/interior, so removing it can NEVER connect interior to outside (the
   *  enclosure is preserved by construction). Aim-occluded fat (behind a tower) is
   *  skipped, and the clearance is contiguous so it opens ONE usable 2×2+ dump
   *  pocket rather than scattered 1-tile holes. Scores NOTHING (own walls) — it is
   *  a tempo spend that trades battle offense for the build flexibility that
   *  prevents a bag-lock life-loss. MUST be proactive: walls are only removable by
   *  cannonball (battle), but the lock manifests next build, so clear the fat the
   *  battle BEFORE you'd otherwise pack into a single-tile seam. Stops when the
   *  reachable fat is gone (bombard the leftover battle) or at `quanta`. */
  declutter(quanta?: number): Observation;
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
  /** WALL_BUILD: every legal placement of the current piece whose footprint
   *  touches `zone` (default = wall bbox ± a margin), annotated with
   *  `sealsTower` / `coversDrift` / `fillsGap` / `touchingWalls`. The exhaustive
   *  alternative to guess-and-check `check`. */
  placements(
    zone: {
      minRow?: number;
      maxRow?: number;
      minCol?: number;
      maxCol?: number;
    } | null,
  ): ZonePlacements;
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
 *  `enclosure_plan` tool / `enclosurePlan()` on demand. */
const ENCLOSURE_TILE_SAMPLE = 8;
/** How many of an opponent's wall tiles to surface as aim-assist in BATTLE. */
const BATTLE_TARGET_SAMPLE = 10;
/** How many ranked pit targets to surface per opponent in BATTLE. */
const PIT_TARGETS_PER_OPPONENT = 3;
/** How many enemy cannon tiles to surface in the conditional snipe nudge. */
const CANNON_SNIPE_TILES = 4;
/** A grunt cluster (`gruntClustersFor`) must pack at least this many grunts in one
 *  4-connected blob to be worth flagging as enclose-killable / a weakness. */
const CLUSTER_MIN_GRUNTS = 4;
/** ...AND its bounding box may span at most this many tiles on each axis, so only
 *  COMPACT knots (one ring traps them) qualify — a swarm strung down a corridor is
 *  one component but fails this and isn't mis-flagged as enclosable. */
const CLUSTER_MAX_SPAN = 3;
/** Chebyshev radius around an opponent tower that counts as its guarding ring —
 *  the band a `breach` concentrates fire on to de-enclose that pocket. */
const BREACH_RADIUS = 6;
/** Max wall tiles a single `breach` min-cut chain will plan — the `cap` handed
 *  to `findMinBreach` / `findTowerBreach`. Generous (longer than the AI's 8) so
 *  even a fat 2–3-thick ring's diagonal staircase fits; per-volley fire stays
 *  reload-gated, so a high cap never lets the agent out-shoot its cannons. */
const BREACH_MAX_TILES = 12;
/** How many placements to surface per cannon mode in CANNON_PLACE. */
const CANNON_SUGGESTION_PER_MODE = 3;
/** A loose wall end gets an extension hint only when an un-closed enclosure gap
 *  lies within this Manhattan radius — past it the stub isn't really heading
 *  toward closing anything, so silence beats a misleading arrow. */
const WALL_EXTEND_RADIUS = 8;
/** Cap on extension hints surfaced, so a ragged frontier can't bloat the line. */
const MAX_WALL_EXTENSIONS = 6;
/** Tile margin around the agent's zone in the cropped board — kept in one place
 *  so the rendered crop and the reported `boardBounds` can't drift apart. */
const BOARD_CROP_PAD = 2;
/** Cap on the grunt-drift forecast depth (build-seconds = grunt-ticks). The
 *  build phase is ~25s, so 30 covers it; the cap just bounds the worst-case
 *  `moveGrunts` replay cost (depth × grunt-count). */
const GRUNT_DRIFT_MAX_HORIZON = 30;
/** The seal-finder only runs on a pocket within this many min-cut tiles of
 *  closing — a single placed wall can only seal a near-complete ring, so beyond
 *  this there's no single-tile seal to find and the scan would be wasted. */
const SEAL_FINDER_MAX_GAPS = 3;
/** Default zone for a no-arg `list_placements` query: the wall bounding box grown
 *  by this many tiles (the buildable frontier). */
const PLACEMENT_ZONE_PAD = 2;
/** Max placements returned by a `list_placements` query (best-first); `total` still
 *  reports the full count so truncation is visible. */
const MAX_ZONE_PLACEMENTS = 24;
/** Largest piece extent in tiles — the anchor-scan margin so a placement whose
 *  anchor sits just outside the zone but whose tiles reach into it is still
 *  enumerated. */
const MAX_PIECE_EXTENT = 3;
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
    mode: opts.mode ?? "classic",
    rounds: opts.rounds ?? 3,
    renderer: "ascii",
    controllerFactory,
    ...(opts.forceModifier
      ? { testHooks: { forceModifier: opts.forceModifier } }
      : {}),
  });

  const gameOver = (): boolean => sc.mode() === Mode.STOPPED;

  /** Memoised count of my zone's land tiles — static for the match (zones +
   *  water never change). -1 = not yet computed. */
  let zoneLandCache = -1;

  /** Idle-build pass guard: set once the agent has been warned that passing this
   *  WALL_BUILD would abandon a still-enclosable tower (idle build scores 0). The
   *  next pass then goes through, so the warning never traps a deliberate skip.
   *  Cleared on any build placement and on leaving WALL_BUILD. */
  let idleBuildPassWarned = false;

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
    // Track `fat` (piece tiles that would land redundant — every 8-neighbour
    // already owned) so the dud-redirect fallback that consumes [0] stops dumping
    // pieces into fat walls; stripped before returning the public shape.
    const out: (BuildSuggestion & { fat: number })[] = [];
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
          const pieceKeys = new Set(tiles.map(([r, c]) => packTile(r, c)));
          const isWall = (tileRow: number, tileCol: number): boolean =>
            inBounds(tileRow, tileCol) &&
            player.walls.has(packTile(tileRow, tileCol));
          const isOwned = (tileRow: number, tileCol: number): boolean => {
            if (!inBounds(tileRow, tileCol)) return false;
            const okey = packTile(tileRow, tileCol);
            return (
              player.walls.has(okey) ||
              player.interior.has(okey) ||
              pieceKeys.has(okey)
            );
          };
          let touching = 0;
          let fillsGap = 0;
          let fat = 0;
          for (const [tileRow, tileCol] of tiles) {
            const up = isWall(tileRow - 1, tileCol);
            const down = isWall(tileRow + 1, tileCol);
            const left = isWall(tileRow, tileCol - 1);
            const right = isWall(tileRow, tileCol + 1);
            touching += [up, down, left, right].filter(Boolean).length;
            if ((up && down) || (left && right)) fillsGap++;
            if (
              DIRS_8.every(([er, ec]) => isOwned(tileRow + er, tileCol + ec))
            ) {
              fat++;
            }
          }
          out.push({
            row,
            col,
            rotation,
            fillsGap,
            touchingWalls: touching,
            fat,
          });
        }
      }
    }
    // Plug holes first, then prefer the LEAST-fat placement, then ring-adjacency —
    // so a dud redirected here lands on the frontier, not packed into a fat wall.
    out.sort(
      (a, b) =>
        b.fillsGap - a.fillsGap ||
        a.fat - b.fat ||
        b.touchingWalls - a.touchingWalls,
    );
    return out.slice(0, 6).map(({ fat: _fat, ...rest }) => rest);
  }

  /** Score one placement's footprint: wall-adjacency (`touchingWalls`),
   *  1-wide-hole plugs (`fillsGap`), and the live-signal hits — `sealsTower` (a
   *  tile that closes a pocket) and `coversDrift` (a converging-grunt tile). */
  function annotateBuildPlacement(
    tiles: readonly (readonly [number, number])[],
    isWall: (row: number, col: number) => boolean,
    sealOf: ReadonlyMap<number, string>,
    driftSet: ReadonlySet<number>,
  ): {
    fillsGap: number;
    touchingWalls: number;
    sealsTower?: string;
    coversDrift: boolean;
  } {
    let touching = 0;
    let fillsGap = 0;
    let sealsTower: string | undefined;
    let coversDrift = false;
    for (const [tileRow, tileCol] of tiles) {
      const up = isWall(tileRow - 1, tileCol);
      const down = isWall(tileRow + 1, tileCol);
      const left = isWall(tileRow, tileCol - 1);
      const right = isWall(tileRow, tileCol + 1);
      touching += [up, down, left, right].filter(Boolean).length;
      if ((up && down) || (left && right)) fillsGap++;
      const tileKey = packTile(tileRow, tileCol);
      const seals = sealOf.get(tileKey);
      if (seals !== undefined) sealsTower = seals;
      if (driftSet.has(tileKey)) coversDrift = true;
    }
    return {
      fillsGap,
      touchingWalls: touching,
      coversDrift,
      ...(sealsTower !== undefined ? { sealsTower } : {}),
    };
  }

  /** Rank zone placements: seals first (they close a pocket), then drift
   *  pre-empts, then the base fillsGap/touching tiebreaks. */
  function compareZonePlacements(a: ZonePlacement, b: ZonePlacement): number {
    return (
      Number(b.sealsTower !== undefined) - Number(a.sealsTower !== undefined) ||
      Number(b.coversDrift) - Number(a.coversDrift) ||
      b.fillsGap - a.fillsGap ||
      b.touchingWalls - a.touchingWalls
    );
  }

  /** Mirror of the engine's round-end survival check (phase-setup.ts
   *  `applyLifePenalties`, which runs AFTER build-system `reviveEnclosedTowers`):
   *  if the round finalized on the CURRENT board, would `player` keep its life?
   *  An ALIVE enclosed tower clears it — but so does a DEAD enclosed tower that
   *  finalize revives FIRST: one that's pending-revive (enclosed the previous
   *  build) or, while the player holds Restoration Crew, the one RC revives. The
   *  raw `aliveEnclosedTowers` count misses both revives, which is why the
   *  survival warning used to false-alarm "LOSE A LIFE" while Restoration Crew was
   *  active with a dead tower sealed (it finalized fine). */
  function survivesRoundEndLifeCheck(player: Player): boolean {
    const state = sc.state;
    const hasRestorationCrew = player.upgrades.has(UID.RESTORATION_CREW);
    for (const tower of player.enclosedTowers) {
      if (state.towerAlive[tower.index]) return true;
      // Dead enclosed tower: finalize revives it BEFORE the life check when it's
      // pending, or when Restoration Crew is held (revives one) — either clears
      // survival this round.
      if (hasRestorationCrew || state.towerPendingRevive.has(tower.index))
        return true;
    }
    return false;
  }

  /** WALL_BUILD bag-lock guard: does `player`'s CURRENT piece have ANY legal
   *  placement anywhere in its zone (all 4 rotations)? The bag advances ONLY by
   *  PLACING — `pass` never cycles the piece — so a piece with zero legal
   *  placements is a hard deadlock: nothing can be built this phase, and if no
   *  survival-clearing tower is already sealed the clock runs out into a life
   *  loss. Happens to a near-sealed fortress whose only gaps are 1-tile holes or
   *  the wrong chirality/size for the held piece (an `S` gap can't take an `SR`).
   *  Early-exits on the first legal spot, so it's cheap unless genuinely locked. */
  function shapeHasAnyPlacement(shape: PieceShape): boolean {
    const state = sc.state;
    for (let rotation = 0; rotation < 4; rotation++) {
      const offsets = rotatedOffsets(shape, rotation);
      for (let row = -MAX_PIECE_EXTENT; row < GRID_ROWS; row++) {
        for (let col = -MAX_PIECE_EXTENT; col < GRID_COLS; col++) {
          if (canPlacePiece(state, agentSlot, offsets, row, col)) return true;
        }
      }
    }
    return false;
  }

  function currentPieceHasAnyPlacement(player: Player): boolean {
    const piece = player.currentPiece;
    if (!piece) return true;
    return shapeHasAnyPlacement(piece);
  }

  /** Bag-lock tightness for WALL_BUILD. `currentPieceHasAnyPlacement` reports the
   *  terminal deadlock for the piece already dealt; this sweeps the WHOLE round
   *  draw pool (derived from `bag.round` + `bag.smallPieces` — scalar flags, never
   *  the queued shapes, so no asymmetric bag peek) and counts how many distinct
   *  shapes still have a legal home, with `largestBlocked` naming the biggest that
   *  doesn't. CAVEAT (measured): under an atomic build_out this is effectively
   *  binary — it stays full until the packing call locks it, so it diagnoses a
   *  lock (and teaches the next-build lesson) rather than forecasting one; the
   *  preview window exists only between incremental place_piece calls. */
  function dumpCapacityFor(
    player: Player,
  ): { pool: number; placeable: number; largestBlocked: string | null } | null {
    const bag = player.bag;
    if (sc.state.phase !== Phase.WALL_BUILD || !bag) return null;
    const pool = piecesInRoundPool(bag.round, bag.smallPieces);
    let placeable = 0;
    let largestBlocked: PieceShape | null = null;
    for (const shape of pool) {
      if (shapeHasAnyPlacement(shape)) {
        placeable++;
      } else if (
        !largestBlocked ||
        shape.offsets.length > largestBlocked.offsets.length
      ) {
        largestBlocked = shape;
      }
    }
    return {
      pool: pool.length,
      placeable,
      largestBlocked: largestBlocked?.name ?? null,
    };
  }

  /** Every legal placement of the current piece whose footprint touches `zone`
   *  (default = wall bbox ± PLACEMENT_ZONE_PAD), annotated with what it does:
   *  `sealsTower` (lands on a seal tile → closes that pocket), `coversDrift`
   *  (pre-empts a converging grunt), plus the `fillsGap`/`touchingWalls` of the
   *  base suggestions. The exhaustive answer that retires guess-and-check
   *  `check_placement` loops; reads the live seal/drift signals so "which
   *  placement closes this?" is one query. */
  function placementsInZone(
    zone: {
      minRow?: number;
      maxRow?: number;
      minCol?: number;
      maxCol?: number;
    } | null,
  ): ZonePlacements {
    const state = sc.state;
    const player = state.players[agentSlot]!;
    const piece = player.currentPiece;
    const bounds = wallBounds(player.walls);
    const fallback = bounds
      ? {
          minRow: bounds.minRow - PLACEMENT_ZONE_PAD,
          maxRow: bounds.maxRow + PLACEMENT_ZONE_PAD,
          minCol: bounds.minCol - PLACEMENT_ZONE_PAD,
          maxCol: bounds.maxCol + PLACEMENT_ZONE_PAD,
        }
      : { minRow: 0, maxRow: GRID_ROWS - 1, minCol: 0, maxCol: GRID_COLS - 1 };
    const rect = {
      minRow: Math.max(0, zone?.minRow ?? fallback.minRow),
      maxRow: Math.min(GRID_ROWS - 1, zone?.maxRow ?? fallback.maxRow),
      minCol: Math.max(0, zone?.minCol ?? fallback.minCol),
      maxCol: Math.min(GRID_COLS - 1, zone?.maxCol ?? fallback.maxCol),
    };
    if (!piece) {
      return { piece: null, zone: rect, total: 0, shown: 0, placements: [] };
    }
    // Gather the live seal/drift tiles to annotate against (one candidate pass).
    const sealOf = new Map<number, string>();
    const driftSet = new Set<number>();
    for (const candidate of enclosureCandidatesFor()) {
      const label = candidate.isHome ? "HOME" : `tower ${candidate.towerIdx}`;
      for (const seal of candidate.sealTiles) {
        sealOf.set(packTile(seal.row, seal.col), label);
      }
      for (const drift of candidate.driftTiles) {
        driftSet.add(packTile(drift.row, drift.col));
      }
    }
    const inZone = (tileRow: number, tileCol: number): boolean =>
      tileRow >= rect.minRow &&
      tileRow <= rect.maxRow &&
      tileCol >= rect.minCol &&
      tileCol <= rect.maxCol;
    const isWall = (tileRow: number, tileCol: number): boolean =>
      inBounds(tileRow, tileCol) &&
      player.walls.has(packTile(tileRow, tileCol));
    const seen = new Set<string>();
    const out: ZonePlacement[] = [];
    for (let rotation = 0; rotation < 4; rotation++) {
      const offsets = rotatedOffsets(piece, rotation);
      for (
        let row = rect.minRow - MAX_PIECE_EXTENT;
        row <= rect.maxRow;
        row++
      ) {
        for (
          let col = rect.minCol - MAX_PIECE_EXTENT;
          col <= rect.maxCol;
          col++
        ) {
          if (!canPlacePiece(state, agentSlot, offsets, row, col)) continue;
          const tiles = offsets.map(
            ([dr, dc]) => [row + dr, col + dc] as const,
          );
          if (!tiles.some(([r, c]) => inZone(r, c))) continue;
          const key = tiles
            .map(([r, c]) => `${r},${c}`)
            .sort()
            .join("|");
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            row,
            col,
            rotation,
            ...annotateBuildPlacement(tiles, isWall, sealOf, driftSet),
          });
        }
      }
    }
    out.sort(compareZonePlacements);
    return {
      piece: piece.name,
      zone: rect,
      total: out.length,
      shown: Math.min(out.length, MAX_ZONE_PLACEMENTS),
      placements: out.slice(0, MAX_ZONE_PLACEMENTS),
    };
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

  /** Roll the REAL `moveGrunts` model forward `maxTicks` build-seconds (grunts
   *  step once per second — GRUNT_TICK_INTERVAL=1.0) and report, per tile any
   *  grunt occupies during that window, the FIRST and LAST tick it's there.
   *  Reuses the engine's own movement so the forecast can't drift from reality;
   *  the throwaway clone deep-copies only `grunts` (the sole field `moveGrunts`
   *  mutates) and shares the read-only map/walls/towers. Walls are held fixed —
   *  the conservative "if you DON'T seal, the grunts arrive/stay" read, exactly
   *  the pre-emption signal a drift warning wants. `last` is what separates a
   *  mobile grunt that wanders off (last < seal time) from one that stays and
   *  boxes the ring (last ≥ seal time). */
  function forecastGruntArrival(
    maxTicks: number,
  ): Map<number, { first: number; last: number }> {
    const arrival = new Map<number, { first: number; last: number }>();
    const state = sc.state;
    if (maxTicks <= 0 || state.grunts.length === 0) return arrival;
    const clone = {
      ...state,
      grunts: state.grunts.map((grunt) => ({ ...grunt })),
    } as typeof state;
    for (let tick = 1; tick <= maxTicks; tick++) {
      moveGrunts(clone);
      for (const grunt of clone.grunts) {
        const key = packTile(grunt.row, grunt.col);
        const rec = arrival.get(key);
        if (rec) rec.last = tick;
        else arrival.set(key, { first: tick, last: tick });
      }
    }
    return arrival;
  }

  /** Min-cut tiles a grunt is forecast to sit on when the seal would complete —
   *  the `driftTiles` advisory. A tile drifts if a grunt is on it both at/after
   *  the seal-completion tick (`last ≥ cutoff` → it doesn't clear in time) and by
   *  then (`first ≤ cutoff`). Tiles already HARD-blocked (boxed/pit/unfillable)
   *  are dropped — the ⛔ already says it; soft `grunt-mobile` tiles stay eligible
   *  so the forecast can correct that snapshot's optimism. */
  function driftTilesFor(
    tiles: readonly { row: number; col: number }[],
    blockers: readonly SealBlocker[],
    estSeconds: number,
    forecast: Map<number, { first: number; last: number }>,
    horizon: number,
  ): { row: number; col: number; etaSeconds: number }[] {
    const cutoff = Math.min(Math.max(1, Math.ceil(estSeconds)), horizon);
    const hardBlocked = new Set(
      blockers
        .filter((blocker) => blocker.hard)
        .map((blocker) => packTile(blocker.row, blocker.col)),
    );
    const out: { row: number; col: number; etaSeconds: number }[] = [];
    for (const tile of tiles) {
      const key = packTile(tile.row, tile.col);
      if (hardBlocked.has(key)) continue;
      const rec = forecast.get(key);
      if (rec && rec.first <= cutoff && rec.last >= cutoff) {
        out.push({ row: tile.row, col: tile.col, etaSeconds: rec.first });
      }
    }
    return out.sort((a, b) => a.etaSeconds - b.etaSeconds);
  }

  /** True if adding `extraWall` to my walls would enclose `tower` — i.e. none of
   *  its 2×2 footprint tiles stay "outside". Uses the ENGINE's own
   *  `computeOutsideAfterAdd` against a precomputed `baselineOutside`, so the
   *  8-connected flood and the enclosure rule match the real `updateEnclosedTowers`
   *  exactly (owned ⟺ not outside; a tower is in ⟺ all footprint tiles owned). */
  function wouldEncloseWith(
    tower: { row: number; col: number },
    baselineOutside: ReadonlySet<TileKey>,
    extraWall: TileKey,
  ): boolean {
    const after = computeOutsideAfterAdd(baselineOutside, [extraWall]);
    for (let dr = 0; dr < TOWER_SIZE; dr++) {
      for (let dc = 0; dc < TOWER_SIZE; dc++) {
        if (after.has(packTile(tower.row + dr, tower.col + dc))) return false;
      }
    }
    return true;
  }

  /** BUILDABLE single-tile seals for a near-complete pocket — the `sealTiles`
   *  advisory. Candidates are the min-cut gaps plus their 8-neighbours (an
   *  inner-corner that kills a diagonal leak is always diagonally adjacent to the
   *  gap it covers); each buildable candidate is test-walled and kept only if the
   *  engine flood then encloses the tower. `kind` distinguishes a min-cut `gap`
   *  from an off-cut `inner-corner` the min-cut never surfaces. Skipped when the
   *  pocket is more than `SEAL_FINDER_MAX_GAPS` from closing (no single-tile seal
   *  exists, and the scan would be wasted). */
  function sealTilesFor(
    tower: { row: number; col: number },
    cut: ReadonlySet<TileKey>,
    baselineOutside: ReadonlySet<TileKey>,
  ): { row: number; col: number; kind: "gap" | "inner-corner" }[] {
    if (cut.size === 0 || cut.size > SEAL_FINDER_MAX_GAPS) return [];
    const candidates = new Set<TileKey>();
    for (const gapKey of cut) {
      candidates.add(gapKey);
      const { row, col } = unpackTile(gapKey);
      for (const [dr, dc] of DIRS_8) {
        const nr = row + dr;
        const nc = col + dc;
        if (inBounds(nr, nc)) candidates.add(packTile(nr, nc));
      }
    }
    const out: { row: number; col: number; kind: "gap" | "inner-corner" }[] =
      [];
    for (const key of candidates) {
      const { row, col } = unpackTile(key);
      if (!isBuildableGround(row, col)) continue;
      if (!wouldEncloseWith(tower, baselineOutside, key)) continue;
      out.push({ row, col, kind: cut.has(key) ? "gap" : "inner-corner" });
    }
    // Inner-corners first — they're the ones the min-cut/blockers don't already
    // surface, so they carry the new information.
    return out.sort(
      (a, b) => Number(a.kind === "gap") - Number(b.kind === "gap"),
    );
  }

  /** One-line blocker summary for a `stuck`/`blocked` build reason. When every
   *  remaining blocker is a boxed grunt sitting on the only seal tile (no
   *  inner-corner alternate, or `build_toward` would have taken it), the only
   *  remedy is a future battle — so append the actionable cull hint instead of
   *  leaving the agent staring at a dead-end. */
  function describeBlockers(blockers: readonly SealBlocker[]): string {
    if (blockers.length === 0) return "";
    const shown = blockers
      .slice(0, 4)
      .map((blocker) => `(${blocker.row},${blocker.col}) ${blocker.kind}`)
      .join(", ");
    const extra = blockers.length > 4 ? ` +${blockers.length - 4} more` : "";
    const allBoxed = blockers.every(
      (blocker) => blocker.kind === "grunt-boxed",
    );
    const remedy = allBoxed
      ? " — these grunts box the only seal tile and won't move; cull() them next battle to free it, then build_toward again (an enclosed-kill also clears them)"
      : "";
    return ` — ${shown}${extra}${remedy}`;
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
    // Forecast grunt traffic ONCE for the whole remaining build; each candidate
    // reads it up to its own seal-completion cutoff (driftTilesFor).
    const forecastHorizon = Math.min(
      Math.max(1, Math.ceil(state.timer)),
      GRUNT_DRIFT_MAX_HORIZON,
    );
    const gruntForecast = forecastGruntArrival(forecastHorizon);
    // Baseline 8-connected outside flood, computed ONCE; the seal-finder tests
    // each candidate wall against it via the engine's computeOutsideAfterAdd.
    const baselineOutside = computeOutside(player.walls);
    // Restoration Crew revives ONE enclosed dead tower immediately (before the
    // round-end life check), so while the player holds it a dead-tower seal DOES
    // satisfy survival this round. Read once — it's player-wide, not per-tower.
    const restorationRevive = player.upgrades.has(UID.RESTORATION_CREW);
    for (const tower of state.map.towers) {
      if (tower.zone !== zone) continue;
      const isHome = tower.index === homeIdx;
      const alive = state.towerAlive[tower.index] ?? false;
      const satisfiesSurvival = alive || restorationRevive;
      const pocket = pocketRectFor(tower, isHome, bounds);
      // Bonus squares this tower's pocket would bank (only meaningful while the
      // tower isn't yet enclosed — once enclosed, whatever it holds is already
      // counted in the interior).
      const bonusSquares = bonuses.filter((bonus) =>
        rectHas(pocket, bonus.row, bonus.col),
      ).length;
      const base = {
        towerIdx: tower.index as number,
        isHome,
        alive,
        satisfiesSurvival,
        bonusSquares,
        driftTiles: [] as EnclosureCandidate["driftTiles"],
        sealTiles: [] as EnclosureCandidate["sealTiles"],
      };
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
          driftTiles: driftTilesFor(
            tiles,
            blockers,
            estSeconds,
            gruntForecast,
            forecastHorizon,
          ),
          sealTiles: sealTilesFor(tower, cut, baselineOutside),
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
  /** Dense grunt clusters on the board: each connected (4-dir) grunt blob of
   *  CLUSTER_MIN_GRUNTS+ that fits in a compact CLUSTER_MAX_SPAN bounding box — the
   *  "group packed tightly enough that one wall ring traps the lot" signal (the
   *  ≥2×2-footprint idea, loosened so an L / knot counts, not just a perfect
   *  square). A sprawling swarm strung along a corridor is one component but fails
   *  the span test, so it's not mis-flagged as enclosable. Attributed to its zone
   *  (and owning castle) so the render frames yours as enclose-kill candidates and
   *  an opponent's as a grunt-pressure weakness. Densest blob first. */
  function gruntClustersFor(): GruntCluster[] {
    const state = sc.state;
    if (state.grunts.length < CLUSTER_MIN_GRUNTS) return [];
    const gruntKeys = new Set(
      state.grunts.map((grunt) => packTile(grunt.row, grunt.col)),
    );
    const isGrunt = (row: number, col: number) =>
      inBounds(row, col) && gruntKeys.has(packTile(row, col));
    const myZone = state.playerZones[agentSlot];
    const visited = new Set<number>();
    const clusters: GruntCluster[] = [];
    for (const start of state.grunts) {
      const startKey = packTile(start.row, start.col);
      if (visited.has(startKey)) continue;
      // Flood the whole 4-connected blob this grunt belongs to.
      let minRow = start.row;
      let maxRow = start.row;
      let minCol = start.col;
      let maxCol = start.col;
      let count = 0;
      const stack = [startKey];
      visited.add(startKey);
      while (stack.length > 0) {
        const { row, col } = unpackTile(stack.pop()!);
        count++;
        minRow = Math.min(minRow, row);
        maxRow = Math.max(maxRow, row);
        minCol = Math.min(minCol, col);
        maxCol = Math.max(maxCol, col);
        for (const [dr, dc] of DIRS_4) {
          const nr = row + dr;
          const nc = col + dc;
          // isGrunt bounds-checks first — must precede packTile, which throws
          // on an off-board tile (a grunt on the bottom/edge row probes row 28).
          if (!isGrunt(nr, nc)) continue;
          const nkey = packTile(nr, nc);
          if (!visited.has(nkey)) {
            visited.add(nkey);
            stack.push(nkey);
          }
        }
      }
      // Keep only blobs that are both big enough AND compact enough to enclose.
      if (count < CLUSTER_MIN_GRUNTS) continue;
      if (
        maxRow - minRow > CLUSTER_MAX_SPAN ||
        maxCol - minCol > CLUSTER_MAX_SPAN
      ) {
        continue;
      }
      const zone = zoneAt(state.map, start.row, start.col);
      if (zone === undefined) continue;
      const owner = state.playerZones.findIndex((zoneId) => zoneId === zone);
      clusters.push({
        minRow,
        maxRow,
        minCol,
        maxCol,
        count,
        zone,
        owner: owner >= 0 ? owner : null,
        ownerName: owner >= 0 ? (PLAYER_NAMES[owner] ?? `P${owner}`) : null,
        mine: zone === myZone,
      });
    }
    clusters.sort((a, b) => b.count - a.count);
    return clusters;
  }

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
        hittable: aimReachesTile(state, grunt.row, grunt.col),
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

    // Routability: a cannon is only RISKY if it pinches the wall route so a
    // future re-seal can't go around it. We measure that directly with the
    // engine's own min-cut on BARE terrain (empty walls) — "can a ring be built
    // around the home tower at all" — once as a baseline, then again with the
    // candidate cannon injected as an obstacle. A spot is unsafe only when it
    // flips that yes→no. Ring-adjacency alone is NOT risk: a 2×2 a tile inside a
    // clean rectangle leaves the boundary route untouched (the centred-tower
    // opener), so it stays routable. Footprints that don't even touch the ring
    // can never pinch the route, so they skip the min-cut entirely.
    const homeIdx = me.homeTower?.index;
    const homeTower =
      homeIdx === undefined
        ? undefined
        : state.map.towers.find((tower) => tower.index === homeIdx);
    const homePocket =
      homeTower !== undefined ? pocketRectFor(homeTower, true, bounds) : null;
    const BARE_WALLS = new Set() as unknown as Parameters<
      typeof findEnclosureCut
    >[2];
    const homeRoutable = (): boolean =>
      homeTower !== undefined &&
      homePocket !== null &&
      findEnclosureCut(
        [{ tower: homeTower, interior: homePocket }],
        state,
        BARE_WALLS,
        false,
      ) !== null;
    const baseRoutable = homeRoutable();
    const spotRoutable = (
      row: number,
      col: number,
      size: number,
      mode: CannonMode,
    ): boolean => {
      // No baseline ring (degenerate castle) → don't pin the blame on a cannon.
      if (!baseRoutable || homeTower === undefined || homePocket === null)
        return true;
      // Deep-interior footprint can't sit on the boundary route → always safe.
      if (footprintHug(row, col, size, ring) === 0) return true;
      const hypothetical = {
        row,
        col,
        mode,
        hp: 1,
      } as (typeof me.cannons)[number];
      me.cannons.push(hypothetical);
      const stillRoutable = homeRoutable();
      me.cannons.pop();
      return stillRoutable;
    };

    const out: CannonSuggestion[] = [];
    for (const def of cannonModesForGame(state.modern !== null)) {
      if (def.slotCost > remaining) continue;
      const spots: {
        row: number;
        col: number;
        hugs: number;
        wallLineSides: number;
        routable: boolean;
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
            routable: spotRoutable(row, col, def.size, def.id),
          });
        }
      }
      // Routable spots first (safe to re-wall around), then deep-interior spots
      // (wallLineSides 0 — stay armed through a ring breach), compactness last.
      spots.sort(
        (a, b) =>
          Number(!a.routable) - Number(!b.routable) ||
          a.wallLineSides - b.wallLineSides ||
          b.hugs - a.hugs,
      );
      for (const spot of spots.slice(0, CANNON_SUGGESTION_PER_MODE)) {
        out.push({
          mode: def.id,
          role: def.description,
          row: spot.row,
          col: spot.col,
          size: def.size,
          slotCost: def.slotCost,
          hugs: spot.hugs,
          wallLineSides: spot.wallLineSides,
          routable: spot.routable,
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
    if (isRampartCannon(cannon)) {
      return {
        canFire: false,
        reason:
          "defensive structure — absorbs cannonball hits on nearby walls, never fires",
      };
    }
    if (isBalloonCannon(cannon)) {
      return {
        canFire: false,
        reason:
          "balloon launcher — captures enemy cannons, not on the direct-fire path",
      };
    }
    const captor = captorOf(cannon);
    if (captor) {
      return {
        canFire: false,
        reason: `captured by ${captor} — fires for them this battle, not you`,
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

  /** Per-mode cannon tally with slot cost — reconciles cannon COUNT → slots USED
   *  (`slots` sum to `cannonSlotsUsed`). Mirrors that helper: alive cannons only,
   *  `cannonModeDef(mode).slotCost` per unit. */
  function cannonSlotsByMode(): {
    mode: CannonMode;
    count: number;
    slots: number;
  }[] {
    const me = sc.state.players[agentSlot];
    if (!me) return [];
    const counts = new Map<CannonMode, number>();
    for (const cannon of me.cannons) {
      if (!isCannonAlive(cannon)) continue;
      counts.set(cannon.mode, (counts.get(cannon.mode) ?? 0) + 1);
    }
    return [...counts].map(([mode, count]) => ({
      mode,
      count,
      slots: count * cannonModeDef(mode).slotCost,
    }));
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

  /** Name of the opponent who captured `cannon` from me, or null if it's still
   *  mine. A balloon (one for a normal gun, TWO for a super) launched in the
   *  cannon→battle gap can seize one of my cannons; a captured gun fires for the
   *  captor this battle, so it silently drops out of my own bombard/pit. */
  function captorOf(cannon: Cannon): string | null {
    const taken = sc.state.capturedCannons.find(
      (entry) => entry.cannon === cannon && entry.victimId === agentSlot,
    );
    return taken
      ? (PLAYER_NAMES[taken.capturerId] ?? `P${taken.capturerId}`)
      : null;
  }

  /** My cannons that an opponent's balloon has captured this battle — they fire
   *  for the captor, not me. Surfaced so a captured super (the pit-strike gun) or
   *  any lost cannon is visible BEFORE I commit a battle action, the way a human
   *  sees the enemy-coloured gun on their board. */
  function capturedFromMe(): {
    row: number;
    col: number;
    mode: CannonMode;
    by: string;
  }[] {
    return sc.state.capturedCannons
      .filter((entry) => entry.victimId === agentSlot)
      .map((entry) => ({
        row: entry.cannon.row,
        col: entry.cannon.col,
        mode: entry.cannon.mode,
        by: PLAYER_NAMES[entry.capturerId] ?? `P${entry.capturerId}`,
      }));
  }

  /** Enemy cannons MY balloon CAPTURED this battle — they now fire for ME, not
   *  their original owner (the mirror of `capturedFromMe`). A balloon launched in
   *  the cannon→battle gap seizes a normal gun with one hit, a super with two;
   *  the capture resolves at the CANNON_PLACE→BATTLE transition (`prepareBattle`),
   *  so it's already settled before any battle action and the seized gun fires
   *  inside my bombard/cull automatically. Surfaced so a successful balloon is
   *  visible — without it the agent gets no signal that its balloon worked. */
  function capturedByMe(): {
    row: number;
    col: number;
    mode: CannonMode;
    from: string;
  }[] {
    return sc.state.capturedCannons
      .filter((entry) => entry.capturerId === agentSlot)
      .map((entry) => ({
        row: entry.cannon.row,
        col: entry.cannon.col,
        mode: entry.cannon.mode,
        from: PLAYER_NAMES[entry.victimId] ?? `P${entry.victimId}`,
      }));
  }

  /** A cannon that plants a burning PIT when it fires at an enemy wall: a SUPER
   *  (always 3×3 splash + pit), or a NORMAL gun the Mortar upgrade elected this
   *  battle (`cannon.mortar`, set at the cannon→battle transition). `pit_strike`
   *  treats both as pit sources — Mortar's elected gun pits on every wall hit,
   *  so a Mortar owner can plant pits with no super placed at all. */
  function isPitCapable(cannon: Cannon): boolean {
    return isSuperCannon(cannon) || cannon.mortar === true;
  }

  /** Conditional cannon-snipe nudge (see `observation.cannonSnipe`). Returns the
   *  suggestion ONLY when sniping an enemy cannon beats the default bombard:
   *  Salvage held (every kill banks me a slot) or an opponent fields a targetable
   *  super/Mortar gun (a disproportionate threat). Otherwise null — plain bombard
   *  spreads more wall damage, so we don't bias the agent toward sniping every
   *  battle. A cannon is targetable when it's alive, not a balloon, and not
   *  shielded this battle (those absorb the hit). */
  function cannonSnipeSuggestion(): NonNullable<
    Observation["cannonSnipe"]
  > | null {
    const state = sc.state;
    // No gun of my own can fire this battle → nothing to snipe with.
    if (cannonsReadyCount() === 0) return null;
    const me = state.players[agentSlot]!;
    const targetable = (cannon: Cannon): boolean =>
      isCannonAlive(cannon) && !isBalloonCannon(cannon) && !cannon.shielded;
    const opps = state.players
      .map((player, slot) => ({ player, slot }))
      .filter(
        ({ player, slot }) =>
          slot !== agentSlot &&
          !player.eliminated &&
          player.cannons.some(targetable),
      )
      .sort((a, b) => b.player.score - a.player.score);
    if (opps.length === 0) return null;
    const holdsSalvage = me.upgrades.has(UID.SALVAGE);
    const heavyOpp = opps.find(({ player }) =>
      player.cannons.some(
        (cannon) => targetable(cannon) && isPitCapable(cannon),
      ),
    );
    let pick: { player: Player; slot: number };
    let reason: string;
    if (holdsSalvage) {
      pick = opps[0]!; // thin the leader's battery — most slots banked
      reason =
        "you hold Salvage — each enemy cannon you destroy banks you +1 slot (max +2)";
    } else if (heavyOpp) {
      pick = heavyOpp;
      reason =
        "they field a SUPER/Mortar gun — it 3×3-splashes + pit-strikes you; killing it removes a disproportionate threat and the wreck-debris denies the slot";
    } else {
      return null; // a plain battery isn't worth biasing off bombard
    }
    const guns = pick.player.cannons
      .filter(targetable)
      .sort((a, b) => Number(isPitCapable(b)) - Number(isPitCapable(a)));
    return {
      slot: pick.slot,
      name: PLAYER_NAMES[pick.slot] ?? `P${pick.slot}`,
      reason,
      hitsToKill: state.cannonMaxHp,
      tiles: guns.slice(0, CANNON_SNIPE_TILES).map((cannon) => ({
        row: cannon.row,
        col: cannon.col,
        heavy: isPitCapable(cannon),
      })),
    };
  }

  /** Balloon hits to capture a cannon (super = 2, normal/Mortar = 1) — mirrors the
   *  engine's `balloonHitThreshold` (not exported). */
  function balloonHitsNeeded(cannon: Cannon): number {
    return isSuperCannon(cannon)
      ? SUPER_BALLOON_HITS_NEEDED
      : BALLOON_HITS_NEEDED;
  }

  /** Spare-slot balloon nudge (see `observation.balloonOpportunity`). Returns the
   *  suggestion whenever a balloon is affordable AND any enclosed enemy gun is
   *  still capturable — a near-free steal on idle slots, so unlike
   *  `cannonSnipeSuggestion` it does NOT require an enemy super. Mirrors the
   *  engine's `findBestBalloonTarget`: most dangerous ENCLOSED, under-threshold
   *  enemy cannon (super preferred, then HP), so `gun` names the cannon the
   *  balloon will actually fly at and `balloonsToSeize` is honest about a super's
   *  2-hit cost. */
  function balloonOpportunitySuggestion(
    suggestions: CannonSuggestion[],
  ): NonNullable<Observation["balloonOpportunity"]> | null {
    const spot = suggestions.find((s) => s.mode === CannonMode.BALLOON);
    if (!spot) return null; // no affordable / legal 2×2 balloon placement
    const state = sc.state;
    const me = state.players[agentSlot];
    if (!me) return null;
    const free = cannonSlotsFor(state, agentSlot) - cannonSlotsUsed(me);
    const balloonsAffordable = Math.floor(
      free / cannonModeDef(CannonMode.BALLOON).slotCost,
    );
    if (balloonsAffordable < 1) return null;
    // Mirror findBestBalloonTarget: most dangerous ENCLOSED, still-capturable enemy
    // gun (super preferred, then HP). A balloon can't take its own kind, a dead
    // gun, or one already at its hit threshold.
    let best: { cannon: Cannon; slot: number; key: number } | null = null;
    state.players.forEach((player, slot) => {
      if (slot === agentSlot || player.eliminated) return;
      for (const cannon of player.cannons) {
        if (!isCannonAlive(cannon) || isBalloonCannon(cannon)) continue;
        if ((cannon.balloonHits ?? 0) >= balloonHitsNeeded(cannon)) continue;
        if (!isCannonEnclosed(cannon, player)) continue;
        // Same ordering the engine uses: super dominates, HP breaks ties.
        const key = (isSuperCannon(cannon) ? 1_000 : 0) + cannon.hp;
        if (!best || key > best.key) best = { cannon, slot, key };
      }
    });
    if (!best) return null;
    const pick: { cannon: Cannon; slot: number; key: number } = best;
    return {
      slot: pick.slot,
      name: PLAYER_NAMES[pick.slot] ?? `P${pick.slot}`,
      gun: {
        row: pick.cannon.row,
        col: pick.cannon.col,
        mode: pick.cannon.mode,
      },
      balloonsToSeize:
        balloonHitsNeeded(pick.cannon) - (pick.cannon.balloonHits ?? 0),
      balloonsAffordable,
      spot: { row: spot.row, col: spot.col },
    };
  }

  /** Short label for a pit-capable gun in result/fallback text. */
  function pitGunLabel(cannon: Cannon): string {
    return isSuperCannon(cannon) ? "super" : "mortar gun";
  }

  /** Enemy cannons MY balloon seized that can plant pits this battle: pit-capable
   *  (a captured super) and alive. A seized gun fires for ME via `nextReadyCannon`
   *  (it rotates own + captured for the captor) and, being a super ball, pits any
   *  wall it hits — so it's a real pit_strike gun even when ALL my own guns are
   *  dead/captured. No enclosure test: a captured cannon sits in enemy territory
   *  and its readiness is governed by `canFireCapturedCannon`, not my ring. */
  function capturedPitGuns(): Cannon[] {
    return sc.state.capturedCannons
      .filter(
        (entry) =>
          entry.capturerId === agentSlot &&
          isPitCapable(entry.cannon) &&
          isCannonAlive(entry.cannon),
      )
      .map((entry) => entry.cannon);
  }

  /** Guns that can actually plant pits FOR me this battle: my own pit-capable
   *  (super or Mortar-elected normal) cannons that are alive, enclosed, and NOT
   *  captured — PLUS any enemy super my balloon seized (it fires for me and pits
   *  on hit). `pit_strike` needs one of these; an alive-but-captured OWN gun looks
   *  armed yet fires for the enemy, while a seized ENEMY super is the mirror — it
   *  fires for me, so the render's "a seized super = a free pit_strike gun" holds. */
  function usablePitCannons(): Cannon[] {
    const me = sc.state.players[agentSlot];
    if (!me) return [];
    const own = me.cannons.filter(
      (cannon) =>
        isPitCapable(cannon) &&
        isCannonAlive(cannon) &&
        isCannonEnclosed(cannon, me) &&
        captorOf(cannon) === null,
    );
    return [...own, ...capturedPitGuns()];
  }

  /** Why `pit_strike` fell back to a plain bombard, or null when there was simply
   *  no pit-capable gun to begin with (bombard IS the right call then — no note
   *  needed). Names the cause (captured / destroyed / unenclosed) for the super
   *  OR Mortar-elected gun, so a no-pit fallback is never the old silent surprise. */
  function pitGunUnusableReason(): string | null {
    const me = sc.state.players[agentSlot];
    const guns = (me?.cannons ?? []).filter((cannon) => isPitCapable(cannon));
    if (guns.length === 0) return null;
    const captured = guns.find((cannon) => captorOf(cannon) !== null);
    if (captured) {
      return `your ${pitGunLabel(captured)} at (${captured.row},${captured.col}) was CAPTURED by ${captorOf(
        captured,
      )} — it fires for them, not you`;
    }
    if (guns.every((cannon) => !isCannonAlive(cannon))) {
      return `your ${pitGunLabel(guns[0]!)} was destroyed`;
    }
    const unenclosed = guns.find(
      (cannon) => me && !isCannonEnclosed(cannon, me),
    );
    if (unenclosed) {
      return `your ${pitGunLabel(unenclosed)} at (${unenclosed.row},${unenclosed.col}) is unenclosed (ring breached) — reseal to re-arm`;
    }
    return "your pit gun can't fire this battle";
  }

  /** What happened to ME this battle — the return-fire I take while a one-call
   *  bombard/breach runs (and can't react to). Walls lost AND WHERE they fell
   *  (a few sample tiles nearest my home, so I see which face was hit, not just a
   *  count), plus whether my own ring was breached (cannons going inert is the
   *  live tell — enclosedTowers only recomputes next build). Appended to the
   *  attack result so a breached castle + disarmed battery isn't a surprise at
   *  the next build. Takes the pre-battle wall SET (not a count) so it can diff
   *  the exact tiles the enemy destroyed. */
  function battleSelfReport(
    wallsBefore: ReadonlySet<number>,
    inertBefore: number,
    selfCleared?: ReadonlySet<number>,
  ): string {
    const me = sc.state.players[agentSlot];
    // `selfCleared` = walls I intentionally shot out myself (declutter) — exclude
    // them so the report counts only INCIDENTAL return-fire, not my own work.
    const lost = [...wallsBefore]
      .filter(
        (key) =>
          !me?.walls.has(key as Parameters<typeof unpackTile>[0]) &&
          !selfCleared?.has(key),
      )
      .map((key) => unpackTile(key as Parameters<typeof unpackTile>[0]));
    const inertNow = cannonsUnenclosedCount();
    const total = me?.cannons.length ?? 0;
    const parts: string[] = [];
    if (lost.length > 0) {
      // Sample the lost tiles NEAREST my home tower first — the breach closest
      // to the core is the one most urgent to reseal, and a 4-tile sample with
      // a side label tells me where without dumping the whole list.
      const home = me?.homeTower;
      const ordered = home
        ? [...lost].sort(
            (a, b) =>
              (a.row - home.row) ** 2 +
              (a.col - home.col) ** 2 -
              ((b.row - home.row) ** 2 + (b.col - home.col) ** 2),
          )
        : lost;
      const sample = ordered
        .slice(0, 4)
        .map((tile) => `(${tile.row},${tile.col})`)
        .join(",");
      const more = lost.length > 4 ? "…" : "";
      parts.push(`you lost ${lost.length} walls near ${sample}${more}`);
    }
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
    let bestScore = [-1, -Infinity, -Infinity, -Infinity, -1];
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

  /** Lexicographic [coverage, -waste, -overshoot, -fatTiles, ringTouch] score for
   *  one placement, or null if it covers no target tile (so it's never chosen for
   *  a goal). `overshoot` = piece tiles beyond `box` (the target tiles' bounding
   *  box): a tile outside it grows the castle's wall bbox outward, which inflates
   *  the home pocket on the NEXT plan, so the min-cut chases an ever-larger ring
   *  that never closes (the seed-42 R5 reseal that burned the whole phase).
   *  `fatTiles` = piece tiles that would be FAT — every 8-neighbour already owned
   *  (wall / interior / a sibling tile of this piece), so the tile guards no
   *  boundary (the `fatWallsFor` predicate, applied to the prospective board).
   *  Ranked above ringTouch so the executor never packs a redundant inner wall
   *  just to gain ring-adjacency — the fix for `build_toward` finishing with dozens
   *  of fat walls. A frontier seal touches `outside`, so it's never fat and this
   *  never penalises a real ring placement. Rank overshoot above fat so a tight
   *  on-the-gap placement still beats one that overshoots into open space. */
  function scorePlacement(
    offsets: readonly [number, number][],
    row: number,
    col: number,
    targets: ReadonlySet<number>,
    walls: ReadonlySet<number>,
    box: { minRow: number; maxRow: number; minCol: number; maxCol: number },
  ): [number, number, number, number, number] | null {
    const interior = sc.state.players[agentSlot]?.interior;
    const pieceTiles = new Set(
      offsets.map(([dr, dc]) => packTile(row + dr, col + dc)),
    );
    const isWall = (tileRow: number, tileCol: number): boolean =>
      inBounds(tileRow, tileCol) && walls.has(packTile(tileRow, tileCol));
    // Owned = wall / interior / a sibling tile of THIS piece. Off-board is NOT
    // owned (a board-edge neighbour makes the tile load-bearing, never fat) —
    // mirrors `fatWallsFor`.
    const isOwned = (tileRow: number, tileCol: number): boolean => {
      if (!inBounds(tileRow, tileCol)) return false;
      const key = packTile(tileRow, tileCol);
      return (
        walls.has(key) || (interior?.has(key) ?? false) || pieceTiles.has(key)
      );
    };
    let coverage = 0;
    let touching = 0;
    let overshoot = 0;
    let fatTiles = 0;
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
      if (DIRS_8.every(([er, ec]) => isOwned(tileRow + er, tileCol + ec))) {
        fatTiles++;
      }
    }
    if (coverage === 0) return null;
    return [
      coverage,
      -(offsets.length - coverage),
      -overshoot,
      -fatTiles,
      touching,
    ];
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

  function observe(view?: ViewOptions): Observation {
    const state = sc.state;
    const phase = state.phase;
    const me = state.players[agentSlot]!;
    const zone = state.playerZones[agentSlot];
    const battle = phase === Phase.BATTLE;
    // Default: zone-cropped board (battle = whole board). `view` lets the agent
    // override the crop / pick a layer / isolate an entity subset.
    const boardOpts: AsciiSnapshotOptions = { coords: true, gruntFacing: true };
    if (view?.crop) {
      boardOpts.cropTo = {
        minRow: view.crop.minRow ?? 0,
        maxRow: view.crop.maxRow ?? GRID_ROWS - 1,
        minCol: view.crop.minCol ?? 0,
        maxCol: view.crop.maxCol ?? GRID_COLS - 1,
      };
    } else if (!battle) {
      boardOpts.cropTo = agentSlot;
      boardOpts.cropPad = BOARD_CROP_PAD;
    }
    if (view?.layer) boardOpts.layer = view.layer;
    if (view?.show && view.show.length > 0) boardOpts.show = view.show;
    const board = asciiSnapshot(state, boardOpts);

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
        aliveEnclosedTowers: filterAliveEnclosedTowers(me, state).length,
        survivesRoundEnd: survivesRoundEndLifeCheck(me),
        bagLocked:
          state.phase === Phase.WALL_BUILD && me.currentPiece != null
            ? !currentPieceHasAnyPlacement(me)
            : false,
        dumpCapacity: dumpCapacityFor(me),
        homeTower: me.homeTower
          ? { row: me.homeTower.row, col: me.homeTower.col }
          : null,
        currentPiece: me.currentPiece?.name ?? null,
        cannons: me.cannons.length,
        cannonSlots: {
          used: cannonSlotsUsed(me),
          max: cannonSlotsFor(state, agentSlot),
          byMode: cannonSlotsByMode(),
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
        capturedCannons: capturedFromMe(),
        capturedByMe: capturedByMe(),
        cannonsReady: cannonsReadyCount(),
        cannonsUnenclosed: cannonsUnenclosedCount(),
        walls: me.walls.size,
        interior: me.interior.size,
        headroom: headroomFor(),
        enclosedTowers: me.enclosedTowers.length,
        homeTowerEnclosed:
          me.homeTower !== null &&
          me.enclosedTowers.some((tower) => tower === me.homeTower),
        ...upgradesField(me),
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
          ...upgradesField(player),
        })),
      lastResult: bridge.lastResult,
    };

    const threats = threatsFor();
    if (threats.length > 0) observation.threats = threats;

    if (phase === Phase.WALL_BUILD || phase === Phase.BATTLE) {
      const clusters = gruntClustersFor();
      if (clusters.length > 0) observation.gruntClusters = clusters;
    }

    if (phase === Phase.CASTLE_SELECT && zone !== undefined) {
      observation.towers = state.map.towers
        .filter((tower) => tower.zone === zone)
        .map((tower) => {
          const rect = castleRect(
            tower,
            state.map.tiles,
            state.map.towers,
            ENCLOSURE_MARGIN,
            true,
          );
          return {
            index: tower.index,
            row: tower.row,
            col: tower.col,
            enclosed: me.enclosedTowers.some(
              (enc) => enc.index === tower.index,
            ),
            pocket: {
              h: rect.bottom - rect.top + 1,
              w: rect.right - rect.left + 1,
            },
          };
        });
    }

    if (phase === Phase.CANNON_PLACE) {
      observation.cannonSuggestions = cannonSuggestionsFor();
      const balloon = balloonOpportunitySuggestion(
        observation.cannonSuggestions,
      );
      if (balloon) observation.balloonOpportunity = balloon;
    }

    if (phase === Phase.WALL_BUILD) attachBuildSurfaces(observation);

    if (phase === Phase.BATTLE) attachBattleSurfaces(observation);

    applyModernSurfaces(observation, phase);

    // Derived LAST — reads the fully-populated sections it summarizes.
    const alerts = alertsFor(observation);
    if (alerts.length > 0) observation.alerts = alerts;

    return observation;
  }

  /** Attach the modern-only observation fields (absent in classic, where
   *  `state.modern === null`): the round's environmental modifier (passive, but
   *  it reshapes the board) and — during UPGRADE_PICK — the agent's three
   *  upgrade offers in card order. Kept out of `observe` to hold that function
   *  under the complexity cap. */
  /** The upgrades a player holds in force this round, as the public
   *  `ActiveUpgrade` shape. Empty in classic (player.upgrades is empty) and when
   *  the player drafted nothing — callers omit the field in that case. */
  function activeUpgradesFor(player: Player): ActiveUpgrade[] {
    const out: ActiveUpgrade[] = [];
    for (const [id, stacks] of player.upgrades) {
      const def = UPGRADE_POOL.find((entry) => entry.id === id);
      out.push({
        id,
        label: def?.label ?? id,
        description: def?.description ?? "",
        stacks,
      });
    }
    return out;
  }

  /** `{ activeUpgrades }` when the player holds any, else `{}` — spread into the
   *  me / opponent observation objects so the field is omitted (not empty) in
   *  classic and when the player drafted nothing. */
  function upgradesField(player: Player): { activeUpgrades?: ActiveUpgrade[] } {
    const upgrades = activeUpgradesFor(player);
    return upgrades.length > 0 ? { activeUpgrades: upgrades } : {};
  }

  function applyModernSurfaces(observation: Observation, phase: Phase): void {
    const modern = sc.state.modern;
    if (!modern) return;
    // This round's modifier isn't rolled until prepareBattleState
    // (cannon-place-done), so during CASTLE_SELECT/CANNON_PLACE
    // `activeModifier` still holds the PREVIOUS round's value. Surfacing it
    // then is both stale and a peek at info not yet rolled — only expose it
    // once it's genuinely live (MODIFIER_REVEAL onward).
    const modId = modern.activeModifier;
    const modifierRolled =
      phase !== Phase.CASTLE_SELECT && phase !== Phase.CANNON_PLACE;
    if (modId && modifierRolled) {
      observation.activeModifier = {
        id: modId,
        label: modifierDef(modId).label,
      };
    }
    // Ceasefire is global: any owner skips the whole battle this round. Warn in
    // CANNON_PLACE so the agent knows end_cannon won't yield a battle turn.
    if (phase === Phase.CANNON_PLACE && shouldSkipBattle(sc.state)) {
      observation.battleSkipped = true;
    }
    // Supply Ship: surface the live hulls (battle only — spawned at battle start,
    // cleared at battle end) so the agent can lead-fire at them like a human can.
    // The per-ship `bonus` is deliberately NOT exposed: it's hidden until sunk,
    // so reading it would be info no human has.
    const ships = modern.supplyShips;
    if (phase === Phase.BATTLE && ships && ships.length > 0) {
      observation.supplyShips = ships.map((ship) => ({
        id: ship.id,
        row: Math.round(ship.position.row * 10) / 10,
        col: Math.round(ship.position.col * 10) / 10,
        hp: ship.hp,
        sinking: ship.sinking !== undefined,
        velTilesPerSec: {
          dCol:
            Math.round(Math.cos(ship.headingRad) * SUPPLY_SHIP_SPEED * 100) /
            100,
          dRow:
            Math.round(Math.sin(ship.headingRad) * SUPPLY_SHIP_SPEED * 100) /
            100,
        },
      }));
    }
    if (phase !== Phase.UPGRADE_PICK) return;
    const offers = modern.pendingUpgradeOffers?.get(agentSlot);
    if (!offers) return;
    observation.upgradeOffers = offers.map((id, cardIdx) => {
      const def = UPGRADE_POOL.find((entry) => entry.id === id);
      return {
        cardIdx,
        id,
        label: def?.label ?? id,
        description: def?.description ?? "",
      };
    });
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

  /** Shared attack target-selection over an opponent's walls — the strategy
   *  layer `bombard` draws from. `spread` returns the walls nearest my battery
   *  (max raw wall count destroyed — bombard's classic behaviour). `choke`
   *  returns the opponent's load-bearing OUTER-RING walls ranked by
   *  un-reroutability (`chokeScore` desc — walls pinched against water/edge that
   *  they can't rebuild one tile over, exactly the ranking `pit_strike` uses),
   *  distance-to-battery as the tie-break. Choke is pit_strike's aim made
   *  available to ORDINARY cannon fire: a normal ball that razes a load-bearing
   *  ring wall costs them more to patch than a random near wall — a heavier
   *  wall-TAX, not a de-enclosure (the AI re-routes its ring and re-encloses next
   *  build either way; choke just makes the re-route pricier). Falls back to
   *  `spread` when the target has no boundary ring left
   *  (e.g. only interior debris) so a choke attack never no-ops. */
  function attackWallTiles(
    slot: number,
    origin: { row: number; col: number },
    mode: "spread" | "choke",
  ): { row: number; col: number }[] {
    const target = sc.state.players[slot];
    if (!target) return [];
    if (mode === "spread") {
      return sampleWallTiles(target.walls, target.walls.size, origin);
    }
    const dist2 = (row: number, col: number): number =>
      (row - origin.row) ** 2 + (col - origin.col) ** 2;
    const ranked = [...boundaryWalls(target)]
      .map((key) => unpackTile(key as Parameters<typeof unpackTile>[0]))
      .sort(
        (a, b) =>
          chokeScore(b.row, b.col) - chokeScore(a.row, a.col) ||
          dist2(a.row, a.col) - dist2(b.row, b.col),
      )
      .map(({ row, col }) => ({ row, col }));
    return ranked.length > 0
      ? ranked
      : sampleWallTiles(target.walls, target.walls.size, origin);
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
        // Slot affordability — `canPlaceCannon` only checks the footprint, so a
        // super (slotCost 4) on 3 free slots reads as a valid phantom yet the
        // real commit rejects it with no explanation. Gate the budget here so
        // check_placement is honest AND the rejection routes through the
        // reason-carrying branch in `act` instead of the silent count-delta one.
        const def = cannonModesForGame(state.modern !== null).find(
          (mode) => mode.id === decision.mode,
        );
        if (def) {
          const free = cannonSlotsFor(state, agentSlot) - cannonSlotsUsed(me);
          if (def.slotCost > free) {
            return {
              valid: false,
              reason: `can't afford ${def.label} — costs ${def.slotCost} slots, ${free} free`,
            };
          }
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
      case "pick-upgrade":
        return checkPickUpgrade(decision.cardIdx);
    }
  }

  /** Legality of a `pick-upgrade` decision: must be in UPGRADE_PICK with offers
   *  for the agent, and `cardIdx` in range. Split out of `checkDecision` to keep
   *  that switch under the complexity cap. */
  function checkPickUpgrade(cardIdx: number): CheckResult {
    if (sc.state.phase !== Phase.UPGRADE_PICK) {
      return { valid: false, reason: "not in UPGRADE_PICK" };
    }
    const offers = sc.state.modern?.pendingUpgradeOffers?.get(agentSlot);
    if (!offers) {
      return { valid: false, reason: "no upgrade offers for you this round" };
    }
    if (cardIdx < 0 || cardIdx >= offers.length) {
      return {
        valid: false,
        reason: `cardIdx must be 0..${offers.length - 1} (see upgradeOffers)`,
      };
    }
    return { valid: true };
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
  /** The still-enclosable tower the agent could bank in the time left, cheapest
   *  (and, tie-broken, most bonus) first — the build worth doing before passing.
   *  Null when nothing's reachable, so passing is genuinely correct. */
  function cheapestFeasibleEnclosure(): EnclosureCandidate | null {
    const feasible = enclosureCandidatesFor().filter(
      (candidate) => candidate.status === "enclosable" && candidate.feasible,
    );
    if (feasible.length === 0) return null;
    return feasible.sort(
      (a, b) =>
        a.estSeconds - b.estSeconds ||
        (b.bonusSquares ?? 0) - (a.bonusSquares ?? 0),
    )[0]!;
  }

  /** Like `cheapestFeasibleEnclosure`, but only towers whose seal actually CLEARS
   *  the "no alive tower enclosed → lose a life" check (alive, or dead-but-
   *  Restoration-Crew). The right target when survival is on the line: a dead
   *  tower is cheaper but its seal still costs the life. Null when no
   *  survival-satisfying tower is reachable this build. */
  function cheapestFeasibleSurvivalEnclosure(): EnclosureCandidate | null {
    const feasible = enclosureCandidatesFor().filter(
      (candidate) =>
        candidate.status === "enclosable" &&
        candidate.feasible &&
        candidate.satisfiesSurvival,
    );
    if (feasible.length === 0) return null;
    return feasible.sort(
      (a, b) =>
        a.estSeconds - b.estSeconds ||
        (b.bonusSquares ?? 0) - (a.bonusSquares ?? 0),
    )[0]!;
  }

  /** buildOut's greedy pick: the next tower worth FULLY enclosing in the time
   *  left — home first (biggest territory, always priority), then cheapest /
   *  most-bonus. Null when nothing fully fits (→ pre-claim instead). */
  function nextExpandTarget(): EnclosureCandidate | null {
    const feasible = enclosureCandidatesFor().filter(
      (candidate) => candidate.status === "enclosable" && candidate.feasible,
    );
    if (feasible.length === 0) return null;
    return (
      feasible.find((candidate) => candidate.isHome) ??
      feasible.sort(
        (a, b) =>
          a.estSeconds - b.estSeconds ||
          (b.bonusSquares ?? 0) - (a.bonusSquares ?? 0),
      )[0]!
    );
  }

  /** buildOut's pre-claim pick: the cheapest tower that's enclosable but WON'T
   *  finish in the time left — the ring worth part-building now so next round's
   *  enclosure is cheaper. Null when none. */
  function cheapestPreclaimTarget(): EnclosureCandidate | null {
    const partial = enclosureCandidatesFor().filter(
      (candidate) => candidate.status === "enclosable" && !candidate.feasible,
    );
    if (partial.length === 0) return null;
    return partial.sort((a, b) => a.tilesNeeded - b.tilesNeeded)[0]!;
  }

  function pass(count = 1, seconds?: number): Observation {
    const startPhase = sc.state.phase;
    const wasCountdown = sc.state.battleCountdown > 0;
    // True when a PRIOR pass already issued the idle-build HELD warning and this
    // call is the deliberate "pass again to skip it anyway" follow-up. Captured
    // before the guard below can re-arm it, so the advancing path knows to drop
    // the stale HELD text (otherwise the same REJECT re-renders after time has
    // moved and the skip reads as a no-op).
    const releasingHold = idleBuildPassWarned;
    // Idle-build guard: skipping build time while a tower is still enclosable in
    // the time left scores nothing — that territory + bonus bank ONLY if walled.
    // Hold the FIRST such pass and shout the opportunity cost; a second pass goes
    // through (so a deliberate skip isn't trapped). Only fires when the skip is
    // big enough to have built the cheapest reachable tower.
    if (startPhase === Phase.WALL_BUILD && !idleBuildPassWarned) {
      const skipSec = seconds ?? (count * actionTicks) / SIM_TICKS_PER_SEC;
      // If NO alive tower is enclosed right now, passing doesn't just forfeit
      // territory — it costs a LIFE and resets the whole zone at round end. When
      // that's the case, steer the agent to a tower whose seal actually CLEARS
      // the loss (alive / Restoration-Crew), not merely the cheapest reachable
      // one — sealing a dead tower banks territory but still costs the life.
      const atRisk = !survivesRoundEndLifeCheck(sc.state.players[agentSlot]!);
      const target =
        (atRisk ? cheapestFeasibleSurvivalEnclosure() : null) ??
        cheapestFeasibleEnclosure();
      if (target && skipSec >= target.estSeconds) {
        idleBuildPassWarned = true;
        const who = target.isHome ? "home" : `tower ${target.towerIdx}`;
        const bonus =
          (target.bonusSquares ?? 0) > 0
            ? ` + ★${target.bonusSquares} bonus square(s)`
            : "";
        const stakes = atRisk
          ? `☠ NO alive tower enclosed — finalize like this and you LOSE A LIFE and your zone resets. `
          : "";
        bridge.lastResult = {
          kind: "build",
          success: false,
          reason:
            `HELD — ${stakes}${who} is still enclosable (~${target.estSeconds.toFixed(0)}s, ` +
            `you have ${sc.state.timer.toFixed(0)}s) and idle build scores 0: ${who}'s ` +
            `territory${bonus} banks THIS round only if you wall it. ` +
            `build_out() to enclose it (and everything else that fits), ` +
            `build_toward({ towerIdx: ${target.towerIdx} }) for just this one, or pass again to skip it anyway.`,
        };
        return observe();
      }
    }
    // `seconds` (the unit the agent reads as timerSec) wins when given; convert
    // to action-quanta via the game's per-action tick cost. Each iteration still
    // advances exactly one quantum and stops early on a phase change.
    const iterations =
      seconds !== undefined
        ? Math.max(1, Math.round((seconds * SIM_TICKS_PER_SEC) / actionTicks))
        : count;
    // This pass is the follow-up that overrides a prior HELD: drop the stale
    // warning so the observation reflects the time we are about to burn, not the
    // reject that already did its job.
    if (releasingHold) bridge.lastResult = null;
    for (let i = 0; i < iterations && !gameOver(); i++) {
      advance(actionTicks);
      settleToDecision();
      if (sc.state.phase !== startPhase) break;
      if (wasCountdown && sc.state.battleCountdown <= 0) break;
    }
    if (sc.state.phase !== Phase.WALL_BUILD) idleBuildPassWarned = false;
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
    // Building re-arms the idle-pass guard: any tower still reachable after this
    // piece is worth a fresh warning if the agent then tries to pass it away.
    idleBuildPassWarned = false;
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

  /** Per-step seal plan for `driveBuildLoop`: the target tile set, whether the
   *  step is bag-cycling (no on-target placement is possible right now, so a
   *  redirect mustn't count as a stall/divergence), and whether the pocket is
   *  hard-jammed with no way forward (terminal `blocked`). `targets` is the
   *  min-cut gaps PLUS any off-cut inner-corner alternates (the 8-dir
   *  diagonal-leak seals) — so when a min-cut gap is grunt-boxed we wall AROUND
   *  the grunt via the alternate instead of dead-ending (the seed-42 R4 jam).
   *  Pulled out to keep `driveBuildLoop` within the complexity budget. */
  function sealStepPlan(candidate: EnclosureCandidate): {
    blocked: boolean;
    cyclingForPiece: boolean;
    targets: Set<number>;
  } {
    const altSeals = candidate.sealTiles.filter(
      (seal) => seal.kind === "inner-corner",
    );
    const allBlocked = candidate.blockers.length === candidate.tiles.length;
    const allHardBlocked =
      allBlocked && candidate.blockers.every((blocker) => blocker.hard);
    const allSoftBlocked =
      allBlocked && candidate.blockers.every((blocker) => !blocker.hard);
    const targets = new Set(
      candidate.tiles.map((tile) => packTile(tile.row, tile.col)),
    );
    for (const seal of altSeals) targets.add(packTile(seal.row, seal.col));
    return {
      blocked: allHardBlocked && altSeals.length === 0,
      // Soft-blocked (mobile grunt / awaiting small piece), OR hard-blocked but
      // cycling the bag toward a piece that fits an inner-corner alternate.
      cyclingForPiece:
        allSoftBlocked || (allHardBlocked && altSeals.length > 0),
      targets,
    };
  }

  /** Piece-aware widening of `sealStepPlan.cyclingForPiece` (Bug 1): even when only
   *  SOME tiles are blocked, an arriving piece too big for an open sub-piece island
   *  (and covering no other seal target this draw) gets redirected onto the ring —
   *  legitimate bag-cycling toward a smaller draw, not a stall. Treat it as cycling
   *  so the redirect doesn't trip BUILD_STALL_LIMIT and abandon the seal with time
   *  to spare (the seed-42 R1 home reseal that bailed one tile short). Stays false
   *  — leaving the stall guard fully active — when there's no `needs-small-piece`
   *  island to wait on, so genuine geometric jams still terminate. */
  function isCyclingForPiece(
    candidate: EnclosureCandidate,
    plan: { cyclingForPiece: boolean; targets: ReadonlySet<number> },
  ): boolean {
    if (plan.cyclingForPiece) return true;
    const piece = sc.state.players[agentSlot]?.currentPiece;
    const pieceFitsTarget =
      !!piece && bestBuildPlacement(piece, plan.targets) !== null;
    const awaitingSmallPiece = candidate.blockers.some(
      (blocker) => blocker.kind === "needs-small-piece",
    );
    return !pieceFitsTarget && awaitingSmallPiece;
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
      const plan = sealStepPlan(candidate);
      // Min-cut fully hard-blocked AND no inner-corner alternate → no piece will
      // ever land. Stop instead of thrashing redirects into the stall limit.
      if (plan.blocked) {
        outcome = "blocked";
        break;
      }
      const cyclingForPiece = isCyclingForPiece(candidate, plan);
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
      const step = placeTowardTargets(plan.targets);
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

  /** Survival escape: seal the cheapest tower that clears the round-end life
   *  check (see `sealSurvivor` in McpGame). Delegates to `buildToward` so the
   *  min-cut carves a tight compartment even when the outer ring is unsealable
   *  in time. No-ops with an explanatory REJECT when survival is unreachable. */
  function sealSurvivor(budget?: BuildBudget): Observation {
    if (sc.state.phase !== Phase.WALL_BUILD) {
      bridge.lastResult = {
        kind: "build",
        success: false,
        reason: "not in WALL_BUILD",
      };
      return observe();
    }
    const player = sc.state.players[agentSlot]!;
    if (survivesRoundEndLifeCheck(player)) {
      bridge.lastResult = {
        kind: "build",
        success: true,
        reason:
          "survival already safe: an alive/revivable tower is enclosed — no life at risk this round-end.",
      };
      return observe();
    }
    const saver = cheapestFeasibleSurvivalEnclosure();
    if (saver === null) {
      // Separate the two hopeless cases so the agent knows whether to fight for
      // it (a survivor exists but won't finish now — maybe cull/declutter helps
      // next build) or accept the loss (none is enclosable at all this zone).
      const anyEnclosable = enclosureCandidatesFor().some(
        (candidate) =>
          candidate.status === "enclosable" && candidate.satisfiesSurvival,
      );
      bridge.lastResult = {
        kind: "build",
        success: false,
        reason: anyEnclosable
          ? "no survival seal fits the time left — an alive/revivable tower is enclosable but won't finish this build; the life is unavoidable now."
          : "no survival-clearing tower is enclosable in your zone — every alive/revivable tower leaks to the edge; the life is unavoidable this build.",
      };
      return observe();
    }
    return buildToward(saver.towerIdx, budget);
  }

  /** Greedy whole-castle build: enclose home, then every other tower that fits
   *  the time left (home-first, then cheapest/most-bonus), then PRE-CLAIM the
   *  cheapest unreachable tower's ring with whatever time/pieces remain — so
   *  spare build time is never idled. One call replaces chaining build({towerIdx})
   *  per tower and hand-budgeting time. See `buildOut` in McpGame for the contract. */
  function buildOut(budget?: BuildBudget): Observation {
    if (sc.state.phase !== Phase.WALL_BUILD) {
      bridge.lastResult = {
        kind: "build",
        success: false,
        reason: "not in WALL_BUILD",
      };
      return observe();
    }
    const startTimer = sc.state.timer;
    const compactBefore = compactnessSnapshot();
    // Stop building once the timer drops to this floor (reserve a beat; honour a
    // caller maxSeconds as a total-time cap across all the towers this call seals).
    const floorTimer =
      budget?.maxSeconds !== undefined
        ? Math.max(MIN_BUILD_LEFT_SEC, startTimer - budget.maxSeconds)
        : MIN_BUILD_LEFT_SEC;
    let piecesLeft = Math.min(
      budget?.maxPieces ?? MAX_BUILD_PIECES,
      MAX_BUILD_PIECES,
    );
    let totalPlaced = 0;
    const sealed: number[] = [];
    // Run one enclosure pass on `towerIdx`, bounded by the time/pieces still
    // budgeted across the whole call. Returns pieces placed this pass.
    const runOne = (towerIdx: number): number => {
      const { placed } = driveBuildLoop(towerIdx, sc.state.timer, piecesLeft, {
        maxSeconds: sc.state.timer - floorTimer,
        maxPieces: piecesLeft,
      });
      totalPlaced += placed;
      piecesLeft -= placed;
      return placed;
    };

    // Phase A — fully enclose every tower that fits, home first.
    while (sc.state.timer > floorTimer && piecesLeft > 0) {
      const target = nextExpandTarget();
      if (target?.towerIdx === undefined) break;
      const placed = runOne(target.towerIdx);
      const enclosed = sc.state.players[agentSlot]?.enclosedTowers.some(
        (tower) => tower.index === target.towerIdx,
      );
      if (enclosed) sealed.push(target.towerIdx);
      // Stop spinning if a "feasible" tower couldn't actually be sealed (a late
      // grunt-lock) or no piece landed — otherwise we'd loop on the same target.
      if (!enclosed || placed === 0) break;
    }

    // Phase B — pre-claim: bank partial ring progress on the cheapest tower that
    // doesn't fit, so next round's enclosure is cheaper. Spare time isn't idled.
    // BUT never trade leftover time away while no alive tower is enclosed: an
    // unsealed survival tower costs a LIFE and resets the whole zone at round
    // end, which a next-round-cheaper ring can't outweigh. Hold the spare time
    // for the survival seal (the caller can keep cycling the bag) instead of
    // pre-claiming a non-survival tower.
    let preclaim = "";
    const survives = survivesRoundEndLifeCheck(sc.state.players[agentSlot]!);
    if (survives && sc.state.timer > floorTimer && piecesLeft > 0) {
      const partial = cheapestPreclaimTarget();
      if (partial) {
        const placed = runOne(partial.towerIdx);
        if (placed > 0) {
          preclaim = `; pre-claimed ${placed} tile(s) of tower ${partial.towerIdx}'s ring for next round`;
        }
      }
    } else if (!survives && sc.state.timer > floorTimer && piecesLeft > 0) {
      preclaim =
        "; held spare time — no alive tower enclosed (pre-claim skipped; seal a survival tower first)";
    }

    const elapsed = Math.round((startTimer - sc.state.timer) * 10) / 10;
    bridge.lastResult = {
      kind: "build",
      success: totalPlaced > 0,
      reason:
        `expand: ${sealed.length > 0 ? `sealed [${sealed.join(",")}]` : "nothing new sealed"}, ` +
        `placed ${totalPlaced}, ~${elapsed}s${preclaim}${expansionDeltaNote(compactBefore)}`,
    };
    return observe();
  }

  /** Grunts standing inside `rect` right now — the count that an enclose-kill of
   *  this footprint would clear, for the buildRegion report. */
  function gruntsInRect(rect: TileRect): number {
    return sc.state.grunts.filter(
      (grunt) =>
        grunt.row >= rect.top &&
        grunt.row <= rect.bottom &&
        grunt.col >= rect.left &&
        grunt.col <= rect.right,
    ).length;
  }

  /** Enclose an arbitrary footprint by position (no tower needed) — walls the
   *  min-cut ring around `rect`, recomputing the cut each step as walls land,
   *  until it seals, stalls, or the budget/clock stops it. Grunts inside the
   *  sealed region are enclosed-killed by the engine's territory pass. See
   *  `buildRegion` in McpGame for the contract. */
  function buildRegion(
    rect: { top: number; bottom: number; left: number; right: number },
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
    const interior: TileRect = rect;
    const cutNow = (): Set<number> | null =>
      findEnclosureCut(
        [{ interior }],
        sc.state,
        sc.state.players[agentSlot]?.walls ?? new Set(),
        false,
      );
    if (cutNow() === null) {
      bridge.lastResult = {
        kind: "build",
        success: false,
        reason:
          "region unenclosable — its ring leaks to the map edge through water/pit; pick a footprint with a wallable perimeter",
      };
      return observe();
    }
    const startTimer = sc.state.timer;
    const compactBefore = compactnessSnapshot();
    const gruntsBefore = gruntsInRect(interior);
    const pieceCap = Math.min(
      budget?.maxPieces ?? MAX_BUILD_PIECES,
      MAX_BUILD_PIECES,
    );
    let placed = 0;
    let stall = 0;
    let outcome = "done";
    while (placed < pieceCap) {
      const stop = buildStop(placed, startTimer, pieceCap, budget);
      if (stop) {
        outcome = stop;
        break;
      }
      const cut = cutNow();
      if (cut === null) {
        outcome = "blocked";
        break;
      }
      if (cut.size === 0) {
        outcome = "done";
        break;
      }
      const step = placeTowardTargets(cut);
      if (step.noPiece) continue;
      if (step.landed) {
        placed++;
        if (step.onTarget) stall = 0;
        else stall++;
      } else {
        stall++;
      }
      if (stall >= BUILD_STALL_LIMIT) {
        outcome = "stuck";
        break;
      }
    }
    const gaps = cutNow()?.size ?? 0;
    const killed = gruntsBefore - gruntsInRect(interior);
    const elapsed = Math.round((startTimer - sc.state.timer) * 10) / 10;
    const killNote =
      outcome === "done" && killed > 0
        ? ` — enclosed-killed ${killed} grunt(s) inside`
        : gruntsBefore > 0 && gaps > 0
          ? ` — ${gaps} ring gap(s) left; ${gruntsInRect(interior)} grunt(s) still inside (not yet sealed)`
          : "";
    bridge.lastResult = {
      kind: "build",
      success: placed > 0 || outcome === "done",
      reason: `region: ${outcome}, placed ${placed}, ${gaps} gaps left, ~${elapsed}s${killNote}${expansionDeltaNote(compactBefore)}`,
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

  /** MY "fat" walls — redundant inner tiles whose every 8-dir neighbour is my own
   *  wall or interior (none faces outside). This is the exact non-load-bearing test
   *  `demolition` uses to strip walls: a single shell encloses the same territory,
   *  so each of these is a wasted piece and a target a tighter ring wouldn't expose.
   *  `me.interior` stands in for "inside" (a tile is wall / interior / outside), so a
   *  wall counts as load-bearing the moment any diagonal or orthogonal neighbour is
   *  off-board or outside. Before a pocket seals interior is empty, so nothing reads
   *  as fat — fat only exists once there's enclosed space behind the wall. */
  /** Attach the WALL_BUILD-only build surfaces (enclosure plan, suggestions,
   *  fragile/fat walls, compactness, extension hints). Split out of `observe` to
   *  keep that dispatcher under the complexity cap. */
  /** BATTLE aim-assist surfaces: opponent targets, pit targets, cannon-snipe
   *  nudge, declutter count. Split out of `observe` to keep its complexity in
   *  bounds (mirrors `attachBuildSurfaces`). */
  function attachBattleSurfaces(observation: Observation): void {
    const state = sc.state;
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
    // Pit targets only matter if I have a pit-capable gun (super or a
    // Mortar-elected normal) that can actually fire for me — an alive-but-
    // captured gun can't plant pits, so it shouldn't dangle pit targets I
    // can't act on.
    if (usablePitCannons().length > 0) {
      const pits = pitTargetsFor();
      if (pits.length > 0) observation.pitTargets = pits;
    }
    const snipe = cannonSnipeSuggestion();
    if (snipe) observation.cannonSnipe = snipe;
    const clearable = declutterFatTargets().length;
    if (clearable > 0) observation.fatClearable = clearable;
  }

  function attachBuildSurfaces(observation: Observation): void {
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
    const fat = fatWallsFor();
    if (fat.length > 0) observation.fatWalls = fat;
    const compactness = compactnessFor(fat.length);
    if (compactness) observation.compactness = compactness;
    const extensions = wallExtensionsFor();
    if (extensions.length > 0) observation.wallExtensions = extensions;
  }

  /** Live {interior, fat} reading — snapshot it before an expanding build and
   *  diff afterwards to report what the call cost (see `expansionDeltaNote`). */
  function compactnessSnapshot(): { interior: number; fat: number } {
    return {
      interior: sc.state.players[agentSlot]?.interior.size ?? 0,
      fat: fatWallsFor().length,
    };
  }

  /** The interior GAINED vs sunk fat BURIED since `before` — the honest cost/
   *  benefit of an expansion. A big interior gain for little fat is good; lots of
   *  fat for little gain is over-expansion (in classic that fat is unremovable),
   *  so the note nudges toward a compact `build_toward` next time. "" when nothing
   *  changed (the builder placed only frontier walls or did nothing). */
  function expansionDeltaNote(before: {
    interior: number;
    fat: number;
  }): string {
    const now = compactnessSnapshot();
    const dInterior = now.interior - before.interior;
    const dFat = now.fat - before.fat;
    if (dInterior === 0 && dFat === 0) return "";
    const heavy =
      dFat > 0 && dInterior < dFat * 4
        ? " — expansion-heavy: that fat is sunk (unremovable in classic); prefer a compact build_toward(<nearest>) next round"
        : "";
    return `; +${dInterior} interior, +${dFat} fat (now ${now.fat}/${now.interior})${heavy}`;
  }

  /** The standing compactness read for the given fat-wall count, or null when
   *  there's nothing enclosed yet. `interior` = my enclosed scoring tiles,
   *  `fatPer100` = sunk fat per 100 interior (the over-expansion trend number). */
  function compactnessFor(
    fatCount: number,
  ): { interior: number; fat: number; fatPer100: number } | null {
    const interior = sc.state.players[agentSlot]?.interior.size ?? 0;
    if (interior === 0 && fatCount === 0) return null;
    return {
      interior,
      fat: fatCount,
      fatPer100: Math.round((fatCount / Math.max(1, interior)) * 100),
    };
  }

  /** Build headroom: remaining enclosable land + the largest empty buildable
   *  rectangle still open in my zone (the dump-pocket gauge). See the `headroom`
   *  field doc on `Observation.me`. `null` before a castle/zone exists. */
  function headroomFor(): NonNullable<Observation["me"]["headroom"]> | null {
    const state = sc.state;
    const me = state.players[agentSlot];
    const zone = state.playerZones[agentSlot];
    if (!me || zone === undefined) return null;
    const zoneLand = myZoneLand();
    const used = me.interior.size + me.walls.size;
    let openPocket = { h: 0, w: 0 };
    const bounds = zoneBounds(state, zone);
    if (bounds) {
      const solid = solidTiles(me);
      const width = bounds.maxCol - bounds.minCol + 1;
      // Largest all-open rectangle via the column-height histogram sweep: per row
      // grow each column's run of open tiles, then take the biggest rectangle
      // under that histogram. Open = in-zone grass not occupied by wall/cannon/tower.
      const heights = new Array<number>(width).fill(0);
      for (let row = bounds.minRow; row <= bounds.maxRow; row++) {
        for (let ci = 0; ci < width; ci++) {
          const col = bounds.minCol + ci;
          const open =
            zoneAt(state.map, row, col) === zone &&
            !isWater(state.map.tiles, row, col) &&
            !solid.has(packTile(row, col));
          heights[ci] = open ? heights[ci]! + 1 : 0;
        }
        const best = largestRectInHistogram(heights);
        if (best.h * best.w > openPocket.h * openPocket.w) openPocket = best;
      }
    }
    return { zoneLand, used, free: Math.max(0, zoneLand - used), openPocket };
  }

  /** Largest-area rectangle (returned as height × width) under a histogram — the
   *  classic monotonic-stack sweep. Backs `headroomFor`'s open-pocket search. */
  function largestRectInHistogram(heights: readonly number[]): {
    h: number;
    w: number;
  } {
    const stack: number[] = [];
    let best = { h: 0, w: 0 };
    for (let i = 0; i <= heights.length; i++) {
      const cur = i < heights.length ? heights[i]! : 0;
      while (stack.length > 0 && heights[stack[stack.length - 1]!]! >= cur) {
        const height = heights[stack.pop()!]!;
        const left = stack.length === 0 ? 0 : stack[stack.length - 1]! + 1;
        const widthSpan = i - left;
        if (height * widthSpan > best.h * best.w) {
          best = { h: height, w: widthSpan };
        }
      }
      stack.push(i);
    }
    return best;
  }

  /** Severity-ranked verdict digest — see the `alerts` field doc. Reads the
   *  already-built observation's own fields so it can't drift from the detailed
   *  sections it summarizes. */
  function alertsFor(obs: Observation): string[] {
    const out: string[] = [];
    const me = obs.me;
    if (obs.phase === Phase.WALL_BUILD && !me.survivesRoundEnd) {
      out.push(
        "☠ SURVIVAL: no alive tower enclosed — finalizing loses a life + your zone resets. Seal a survival-clearing tower (see ENCLOSURE CANDIDATES).",
      );
    }
    if (me.bagLocked) {
      out.push(
        `⚠ BAG-LOCK: piece ${me.currentPiece ?? "?"} has no legal placement anywhere — you can build nothing this phase (the bag only advances by placing).`,
      );
    } else if (
      me.dumpCapacity &&
      me.dumpCapacity.placeable < me.dumpCapacity.pool
    ) {
      out.push(
        `⚠ BAG-LOCK RISK: only ${me.dumpCapacity.placeable}/${me.dumpCapacity.pool} draw-pool shapes fit — keep an open 3×3 dump pocket (declutter in battle / stop packing every seam).`,
      );
    }
    if (
      obs.cannonSuggestions &&
      obs.cannonSuggestions.length > 0 &&
      obs.cannonSuggestions.every((spot) => spot.routable === false)
    ) {
      out.push(
        "⚠ CANNONS: no routable spot — every affordable footprint pinches the re-seal route (place FEWER cannons / expand your interior first).",
      );
    }
    const exposed = (obs.threats ?? []).filter(
      (threat) => !threat.towerEnclosed,
    ).length;
    if (exposed > 0) {
      out.push(
        `⚠ EXPOSED: ${exposed} grunt(s) can reach an unwalled tower — wall the tower this build or cull it in battle.`,
      );
    }
    if (obs.compactness && obs.compactness.fatPer100 >= 20) {
      out.push(
        `▣ FAT: ${obs.compactness.fatPer100} fat/100 — you're expanding past old shells; prefer build_toward(<nearest>) over build_out.`,
      );
    }
    if (me.headroom && me.headroom.openPocket.h > 0) {
      const { h, w } = me.headroom.openPocket;
      if (Math.min(h, w) < 3) {
        out.push(
          `⊞ TIGHT: largest open pocket ${h}×${w} (<3×3) — little dump room left; place cannons sparingly and reserve a pocket.`,
        );
      }
    }
    return out;
  }

  function fatWallsFor(): { row: number; col: number }[] {
    const me = sc.state.players[agentSlot];
    if (!me) return [];
    const out: { row: number; col: number }[] = [];
    for (const key of me.walls) {
      const { row, col } = unpackTile(key as Parameters<typeof unpackTile>[0]);
      let loadBearing = false;
      for (const [dr, dc] of DIRS_8) {
        const nr = row + dr;
        const nc = col + dc;
        if (!inBounds(nr, nc)) {
          loadBearing = true;
          break;
        }
        const nkey = packTile(nr, nc);
        if (!me.walls.has(nkey) && !me.interior.has(nkey)) {
          loadBearing = true;
          break;
        }
      }
      if (!loadBearing) out.push({ row, col });
    }
    return out;
  }

  /** Loose wall ends that can be productively extended toward closing a tower:
   *  for each fragile stub within `WALL_EXTEND_RADIUS` of an un-closed enclosure
   *  gap, the next buildable step toward the nearest gap. A sealed castle has no
   *  open gaps, so its stubs yield nothing here — the constructive counterpart to
   *  "leave a finished castle's stubs alone". Reuses the planner's min-cut tiles,
   *  so an extension hint agrees with where `build_toward` would seal. */
  function wallExtensionsFor(): WallExtension[] {
    const me = sc.state.players[agentSlot];
    if (!me) return [];
    const fragile = fragileWallsFor();
    if (fragile.length === 0) return [];
    const gaps: { row: number; col: number }[] = [];
    for (const cand of enclosureCandidatesFor()) {
      if (cand.status === "enclosable") gaps.push(...cand.tiles);
    }
    if (gaps.length === 0) return [];
    const solid = solidTiles(me);
    const out: WallExtension[] = [];
    for (const stub of fragile) {
      let nearest: { row: number; col: number } | null = null;
      let nearestDist = Infinity;
      for (const gap of gaps) {
        const dist =
          Math.abs(gap.row - stub.row) + Math.abs(gap.col - stub.col);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = gap;
        }
      }
      if (!nearest || nearestDist > WALL_EXTEND_RADIUS) continue;
      const next = stepToward(stub, nearest, solid);
      if (next) out.push({ from: stub, next, toward: nearest });
      if (out.length >= MAX_WALL_EXTENSIONS) break;
    }
    return out;
  }

  /** The buildable orthogonal neighbour of `from` that most reduces Manhattan
   *  distance to `target` — the first step of extending a stub toward a gap.
   *  Must STRICTLY improve on `from`'s own distance (init bestDist to it), so a
   *  stub boxed away from the gap yields null instead of a backward step. Skips
   *  off-board / water / solid (wall, tower, cannon) cells; the placer still
   *  enforces full legality. */
  function stepToward(
    from: { row: number; col: number },
    target: { row: number; col: number },
    solid: Set<number>,
  ): { row: number; col: number } | null {
    let best: { row: number; col: number } | null = null;
    let bestDist =
      Math.abs(target.row - from.row) + Math.abs(target.col - from.col);
    for (const [dr, dc] of DIRS_4) {
      const row = from.row + dr;
      const col = from.col + dc;
      if (!inBounds(row, col)) continue;
      if (isWater(sc.state.map.tiles, row, col)) continue;
      if (solid.has(packTile(row, col))) continue;
      const dist = Math.abs(target.row - row) + Math.abs(target.col - col);
      if (dist < bestDist) {
        bestDist = dist;
        best = { row, col };
      }
    }
    return best;
  }

  /** Bombard one opponent's walls for the rest of the battle (or `quanta` action
   *  quanta): waits out the countdown, then fires every ready cannon at their
   *  nearest walls, pacing to reload, until their walls clear, the battle ends,
   *  or the budget runs out. Collapses a whole battle of fire/pass micro into one
   *  call. Returns the walls destroyed + points scored. */
  function bombardSlot(
    targetSlot: number,
    quanta?: number,
    mode: "spread" | "choke" = "spread",
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
    const wallsBefore = sc.state.players[targetSlot]?.walls.size ?? 0;
    const scoreBefore = me?.score ?? 0;
    const myWallsBefore = new Set(me?.walls);
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
      const tiles = attackWallTiles(targetSlot, origin, mode);
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
      reason: `${
        mode === "choke" ? "choke-bombard" : "bombard"
      }: fired ${fired}, +${pointsGained} pts (target lost ${wallsDestroyed} walls)${battleSelfReport(
        myWallsBefore,
        inertBefore,
      )}`,
    };
    return observe();
  }

  /** Is the next cannon to fire (strict round-robin `cannonRotationIdx`) a
   *  pit-capable gun (a super, or a Mortar-elected normal / seized enemy super)?
   *  The firing ORDER is fixed by the rules — a player can't skip or reorder
   *  cannons — but they DO aim each shot. So during a SELF-targeted volley
   *  (declutter at my own fat, cull at my own grunts) we peek this and, when a
   *  pit gun is up, aim it at the ENEMY instead of my own tile. A pit only forms
   *  where an incendiary ball razes a standing wall (`computeImpact`), and the
   *  shooter-own-walls rule (`surface-elevation.ts`) makes my own walls
   *  altitude-0 to my own ball at every non-aim tile — so a pit gun aimed at the
   *  enemy either pits the enemy (bonus) or falls short into water, but can NEVER
   *  plant a pit on my own walls. Aiming-only ⇒ fully rule-legal. */
  function pitGunIsNext(): boolean {
    const shooter = sc.state.players[agentSlot];
    if (!shooter) return false;
    const next = nextReadyCannon(
      sc.state,
      agentSlot,
      shooter.cannonRotationIdx,
    );
    if (!next) return false;
    return (
      (next.type === "own" && isPitCapable(shooter.cannons[next.ownIdx]!)) ||
      (next.type === "captured" && isPitCapable(next.captured.cannon))
    );
  }

  /** The pit-safe redirect tile for a pit gun fired during a self-targeted
   *  volley: the leading living opponent's wall nearest my battery. Aiming a
   *  super/Mortar here can't pit my zone (shooter-own-walls rule, see
   *  `pitGunIsNext`) — worst case the ball falls short into the river. Null when
   *  no opponent has a standing wall to aim at (then the caller must NOT fire the
   *  pit gun at my own tile). */
  function pitGunRedirectAim(): { row: number; col: number } | null {
    const origin = cannonCentroid();
    const opp = sc.state.players
      .map((player, slot) => ({ player, slot }))
      .filter(
        ({ player, slot }) =>
          slot !== agentSlot && !player.eliminated && player.walls.size > 0,
      )
      .sort((a, b) => b.player.score - a.player.score)[0];
    if (!opp) return null;
    return sampleWallTiles(opp.player.walls, 1, origin)[0] ?? null;
  }

  /** BATTLE: aim every ready cannon at the GRUNTS menacing YOUR towers — the
   *  defensive counterpart to bombard/breach. During BATTLE grunts are frozen
   *  (they move only in WALL_BUILD), so the swarm that will box your reseal next
   *  build sits at known tiles RIGHT NOW; a cannonball on a grunt's tile kills it
   *  (one shot, and since the grunt stands on grass the ball clears it without
   *  touching your wall). Fires the in-zone `threatsFor()` grunts closest-first,
   *  re-reading each volley so killed grunts drop and the next-nearest takes
   *  over; a grunt that survives a shot is out of cannon range and is skipped so
   *  the volley never hammers an unreachable tile. Stops early once the zone is
   *  clear — handing the rest of the battle back (bombard to use it) — or at the
   *  `quanta` cap. Live-gated and reload-paced exactly like bombard (no clock
   *  exploit). Trades this battle's offence for an un-boxable reseal: the move
   *  when "+N grunts behind your walls" or a DRIFT lock is what's killing you. */
  function cullGrunts(quanta?: number): Observation {
    if (sc.state.phase !== Phase.BATTLE) {
      bridge.lastResult = {
        kind: "fire",
        success: false,
        reason: "not in BATTLE",
      };
      return observe();
    }
    const allThreats = threatsFor();
    if (allThreats.length === 0) {
      bridge.lastResult = {
        kind: "fire",
        success: false,
        reason:
          "no grunts threatening your towers — nothing to cull (bombard/breach an opponent instead)",
      };
      return observe();
    }
    if (!allThreats.some((threat) => threat.hittable)) {
      bridge.lastResult = {
        kind: "fire",
        success: false,
        reason:
          "every threatening grunt is occluded behind a wall/tower — no shot can land on them under the battle tilt (bombard/breach an opponent, or wait for the cover to clear)",
      };
      return observe();
    }
    const me = sc.state.players[agentSlot];
    const myZone = sc.state.playerZones[agentSlot];
    const inZoneGrunts = (): number =>
      myZone === undefined
        ? 0
        : sc.state.grunts.filter(
            (grunt) => zoneAt(sc.state.map, grunt.row, grunt.col) === myZone,
          ).length;
    const gruntsBefore = inZoneGrunts();
    const scoreBefore = me?.score ?? 0;
    const myWallsBefore = new Set(me?.walls);
    const inertBefore = cannonsUnenclosedCount();
    const budget = quanta ?? Infinity;
    // Tiles already shot at whose grunt survived — out of cannon range, so don't
    // re-aim there (else one unreachable grunt eats the whole battle).
    const spentOn = new Set<number>();
    // Aim nearest-my-cannons first: a far grunt menacing a corner tower is the
    // top THREAT but out of range — firing there whiffs while a reachable grunt
    // waits. Cannon-proximity lands the shot AND tracks the home tower (guns sit
    // by it), so cull spends its volleys on grunts it can actually kill.
    const origin = cannonCentroid();
    const reach = (threat: ThreatInfo): number =>
      (threat.grunt.row - origin.row) ** 2 +
      (threat.grunt.col - origin.col) ** 2;
    let spent = 0;
    let fired = 0;
    let redirected = 0;
    while (!gameOver() && sc.state.phase === Phase.BATTLE && spent < budget) {
      const threats = threatsFor()
        .filter(
          (threat) =>
            threat.hittable &&
            !spentOn.has(packTile(threat.grunt.row, threat.grunt.col)),
        )
        .sort((a, b) => reach(a) - reach(b));
      // Zone clear (or only unreachable grunts left) — hand the rest of the
      // battle back so the agent can bombard the time that remains.
      if (threats.length === 0) break;
      const live = sc.state.battleCountdown <= 0 && sc.state.timer > 0;
      const canFire = live && cannonsReadyCount() > 0;
      if (!canFire) {
        advance(actionTicks);
        settleToDecision();
        spent++;
        continue;
      }
      const ready = cannonsReadyCount();
      let threatIdx = 0;
      for (let shot = 0; shot < ready && threatIdx < threats.length; shot++) {
        if (sc.state.phase !== Phase.BATTLE || gameOver()) break;
        // A pit gun aimed at a grunt could splash/miss onto a wall and plant a
        // pit in MY zone — so when one is next in the firing rotation, redirect
        // it at the enemy (pit-safe; see `pitGunIsNext`). It doesn't help cull,
        // so it doesn't consume a threat slot — the normals keep clearing.
        if (pitGunIsNext()) {
          const enemyAim = pitGunRedirectAim();
          if (!enemyAim) {
            // No pit-safe target — don't fire the pit gun at my own grunt/wall.
            advance(actionTicks);
            settleToDecision();
            spent++;
            break;
          }
          bridge.pending = {
            kind: "fire",
            row: enemyAim.row,
            col: enemyAim.col,
          };
          advance(actionTicks);
          settleToDecision();
          fired++;
          spent++;
          redirected++;
          continue;
        }
        const grunt = threats[threatIdx]!.grunt;
        threatIdx++;
        spentOn.add(packTile(grunt.row, grunt.col));
        bridge.pending = { kind: "fire", row: grunt.row, col: grunt.col };
        advance(actionTicks);
        settleToDecision();
        fired++;
        spent++;
      }
    }
    const culled = gruntsBefore - inZoneGrunts();
    const pointsGained =
      (sc.state.players[agentSlot]?.score ?? 0) - scoreBefore;
    bridge.lastResult = {
      kind: "fire",
      success: fired > 0,
      reason: `fired ${fired}, culled ${culled} grunt(s) threatening your towers${
        pointsGained > 0 ? ` (+${pointsGained} pts)` : ""
      }${
        redirected > 0
          ? ` (${redirected} super/Mortar shot(s) redirected at the enemy to avoid self-pitting)`
          : ""
      }${battleSelfReport(myWallsBefore, inertBefore)}`,
    };
    return observe();
  }

  /** Aim-reachable fat walls, ordered as a CONTIGUOUS clearance front so the shots
   *  open ONE usable dump-pocket rather than scattering single-tile holes (a 2×2+
   *  opening defuses the bag-lock; isolated 1-tile holes only fit a 1×1). Seeds at
   *  the fat tile nearest my cannons (the side a shot reaches first) and BFS-grows
   *  over 4-connected fat. Fat walls are non-load-bearing by construction (every
   *  8-neighbour is my own wall/interior — `fatWallsFor`), so removing any of them
   *  can never connect interior to outside: enclosure is preserved without a
   *  re-check. Tower-occluded fat is dropped (`aimReachesTile`) — a cannonball
   *  can't land on a tile hidden behind a taller tower. */
  function declutterFatTargets(): { row: number; col: number }[] {
    const reachable = fatWallsFor().filter((tile) =>
      aimReachesTile(sc.state, tile.row, tile.col),
    );
    if (reachable.length === 0) return [];
    const fatSet = new Set(
      reachable.map((tile) => packTile(tile.row, tile.col)),
    );
    const origin = cannonCentroid();
    let seed = reachable[0]!;
    let bestDist = Infinity;
    for (const tile of reachable) {
      const dist = (tile.row - origin.row) ** 2 + (tile.col - origin.col) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        seed = tile;
      }
    }
    const order: { row: number; col: number }[] = [];
    const seen = new Set<number>([packTile(seed.row, seed.col)]);
    const queue: { row: number; col: number }[] = [seed];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      order.push(cur);
      for (const [dr, dc] of DIRS_4) {
        const nr = cur.row + dr;
        const nc = cur.col + dc;
        const nkey = packTile(nr, nc);
        if (fatSet.has(nkey) && !seen.has(nkey)) {
          seen.add(nkey);
          queue.push({ row: nr, col: nc });
        }
      }
    }
    return order;
  }

  /** BATTLE: fire MY battery at MY redundant inner ("fat") walls to reopen a build
   *  pocket — the structural sibling of `cull` (cull clears the grunts that box a
   *  reseal; declutter clears the walls that box the piece bag). Only enclosure-safe
   *  fat is shot (see `declutterFatTargets`), the clearance is contiguous, and it
   *  scores nothing (own walls) — a deliberate tempo spend that buys the build-phase
   *  room which prevents a bag-lock life-loss. Same live-gated, reload-paced firing
   *  as cull/bombard. */
  function declutterWalls(quanta?: number): Observation {
    if (sc.state.phase !== Phase.BATTLE) {
      bridge.lastResult = {
        kind: "fire",
        success: false,
        reason: "not in BATTLE (declutter shoots out fat walls during battle)",
      };
      return observe();
    }
    const targets = declutterFatTargets();
    if (targets.length === 0) {
      const anyFat = fatWallsFor().length > 0;
      bridge.lastResult = {
        kind: "fire",
        success: false,
        reason: anyFat
          ? "your fat walls are all tower-occluded — no cannonball can land on them (bombard/cull instead)"
          : "no fat walls to clear — your castle is already lean (bombard/cull/breach an opponent instead)",
      };
      return observe();
    }
    const me = sc.state.players[agentSlot];
    const scoreBefore = me?.score ?? 0;
    const myWallsBefore = new Set(me?.walls);
    const inertBefore = cannonsUnenclosedCount();
    const budget = quanta ?? Infinity;
    const firedTiles = new Set<ReturnType<typeof packTile>>();
    let spent = 0;
    let fired = 0;
    let redirected = 0;
    let idx = 0;
    while (
      !gameOver() &&
      sc.state.phase === Phase.BATTLE &&
      spent < budget &&
      idx < targets.length
    ) {
      const live = sc.state.battleCountdown <= 0 && sc.state.timer > 0;
      const canFire = live && cannonsReadyCount() > 0;
      if (!canFire) {
        advance(actionTicks);
        settleToDecision();
        spent++;
        continue;
      }
      const ready = cannonsReadyCount();
      for (let shot = 0; shot < ready && idx < targets.length; shot++) {
        if (sc.state.phase !== Phase.BATTLE || gameOver()) break;
        // A pit gun fired at my own fat wall plants a burning pit on the exact
        // grass tile declutter just freed — defeating the call. Firing order is
        // fixed by the rules, but aim isn't: when a pit gun is next, redirect it
        // at the enemy (pit-safe; see `pitGunIsNext`). It clears no fat, so it
        // doesn't consume a target — the normals keep opening the dump pocket.
        if (pitGunIsNext()) {
          const enemyAim = pitGunRedirectAim();
          if (!enemyAim) {
            // No pit-safe target — don't fire the pit gun at my own fat.
            advance(actionTicks);
            settleToDecision();
            spent++;
            break;
          }
          bridge.pending = {
            kind: "fire",
            row: enemyAim.row,
            col: enemyAim.col,
          };
          advance(actionTicks);
          settleToDecision();
          fired++;
          spent++;
          redirected++;
          continue;
        }
        const tile = targets[idx]!;
        idx++;
        const tileKey = packTile(tile.row, tile.col);
        // A fat tile already cleared by splash from a prior shot needs no volley.
        if (!sc.state.players[agentSlot]?.walls.has(tileKey)) continue;
        firedTiles.add(tileKey);
        bridge.pending = { kind: "fire", row: tile.row, col: tile.col };
        advance(actionTicks);
        settleToDecision();
        fired++;
        spent++;
      }
    }
    // "Freed interior" = the fat tiles I myself shot out, NOT the gross wall
    // delta (which would fold in incidental return-fire on my outer ring — that
    // opens the ring, it doesn't free a build pocket). Return-fire is reported
    // separately by battleSelfReport.
    const nowWalls = sc.state.players[agentSlot]?.walls;
    let cleared = 0;
    for (const key of firedTiles) if (!nowWalls?.has(key)) cleared++;
    const pointsGained =
      (sc.state.players[agentSlot]?.score ?? 0) - scoreBefore;
    bridge.lastResult = {
      kind: "fire",
      success: cleared > 0,
      reason: `fired ${fired}, cleared ${cleared} fat wall(s) — freed that many interior tiles for next build (declutter scores 0; it's a tempo spend to prevent a bag-lock)${
        pointsGained > 0 ? `; +${pointsGained} incidental pts` : ""
      }${
        redirected > 0
          ? `; ${redirected} super/Mortar shot(s) redirected at the enemy to avoid self-pitting`
          : ""
      }${battleSelfReport(myWallsBefore, inertBefore, firedTiles)}`,
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

  /** The best enemy wall tiles to plant a super-cannon pit on — sourced from the
   *  engine's MIN-CUT (`findMinBreach`, the same finder `breach` drills): the
   *  fewest walls whose removal de-encloses. A pit on a cut tile costs them a
   *  load-bearing wall, so the reseal is a costlier re-route (lost tiles +
   *  territory) — a TAX, not a denial: measurement shows the AI re-encloses ~90%
   *  of pit-targeted towers next build regardless (it routes the ring around the
   *  pit; spread/concentrate/bombard all ~85-90% reseal). A pit only DENIES a
   *  reseal at a true geographic pinch (a 1-wide neck walled by water/edge), which
   *  rarely lands on a cut tile. Still strictly better than the old `chokeScore`
   *  aim, which wasted pits on outer-fringe walls that cost nothing to route
   *  around. The cut is spread shell-first along the real neck. `choke` is
   *  advisory display only (un-reroutability), NOT the ordering. A few per
   *  opponent, tower-rings first (findMinBreach's order). */
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
      // The live min-cut against this opponent's CURRENT walls — only their
      // still-intact enclosures seed it, so once a ring is breached its tiles
      // drop out and re-aim moves to the next-cheapest cut (the shell beneath).
      const cut = findMinBreach(sc.state, opponent, BREACH_MAX_TILES);
      if (!cut || cut.length === 0) continue;
      for (const { row, col } of cut.slice(0, PIT_TARGETS_PER_OPPONENT)) {
        const tower = opponent.enclosedTowers.find((entry) =>
          near(row, col, entry.row, entry.col),
        );
        out.push({
          slot,
          row,
          col,
          choke: chokeScore(row, col),
          towerIdx: tower ? (tower.index as number) : null,
        });
      }
    }
    return out;
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

  /** Concentrate fire to DE-ENCLOSE an opponent's territory — the targeted
   *  counterpart to `bombard`'s spread. Where bombard maximises raw wall count
   *  destroyed (points + general tax), breach drills the engine's own MIN-CUT:
   *  the FEWEST walls whose removal lets the 8-dir enclosure flood reach a
   *  defended interior (a diagonal staircase through a ring of any thickness).
   *  With `towerIdx` it cuts exactly that tower's ring (`findTowerBreach`);
   *  omitted, it runs the whole-castle min-cut (`findMinBreach`) — opening every
   *  intact tower-ring it can afford, tower-rings first, cheapest-first. Either
   *  way the opened pocket scores zero next build unless they reseal it, and its
   *  bonus squares fall out of their interior. Falls back to the nearest-arc
   *  radius heuristic only when no min-cut is breachable (so the volley still
   *  chips walls for points). Same fairness as bombard — fires only while the
   *  battle is live, one ready cannon per shot, paced to reload. */
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
    const myWallsBefore = new Set(me?.walls);
    const inertBefore = cannonsUnenclosedCount();
    const stillEnclosed = () =>
      sc.state.players[targetSlot]?.enclosedTowers.some(
        (enc) => enc.index === tower.towerIdx,
      ) ?? false;
    let fired = 0;
    let usedMinCut = false;
    while (!gameOver() && sc.state.phase === Phase.BATTLE) {
      const target = sc.state.players[targetSlot];
      const live = sc.state.battleCountdown <= 0 && sc.state.timer > 0;
      // True min-cut first (per-tower or whole-castle), recomputed each volley so
      // a ring that just opened drops out and the next-cheapest cut takes over.
      // Radius nibbling is only the tail once nothing intact is breachable.
      const minCut =
        target === undefined
          ? null
          : towerIdx !== undefined
            ? findTowerBreach(
                sc.state,
                target,
                tower.towerIdx,
                BREACH_MAX_TILES,
              )
            : findMinBreach(sc.state, target, BREACH_MAX_TILES);
      if (minCut && minCut.length > 0) usedMinCut = true;
      const tiles = minCut ?? breachTilesFor(targetSlot, tower);
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
    const aim = usedMinCut
      ? "min-cut"
      : "radius fallback (no min-cut breachable)";
    const scope = towerIdx !== undefined ? `tower ${tower.towerIdx}` : "castle";
    bridge.lastResult = {
      kind: "fire",
      success: fired > 0,
      reason: `breached ${scope} (${aim}): fired ${fired}, +${pointsGained} pts (ring lost ${wallsDestroyed} walls${
        stillEnclosed() ? "" : ", pocket OPEN"
      })${battleSelfReport(myWallsBefore, inertBefore)}`,
    };
    return observe();
  }

  /** Drive the whole battle like bombard, but AIM super cannons at `targets`
   *  (enemy wall tiles) to plant burning pits while normals spread-chip `slot`.
   *  Each shot peeks `nextReadyCannon` (own + balloon-seized roster — fair) and,
   *  when a pit gun (own super/Mortar OR a seized enemy super) is next, redirects
   *  it onto the next still-walled, not-yet-pitted target;
   *  everything else spreads like bombard. A pit only forms on a WALL hit and
   *  blocks rebuilding for BURNING_PIT_DURATION rounds, so this TAXES a reseal
   *  (costlier re-route) more than a bombard hit — but rarely denies it outright
   *  (the AI routes around scattered pits; ~90% of pit-targeted towers re-enclose
   *  next build). Same fairness as bombard (live-gated, reload-paced). */
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
    // A pit needs a pit-capable gun (a super, or a Mortar-elected normal) that
    // can actually fire for ME. A captured (or destroyed/unenclosed) gun looks
    // armed but plants nothing — fall back to a plain bombard and SAY why,
    // instead of running a doomed strike that reports 0 pits with a misleading
    // "reloading / battle ended" note.
    if (usablePitCannons().length === 0) {
      // Snapshot WHY before bombarding — bombardSlot runs the whole battle, and
      // a capture is released at battle end, so reading the reason afterwards
      // would lose the "captured by X" detail.
      const why = pitGunUnusableReason();
      bombardSlot(targetSlot);
      if (why && bridge.lastResult?.reason) {
        bridge.lastResult.reason = `pit-strike → bombard (${why}); ${bridge.lastResult.reason}`;
      }
      return observe();
    }
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
    const myWallsBefore = new Set(me?.walls);
    const inertBefore = cannonsUnenclosedCount();
    // Every tile a pit-gun shot actually aimed at (bound or re-aimed) — counting
    // pits over THIS set credits re-aimed fresh tiles too, which a fixed
    // pitTiles snapshot would miss.
    const pitAims = new Set<number>();
    let fired = 0;
    let pitShots = 0;
    let pitDry = 0;
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
        const pitNext =
          (next?.type === "own" &&
            isPitCapable(shooter!.cannons[next.ownIdx]!)) ||
          (next?.type === "captured" && isPitCapable(next.captured.cannon));
        let aim = spread[shot]!;
        if (pitNext) {
          const pit = nextPitAim(pitIdx);
          if (pit) {
            aim = pit;
            pitIdx++;
            pitShots++;
            pitAims.add(packTile(pit.row, pit.col));
          } else {
            pitDry++;
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
    const pitsPlanted = [...pitAims].filter((key) => {
      const { row, col } = unpackTile(key as Parameters<typeof unpackTile>[0]);
      return hasPitAt(sc.state.burningPits, row, col);
    }).length;
    const pitNote = pitDryNote(pitShots, pitDry, autoTargets);
    bridge.lastResult = {
      kind: "fire",
      success: fired > 0,
      reason: `pit-strike slot ${targetSlot}: fired ${fired} (${pitShots} pit-gun→pit), +${pointsGained} pts, target lost ${wallsDestroyed} walls, ${pitsPlanted} pit(s) planted${pitNote}${battleSelfReport(
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
    sealSurvivor,
    buildOut,
    buildRegion,
    path: buildPath,
    bombard: bombardSlot,
    breach: breachSlot,
    pitStrike,
    cull: cullGrunts,
    declutter: declutterWalls,
    enclosurePlan,
    check,
    placements: placementsInZone,
    agentSlot,
    scenario: sc,
  };
}

/** Why a pit-strike planted 0 pits — appended to the result line ONLY when the
 *  pit gun (super or Mortar-elected normal) truly planted nothing, so a working
 *  strike stays terse. A 0-pit strike was previously indistinguishable from a
 *  successful one; this names the cause (razed targets vs stale explicit aim vs
 *  the gun never getting a live shot). */
function pitDryNote(
  pitShots: number,
  pitDry: number,
  autoTargets: boolean,
): string {
  if (pitShots > 0) return "";
  if (pitDry > 0) {
    return autoTargets
      ? "; ⚠ pit gun planted no pits — no standing tower-ring wall left to pit (the choke walls were already razed)"
      : "; ⚠ pit gun planted no pits — your target tiles weren't standing enemy walls when it fired (omit targets to auto-aim live ring walls)";
  }
  return "; ⚠ pit gun never fired a pit shot (reloading, inert/unenclosed, or the battle ended first)";
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
      return "Re-seal/expand your castle. Fastest for the WHOLE phase: build_out() encloses home then every tower that fits the time left, then pre-claims the next tower's ring — one call, spare time never idled (use this by default unless you want a specific tower or to reserve time). build_toward({ towerIdx }) encloses ONE tower (omit towerIdx = home); add { maxSeconds | maxPieces } to stop early and reserve time for a defensive build. build_path({ from, to }) lays a straight/L wall line to pre-claim or bridge towers across rounds — anchor both ends on existing wall or it erodes (watch fragileWalls). Or place pieces by hand: act { kind: 'build', row, col, rotation }. Or pass.";
    case Phase.CANNON_PLACE:
      return "Place a cannon at its top-left — act { kind: 'cannon', row, col, mode }. See cannonSuggestions for legal spots you can afford, grouped by mode (no 'super' line = no 3x3 fits). Footprint: normal/balloon 2x2, super 3x3. Watch me.cannonSlots (used/max). End early with { kind: 'cannon-done' }, or pass.";
    case Phase.UPGRADE_PICK:
      return "Pick ONE of your three upgrade offers — act { kind: 'pick-upgrade', cardIdx } where cardIdx is 0, 1, or 2 (the index into observation.upgradeOffers; each lists id + label + description). The pick applies for the next round only. There's no skip — choose the offer that best fits your board (e.g. second_wind if you have dead towers, clear_the_field if grunts crowd your zone).";
    case Phase.BATTLE:
      return "Attack an opponent for the whole battle (one call). Strategies: bombard({ slot, mode? }) SPREADS fire over their nearest walls — maximises wall count destroyed (points + general tax); pass mode:'choke' to instead concentrate normal fire on their load-bearing ring walls (pit_strike's aim without the pit — a HEAVIER wall-tax, costlier for them to patch; it does NOT de-enclose — the AI re-routes and re-encloses next build either way). breach({ slot, towerIdx? }) drills the engine's MIN-CUT to de-enclose a pocket — the fewest walls whose removal lets the 8-dir flood reach the interior (a diagonal staircase through a ring of any thickness): towerIdx cuts exactly that tower's ring, omitted runs the whole-castle min-cut (opens every intact tower-ring it can afford, cheapest first). Denies that territory + bonus squares next build. pit_strike({ slot, targets? }) aims your pit gun(s) — a SUPER, or a normal the MORTAR upgrade elected this battle — at enemy wall tiles to plant burning PITS (a tempo/territory TAX — pits a load-bearing wall so their reseal is a costlier re-route, but rarely denies it: the AI re-encloses ~90% of pit-targeted towers anyway) while normals chip — see pitTargets for the best min-cut walls; omit targets to use them. cull() is DEFENSIVE — fire at the GRUNTS menacing your OWN towers (observation.threats) instead of an opponent; grunts are frozen this phase, so the swarm that would box your reseal next build is killable now (one shot each). Reach for it when 'grunts behind your walls' is climbing or a reseal is grunt-locked. declutter() is SELF-MAINTENANCE — fire at your OWN redundant inner (fat) walls to shoot a build pocket back open (enclosure-safe, scores 0); the proactive escape from a bag-lock when your castle has packed toward single-tile seams (watch observation.fatClearable). See targets (leader first; each lists towers with ringWalls + bonusSquares). Or aim by hand: act { kind: 'fire', row, col } (wait out battleCountdown > 0; fire at most me.cannonsReady per burst, then pass to reload) — this is also how you SNIPE an enemy cannon: a ball on its tile damages it and ~cannonMaxHp hits DESTROY it (fewer enemy guns + wreck-debris blocks their rebuild). Worth it over bombard only sometimes (you hold Salvage, or they field a super/Mortar gun) — see observation.cannonSnipe, surfaced just then.";
    default:
      return "No agent action this phase; call pass to advance.";
  }
}
