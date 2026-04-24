/**
 * Debug script: log host/watcher per-phase state to find divergence.
 * Wrapped in Deno.test() so the test runner installs DOM polyfills before
 * the import chain that pulls in render/3d sprite textures evaluates.
 */

// scenario.ts MUST be evaluated before network-setup.ts so the render
// module-init runs before online-dom-shim defines document. Otherwise
// procedural-texture.ts goes from "undefined document → return undefined"
// to "stub document → call canvas.getContext (which doesn't exist)".

import { createScenario as _, type Scenario } from "./scenario.ts";
import "./test-globals.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import type { GameState } from "../src/shared/core/types.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";
import { createNetworkedPair } from "./network-setup.ts";

interface Snap {
  readonly round: number;
  readonly phase: string;
  readonly players: {
    id: number;
    lives: number;
    cannons: number;
    walls: number;
    ownedTowers: number;
    score: number;
  }[];
  readonly towerAlive: boolean[];
  readonly grunts: { row: number; col: number }[];
  readonly cannonballs: number;
  readonly rng: number;
}

void _;

Deno.test("debug net divergence (pure AI classic seed=42)", async () => {
  const { host, watcher, pump } = await createNetworkedPair({
    seed: 42,
    mode: "classic",
    rounds: 3,
  });

  const hostSnaps: { tag: string; snap: Snap }[] = [];
  const watcherSnaps: { tag: string; snap: Snap }[] = [];
  const hostEvents: { type: string; payload: unknown }[] = [];
  const watcherEvents: { type: string; payload: unknown }[] = [];

  // Capture every cannonFired / impact-class event on both sides so we
  // can compare the per-side bus stream and find which events the
  // watcher missed (or had extra of) compared to the host.
  const TRACKED_EVENTS = [
    GAME_EVENT.CANNON_FIRED,
    GAME_EVENT.WALL_DESTROYED,
    GAME_EVENT.WALL_ABSORBED,
    GAME_EVENT.WALL_SHIELDED,
    GAME_EVENT.CANNON_DAMAGED,
    GAME_EVENT.HOUSE_DESTROYED,
    GAME_EVENT.GRUNT_KILLED,
    GAME_EVENT.GRUNT_SPAWNED,
    GAME_EVENT.TOWER_KILLED,
  ] as const;
  for (const evType of TRACKED_EVENTS) {
    host.bus.on(evType, (ev) => {
      hostEvents.push({ type: evType, payload: ev });
    });
    watcher.bus.on(evType, (ev) => {
      watcherEvents.push({ type: evType, payload: ev });
    });
  }

  host.bus.on(GAME_EVENT.PHASE_END, (ev) => {
    const tag = `r${ev.round}:${String(ev.phase)}`;
    hostSnaps.push({ tag, snap: snap(host.state) });
  });
  watcher.bus.on(GAME_EVENT.PHASE_END, (ev) => {
    const tag = `r${ev.round}:${String(ev.phase)}`;
    watcherSnaps.push({ tag, snap: snap(watcher.state) });
  });

  await runNetworkedToEnd(host, watcher, pump);

  console.log(
    `event counts: host=${hostEvents.length} watcher=${watcherEvents.length}`,
  );
  const hostByType: Record<string, number> = {};
  const watcherByType: Record<string, number> = {};
  for (const e of hostEvents) hostByType[e.type] = (hostByType[e.type] ?? 0) + 1;
  for (const e of watcherEvents)
    watcherByType[e.type] = (watcherByType[e.type] ?? 0) + 1;
  for (const t of TRACKED_EVENTS) {
    const h = hostByType[t] ?? 0;
    const w = watcherByType[t] ?? 0;
    if (h !== w) console.log(`  ${t}: host=${h} watcher=${w}`);
  }

  // Host's network sends — what actually went over the wire.
  const sentByType: Record<string, number> = {};
  for (const msg of host.sentMessages) {
    const t = (msg as { type: string }).type;
    sentByType[t] = (sentByType[t] ?? 0) + 1;
  }
  console.log(`\nhost sentMessages total: ${host.sentMessages.length}`);
  for (const t of [
    "cannonFired",
    "wallDestroyed",
    "wallAbsorbed",
    "wallShielded",
    "cannonDamaged",
    "houseDestroyed",
    "gruntKilled",
    "gruntSpawned",
    "towerKilled",
  ]) {
    const c = sentByType[t] ?? 0;
    if (c > 0) console.log(`  sent ${t}: ${c}`);
  }

  console.log(
    `host snaps: ${hostSnaps.length}, watcher snaps: ${watcherSnaps.length}`,
  );

  const minLen = Math.min(hostSnaps.length, watcherSnaps.length);
  let firstDiff = -1;
  for (let i = 0; i < minLen; i++) {
    const h = hostSnaps[i]!;
    const w = watcherSnaps[i]!;
    if (h.tag !== w.tag) {
      console.log(`tag diverged at ${i}: host=${h.tag} watcher=${w.tag}`);
      firstDiff = i;
      break;
    }
    const d = diff(h.snap, w.snap);
    if (d.length > 0) {
      console.log(`\n=== first diff at snap[${i}] tag=${h.tag} ===`);
      for (const line of d) console.log(`  ${line}`);
      firstDiff = i;
      break;
    }
  }

  if (firstDiff === -1) {
    console.log(
      "no per-phase divergence — drift accrued after final PHASE_END",
    );
    if (hostSnaps.length !== watcherSnaps.length) {
      console.log(
        `snap count diverged: host=${hostSnaps.length}, watcher=${watcherSnaps.length}`,
      );
    }
  } else {
    for (let i = firstDiff; i < Math.min(firstDiff + 5, minLen); i++) {
      const h = hostSnaps[i]!;
      const w = watcherSnaps[i]!;
      const d = diff(h.snap, w.snap);
      if (d.length === 0) {
        console.log(`\nsnap[${i}] tag=${h.tag} (no diffs)`);
        continue;
      }
      console.log(`\nsnap[${i}] tag=${h.tag} diffs:`);
      for (const line of d) console.log(`  ${line}`);
    }
  }
});

function snap(state: GameState): Snap {
  return {
    round: state.round,
    phase: String(state.phase),
    players: state.players.map((p) => ({
      id: p.id,
      lives: p.lives,
      cannons: p.cannons.filter((c) => c.hp > 0).length,
      walls: p.walls.size,
      ownedTowers: p.ownedTowers.length,
      score: p.score,
    })),
    towerAlive: [...state.towerAlive],
    grunts: state.grunts.map((g) => ({ row: g.row, col: g.col })),
    cannonballs: state.cannonballs.length,
    rng: state.rng.getState(),
  };
}

function diff(a: Snap, b: Snap): string[] {
  const out: string[] = [];
  if (a.round !== b.round) out.push(`round: ${a.round} vs ${b.round}`);
  if (a.phase !== b.phase) out.push(`phase: ${a.phase} vs ${b.phase}`);
  if (a.cannonballs !== b.cannonballs)
    out.push(`cannonballs: ${a.cannonballs} vs ${b.cannonballs}`);
  if (a.rng !== b.rng) out.push(`rng: ${a.rng} vs ${b.rng}`);
  for (let i = 0; i < a.players.length; i++) {
    const ap = a.players[i]!;
    const bp = b.players[i]!;
    if (ap.lives !== bp.lives)
      out.push(`p${i}.lives: ${ap.lives} vs ${bp.lives}`);
    if (ap.cannons !== bp.cannons)
      out.push(`p${i}.cannons: ${ap.cannons} vs ${bp.cannons}`);
    if (ap.walls !== bp.walls)
      out.push(`p${i}.walls: ${ap.walls} vs ${bp.walls}`);
    if (ap.ownedTowers !== bp.ownedTowers)
      out.push(`p${i}.ownedTowers: ${ap.ownedTowers} vs ${bp.ownedTowers}`);
    if (ap.score !== bp.score)
      out.push(`p${i}.score: ${ap.score} vs ${bp.score}`);
  }
  for (let i = 0; i < a.towerAlive.length; i++) {
    if (a.towerAlive[i] !== b.towerAlive[i])
      out.push(
        `tower[${i}].alive: ${a.towerAlive[i]} vs ${b.towerAlive[i]}`,
      );
  }
  if (a.grunts.length !== b.grunts.length) {
    out.push(`grunts.length: ${a.grunts.length} vs ${b.grunts.length}`);
  }
  return out;
}

async function runNetworkedToEnd(
  host: Scenario,
  watcher: Scenario,
  pump: () => Promise<void>,
  maxSteps = 60_000,
): Promise<void> {
  for (let step = 0; step < maxSteps; step++) {
    host.tick(1);
    await pump();
    watcher.tick(1);
    if (host.mode() === Mode.STOPPED && watcher.mode() === Mode.STOPPED) {
      return;
    }
  }
  throw new Error(
    `lockstep did not reach STOPPED within ${maxSteps} steps ` +
      `(host=${host.mode()} watcher=${watcher.mode()})`,
  );
}
