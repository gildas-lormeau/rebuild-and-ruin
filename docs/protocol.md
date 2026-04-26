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
- **Bare-marker phase checkpoints**: `buildStart`, `cannonStart`, `buildEnd` carry no payload. The watcher runs the same engine fn locally on receipt (`enterBuildPhase`, source-prefix + `enterCannonPhase`, `finalizeBuildPhase`). Watcher and host produce byte-identical state from synced RNG.
- **One RNG resync per round**: `battleStart` carries only `rngState` — the host's pre-`enterBattlePhase` RNG. The watcher applies `setState(rngState)` then runs the same setup locally (modifier roll, balloon resolution, grunt wall-attack flags, captured cannons, combo tracker). Drift over a full round is caught here as a defense-in-depth round-trip check.
- **Events during phases**: incremental updates (piece placed, cannon fired, wall destroyed) streamed in real-time.
- **Local AI on every peer**: AI selections, castle wall plans, modifier tiles, bonus square placement, and grunt spawns all advance from `state.rng`. Watchers run the same code paths as host — no wire payload needed for any of these.
- **Local execution**: build and cannon phases run locally on each client for zero-latency input. The host's local controllers broadcast their actions as incremental events; the watcher derives everything else from local engine fns.

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
| `gameMode?` | `string` | `"classic"` or `"modern"` (default `"modern"`) |

### Host → All (Phase Transitions / Checkpoints)

Bare-marker checkpoints carry only `{ type }` — the watcher runs the matching engine fn locally on receipt, deriving every mutation from synced state + RNG. The only payload-carrying checkpoint is `battleStart`, which ships the host's pre-`enterBattlePhase` `rngState` so the watcher can resync once per round.

| Message | When | Payload | Watcher action |
|---------|------|---------|----------------|
| `init` | Game start | `seed`, `playerCount`, `settings` (`maxRounds`, `cannonMaxHp`, `buildTimer`, `cannonPlaceTimer`, `firstRoundCannons`, `gameMode`) | Bootstrap from seed |
| `selectStart` | Tower selection begins | `timer` | Run `enterTowerSelection` |
| `cannonStart` | CASTLE_SELECT / CASTLE_RESELECT / WALL_BUILD → CANNON_PLACE | _none_ | Source-phase prefix (`finalizeBuildVisuals` / `finalizeReselectedPlayers` / `finalizeCastleConstruction`) + `enterCannonPhase` |
| `battleStart` | CANNON_PLACE → BATTLE | `rngState` (host's pre-`enterBattlePhase` RNG) | `state.rng.setState(rngState)` then `enterBattlePhase` (modifier roll, balloon resolution, grunt wall-attack flags, combo tracker) |
| `buildStart` | BATTLE → WALL_BUILD | _none_ | `enterBuildPhase` (combo bonuses, battle cleanup, grunt spawn, upgrade offers, modifier rotation, round increment, piece bag init) |
| `buildEnd` | End of build phase | _none_ | `finalizeBuildPhase` (territory finalize, life penalties, score) |
| `gameOver` | Game ends | `winner`, `scores[]` | Render terminal frame |

**Drift detection**: a watcher whose state ever desynced from host will fail the `state.rng` round-trip when the next `battleStart` arrives — the local RNG must already match `rngState` before `setState` is applied. In practice this is a soft check (`setState` always wins) but it surfaces in determinism tests that assert byte-for-byte parity.

#### Serialized Shapes

The `SerializedPlayer` / `SerializedHouse` / `SerializedGrunt` / `SerializedBonusSquare` / `SerializedBurningPit` types in `src/protocol/checkpoint-data.ts` are used **only** by `fullState` (host migration / late-join recovery — see [Host Migration](#host-migration)). Phase-marker checkpoints carry no payload, so they don't reference these shapes.

`interior` and `ownedTowers` are always recomputed from `walls` on the receiver (flood-fill + tower enclosure check) — they're never serialized.

### Host → All (Incremental Events)

Streamed during gameplay phases. Battle impact events (`wallDestroyed` through `towerKilled`) are **host-only** — only the host can send them.

| Message | Phase | Description |
|---------|-------|-------------|
| `opponentPiecePlaced` | WALL_BUILD | AI/remote player placed a wall piece |
| `opponentPhantom` | WALL_BUILD | Ghost piece position (cursor preview) |
| `opponentCannonPlaced` | CANNON_PLACE | AI/remote player placed a cannon |
| `opponentCannonPhantom` | CANNON_PLACE | Ghost cannon position |
| `opponentTowerSelected` | SELECTION | **Human** player browsing/confirming tower (AI selections derived locally on every peer from synced `strategy.rng` — never sent over the wire) |
| `cannonFired` | BATTLE | A cannon fired a cannonball |
| `wallDestroyed` | BATTLE | A wall tile was destroyed (host-only) |
| `cannonDamaged` | BATTLE | A cannon took damage (host-only) |
| `gruntKilled` | BATTLE | A grunt was killed (host-only) |
| `houseDestroyed` | BATTLE | A house was destroyed (host-only) |
| `gruntSpawned` | BATTLE | A grunt was spawned (host-only) |
| `pitCreated` | BATTLE | Burning pit from incendiary shot (host-only) |
| `iceThawed` | BATTLE | Frozen water tile thawed by cannonball (host-only) |
| `towerKilled` | BATTLE | A tower was destroyed by grunts (host-only) |
| `aimUpdate` | BATTLE | Crosshair position |
| `lifeLostChoice` | Any | Forwarded from non-host client to all (playerId + choice) |
| `upgradePick` | Any | Forwarded from non-host client to host (playerId + choice) |

#### Battle Event Unions

The battle impact messages are grouped into type aliases in `src/shared/core/battle-events.ts` for type-safe handling:

- **`ImpactEvent`** = `wallDestroyed` | `wallAbsorbed` | `wallShielded` | `cannonDamaged` | `houseDestroyed` | `gruntKilled` | `gruntChipped` | `gruntSpawned` | `pitCreated` | `iceThawed` — host-only effects from cannonball impacts and secondary consequences.
- **`BattleEvent`** = `cannonFired` | `towerKilled` | `ImpactEvent` — all events emitted during battle. Discriminated on `type`.

## Game Phases

```
CASTLE_SELECT ──> CANNON_PLACE ──> BATTLE ──> WALL_BUILD ──┐
      ↑                                                     │
      └──── (life lost → CASTLE_RESELECT) ──────────────────┘
      └──── (no reselect) ──> CANNON_PLACE ──> ...
```

Castle wall construction is animated inline during `CASTLE_SELECT` / `CASTLE_RESELECT` — every peer derives wall plans locally via `prepareCastleWallsForPlayer` (consumes `state.rng` for clumsy builders + ring ordering) on each tower confirmation. No separate `CASTLE_BUILD` phase, no `castleWalls` wire message.

Modern mode inserts an upgrade draft/pick between battle end and build banner (from round 3). Upgrade offers are generated locally on every peer inside `enterBuildFromBattle` (synced RNG); players respond with `upgradePick` messages, which the host applies and re-broadcasts.

Each transition is marked by a bare-marker checkpoint from the host. Watchers run the matching engine fn locally on receipt and render incremental events until the next checkpoint.

## Host Migration

When the host disconnects mid-game, the server promotes another player (lowest slot ID) or falls back to any connected socket.

| Message | Sender | Description |
|---------|--------|-------------|
| `hostLeft` | Server → All | `newHostPlayerId`, `disconnectedPlayerId`. `null` if no human available (watcher fallback). |
| `fullState` | New Host → All | Comprehensive snapshot sent after promotion for watcher reconciliation. Includes `migrationSeq?`, `phase`, `round`, `timer`, `battleCountdown`, `maxRounds`, `shotsFired`, `rngState`, `gameMode`, `activeModifier`, `activeModifierChangedTiles[]`, `lastModifierId`, `pendingUpgradeOffers?`, `masterBuilderLockout?`, `masterBuilderOwners?`, `frozenTiles`, `highTideTiles?`, `sinkholeTiles?`, `players[]`, `grunts[]`, `houses[]`, `bonusSquares[]`, `towerAlive[]`, `burningPits[]`, `cannonLimits[]`, `salvageSlots?`, `playerZones[]`, `towerPendingRevive[]`, `capturedCannons[]`, `cannonballs[]`, `balloonFlights?`. The full shape lives in `FullStateMessage` in `src/protocol/protocol.ts` — the lint script `scripts/lint-checkpoint-fields.ts` enforces that every `GameState`/`ModernState` field is referenced in `online-serialize.ts` so additions can't silently drift. |

## Anti-Cheat (Server-Side)

The relay server validates without running game logic:

- **Host-only enforcement**: only the host socket can send checkpoints (`init`, `selectStart`, `cannonStart`, `battleStart`, `buildStart`, `buildEnd`, `gameOver`, `fullState`) and battle impact events (`wallDestroyed`, `wallAbsorbed`, `wallShielded`, `cannonDamaged`, `houseDestroyed`, `gruntKilled`, `gruntChipped`, `gruntSpawned`, `pitCreated`, `iceThawed`, `towerKilled`)
- **Identity**: players can only send messages with their own `playerId` (host exempt — sends on behalf of AI players)
- **Phase gating**: `cannonFired` and `aimUpdate` rejected outside BATTLE, `opponentPiecePlaced` and `opponentPhantom` rejected outside WALL_BUILD, `opponentCannonPlaced` and `opponentCannonPhantom` rejected outside CANNON_PLACE, `opponentTowerSelected` rejected outside CASTLE_SELECT
- **Rate limiting**: cosmetic messages (`opponentPhantom`, `opponentCannonPhantom`, `aimUpdate`) capped at 100/s per socket per message type. Game-state messages (`opponentPiecePlaced`, `opponentCannonPlaced`, `cannonFired`, `opponentTowerSelected`, `lifeLostChoice`, `upgradePick`) are **not** rate-limited — they are low-frequency and must never be silently dropped
- **Payload validation**: bounds-checking on `playerId`, grid coordinates, pixel coordinates, cannon modes, piece offsets, tower index, and choice values

## Bandwidth

Per watcher, ~1 KB/s average. 100 rooms × 3 players ≈ 3 Mbps combined. Dominant message type is `opponentPhantom` (ghost piece positions during build phase).

## Watcher Rendering

Watchers receive the same messages as players. They:
1. Run the same engine fn locally at each phase-marker checkpoint (`enterBuildPhase`, `enterCannonPhase`, `finalizeBuildPhase`, etc.) — derive every state mutation from synced RNG instead of reading wire payloads
2. Resync RNG once per round at `battleStart` before running `enterBattlePhase`
3. Apply incremental events (piece placed, cannon placed, cannon fired, wall destroyed, etc.) as they arrive
4. Interpolate crosshair positions from `aimUpdate` messages
5. Tick grunts locally (deterministic movement from shared state)
6. Use sim-time accumulators with the mock clock in tests, wall-clock timers in production (immune to RAF throttling when tab is backgrounded)

Late-joining watchers (mid-game) and post-host-migration watchers receive `fullState` instead, which carries the complete serialized state.
