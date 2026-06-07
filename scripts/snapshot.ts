/**
 * Capture an ASCII snapshot of the board at a specific (seed, round, phase,
 * moment), optionally cropped to one player's footprint.
 *
 * Usage:
 *   npm run snapshot -- --seed 1000000 --round 20 --phase WALL_BUILD
 *   npm run snapshot -- --seed 42 --round 5 --phase BATTLE --moment end --player BLUE
 *   npm run snapshot -- --seed 1000000 --mode classic --round 3 --phase CANNON_PLACE
 *   npm run snapshot -- --seed 42 --round 5 --phase BATTLE --at 3.5
 *   npm run snapshot -- --fixture test/phase-tests/fixtures/wall-build/round-pits-1.json
 *
 * Source: either a --seed (booted at round 1) or a --fixture (a phase-test
 * fixture resumed at its captured entry phase/round). With --fixture, --round
 * and --phase default to the entry moment; asking for the entry phase at
 * --moment start renders immediately (no PHASE_START fires for a mid-phase
 * checkpoint resume), while a later round/phase runs the runtime forward.
 *
 * --round N is a WATCH TARGET — does NOT change game state. The match
 * defaults to to-the-death (state.maxRounds = Infinity) so RNG-consuming
 * code gated on maxRounds (e.g. upgrade-system's "skip pick for the final
 * round") never trips. That means the r29 snapshot is IDENTICAL whether
 * you ask for --round 29 or --round 50. Use --match-rounds M to constrain
 * match length explicitly (rare).
 *
 * --phase: CASTLE_SELECT | CANNON_PLACE | MODIFIER_REVEAL | BATTLE |
 *          UPGRADE_PICK | WALL_BUILD
 * --moment: start (default — at PHASE_START) | end (just after the phase exits)
 * --at <seconds>: sim-seconds elapsed since the target phase's PHASE_START.
 *          Wins over --moment. Errors if the phase exits before reaching
 *          the requested offset. Sub-second values (e.g. 2.5) are fine —
 *          the runtime advances one frame at a time so granularity is bounded
 *          by the sim frame budget, not seconds.
 * --player RED|BLUE|GOLD: highlights that player + crops the ASCII to
 *          their footprint (`cropTo: playerId` auto-computes the bbox)
 * --tower N / --castle RED|BLUE|GOLD / --at-tile ROW,COL: focus the crop
 *          window on one entity — works even when it is NOT enclosed (no
 *          player footprint needed). At most one focus target.
 * --zoom R: crop radius in tiles. With a focus target → half-window size
 *          around it (default 8). With --player + no target → padding
 *          added around the footprint (zoom out). ASCII keeps one char per
 *          tile, so "zoom" means window size, not glyph magnification.
 * --each-placement: instead of one moment, render a snapshot after EACH
 *          placement --player makes during a placement phase (WALL_BUILD /
 *          CASTLE_SELECT → labeled with the piece shape; CANNON_PLACE →
 *          labeled with the cannon mode). Requires --player. Combine with
 *          --at SECONDS to stop once that many sim-seconds have elapsed
 *          since PHASE_START, or --max-placements N to cap the count.
 *
 * Conditional phases (MODIFIER_REVEAL, UPGRADE_PICK) don't fire every round;
 * asking for one in a round that doesn't have it will time out.
 *
 * Body wrapped in main() because Biome hoists top-level consts past their
 * init-order dependencies.
 */

import type { Rect } from "../dev/dev-console-grid.ts";
import { setAiBuildDiagHook } from "../src/ai/ai-build-diag.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { playerByZone } from "../src/shared/core/player-types.ts";
import { unpackTile } from "../src/shared/core/spatial.ts";
import type { GameState } from "../src/shared/core/types.ts";
import { type Scenario, waitForEvent } from "../test/scenario.ts";
import {
  type ResolvedScenarioSource,
  resolveScenarioSource,
} from "./scenario-source.ts";

interface Args {
  seed: number | undefined;
  /** Phase-fixture path. Mutually exclusive with --seed: the fixture supplies
   *  seed / mode / rounds, and --round / --phase default to its entry moment.
   *  Resumes via createPhaseScenario instead of booting at round 1. */
  fixture: string | undefined;
  mode: "classic" | "modern";
  round: number | undefined;
  /** Match-length cap (state.maxRounds). 0 = to-the-death (Infinity).
   *  Default 0 so --round never silently shifts AI-visible state. */
  matchRounds: number;
  phase: Phase | undefined;
  moment: "start" | "end";
  /** Sim-seconds elapsed since PHASE_START, when provided. Overrides moment. */
  at: number | undefined;
  player: 0 | 1 | 2 | undefined;
  /** Focus the crop on one tower by its anchor index (state.map.towers[N]). */
  tower: number | undefined;
  /** Focus the crop on a player's home tower (castle), enclosed or not. */
  castle: 0 | 1 | 2 | undefined;
  /** Focus the crop on an arbitrary (row, col) center. */
  atTile: { row: number; col: number } | undefined;
  /** Crop window radius in tiles. With a focus target → half-window size
   *  around it (default DEFAULT_FOCUS_ZOOM). With --player and no target →
   *  padding added around the footprint. */
  zoom: number | undefined;
  /** Render one snapshot after EACH wall placement by `--player` during the
   *  target build phase (instead of a single moment), labeling each with the
   *  piece shape. Requires --player. `--at SECONDS` caps the window (stop once
   *  that many sim-seconds have elapsed since PHASE_START). */
  eachPlacement: boolean;
  /** Optional cap on the number of per-placement snapshots in --each-placement
   *  mode (default: unbounded — runs to phase end). */
  maxPlacements: number | undefined;
}

const PLAYER_NAMES = ["RED", "BLUE", "GOLD"] as const;
/** Default half-window radius for a focus target when --zoom is omitted. */
const DEFAULT_FOCUS_ZOOM = 8;
const HELP_TEXT = `Capture an ASCII snapshot of the board at a specific (seed, round, phase,
moment), optionally cropped to one player's footprint.

Usage:
  npm run snapshot -- --seed N --round N --phase PHASE [options]
  npm run snapshot -- --fixture PATH [options]
  deno run -A scripts/snapshot.ts --seed N --round N --phase PHASE [options]

Options:
  --seed N               Seed to play (REQUIRED unless --fixture is given).
  --round N              Watch target round (REQUIRED with --seed; defaults to
                         the fixture's entry round). Does NOT change game state.
  --phase PHASE          Target phase (REQUIRED with --seed; defaults to the
                         fixture's entry phase). One of:
                         CASTLE_SELECT | CANNON_PLACE | MODIFIER_REVEAL |
                         BATTLE | UPGRADE_PICK | WALL_BUILD.
  --fixture PATH         Phase-fixture JSON to resume from instead of a seed.
                         Supplies seed/mode/rounds; --round/--phase default to
                         its entry moment, so '--fixture X.json' alone snapshots
                         the entry board. Mutually exclusive with --seed.
                         Asking for the entry phase at --moment start needs no
                         wait (the runtime is already there); a later round/
                         phase runs forward normally. Checkpoint fixtures can't
                         snapshot a round BEFORE their entry round.
  --mode classic|modern  Game mode (default: modern). Ignored with --fixture.
  --match-rounds M       Match-length cap (state.maxRounds). 0 = to-the-death
                         (default: 0). Ignored with --fixture.
  --moment start|end     start (default, at PHASE_START) | end (just after the
                         phase exits).
  --at SECONDS           Sim-seconds elapsed since the phase's PHASE_START.
                         Overrides --moment. Errors if the phase exits first.
  --player RED|BLUE|GOLD Highlight that player and crop the ASCII to their
                         footprint.

Per-placement mode (one snapshot after each placement instead of a moment):
  --each-placement       Render a snapshot after every placement --player makes
                         during the target phase. WALL_BUILD / CASTLE_SELECT
                         label each with the piece shape; CANNON_PLACE labels
                         each with the cannon mode. Requires --player. Honors
                         --at SECONDS (stop after that elapsed) and the focus/
                         zoom crop flags.
  --max-placements N     Cap the number of per-placement snapshots (default:
                         run to phase end).

Focus a crop window on one entity (works even when it is NOT enclosed — no
player footprint required). At most one of these may be given:
  --tower N              Center on tower index N (the #N shown in Anchors).
  --castle RED|BLUE|GOLD Center on a player's home tower (castle).
  --at-tile ROW,COL      Center on an arbitrary tile, e.g. --at-tile 12,34.
  --zoom R               Crop radius in tiles. With a focus target, half the
                         window size around it (default ${DEFAULT_FOCUS_ZOOM});
                         smaller = tighter. With --player and no focus target,
                         padding added around the footprint to zoom OUT.
  --help, -h             Show this help and exit.

"Zoom" is a crop-window radius, not glyph magnification — ASCII keeps one
character per tile, so a smaller window simply shows fewer tiles. A focus
target may be combined with --player to tint a player inside the window.

Conditional phases (MODIFIER_REVEAL, UPGRADE_PICK) don't fire every round;
asking for one in a round that doesn't have it will time out.

Examples:
  npm run snapshot -- --seed 1000000 --round 20 --phase WALL_BUILD
  npm run snapshot -- --seed 42 --round 5 --phase BATTLE --moment end --player BLUE
  npm run snapshot -- --seed 1000000 --mode classic --round 3 --phase CANNON_PLACE
  npm run snapshot -- --seed 42 --round 5 --phase BATTLE --at 3.5
  npm run snapshot -- --seed 42 --round 5 --phase BATTLE --castle RED --zoom 6
  npm run snapshot -- --seed 42 --round 5 --phase WALL_BUILD --tower 3
  npm run snapshot -- --seed 42 --round 8 --phase WALL_BUILD --player BLUE --zoom 4
  npm run snapshot -- --seed 42 --round 1 --phase WALL_BUILD --player RED --castle RED --each-placement --at 15
  npm run snapshot -- --seed 42 --round 1 --phase CANNON_PLACE --player RED --castle RED --each-placement
  npm run snapshot -- --fixture test/phase-tests/fixtures/wall-build/round-pits-1.json`;

await main();

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.fixture !== undefined && args.seed !== undefined) {
    console.error("--fixture and --seed are mutually exclusive");
    Deno.exit(1);
  }
  // Seed path requires seed + round + phase; fixture path defaults round/phase
  // from the fixture's entry moment, so only --fixture is required there.
  if (
    args.fixture === undefined &&
    (args.seed === undefined ||
      args.round === undefined ||
      args.phase === undefined)
  ) {
    console.error(
      "Usage: npm run snapshot -- (--seed N --round N --phase PHASE | --fixture PATH) " +
        "[--mode classic|modern] [--match-rounds M] " +
        "[--moment start|end | --at SECONDS] " +
        "[--player RED|BLUE|GOLD] " +
        "[--tower N | --castle RED|BLUE|GOLD | --at-tile ROW,COL] [--zoom R]",
    );
    console.error(
      "  PHASE: CASTLE_SELECT | CANNON_PLACE | MODIFIER_REVEAL | BATTLE | UPGRADE_PICK | WALL_BUILD",
    );
    Deno.exit(1);
  }

  // Resolve the scenario (seed or fixture) with an ASCII renderer attached.
  // --round is the WATCH TARGET; match length is independent (see
  // resolveScenarioSource).
  const resolved = await resolveScenarioSource(args, { renderer: "ascii" });
  using sc = resolved.sc;

  // A fixture supplies its own entry round/phase as the default target. The
  // checkpoint path resumes mid-phase and emits NO PHASE_START for the entry
  // phase, so "snapshot the entry moment" is handled specially below.
  if (resolved.fixtureEntry) {
    args.round ??= resolved.fixtureEntry.round;
    args.phase ??= resolved.fixtureEntry.phase;
    if (args.round < resolved.fixtureEntry.round) {
      console.error(
        `--round ${args.round} precedes the fixture's entry round ${resolved.fixtureEntry.round} (that state is gone — the fixture resumes at r${resolved.fixtureEntry.round}).`,
      );
      Deno.exit(1);
    }
  }
  if (args.round === undefined || args.phase === undefined) {
    throw new Error("unreachable: round/phase undefined after defaulting");
  }
  // True when the requested target IS the fixture's resume point. The runtime
  // is already sitting at that phase's start, so there's nothing to wait for
  // (start) and no entry PHASE_START will ever fire to prime the end/at logic.
  const atFixtureEntry =
    resolved.fixtureEntry !== undefined &&
    args.round === resolved.fixtureEntry.round &&
    args.phase === resolved.fixtureEntry.phase;

  const targetLabel =
    args.at !== undefined
      ? `r${args.round} ${args.phase} @${args.at}s`
      : `r${args.round} ${args.phase} ${args.moment}`;
  // 200_000ms/round matches watch-game's budget shape (~183s sim/round on
  // survival, headroom for stalls).
  const timeoutMs = 200_000 * (args.round + 1);

  // --each-placement: render one snapshot per placement (wall piece in a
  // build phase, cannon in CANNON_PLACE) instead of a single moment.
  if (args.eachPlacement) {
    runEachPlacement(sc, args, resolved, timeoutMs, atFixtureEntry);
    Deno.exit(0);
  }

  if (atFixtureEntry && args.at === undefined && args.moment === "start") {
    // Already sitting at the fixture's entry-phase start — snapshot as-is.
  } else if (args.at !== undefined) {
    // "at N seconds" = wait for PHASE_START, then drive sim time forward
    // until N*1000 sim-ms have elapsed. Bail if the phase exits early
    // (PHASE_END for the target, or ROUND_END) — the requested offset
    // doesn't exist. At the fixture entry phase no PHASE_START fires, so
    // anchor the clock at the resume moment (sc.now()) instead.
    let phaseStartAt: number | null = atFixtureEntry ? sc.now() : null;
    let phaseExitedEarly = false;
    sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
      if (
        phaseStartAt === null &&
        ev.round === args.round &&
        ev.phase === args.phase
      ) {
        phaseStartAt = sc.now();
      }
    });
    sc.bus.on(GAME_EVENT.PHASE_END, (ev) => {
      if (
        phaseStartAt !== null &&
        ev.round === args.round &&
        ev.phase === args.phase
      ) {
        phaseExitedEarly = true;
      }
    });
    sc.bus.on(GAME_EVENT.ROUND_END, (ev) => {
      if (phaseStartAt !== null && ev.round === args.round) {
        phaseExitedEarly = true;
      }
    });
    const targetMs = args.at * 1000;
    sc.runUntil(
      () =>
        phaseExitedEarly ||
        (phaseStartAt !== null && sc.now() - phaseStartAt >= targetMs),
      { timeoutMs },
    );
    if (phaseExitedEarly) {
      console.error(
        `Phase ${args.phase} in round ${args.round} exited before reaching --at ${args.at}s.`,
      );
      Deno.exit(1);
    }
  } else if (args.moment === "start") {
    waitForEvent(
      sc,
      GAME_EVENT.PHASE_START,
      (ev) => ev.round === args.round && ev.phase === args.phase,
      { timeoutMs, label: targetLabel },
    );
  } else {
    // "end" = state right after the target phase exits. Wait for the
    // target phase to START, then for the NEXT PHASE_START (or ROUND_END
    // if the target was WALL_BUILD, the last phase of a round). Modern
    // mode has conditional phases (MODIFIER_REVEAL / UPGRADE_PICK) so we
    // can't hard-code the successor phase per (mode, target) — listening
    // for whichever fires next is the only robust path. At the fixture entry
    // phase no PHASE_START fires for the target, so treat it as already seen.
    let sawTarget = atFixtureEntry;
    let triggered = false;
    sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
      if (sawTarget) triggered = true;
      if (ev.round === args.round && ev.phase === args.phase) sawTarget = true;
    });
    sc.bus.on(GAME_EVENT.ROUND_END, (ev) => {
      if (sawTarget && ev.round === args.round) triggered = true;
    });
    sc.runUntil(() => triggered, { timeoutMs, label: targetLabel });
  }

  // Resolve a point-focus crop window (tower / castle / at-tile), if any.
  const {
    rect: focusRect,
    label: focusLabel,
    zoom: focusZoom,
  } = resolveFocus(sc, args);

  // Banner: seed/round/phase/moment + per-player stats (filtered to the
  // focused player if --player was passed). `sourceLabel` carries the
  // provenance (match-rounds for a seed, or fixture=… entry=… for a fixture).
  const playerNote =
    args.player !== undefined ? ` (player ${PLAYER_NAMES[args.player]})` : "";
  const focusNote = focusRect ? ` focus=${focusLabel} zoom=${focusZoom}` : "";
  console.log(
    `seed=${resolved.seed} mode=${resolved.mode} ${resolved.sourceLabel} ${targetLabel}${playerNote}${focusNote}`,
  );
  for (let i = 0; i < 3; i++) {
    const player = sc.state.players[i];
    if (!player) continue;
    if (args.player !== undefined && args.player !== i) continue;
    console.log(
      `  ${PLAYER_NAMES[i]}: ${player.lives}♥ ${player.score} ${player.walls.size}w ${player.enclosedTowers.length}e${player.eliminated ? " ELIM" : ""}`,
    );
  }
  console.log();

  // cropTo accepts a ValidPlayerId (renderer auto-computes the footprint
  // rect) or an explicit Rect. A focus target supplies the rect directly;
  // otherwise fall back to the player footprint. cropPad zooms OUT from a
  // player footprint when --zoom is given without a focus target.
  const snapshot = sc.renderer!.snapshot({
    coords: true,
    playerFilter: args.player,
    cropTo: focusRect ?? args.player,
    cropPad: focusRect ? 0 : (args.zoom ?? 0),
  });
  console.log(snapshot);
  console.log();
  console.log(buildAnchors(sc.state, args.player));
  Deno.exit(0);
}

/** --each-placement: render one cropped snapshot per placement the focused
 *  player makes during the target phase, labeled with the piece shape (build
 *  phases) or cannon mode (CANNON_PLACE). Drives the sim placement-by-placement
 *  via `runUntil(count increased)` — `tick()` alone doesn't advance the AI
 *  enough to place. `--at SECONDS` caps the window; `--max-placements N` caps
 *  the count. */
function runEachPlacement(
  sc: Scenario,
  args: Args,
  resolved: ResolvedScenarioSource,
  timeoutMs: number,
  atFixtureEntry: boolean,
): void {
  const playerId = args.player;
  if (playerId === undefined) {
    console.error("--each-placement requires --player RED|BLUE|GOLD.");
    Deno.exit(1);
  }
  if (args.round === undefined || args.phase === undefined) {
    throw new Error("unreachable: round/phase undefined in each-placement");
  }
  const round = args.round;
  const phase = args.phase;
  const isCannonPhase = phase === Phase.CANNON_PLACE;
  if (
    !isCannonPhase &&
    phase !== Phase.WALL_BUILD &&
    phase !== Phase.CASTLE_SELECT
  ) {
    console.error(
      `--each-placement only supports placement phases (CANNON_PLACE | WALL_BUILD | CASTLE_SELECT), got ${phase}.`,
    );
    Deno.exit(1);
  }

  // Build phases: capture the placed piece's shape name from the AI build-diag
  // hook (the bus WALL_PLACED event doesn't carry it). Cannon mode is read
  // straight off the placed cannon, so no hook is needed there.
  let lastPiece = "(piece n/a)";
  if (!isCannonPhase) {
    setAiBuildDiagHook((ev) => {
      if (ev.round !== round || ev.playerId !== playerId) return;
      if (ev.kind === "wall-placed") {
        const cells = ev.cells
          .map((key) => {
            const { row, col } = unpackTile(key);
            return `(${row},${col})`;
          })
          .join("");
        lastPiece = `${ev.pieceShapeName} (${ev.cells.length}t) ${cells}`;
      }
    });
  }

  let phaseEnded = false;
  sc.bus.on(GAME_EVENT.PHASE_END, (ev) => {
    if (ev.round === round && ev.phase === phase) phaseEnded = true;
  });
  sc.bus.on(GAME_EVENT.ROUND_END, (ev) => {
    if (ev.round === round) phaseEnded = true;
  });

  // Anchor the phase clock: at a fixture's own entry phase no PHASE_START
  // fires, so use the resume moment; otherwise wait for the phase to start.
  let anchorMs: number;
  if (atFixtureEntry) {
    anchorMs = sc.now();
  } else {
    waitForEvent(
      sc,
      GAME_EVENT.PHASE_START,
      (ev) => ev.round === round && ev.phase === phase,
      { timeoutMs, label: `r${round} ${phase} start` },
    );
    anchorMs = sc.now();
  }

  const {
    rect: focusRect,
    label: focusLabel,
    zoom: focusZoom,
  } = resolveFocus(sc, args);
  const boundMs = args.at !== undefined ? args.at * 1000 : undefined;
  const max = args.maxPlacements ?? Number.POSITIVE_INFINITY;
  const count = () =>
    isCannonPhase
      ? sc.state.players[playerId]!.cannons.length
      : sc.state.players[playerId]!.walls.size;

  const boundNote = boundMs !== undefined ? ` until +${args.at}s` : "";
  const focusNote = focusRect ? ` focus=${focusLabel} zoom=${focusZoom}` : "";
  console.log(
    `seed=${resolved.seed} mode=${resolved.mode} ${resolved.sourceLabel} r${round} ${phase} per-placement (player ${PLAYER_NAMES[playerId]})${boundNote}${focusNote}`,
  );

  let placements = 0;
  while (!phaseEnded && placements < max) {
    if (boundMs !== undefined && sc.now() - anchorMs >= boundMs) break;
    const prev = count();
    sc.runUntil(
      () =>
        phaseEnded ||
        count() > prev ||
        (boundMs !== undefined && sc.now() - anchorMs >= boundMs),
      { timeoutMs },
    );
    if (phaseEnded || count() <= prev) break;
    placements++;
    const player = sc.state.players[playerId]!;
    const elapsed = ((sc.now() - anchorMs) / 1000).toFixed(1);
    let label: string;
    if (isCannonPhase) {
      const cannon = player.cannons[player.cannons.length - 1]!;
      label = `${cannon.mode} cannon @(${cannon.row},${cannon.col})`;
    } else {
      label = lastPiece;
    }
    const stat = isCannonPhase
      ? `${player.cannons.length}c`
      : `${player.walls.size}w ${player.enclosedTowers.length}e`;
    console.log(
      `\n── placement #${placements} @${elapsed}s — ${label} — ${PLAYER_NAMES[playerId]} ${stat}`,
    );
    console.log(
      sc.renderer!.snapshot({
        coords: true,
        playerFilter: args.player,
        cropTo: focusRect ?? args.player,
        cropPad: focusRect ? 0 : (args.zoom ?? 0),
      }),
    );
  }
  console.log(
    `\n${placements} placement(s) rendered; phase ${phaseEnded ? "ended" : "in progress"}.`,
  );
}

/** Anchor footnote — absolute (row, col) positions for entities the agent
 *  is likely to want to reason about. Skips groups with no entries so
 *  early-game / empty-state snapshots stay short. Always uses (row, col)
 *  ordering to match TilePos / tileAt across the codebase. */
function buildAnchors(state: GameState, focus: 0 | 1 | 2 | undefined): string {
  const out: string[] = ["Anchors (row, col):"];
  const homeIndices = new Set<number>();
  for (const player of state.players) {
    if (player.homeTower) homeIndices.add(player.homeTower.index);
  }

  // Castles — home towers per active player.
  const castles: string[] = [];
  for (const player of state.players) {
    if (focus !== undefined && player.id !== focus) continue;
    if (!player.homeTower) continue;
    const alive = state.towerAlive[player.homeTower.index] ?? false;
    castles.push(
      `${PLAYER_NAMES[player.id]} ${alive ? "T" : "t"}(${player.homeTower.row},${player.homeTower.col})`,
    );
  }
  if (castles.length > 0) out.push(`  Castles: ${castles.join(" ")}`);

  // Non-home towers, grouped by zone-owner. A tower's zone is fixed at
  // map-gen and never reassigned, so each tower has a durable owner-player
  // (or no player when its zone isn't assigned to a slot). Whether the
  // owner currently encloses it is visible on the ASCII map via the `░`
  // territory marker — this listing surfaces the static zone affinity.
  const towersByPlayer: Map<number, string[]> = new Map();
  const neutralTowers: string[] = [];
  for (let i = 0; i < state.map.towers.length; i++) {
    if (homeIndices.has(i)) continue;
    const tower = state.map.towers[i]!;
    const alive = state.towerAlive[i] ?? false;
    const label = `${alive ? "Y" : "y"}#${i}(${tower.row},${tower.col})`;
    const ownerId = playerByZone(state.playerZones, tower.zone);
    if (ownerId === undefined) {
      neutralTowers.push(label);
    } else {
      const bucket = towersByPlayer.get(ownerId) ?? [];
      bucket.push(label);
      towersByPlayer.set(ownerId, bucket);
    }
  }
  for (const player of state.players) {
    if (focus !== undefined && player.id !== focus) continue;
    const bucket = towersByPlayer.get(player.id);
    if (bucket && bucket.length > 0) {
      out.push(`  Towers ${PLAYER_NAMES[player.id]}: ${bucket.join(" ")}`);
    }
  }
  if (neutralTowers.length > 0 && focus === undefined) {
    out.push(`  Towers neutral: ${neutralTowers.join(" ")}`);
  }

  // Cannons per player. Dead cannons remain on the map as debris (x), so
  // include them — they still block placement.
  for (const player of state.players) {
    if (focus !== undefined && player.id !== focus) continue;
    if (player.cannons.length === 0) continue;
    const items: string[] = [];
    for (let idx = 0; idx < player.cannons.length; idx++) {
      const cannon = player.cannons[idx]!;
      const char = cannon.hp > 0 ? "C" : "x";
      items.push(`#${idx} ${char}(${cannon.row},${cannon.col})/${cannon.mode}`);
    }
    out.push(`  Cannons ${PLAYER_NAMES[player.id]}: ${items.join(" ")}`);
  }

  // Captured cannons (one player's cannon held by another).
  if (state.capturedCannons.length > 0) {
    const captured = state.capturedCannons.map(
      (entry) =>
        `(${entry.cannon.row},${entry.cannon.col})${PLAYER_NAMES[entry.victimId]}→${PLAYER_NAMES[entry.capturerId]}`,
    );
    out.push(`  Captured: ${captured.join(" ")}`);
  }

  // Burning pits (block grass tiles for 3 battle rounds).
  if (state.burningPits.length > 0) {
    const pits = state.burningPits.map((pit) => `(${pit.row},${pit.col})`);
    out.push(`  Burning pits: ${pits.join(" ")}`);
  }

  // Bonus squares.
  if (state.bonusSquares.length > 0) {
    const bonuses = state.bonusSquares.map(
      (bonus) => `(${bonus.row},${bonus.col})`,
    );
    out.push(`  Bonuses: ${bonuses.join(" ")}`);
  }

  return out.join("\n");
}

/** Resolve a point-focus crop window (tower / castle / at-tile), if any.
 *  A focus target wins over --player for the crop bounds; --player still
 *  tints via playerFilter, so you can zoom a neutral tower and shade a
 *  player at the same time. The renderer (renderGrid) clamps the bbox to
 *  the grid, so an over-large window near an edge is safe. */
function resolveFocus(
  sc: Scenario,
  args: Args,
): { rect: Rect | undefined; label: string; zoom: number } {
  const zoom = args.zoom ?? DEFAULT_FOCUS_ZOOM;
  if (args.tower !== undefined) {
    const tower = sc.state.map.towers[args.tower];
    if (!tower) {
      console.error(
        `Invalid --tower ${args.tower}: map has ${sc.state.map.towers.length} towers (0..${sc.state.map.towers.length - 1}).`,
      );
      Deno.exit(1);
    }
    return {
      rect: towerWindow(tower.row, tower.col, zoom),
      label: `tower #${args.tower}(${tower.row},${tower.col})`,
      zoom,
    };
  }
  if (args.castle !== undefined) {
    const homeTower = sc.state.players[args.castle]?.homeTower;
    if (!homeTower) {
      console.error(
        `${PLAYER_NAMES[args.castle]} has no home tower (not seated this match).`,
      );
      Deno.exit(1);
    }
    return {
      rect: towerWindow(homeTower.row, homeTower.col, zoom),
      label: `${PLAYER_NAMES[args.castle]} castle(${homeTower.row},${homeTower.col})`,
      zoom,
    };
  }
  if (args.atTile) {
    return {
      rect: pointWindow(args.atTile.row, args.atTile.col, zoom),
      label: `tile(${args.atTile.row},${args.atTile.col})`,
      zoom,
    };
  }
  return { rect: undefined, label: "", zoom };
}

/** Crop window around a 2x2 tower whose top-left is (row, col): the tower
 *  footprint plus `zoom` tiles of margin on every side. */
function towerWindow(row: number, col: number, zoom: number): Rect {
  return {
    minRow: row - zoom,
    maxRow: row + 1 + zoom,
    minCol: col - zoom,
    maxCol: col + 1 + zoom,
  };
}

/** Crop window centered on a single (row, col), `zoom` tiles each side. */
function pointWindow(row: number, col: number, zoom: number): Rect {
  return {
    minRow: row - zoom,
    maxRow: row + zoom,
    minCol: col - zoom,
    maxCol: col + zoom,
  };
}

function parseArgs(): Args {
  const argv = Deno.args;
  let seed: number | undefined;
  let fixture: string | undefined;
  let mode: "classic" | "modern" = "modern";
  let round: number | undefined;
  let matchRounds = 0;
  let phase: Phase | undefined;
  let moment: "start" | "end" = "start";
  let at: number | undefined;
  let player: 0 | 1 | 2 | undefined;
  let tower: number | undefined;
  let castle: 0 | 1 | 2 | undefined;
  let atTile: { row: number; col: number } | undefined;
  let zoom: number | undefined;
  let eachPlacement = false;
  let maxPlacements: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") {
      console.log(HELP_TEXT);
      Deno.exit(0);
    } else if (flag === "--seed") seed = Number(argv[++i]);
    else if (flag === "--fixture") fixture = argv[++i];
    else if (flag === "--mode") mode = parseMode(argv[++i]);
    else if (flag === "--round") round = Number(argv[++i]);
    else if (flag === "--match-rounds") matchRounds = Number(argv[++i]);
    else if (flag === "--phase") phase = parsePhase(argv[++i]);
    else if (flag === "--moment") moment = parseMoment(argv[++i]);
    else if (flag === "--at") at = parseAtSeconds(argv[++i]);
    else if (flag === "--player")
      player = parsePlayerName(argv[++i], "--player");
    else if (flag === "--tower") {
      tower = parseNonNegInt(argv[++i], "--tower");
    } else if (flag === "--castle") {
      castle = parsePlayerName(argv[++i], "--castle");
    } else if (flag === "--at-tile") {
      atTile = parseRowCol(argv[++i]);
    } else if (flag === "--zoom") {
      zoom = parseNonNegInt(argv[++i], "--zoom");
    } else if (flag === "--each-placement") {
      eachPlacement = true;
    } else if (flag === "--max-placements") {
      maxPlacements = parseNonNegInt(argv[++i], "--max-placements");
    } else {
      console.error(`Unknown flag: ${flag}`);
      Deno.exit(1);
    }
  }
  assertSingleFocus(tower, castle, atTile);
  return {
    seed,
    fixture,
    mode,
    round,
    matchRounds,
    phase,
    moment,
    at,
    player,
    tower,
    castle,
    atTile,
    zoom,
    eachPlacement,
    maxPlacements,
  };
}

/** Parse a --mode flag value, or exit on a bad value. */
function parseMode(raw: string | undefined): "classic" | "modern" {
  if (raw !== "classic" && raw !== "modern") {
    console.error(`Invalid --mode: ${raw} (expected classic or modern)`);
    Deno.exit(1);
  }
  return raw;
}

/** Parse a --moment flag value, or exit on a bad value. */
function parseMoment(raw: string | undefined): "start" | "end" {
  if (raw !== "start" && raw !== "end") {
    console.error(`Invalid --moment: ${raw} (expected start or end)`);
    Deno.exit(1);
  }
  return raw;
}

/** Parse a --at flag value (non-negative seconds), or exit on a bad value. */
function parseAtSeconds(raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(
      `Invalid --at: ${raw} (expected non-negative number of seconds)`,
    );
    Deno.exit(1);
  }
  return value;
}

/** Parse a --phase flag value to a Phase, or exit on a bad value. */
function parsePhase(raw: string | undefined): Phase {
  const value = raw?.toUpperCase() ?? "";
  const enumValue = (Phase as Record<string, Phase>)[value];
  if (enumValue === undefined) {
    console.error(
      `Invalid --phase: ${value} (expected CASTLE_SELECT | CANNON_PLACE | MODIFIER_REVEAL | BATTLE | UPGRADE_PICK | WALL_BUILD)`,
    );
    Deno.exit(1);
  }
  return enumValue;
}

/** Exit if more than one mutually-exclusive focus target was supplied —
 *  each picks one crop center, so combining them is ambiguous. */
function assertSingleFocus(
  tower: number | undefined,
  castle: number | undefined,
  atTile: { row: number; col: number } | undefined,
): void {
  const count =
    (tower !== undefined ? 1 : 0) +
    (castle !== undefined ? 1 : 0) +
    (atTile !== undefined ? 1 : 0);
  if (count > 1) {
    console.error(
      "Pick at most one focus target: --tower, --castle, or --at-tile.",
    );
    Deno.exit(1);
  }
}

/** Resolve a RED|BLUE|GOLD flag value to a player slot, or exit on a bad
 *  value. Shared by --player and --castle. */
function parsePlayerName(raw: string | undefined, flag: string): 0 | 1 | 2 {
  const value = raw?.toUpperCase() ?? "";
  const idx = PLAYER_NAMES.indexOf(value as (typeof PLAYER_NAMES)[number]);
  if (idx < 0) {
    console.error(`Invalid ${flag}: ${value} (expected RED, BLUE, or GOLD)`);
    Deno.exit(1);
  }
  return idx as 0 | 1 | 2;
}

/** Parse a non-negative integer flag value, or exit on a bad value.
 *  Shared by --tower and --zoom. */
function parseNonNegInt(raw: string | undefined, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`Invalid ${flag}: ${raw} (expected a non-negative integer)`);
    Deno.exit(1);
  }
  return value;
}

/** Parse a `ROW,COL` flag value into a tile, or exit on a bad value. */
function parseRowCol(raw: string | undefined): { row: number; col: number } {
  const parts = (raw ?? "").split(",");
  const row = Number(parts[0]);
  const col = Number(parts[1]);
  if (
    parts.length !== 2 ||
    !Number.isInteger(row) ||
    !Number.isInteger(col) ||
    row < 0 ||
    col < 0
  ) {
    console.error(`Invalid --at-tile: ${raw} (expected ROW,COL, e.g. 12,34)`);
    Deno.exit(1);
  }
  return { row, col };
}
