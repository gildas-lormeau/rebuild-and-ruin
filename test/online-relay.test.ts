import { assertEquals } from "@std/assert";
import { MESSAGE } from "../src/protocol/protocol.ts";

interface Msg {
  type: string;
  [key: string]: unknown;
}

interface Waiter {
  predicate: (msg: Msg) => boolean;
  resolve: (msg: Msg) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ClientHandle {
  ws: WebSocket;
  messages: Msg[];
  waitFor: (predicate: ((msg: Msg) => boolean) | string, timeout?: number) => Promise<Msg>;
}

const SERVER_URL = "ws://localhost:8001/ws/play";

Deno.test("relay matches current lobby, checkpoint, and migration protocol", async () => {
  const host = await connectClient("HOST");
  const player = await connectClient("PLAYER");
  const watcher = await connectClient("WATCHER");

  try {
    send(host.ws, {
      type: MESSAGE.CREATE_ROOM,
      settings: { maxRounds: 3, cannonMaxHp: 3, waitTimerSec: 1 },
    });
    const roomCreated = await host.waitFor(MESSAGE.ROOM_CREATED);
    const code = roomCreated.code as string;
    assertEquals(typeof code, "string");

    send(host.ws, { type: MESSAGE.SELECT_SLOT, playerId: 0 });
    const hostJoined = await host.waitFor(MESSAGE.JOINED);
    assertEquals(hostJoined.playerId, 0);

    send(player.ws, { type: MESSAGE.JOIN_ROOM, code });
    const playerRoomJoined = await player.waitFor(MESSAGE.ROOM_JOINED);
    assertEquals(playerRoomJoined.code, code);

    send(player.ws, { type: MESSAGE.SELECT_SLOT, playerId: 1 });
    const playerJoined = await player.waitFor(MESSAGE.JOINED);
    assertEquals(playerJoined.playerId, 1);
    const hostSawPlayer = await host.waitFor(
      (msg) => msg.type === MESSAGE.PLAYER_JOINED && msg.playerId === 1,
    );
    assertEquals(hostSawPlayer.playerId, 1);

    send(watcher.ws, { type: MESSAGE.JOIN_ROOM, code });
    const watcherRoomJoined = await watcher.waitFor(MESSAGE.ROOM_JOINED);
    assertEquals(watcherRoomJoined.code, code);

    send(host.ws, {
      type: MESSAGE.INIT,
      seed: 123,
      playerCount: 3,
      settings: {
        maxRounds: 3,
        cannonMaxHp: 3,
        buildTimer: 25,
        cannonPlaceTimer: 15,
      },
    });
    const playerInit = await player.waitFor(MESSAGE.INIT);
    const watcherInit = await watcher.waitFor(MESSAGE.INIT);
    assertEquals(playerInit.seed, 123);
    assertEquals(watcherInit.seed, 123);

    send(host.ws, { type: MESSAGE.SELECT_START, timer: 10 });
    const playerSelect = await player.waitFor(MESSAGE.SELECT_START);
    const watcherSelect = await watcher.waitFor(MESSAGE.SELECT_START);
    assertEquals(playerSelect.timer, 10);
    assertEquals(watcherSelect.timer, 10);

    send(player.ws, { type: MESSAGE.OPPONENT_TOWER_SELECTED, playerId: 1, towerIdx: 4, confirmed: false });
    const watcherTower = await watcher.waitFor(
      (msg) => msg.type === MESSAGE.OPPONENT_TOWER_SELECTED && msg.playerId === 1,
    );
    assertEquals(watcherTower.towerIdx, 4);

    send(host.ws, { type: MESSAGE.CANNON_START });
    const cannonStart = await watcher.waitFor(MESSAGE.CANNON_START);
    assertEquals(cannonStart.type, MESSAGE.CANNON_START);

    host.ws.close();

    const playerHostLeft = await player.waitFor(MESSAGE.HOST_LEFT);
    const watcherHostLeft = await watcher.waitFor(MESSAGE.HOST_LEFT);
    assertEquals(playerHostLeft.newHostPlayerId, 1);
    assertEquals(playerHostLeft.disconnectedPlayerId, 0);
    assertEquals(watcherHostLeft.newHostPlayerId, 1);
  } finally {
    if (host.ws.readyState === WebSocket.OPEN) host.ws.close();
    if (player.ws.readyState === WebSocket.OPEN) player.ws.close();
    if (watcher.ws.readyState === WebSocket.OPEN) watcher.ws.close();
  }
});

Deno.test("rejoin replays INIT, broadcasts the resync, and relays seat reclaim", async () => {
  const host = await connectClient("HOST");
  let player = await connectClient("PLAYER");
  const watcher = await connectClient("WATCHER");

  try {
    send(host.ws, {
      type: MESSAGE.CREATE_ROOM,
      settings: { maxRounds: 3, cannonMaxHp: 3, waitTimerSec: 30 },
    });
    const code = (await host.waitFor(MESSAGE.ROOM_CREATED)).code as string;

    send(host.ws, { type: MESSAGE.SELECT_SLOT, playerId: 0 });
    await host.waitFor(MESSAGE.JOINED);

    send(player.ws, { type: MESSAGE.JOIN_ROOM, code });
    await player.waitFor(MESSAGE.ROOM_JOINED);
    send(player.ws, { type: MESSAGE.SELECT_SLOT, playerId: 1 });
    const playerJoined = await player.waitFor(MESSAGE.JOINED);
    const rejoinToken = playerJoined.rejoinToken as string;
    // The selecting socket gets an opaque seat token; it's the rejoin proof.
    assertEquals(typeof rejoinToken, "string");

    send(watcher.ws, { type: MESSAGE.JOIN_ROOM, code });
    await watcher.waitFor(MESSAGE.ROOM_JOINED);
    // A watcher (no slot) is not handed a token in its own JOIN flow.

    send(host.ws, {
      type: MESSAGE.INIT,
      seed: 777,
      playerCount: 3,
      settings: { maxRounds: 3, cannonMaxHp: 3, buildTimer: 25, cannonPlaceTimer: 15 },
    });
    await player.waitFor(MESSAGE.INIT);
    await watcher.waitFor(MESSAGE.INIT);

    // ── Player's tab is hidden past the away window → socket drops ──
    player.ws.close();
    const hostSawLeft = await host.waitFor(
      (msg) => msg.type === MESSAGE.PLAYER_LEFT && msg.playerId === 1,
    );
    assertEquals(hostSawLeft.playerId, 1);

    // ── Player returns: reconnect + rejoin with its retained token ──
    player = await connectClient("PLAYER-REJOIN");
    send(player.ws, { type: MESSAGE.REJOIN_ROOM, code, token: rejoinToken });

    // The buffered INIT is replayed to the rejoiner (clean re-bootstrap)...
    const replayedInit = await player.waitFor(MESSAGE.INIT);
    assertEquals(replayedInit.seed, 777);
    // ...and the host is told which seat is rejoining so it can defer.
    const resyncReq = await host.waitFor(MESSAGE.REQUEST_RESYNC);
    assertEquals(resyncReq.forPlayerId, 1);

    // ── Host answers by re-broadcasting the resync to the WHOLE room (a no-op
    // migration): every peer — the rejoiner AND existing watchers — adopts it
    // and re-primes its AI in lockstep (a targeted resync forks the AI). ──
    send(host.ws, { type: MESSAGE.FULL_STATE, round: 2, phase: "wallBuild" });
    await player.waitFor(MESSAGE.FULL_STATE);
    await watcher.waitFor(MESSAGE.FULL_STATE);

    // ── Rejoiner asks for its seat back → forwarded to the host ──
    send(player.ws, { type: MESSAGE.REQUEST_SEAT_RECLAIM, playerId: 1 });
    const reclaimReq = await host.waitFor(MESSAGE.REQUEST_SEAT_RECLAIM);
    assertEquals(reclaimReq.playerId, 1);

    // ── Host stamps + broadcasts the lockstep flip → all peers get it ──
    send(host.ws, { type: MESSAGE.SEAT_RECLAIM, playerId: 1, applyAt: 4242 });
    const watcherReclaim = await watcher.waitFor(MESSAGE.SEAT_RECLAIM);
    const playerReclaim = await player.waitFor(MESSAGE.SEAT_RECLAIM);
    assertEquals(watcherReclaim.applyAt, 4242);
    assertEquals(playerReclaim.playerId, 1);

    // ── A garbage token cannot rejoin (no general spectator path) ──
    const intruder = await connectClient("INTRUDER");
    try {
      send(intruder.ws, { type: MESSAGE.REJOIN_ROOM, code, token: "not-a-real-token" });
      const err = await intruder.waitFor(MESSAGE.ROOM_ERROR);
      assertEquals(typeof err.message, "string");
    } finally {
      intruder.ws.close();
    }
  } finally {
    for (const handle of [host, player, watcher]) {
      if (handle.ws.readyState === WebSocket.OPEN) handle.ws.close();
    }
  }
});

function connectClient(name: string): Promise<ClientHandle> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL);
    const messages: Msg[] = [];
    const waiters: Waiter[] = [];

    const settleWaiters = (msg: Msg) => {
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i]!;
        if (!waiter.predicate(msg)) continue;
        clearTimeout(waiter.timer);
        waiters.splice(i, 1);
        waiter.resolve(msg);
      }
    };

    ws.onopen = () => {
      resolve({
        ws,
        messages,
        waitFor: (predicate, timeout = 5000) => {
          const existing = messages.find((msg) => matches(predicate, msg));
          if (existing) return Promise.resolve(existing);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              rej(new Error(`[${name}] timeout waiting for message`));
            }, timeout);
            waiters.push({
              predicate: (msg) => matches(predicate, msg),
              resolve: res,
              reject: rej,
              timer,
            });
          });
        },
      });
    };
    ws.onerror = () => reject(new Error(`[${name}] connection failed — is the server running?`));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as Msg;
      messages.push(msg);
      settleWaiters(msg);
    };
    ws.onclose = () => {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`[${name}] socket closed while waiting for message`));
      }
    };
  });
}

function matches(predicate: ((msg: Msg) => boolean) | string, msg: Msg): boolean {
  return typeof predicate === "string" ? msg.type === predicate : predicate(msg);
}

function send(ws: WebSocket, msg: Msg): void {
  ws.send(JSON.stringify(msg));
}
