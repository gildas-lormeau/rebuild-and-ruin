import { expect, test } from "bun:test";

import { MESSAGE } from "../server/protocol.ts";

const SERVER_URL = "ws://localhost:8001/ws/play";

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

function matches(predicate: ((msg: Msg) => boolean) | string, msg: Msg): boolean {
  return typeof predicate === "string" ? msg.type === predicate : predicate(msg);
}

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

function send(ws: WebSocket, msg: Msg): void {
  ws.send(JSON.stringify(msg));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("relay matches current lobby, checkpoint, and migration protocol", async () => {
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
    expect(typeof code).toBe("string");

    send(host.ws, { type: MESSAGE.SELECT_SLOT, slotId: 0 });
    const hostJoined = await host.waitFor(MESSAGE.JOINED);
    expect(hostJoined.playerId).toBe(0);

    send(player.ws, { type: MESSAGE.JOIN_ROOM, code });
    const playerRoomJoined = await player.waitFor(MESSAGE.ROOM_JOINED);
    expect(playerRoomJoined.code).toBe(code);

    send(player.ws, { type: MESSAGE.SELECT_SLOT, slotId: 1 });
    const playerJoined = await player.waitFor(MESSAGE.JOINED);
    expect(playerJoined.playerId).toBe(1);
    const hostSawPlayer = await host.waitFor(
      (msg) => msg.type === MESSAGE.PLAYER_JOINED && msg.playerId === 1,
    );
    expect(hostSawPlayer.playerId).toBe(1);

    send(watcher.ws, { type: MESSAGE.JOIN_ROOM, code });
    const watcherRoomJoined = await watcher.waitFor(MESSAGE.ROOM_JOINED);
    expect(watcherRoomJoined.code).toBe(code);

    await sleep(1100);

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
    expect(playerInit.seed).toBe(123);
    expect(watcherInit.seed).toBe(123);

    send(host.ws, { type: MESSAGE.SELECT_START, timer: 10 });
    const playerSelect = await player.waitFor(MESSAGE.SELECT_START);
    const watcherSelect = await watcher.waitFor(MESSAGE.SELECT_START);
    expect(playerSelect.timer).toBe(10);
    expect(watcherSelect.timer).toBe(10);

    send(player.ws, { type: MESSAGE.OPPONENT_TOWER_SELECTED, playerId: 1, towerIdx: 4, confirmed: false });
    const watcherTower = await watcher.waitFor(
      (msg) => msg.type === MESSAGE.OPPONENT_TOWER_SELECTED && msg.playerId === 1,
    );
    expect(watcherTower.towerIdx).toBe(4);

    send(host.ws, {
      type: MESSAGE.CASTLE_WALLS,
      plans: [
        { playerId: 0, tiles: [100, 101, 102] },
        { playerId: 1, tiles: [200, 201, 202] },
        { playerId: 2, tiles: [300, 301, 302] },
      ],
    });
    const castleWalls = await watcher.waitFor(MESSAGE.CASTLE_WALLS);
    expect((castleWalls.plans as unknown[]).length).toBe(3);

    send(host.ws, {
      type: MESSAGE.CANNON_START,
      timer: 15,
      limits: [3, 3, 3],
      players: [],
      grunts: [],
      bonusSquares: [],
      towerAlive: [],
      burningPits: [],
      houses: [],
    });
    const cannonStart = await watcher.waitFor(MESSAGE.CANNON_START);
    expect(cannonStart.timer).toBe(15);

    host.ws.close();

    const playerHostLeft = await player.waitFor(MESSAGE.HOST_LEFT);
    const watcherHostLeft = await watcher.waitFor(MESSAGE.HOST_LEFT);
    expect(playerHostLeft.newHostPlayerId).toBe(1);
    expect(playerHostLeft.previousHostPlayerId).toBe(0);
    expect(watcherHostLeft.newHostPlayerId).toBe(1);
  } finally {
    if (host.ws.readyState === WebSocket.OPEN) host.ws.close();
    if (player.ws.readyState === WebSocket.OPEN) player.ws.close();
    if (watcher.ws.readyState === WebSocket.OPEN) watcher.ws.close();
    await sleep(25);
  }
}, 15000);
