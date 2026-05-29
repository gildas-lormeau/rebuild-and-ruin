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
import { getBattleInterior } from "../src/shared/core/board-occupancy.ts";
import { BATTLE_MESSAGE } from "../src/shared/core/battle-events.ts";
import {
  isBalloonCannon,
  isCannonAlive,
  isRampartCannon,
} from "../src/shared/core/battle-types.ts";
import { MODIFIER_ID } from "../src/shared/core/game-constants.ts";
import {
  GAME_EVENT,
  type GameEventMap,
} from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { GRID_COLS, GRID_ROWS } from "../src/shared/core/grid.ts";
import {
  cannonSize,
  hasPitAt,
  isAtTile,
  isCannonTile,
  isGrass,
  isTowerTile,
  packTile,
} from "../src/shared/core/spatial.ts";
import type { GameState } from "../src/shared/core/types.ts";
import { UID } from "../src/shared/core/upgrade-defs.ts";
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
   *  on life-loss, so their `walls.size` / `enclosedTowers.length` read 0
   *  by the time ROUND_END fires. Without the marker the END row's `0w/0e`
   *  is indistinguishable from a player who genuinely built nothing. */
  const lifeLostThisRound = new Set<number>();

  /** Battle-skip tracking. The `ceasefire` upgrade routes CANNON_PLACE
   *  straight to UPGRADE_PICK/WALL_BUILD with NO BATTLE PHASE_START — the
   *  battle phase vanishes from the event stream entirely. Without a marker
   *  that reads as a missing-phase bug (a skipped battle is indistinguishable
   *  from a runtime defect), so we synthesize a `BATTLE [skipped: …]` header.
   *  `sawCannonPlace` / `sawBattle` reset each round; `skipAnnounced` dedups
   *  the marker across the two phases (UPGRADE_PICK then WALL_BUILD) that can
   *  trigger detection. */
  let sawCannonPlaceThisRound = false;
  let sawBattleThisRound = false;
  let skipAnnouncedThisRound = false;
  /** `ceasefire` picks awaiting their skip. Picked in round N's UPGRADE_PICK,
   *  the skip lands in round N+1's battle decision — so the owner must survive
   *  the round rollover. Round-tagged so a pick that never causes a skip (sole
   *  owner eliminated before the next battle) is pruned instead of mis-crediting
   *  a later skip. */
  const pendingCeasefire: Array<{ round: number; playerId: number }> = [];

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
        sawCannonPlaceThisRound = false;
        sawBattleThisRound = false;
        skipAnnouncedThisRound = false;
        // Don't emit a header here — PHASE_START fires moments later
        // with the actual phase label. Avoids a stale "── r2 ?? ──".
      });

      on(sc, GAME_EVENT.PHASE_START, (ev) => {
        flushWallGroup();
        currentRound = ev.round;
        if (ev.phase === Phase.CANNON_PLACE) sawCannonPlaceThisRound = true;
        if (ev.phase === Phase.BATTLE) sawBattleThisRound = true;
        // Ceasefire-skip detection: the first UPGRADE_PICK/WALL_BUILD after a
        // CANNON_PLACE with no intervening BATTLE means the battle was skipped
        // (MODIFIER_REVEAL never fires on the ceasefire path either). Emit a
        // synthetic BATTLE header crediting the upgrade owner(s) before the
        // real phase header so the skip reads as intentional, not a missing
        // phase. Guarded so it fires once even though both phases can trigger.
        if (
          (ev.phase === Phase.UPGRADE_PICK || ev.phase === Phase.WALL_BUILD) &&
          sawCannonPlaceThisRound &&
          !sawBattleThisRound &&
          !skipAnnouncedThisRound
        ) {
          skipAnnouncedThisRound = true;
          const owners = pendingCeasefire
            .filter((pick) => pick.round === ev.round - 1)
            .map((pick) => playerName(pick.playerId))
            .join(", ");
          // Prune consumed + any stale picks that never produced a skip.
          for (let idx = pendingCeasefire.length - 1; idx >= 0; idx--) {
            if (pendingCeasefire[idx]!.round <= ev.round - 1) {
              pendingCeasefire.splice(idx, 1);
            }
          }
          const ownerSuffix = owners !== "" ? ` — ${owners}` : "";
          lines.push(
            `── r${ev.round} BATTLE [skipped: ceasefire${ownerSuffix}] ──`,
          );
        }
        currentPhaseLabel = Phase[ev.phase];
        emitHeaderIfNeeded();
        // At battle start, surface each player's firable-cannon capacity.
        // A placed cannon only fires when ALL its tiles sit in wall-enclosed
        // interior (canFireOwnCannon) and it isn't a rampart/balloon cannon —
        // so the owned-cannon coordinates in the CANNON_PLACE log don't tell
        // you how much firepower actually comes online this round. The
        // fire/encl/alive triple makes "owns 17, fires 1" (enclosure collapse)
        // legible at a glance instead of needing per-cannon state probes.
        if (ev.phase === Phase.BATTLE) {
          const firepower = firepowerSummary(sc.state);
          if (firepower !== "") lines.push(`  firepower: ${firepower}`);
        }
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
        // Remember who armed a ceasefire — it skips NEXT round's battle, so
        // the skip marker (a round later) can name the owner. Tagged with the
        // pick round; consumed/pruned at detection.
        if (ev.upgradeId === UID.CEASEFIRE) {
          pendingCeasefire.push({ round: currentRound, playerId: ev.playerId });
        }
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
          return `${playerShort(idx)} ${player.lives}♥/${player.score}/${player.walls.size}w/${player.enclosedTowers.length}e${resetMark}`;
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

/** Per-player firable-cannon capacity at battle start, formatted as
 *  `fire<F>/encl<E>/alive<A> t[<towers>] i<interior>`. A placed cannon only
 *  fires when it's alive, NOT rampart/balloon, AND every tile of its footprint
 *  sits in the player's wall-enclosed interior (mirrors `canFireOwnCannon`).
 *  So `F` = firable now, `E` = alive + enclosed (drops the rampart/balloon
 *  filter), `A` = alive total. The E→A gap is cannons stranded outside the
 *  enclosure; the F→E gap is rampart/balloon dead weight. Without this line the
 *  CANNON_PLACE coordinates show owned cannons but never how many actually come
 *  online — "owns 17, fires 1" (enclosure collapse) is invisible otherwise.
 *  Reads the battle-time interior snapshot (`getBattleInterior`, no freshness
 *  assertion) so it's safe at BATTLE PHASE_START. */
function firepowerSummary(state: GameState): string {
  const segments: string[] = [];
  for (let idx = 0; idx < state.players.length; idx++) {
    const player = state.players[idx];
    if (!player || player.eliminated) continue;
    const interior = getBattleInterior(player);
    let alive = 0;
    let enclosed = 0;
    let firable = 0;
    for (const cannon of player.cannons) {
      if (!isCannonAlive(cannon)) continue;
      alive++;
      const size = cannonSize(cannon.mode);
      let inside = true;
      for (let dr = 0; dr < size && inside; dr++) {
        for (let dc = 0; dc < size && inside; dc++) {
          if (!interior.has(packTile(cannon.row + dr, cannon.col + dc))) {
            inside = false;
          }
        }
      }
      if (!inside) continue;
      enclosed++;
      if (!isRampartCannon(cannon) && !isBalloonCannon(cannon)) firable++;
    }
    const towers = player.enclosedTowers.map((tower) => tower.index).join(",");
    segments.push(
      `${playerShort(idx)} fire${firable}/encl${enclosed}/alive${alive} t[${towers}] i${interior.size}`,
    );
  }
  return segments.join(" | ");
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
 *  shouldn't be reported as wall.
 *
 *  Suffixes:
 *    `+dup`         — another in-flight ball from the same shooter (capturer
 *                     for captured cannons, original owner otherwise) already
 *                     targets this same impact tile.
 *    `+dup-wasted`  — this ball is excess vs the target's HP (e.g. 3rd ball
 *                     queued on a 1-hit wall). Promoted from `+dup` when the
 *                     overshoot is provable from current state.
 *    `+jitter`      — dust_storm is active, so the impact tile may differ
 *                     from the aim tile by up to 15°. Surfaces the explanation
 *                     for own-cannon / off-map / grass impacts that would
 *                     otherwise read as AI mistakes. */
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
  if (sameTileBalls.length >= 2) {
    // Include this just-fired ball in the count: CANNON_FIRED emits before
    // the ball is pushed onto state.cannonballs in some paths and after in
    // others, so compare against max(filterCount, totalQueued) — but the
    // current code path emits after the push, so sameTileBalls already
    // includes this fire. Verified by the existing +dup behaviour matching
    // the observed log.
    const queuedCount = sameTileBalls.length;
    const targetHp = effectiveTargetHp(state, row, col, tag);
    tag += targetHp !== undefined && queuedCount > targetHp
      ? " +dup-wasted"
      : " +dup";
  }
  if (state.modern?.activeModifier === MODIFIER_ID.DUST_STORM) {
    tag += " +jitter";
  }
  return tag;
}

/** Effective HP of whatever sits at (row, col), or undefined when HP doesn't
 *  apply (grass, water, off-map, grunt, tower — towers are cannonball-
 *  invulnerable so we don't surface "wasted" for them, the entire shot was
 *  wasted regardless of dup count). Used to detect over-commit on focus-fire:
 *  if more balls are queued than the target can absorb, the surplus is
 *  marked `+dup-wasted`. */
function effectiveTargetHp(
  state: GameState,
  row: number,
  col: number,
  tag: string,
): number | undefined {
  // Walls — 1 hit unless the owner holds reinforced_walls AND this tile isn't
  // already in damagedWalls (= already absorbed its one reinforcement).
  if (tag === "own-wall" || tag.startsWith("wall:")) {
    const key = packTile(row, col);
    for (const player of state.players) {
      if (!player.walls.has(key)) continue;
      const reinforced =
        (player.upgrades.get(UID.REINFORCED_WALLS) ?? 0) > 0 &&
        !player.damagedWalls.has(key);
      return reinforced ? 2 : 1;
    }
    return 1;
  }
  // Cannons — current hp. Matches `cannon:NAME@idx`, `own-cannon@idx`,
  // `own-captured@idx`, `lost-cannon@idx→NAME`. Locate by tile rather than
  // parsing the tag, since the tag's idx refers to different player arrays
  // across the variants.
  if (
    tag.startsWith("cannon:") ||
    tag.startsWith("own-cannon") ||
    tag.startsWith("own-captured") ||
    tag.startsWith("lost-cannon")
  ) {
    for (const player of state.players) {
      for (const cannon of player.cannons) {
        if (isCannonTile(cannon, row, col) && isCannonAlive(cannon)) {
          return cannon.hp;
        }
      }
    }
    return undefined;
  }
  // Debris — already-dead cannon, any hit is wasted. Treat as HP 0 so the
  // first dup ball already qualifies as +dup-wasted.
  if (tag.startsWith("debris:")) return 0;
  return undefined;
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
      player.enclosedTowers.some((owned) => owned.index === tower.index),
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
