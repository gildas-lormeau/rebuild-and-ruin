/**
 * Narrative observer — subscribes to a scenario's event bus and turns
 * the resulting event stream into a human-readable play-by-play.
 *
 * NOT a renderer. The runtime's RendererInterface is per-frame and only
 * sees finalized state; this observer hooks the discrete events that
 * happened between frames (cannon fired, tower killed, walls placed,
 * etc.) so the narrative reads like a game commentary instead of a
 * sequence of board diffs.
 *
 * Output format favours token-efficiency without sacrificing fidelity:
 *   - one header line per (round, phase) section instead of repeating
 *     a `[PHASE]` prefix on every event
 *   - `WALL_PLACED` events grouped per player per WALL_BUILD phase
 *     (per-piece coordinates would dominate the output)
 *   - abbreviated verbs (`X → Y cannon@N hp=H` rather than spelled out)
 *
 * Usage:
 *
 *   const sc = await createScenario({ seed: 42, mode: "modern" });
 *   const narrative = createNarrativeObserver();
 *   narrative.attach(sc);
 *   // ... advance the game ...
 *   console.log(narrative.lines.join("\n"));
 *   narrative.detach();
 */

import { BATTLE_MESSAGE } from "../src/shared/core/battle-events.ts";
import { isCannonAlive } from "../src/shared/core/battle-types.ts";
import {
  GAME_EVENT,
  type GameEventMap,
} from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import {
  hasPitAt,
  isAtTile,
  isCannonTile,
  isGrass,
  isTowerTile,
  packTile,
} from "../src/shared/core/spatial.ts";
import type { GameState } from "../src/shared/core/types.ts";
import type { Scenario } from "./scenario.ts";

export interface NarrativeObserver {
  /** Accumulated play-by-play lines in event order. */
  readonly lines: readonly string[];
  /** Subscribe to a scenario's bus. Call exactly once per scenario. */
  attach(sc: Scenario): void;
  /** Unsubscribe everything. Idempotent. Also flushes any pending wall
   *  group so its summary line appears in `lines`. */
  detach(): void;
}

const PLAYER_NAMES = ["RED", "BLUE", "GOLD"] as const;
const PLAYER_SHORT = ["R", "B", "G"] as const;
const playerName = (playerId: number | undefined): string =>
  playerId === undefined ? "?" : (PLAYER_NAMES[playerId] ?? `P${playerId}`);
const playerShort = (playerId: number | undefined): string =>
  playerId === undefined ? "?" : (PLAYER_SHORT[playerId] ?? `P${playerId}`);

export function createNarrativeObserver(): NarrativeObserver {
  const lines: string[] = [];
  const subscriptions: Array<() => void> = [];
  let attached = false;

  /** Round/phase context — emitted as a header line on change, NOT as a
   *  per-event prefix. Initialised to the implicit pre-game "SETUP" so
   *  initial castle/enclosure events get attributed cleanly. */
  let currentRound = 0;
  let currentPhaseLabel = "SETUP";
  let lastEmittedHeader = "";

  /** Per-player wall-placement accumulator — flushed when the phase
   *  changes (or detach fires). One summary line per player instead of
   *  one line per WALL_PLACED event. */
  const wallGroup: Map<number, { tiles: number; placements: number }> =
    new Map();

  /** Player IDs that lost a life THIS round. Used to mark their END
   *  snapshot with `(reset)` — `finalizeRound` runs `resetPlayerBoardState`
   *  on life-loss, so their `walls.size` / `ownedTowers.length` read 0
   *  by the time ROUND_END fires. Without the marker the END row's `0w/0e`
   *  is indistinguishable from a player who genuinely built nothing. */
  const lifeLostThisRound = new Set<number>();

  function emitHeaderIfNeeded(): void {
    const header = `── r${currentRound} ${currentPhaseLabel} ──`;
    if (header === lastEmittedHeader) return;
    flushWallGroup();
    lines.push(header);
    lastEmittedHeader = header;
  }

  function flushWallGroup(): void {
    if (wallGroup.size === 0) return;
    // Stable order: by player index ascending.
    const ordered = [...wallGroup.entries()].sort((a, b) => a[0] - b[0]);
    for (const [playerId, agg] of ordered) {
      lines.push(
        `  ${playerName(playerId)} placed ${agg.tiles}w in ${agg.placements} pieces`,
      );
    }
    wallGroup.clear();
  }

  function push(line: string): void {
    flushWallGroup();
    emitHeaderIfNeeded();
    lines.push(`  ${line}`);
  }

  function on<K extends keyof GameEventMap>(
    sc: Scenario,
    eventType: K,
    handler: (ev: GameEventMap[K]) => void,
  ): void {
    sc.bus.on(eventType, handler);
    subscriptions.push(() => sc.bus.off(eventType, handler));
  }

  return {
    get lines() {
      return lines;
    },

    attach(sc) {
      if (attached) throw new Error("narrative observer already attached");
      attached = true;

      on(sc, GAME_EVENT.ROUND_START, (ev) => {
        currentRound = ev.round;
        // Don't emit a header here — PHASE_START fires moments later
        // with the actual phase label. Avoids a stale "── r2 ?? ──".
      });

      on(sc, GAME_EVENT.PHASE_START, (ev) => {
        flushWallGroup();
        currentRound = ev.round;
        currentPhaseLabel = Phase[ev.phase];
        emitHeaderIfNeeded();
      });

      on(sc, GAME_EVENT.CASTLE_PLACED, (ev) => {
        push(`${playerName(ev.playerId)} castle (${ev.row},${ev.col})`);
      });

      on(sc, GAME_EVENT.CANNON_PLACED, (ev) => {
        push(
          `${playerName(ev.playerId)} cannon@${ev.cannonIdx} (${ev.row},${ev.col})`,
        );
      });

      on(sc, GAME_EVENT.WALL_PLACED, (ev) => {
        // Defer to the per-player summary instead of one line per event.
        const slot = wallGroup.get(ev.playerId) ?? {
          tiles: 0,
          placements: 0,
        };
        slot.tiles += ev.tileKeys.length;
        slot.placements += 1;
        wallGroup.set(ev.playerId, slot);
        emitHeaderIfNeeded();
      });

      on(sc, GAME_EVENT.TOWER_ENCLOSED, (ev) => {
        push(`${playerName(ev.playerId)} encloses T${ev.towerIndex}`);
      });

      on(sc, GAME_EVENT.GRUNTS_ENCLOSED, (ev) => {
        push(`${playerName(ev.playerId)} traps ${ev.count} grunt(s)`);
      });

      on(sc, GAME_EVENT.HOUSE_CRUSHED, (ev) => {
        push(`house@(${ev.row},${ev.col}) crushed by piece`);
      });

      on(sc, GAME_EVENT.LIFE_LOST, (ev) => {
        lifeLostThisRound.add(ev.playerId);
        push(
          `${playerName(ev.playerId)} ✗ life (${ev.livesRemaining}♥ left)`,
        );
      });

      on(sc, GAME_EVENT.PLAYER_ELIMINATED, (ev) => {
        push(`${playerName(ev.playerId)} ELIMINATED`);
      });

      on(sc, GAME_EVENT.MODIFIER_APPLIED, (ev) => {
        push(`modifier: ${ev.modifierId}`);
      });

      on(sc, GAME_EVENT.UPGRADE_PICKED, (ev) => {
        push(`${playerName(ev.playerId)} upgrade: ${ev.upgradeId}`);
      });

      on(sc, GAME_EVENT.ROUND_END, (ev) => {
        flushWallGroup();
        const players = PLAYER_NAMES.map((_, idx) => {
          const player = sc.state.players[idx];
          if (!player) return `${playerShort(idx)}:×`;
          // `(reset)` flags a life-loss reset — finalizeRound wipes the
          // player's walls/towers before this snapshot reads them, so the
          // `0w/0e` shown is the reset state, not a build failure.
          const resetMark = lifeLostThisRound.has(idx) ? " (reset)" : "";
          return `${playerShort(idx)} ${player.lives}♥/${player.score}/${player.walls.size}w/${player.ownedTowers.length}e${resetMark}`;
        }).join(" | ");
        lines.push(`r${ev.round} END: ${players}`);
        lifeLostThisRound.clear();
        // Clear the header so the next round's first event re-emits one.
        lastEmittedHeader = "";
      });

      on(sc, GAME_EVENT.GAME_END, (ev) => {
        flushWallGroup();
        lines.push(`GAME END r${ev.round}: winner ${playerName(ev.winner)}`);
        lastEmittedHeader = "";
      });

      // Battle events — emitted on the same bus via state.bus.emit(...).
      on(sc, BATTLE_MESSAGE.CANNON_FIRED, (ev) => {
        const scorer = ev.scoringPlayerId !== undefined &&
            ev.scoringPlayerId !== ev.playerId
          ? ` (scoring ${playerName(ev.scoringPlayerId)})`
          : "";
        const tag = classifyImpactTile(
          sc.state,
          ev.impactRow,
          ev.impactCol,
          ev.playerId,
        );
        push(
          `${playerName(ev.playerId)} fires@${ev.cannonIdx} → (${ev.impactRow},${ev.impactCol}) [${tag}]${scorer}`,
        );
      });

      on(sc, BATTLE_MESSAGE.WALL_DESTROYED, (ev) => {
        // shooterId is undefined only when a grunt destroyed the wall
        // (grunt-system emits without a shooter; battle-system always sets
        // one). cannonIdx is set for cannon-driven hits including splash;
        // grunts pass undefined.
        const shooter = ev.shooterId === undefined
          ? "grunt"
          : ev.cannonIdx !== undefined
            ? `${playerName(ev.shooterId)}@${ev.cannonIdx}`
            : playerName(ev.shooterId);
        push(
          `${shooter} → ${playerName(ev.playerId)} wall@(${ev.row},${ev.col})`,
        );
      });

      on(sc, BATTLE_MESSAGE.CANNON_DAMAGED, (ev) => {
        const shooter = ev.shooterId !== undefined
          ? playerName(ev.shooterId)
          : "?";
        push(
          `${shooter} → ${playerName(ev.playerId)} cannon@${ev.cannonIdx} hp=${ev.newHp}`,
        );
      });

      on(sc, BATTLE_MESSAGE.TOWER_KILLED, (ev) => {
        const owner = ev.playerId !== undefined
          ? `${playerName(ev.playerId)}'s`
          : "neutral";
        push(`tower T${ev.towerIdx} (${owner}) destroyed`);
      });

      on(sc, BATTLE_MESSAGE.HOUSE_DESTROYED, (ev) => {
        push(`house@(${ev.row},${ev.col}) destroyed`);
      });

      on(sc, BATTLE_MESSAGE.PIT_CREATED, (ev) => {
        push(`pit@(${ev.row},${ev.col}) ${ev.roundsLeft}r`);
      });

      on(sc, BATTLE_MESSAGE.GRUNT_KILLED, (ev) => {
        push(`grunt@(${ev.row},${ev.col}) killed`);
      });
    },

    detach() {
      flushWallGroup();
      for (const off of subscriptions) off();
      subscriptions.length = 0;
      attached = false;
    },
  };
}

/** Classify what's at the impact tile (row, col) for the firing player.
 *  Order matters — a tower tile that also has a wall around it shouldn't be
 *  reported as wall. Suffix `+dup` when another in-flight ball from the same
 *  player already targets this same impact tile (intra-volley duplicate). */
function classifyImpactTile(
  state: GameState,
  row: number,
  col: number,
  firingPlayerId: number,
): string {
  let tag = identifyImpactTile(state, row, col, firingPlayerId);
  // Intra-volley duplicate: another in-flight ball from the same player
  // already aimed at this impact tile (the just-fired ball is in
  // state.cannonballs by the time this handler runs, so count >= 2 means
  // at least one peer ball is also targeting).
  const sameTileBalls = state.cannonballs.filter(
    (b) =>
      b.playerId === firingPlayerId &&
      b.impactRow === row &&
      b.impactCol === col,
  );
  if (sameTileBalls.length >= 2) tag += " +dup";
  return tag;
}

function identifyImpactTile(
  state: GameState,
  row: number,
  col: number,
  firingPlayerId: number,
): string {
  // Cannon (own / enemy / captured) — 2×2 footprint check. Dead cannons
  // persist as debris (clear on zone reset) so a hit on one is wasted;
  // we surface that explicitly.
  for (let pid = 0; pid < state.players.length; pid++) {
    const player = state.players[pid]!;
    for (let idx = 0; idx < player.cannons.length; idx++) {
      const cannon = player.cannons[idx]!;
      if (!isCannonTile(cannon, row, col)) continue;
      if (!isCannonAlive(cannon)) return `debris:${playerName(pid)}@${idx}`;
      const capturedByFirer = state.capturedCannons.some(
        (cap) => cap.cannon === cannon && cap.capturerId === firingPlayerId,
      );
      if (capturedByFirer) return `own-captured@${idx}`;
      return pid === firingPlayerId
        ? `own-cannon@${idx}`
        : `cannon:${playerName(pid)}@${idx}`;
    }
  }
  // Tower (owned / neutral) — 2×2 footprint.
  for (const tower of state.map.towers) {
    if (!isTowerTile(tower, row, col)) continue;
    const owner = state.players.find((player) =>
      player.ownedTowers.some((owned) => owned.index === tower.index),
    );
    if (owner === undefined) return `tower:neutral T${tower.index}`;
    const ownTag = owner.id === firingPlayerId ? "own-" : "";
    return `${ownTag}tower:${playerName(owner.id)} T${tower.index}`;
  }
  // Wall (own / enemy) — single-tile lookup via TileKey.
  const key = packTile(row, col);
  for (let pid = 0; pid < state.players.length; pid++) {
    if (!state.players[pid]!.walls.has(key)) continue;
    return pid === firingPlayerId ? "own-wall" : `wall:${playerName(pid)}`;
  }
  // Grunt on this tile — non-blocking but worth knowing.
  if (state.grunts.some((grunt) => isAtTile(grunt, row, col))) return "grunt";
  // Map-level terrain modifiers.
  if (hasPitAt(state.burningPits, row, col)) return "pit";
  if (state.modern?.frozenTiles?.has(key)) return "ice";
  if (isGrass(state.map.tiles, row, col)) return "grass";
  return "water";
}
