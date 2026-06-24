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

  // ── standings (or final results, once the match is over) ────────────────────
  for (const line of standingsLines(obs)) lines.push(line);

  if (!obs.gameOver) lines.push(`EXPECTED: ${obs.expected}`);

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

  // ── grunt clusters: dense packs (≥2×2) worth enclosing / opponent weak spots ─
  lines.push(...gruntClusterLines(obs));

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
          "     ⚠ NO safe spot — every ✗ sits on the outer ring: a ring-cannon goes INERT the moment that wall is breached, and the re-seal can't route around it without orphaning a 1-tile gap (→ the castle can become UNSEALABLE).",
        );
        lines.push(
          "       Mitigate: place FEWER cannons this round, or expand your interior first so a buffered (non-✗) spot opens up — don't reflexively fill every slot on the ring.",
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
        const drift = candidate.driftTiles ?? [];
        if (drift.length > 0) {
          const shown = drift
            .slice(0, 3)
            .map((tile) => `(${tile.row},${tile.col}) ~${tile.etaSeconds}s`)
            .join(" ");
          const rest = drift.length > 3 ? ` +${drift.length - 3}` : "";
          line +=
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
          line +=
            `\n        🔑 SEAL NOW: place 1 wall at ${shown}${rest} to close it` +
            (hasCorner
              ? " (◆ = inner-corner: seals the 8-dir diagonal leak the min-cut misses)"
              : "");
        }
      } else if (candidate.status === "unenclosable" && candidate.reason) {
        line += `  (${candidate.reason})`;
      }
      if ((candidate.bonusSquares ?? 0) > 0) {
        line += `  ★+${candidate.bonusSquares} BONUS`;
      }
      lines.push(line);
    }
  }

  // ── opportunity cost of passing: prices idle build time at the decision point ─
  // Lists every enclosure still sealable in the time left (`feasible`). Present ⇒
  // there's a tower to bank (a castle unit) and maybe bonus squares with it, so
  // build_toward instead of passing; ABSENT ⇒ nothing's reachable and passing is
  // correct. Disappears the instant the last feasible tower seals — so the line's
  // presence IS the answer to "should I pass yet?".
  const stillSealable = (obs.enclosureCandidates ?? []).filter(
    (candidate) => candidate.status === "enclosable" && candidate.feasible,
  );
  if (stillSealable.length > 0) {
    const parts = stillSealable.map((candidate) => {
      const who = candidate.isHome ? "home" : `tower ${candidate.towerIdx}`;
      const bonus =
        (candidate.bonusSquares ?? 0) > 0
          ? `, ★+${candidate.bonusSquares}`
          : "";
      return `${who} (~${candidate.estSeconds.toFixed(0)}s${bonus})`;
    });
    lines.push(
      `  ⏳ ${obs.timerSec}s left — still enclosable: ${parts.join(
        ", ",
      )}. Idle build time scores nothing; castle units + bonus squares only bank if enclosed — build_out() to claim all of them (then pre-claim the rest) before you pass.`,
    );
  }

  // ── fat walls: SUNK history, not a to-do — in classic no placed wall is removable ─
  // Count-only (the coords are non-actionable: you can't un-place a wall, and a
  // sealed ring is sweep-proof regardless). The lever is purely forward.
  if (obs.fatWalls && obs.fatWalls.length > 0) {
    lines.push(
      `  ℹ fat walls: ${obs.fatWalls.length} interior tiles fully boxed by your own territory (former perimeters you expanded past + piece-overflow). SUNK — in classic a placed wall can't be removed, so this isn't a to-do and isn't a defensive hole. The only avoidable fat is fat you haven't placed yet: send new pieces to the frontier (build_toward / ↗ EXTEND), not into interior.`,
    );
  }

  // ── loose wall ends: ≤1-neighbour stubs the round-end sweep deletes ─────────
  // NOT an alarm — a closed ring's walls always keep ≥2 neighbours, so the sweep
  // can only ever shave dangling stubs; it can never open a sealed pocket. They
  // only cost you on an UN-closed cross-round pre-claim line (build_path).
  if (obs.fragileWalls && obs.fragileWalls.length > 0) {
    lines.push(
      `  ◦ loose wall ends (${obs.fragileWalls.length}, ≤1 wall-neighbor — swept at round end): harmless to a sealed castle (you can even dump a dud piece here); only anchor one if it's part of a build_path pre-claim you'll close a later round: ${tileList(obs.fragileWalls)}`,
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

/** Grunt-cluster block: dense packs (≥2×2) the harness surfaces. Yours read as
 *  enclose-kill candidates (wall a ring round them → the block dies + the seal
 *  banks); an opponent's read as a grunt-pressure weak spot to breach/deny. Empty
 *  when there are no clusters. Pulled out to keep `renderObservation` simpler. */
function gruntClusterLines(obs: Observation): string[] {
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
    for (const cluster of mine) {
      lines.push(
        `     ${cluster.count} grunts packed in ${box(cluster)} — wall a ring AROUND them to kill the whole block + bank the seal in one move (do it BEFORE they reach your chokepoint; once they plug it, only cull() frees you)`,
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
