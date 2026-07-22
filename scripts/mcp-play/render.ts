/**
 * Server-side observation renderer for mcp-play — the same annotated ASCII board
 * the throwaway `tmp/show.py` lens produced, ported to TypeScript so the MCP
 * server can return a ready-to-read board instead of raw JSON. An agent driving
 * the server through live tool calls then sees the rendered battlefield directly
 * after every action, with no separate render step.
 *
 * `renderObservation` consumes ONLY the public `Observation` shape (imported as a
 * type), so it pulls none of the harness's runtime deps. The harness's own
 * `observe()` still returns the structured object — tests consume that directly;
 * only the server's tool-result serialization goes through here.
 *
 * dev/research tool — never wired into determinism or parity suites.
 */

import { LEGEND_LINE_COUNT } from "../../dev/dev-console-grid.ts";
import type { CannonMode } from "../../src/shared/core/battle-types.ts";
import type { Observation } from "./harness.ts";

type CannonSpots = NonNullable<Observation["cannonSuggestions"]>;

/** Cumulative count of cannons the agent has successfully placed this session,
 *  by mode. Session state owned by the server (like `seenBlocks`) and threaded
 *  in — the CANNON_PLACE skew nudge (`cannonSkewLines`) reads it to pattern-
 *  interrupt a mode monoculture. */
export type CannonModeTally = Record<CannonMode, number>;

/** Show-once gate threaded into the section helpers: returns `full` the first
 *  time `key` is seen in a session, `terse` thereafter. See `renderObservation`. */
type Once = (key: string, full: string, terse: string) => string;

/** A rectangular region of the board worth inspecting, with a name the agent
 *  passes to `observe({roi})` and a one-line reason. Computed from the same
 *  structured signals the annotation sections already carry (the min-cut,
 *  threats, grunt clusters, breach targets, castle bounds) — so a "view" points
 *  at real geometry, never a guess. */
export interface RoiRect {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}

export interface RoiEntry {
  name: string;
  rect: RoiRect;
  why: string;
}

/** Placements of `normal` before the skew nudge starts firing — high enough to
 *  read as an entrenched habit across rounds, not first-round noise. */
const NORMAL_SKEW_THRESHOLD = 8;
/** Placements of a single non-normal mode before the monoculture nudge fires.
 *  Lower than the normal threshold: leaning entirely on balloons (single-use,
 *  3 slots, gone after battle) or supers (4 slots) starves the standing battery
 *  faster than a normal habit does, so it's worth interrupting sooner. */
const NONNORMAL_SKEW_THRESHOLD = 4;
/** Terse one-line replacements for the per-phase EXPECTED menus, keyed by the
 *  `Observation.phase` string. The full menu (from `expectedFor` in harness.ts)
 *  is emitted the FIRST time a phase is seen in a session; thereafter a stateful
 *  agent that already read it gets this pointer instead. */
const TERSE_EXPECTED: Record<string, string> = {
  CASTLE_SELECT: "CASTLE_SELECT — select { towerIdx } a home tower.",
  WALL_BUILD:
    "WALL_BUILD — SCORE by enclosing (every tile = 1 pt, living-tower castle bonus); never idle-pass, pre-claim if a full seal won't finish. build_out (default, seals everything that fits) / build_toward { towerIdx } / seal_survivor (one-call life rescue) / build_path { from, to } / hand place { row, col, rotation } / pass({ seconds: 30 }) ONLY if nothing can be built — that skips the WHOLE idle remainder in one call (bare pass() with no seconds only steps ~0.5s and needs dozens of calls to drain a phase). (full menu: round 1)",
  CANNON_PLACE:
    "CANNON_PLACE — cannon { row, col, mode }; see CANNON SPOTS for affordable spots; cannon-done / pass. (full menu: round 1)",
  UPGRADE_PICK:
    "UPGRADE_PICK — pick-upgrade { cardIdx 0|1|2 } from UPGRADE OFFERS. (full menu: round 1)",
  BATTLE:
    "BATTLE — bombard { slot } (spread) / breach { slot, towerIdx? } (min-cut open a pocket) / pit_strike { slot } / cull (defend vs your grunts) / declutter (shoot out your own fat to avoid a bag-lock) / fire { row, col } (snipe). See TARGETS. (full menu: round 1)",
};
/** Tiles of padding around an ROI's bounding box so the crop shows the region
 *  IN CONTEXT (the gap plus the ring around it), not a hairline slice. */
const ROI_PAD = 3;

/** Render an observation as the annotated ASCII board (header, standings,
 *  roster, battery, aim-assist sections, then the raw board the harness baked).
 *  Faithful to the curated `tmp/show.py` layout. */
export function renderObservation(
  obs: Observation,
  seen: Set<string> = new Set<string>(),
  modeTally?: CannonModeTally,
  opts?: { includeBoard?: boolean },
): string {
  const lines: string[] = [];
  // Show-once gate: the FIRST time a static explainer block is rendered in a
  // session it gets the full text; thereafter a stateful agent (the MCP session
  // retains every prior turn) gets the terse pointer. `seen` is owned by the
  // server session and reset at new_game; an empty default means a one-off
  // caller (or a test) still gets the full text every time.
  const once = (key: string, full: string, terse: string) =>
    seen.has(key) ? terse : (seen.add(key), full);

  // ── header: round / phase / timer, battle liveness, board coverage ──────────
  let hdr = `ROUND ${obs.round}  ${obs.phase}  t=${obs.timerSec}s`;
  if (obs.phase === "BATTLE") {
    hdr +=
      obs.battleCountdown > 0
        ? `  | COUNTDOWN ${obs.battleCountdown}s (not live - shots wasted)`
        : `  | LIVE  shots in flight: ${obs.cannonballsInFlight}`;
  }
  if (obs.gameOver) hdr += "  *** GAME OVER ***";
  const bb = obs.boardBounds;
  lines.push(
    `${hdr}   [board r${bb.minRow}-${bb.maxRow} c${bb.minCol}-${bb.maxCol}]`,
  );
  if (obs.activeModifier) {
    lines.push(
      `MODIFIER: ${obs.activeModifier.label} (${obs.activeModifier.id}) — active this round`,
    );
  }
  if (obs.battleSkipped) {
    lines.push(
      "⚠ BATTLE SKIPPED this round (a player owns Ceasefire) — end_cannon goes straight to the next phase; no attack/cull/fire turn.",
    );
  }

  // ── standings (or final results, once the match is over) ────────────────────
  for (const line of standingsLines(obs)) lines.push(line);

  // ── alerts: the severity-ranked verdict, ABOVE the detailed sections so the
  //    one line that matters isn't buried among always-on context ──────────────
  lines.push(...alertLines(obs));

  if (!obs.gameOver) {
    lines.push(
      `EXPECTED: ${once(`expected:${obs.phase}`, obs.expected, TERSE_EXPECTED[obs.phase] ?? obs.expected)}`,
    );
  }

  const last = obs.lastResult;
  if (last) {
    lines.push(
      `LAST: ${last.kind} -> ${last.success ? "OK" : "REJECT"}` +
        (last.reason ? `  (${last.reason})` : ""),
    );
  }

  // ── roster: one row per player (home, castle box, armament) ─────────────────
  lines.push("ROSTER:");
  for (const player of obs.layout) {
    const mark = player.isMe ? "►" : " ";
    const who = player.name + (player.isMe ? " (you)" : "");
    const status = player.eliminated ? "ELIM" : `L${player.lives}`;
    lines.push(
      `  ${mark} ${who.padEnd(11)} ${status.padEnd(5)} ` +
        `home${box(player.home).padEnd(9)} castle ${box(player.castle).padEnd(
          16,
        )} walls${String(player.walls).padEnd(3)} cannons${player.cannons} ` +
        `encl${player.enclosedTowers}`,
    );
  }

  // ── active upgrades in force this round (modern; shared screen = all visible) ─
  lines.push(...activeUpgradeLines(obs));

  // ── my battery + status line (battery prints before the YOU line, as in show.py) ─
  lines.push(...batteryStatusLines(obs, once));

  // ── build headroom: free land + open-pocket gauge (the cannon-count signal) ──
  lines.push(...headroomLines(obs));

  // ── firepower: honest live-gun comparison (return fire scales with theirs) ──
  lines.push(...firepowerLines(obs));

  // ── BATTLE aim-assist: opponents + their towers as breach targets ───────────
  lines.push(...targetLines(obs, once));

  // ── BATTLE pit targets: best super-cannon pit walls, choke-ranked ───────────
  lines.push(...pitTargetLines(obs, once));

  // ── BATTLE cannon-snipe: conditional nudge to kill enemy guns over bombard ──
  lines.push(...cannonSnipeLines(obs));

  // ── BATTLE declutter: nudge to shoot out your own fat before it bag-locks you ─
  lines.push(...declutterLines(obs));

  // ── supply ships: live river hulls to hunt for a hidden bonus ───────────────
  lines.push(...supplyShipLines(obs));

  // ── threats: grunts bearing down on my towers ───────────────────────────────
  lines.push(...threatLines(obs));

  // ── grunt clusters: dense packs (≥2×2) worth enclosing / opponent weak spots ─
  lines.push(...gruntClusterLines(obs, once));

  // ── selection: pickable towers in my zone ───────────────────────────────────
  if (obs.towers) {
    // Flag the roomiest pickable home (largest buildable pocket area) — the
    // central/open tower the agent should usually prefer over a hemmed-in one.
    const roomiest = obs.towers.reduce(
      (best, tower) =>
        tower.pocket.h * tower.pocket.w > best.pocket.h * best.pocket.w
          ? tower
          : best,
      obs.towers[0]!,
    );
    const picks = obs.towers
      .map((tower) => {
        const { h, w } = tower.pocket;
        const star = tower === roomiest ? "★" : "";
        const tight = Math.min(h, w) < 3 ? " TIGHT" : "";
        return `${tower.index}→(${tower.row},${tower.col}) pocket ${h}×${w}${tight}${star}`;
      })
      .join("   ");
    lines.push(
      `  PICKABLE TOWERS (pocket = buildable room as home; ★ roomiest): ${picks}`,
    );
  }

  // ── cannon spots: legal placements as a role menu, ordered by situational fit ─
  if (obs.cannonSuggestions !== undefined) {
    for (const line of renderCannonSpots(obs, obs.cannonSuggestions, once))
      lines.push(line);
  }

  // ── idle slots: keep-placing interrupt — unspent slots are forfeited firepower ─
  lines.push(...idleSlotLines(obs, once));

  // ── balloon opportunity: conditional cannon-phase nudge to steal an enemy super ─
  lines.push(...balloonOpportunityLines(obs));

  // ── mode skew: stateful pattern-interrupt for a normal-only cannon monoculture ─
  lines.push(...cannonSkewLines(obs, modeTally));

  // ── survival warning: no alive/revivable enclosed tower = a life lost at round
  //    end (see survivalLines) ──
  lines.push(...survivalLines(obs));

  // ── bag-lock: current piece has zero legal placements anywhere ──────────────
  // The bag only advances by PLACING (pass does NOT cycle the piece), so this is
  // a hard deadlock — nothing can be built this phase. Surfaced so the agent
  // stops thrashing build_* calls and reads the real cause.
  if (obs.me.bagLocked) {
    lines.push(
      `  ⚠ BAG-LOCKED: piece ${obs.me.currentPiece ?? "?"} has NO legal placement anywhere in your zone — and the bag advances ONLY by placing (pass won't cycle it), so you can build NOTHING this phase.` +
        (obs.me.survivesRoundEnd
          ? " Survival is safe (a tower is enclosed), so you just forfeit this build."
          : " ☠ No alive/revivable tower is enclosed, so finalizing costs a LIFE + zone reset — unavoidable now.") +
        once(
          "bagLockHowto",
          " Cause: a near-sealed castle whose only gaps need a different piece shape/size (e.g. an S-gap can't take an SR). Prevent next time: keep a multi-tile cut and don't pack every interior tile.",
          "",
        ),
    );
  }

  // ── dump-capacity: bag-lock tightness diagnosis (binary under atomic build) ──
  lines.push(...dumpCapacityLines(obs, once));

  // ── enclosure candidates: min-cut plans, blocker-aware feasibility ──────────
  lines.push(...enclosureLines(obs));

  // ── opportunity cost of passing: prices idle build time at the decision point ─
  lines.push(...stillSealableLines(obs, once));

  // ── compactness: the standing over-expansion trend, the PRE-COMMIT fat lever ─
  // Visible before every build choice so a climbing fat/100 steers you off a
  // greedy build_out and onto a compact build_toward (the only avoidable fat is
  // fat not yet placed).
  if (obs.compactness && obs.compactness.interior > 0) {
    lines.push(compactnessLine(obs.compactness));
  }

  // ── fat walls: SUNK history, not a to-do — in classic no placed wall is removable ─
  // Count-only (the coords are non-actionable: you can't un-place a wall, and a
  // sealed ring is sweep-proof regardless). The lever is purely forward.
  if (obs.fatWalls && obs.fatWalls.length > 0) {
    lines.push(
      once(
        "fatWalls",
        `  ℹ fat walls: ${obs.fatWalls.length} interior tiles fully boxed by your own territory (former perimeters you expanded past + piece-overflow). SUNK — in classic a placed wall can't be removed, so this isn't a to-do and isn't a defensive hole. The only avoidable fat is fat you haven't placed yet: send new pieces to the frontier (build_toward / ↗ EXTEND), not into interior.`,
        `  ℹ fat walls: ${obs.fatWalls.length} sunk interior tiles (not a to-do; only avoidable fat is unplaced — send pieces to the frontier).`,
      ),
    );
  }

  // ── loose wall ends: ≤1-neighbour stubs the round-end sweep deletes ─────────
  // NOT an alarm — a closed ring's walls always keep ≥2 neighbours, so the sweep
  // can only ever shave dangling stubs; it can never open a sealed pocket. They
  // only cost you on an UN-closed cross-round pre-claim line (build_path).
  if (obs.fragileWalls && obs.fragileWalls.length > 0) {
    const tail = once(
      "fragileWallsHowto",
      " — harmless to a sealed castle (you can even dump a dud piece here); only anchor one if it's part of a build_path pre-claim you'll close a later round",
      "",
    );
    lines.push(
      `  ◦ loose wall ends (${obs.fragileWalls.length}, ≤1 wall-neighbor — swept at round end)${tail}: ${tileList(obs.fragileWalls)}`,
    );
  }

  // ── wall extensions: the constructive read of a loose end — grow it into a gap ─
  if (obs.wallExtensions && obs.wallExtensions.length > 0) {
    const hints = obs.wallExtensions
      .map(
        (ext) =>
          `(${ext.from.row},${ext.from.col})→(${ext.next.row},${ext.next.col})`,
      )
      .join(" ");
    lines.push(
      `  ↗ EXTEND toward closing (loose end → next tile, heads for an open min-cut gap): ${hints}`,
    );
  }

  // ── bonus squares: highest points-per-tile build targets in my zone ─────────
  lines.push(...bonusTargetLines(obs));

  // ── placement suggestions for the current piece (ring repairs first) ─────────
  lines.push(...suggestionLines(obs));

  // ── modern UPGRADE_PICK: the three offers, pick one by cardIdx ───────────────
  lines.push(...upgradeOfferLines(obs));

  // ── VIEWS: precomputed regions of interest, pulled by name via observe({roi}) ─
  // Replaces the always-on full board on action returns: the agent doesn't scan
  // a 44×28 grid it mostly ignores — it gets a short menu of the salient regions
  // (the harness already knows where they are) and pulls the one it wants as a
  // cheap focused crop. On `observe` (board included below) it's a bonus pointer.
  const views = roiMenuLine(obs);
  if (views) lines.push(views);

  // The board carries a constant glyph legend (the first LEGEND_LINE_COUNT
  // lines, incl. a round/score line that ROSTER + STANDINGS already cover).
  // Show it once per session, then drop it — the coordinate headers below it
  // stay, so the agent never loses tile-citing context. Suppressed on action
  // returns (`includeBoard: false`) so only an explicit `observe` pays the board
  // tokens; the annotation sections above already drive every decision.
  if (opts?.includeBoard !== false) {
    lines.push(
      once(
        "board:legend",
        obs.board,
        obs.board.split("\n").slice(LEGEND_LINE_COUNT).join("\n"),
      ),
    );
  }
  return lines.join("\n");
}

/** The one-line `VIEWS:` menu: the top few ROIs as ready-to-call `observe({roi})`
 *  invocations, with the rest named so the agent knows they're pullable too.
 *  Null when nothing salient (e.g. pre-selection). */
function roiMenuLine(obs: Observation): string | null {
  const rois = computeRois(obs);
  if (rois.length === 0) return null;
  const shown = rois.slice(0, 3);
  const items = shown
    .map((roi) => `observe({roi:"${roi.name}"}) ${roi.why}`)
    .join(" · ");
  const rest = rois.slice(3);
  const more =
    rest.length > 0
      ? ` (+${rest.length} more: ${rest.map((roi) => roi.name).join(", ")})`
      : "";
  return `  VIEWS (pull a focused board — no clock): ${items}${more}`;
}

/** Precompute the salient regions of the current observation as named,
 *  ready-to-pull `observe({roi})` crops. Ranked most-urgent first: the seal the
 *  survival/home ring needs, grunts bearing on a tower, an enclose-kill cluster,
 *  an opponent's softest breach target, your castle overview, an open bonus. The
 *  server's `observe` handler resolves a `roi` name back to its `rect`. */
export function computeRois(obs: Observation): RoiEntry[] {
  const rois: RoiEntry[] = [];

  // 1. reseal-gap / gap — the min-cut the survival (or home) ring must close.
  const candidates = obs.enclosureCandidates ?? [];
  const gapCand =
    candidates.find((c) => c.status === "enclosable" && c.satisfiesSurvival) ??
    candidates.find((c) => c.status === "enclosable" && c.isHome) ??
    candidates.find((c) => c.status === "enclosable");
  if (gapCand && gapCand.tiles.length > 0) {
    const rect = padBox(gapCand.tiles);
    if (rect) {
      const urgent = obs.me.survivesRoundEnd === false;
      const first = gapCand.tiles[0]!;
      rois.push({
        name: urgent ? "reseal-gap" : "gap",
        rect,
        why: `${gapCand.isHome ? "home" : `tower ${gapCand.towerIdx}`} seal near (${first.row},${first.col})`,
      });
    }
  }

  // 2. threat:N — a grunt bearing down on one of my towers (grunt + tower box).
  (obs.threats ?? []).slice(0, 2).forEach((threat, index) => {
    const rect = padBox([threat.grunt, threat.tower]);
    if (rect) {
      rois.push({
        name: `threat:${index}`,
        rect,
        why: `${threat.kind} (${threat.grunt.row},${threat.grunt.col})→tower ${threat.tower.idx}`,
      });
    }
  });

  // 3. enclose-kill — one of MY zone's packed grunt clusters, boxable for points.
  const cluster = (obs.gruntClusters ?? []).find((entry) => entry.mine);
  if (cluster) {
    rois.push({
      name: "enclose-kill",
      rect: {
        minRow: Math.max(0, cluster.minRow - ROI_PAD),
        maxRow: cluster.maxRow + ROI_PAD,
        minCol: Math.max(0, cluster.minCol - ROI_PAD),
        maxCol: cluster.maxCol + ROI_PAD,
      },
      why: `${cluster.count} grunts packed — enclose-kill`,
    });
  }

  // 4. target:slot — an opponent's softest enclosed tower (breach/bombard aim).
  for (const target of obs.targets ?? []) {
    const soft = target.towers[0];
    if (!soft) continue;
    const rect = padBox([{ row: soft.row, col: soft.col }], 5);
    if (rect) {
      rois.push({
        name: `target:${target.slot}`,
        rect,
        why: `${target.name} soft tower ${soft.towerIdx} (${soft.ringWalls}w ring)`,
      });
    }
  }

  // 5. home — the always-available overview of my own castle.
  const me = obs.layout.find((player) => player.isMe);
  if (me?.castle) {
    rois.push({
      name: "home",
      rect: {
        minRow: Math.max(0, me.castle.minRow - ROI_PAD),
        maxRow: me.castle.maxRow + ROI_PAD,
        minCol: Math.max(0, me.castle.minCol - ROI_PAD),
        maxCol: me.castle.maxCol + ROI_PAD,
      },
      why: "your castle",
    });
  }

  // 6. bonus — an open-grass bonus square that needs dedicated walls.
  const openBonus = (obs.bonusTargets ?? []).find(
    (bonus) => !bonus.enclosed && bonus.capturedByTower === null,
  );
  if (openBonus) {
    const rect = padBox([{ row: openBonus.row, col: openBonus.col }], 4);
    if (rect) {
      rois.push({
        name: "bonus",
        rect,
        why: `bonus square (${openBonus.row},${openBonus.col}) — needs walls`,
      });
    }
  }

  return rois;
}

function padBox(
  tiles: readonly { row: number; col: number }[],
  pad: number = ROI_PAD,
): RoiRect | null {
  if (tiles.length === 0) return null;
  let minRow = Number.POSITIVE_INFINITY;
  let maxRow = Number.NEGATIVE_INFINITY;
  let minCol = Number.POSITIVE_INFINITY;
  let maxCol = Number.NEGATIVE_INFINITY;
  for (const tile of tiles) {
    if (tile.row < minRow) minRow = tile.row;
    if (tile.row > maxRow) maxRow = tile.row;
    if (tile.col < minCol) minCol = tile.col;
    if (tile.col > maxCol) maxCol = tile.col;
  }
  return {
    minRow: Math.max(0, minRow - pad),
    maxRow: maxRow + pad,
    minCol: Math.max(0, minCol - pad),
    maxCol: maxCol + pad,
  };
}

/** Severity-ranked verdict header — the agent's "read this FIRST" digest. The
 *  harness derives the strings (`obs.alerts`); the renderer only frames them so
 *  the ordering/wording stays in one place. Empty when nothing is flagged. */
/** The standing fat/interior read. A ring breach collapses `interior` while
 *  dense wall blocks still count as fat, so the harness suspends `fatPer100`
 *  (null) there — render the absolute fat count instead of a meaningless HIGH. */
function compactnessLine(
  compactness: NonNullable<Observation["compactness"]>,
): string {
  const { interior, fat, fatPer100 } = compactness;
  if (fatPer100 === null) {
    return `  ▣ compactness: ${fat} sunk fat, ${interior} interior — ring open, ratio suspended until resealed (declutter still targets the fat).`;
  }
  return (
    `  ▣ compactness: ${interior} interior (scoring) tiles, ${fat} sunk fat = ${fatPer100} fat/100. ` +
    `${fatPer100 >= 20 ? "HIGH — you're expanding past old shells; prefer build_toward(<nearest>) over build_out" : "lean — keep sending pieces to the frontier"}.`
  );
}

function alertLines(obs: Observation): string[] {
  if (!obs.alerts || obs.alerts.length === 0) return [];
  return ["⚑ NOW (most urgent first):", ...obs.alerts.map((a) => `  ${a}`)];
}

/** Build-headroom gauge: remaining enclosable land + the largest open buildable
 *  rectangle (the dump-pocket / cannon-count signal). Gated out of BATTLE (the
 *  decision it informs is select/cannon/build) and when there's no zone yet. */
function headroomLines(obs: Observation): string[] {
  const hr = obs.me.headroom;
  if (!hr || hr.zoneLand === 0 || obs.phase === "BATTLE") return [];
  const { h, w } = hr.openPocket;
  const verdict =
    Math.min(h, w) >= 3
      ? "room for cannons + a 3×3 dump pocket"
      : "TIGHT — keep cannons lean and reserve a dump pocket";
  return [
    `  ⊞ HEADROOM: ${hr.free}/${hr.zoneLand} land free, largest open pocket ${h}×${w} — ${verdict}.`,
  ];
}

/** Firepower differential — live enclosed direct-fire guns per living player
 *  (CANNON_PLACE + BATTLE, where the number drives a decision). The roster's
 *  raw `cannons` count includes dead debris and balloons, so it flatters
 *  everyone; this is the honest battle-throughput comparison. When the agent is
 *  clearly outgunned the line says what that MEANS — enemy return fire during
 *  its own bombard/cull/declutter outnumbers what it dishes out — because a
 *  bare ratio was too easy to read past (the balloon-habit lesson: numbers
 *  beat prose, but numbers + consequence beat numbers). */
function firepowerLines(obs: Observation): string[] {
  const firepower = obs.firepower;
  if (!firepower || firepower.length < 2) return [];
  const mine = firepower.find((entry) => entry.isMe);
  if (!mine) return [];
  const rivals = firepower.filter((entry) => !entry.isMe);
  const list = rivals.map((entry) => `${entry.name} ${entry.guns}`).join(", ");
  const maxRival = Math.max(...rivals.map((entry) => entry.guns));
  const tail =
    maxRival >= mine.guns * 2 && maxRival - mine.guns >= 3
      ? " — OUTGUNNED: their return fire during your bombard/cull/declutter outnumbers what you fire, and the gap compounds (their guns persist). Favor defensive spends (cull/declutter) over trading bombards until your battery recovers."
      : maxRival > mine.guns
        ? " — they out-fire you in a trade; weigh bombards accordingly."
        : "";
  return [
    `  ⚔ FIREPOWER (live enclosed direct-fire guns): you ${mine.guns} vs ${list}${tail}`,
  ];
}

/** MODERN: the upgrades each player holds in force this round. The upgrade
 *  screen is shared, so a rival's picks are fair game to read. Empty in classic
 *  / when nobody holds an upgrade. */
function activeUpgradeLines(obs: Observation): string[] {
  const lines: string[] = [];
  const mine = obs.me.activeUpgrades ?? [];
  if (mine.length > 0) {
    lines.push(
      `  ✦ YOUR upgrades this round: ${mine.map(upgradeTag).join(", ")}`,
    );
  }
  for (const opp of obs.opponents) {
    const ups = opp.activeUpgrades ?? [];
    if (ups.length > 0) {
      const name = obs.layout[opp.slot]?.name ?? `P${opp.slot}`;
      lines.push(`  ✦ ${name} upgrades: ${ups.map(upgradeTag).join(", ")}`);
    }
  }
  return lines;
}

/** One active upgrade as `Label (description)` with a ×N suffix when stacked. */
function upgradeTag(upgrade: {
  label: string;
  description: string;
  stacks: number;
}): string {
  const stack = upgrade.stacks > 1 ? ` ×${upgrade.stacks}` : "";
  return `${upgrade.label}${stack} (${upgrade.description})`;
}

/** MODERN UPGRADE_PICK: the agent's three offers as a pick list. Empty outside
 *  the phase (the field is omitted unless offers are live). */
function upgradeOfferLines(obs: Observation): string[] {
  if (!obs.upgradeOffers || obs.upgradeOffers.length === 0) return [];
  const lines = ["UPGRADE OFFERS (pick_upgrade { cardIdx }):"];
  for (const offer of obs.upgradeOffers) {
    lines.push(`  [${offer.cardIdx}] ${offer.label} — ${offer.description}`);
  }
  return lines;
}

/** My battery rollup + the YOU status line. BATTERY and CAPTURED print before
 *  YOU (as in show.py), so they're pushed first and the YOU line last. */
function batteryStatusLines(obs: Observation, once: Once): string[] {
  const lines: string[] = [];
  const me = obs.me;
  const slots = me.cannonSlots;
  let mine = `  YOU: piece=${me.currentPiece}  cannonSlots ${slots.used}/${slots.max}`;
  const byMode = slots.byMode ?? [];
  if (byMode.length > 0) {
    mine += ` (${byMode
      .map((entry) => `${entry.mode}×${entry.count}=${entry.slots}sl`)
      .join(" + ")})`;
  }
  // The max is recomputed each CANNON_PLACE and SHRINKS when cannons died or
  // towers entered the phase unenclosed/dead — unexplained, a falling cap reads
  // as a bug. One-time formula note the first cannon phase of the session.
  if (obs.phase === "CANNON_PLACE") {
    mine += once(
      "cannonSlotsMaxHowto",
      " (max = slots your live cannons already use + 2 for an enclosed alive home + 1 per other enclosed alive tower, recomputed each round — dead cannons and unsealed towers shrink it)",
      "",
    );
  }
  if (obs.phase === "BATTLE") {
    // cannonsReady's denominator is your raw cannon COUNT — it includes
    // balloons/ramparts (never direct-fire) and guns captured away, so it
    // overstates offense. `firing-for-you` is the NET battery actually shooting
    // for you this battle: own enclosed normals/supers (reloading still count)
    // + enemy guns YOUR balloon seized − your guns an enemy seized.
    const ownFiring = me.cannonPositions.filter(
      (cannon) =>
        cannon.alive &&
        (cannon.mode === "normal" || cannon.mode === "super") &&
        !(cannon.reason ?? "").includes("captured") &&
        !(cannon.reason ?? "").includes("unenclosed"),
    ).length;
    const seizedFiring = (me.capturedByMe ?? []).filter(
      (cannon) => cannon.mode === "normal" || cannon.mode === "super",
    ).length;
    let firing = `firing-for-you ${ownFiring + seizedFiring}`;
    if (seizedFiring > 0)
      firing += ` (own ${ownFiring} + ${seizedFiring} seized)`;
    mine += `  cannonsReady ${me.cannonsReady}/${me.cannonPositions.length}  ${firing}`;
  }
  if (me.cannonsUnenclosed) {
    mine += `  ⚠ ${me.cannonsUnenclosed} INERT (unenclosed — can't fire, reseal to re-arm)`;
  }
  const battery = me.cannonsByTower ?? [];
  if (battery.length > 0) {
    const parts = battery.map((tower) => {
      const modes = Object.entries(tower.byMode ?? {})
        .map(([mode, count]) => ` ${mode}×${count}`)
        .join("");
      const tags: string[] = [];
      if (tower.dead) tags.push(`${tower.dead}dead`);
      if (tower.inert) tags.push(`${tower.inert}inert`);
      const open = tower.enclosed ? "" : " OPEN";
      const tag = tags.length > 0 ? ` [${tags.join(",")}]` : "";
      return `T${tower.towerIdx}(${tower.row},${tower.col})${open}: ${tower.alive}/${tower.total} live${tag}${modes}`;
    });
    lines.push(`  BATTERY by tower: ${parts.join(" | ")}`);
  }
  // Attrition ledger: dead guns are PERMANENT debris — worse than idle slots
  // (the wreck blocks rebuild tiles and shrinks the open pocket until a zone
  // reset). Surfaced next to the battery so a shrinking gun count reads as the
  // cost of the last bombard trade, not silent bad luck.
  const attrition = me.attrition;
  if (attrition) {
    lines.push(
      `  ☠ ATTRITION: ${attrition.deadGuns} dead gun${attrition.deadGuns === 1 ? "" : "s"} = permanent debris over ${attrition.debrisTiles} interior tiles (blocks rebuilding there + shrinks your open pocket; only a zone reset clears it). If this count keeps climbing, return fire is eating your battery — trade fewer bombards.`,
    );
  }
  const captured = me.capturedCannons ?? [];
  if (captured.length > 0) {
    const list = captured
      .map(
        (cannon) => `${cannon.mode}(${cannon.row},${cannon.col})→${cannon.by}`,
      )
      .join("  ");
    lines.push(
      `  ⚠ CAPTURED by enemy balloons — these fire for the captor this battle, NOT you${
        captured.some((cannon) => cannon.mode === "super")
          ? " (a captured super = pit_strike can't plant)"
          : ""
      }: ${list}`,
    );
  }
  const seized = me.capturedByMe ?? [];
  if (seized.length > 0) {
    const list = seized
      .map(
        (cannon) =>
          `${cannon.mode}(${cannon.row},${cannon.col})←${cannon.from}`,
      )
      .join("  ");
    lines.push(
      `  ✓ CAPTURED by YOUR balloon — these fire for YOU this battle${
        seized.some((cannon) => cannon.mode === "super")
          ? " (a seized super = a free pit_strike gun)"
          : ""
      }: ${list}`,
    );
  }
  if (me.cannonPositions.length > 0) {
    let anyMark = false;
    const guns = me.cannonPositions.map((cannon) => {
      const reason = cannon.reason ?? "";
      const mark = !cannon.alive
        ? "†"
        : reason.includes("captured")
          ? "⊗"
          : reason.includes("unenclosed")
            ? "✗"
            : "";
      if (mark) anyMark = true;
      return `${cannon.mode}(${cannon.row},${cannon.col})${mark}`;
    });
    // Mode-tagged so you can locate your super/balloon; marks flag guns that
    // can't fire FOR you (✗ inert, ⊗ captured away, † dead) — balloon/rampart
    // self-identify by their mode label (never on the direct-fire path).
    const legend = anyMark ? " (✗inert ⊗captured-away †dead)" : "";
    mine += `  guns${legend}=${guns.join(",")}`;
  }
  lines.push(mine);
  return lines;
}

/** BATTLE aim-assist: each opponent (leader first) + their towers as breach
 *  targets. Empty when `obs.targets` is absent (non-BATTLE phases). */
function targetLines(obs: Observation, once: Once): string[] {
  if (!obs.targets) return [];
  const lines: string[] = [
    once(
      "targetsHeader",
      "  TARGETS (leader first — bombard=spread walls / breach=min-cut open a pocket):",
      "  TARGETS (leader first):",
    ),
  ];
  for (const target of obs.targets) {
    const tiles = target.sampleTiles
      .slice(0, 6)
      .map((tile) => `(${tile.row},${tile.col})`)
      .join(",");
    lines.push(
      `     ${target.name.padEnd(5)} ${target.score}pts ${target.walls}w  -> ${tiles}`,
    );
    for (const tower of target.towers ?? []) {
      const star = tower.bonusSquares ? `  ★${tower.bonusSquares}bonus` : "";
      lines.push(
        `        breach tower ${tower.towerIdx} (${tower.row},${tower.col})  ring ${tower.ringWalls}w${star}`,
      );
    }
  }
  return lines;
}

/** BATTLE pit targets: super-cannon pit walls drawn from the engine min-cut. */
function pitTargetLines(obs: Observation, once: Once): string[] {
  if (!obs.pitTargets) return [];
  const lines: string[] = [
    once(
      "pitTargetsHeader",
      "  🔥 PIT TARGETS (super-cannon → burning pit; pit_strike(slot, targets) — on the MIN-CUT load-bearing seal; TAXES the reseal, rarely denies it — AI re-routes ~90%; choke=un-reroutable sides):",
      "  🔥 PIT TARGETS (pit_strike(slot, targets); min-cut seal tiles; taxes reseal, rarely denies; choke=un-reroutable sides):",
    ),
  ];
  for (const pit of obs.pitTargets) {
    const tower = pit.towerIdx != null ? ` tower${pit.towerIdx}` : "";
    lines.push(
      `     slot${pit.slot} (${pit.row},${pit.col})  choke ${pit.choke}/4${tower}`,
    );
  }
  return lines;
}

/** Conditional cannon-snipe nudge: surfaced only when sniping enemy guns with
 *  fire(row,col) beats the default bombard (Salvage held / their super gun). */
function cannonSnipeLines(obs: Observation): string[] {
  const snipe = obs.cannonSnipe;
  if (!snipe) return [];
  const tiles = snipe.tiles
    .map((tile) => `(${tile.row},${tile.col})${tile.heavy ? "★" : ""}`)
    .join(" ");
  return [
    `  ⌖ SNIPE CANNONS (situational — bombard usually out-scores this): fire(row,col) on ${snipe.name}'s gun tiles to DESTROY them — ${snipe.reason}.`,
    `     ~${snipe.hitsToKill} normal hits kill a gun (a super ball does 2/hit); the wreck leaves debris that blocks their rebuild. No one-call aimer — fire a tile, pass to reload, repeat. Tiles (★=super/Mortar): ${tiles}`,
  ];
}

/** Conditional balloon nudge: surfaced in CANNON_PLACE when a balloon is
 *  affordable AND an opponent fields a super/Mortar worth seizing for a battle.
 *  The cannon-phase mirror of the SNIPE hint — makes the otherwise-passive
 *  balloon menu line salient exactly when it pays for its 3 slots. */
function balloonOpportunityLines(obs: Observation): string[] {
  const balloon = obs.balloonOpportunity;
  if (!balloon) return [];
  const { row: gr, col: gc, mode } = balloon.gun;
  const { row: sr, col: sc } = balloon.spot;
  const canSeize = balloon.balloonsAffordable >= balloon.balloonsToSeize;
  // Honest about a super's 2-hit cost: seize-now vs bank-partial-progress.
  const action = canSeize
    ? `place ${balloon.balloonsToSeize === 1 ? "a balloon" : `${balloon.balloonsToSeize} balloons`} (mode:'balloon', 3 slots each) starting at (${sr},${sc}) to SEIZE it THIS battle — it fires FOR you, denies it to them, then is spent (slots free next round)`
    : `it needs ${balloon.balloonsToSeize} balloon hits (a super takes 2) but you can afford ${balloon.balloonsAffordable} now — one balloon at (${sr},${sc}) banks ${balloon.balloonsAffordable}/${balloon.balloonsToSeize} (progress persists; finish next round)`;
  const lines = [
    `  🎈 BALLOON OPPORTUNITY: ${balloon.name}'s ${mode} at (${gr},${gc}) is capturable — ${action}. Near-free on slots you'd otherwise leave idle (a seized gun is a +1/−1 swing). It's REMOVED before WALL_BUILD, so it costs no build-space and can never add fat or trigger a bag-lock — a tight/packed castle is no reason to skip it (you only need a legal 2×2 spot at placement time).`,
  ];
  // ROI counterfactual: the balloon's 3 slots vs the same slots as persistent
  // normals, priced in rounds remaining. Only when a normal genuinely fits
  // (safeNormals > 0) AND enough match is left for compounding to matter —
  // with no battery spot or in the final rounds, the balloon IS the right
  // spend and the comparison would just be noise.
  const roundsLeft = obs.roundsTotal - obs.round;
  const safeNormals = obs.cannonBudget?.safeNormals ?? 0;
  if (roundsLeft >= 2 && safeNormals > 0) {
    const guns = Math.min(3, safeNormals);
    lines.push(
      `     ⚖ ROI: this balloon = +1 gun for THIS battle only, then gone. The same 3 slots as normals = +${guns} persistent gun${guns === 1 ? "" : "s"} firing EVERY battle for the ${roundsLeft} rounds left (~${guns * roundsLeft} gun-battles vs 1). Take the balloon only when the capture itself outweighs that compounding (e.g. it defuses their super).`,
    );
  }
  return lines;
}

/** In-phase interrupt for unspent cannon slots. The battery line shows `used/max`,
 *  but a passive count reads as status, not a to-do — a weak agent places one
 *  cannon, calls end_cannon, and leaves 3–5 slots empty EVERY round while the
 *  built-in AI fills all of them, so its cannon count never grows. Firing whenever
 *  idle > 0 turns that silent gap into an explicit "keep placing" prompt; the live
 *  idle count changes each round so it can't be skimmed past like a fixed string.
 *  Space-aware, in escalating order: (1) castle fully packed (no gun spot) → bless a
 *  balloon/end; (2) only ring-adjacent spots → don't seam a permanent
 *  normal (balloon only); (3) dump pocket down to the 3×3 minimum → stop cramming permanent normals
 *  (a bag-lock costs more than idle slots); (4) otherwise push to fill with the
 *  `once`-gated cluster + repair-lane wisdom. */
function idleSlotLines(obs: Observation, once: Once): string[] {
  if (obs.phase !== "CANNON_PLACE") return [];
  const { used, max } = obs.me.cannonSlots;
  const idle = max - used;
  if (idle <= 0) return [];
  if (!hasBatterySpot(obs)) {
    return [
      `  ▸ ${idle} idle cannon slot${idle === 1 ? "" : "s"} (${used}/${max}) but NO routable spot for a normal/super gun — your castle is packed. A balloon here (no build-space, gone after battle) or end_cannon is fine; to add real battery, expand your interior first, then place guns next round.`,
    ];
  }
  if (ringOnlyBattery(obs)) {
    return [
      `  ▸ ${idle} idle cannon slot${idle === 1 ? "" : "s"} (${used}/${max}) — but the ONLY gun spots are ring-adjacent (°). Do NOT drop a normal on the seam: it's PERMANENT, goes inert on every breach, and will block the re-seal an enemy breach forces (this is how a castle ends up "never closable at the south"). A balloon there is fine (removed before WALL_BUILD → never obstructs walls later); otherwise leave the slot and expand your interior first — a placed gun isn't worth a lost enclosure.`,
    ];
  }
  // Budget-driven verdict: when the harness computed a safe-cannon budget, ONE
  // decisive instruction replaces the old contradictory pair ("fill every
  // slot" vs "reserve the pocket") — the number already arbitrated them.
  const budget = obs.cannonBudget;
  if (budget) {
    if (budget.safeNormals > 0) {
      const spots = budget.spots
        .slice(0, 3)
        .map((spot) => `(${spot.row},${spot.col})`)
        .join(" ");
      return [
        `  ▸ ${idle} idle cannon slot${idle === 1 ? "" : "s"} (${used}/${max}) — SAFE BUDGET: ${budget.safeNormals} normal${budget.safeNormals === 1 ? "" : "s"} at ${spots} keeps a 3×3 dump pocket (measured, not a vibe). Place ${budget.safeNormals === 1 ? "it" : "those"}, then STOP — further permanent guns risk a bag-lock. A balloon is exempt (removed before WALL_BUILD, no build-space).`,
      ];
    }
    return [
      `  ▸ ${idle} idle cannon slot${idle === 1 ? "" : "s"} (${used}/${max}) — SAFE BUDGET: 0. Every routable normal spot is ring-adjacent (° — a permanent gun there blocks future reseals, never recommended) or would shrink your dump pocket below 3×3 (bag-lock risk: forfeited build, lost life if it de-encloses you). Spend the slots on a balloon (no build-space) if a 🎈 capture is live, or end_cannon — an idle slot is far cheaper than a bag-lock.`,
    ];
  }
  if (dumpPocketAtRisk(obs)) {
    const balloonOk = obs.balloonOpportunity
      ? "The live 🎈 capture is still fine (a balloon is removed before WALL_BUILD → costs no build-space, can't cause a bag-lock)."
      : "A balloon would be fine (no build-space) but only if a 🎈 capture is on offer — none now.";
    return [
      `  ▸ ${idle} idle cannon slot${idle === 1 ? "" : "s"} (${used}/${max}) — but your dump pocket is down to the 3×3 MINIMUM. STOP adding permanent normals: one more 2×2 gun can shrink the pocket below a placeable piece and BAG-LOCK your next build (no legal placement → forfeited build, and a lost life if it de-encloses you). Reserve the pocket. ${balloonOk} Otherwise leave the slots idle — an idle slot is far cheaper than a bag-lock.`,
    ];
  }
  const howto = once(
    "idleSlotsHowto",
    " Good play: fill EVERY slot each round with normal cannons — they PERSIST and compound round over round (the AI reaches 15+ this way). CLUSTER them around your towers, and leave a 1-tile lane between clusters so a repair/divider wall still fits if a breach opens (see CANNON SPOTS — ✗ marks spots that would wall you in). Only end with idle slots if no gun spot fits; then expand your interior first.",
    "",
  );
  return [
    `  ▸ ${idle} IDLE CANNON SLOT${idle === 1 ? "" : "s"} (${used}/${max} used) — call cannon{...} again before end_cannon. Each unused slot is firepower forfeited, and because cannons persist the gap COMPOUNDS every round.${howto}`,
  ];
}

/** Stateful pattern-interrupt for a cannon-mode habit that starves the standing
 *  battery. The 🎈 balloon and super hints are STATIC — an agent that skims one
 *  skims them all, so a real habit sails past every nudge for a whole game. This
 *  line counts the modes actually placed; the live count changes every round (so
 *  it can't be pattern-matched-past). Two shapes matter in practice:
 *   - all-`normal`: never once weighed a special lever (a mild nudge).
 *   - balloon-DOMINANT: more balloons than every other mode combined — the actual
 *     weak-agent trap, spending the whole slot budget each round on single-use
 *     capture units so the battery never grows. Fires only when a real gun spot
 *     STILL fits (`hasBatterySpot`); a packed castle makes balloon-leaning correct,
 *     so it stands down there rather than nagging an agent with no room. */
function cannonSkewLines(obs: Observation, tally?: CannonModeTally): string[] {
  if (!tally || obs.phase !== "CANNON_PLACE") return [];
  const { normal, super: superN, balloon, rampart } = tally;
  const balloonPointer = obs.balloonOpportunity
    ? "There's a live 🎈 opportunity right now (above) — THAT is when a balloon pays; otherwise place normals."
    : "Reserve balloons for a live 🎈 opportunity; the rest of the time, place normals.";
  // Balloon-dominant AND a battery gun would still fit → the real mistake.
  if (
    balloon >= NONNORMAL_SKEW_THRESHOLD &&
    balloon > normal + superN + rampart &&
    hasBatterySpot(obs)
  ) {
    return [
      `  ⚖ MODE SKEW: balloon×${balloon} — more than every other cannon combined, yet a normal/super gun DOES fit right now. A balloon is SINGLE-USE (removed after battle, 3 slots), a capture tool for one enemy gun, NOT your battery — leaning on it keeps your cannon count flat. Default to NORMAL cannons (1 slot; they persist and compound into a standing battery). ${balloonPointer}`,
    ];
  }
  // All-normal habit: never once tried a special lever.
  if (superN + balloon + rampart === 0 && normal >= NORMAL_SKEW_THRESHOLD) {
    const pointer = obs.balloonOpportunity
      ? `A balloon is affordable RIGHT NOW (see 🎈 above): a seized enemy gun is a +1/−1 swing this battle, near-free on slots you'd leave idle.`
      : "super (3×3, plants pits — area denial) and balloon (single-use, steals the enemy's scariest gun) are unused levers — weigh them deliberately instead of auto-placing normal.";
    return [
      `  ⚖ MODE SKEW: normal×${normal}, and you've NEVER tried a non-normal cannon. ${pointer}`,
    ];
  }
  return [];
}

/** Is there a routable spot for a STANDING BATTERY gun (normal/super) right now?
 *  False = the castle is packed tight — only balloon-sized footprints fit, or the
 *  only spots left would wall the ring shut. When there's no battery spot, idle
 *  slots are UNAVOIDABLE and a balloon (no build-space, gone after battle) is the
 *  right use of them — so the "fill your slots" nudges stand down (per the design:
 *  balloon overuse is fine when there's almost no space). */
function hasBatterySpot(obs: Observation): boolean {
  return (obs.cannonSuggestions ?? []).some(
    (spot) =>
      (spot.mode === "normal" || spot.mode === "super") && spot.routable,
  );
}

/** Conditional declutter nudge: surfaced in BATTLE when enough non-load-bearing,
 *  aim-reachable fat exists to open a real dump pocket (≥4 = a 2×2). The proactive
 *  escape from a looming bag-lock — you can only shoot walls out during BATTLE, but
 *  the lock bites next build, so the prompt has to fire a round early. */
function declutterLines(obs: Observation): string[] {
  const clearable = obs.fatClearable ?? 0;
  if (clearable < 4) return [];
  return [
    `  ♻ DECLUTTER AVAILABLE: ${clearable} of your redundant inner (fat) walls are cannonball-reachable — declutter() shoots them out (enclosure-safe, scores 0) to reopen a build pocket. Do it NOW if your castle is packing toward single-tile seams: walls are only removable in BATTLE, but a bag-lock bites next build. Otherwise bombard/cull.`,
  ];
}

/** Supply Ship modifier: the live river hulls to hunt. 2 hits sinks one for a
 *  hidden 1-round bonus; lead the moving hull and fire AHEAD of it. */
function supplyShipLines(obs: Observation): string[] {
  if (!obs.supplyShips || obs.supplyShips.length === 0) return [];
  const lines: string[] = [
    "  ⛴ SUPPLY SHIPS (2 hits sinks one → hidden 1-round bonus; lead the hull — fire AHEAD by flight-time × vel):",
  ];
  for (const ship of obs.supplyShips) {
    const state = ship.sinking ? " SINKING" : "";
    lines.push(
      `     ship ${ship.id} at (${ship.row},${ship.col}) hp${ship.hp}` +
        ` vel(${ship.velTilesPerSec.dCol},${ship.velTilesPerSec.dRow})/s${state}`,
    );
  }
  return lines;
}

/** Grunts bearing down on my towers. Lists in FULL only the ones that can reach
 *  a tower this build (EXPOSED or ATTACKING); the many [walled] grunts can't
 *  touch a tower while the ring holds, so they collapse to one summary line. */
function threatLines(obs: Observation): string[] {
  if (!obs.threats || obs.threats.length === 0) return [];
  const urgent = obs.threats.filter(
    (threat) => !threat.towerEnclosed || threat.attacking,
  );
  const walled = obs.threats.filter(
    (threat) => threat.towerEnclosed && !threat.attacking,
  );
  const lines: string[] = [
    "  ⚠ THREATS (grunts that can reach a tower — most urgent first):",
  ];
  // Cap the enumeration: urgent threats are sorted most-urgent-first, so the top
  // few are the actionable ones; a long tail of equally-exposed grunts is noise.
  const URGENT_CAP = 6;
  for (const threat of urgent.slice(0, URGENT_CAP)) {
    const grunt = threat.grunt;
    const tower = threat.tower;
    const flag = threat.towerEnclosed ? "walled" : "EXPOSED";
    const attacking = threat.attacking ? " ATTACKING!" : "";
    const occluded = threat.hittable
      ? ""
      : " OCCLUDED (no shot lands — cover in front)";
    const wall = threat.targetedWall
      ? ` wall(${threat.targetedWall.row},${threat.targetedWall.col})`
      : "";
    lines.push(
      `     ${threat.kind} (${grunt.row},${grunt.col}) -> tower ${tower.idx} (${tower.row},${tower.col}) dist ${threat.distance} [${flag}]${attacking}${occluded}${wall}`,
    );
  }
  if (urgent.length > URGENT_CAP) {
    lines.push(
      `     + ${urgent.length - URGENT_CAP} more grunt(s) that can reach a tower (less urgent — closest shown above)`,
    );
  }
  if (walled.length > 0) {
    const nearest = walled[0]!;
    lines.push(
      `     + ${walled.length} grunt(s) behind your walls (nearest: ${nearest.kind} dist ${nearest.distance} → tower ${nearest.tower.idx}) — can't reach while that ring holds`,
    );
  }
  return lines;
}

/** Survival warning: no alive/revivable enclosed tower = a life lost at round
 *  end. Gated on `survivesRoundEnd` (credits pending / Restoration-Crew
 *  revives), NOT the raw alive count, which false-alarmed while RC was held.
 *  Points at a tower whose seal actually CLEARS the loss — alive, or dead-but-
 *  revivable via Restoration Crew (`satisfiesSurvival`); enclosing a plain dead
 *  tower banks territory but still costs the life. When no candidate passes the
 *  strict `feasible` gate, checks for a LONG-ODDS one (walls fit the clock,
 *  only the expected small-piece bag-wait prices it out) before declaring the
 *  life unreachable — seal_survivor attempts those now, and "no tower is
 *  reachable" was twice disproven by a single lucky draw. */
function survivalLines(obs: Observation): string[] {
  if (obs.enclosureCandidates === undefined || obs.me.survivesRoundEnd) {
    return [];
  }
  const savers = obs.enclosureCandidates
    .filter(
      (candidate) =>
        candidate.status === "enclosable" &&
        candidate.feasible &&
        candidate.satisfiesSurvival,
    )
    .sort(
      (a, b) =>
        a.estSeconds - b.estSeconds ||
        (b.bonusSquares ?? 0) - (a.bonusSquares ?? 0),
    );
  const saver = savers[0];
  const longOdds = saver
    ? undefined
    : obs.enclosureCandidates
        .filter(
          (candidate) =>
            candidate.status === "enclosable" &&
            candidate.satisfiesSurvival &&
            !(candidate.blockers ?? []).some((blocker) => blocker.hard) &&
            candidate.estSeconds - candidate.waitSeconds <= obs.timerSec,
        )
        .sort((a, b) => a.estSeconds - b.estSeconds)[0];
  let hint: string;
  if (saver) {
    hint = ` → call seal_survivor() now — ONE call seals a compartment around ${saver.isHome ? "home" : `tower ${saver.towerIdx}`} (~${saver.estSeconds.toFixed(0)}s)${saver.alive ? "" : " — dead but Restoration Crew revives it on enclose"}, no coordinates. Passing forfeits the life; enclosing a DEAD tower does NOT count.`;
  } else if (longOdds) {
    hint = ` → call seal_survivor() — LONG ODDS: ${longOdds.isHome ? "home" : `tower ${longOdds.towerIdx}`}'s walls fit (~${(longOdds.estSeconds - longOdds.waitSeconds).toFixed(0)}s) but it needs a small-piece draw (~${longOdds.waitSeconds.toFixed(0)}s expected bag-wait); it cycles the bag for you and a lucky draw saves the life. Passing forfeits it for sure.`;
  } else {
    hint =
      " ⚠ No survival-clearing tower is reachable this build — enclosing a dead tower will NOT prevent the life loss.";
  }
  return [
    "  ☠ SURVIVAL: NO alive tower enclosed — finalize the round like this and you LOSE A LIFE and your whole zone resets to bare ground." +
      hint,
  ];
}

/** Bag-lock tightness diagnosis. Fires whenever the castle has packed tight
 *  enough that some draw-pool shapes no longer have a legal placement — i.e. a
 *  fat piece could (or already did) bag-lock you. NOTE: with an atomic build_out
 *  this reading is effectively binary — it goes from "all shapes fit" straight to
 *  locked in one call, so it reads as a diagnosis + next-build lesson, not a
 *  pre-lock prediction (the structured `me.dumpCapacity` field IS pollable
 *  between incremental place_piece calls, where a preview window exists).
 *  The generic-dump pocket that admits ANY piece is 3×3 — the `+` needs a 3×3
 *  bounding box; a 3×4 is a safe superset with placement slack. */
function dumpCapacityLines(obs: Observation, once: Once): string[] {
  if (!obs.me.dumpCapacity) return [];
  const { pool, placeable, largestBlocked } = obs.me.dumpCapacity;
  if (placeable >= pool) return [];
  const verb = obs.me.bagLocked
    ? "is why you're bag-locked"
    : "risks a bag-lock";
  const tail = once(
    "dumpCapacityHowto",
    `Your castle is packed to a near-single-tile seam — that ${verb}: a fat piece has no home, and the bag only advances by placing. Keep an open 3×3 pocket next build (the + needs 3×3; 3×4 is safely generic) — dump duds onto loose ends (◦) instead of sealing every interior tile.`,
    `(${verb}; keep an open 3×3 pocket next build).`,
  );
  return [
    `  ⚠ DUMP CAPACITY: only ${placeable}/${pool} draw-pool shapes have a legal placement` +
      (largestBlocked ? ` (largest blocked: ${largestBlocked})` : "") +
      `. ${tail}`,
  ];
}

/** Min-cut enclosure plans per tower (blocker-aware feasibility, drift + seal
 *  hints). One multi-line entry per candidate. */
function enclosureLines(obs: Observation): string[] {
  if (!obs.enclosureCandidates) return [];
  const lines: string[] = [
    "  ENCLOSURE CANDIDATES (home first, then cheapest):",
  ];
  for (const candidate of obs.enclosureCandidates) {
    const who = candidate.isHome ? "home" : "tower";
    let line = `     ${who} ${candidate.towerIdx}: ${candidate.status}`;
    // A DEAD tower's enclosure banks its pocket but does NOT clear the survival
    // life-loss on its own (unless Restoration Crew makes it revive on enclose).
    // Flag it inline so a "SEAL NOW ★+BONUS" row can't be misread as survival-safe.
    if (candidate.alive === false) {
      line += candidate.satisfiesSurvival
        ? "  ⚑DEAD (revives before the life check — pending revive or Restoration Crew)"
        : "  ⚑DEAD (enclosing does NOT satisfy survival this round)";
    }
    if (candidate.status === "enclosable") {
      line += enclosableDetail(candidate);
    } else if (candidate.status === "unenclosable" && candidate.reason) {
      line += `  (${candidate.reason})`;
    }
    if ((candidate.bonusSquares ?? 0) > 0) {
      line += `  ★+${candidate.bonusSquares} BONUS`;
    }
    lines.push(line);
  }
  return lines;
}

/** The `enclosable`-status tail of one ENCLOSURE CANDIDATES row: tile list, fit
 *  / blocker verdict, then optional DRIFT and SEAL-NOW continuation lines. */
function enclosableDetail(
  candidate: NonNullable<Observation["enclosureCandidates"]>[number],
): string {
  const tiles = candidate.tiles
    .slice(0, 10)
    .map((tile) => `(${tile.row},${tile.col})`)
    .join(",");
  const more =
    candidate.tiles.length <= 10 ? "" : ` +${candidate.tiles.length - 10}`;
  const blockers = candidate.blockers ?? [];
  let fit: string;
  if (blockers.length > 0) {
    let desc = blockers
      .slice(0, 4)
      .map((blocker) => `(${blocker.row},${blocker.col}) ${blocker.kind}`)
      .join(", ");
    if (blockers.length > 4) desc += ` +${blockers.length - 4}`;
    fit = `${
      blockers.some((blocker) => blocker.hard) ? "⛔ BLOCKED" : "soft-block"
    }: ${desc}`;
  } else {
    fit = candidate.feasible ? "fits in time" : "WON'T FINISH in time left";
  }
  // Split the price so the number self-explains when it jumps: the bag-wait
  // term toggles on/off as gaps shrink below piece size (or grunts move), and
  // an unlabelled ~1s↔~33s flip read as an unstable estimate instead of a
  // re-priced draw-odds wait.
  const price =
    candidate.waitSeconds > 0
      ? `~${candidate.estSeconds.toFixed(0)}s (${(candidate.estSeconds - candidate.waitSeconds).toFixed(0)}s walls + ~${candidate.waitSeconds.toFixed(0)}s expected bag-wait)`
      : `~${candidate.estSeconds.toFixed(0)}s`;
  let out = `  ${candidate.tilesNeeded} tiles ${price} [${fit}] -> ${tiles}${more}`;
  const drift = candidate.driftTiles ?? [];
  if (drift.length > 0) {
    const shown = drift
      .slice(0, 3)
      .map((tile) => `(${tile.row},${tile.col}) ~${tile.etaSeconds}s`)
      .join(" ");
    const rest = drift.length > 3 ? ` +${drift.length - 3}` : "";
    out +=
      `\n        ⏳ DRIFT: grunts reach ${shown}${rest} before this seals` +
      ` — wall these FIRST, reroute the cut, or clear them in battle`;
  }
  const seals = candidate.sealTiles ?? [];
  if (seals.length > 0) {
    const shown = seals
      .slice(0, 4)
      .map(
        (tile) =>
          `(${tile.row},${tile.col})${tile.kind === "inner-corner" ? "◆" : ""}`,
      )
      .join(" ");
    const rest = seals.length > 4 ? ` +${seals.length - 4}` : "";
    const hasCorner = seals.some((tile) => tile.kind === "inner-corner");
    out +=
      `\n        🔑 SEAL NOW: place 1 wall at ${shown}${rest} to close it` +
      (hasCorner
        ? " (◆ = inner-corner: seals the 8-dir diagonal leak the min-cut misses)"
        : "");
  }
  return out;
}

/** Prices idle build time: lists every enclosure still sealable in the time
 *  left (`feasible`). Present ⇒ a tower (+ maybe bonus squares) to bank, so
 *  build_toward instead of passing; absent ⇒ passing is correct. */
function stillSealableLines(obs: Observation, once: Once): string[] {
  const stillSealable = (obs.enclosureCandidates ?? []).filter(
    (candidate) => candidate.status === "enclosable" && candidate.feasible,
  );
  if (stillSealable.length === 0) return [];
  const parts = stillSealable.map((candidate) => {
    const who = candidate.isHome ? "home" : `tower ${candidate.towerIdx}`;
    const bonus =
      (candidate.bonusSquares ?? 0) > 0 ? `, ★+${candidate.bonusSquares}` : "";
    const wait =
      candidate.waitSeconds > 0
        ? ` incl ~${candidate.waitSeconds.toFixed(0)}s bag-wait`
        : "";
    return `${who} (~${candidate.estSeconds.toFixed(0)}s${wait}${bonus})`;
  });
  const tail = once(
    "stillSealableHowto",
    " Idle build time scores nothing; castle units + bonus squares only bank if enclosed — build_out() to claim all of them (then pre-claim the rest) before you pass.",
    " build_out() before you pass.",
  );
  return [
    `  ⏳ ${obs.timerSec}s left — still enclosable: ${parts.join(", ")}.${tail}`,
  ];
}

/** Highest points-per-tile build targets (bonus squares) in my zone. */
function bonusTargetLines(obs: Observation): string[] {
  if (!obs.bonusTargets || obs.bonusTargets.length === 0) return [];
  const lines: string[] = [
    `  ★ BONUS SQUARES in your zone (~${obs.bonusTargets[0]!.value}pts each — capture = enclose its tower):`,
  ];
  for (const bonus of obs.bonusTargets) {
    const tag = bonus.enclosed
      ? "BANKED (inside interior)"
      : bonus.capturedByTower != null
        ? `capture via tower ${bonus.capturedByTower}`
        : "open grass — needs dedicated walls";
    lines.push(`     (${bonus.row},${bonus.col}) ~${bonus.value}pts  [${tag}]`);
  }
  return lines;
}

/** Placement suggestions for the current piece (best ring-repairs first). */
function suggestionLines(obs: Observation): string[] {
  if (!obs.suggestions || obs.suggestions.length === 0) return [];
  const lines: string[] = [
    `  SUGGESTIONS for piece ${obs.me.currentPiece} (best ring-repairs first):`,
  ];
  for (const suggestion of obs.suggestions) {
    lines.push(
      `     place (${suggestion.row},${suggestion.col}) rot${suggestion.rotation}  -> fillsGap ${suggestion.fillsGap}, touchesWalls ${suggestion.touchingWalls}`,
    );
  }
  return lines;
}

/** Render the CANNON_PLACE shortlist as a ROLE MENU — one line per affordable
 *  mode, ordered by situational fit rather than a fixed normal-first dump (which
 *  structurally reads as "normal is the default" and buries the alternatives).
 *  The order is honest, not a fabricated point score: the one cross-mode signal
 *  the engine actually computes — a live balloon capture (`balloonOpportunity`)
 *  — floats a balloon to the TOP with its reason; a balloon with NO capturable
 *  target sinks to the BOTTOM (3 idle slots that do nothing this round); normal
 *  and super sit between as the neutral peers they are (cheap battery vs. 4-slot
 *  area denial — neither dominates, so neither is forced above the other). Each
 *  line still carries every affordable coord for that mode. `✗` = the min-cut
 *  says a re-seal can't wall around the footprint (UNSEALABLE risk — tight space
 *  only); `°` = ring-adjacent but routable (inert on a breach, re-arms at reseal). */
function renderCannonSpots(
  obs: Observation,
  suggestions: CannonSpots,
  once: Once,
): string[] {
  if (suggestions.length === 0) {
    return [
      "  CANNON SPOTS: none (no affordable footprint fits — end_cannon or pass)",
    ];
  }
  const lines: string[] = [
    once(
      "cannonSpotsHeader",
      "  CANNON SPOTS — pick by ROLE, ordered by situational fit (NOT a default; ★ = the mode the board rewards now). Coords safest-first; ✗ = tight spot, a re-seal can't wall around it after a breach → UNSEALABLE risk; ° = ring-adjacent: goes inert on a breach but re-arms at reseal:",
      "  CANNON SPOTS (role menu; ★ = board-favoured mode; coords safest-first; ✗ = UNSEALABLE risk; ° = ring-adjacent, inert on breach):",
    ),
  ];
  const byMode = new Map<string, CannonSpots>();
  for (const spot of suggestions) {
    const list = byMode.get(spot.mode) ?? [];
    list.push(spot);
    byMode.set(spot.mode, list);
  }
  const hasBalloonTarget = obs.balloonOpportunity !== undefined;
  // Situational rank: a live capture floats balloon to the top; a targetless
  // balloon sinks below the reliable modes; everything else keeps its order.
  const rankOf = (mode: string): number => {
    if (mode === "balloon") return hasBalloonTarget ? -1 : 9;
    return mode === "normal" ? 0 : mode === "super" ? 1 : 2;
  };
  const ordered = [...byMode.entries()].sort(
    ([a], [b]) => rankOf(a) - rankOf(b),
  );
  for (const [mode, list] of ordered) {
    const spots = list
      .map((spot) => {
        const mark =
          spot.routable === false
            ? "✗"
            : (spot.wallLineSides ?? 0) > 0
              ? "°"
              : "";
        return `(${spot.row},${spot.col})${mark}`;
      })
      .join(" ");
    // Per-role tag: honest situational value, keyed off the engine's own signal.
    const tag =
      mode === "balloon"
        ? hasBalloonTarget
          ? " ★ SEIZE the capturable enemy gun THIS battle (see 🎈) — then spent"
          : " ⚠ no enclosed enemy gun to seize right now — these 3 slots sit idle this round"
        : mode === "normal" && !hasBalloonTarget
          ? ringOnlyBattery(obs)
            ? " ⚠ every spot is ring-adjacent (°) — NOT recommended for a PERMANENT gun (inert on every breach, can block the reseal); prefer a balloon or leave the slot (see below)"
            : " ★ reliable battery — the default when nothing special is on offer"
          : "";
    lines.push(
      `     ${mode} ${list[0]!.size}x${list[0]!.size} (${list[0]!.slotCost} slot — ${list[0]!.role})${tag} -> ${spots}`,
    );
  }
  if (suggestions.every((spot) => spot.routable === false)) {
    lines.push(
      "     ⚠ NO routable spot — every affordable footprint is tight enough that a re-seal can't wall around it (→ the castle can become UNSEALABLE). Place FEWER cannons, or expand your interior first so a routable spot opens up.",
    );
  } else if (suggestions.every((spot) => (spot.wallLineSides ?? 0) > 0)) {
    lines.push(
      "     ⚠ every gun spot is ring-adjacent (°) — do NOT place a PERMANENT normal/super here: it sits on the wall seam, goes inert on EVERY breach, and can obstruct the re-seal a breach forces (the castle ends up unclosable). A BALLOON is fine (removed before WALL_BUILD → never blocks a wall later); otherwise leave the slot and expand your interior first so a deep spot opens up.",
    );
  }
  return lines;
}

/** The trap the `routable` flag misses: every available battery (normal/super)
 *  spot is RING-ADJACENT (`wallLineSides > 0`). `routable` is computed on BARE
 *  terrain ("could a ring route around this cannon on an empty board"), so it
 *  rates such a spot safe; but a PERMANENT normal dropped on the wall seam goes
 *  inert on EVERY breach and physically obstructs the re-seal an opponent's
 *  1–2-hole breach forces — exactly the case where the castle "can almost never
 *  be closed at the south". This used to also require the ring to already be
 *  breached/tight, but a gun placed on an intact ring is the same trap on a
 *  delay (the breach comes later; the gun is permanent) — so ring-adjacency
 *  alone now stands down every "fill your slots with normals" nudge. A balloon
 *  is fine there (removed before WALL_BUILD → never blocks a wall later), and
 *  leaving the slot is better than a normal. */
function ringOnlyBattery(obs: Observation): boolean {
  const battery = (obs.cannonSuggestions ?? []).filter(
    (spot) =>
      (spot.mode === "normal" || spot.mode === "super") && spot.routable,
  );
  if (battery.length === 0) return false;
  return battery.every((spot) => (spot.wallLineSides ?? 0) > 0);
}

/** The over-packing bag-lock predictor: the largest open pocket has shrunk to the
 *  3×3 MINIMUM that still admits any piece (`min(h,w) <= 3`). One more permanent 2×2
 *  cannon can drop it below a placeable footprint, so the NEXT build has no legal
 *  drop → a forfeited build, and a lost life if the un-dumpable piece was the one
 *  that would have re-sealed. At this margin the "fill your idle slots" push is
 *  actively harmful: an idle slot is recoverable next round, a bag-lock is not. Used
 *  to flip the idle-slot nudge from "keep placing normals" to "reserve the pocket". */
function dumpPocketAtRisk(obs: Observation): boolean {
  const pocket = obs.me.headroom?.openPocket;
  return pocket ? Math.min(pocket.h, pocket.w) <= 3 : false;
}

/** Grunt-cluster block: dense packs (≥2×2) the harness surfaces. Yours read as
 *  enclose-kill candidates (wall a ring round them → the block dies + the seal
 *  banks); an opponent's read as a grunt-pressure weak spot to breach/deny. Empty
 *  when there are no clusters. Pulled out to keep `renderObservation` simpler. */
function gruntClusterLines(obs: Observation, once: Once): string[] {
  if (!obs.gruntClusters || obs.gruntClusters.length === 0) return [];
  const lines: string[] = [];
  const box = (cluster: NonNullable<Observation["gruntClusters"]>[number]) =>
    `(${cluster.minRow},${cluster.minCol})–(${cluster.maxRow},${cluster.maxCol})`;
  const mine = obs.gruntClusters.filter((cluster) => cluster.mine);
  const theirs = obs.gruntClusters.filter((cluster) => !cluster.mine);
  if (mine.length > 0) {
    lines.push(
      "  ⚔ GRUNT CLUSTERS in your zone (≥2×2 packed — ENCLOSE-KILL candidates):",
    );
    const howto = once(
      "gruntClusterHowto",
      " walls a ring around them → enclosed-kills the block. Do it BEFORE they reach a chokepoint (they move during build); once they plug a tower's seal, only cull() frees you.",
      "",
    );
    for (const cluster of mine) {
      lines.push(
        `     ${cluster.count} grunts packed in ${box(cluster)} — build_region({ rect: { top: ${cluster.minRow}, bottom: ${cluster.maxRow}, left: ${cluster.minCol}, right: ${cluster.maxCol} } })${howto}`,
      );
    }
  }
  if (theirs.length > 0) {
    lines.push(
      "  ☼ OPPONENT grunt clusters (grunt-pressure weak spots — breach/deny there compounds with the grunts):",
    );
    for (const cluster of theirs) {
      lines.push(
        `     ${cluster.ownerName ?? "neutral zone"}: ${cluster.count} grunts packed in ${box(cluster)}`,
      );
    }
  }
  return lines;
}

/** Standings block: a final-placement table once the match is over, otherwise
 *  the live "projected if finalized now" line plus the two legibility caveats
 *  (breached-territory excluded; build-phase leads aren't final). Returns the
 *  lines to push — empty when there's no roster yet. */
function standingsLines(obs: Observation): string[] {
  const layout = obs.layout ?? [];
  if (layout.length === 0) return [];
  const out: string[] = [];

  if (obs.gameOver) {
    // The match is over: the closing round has already finalized, so `score` IS
    // the final result. The `projected` column assumes another round and is
    // meaningless now — show a clear placement table instead of build-phase
    // standings (and the caller skips the "re-seal your castle" EXPECTED line).
    const byScore = [...layout].sort((a, b) => b.score - a.score);
    // Winner rule: highest score among ALIVE players — an eliminated player
    // can't win while any opponent survives (fall back to all if everyone's
    // out). Mirrors peekGameOverOutcome's last-player / top-score logic.
    // No tie handling needed: an alive top-score tie never reaches game
    // over — peekGameOverOutcome routes it to a sudden-death extra round,
    // so by the time gameOver is true the top score is unique (or the
    // degenerate 0-alive slot-order case applies, matched by sort order).
    const alive = byScore.filter((player) => !player.eliminated);
    const winner = (alive.length > 0 ? alive : byScore)[0]!;
    const ordered = [winner, ...byScore.filter((player) => player !== winner)];
    out.push(
      `*** GAME OVER — WINNER: ${winner.name}${winner.isMe ? " (you)" : ""} — ${winner.score} ***`,
    );
    ordered.forEach((player, place) => {
      out.push(
        `   ${place + 1}. ${player.name}${player.isMe ? " (you)" : ""} — ${player.score}${player.eliminated ? " ☠ eliminated" : ""}`,
      );
    });
    return out;
  }

  // Mid-reseal, my projection EXCLUDES my breached territory (it's worth 0 "if
  // finalized now") while rivals' intact enclosures count in full — so the
  // headline can read like I'm losing when a single reseal restores the lead.
  // Flag it instead of letting the number mislead an autonomous agent. The tell
  // is stranded cannons (a sealed ring went open); this is 0 at game start /
  // pre-build, so it doesn't false-fire before there's anything to reseal.
  const breached = obs.me.cannonsUnenclosed > 0;
  const ranked = [...layout].sort((a, b) => b.projected - a.projected);
  const parts = ranked.map(
    (player) =>
      `${player.name} ${player.projected}` +
      (player.projected === player.score ? "" : `(now ${player.score})`) +
      (player.isMe ? (breached ? "*⚠" : "*") : ""),
  );
  out.push(
    `STANDINGS (projected if round finalized now): ${parts.join(" > ")}`,
  );
  if (breached) {
    out.push(
      "   ⚠ your projection EXCLUDES your breached/unsealed territory (worth 0 'if finalized now') — RESEAL to restore it; the lead may flip back",
    );
  }
  // The projection freezes opponents at their CURRENT enclosure, but during
  // WALL_BUILD they're sealing too — a battle-time denial they reseal won't
  // hold, and a build-phase lead can flip by finalize. Don't coast on it.
  if (obs.phase === "WALL_BUILD") {
    out.push(
      "   ℹ projection assumes rivals DON'T keep building — but they are; a build-phase lead isn't final (capture bonus squares / keep denying, don't just pass).",
    );
  }
  return out;
}

/** Format a tile list as "(r,c) (r,c) …", capped so a big set (fat walls can run
 *  to dozens) can't blow up the line — appends "+N more" when truncated. */
function tileList(
  tiles: readonly { row: number; col: number }[],
  cap = 12,
): string {
  const shown = tiles
    .slice(0, cap)
    .map((tile) => `(${tile.row},${tile.col})`)
    .join(" ");
  return tiles.length > cap ? `${shown} +${tiles.length - cap} more` : shown;
}

/** Render a bounding box (`CastleBounds`) or a home position, or an em-dash when
 *  absent. One helper covers both the home `(row,col)` point and the castle box,
 *  since both fall back to "—". */
function box(
  region:
    | { minRow: number; maxRow: number; minCol: number; maxCol: number }
    | { row: number; col: number }
    | null,
): string {
  if (!region) return "—";
  if ("minRow" in region) {
    return `r${region.minRow}-${region.maxRow} c${region.minCol}-${region.maxCol}`;
  }
  return `(${region.row},${region.col})`;
}
