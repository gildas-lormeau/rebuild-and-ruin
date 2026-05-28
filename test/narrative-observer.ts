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

import { setAiBattleDiagHook } from "../src/ai/ai-battle-diag.ts";
import { BATTLE_MESSAGE } from "../src/shared/core/battle-events.ts";
import { isCannonAlive } from "../src/shared/core/battle-types.ts";
import {
  GAME_EVENT,
  type GameEventMap,
} from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { GRID_COLS, GRID_ROWS } from "../src/shared/core/grid.ts";
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
  let currentRoundModifier: string | null = null;
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
    // Tag BATTLE / MODIFIER_REVEAL with the round's modifier so the
    // active modifier stays visible while scanning battle fires —
    // dust_storm / wildfire / etc. scatter targets in ways that look
    // like AI bugs without this context.
    const modifierTag =
      currentRoundModifier !== null &&
      (currentPhaseLabel === "BATTLE" ||
        currentPhaseLabel === "MODIFIER_REVEAL")
        ? ` [${currentRoundModifier}]`
        : "";
    const header = `── r${currentRound} ${currentPhaseLabel}${modifierTag} ──`;
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
        currentRoundModifier = null;
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
        currentRoundModifier = ev.modifierId;
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
      // Captured-cannon disambiguation: ev.playerId is the cannon's ORIGINAL
      // owner; the actual shooter is ev.scoringPlayerId when set. Lead with
      // the actual shooter and tag the cannon idx with its original owner
      // when those differ, so a reader never has to infer who pulled the
      // trigger from a trailing "(scoring X)" suffix.
      on(sc, BATTLE_MESSAGE.CANNON_FIRED, (ev) => {
        const shooterId = ev.scoringPlayerId ?? ev.playerId;
        const isCaptured = ev.scoringPlayerId !== undefined &&
          ev.scoringPlayerId !== ev.playerId;
        const fireRef = isCaptured
          ? `${playerName(shooterId)} fires ${playerName(ev.playerId)}@${ev.cannonIdx}`
          : `${playerName(shooterId)} fires@${ev.cannonIdx}`;
        const tag = classifyImpactTile(
          sc.state,
          ev.impactRow,
          ev.impactCol,
          shooterId,
        );
        push(
          `${fireRef} → (${ev.impactRow},${ev.impactCol}) [${tag}]`,
        );
      });

      on(sc, BATTLE_MESSAGE.WALL_DESTROYED, (ev) => {
        // shooterId is undefined only when a grunt destroyed the wall
        // (grunt-system emits without a shooter; battle-system always sets
        // one). cannonIdx is set for cannon-driven hits including splash;
        // grunts pass undefined. For captured cannons the idx lives in the
        // original owner's player.cannons[] array — formatCannonShooter
        // surfaces that as "SHOOTER via OWNER@idx".
        const shooter = ev.shooterId === undefined
          ? "grunt"
          : ev.cannonIdx !== undefined
            ? formatCannonShooter(sc.state, ev.shooterId, ev.cannonIdx)
            : playerName(ev.shooterId);
        push(
          `${shooter} → ${playerName(ev.playerId)} wall@(${ev.row},${ev.col})`,
        );
      });

      on(sc, BATTLE_MESSAGE.CANNON_DAMAGED, (ev) => {
        // CANNON_DAMAGED carries shooterId (the actual scorer) but not the
        // shooter's cannonIdx — so we can't tag captured-cannon fires with
        // their original owner here. Bare shooter name only.
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

      // AI battle-diag hook — fires synchronously right after the AI's
      // CANNON_FIRED in controller-ai's battleTick (fireNextReadyCannon →
      // state.bus.emit, then emitFireDecisionDiag, no other bus events
      // between them). The most recent narrative line is guaranteed to be
      // the matching fire line, so we splice `via:X` into its tag bracket.
      setAiBattleDiagHook((ev) => {
        const last = lines[lines.length - 1];
        if (!last) return;
        if (!last.endsWith("]")) return;
        lines[lines.length - 1] = `${last.slice(0, -1)} via:${ev.origin}]`;
      });
      subscriptions.push(() => setAiBattleDiagHook(undefined));
    },

    detach() {
      flushWallGroup();
      for (const off of subscriptions) off();
      subscriptions.length = 0;
      attached = false;
    },
  };
}

/** Format a cannon-source label for events whose shooter may have fired a
 *  captured cannon. cannonIdx on the wire is the idx in the firing cannon's
 *  ORIGINAL owner's `player.cannons[]` array, which is the shooter's own
 *  array for normal fires but the victim's array for captured-cannon fires.
 *  Probe state.capturedCannons to detect the latter and surface the original
 *  owner as a "via" prefix. */
function formatCannonShooter(
  state: GameState,
  shooterId: number,
  cannonIdx: number,
): string {
  const captured = state.capturedCannons.find(
    (cap) => cap.capturerId === shooterId && cap.cannonIdx === cannonIdx,
  );
  if (captured !== undefined) {
    return `${playerName(shooterId)} via ${playerName(captured.victimId)}@${cannonIdx}`;
  }
  return `${playerName(shooterId)}@${cannonIdx}`;
}

/** Classify what's at the impact tile (row, col) from the actual shooter's
 *  perspective. Order matters — a tower tile that also has a wall around it
 *  shouldn't be reported as wall. Suffix `+dup` when another in-flight ball
 *  from the same shooter (capturer for captured cannons, original owner
 *  otherwise) already targets this same impact tile. */
function classifyImpactTile(
  state: GameState,
  row: number,
  col: number,
  shooterId: number,
): string {
  let tag = identifyImpactTile(state, row, col, shooterId);
  const sameTileBalls = state.cannonballs.filter(
    (b) =>
      (b.scoringPlayerId ?? b.playerId) === shooterId &&
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
  shooterId: number,
): string {
  // dust_storm scatters impact tiles, occasionally off-map. packTile (called
  // for the wall lookup below) throws in dev mode on out-of-bounds, which
  // would abort the bus emit and silently truncate the narrative log.
  if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) {
    return "off-map";
  }
  // Cannon (own / enemy / captured) — 2×2 footprint check. Dead cannons
  // persist as debris (clear on zone reset) so a hit on one is wasted;
  // we surface that explicitly. "own-*" reflects the actual shooter's
  // effective control, not original ownership — so a capturer hitting the
  // victim's other cannons shows as `cannon:VICTIM@idx`, not `own-cannon`.
  for (let pid = 0; pid < state.players.length; pid++) {
    const player = state.players[pid]!;
    for (let idx = 0; idx < player.cannons.length; idx++) {
      const cannon = player.cannons[idx]!;
      if (!isCannonTile(cannon, row, col)) continue;
      if (!isCannonAlive(cannon)) return `debris:${playerName(pid)}@${idx}`;
      const capturedByShooter = state.capturedCannons.some(
        (cap) => cap.cannon === cannon && cap.capturerId === shooterId,
      );
      if (capturedByShooter) return `own-captured@${idx}`;
      if (pid === shooterId) {
        // Original owner of this cannon — but if an enemy has captured it,
        // it's effectively no longer ours.
        const enemyCapture = state.capturedCannons.find(
          (cap) => cap.cannon === cannon && cap.capturerId !== shooterId,
        );
        if (enemyCapture !== undefined) {
          return `lost-cannon@${idx}→${playerName(enemyCapture.capturerId)}`;
        }
        return `own-cannon@${idx}`;
      }
      return `cannon:${playerName(pid)}@${idx}`;
    }
  }
  // Tower (owned / neutral) — 2×2 footprint.
  for (const tower of state.map.towers) {
    if (!isTowerTile(tower, row, col)) continue;
    const owner = state.players.find((player) =>
      player.ownedTowers.some((owned) => owned.index === tower.index),
    );
    if (owner === undefined) return `tower:neutral T${tower.index}`;
    const ownTag = owner.id === shooterId ? "own-" : "";
    return `${ownTag}tower:${playerName(owner.id)} T${tower.index}`;
  }
  // Wall (own / enemy) — single-tile lookup via TileKey.
  const key = packTile(row, col);
  for (let pid = 0; pid < state.players.length; pid++) {
    if (!state.players[pid]!.walls.has(key)) continue;
    return pid === shooterId ? "own-wall" : `wall:${playerName(pid)}`;
  }
  // Grunt on this tile — non-blocking but worth knowing.
  if (state.grunts.some((grunt) => isAtTile(grunt, row, col))) return "grunt";
  // Map-level terrain modifiers.
  if (hasPitAt(state.burningPits, row, col)) return "pit";
  if (state.modern?.frozenTiles?.has(key)) return "ice";
  if (isGrass(state.map.tiles, row, col)) return "grass";
  return "water";
}
