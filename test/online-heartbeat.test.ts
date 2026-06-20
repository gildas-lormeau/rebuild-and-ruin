// Unit tests for the desync-detection heartbeat (src/online/online-heartbeat.ts).
//
// The monitor is a pure module — no scenario / 3D / DOM — so these drive it
// directly with two fake peers and a hand-wired "relay" (the host's `send`
// pushes straight into the non-host's `onMessage`). They prove the contract:
// matching cursors at a matching simTick never trip (even under skew), a single
// fork trips exactly once, the host never self-checks, the future-tick path
// resolves on arrival, and reset() prevents a cross-discontinuity false trip.
//
// Run: deno test --no-check test/online-heartbeat.test.ts

import { assert, assertEquals } from "@std/assert";
import {
  createHeartbeatMonitor,
  type HeartbeatMonitor,
} from "../src/online/online-heartbeat.ts";
import type { ServerMessage } from "../src/protocol/protocol.ts";
import type { GameState } from "../src/shared/core/types.ts";
import { Rng } from "../src/shared/platform/rng.ts";

interface FakePeer {
  readonly holder: { simTick: number; rng: Rng };
  readonly state: GameState;
}

interface Desync {
  simTick: number;
  local: number;
  host: number;
}

const HEARTBEAT_INTERVAL_TICKS = 30;

Deno.test("no desync when cursors match in lockstep", () => {
  const { host, peer, hostPeer, peerPeer, desyncs } = makePair({
    hostSeed: 42,
    peerSeed: 42,
  });
  for (let t = 1; t <= 90; t++) {
    processTick(hostPeer, t);
    host.recordTick(); // emits at t % 30 === 0 → peer.onMessage
    processTick(peerPeer, t);
    peer.recordTick(); // resolves any early-arrived host fingerprint
  }
  assertEquals(desyncs.length, 0);
});

Deno.test("no false positive under skew (peer behind the host)", () => {
  // Host runs ahead: it emits a fingerprint for a tick the peer hasn't reached.
  // The peer must stash it and resolve it (matching) once it catches up.
  const { host, peer, hostPeer, peerPeer, desyncs } = makePair({
    hostSeed: 7,
    peerSeed: 7,
  });
  // Host reaches tick 30 and emits before the peer has processed any tick.
  for (let t = 1; t <= HEARTBEAT_INTERVAL_TICKS; t++) {
    processTick(hostPeer, t);
    host.recordTick();
  }
  // Peer now catches up; at tick 30 it resolves the stashed fingerprint.
  for (let t = 1; t <= HEARTBEAT_INTERVAL_TICKS; t++) {
    processTick(peerPeer, t);
    peer.recordTick();
  }
  assertEquals(desyncs.length, 0);
});

Deno.test("detects a fork exactly once (poison the peer)", () => {
  const { host, peer, hostPeer, peerPeer, desyncs } = makePair({
    hostSeed: 99,
    peerSeed: 99,
  });
  for (let t = 1; t <= 90; t++) {
    processTick(hostPeer, t);
    host.recordTick();
    // Poison the peer at tick 10: one extra draw forks its cursor permanently.
    processTick(peerPeer, t, t === 10 ? 1 : 0);
    peer.recordTick();
  }
  // First emitted fingerprint after the fork is tick 30; it must trip.
  assertEquals(desyncs.length, 1);
  assertEquals(desyncs[0]!.simTick, HEARTBEAT_INTERVAL_TICKS);
  assert(desyncs[0]!.local !== desyncs[0]!.host);
});

Deno.test("detects a fork on the future-tick (pending) path", () => {
  const { host, peer, hostPeer, peerPeer, desyncs } = makePair({
    hostSeed: 5,
    peerSeed: 5,
  });
  // Poison the peer first, while it lags behind the host.
  for (let t = 1; t <= HEARTBEAT_INTERVAL_TICKS; t++) {
    processTick(peerPeer, t, t === 5 ? 1 : 0);
    peer.recordTick();
  }
  // Host then emits the tick-30 fingerprint, which the peer already passed:
  // it lands in `history`, so the compare runs immediately on receipt.
  for (let t = 1; t <= HEARTBEAT_INTERVAL_TICKS; t++) {
    processTick(hostPeer, t);
    host.recordTick();
  }
  assertEquals(desyncs.length, 1);
  assertEquals(desyncs[0]!.simTick, HEARTBEAT_INTERVAL_TICKS);
});

/** A host monitor whose heartbeats relay straight into a non-host monitor.
 *  `desyncs` collects what the non-host surfaces. */
function makePair(opts: { hostSeed: number; peerSeed: number }): {
  host: HeartbeatMonitor;
  peer: HeartbeatMonitor;
  hostPeer: FakePeer;
  peerPeer: FakePeer;
  desyncs: Desync[];
} {
  const hostPeer = makePeer(opts.hostSeed);
  const peerPeer = makePeer(opts.peerSeed);
  const desyncs: Desync[] = [];

  const peer = createHeartbeatMonitor({
    getState: () => peerPeer.state,
    amHost: () => false,
    send: () => {}, // non-host never emits
    onDesync: (simTick, local, host) => {
      desyncs.push({ simTick, local, host });
    },
  });

  const host = createHeartbeatMonitor({
    getState: () => hostPeer.state,
    amHost: () => true,
    // Relay: the host's broadcast is delivered to the non-host peer.
    send: (msg: ServerMessage) => peer.onMessage(msg),
    onDesync: () => {
      throw new Error("host must never self-detect a desync");
    },
  });

  return { host, peer, hostPeer, peerPeer, desyncs };
}

Deno.test("host never self-detects", () => {
  const hostPeer = makePeer(1);
  let fired = false;
  const host = createHeartbeatMonitor({
    getState: () => hostPeer.state,
    amHost: () => true,
    send: () => {},
    onDesync: () => {
      fired = true;
    },
  });
  // Feed a wildly mismatching fingerprint; an `amHost` monitor must ignore it.
  host.onMessage({ type: "heartbeat", simTick: 30, rngState: 123456 });
  assert(!fired);
});

Deno.test("reset() prevents a cross-discontinuity false positive", () => {
  // Model a checkpoint adoption: the peer's pre-adoption history holds a value
  // for tick 30 that differs from the post-adoption host fingerprint for the
  // same tick. Without reset() this reads as a false desync; with it, the stale
  // entry is gone so the late fingerprint finds nothing to compare and is inert.
  const peerPeer = makePeer(11);
  const desyncs: Desync[] = [];
  const peer = createHeartbeatMonitor({
    getState: () => peerPeer.state,
    amHost: () => false,
    send: () => {},
    onDesync: (simTick, local, host) => desyncs.push({ simTick, local, host }),
  });
  // Pre-adoption: peer records its own (diverged) cursor at tick 30.
  for (let t = 1; t <= HEARTBEAT_INTERVAL_TICKS; t++) {
    processTick(peerPeer, t, t === 3 ? 1 : 0);
    peer.recordTick();
  }
  // Adopt a checkpoint → flush history.
  peer.reset();
  // A late host fingerprint for the now-flushed tick 30 must NOT trip.
  peer.onMessage({ type: "heartbeat", simTick: 30, rngState: 999 });
  assertEquals(desyncs.length, 0);
});

function makePeer(seed: number): FakePeer {
  const holder = { simTick: 0, rng: new Rng(seed) };
  // Only `.simTick` and `.rng.getState()` are read by the monitor.
  return { holder, state: holder as unknown as GameState };
}

/** Simulate one processed sim tick: advance the cursor `draws` times, then set
 *  the tick counter to what the monitor will sample. `extra` poisons this peer
 *  (an extra draw the other peer didn't make → cursors diverge from here on). */
function processTick(peer: FakePeer, simTick: number, extra = 0): void {
  for (let i = 0; i < 1 + extra; i++) peer.holder.rng.next();
  peer.holder.simTick = simTick;
}
