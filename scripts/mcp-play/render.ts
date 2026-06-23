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

import type { Observation } from "./harness.ts";

/** Render an observation as the annotated ASCII board (header, standings,
 *  roster, battery, aim-assist sections, then the raw board the harness baked).
 *  Faithful to the curated `tmp/show.py` layout. */
export function renderObservation(obs: Observation): string {
  const lines: string[] = [];

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

  // ── standings: sort by projected score, mark me ─────────────────────────────
  const layout = obs.layout ?? [];
  // Mid-reseal, my projection EXCLUDES my breached territory (it's worth 0 "if
  // finalized now") while rivals' intact enclosures count in full — so the
  // headline can read like I'm losing when a single reseal restores the lead.
  // Flag it instead of letting the number mislead an autonomous agent. The tell
  // is stranded cannons (a sealed ring went open); this is 0 at game start /
  // pre-build, so it doesn't false-fire before there's anything to reseal.
  const breached = obs.me.cannonsUnenclosed > 0;
  if (layout.length > 0) {
    const ranked = [...layout].sort((a, b) => b.projected - a.projected);
    const parts = ranked.map(
      (player) =>
        `${player.name} ${player.projected}` +
        (player.projected === player.score ? "" : `(now ${player.score})`) +
        (player.isMe ? (breached ? "*⚠" : "*") : ""),
    );
    lines.push(
      `STANDINGS (projected if round finalized now): ${parts.join(" > ")}`,
    );
    if (breached) {
      lines.push(
        "   ⚠ your projection EXCLUDES your breached/unsealed territory (worth 0 'if finalized now') — RESEAL to restore it; the lead may flip back",
      );
    }
  }

  lines.push(`EXPECTED: ${obs.expected}`);

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

  // ── my battery + status line (battery prints before the YOU line, as in show.py) ─
  const me = obs.me;
  const slots = me.cannonSlots;
  let mine = `  YOU: piece=${me.currentPiece}  cannonSlots ${slots.used}/${slots.max}`;
  if (obs.phase === "BATTLE") {
    mine += `  cannonsReady ${me.cannonsReady}/${me.cannonPositions.length}`;
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
  if (me.cannonPositions.length > 0) {
    const guns = me.cannonPositions.map(
      (cannon) =>
        `(${cannon.row},${cannon.col})` +
        ((cannon.reason ?? "").includes("unenclosed") ? "✗" : ""),
    );
    mine += `  guns=${guns.join(",")}`;
  }
  lines.push(mine);

  // ── BATTLE aim-assist: opponents + their towers as breach targets ───────────
  if (obs.targets) {
    lines.push(
      "  TARGETS (leader first — bombard=spread walls / breach=open one tower's pocket):",
    );
    for (const target of obs.targets) {
      const tiles = target.sampleTiles
        .slice(0, 6)
        .map((tile) => `(${tile.row},${tile.col})`)
        .join(",");
      lines.push(
        `     ${target.name.padEnd(
          5,
        )} ${target.score}pts ${target.walls}w  -> ${tiles}`,
      );
      for (const tower of target.towers ?? []) {
        const star = tower.bonusSquares ? `  ★${tower.bonusSquares}bonus` : "";
        lines.push(
          `        breach tower ${tower.towerIdx} (${tower.row},${tower.col})  ring ${tower.ringWalls}w${star}`,
        );
      }
    }
  }

  // ── BATTLE pit targets: best super-cannon pit walls, choke-ranked ───────────
  if (obs.pitTargets) {
    lines.push(
      "  🔥 PIT TARGETS (super-cannon → burning pit; pit_strike(slot, targets) — choke=un-reroutable sides):",
    );
    for (const pit of obs.pitTargets) {
      const tower = pit.towerIdx != null ? ` tower${pit.towerIdx}` : "";
      lines.push(
        `     slot${pit.slot} (${pit.row},${pit.col})  choke ${pit.choke}/4${tower}`,
      );
    }
  }

  // ── threats: grunts bearing down on my towers ───────────────────────────────
  // List in FULL only the ones that can actually reach a tower this build —
  // EXPOSED (tower not walled) or actively ATTACKING. The many [walled] grunts
  // can't touch a tower while the ring holds, so collapse them to one summary
  // line instead of burying the urgent ones under a dozen harmless rows.
  if (obs.threats && obs.threats.length > 0) {
    const urgent = obs.threats.filter(
      (threat) => !threat.towerEnclosed || threat.attacking,
    );
    const walled = obs.threats.filter(
      (threat) => threat.towerEnclosed && !threat.attacking,
    );
    lines.push(
      "  ⚠ THREATS (grunts that can reach a tower — most urgent first):",
    );
    for (const threat of urgent) {
      const grunt = threat.grunt;
      const tower = threat.tower;
      const flag = threat.towerEnclosed ? "walled" : "EXPOSED";
      const attacking = threat.attacking ? " ATTACKING!" : "";
      const wall = threat.targetedWall
        ? ` wall(${threat.targetedWall.row},${threat.targetedWall.col})`
        : "";
      lines.push(
        `     ${threat.kind} (${grunt.row},${grunt.col}) -> tower ${tower.idx} (${tower.row},${tower.col}) dist ${threat.distance} [${flag}]${attacking}${wall}`,
      );
    }
    if (walled.length > 0) {
      const nearest = walled[0]!;
      lines.push(
        `     + ${walled.length} grunt(s) behind your walls (nearest: ${nearest.kind} dist ${nearest.distance} → tower ${nearest.tower.idx}) — can't reach while that ring holds`,
      );
    }
  }

  // ── selection: pickable towers in my zone ───────────────────────────────────
  if (obs.towers) {
    const picks = obs.towers
      .map((tower) => `${tower.index}→(${tower.row},${tower.col})`)
      .join("  ");
    lines.push(`  PICKABLE TOWERS: ${picks}`);
  }

  // ── cannon spots: legal placements grouped by mode, safe-interior first ──────
  if (obs.cannonSuggestions !== undefined) {
    const suggestions = obs.cannonSuggestions;
    if (suggestions.length > 0) {
      lines.push(
        "  CANNON SPOTS (deepest-interior first; ✗ = footprint touches your outer wall — prefer interior when available):",
      );
      const byMode = new Map<string, typeof suggestions>();
      for (const spot of suggestions) {
        const list = byMode.get(spot.mode) ?? [];
        list.push(spot);
        byMode.set(spot.mode, list);
      }
      for (const [mode, list] of byMode) {
        const spots = list
          .map(
            (spot) =>
              `(${spot.row},${spot.col})` +
              ((spot.wallLineSides ?? 0) > 0 ? "✗" : ""),
          )
          .join(" ");
        lines.push(
          `     ${mode} ${list[0]!.size}x${list[0]!.size} (${
            list[0]!.slotCost
          } slot) -> ${spots}`,
        );
      }
      if (suggestions.every((spot) => (spot.wallLineSides ?? 0) > 0)) {
        lines.push(
          "     (none are fully interior — castle too tight; the ✗ spots are the safest that fit)",
        );
      }
    } else {
      lines.push(
        "  CANNON SPOTS: none (no affordable footprint fits — end_cannon or pass)",
      );
    }
  }

  // ── enclosure candidates: min-cut plans, blocker-aware feasibility ──────────
  if (obs.enclosureCandidates) {
    lines.push("  ENCLOSURE CANDIDATES (home first, then cheapest):");
    for (const candidate of obs.enclosureCandidates) {
      const who = candidate.isHome ? "home" : "tower";
      let line = `     ${who} ${candidate.towerIdx}: ${candidate.status}`;
      if (candidate.status === "enclosable") {
        const tiles = candidate.tiles
          .slice(0, 10)
          .map((tile) => `(${tile.row},${tile.col})`)
          .join(",");
        const more =
          candidate.tiles.length <= 10
            ? ""
            : ` +${candidate.tiles.length - 10}`;
        const blockers = candidate.blockers ?? [];
        let fit: string;
        if (blockers.length > 0) {
          let desc = blockers
            .slice(0, 4)
            .map((blocker) => `(${blocker.row},${blocker.col}) ${blocker.kind}`)
            .join(", ");
          if (blockers.length > 4) desc += ` +${blockers.length - 4}`;
          fit = `${
            blockers.some((blocker) => blocker.hard)
              ? "⛔ BLOCKED"
              : "soft-block"
          }: ${desc}`;
        } else {
          fit = candidate.feasible
            ? "fits in time"
            : "WON'T FINISH in time left";
        }
        line += `  ${candidate.tilesNeeded} tiles ~${candidate.estSeconds.toFixed(
          0,
        )}s [${fit}] -> ${tiles}${more}`;
      } else if (candidate.status === "unenclosable" && candidate.reason) {
        line += `  (${candidate.reason})`;
      }
      if ((candidate.bonusSquares ?? 0) > 0) {
        line += `  ★+${candidate.bonusSquares} BONUS`;
      }
      lines.push(line);
    }
  }

  // ── fragile walls: my ≤1-neighbour tiles the round-end sweep deletes ─────────
  if (obs.fragileWalls && obs.fragileWalls.length > 0) {
    const tiles = obs.fragileWalls
      .map((tile) => `(${tile.row},${tile.col})`)
      .join(" ");
    lines.push(
      `  ⚠ FRAGILE WALLS (${obs.fragileWalls.length}, ≤1 wall-neighbor — round-end sweep deletes these; anchor or extend): ${tiles}`,
    );
  }

  // ── bonus squares: highest points-per-tile build targets in my zone ─────────
  if (obs.bonusTargets && obs.bonusTargets.length > 0) {
    lines.push(
      `  ★ BONUS SQUARES in your zone (~${
        obs.bonusTargets[0]!.value
      }pts each — capture = enclose its tower):`,
    );
    for (const bonus of obs.bonusTargets) {
      const tag = bonus.enclosed
        ? "BANKED (inside interior)"
        : bonus.capturedByTower != null
          ? `capture via tower ${bonus.capturedByTower}`
          : "open grass — needs dedicated walls";
      lines.push(
        `     (${bonus.row},${bonus.col}) ~${bonus.value}pts  [${tag}]`,
      );
    }
  }

  // ── placement suggestions for the current piece (ring repairs first) ─────────
  if (obs.suggestions && obs.suggestions.length > 0) {
    lines.push(
      `  SUGGESTIONS for piece ${me.currentPiece} (best ring-repairs first):`,
    );
    for (const suggestion of obs.suggestions) {
      lines.push(
        `     place (${suggestion.row},${suggestion.col}) rot${suggestion.rotation}  -> fillsGap ${suggestion.fillsGap}, touchesWalls ${suggestion.touchingWalls}`,
      );
    }
  }

  lines.push(obs.board);
  return lines.join("\n");
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
