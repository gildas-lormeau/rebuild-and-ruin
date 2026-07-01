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
import type { Observation } from "./harness.ts";

type CannonSpots = NonNullable<Observation["cannonSuggestions"]>;

/** Show-once gate threaded into the section helpers: returns `full` the first
 *  time `key` is seen in a session, `terse` thereafter. See `renderObservation`. */
type Once = (key: string, full: string, terse: string) => string;

/** Terse one-line replacements for the per-phase EXPECTED menus, keyed by the
 *  `Observation.phase` string. The full menu (from `expectedFor` in harness.ts)
 *  is emitted the FIRST time a phase is seen in a session; thereafter a stateful
 *  agent that already read it gets this pointer instead. */
const TERSE_EXPECTED: Record<string, string> = {
  CASTLE_SELECT: "CASTLE_SELECT — select { towerIdx } a home tower.",
  WALL_BUILD:
    "WALL_BUILD — build_out (default, seals everything that fits) / build_toward { towerIdx } / build_path { from, to } / hand place { row, col, rotation } / pass. (full menu: round 1)",
  CANNON_PLACE:
    "CANNON_PLACE — cannon { row, col, mode }; see CANNON SPOTS for affordable spots; cannon-done / pass. (full menu: round 1)",
  UPGRADE_PICK:
    "UPGRADE_PICK — pick-upgrade { cardIdx 0|1|2 } from UPGRADE OFFERS. (full menu: round 1)",
  BATTLE:
    "BATTLE — bombard { slot } (spread) / breach { slot, towerIdx? } (min-cut open a pocket) / pit_strike { slot } / cull (defend vs your grunts) / declutter (shoot out your own fat to avoid a bag-lock) / fire { row, col } (snipe). See TARGETS. (full menu: round 1)",
};

/** Render an observation as the annotated ASCII board (header, standings,
 *  roster, battery, aim-assist sections, then the raw board the harness baked).
 *  Faithful to the curated `tmp/show.py` layout. */
export function renderObservation(
  obs: Observation,
  seen: Set<string> = new Set<string>(),
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
  lines.push(...batteryStatusLines(obs));

  // ── build headroom: free land + open-pocket gauge (the cannon-count signal) ──
  lines.push(...headroomLines(obs));

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

  // ── cannon spots: legal placements grouped by mode, safe-interior first ──────
  if (obs.cannonSuggestions !== undefined) {
    for (const line of renderCannonSpots(obs.cannonSuggestions, once))
      lines.push(line);
  }

  // ── balloon opportunity: conditional cannon-phase nudge to steal an enemy super ─
  lines.push(...balloonOpportunityLines(obs));

  // ── survival warning: no alive/revivable enclosed tower = a life lost at round
  //    end. Gate on `survivesRoundEnd` (credits pending / Restoration-Crew
  //    revives), NOT the raw alive count, which false-alarmed while RC was held. ──
  if (obs.enclosureCandidates !== undefined && !obs.me.survivesRoundEnd) {
    // Point at a tower whose seal actually CLEARS the loss — alive, or dead-but-
    // revivable via Restoration Crew (`satisfiesSurvival`). Enclosing a plain dead
    // tower banks territory but still costs the life, so "reseal the cheapest
    // candidate" was a footgun when the cheapest one was dead.
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
    const hint = saver
      ? ` → call seal_survivor() now — ONE call seals a compartment around ${saver.isHome ? "home" : `tower ${saver.towerIdx}`} (~${saver.estSeconds.toFixed(0)}s)${saver.alive ? "" : " — dead but Restoration Crew revives it on enclose"}, no coordinates. Passing forfeits the life; enclosing a DEAD tower does NOT count.`
      : " ⚠ No survival-clearing tower is reachable this build — enclosing a dead tower will NOT prevent the life loss.";
    lines.push(
      "  ☠ SURVIVAL: NO alive tower enclosed — finalize the round like this and you LOSE A LIFE and your whole zone resets to bare ground." +
        hint,
    );
  }

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
    const { interior, fat, fatPer100 } = obs.compactness;
    lines.push(
      `  ▣ compactness: ${interior} interior (scoring) tiles, ${fat} sunk fat = ${fatPer100} fat/100. ` +
        `${fatPer100 >= 20 ? "HIGH — you're expanding past old shells; prefer build_toward(<nearest>) over build_out" : "lean — keep sending pieces to the frontier"}.`,
    );
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

  // The board carries a constant glyph legend (the first LEGEND_LINE_COUNT
  // lines, incl. a round/score line that ROSTER + STANDINGS already cover).
  // Show it once per session, then drop it — the coordinate headers below it
  // stay, so the agent never loses tile-citing context.
  lines.push(
    once(
      "board:legend",
      obs.board,
      obs.board.split("\n").slice(LEGEND_LINE_COUNT).join("\n"),
    ),
  );
  return lines.join("\n");
}

/** Severity-ranked verdict header — the agent's "read this FIRST" digest. The
 *  harness derives the strings (`obs.alerts`); the renderer only frames them so
 *  the ordering/wording stays in one place. Empty when nothing is flagged. */
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
function batteryStatusLines(obs: Observation): string[] {
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
  return [
    `  🎈 BALLOON OPPORTUNITY: ${balloon.name}'s ${mode} at (${gr},${gc}) is capturable — ${action}. Near-free on slots you'd otherwise leave idle (a seized gun is a +1/−1 swing).`,
  ];
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
        ? "  ⚑DEAD (revives on enclose — Restoration Crew)"
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
  let out = `  ${candidate.tilesNeeded} tiles ~${candidate.estSeconds.toFixed(0)}s [${fit}] -> ${tiles}${more}`;
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
    return `${who} (~${candidate.estSeconds.toFixed(0)}s${bonus})`;
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

/** Render the CANNON_PLACE shortlist: spots grouped by mode, safest first.
 *  `✗` = the routability min-cut says a re-seal can't wall around the footprint
 *  (UNSEALABLE risk — tight space only); `°` = ring-adjacent but routable (goes
 *  inert on a breach, re-arms at reseal). The warning fires only when EVERY
 *  affordable spot is unroutable — never just because spots hug a clean ring. */
function renderCannonSpots(suggestions: CannonSpots, once: Once): string[] {
  if (suggestions.length === 0) {
    return [
      "  CANNON SPOTS: none (no affordable footprint fits — end_cannon or pass)",
    ];
  }
  const lines: string[] = [
    once(
      "cannonSpotsHeader",
      "  CANNON SPOTS (safest first; ✗ = tight spot, a re-seal can't wall around it after a breach → UNSEALABLE risk; ° = ring-adjacent: goes inert on a breach but re-arms at reseal):",
      "  CANNON SPOTS (safest first; ✗ = UNSEALABLE risk; ° = ring-adjacent, inert on breach):",
    ),
  ];
  const byMode = new Map<string, CannonSpots>();
  for (const spot of suggestions) {
    const list = byMode.get(spot.mode) ?? [];
    list.push(spot);
    byMode.set(spot.mode, list);
  }
  for (const [mode, list] of byMode) {
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
    lines.push(
      `     ${mode} ${list[0]!.size}x${list[0]!.size} (${list[0]!.slotCost} slot — ${list[0]!.role}) -> ${spots}`,
    );
  }
  if (suggestions.every((spot) => spot.routable === false)) {
    lines.push(
      "     ⚠ NO routable spot — every affordable footprint is tight enough that a re-seal can't wall around it (→ the castle can become UNSEALABLE). Place FEWER cannons, or expand your interior first so a routable spot opens up.",
    );
  } else if (suggestions.every((spot) => (spot.wallLineSides ?? 0) > 0)) {
    lines.push(
      "     ℹ no deep-interior spot yet (expected on a fresh castle) — the ° spots are routable but go inert when their ring wall is breached, re-arming at reseal. Recoverable, so place a normal complement if you want offense.",
    );
  }
  return lines;
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
    // out). Mirrors peekGameOverOutcome's last-player / score-tiebreak logic.
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
