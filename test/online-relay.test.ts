/**
 * Headless test for online relay: connects two WebSocket clients,
 * creates a room, joins, starts the game, and verifies message flow.
 *
 * Run: bun test/online-relay.test.ts
 * Requires: deno task server running on port 8001
 */

const SERVER_URL = "ws://localhost:8001/ws/play";

interface Msg { type: string; [key: string]: unknown }

function connectClient(name: string): Promise<{ ws: WebSocket; messages: Msg[]; waitFor: (type: string, timeout?: number) => Promise<Msg> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL);
    const messages: Msg[] = [];

    ws.onopen = () => {
      console.log(`[${name}] connected`);
      resolve({ ws, messages, waitFor });
    };
    ws.onerror = () => reject(new Error(`[${name}] connection failed — is the server running?`));
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data) as Msg;
      messages.push(msg);
    };

    function waitFor(type: string, timeout = 5000): Promise<Msg> {
      return new Promise((res, rej) => {
        // Check already received
        const existing = messages.find(m => m.type === type);
        if (existing) { res(existing); return; }

        const timer = setTimeout(() => {
          rej(new Error(`[${name}] timeout waiting for "${type}" (received: ${messages.map(m => m.type).join(", ")})`));
        }, timeout);

        const originalOnMessage = ws.onmessage;
        ws.onmessage = (e) => {
          const msg = JSON.parse(e.data) as Msg;
          messages.push(msg);
          if (msg.type === type) {
            clearTimeout(timer);
            ws.onmessage = originalOnMessage;
            res(msg);
          }
        };
      });
    }
  });
}

function send(ws: WebSocket, msg: Msg) {
  ws.send(JSON.stringify(msg));
}

async function runTest() {
  console.log("=== Online Relay Test ===\n");

  // Connect two clients
  const host = await connectClient("HOST");
  const watcher = await connectClient("WATCHER");

  // 1. Host creates a room
  send(host.ws, { type: "create_room", settings: { battleLength: 3, cannonMaxHp: 3, waitTimerSec: 60 } });
  const roomCreated = await host.waitFor("room_created");
  const code = roomCreated.code as string;
  console.log(`[HOST] room created: ${code}`);

  // 2. Host selects slot 0
  send(host.ws, { type: "select_slot", slotId: 0 });
  const joined = await host.waitFor("joined");
  console.log(`[HOST] joined as player ${joined.playerId}`);

  // 3. Watcher joins the room
  send(watcher.ws, { type: "join_room", code });
  const roomJoined = await watcher.waitFor("room_joined");
  console.log(`[WATCHER] joined room ${(roomJoined as Msg).code}`);

  // 4. Host starts the game
  send(host.ws, { type: "start_game" });

  // 5. Both should receive init
  const hostInit = await host.waitFor("init");
  console.log(`[HOST] received init (seed=${hostInit.seed}, yourPlayerId=${hostInit.yourPlayerId})`);

  const watcherInit = await watcher.waitFor("init");
  console.log(`[WATCHER] received init (seed=${watcherInit.seed}, yourPlayerId=${watcherInit.yourPlayerId})`);

  // 6. Both should receive select_start
  const hostSelect = await host.waitFor("select_start");
  console.log(`[HOST] received select_start (timer=${hostSelect.timer})`);

  const watcherSelect = await watcher.waitFor("select_start");
  console.log(`[WATCHER] received select_start (timer=${watcherSelect.timer})`);

  // 7. Host sends a tower_selected (as ServerMessage — opponent_tower_selected)
  send(host.ws, { type: "opponent_tower_selected", playerId: 0, towerIdx: 0 });
  send(host.ws, { type: "opponent_tower_selected", playerId: 1, towerIdx: 4 });
  send(host.ws, { type: "opponent_tower_selected", playerId: 2, towerIdx: 8 });

  // 8. Watcher should receive those relayed
  const t1 = await watcher.waitFor("opponent_tower_selected");
  console.log(`[WATCHER] received opponent_tower_selected (playerId=${t1.playerId}, towerIdx=${t1.towerIdx})`);

  // 9. Host sends castle_walls
  send(host.ws, { type: "castle_walls", plans: [
    { playerId: 0, tiles: [100, 101, 102] },
    { playerId: 1, tiles: [200, 201, 202] },
    { playerId: 2, tiles: [300, 301, 302] },
  ]});
  const walls = await watcher.waitFor("castle_walls");
  console.log(`[WATCHER] received castle_walls (${(walls.plans as unknown[]).length} plans)`);

  // 10. Host sends cannon_start checkpoint
  send(host.ws, { type: "cannon_start", timer: 15, limits: [3, 3, 3], players: [], grunts: [], bonusSquares: [], towerAlive: [], burningPits: [], houses: [] });
  const cs = await watcher.waitFor("cannon_start");
  console.log(`[WATCHER] received cannon_start (timer=${cs.timer})`);

  // 11. Host sends a cannon_fired during battle
  send(host.ws, { type: "cannon_fired", playerId: 0, cannonIdx: 0, startX: 100, startY: 100, targetX: 300, targetY: 200, speed: 150 });
  const cf = await watcher.waitFor("cannon_fired");
  console.log(`[WATCHER] received cannon_fired (playerId=${cf.playerId}, speed=${cf.speed})`);

  // 12. Host sends wall_destroyed
  send(host.ws, { type: "wall_destroyed", row: 5, col: 10, playerId: 1 });
  const wd = await watcher.waitFor("wall_destroyed");
  console.log(`[WATCHER] received wall_destroyed (row=${wd.row}, col=${wd.col})`);

  // 13. Host sends game_over
  send(host.ws, { type: "game_over", winner: "Red", scores: [{ name: "Red", score: 5000, eliminated: false }] });
  const go = await watcher.waitFor("game_over");
  console.log(`[WATCHER] received game_over (winner=${go.winner})`);

  console.log("\n=== ALL TESTS PASSED ===");

  host.ws.close();
  watcher.ws.close();
  process.exit(0);
}

runTest().catch(err => {
  console.error("\n=== TEST FAILED ===");
  console.error(err.message);
  process.exit(1);
});
