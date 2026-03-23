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
  │<──────────── player_joined ────│──── joined(playerId) ───────>│
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
| `create_room` | `settings` | Create a new room with battle length, cannon HP, wait timer |
| `join_room` | `code` | Join an existing room by 4-letter code |
| `select_slot` | `slotId` | Pick a player slot (0-2) |
| `life_lost_choice` | `choice`, `playerId?` | Continue or abandon after losing a life |
| `ping` | — | Keepalive |

### Server → Client (Lobby)

| Message | Fields | Description |
|---------|--------|-------------|
| `room_created` | `code`, `settings`, `seed` | Room created successfully |
| `room_joined` | `code`, `players[]`, `settings`, `hostId`, `seed`, `elapsedSec` | Sent to joining client with current room state |
| `joined` | `playerId` | Slot assigned after `select_slot` |
| `player_joined` | `playerId`, `name` | Broadcast to all when a player selects a slot |
| `player_left` | `playerId` | Broadcast to all when a player disconnects |
| `room_error` | `message` | Room not found, full, or other error |

### Host → All (Phase Transitions / Checkpoints)

These are sent by the host and relayed to all other clients. They carry full state for reconciliation.

| Message | When | Key Data |
|---------|------|----------|
| `init` | Game start | `seed`, `playerCount`, `settings` |
| `select_start` | Tower selection begins | `timer` |
| `castle_walls` | Castle construction animation | `plans[]` (playerId + ordered wall tiles) |
| `cannon_start` | Cannon placement begins | `timer`, `limits[]`, `players[]`, `grunts[]`, `bonusSquares[]`, `towerAlive[]`, `burningPits[]`, `houses[]` |
| `battle_start` | Battle begins | `players[]`, `grunts[]`, `capturedCannons[]`, `burningPits[]`, `towerAlive[]`, `flights[]?` |
| `build_start` | Build/repair phase begins | `round`, `timer`, `players[]`, `houses[]`, `grunts[]`, `bonusSquares[]`, `towerAlive[]`, `burningPits[]`, `rngSeed` |
| `build_end` | Build phase ends | `needsReselect[]`, `eliminated[]`, `scores[]`, `players[]` |
| `game_over` | Game ends | `winner`, `scores[]` |

### Host → All (Incremental Events)

Streamed during gameplay phases.

| Message | Phase | Description |
|---------|-------|-------------|
| `opponent_piece_placed` | WALL_BUILD | AI/remote player placed a wall piece |
| `opponent_phantom` | WALL_BUILD | Ghost piece position (cursor preview) |
| `opponent_cannon_placed` | CANNON_PLACE | AI/remote player placed a cannon |
| `opponent_cannon_phantom` | CANNON_PLACE | Ghost cannon position |
| `opponent_tower_selected` | SELECTION | Player browsing/confirming tower |
| `cannon_fired` | BATTLE | A cannon fired a cannonball |
| `wall_destroyed` | BATTLE | A wall tile was destroyed |
| `cannon_damaged` | BATTLE | A cannon took damage |
| `grunt_killed` | BATTLE | A grunt was killed |
| `house_destroyed` | BATTLE | A house was destroyed |
| `grunt_spawned` | BATTLE | A grunt was spawned |
| `pit_created` | BATTLE | Burning pit from incendiary shot |
| `tower_killed` | BATTLE | A tower was destroyed by grunts |
| `aim_update` | BATTLE | Crosshair position + orbit params |

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
| `full_state` | New Host → All | Comprehensive snapshot sent after promotion for watcher reconciliation. Includes `phase`, `round`, `timer`, `players[]`, `grunts[]`, `cannonballs[]`, `balloonHits[]`, RNG state, and all checkpoint arrays. |

## Anti-Cheat (Server-Side)

The relay server validates without running game logic:

- **Host-only enforcement**: only the host socket can send checkpoints (`init`, `cannon_start`, `battle_start`, etc.)
- **Identity**: players can only send messages with their own `playerId`
- **Phase gating**: `cannon_fired` rejected outside BATTLE, `opponent_piece_placed` rejected outside WALL_BUILD, etc.
- **Rate limiting**: `aim_update` capped at 30/s, `life_lost_choice` at 5/s

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
