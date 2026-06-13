# Network Protocol

## Architecture

**Trusted host model.** The host owns the canonical state for cross-peer mutations driven by human input (piece/cannon placements, fires, tower confirmations, dialog choices); watchers apply those at the lockstep `applyAt` tick. Everything else — AI decisions, modifier rolls, grunt spawns, castle wall plans, bonus square placement — every peer mirror-simulates locally from synced `state.rng` using the same engine functions. The server is a pure relay with anti-cheat validation; it does not run game logic.

```
Host ──WebSocket──> Server (relay) ──WebSocket──> Players / Watchers
                         ↑                              │
                         └──────────────────────────────┘
                              (player actions)
```

### Key Principles
- **Deterministic from seed**: all clients derive the map, towers, zones, and houses from the seed. The `init` message only carries the seed + settings — no map data.
- **Bare-marker phase checkpoints**: `cannonStart`, `battleStart`, `buildStart`, `buildEnd` carry no payload, and receivers IGNORE them on the wire. Under clone-everywhere every peer dispatches the matching transition — and runs its engine fn (`enterCannonPhase`, `prepareBattle`, `finalizeBattle` + `prepareNextRound`, `finalizeRound`) — from its own local tick, so host and watcher derive byte-identical state from synced RNG without the marker driving anything. The marker is a host liveness / trace signal only. The one payload-bearing wire snapshot of RNG state is `fullState`, used during host-migration / late-join recovery.
- **Events during phases**: incremental updates (piece placed, cannon fired, wall destroyed) streamed in real-time.
- **Lockstep apply scheduling**: every state-mutating originator-driven message (`opponentPiecePlaced`, `opponentCannonPlaced`, `opponentTowerSelected` confirmed, `opponentCannonPhaseDone`, `cannonFired`) carries `applyAt = senderSimTick + SAFETY`. Both originator and receiver enqueue the apply for that tick; the queue drains at the top of each sim tick keyed off the shared `state.simTick` counter, so mutations and their RNG-consuming cascades fire at the same logical tick across peers — closing within-phase divergences (recheckTerritory grunt-respawn drift, AI cannon-fire grunt-spawn drift, castle-wall clumsy-builder drift) that wire delay would otherwise open.
- **Local AI on every peer**: AI selections, castle wall plans, modifier tiles, bonus square placement, and grunt spawns all advance from `state.rng`. Watchers run the same code paths as host — no wire payload needed for any of these.
- **Local execution**: build and cannon phases run locally on each client for zero-latency input. The host's local controllers broadcast their actions as incremental events; the watcher derives everything else from local engine fns.
- **Precompute over per-fire RNG**: AI decisions and modifier effects whose RNG consumption can't be aligned to a deterministic state-mutation point are precomputed at battle-start and indexed by a lockstep counter at use time. Current users: `precomputedUpgradePicks` (drawn at battle-done, indexed by playerId at upgrade lock-in tick) and `precomputedDustStormJitters` (drawn at `prepareBattleState`, indexed by `state.shotsFired` at fire time). Both serialized in `fullState` for late-joiners.

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

All four phase-marker checkpoints (`cannonStart`, `battleStart`, `buildStart`, `buildEnd`) carry only `{ type }` and are ignored on receipt — each peer runs the matching engine fn from its own local tick (deriving every mutation from synced state + RNG), so the marker drives nothing. `init`, `selectStart`, and `gameOver` carry bootstrap / phase-entry / terminal-frame payloads but no derived game state.

| Message | When | Payload | Watcher action |
|---------|------|---------|----------------|
| `init` | Game start | `seed`, `playerCount`, `settings` (`maxRounds`, `cannonMaxHp`, `buildTimer`, `cannonPlaceTimer`, `firstRoundCannons`, `gameMode`) | Bootstrap from seed |
| `selectStart` | Tower selection begins (initial + reselect) | `timer` | `enterSelectionPhase` (cycle type derived from `state.round` + the `pids` queue: omitted = initial cycle, life-losers' ids = reselect) |
| `cannonStart` | CASTLE_SELECT / WALL_BUILD → CANNON_PLACE | _none_ | Source-phase prefix (`finalizeRoundCleanup` for `round > 1` / `finalizeFreshCastles` / `finalizeCastleConstruction`) + `enterCannonPhase` |
| `battleStart` | CANNON_PLACE → BATTLE | _none_ | `prepareBattle` (modifier roll, balloon resolution, grunt wall-attack flags, combo tracker) — RNG already synced from prior wire history |
| `buildStart` | BATTLE → WALL_BUILD | _none_ | `finalizeBattle` + `prepareNextRound` (combo bonuses, battle cleanup, grunt spawn, upgrade offers, modifier rotation, round increment, piece bag init) |
| `buildEnd` | End of build phase / round-end barrier | _none_ | `finalizeRound` (territory finalize, life penalties, score, `ROUND_END` emit) |
| `gameOver` | Game ends | `winner`, `scores[]` | Render terminal frame |

**Drift detection**: there is no in-band drift check on the normal path — peers stay synced by mirror-simulating from the same `state.rng` seed and applying every cross-peer mutation at a lockstep `applyAt` tick. Determinism tests (`npm run test:determinism`) assert byte-for-byte event-log parity across replays. If a watcher desyncs in production it stays desynced until the next `fullState` (host migration / reconnect).

#### Serialized Shapes

The `SerializedPlayer` / `SerializedHouse` / `SerializedGrunt` / `SerializedBonusSquare` / `SerializedBurningPit` types in `src/protocol/checkpoint-data.ts` are used **only** by `fullState` (host migration / late-join recovery — see [Host Migration](#host-migration)). Phase-marker checkpoints carry no payload, so they don't reference these shapes.

`interior` and `enclosedTowers` are always recomputed from `walls` on the receiver (flood-fill + tower enclosure check) — they're never serialized.

### Host → All (Incremental Events)

Streamed during gameplay phases. The 12 battle impact events (`wallDestroyed`, `wallAbsorbed`, `wallShielded`, `cannonDamaged`, `cannonShielded`, `houseDestroyed`, `gruntKilled`, `gruntChipped`, `gruntSpawned`, `pitCreated`, `iceThawed`, `towerKilled`) are **host-only** — server rejects them from any other socket.

Messages marked **(lockstep)** carry an `applyAt` field — see [Lockstep Apply Scheduling](#lockstep-apply-scheduling) below. The originator stamps `applyAt = state.simTick + SAFETY` and enqueues a local apply for that tick; receivers enqueue for the same tick. Validation runs inside the apply closure (not at receive time) so it sees cross-peer-identical state.

| Message | Phase | Description |
|---------|-------|-------------|
| `opponentPiecePlaced` | WALL_BUILD | **(lockstep)** AI/remote player placed a wall piece. `applyPiecePlacement` + the RNG-consuming `recheckTerritory` cascade fire at the same simTick on every peer. |
| `opponentPhantom` | WALL_BUILD | Ghost piece position (cursor preview) — cosmetic, no `applyAt` |
| `opponentCannonPlaced` | CANNON_PLACE | **(lockstep)** **Human** player placed a cannon. Originator reserves the slot via `state.pendingCannonSlotCost` so its AI strategy doesn't double-spend during the SAFETY window. AI placements derived locally on every peer — never sent over the wire. |
| `opponentCannonPhantom` | CANNON_PLACE | Ghost cannon position — cosmetic, no `applyAt` |
| `opponentCannonPhaseDone` | CANNON_PLACE | **(lockstep)** **Human** player finished placing cannons. Schedules `state.cannonPlaceDone.add(playerId)` for `applyAt` so the phase-exit predicate (`allCannonPlaceDone`) flips at identical sim ticks across peers. Originator marks via transient `state.pendingCannonPlaceDone` so the detect loop doesn't re-broadcast in the SAFETY window. AI controllers don't broadcast (clone-everywhere, lockstep already). |
| `opponentTowerSelected` | SELECTION | **(lockstep when confirmed)** **Human** player browsing/confirming tower. Highlight-only messages (`confirmed: false`) are immediate; confirmation messages (`confirmed: true`) carry `applyAt` so castle-wall RNG consumption (`prepareCastleWallsForPlayer` — clumsy builders + ring ordering) fires at the same simTick on every peer. AI selections derived locally on every peer from synced `strategy.rng` — never sent over the wire. |
| `cannonFired` | BATTLE | **(lockstep)** A cannon fired a cannonball. Carries the originator-pinned `BallisticTrajectory` (including `scoringPlayerId` for captured-cannon credit) so receivers spawn an identical parametric flight. The ball-push, `state.shotsFired++`, and bus emit fire at `applyAt`. Originator tracks pending fires in `state.pendingCannonFires` so its AI doesn't double-fire during the SAFETY window. `applyAt` is optional in the type — wire sends always set it, local-only emits (bus replay, host fanout) leave it undefined. |
| `wallDestroyed` | BATTLE | A wall tile was destroyed (host-only) |
| `wallAbsorbed` | BATTLE | Reinforced wall absorbed a hit — wall survives marked `damagedWalls` (host-only) |
| `wallShielded` | BATTLE | Rampart shielded an adjacent wall — wall survives, rampart loses 1 shield HP (host-only) |
| `cannonDamaged` | BATTLE | A cannon took damage (host-only) |
| `cannonShielded` | BATTLE | Shield-Battery cannon absorbed a direct impact — cosmetic, HP unchanged (host-only) |
| `houseDestroyed` | BATTLE | A house was destroyed (host-only) |
| `gruntKilled` | BATTLE | A grunt was killed (host-only) |
| `gruntChipped` | BATTLE | Frosted grunt absorbed first hit (ice chip) — survives marked `grunt.chipped` (host-only) |
| `gruntSpawned` | BATTLE | A grunt was spawned (host-only) |
| `pitCreated` | BATTLE | Burning pit from incendiary shot (host-only) |
| `iceThawed` | BATTLE | Frozen water tile thawed by cannonball (host-only) |
| `towerKilled` | BATTLE | A tower was destroyed by grunts (host-only) |
| `aimUpdate` | BATTLE | Crosshair position |
| `lifeLostChoice` | LIFE_LOST | Human player picked continue/abandon. Applied on every peer (host AND watcher) — fills `entry.choice` in the life-lost dialog. AI controllers fill `entry.choice` deterministically via `tickLifeLost` (decision/commit split: `plannedChoice` cached separately from `choice`), so a wire-arrived choice on the watcher is idempotent against the locally-computed one. |
| `upgradePick` | UPGRADE_PICK | Human player picked an upgrade. Applied on every peer (host AND watcher) — fills `entry.choice` in the upgrade-pick dialog. AI controllers fill `entry.choice` deterministically via `tickAiUpgradePickEntry` (same decision/commit split). |

#### Battle Event Unions

The battle impact messages are grouped into type aliases in `src/shared/core/battle-events.ts` for type-safe handling:

- **`ImpactEvent`** = `wallDestroyed` | `wallAbsorbed` | `wallShielded` | `cannonDamaged` | `cannonShielded` | `houseDestroyed` | `gruntKilled` | `gruntChipped` | `gruntSpawned` | `pitCreated` | `iceThawed` — host-only effects from cannonball impacts and secondary consequences.
- **`BattleEvent`** = `cannonFired` | `towerKilled` | `shipHit` | `shipSunk` | `ImpactEvent` — every event emitted on the in-battle bus. Discriminated on `type`. Note: `shipHit` and `shipSunk` are local-only (no `networkRelay` in `BATTLE_EVENT_CONSUMERS`) — supply-ship positions and HP are mirror-simulated on every peer, so the events fire on each peer's bus from `tryHitSupplyShip` and are observed by sound/haptics only.

## Lockstep Apply Scheduling

Every state-mutating wire message (the originator-driven ones — `cannonFired`, `opponentPiecePlaced`, `opponentCannonPlaced`, `opponentTowerSelected`, `opponentCannonPhaseDone`) carries an **`applyAt: number`** field stamping the sim tick at which both originator and receiver mutate state. The originator computes `applyAt = state.simTick + DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS` (8) and enqueues a local apply for that tick; the wire carries the same `applyAt`; the receiver enqueues for the same tick. The shared `state.simTick` counter advances once per fixed sim tick on every peer, and the action queue drains at the top of each tick — so the apply closure fires identically across peers.

Why: the receiver picks up the message ~wireDelay ticks late. Without `applyAt`, the originator would mutate at simTick=N while the receiver mutates at simTick=N+wireDelay — opening a window where peers' `state.rng`, `cannonPlaceDone` set, etc. diverge. Anything that consumes those mid-window (per-tick rng draws, phase-exit predicates) drifts state. With `applyAt`, both peers apply at the same logical tick → SAFETY window stays state-quiet across peers.

The `lint:applyat` script (`scripts/lint-applyat.ts`) statically asserts that every `applyAt` reference inside `online-server-events.ts` originates from `msg.applyAt` (object-literal field, variable-decl initializer, or destructure from `msg`) — locally-stamped values on the receiver path would defeat the lockstep guarantee.

**Per-fire RNG draws (e.g. dust-storm jitter)** also need to stay rng-quiet across the SAFETY window. The pattern: precompute a buffer at `prepareBattleState` (right after `rollModifier`) on every peer, store on `ModernState` (e.g. `precomputedDustStormJitters: readonly number[]`), and index by a lockstep counter (`state.shotsFired`, bumped at apply on every peer) at fire time. Both peers populate from the same `state.rng` prefix at the same simTick → identical buffers → no per-fire rng draws → no SAFETY-window drift. See `docs/adding-modifiers-and-upgrades.md` § "Per-fire RNG draws" for the full pattern.

The same precompute idea covers any AI decision drawn from `state.rng` whose lock-in tick differs across peers — e.g. `precomputedUpgradePicks` (drawn at battle-done, consumed when the upgrade dialog locks in).

## Game Phases

```
Round 1: CASTLE_SELECT ──> CANNON_PLACE ──> BATTLE ──> WALL_BUILD ──┐
                                                                     │
Round N≥2:                  CANNON_PLACE ──> BATTLE ──> WALL_BUILD ──┤
                                  ↑                                  │
                                  └─ (no life lost) ─────────────────┤
                                                                     │
                            CASTLE_SELECT (reselect, life lost) ─────┘
```

Round 1 is special: CASTLE_SELECT auto-builds the initial castle walls inline, then flows into CANNON_PLACE (no opening WALL_BUILD). Round N≥2 normally loops CANNON_PLACE → BATTLE → WALL_BUILD; when a player loses lives at end-of-WALL_BUILD, the next round re-enters CASTLE_SELECT (reselect cycle, same phase tag) for the eliminated towers. Cycle type is derived from `state.round` (1 vs >1) and the `pids` queue passed to `enterSelectionPhase` (omitted = initial cycle for every slot; the life-losers' ids = reselect cycle), not a separate phase value. Per-player castle grace is tracked via `player.inGracePeriod`. Castle wall construction is animated inline during `CASTLE_SELECT` — every peer derives wall plans locally via `prepareCastleWallsForPlayer` (consumes `state.rng` for clumsy builders + ring ordering) on each tower confirmation. No separate `CASTLE_BUILD` phase, no `castleWalls` wire message.

**Modern mode** adds two conditional phases (both gated by `hasFeature`):
- **MODIFIER_REVEAL** between CANNON_PLACE and BATTLE — entered only when a modifier rolled during `prepareBattleState`. 2s banner + dwell, then BATTLE.
- **UPGRADE_PICK** between BATTLE and WALL_BUILD — entered from round 3 when upgrade offers are present. Upgrade offers are generated locally on every peer inside `prepareNextRound` (synced RNG); players respond with `upgradePick` messages which the host applies and re-broadcasts.

Each transition is marked by a bare-marker checkpoint from the host, which receivers ignore — every peer runs the matching engine fn from its own local tick and renders incremental events until the next checkpoint. The marker is a liveness / trace signal, not a state driver.

## Host Migration

When the host disconnects mid-game, the server promotes another player (lowest slot ID) or falls back to any connected socket.

| Message | Sender | Description |
|---------|--------|-------------|
| `hostLeft` | Server → All | `newHostPlayerId`, `disconnectedPlayerId`. `null` if no human available (watcher fallback). |
| `fullState` | New Host → All | Comprehensive snapshot sent after promotion for peer reconciliation. Includes `migrationSeq?`, `phase`, `round`, `timer`, `battleCountdown`, `maxRounds`, `shotsFired`, `rngState`, `simTick`, `players[]`, `grunts[]`, `gruntSpawnSeq`, `gruntSpawnUsedTiles?`, `houses[]`, `bonusSquares[]`, `towerAlive[]`, `burningPits[]`, `cannonLimits[]`, `cannonPlaceDone[]`, `salvageSlots?`, `playerZones[]`, `gameMode`, `activeModifier`, `activeModifierChangedTiles[]`, `lastModifierId`, `pendingUpgradeOffers?`, `precomputedDustStormJitters?`, `masterBuilderLockout?`, `masterBuilderOwners?`, `comboTracker?`, modifier-tile sets (`frozenTiles`, `sinkholeTiles`, `exposedRiverbedTiles` — all `number[] \| null`, via `extends SerializedModifierTiles`), `rubbleClearingHeld?`, `supplyShips?`, `pendingSupplyBonuses?`, `towerPendingRevive[]`, `capturedCannons[]`, `cannonballs[]` (with `x`/`y`/`elapsed`/`altitude` cursor), `balloonFlights?`. **Not serialized** (mirror-simulated cross-peer): `interior`, `enclosedTowers`, `pendingCannonFires`, `pendingCannonSlotCost`, `pendingCannonPlaceDone`, and `highTideTiles` (recomputed via `computeFloodedTiles`). The full shape lives in `FullStateMessage` in `src/protocol/protocol.ts` — the lint script `scripts/lint-checkpoint-fields.ts` enforces that every `GameState`/`ModernState` field is either referenced in `online-serialize.ts` or carries a documented exclusion reason, so additions can't silently drift. |

## Anti-Cheat (Server-Side)

The relay server validates without running game logic:

- **Host-only enforcement**: only the host socket can send checkpoints (`init`, `selectStart`, `cannonStart`, `battleStart`, `buildStart`, `buildEnd`, `gameOver`, `fullState`) and the 12 battle impact events (`wallDestroyed`, `wallAbsorbed`, `wallShielded`, `cannonDamaged`, `cannonShielded`, `houseDestroyed`, `gruntKilled`, `gruntChipped`, `gruntSpawned`, `pitCreated`, `iceThawed`, `towerKilled`). The seed array satisfies `readonly MessageType[]`, so a renamed/removed `MESSAGE` entry is a compile error in `server/game-room.ts`.
- **Identity**: players can only send messages with their own `playerId` (host exempt — sends on behalf of AI players)
- **Phase gating**: `cannonFired` and `aimUpdate` rejected outside BATTLE; `opponentPiecePlaced` and `opponentPhantom` rejected outside WALL_BUILD; `opponentCannonPlaced`, `opponentCannonPhantom`, and `opponentCannonPhaseDone` rejected outside CANNON_PLACE; `opponentTowerSelected` rejected outside CASTLE_SELECT
- **Rate limiting**: cosmetic messages (`opponentPhantom`, `opponentCannonPhantom`, `aimUpdate`) capped at 100/s per socket per message type. Game-state messages (`opponentPiecePlaced`, `opponentCannonPlaced`, `cannonFired`, `opponentTowerSelected`, `lifeLostChoice`, `upgradePick`) are **not** rate-limited — they are low-frequency and must never be silently dropped
- **Payload validation**: bounds-checking on `playerId`, grid coordinates, pixel coordinates, cannon modes, piece offsets, tower index, and choice values

## Bandwidth

Per watcher, ~1 KB/s average. 100 rooms × 3 players ≈ 3 Mbps combined. Dominant message type is `opponentPhantom` (ghost piece positions during build phase).

## Watcher Rendering

Watchers receive the same messages as players. They:
1. Run the same engine fn locally at each phase-marker checkpoint (`enterCannonPhase`, `prepareBattle`, `prepareNextRound`, `finalizeRound`, etc.) — derive every state mutation from synced RNG instead of reading wire payloads
2. Apply incremental events (piece placed, cannon placed, cannon fired, wall destroyed, etc.) as they arrive — state-mutating messages enqueue at the lockstep `applyAt` tick; cosmetic ones (phantoms, aim) apply immediately
3. Interpolate crosshair positions from `aimUpdate` messages
4. Tick grunts locally (deterministic movement from shared state)
5. Use sim-time accumulators with the mock clock in tests, wall-clock timers in production (immune to RAF throttling when tab is backgrounded)

Late-joining watchers (mid-game) and post-host-migration watchers receive `fullState` instead, which carries the complete serialized state.
