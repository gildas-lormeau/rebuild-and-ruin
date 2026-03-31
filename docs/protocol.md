# Network Protocol

## Architecture

**Trusted host model.** One client (the host) runs all game logic. The server is a pure relay — it forwards messages between connected sockets with basic anti-cheat validation. All other clients (players and watchers) render from the events they receive.

```
Host ──WebSocket──> Server (relay) ──WebSocket──> Players / Watchers
                         ↑                              │
                         └──────────────────────────────┘
                              (player actions)
```

### Key Principles
- **Deterministic from seed**: all clients derive the map, towers, zones, and houses from the seed. The `init` message only carries the seed + settings — no map data.
- **Checkpoints at phase transitions**: full state snapshots sent at each phase boundary for reconciliation.
- **Events during phases**: incremental updates (piece placed, cannon fired, wall destroyed) streamed in real-time.
- **Local execution**: build and cannon phases run locally on each client for zero-latency input. The host validates and sends checkpoints.

## Connection Flow

```
Client                          Server                          Host
  │                                │                              │
  ├─ create_room ─────────────────>│                              │
  │<──────────── room_created ─────│                              │
  │              (code, seed,      │                              │
  │               settings)        │                              │
  │                                │                              │
  │  Other client joins:           │                              │
  │                                │<── join_room(code) ──────────│
  │                                │──── room_joined ────────────>│
  │                                │     (code, players, seed,    │
  │                                │      hostId, elapsedSec)     │
  │                                │                              │
  │  Slot selection:               │                              │
  │                                │<── select_slot(slotId) ──────│
  │<──────────── player_joined ────│──── joined + player_joined ─>│
  │                                │                              │
  │  Lobby timer expires:          │                              │
  ├─ init ────────────────────────>│──────────────────────────────>│
  ├─ select_start ────────────────>│──────────────────────────────>│
  │                                │                              │
```

## Message Categories

### Client → Server

| Message | Fields | Description |
|---------|--------|-------------|
| `create_room` | `settings` | Create a new room with battle length (0=unlimited, 3, 5, 8, 12), cannon HP, wait timer |
| `join_room` | `code` | Join an existing room by 4-letter code |
| `select_slot` | `slotId` | Pick a player slot (0-2) |
| `life_lost_choice` | `choice`, `playerId?` | Continue or abandon after losing a life |
| `ping` | — | Keepalive |

### Server → Client (Lobby)

| Message | Fields | Description |
|---------|--------|-------------|
| `room_created` | `code`, `settings`, `seed` | Room created successfully |
| `room_joined` | `code`, `players[]`, `settings`, `hostId`, `seed`, `elapsedSec` | Sent to joining client with current room state |
| `joined` | `playerId`, `previousPlayerId?` | Slot assigned after `select_slot` (includes previous slot if switching) |
| `player_joined` | `playerId`, `name`, `previousPlayerId?` | Broadcast to all when a player selects a slot (includes previous slot if switching) |
| `player_left` | `playerId` | Broadcast to all when a player disconnects |
| `room_error` | `message` | Room not found, full, or other error |

### Host → All (Phase Transitions / Checkpoints)

These are sent by the host and relayed to all other clients. They carry full state for reconciliation.

| Message | When | Key Data |
|---------|------|----------|
| `init` | Game start | `seed`, `playerCount`, `settings` (`battleLength`, `cannonMaxHp`, `buildTimer`, `cannonPlaceTimer`, `firstRoundCannons`) |
| `select_start` | Tower selection begins | `timer` |
| `castle_walls` | Castle construction animation | `plans[]` (playerId + ordered wall tiles) |
| `cannon_start` | Cannon placement begins | `timer`, `limits[]`, `players[]`, `grunts[]`, `bonusSquares[]`, `towerAlive[]`, `burningPits[]`, `houses[]` |
| `battle_start` | Battle begins | `players[]`, `grunts[]`, `capturedCannons[]`, `burningPits[]`, `towerAlive[]`, `flights[]?` |
| `build_start` | Build/repair phase begins | `round`, `timer`, `players[]`, `houses[]`, `grunts[]`, `bonusSquares[]`, `towerAlive[]`, `burningPits[]`, `rngSeed` |
| `build_end` | Build phase ends | `needsReselect[]`, `eliminated[]`, `scores[]`, `players[]` |
| `game_over` | Game ends | `winner`, `scores[]` |

#### Serialized Player Shape

The `players[]` array in checkpoint messages uses `SerializedPlayer` (`src/checkpoint-data.ts`):

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | Player index |
| `walls` | `number[]` | Wall tile keys (row×COLS+col) |
| `interior` | `number[]` | Enclosed territory tile keys |
| `cannons` | `{row, col, hp, mode, facing?}[]` | Cannon positions and state |
| `ownedTowerIndices` | `number[]` | Indices into `map.towers` |
| `homeTowerIdx` | `number \| null` | Home tower index |
| `castleWallTiles` | `number[]?` | Castle wall tiles protected from debris sweep (includes clumsy extras) |
| `lives` | `number` | Lives remaining |
| `eliminated` | `boolean` | Whether player is out |
| `score` | `number` | Accumulated score |

### Host → All (Incremental Events)

Streamed during gameplay phases. Battle impact events (`wall_destroyed` through `tower_killed`) are **host-only** — only the host can send them.

| Message | Phase | Description |
|---------|-------|-------------|
| `opponent_piece_placed` | WALL_BUILD | AI/remote player placed a wall piece |
| `opponent_phantom` | WALL_BUILD | Ghost piece position (cursor preview) |
| `opponent_cannon_placed` | CANNON_PLACE | AI/remote player placed a cannon |
| `opponent_cannon_phantom` | CANNON_PLACE | Ghost cannon position |
| `opponent_tower_selected` | SELECTION | Player browsing/confirming tower |
| `cannon_fired` | BATTLE | A cannon fired a cannonball |
| `wall_destroyed` | BATTLE | A wall tile was destroyed (host-only) |
| `cannon_damaged` | BATTLE | A cannon took damage (host-only) |
| `grunt_killed` | BATTLE | A grunt was killed (host-only) |
| `house_destroyed` | BATTLE | A house was destroyed (host-only) |
| `grunt_spawned` | BATTLE | A grunt was spawned (host-only) |
| `pit_created` | BATTLE | Burning pit from incendiary shot (host-only) |
| `tower_killed` | BATTLE | A tower was destroyed by grunts (host-only) |
| `aim_update` | BATTLE | Crosshair position + orbit params |
| `life_lost_choice` | Any | Forwarded from non-host client to all (playerId + choice) |

## Game Phases

```
CASTLE_SELECT ──> CASTLE_BUILD ──> CANNON_PLACE ──> BATTLE ──> WALL_BUILD ──┐
      ↑                                                                      │
      └──── (life lost → reselect) ──────────────────────────────────────────┘
      └──── (no reselect) ──> CANNON_PLACE ──> ...
```

Each transition is marked by a checkpoint message from the host. Watchers apply the checkpoint to reconcile state, then render locally until the next checkpoint.

## Host Migration

When the host disconnects mid-game, the server promotes another player (lowest slot ID) or falls back to any connected socket.

| Message | Sender | Description |
|---------|--------|-------------|
| `host_left` | Server → All | `newHostPlayerId`, `previousHostPlayerId`. `-1` if no human available (AI fallback). |
| `full_state` | New Host → All | Comprehensive snapshot sent after promotion for watcher reconciliation. Includes `migrationSeq?`, `phase`, `round`, `timer`, `battleCountdown`, `battleLength`, `shotsFired`, `rngState`, `players[]`, `grunts[]`, `housesAlive[]`, `bonusSquares[]`, `towerAlive[]`, `burningPits[]`, `cannonLimits[]`, `playerZones[]`, `activePlayer`, `towerPendingRevive[]`, `capturedCannons[]`, `balloonHits[]`, `cannonballs[]`, `balloonFlights[]?`. |

## Anti-Cheat (Server-Side)

The relay server validates without running game logic:

- **Host-only enforcement**: only the host socket can send checkpoints (`init`, `cannon_start`, `battle_start`, `build_start`, `build_end`, `game_over`, `full_state`, `select_start`, `castle_walls`) and battle impact events (`wall_destroyed`, `cannon_damaged`, `house_destroyed`, `grunt_killed`, `grunt_spawned`, `pit_created`, `tower_killed`)
- **Identity**: players can only send messages with their own `playerId` (host exempt — sends on behalf of AI players)
- **Phase gating**: `cannon_fired` rejected outside BATTLE, `opponent_piece_placed` rejected outside WALL_BUILD, `opponent_cannon_placed` rejected outside CANNON_PLACE, `opponent_tower_selected` rejected outside SELECTION, etc.
- **Rate limiting**: cosmetic messages (`opponent_phantom`, `opponent_cannon_phantom`, `aim_update`) capped at 100/s per type. Game-state messages (`opponent_piece_placed`, `opponent_cannon_placed`, `cannon_fired`, `opponent_tower_selected`, `life_lost_choice`) are **not** rate-limited — they are low-frequency and must never be silently dropped
- **Payload validation**: bounds-checking on `playerId`, grid coordinates, pixel coordinates, cannon modes, piece offsets, and choice values

## Bandwidth

Per watcher, ~1 KB/s average. 100 rooms × 3 players ≈ 3 Mbps combined. Dominant message type is `opponent_phantom` (ghost piece positions during build phase).

## Watcher Rendering

Watchers receive the same messages as players. They:
1. Apply checkpoints to reconcile full state at phase boundaries
2. Render incremental events (cannonballs, impacts, wall destruction) locally
3. Interpolate crosshair positions from `aim_update` messages
4. Animate orbits locally from orbit params sent once per countdown
5. Tick grunts locally (deterministic movement from shared state)
6. Use wall-clock timers (immune to RAF throttling when tab is backgrounded)
