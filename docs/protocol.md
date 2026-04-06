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
  ├─ createRoom ──────────────────>│                              │
  │<──────────── roomCreated ──────│                              │
  │              (code, seed,      │                              │
  │               settings)        │                              │
  │                                │                              │
  │  Other client joins:           │                              │
  │                                │<── joinRoom(code) ───────────│
  │                                │──── roomJoined ─────────────>│
  │                                │     (code, players, seed,    │
  │                                │      hostId, elapsedSec)     │
  │                                │                              │
  │  Slot selection:               │                              │
  │                                │<── selectSlot(slotId) ───────│
  │<──────────── playerJoined ─────│──── joined + playerJoined ──>│
  │                                │                              │
  │  Lobby timer expires:          │                              │
  ├─ init ────────────────────────>│──────────────────────────────>│
  ├─ selectStart ─────────────────>│──────────────────────────────>│
  │                                │                              │
```

## Message Categories

### Client → Server

| Message | Fields | Description |
|---------|--------|-------------|
| `createRoom` | `settings` | Create a new room with max rounds (0=unlimited, 1, 3, 5, 8, 12), cannon HP, wait timer, game mode |
| `joinRoom` | `code` | Join an existing room by 4-letter code |
| `selectSlot` | `playerId` | Pick a player slot (0-2) |
| `lifeLostChoice` | `choice`, `playerId?` | Continue or abandon after losing a life |
| `upgradePick` | `playerId`, `choice` | Pick an upgrade during modern mode draft (forwarded to host) |
| `ping` | — | Keepalive |

### Server → Client (Lobby)

| Message | Fields | Description |
|---------|--------|-------------|
| `roomCreated` | `code`, `settings`, `seed` | Room created successfully |
| `roomJoined` | `code`, `players[]`, `settings`, `hostId`, `seed`, `elapsedSec` | Sent to joining client with current room state |
| `joined` | `playerId`, `previousPlayerId?` | Slot assigned after `selectSlot` (includes previous slot if switching) |
| `playerJoined` | `playerId`, `name`, `previousPlayerId?` | Broadcast to all when a player selects a slot (includes previous slot if switching) |
| `playerLeft` | `playerId` | Broadcast to all when a player disconnects |
| `roomError` | `message` | Room not found, full, or other error |

### Room Settings

Sent inside `createRoom`, `roomCreated`, and `roomJoined`:

| Field | Type | Description |
|-------|------|-------------|
| `maxRounds` | `number` | 0 (unlimited), 1 (e2e testing), 3, 5, 8, or 12 |
| `cannonMaxHp` | `number` | 3, 6, 9, or 12 |
| `waitTimerSec` | `number` | Lobby wait duration before auto-start (seconds, max 120) |
| `seed?` | `number` | Optional map seed (server generates random if omitted) |
| `gameMode?` | `string` | `"classic"` or `"modern"` (default `"classic"`) |

### Host → All (Phase Transitions / Checkpoints)

These are sent by the host and relayed to all other clients. They carry full state for reconciliation.

| Message | When | Key Data |
|---------|------|----------|
| `init` | Game start | `seed`, `playerCount`, `settings` (`maxRounds`, `cannonMaxHp`, `buildTimer`, `cannonPlaceTimer`, `firstRoundCannons`, `gameMode`) |
| `selectStart` | Tower selection begins | `timer` |
| `castleWalls` | Castle construction animation | `plans[]` (playerId + ordered wall tiles) |
| `cannonStart` | Cannon placement begins | `timer`, `limits[]`, `players[]`, `grunts[]`, `bonusSquares[]`, `towerAlive[]`, `burningPits[]`, `houses[]` |
| `battleStart` | Battle begins | `players[]`, `grunts[]`, `capturedCannons[]`, `burningPits[]`, `towerAlive[]`, `flights`, `frozenTiles`, `modifierDiff` |
| `buildStart` | Build/repair phase begins | `round`, `timer`, `players[]`, `houses[]`, `grunts[]`, `bonusSquares[]`, `towerAlive[]`, `burningPits[]`, `rngSeed`, `pendingUpgradeOffers?`, `frozenTiles` |
| `buildEnd` | Build phase ends | `needsReselect[]`, `eliminated[]`, `scores[]`, `players[]` |
| `gameOver` | Game ends | `winner`, `scores[]` |

#### Serialized Player Shape

The `players[]` array in checkpoint messages uses `SerializedPlayer` (`src/shared/checkpoint-data.ts`):

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | Player index |
| `walls` | `number[]` | Wall tile keys (row×COLS+col) |
| `cannons` | `{row, col, hp, mode, facing?}[]` | Cannon positions and state |
| `homeTowerIdx` | `number \| null` | Home tower index |
| `castleWallTiles` | `number[]?` | Castle wall tiles protected from debris sweep (includes clumsy extras) |
| `lives` | `number` | Lives remaining |
| `eliminated` | `boolean` | Whether player is out |
| `score` | `number` | Accumulated score |
| `upgrades` | `[string, number][]?` | Active upgrades with stack count (modern mode) |
| `damagedWalls` | `number[]?` | Wall tiles that absorbed one hit (reinforced walls upgrade) |

`interior` and `ownedTowers` are recomputed from `walls` on the receiver (flood-fill + tower enclosure check).

#### Serialized House Shape

Houses are sent as `houses: SerializedHouse[]` in `cannonStart`, `battleStart`, and `buildStart` checkpoints:

| Field | Type | Description |
|-------|------|-------------|
| `row` | `number` | Grid row |
| `col` | `number` | Grid column |
| `zone` | `number` | Zone index |
| `alive` | `boolean` | Whether the house is still standing |

House positions are deterministic from the seed, but alive/zone state is synced via the full `SerializedHouse` array.

#### Serialized Grunt Shape

The `grunts[]` array in checkpoint messages uses `SerializedGrunt` (`src/shared/checkpoint-data.ts`):

| Field | Type | Description |
|-------|------|-------------|
| `row` | `number` | Grid row |
| `col` | `number` | Grid column |
| `victimPlayerId` | `number` | Player being attacked |
| `targetTowerIdx?` | `number` | Specific tower target |
| `attackCountdown?` | `number` | Countdown (seconds) before killing adjacent tower or wall |
| `blockedRounds?` | `number` | Consecutive battles not adjacent to target tower |
| `attackingWall?` | `boolean` | Currently attacking a wall tile (decided at battle start) |
| `facing?` | `number` | Sprite facing direction |

### Host → All (Incremental Events)

Streamed during gameplay phases. Battle impact events (`wallDestroyed` through `towerKilled`) are **host-only** — only the host can send them.

| Message | Phase | Description |
|---------|-------|-------------|
| `opponentPiecePlaced` | WALL_BUILD | AI/remote player placed a wall piece |
| `opponentPhantom` | WALL_BUILD | Ghost piece position (cursor preview) |
| `opponentCannonPlaced` | CANNON_PLACE | AI/remote player placed a cannon |
| `opponentCannonPhantom` | CANNON_PLACE | Ghost cannon position |
| `opponentTowerSelected` | SELECTION | Player browsing/confirming tower |
| `cannonFired` | BATTLE | A cannon fired a cannonball |
| `wallDestroyed` | BATTLE | A wall tile was destroyed (host-only) |
| `cannonDamaged` | BATTLE | A cannon took damage (host-only) |
| `gruntKilled` | BATTLE | A grunt was killed (host-only) |
| `houseDestroyed` | BATTLE | A house was destroyed (host-only) |
| `gruntSpawned` | BATTLE | A grunt was spawned (host-only) |
| `pitCreated` | BATTLE | Burning pit from incendiary shot (host-only) |
| `iceThawed` | BATTLE | Frozen water tile thawed by cannonball (host-only) |
| `towerKilled` | BATTLE | A tower was destroyed by grunts (host-only) |
| `aimUpdate` | BATTLE | Crosshair position + orbit params |
| `lifeLostChoice` | Any | Forwarded from non-host client to all (playerId + choice) |
| `upgradePick` | Any | Forwarded from non-host client to host (playerId + choice) |

#### Battle Event Unions

The battle impact messages are grouped into type aliases in `server/protocol.ts` for type-safe handling:

- **`ImpactEvent`** = `wallDestroyed` | `cannonDamaged` | `houseDestroyed` | `gruntKilled` | `gruntSpawned` | `pitCreated` | `iceThawed` — host-only effects from cannonball impacts and secondary consequences.
- **`BattleEvent`** = `cannonFired` | `towerKilled` | `ImpactEvent` — all events emitted during battle. Discriminated on `type`.

## Game Phases

```
CASTLE_SELECT ──> CASTLE_BUILD ──> CANNON_PLACE ──> BATTLE ──> WALL_BUILD ──┐
      ↑                                                                      │
      └──── (life lost → reselect) ──────────────────────────────────────────┘
      └──── (no reselect) ──> CANNON_PLACE ──> ...
```

Modern mode inserts an upgrade draft/pick between battle end and build banner (from round 3). Upgrade offers are delivered in `buildStart.pendingUpgradeOffers` and players respond with `upgradePick` messages.

Each transition is marked by a checkpoint message from the host. Watchers apply the checkpoint to reconcile state, then render locally until the next checkpoint.

## Host Migration

When the host disconnects mid-game, the server promotes another player (lowest slot ID) or falls back to any connected socket.

| Message | Sender | Description |
|---------|--------|-------------|
| `hostLeft` | Server → All | `newHostPlayerId`, `disconnectedPlayerId`. `null` if no human available (watcher fallback). |
| `fullState` | New Host → All | Comprehensive snapshot sent after promotion for watcher reconciliation. Includes `migrationSeq?`, `phase`, `round`, `timer`, `battleCountdown`, `maxRounds`, `shotsFired`, `rngState`, `gameMode`, `activeModifier`, `lastModifierId`, `pendingUpgradeOffers?`, `frozenTiles`, `players[]`, `grunts[]`, `houses[]`, `bonusSquares[]`, `towerAlive[]`, `burningPits[]`, `cannonLimits[]`, `playerZones[]`, `towerPendingRevive[]`, `capturedCannons[]`, `balloonHits[]`, `cannonballs[]`, `balloonFlights?`. |

## Anti-Cheat (Server-Side)

The relay server validates without running game logic:

- **Host-only enforcement**: only the host socket can send checkpoints (`init`, `cannonStart`, `battleStart`, `buildStart`, `buildEnd`, `gameOver`, `fullState`, `selectStart`, `castleWalls`) and battle impact events (`wallDestroyed`, `cannonDamaged`, `houseDestroyed`, `gruntKilled`, `gruntSpawned`, `pitCreated`, `iceThawed`, `towerKilled`)
- **Identity**: players can only send messages with their own `playerId` (host exempt — sends on behalf of AI players)
- **Phase gating**: `cannonFired` and `aimUpdate` rejected outside BATTLE, `opponentPiecePlaced` and `opponentPhantom` rejected outside WALL_BUILD, `opponentCannonPlaced` and `opponentCannonPhantom` rejected outside CANNON_PLACE, `opponentTowerSelected` rejected outside CASTLE_SELECT
- **Rate limiting**: cosmetic messages (`opponentPhantom`, `opponentCannonPhantom`, `aimUpdate`) capped at 100/s per socket per message type. Game-state messages (`opponentPiecePlaced`, `opponentCannonPlaced`, `cannonFired`, `opponentTowerSelected`, `lifeLostChoice`, `upgradePick`) are **not** rate-limited — they are low-frequency and must never be silently dropped
- **Payload validation**: bounds-checking on `playerId`, grid coordinates, pixel coordinates, cannon modes, piece offsets, tower index, and choice values

## Bandwidth

Per watcher, ~1 KB/s average. 100 rooms × 3 players ≈ 3 Mbps combined. Dominant message type is `opponentPhantom` (ghost piece positions during build phase).

## Watcher Rendering

Watchers receive the same messages as players. They:
1. Apply checkpoints to reconcile full state at phase boundaries
2. Render incremental events (cannonballs, impacts, wall destruction) locally
3. Interpolate crosshair positions from `aimUpdate` messages
4. Animate orbits locally from orbit params sent once per countdown
5. Tick grunts locally (deterministic movement from shared state)
6. Use wall-clock timers (immune to RAF throttling when tab is backgrounded)
