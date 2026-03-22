# Rebuild & Ruin

A web-based multiplayer remake of Rampart (1990). Build castles, place cannons, and destroy your opponents in tournament-style rounds.

## Build

```
npm install
npm run build
```

## Run locally

```
npm run dev
```

Open `http://localhost:5173/` — choose **Local** for offline play (vs AI) or **Online** to host/join a game.

## Online multiplayer

Start the relay server:

```
deno task server
```

The server listens on port 8001. Players connect via the Online lobby. The server is a pure WebSocket relay — all game logic runs on the host client.

For production, deploy `server/server.ts` to [Deno Deploy](https://deno.com/deploy) and the static site to GitHub Pages.

## Test

```
bun src/headless-test.ts                          # game logic invariants
npx tsx test/online-e2e.ts local                  # local play, 3 AI
npx tsx test/online-e2e.ts online 2               # online, 2 humans + watcher (needs server + dev)
npx tsx test/online-e2e.ts online 1 https://...   # online with remote server
```
