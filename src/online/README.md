# `src/online/` — Multiplayer networking + host migration

The **online** domain implements multiplayer: WebSocket session
management, wire protocol serialization, host-authoritative game flow,
checkpoint-based watcher sync, and host migration when the current host
disconnects. This is the most structurally complex domain in the
project — not because any individual file is hard, but because the
model has three concurrent concerns that cross every file:

1. **Who is this machine?** Host? Watcher? Which slot?
2. **What phase are we in?** Checkpoint vs. tick vs. message-driven.
3. **What's the local vs. remote split?** Which players run AI locally,
   which are driven by peer machines?

If you hold those three in mind, the file structure makes sense.

## The multiplayer model

- **Host-authoritative.** Exactly one client is the host at any time.
  The host runs the canonical simulation; every other client is a
  **watcher** that replays the host's state via checkpoints and
  per-frame tick messages.
- **No client-side prediction, no rollback.** Watchers don't simulate
  independently; they apply host state. This is the correct tradeoff
  for Rampart (phase-based, not twitchy) and keeps the model simple.
- **Host migration is first-class.** If the host disconnects,
  another client is promoted via `HOST_MIGRATION` and rebuilds
  its controllers as if it had been host all along. `isHost` is
  **volatile** — it can flip mid-session — and must always be read
  through `isHostInContext()` from `runtime-tick-context.ts`, never cached.
- **Phase transitions go through checkpoints.** When the host enters
  a new phase, it broadcasts a full checkpoint
  (`BUILD_START` / `CANNON_START` / `BATTLE_START` / `BUILD_END`).
  Watchers apply the checkpoint, replacing their subsystem state.
  Between checkpoints, watchers tick from per-frame messages
  (piece placements, cannon fires, impact events).

## Read these first (in order)

1. **[online-session.ts](./online-session.ts)** — `OnlineSession`
   state: socket, isHost, myPlayerId, occupiedSlots,
   remotePlayerSlots, room config. This is the "who am I" bag.

2. **[online-types.ts](./online-types.ts)** — Public interfaces for
   the online layer, including `WatcherState`, `OnlineContext`, dedup
   channel types, and `toCannonMode()` string parsing.

3. **[online-runtime-game.ts](./online-runtime-game.ts)** — Top-level
   wiring for the online client. This is the online equivalent of
   `src/main.ts`: it creates renderer/timing/network, wires everything
   through `createGameRuntime()` from `runtime-composition.ts`, and
   sets up the `onlinePhaseTicks` bag that passes networking callbacks
   into the per-frame game loop.

4. **[online-stores.ts](./online-stores.ts)** — `createOnlineClient()`
   builds an isolated client instance (session + dedup + watcher +
   reconnect). `defaultClient` is a module-level singleton — the
   entry point uses it, tests build their own via
   `test/online-headless.ts`.

5. **[online-phase-transitions.ts](./online-phase-transitions.ts)** —
   The host-side recipes for each phase transition. Emits checkpoints,
   triggers banners, sets modes. Mirrors the local-side
   `phase-setup.ts` but with broadcast hooks.

## File categories

### Session state + types (3 files)
- **`online-session.ts`** — `OnlineSession`, `DedupMaps`,
  `createSession()`, `resetSessionState()`, keepalive.
- **`online-types.ts`** — `OnlineContext`, `WatcherState`, dedup
  channel types, remote player lookup helpers.
- **`online-config.ts`** — Room config constants (cap limits, default
  timers). Zero imports.

### Client factory / composition (4 files)
- **`online-stores.ts`** — `createOnlineClient()` factory +
  `defaultClient` singleton. Every client has its own session, dedup,
  watcher, reconnect state. Tests build isolated clients via
  `test/online-headless.ts`.
- **`online-runtime-game.ts`** — Top-level online client wiring.
  Creates runtime via `createGameRuntime(config)` with the
  `onlinePhaseTicks` + `onlineActions` bags filled in.
- **`online-runtime-deps.ts`** — `initDeps()` — builds the deps bags
  consumed by server-lifecycle and server-events, and contains the
  server message dispatcher `handleServerMessage()`.
- **`online-runtime-ws.ts`** — `initWs()` — WebSocket connection
  lifecycle, reconnect logic. Decoupled from game runtime via
  dependency injection to avoid init-order coupling.

### Server message handling (3 files)
- **`online-server-events.ts`** — `handleServerIncrementalMessage()` —
  per-frame action / aim / phantom messages (tower-selected, piece-
  placed, cannon-placed, cannon-fired, aim-update, life-lost-choice,
  upgrade-pick, etc.). Validates + applies to local state. Host-only
  legality checks gate via `isHostInContext`.
- **`online-server-lifecycle.ts`** — `handleServerLifecycleMessage()`
  — lifecycle messages (ROOM_CREATED / ROOM_JOINED, JOINED, INIT,
  SELECT_START, HOST_LEFT, FULL_STATE, GAME_OVER, etc.). Mutates
  session slot state atomically (clearLobbySlot / occupyLobbySlot).
  Phase-marker messages (CANNON_START / BATTLE_START / BUILD_START /
  BUILD_END) are acknowledged but ignored — every peer dispatches
  the matching transition locally from its own tick (clone-everywhere).
- **`online-phase-transitions.ts`** — `handleGameOverTransition()` —
  the one wire-driven transition. GAME_OVER carries the host's
  authoritative scores, used to paint the terminal frame on watchers.

### Outgoing actions + crosshairs (2 files)
- **`online-send-actions.ts`** — `createOnlineSendActions()` —
  `tryPlacePiece`, `tryPlaceCannon`, `fire` — action wrappers that
  apply locally THEN broadcast the event. Used by the local controller
  path.
- **`online-host-crosshairs.ts`** — `broadcastLocalCrosshair` (deduped
  aim-update fan-out for the local human / AI) +
  `extendWithRemoteCrosshairs` (merges remote-human crosshair targets
  into the frame via linear interpolation). Both host and watcher
  render remote crosshairs the same way.

### Host migration (2 files)
- **`online-host-promotion.ts`** — Helpers for controller rebuild +
  accumulator sync when this client gets promoted. Called from
  `online-runtime-promote.ts`.
- **`online-runtime-promote.ts`** — `initPromote()` + `promoteToHost()`
  — orchestration around `online-host-promotion.ts`. Resets networking,
  rebuilds controllers, broadcasts FULL_STATE. Called when `HOST_LEFT`
  arrives and this client is the new host.

### Serialization (1 file)
- **`online-serialize.ts`** — `createFullStateMessage` /
  `restoreFullStateSnapshot` (host-migration / late-join recovery) plus
  the bare-marker phase-checkpoint factories
  (`createBuildStartMessage`, `createCannonStartMessage`,
  `createBattleStartMessage`, `BUILD_END`) and `createGameOverPayload`.
  Phase-marker checkpoints carry no game state — watchers derive
  everything locally. **Exhaustiveness is NOT automatic** —
  `lint-checkpoint-fields.ts` verifies every GameState field is
  referenced at least once in the full-state payload, so drift becomes
  a lint failure.

### Runtime helpers (2 files)
- **`online-runtime-session.ts`** — `createOnlineRuntimeSessionHelpers()`
  — session reset, show-lobby, show-waiting-room, init-from-server,
  restore-full-state.
- **`online-runtime-lobby.ts`** — Online lobby DOM bootstrap + init.
  Exports `lobbyReady` — the single public API consumed by `entry.ts`.

### Presence + UI + plumbing (4 files)
- **`online-presence-state.ts`** — `OnlinePresenceState` (remote
  crosshair targets + smoothed visual positions + host-migration
  banner). Held by every peer; reset fully on new game, partial reset
  on host promotion.
- **`online-lobby-ui.ts`** — Online-specific lobby UI rendering.
- **`online-router.ts`** — Hash-route dispatcher (`navigateTo`,
  `onRoute`) + `GAME_EXIT_EVENT` constant.
- **`online-dom.ts`** — Centralized `getElementById` for all DOM
  elements the online client reads. One file = one boundary for all
  DOM access in online/.

## The volatile host flag — the #1 footgun

`session.isHost` can flip from `false` to `true` during host migration.
**Never cache it across ticks, awaits, or phase transitions.** Always
read fresh via `isHostInContext(session)` from
`runtime/runtime-tick-context.ts`. This is enforced by a custom ESLint rule
(`no-restricted-syntax` → `MemberExpression[property.name='isHost']`)
— direct `.isHost` access is banned outside a small allowlist (session
init, reset, promotion). If you genuinely need to write it, use
`// eslint-disable-next-line no-restricted-syntax -- reason`.

Same rule: when ticking, always read `amHost()` from the `NetworkApi`
seam, not from stored session state.

## The dedup channels — the #2 footgun

Some messages fan out at 60 Hz (aim-target updates, piece phantoms,
cannon phantoms). The server does not need every frame's worth of
these; only changes. `DedupChannel.shouldSend(playerId, key)` tracks
the last-sent value per player and returns `false` if the same value
is repeated. Use the helper, don't reinvent it. The channels are:

- `dedup.aimTarget` — per-player aim direction
- `dedup.cannonPhantom` — per-player cannon placement preview
- `dedup.piecePhantom` — per-player piece placement preview

Reset via `resetDedupMaps()` on session reset and host promotion —
stale entries after a promotion will suppress legitimate sends.

## Common operations

### Add a new server message type
1. Add the interface to `src/protocol/protocol.ts` + the `MESSAGE.*`
   constant.
2. Add to the `ServerMessage` union in the same file.
3. Add a handler in `online-runtime-deps.ts` `handleServerMessage()`
   (or the appropriate delegate in `online-server-lifecycle.ts` /
   `online-server-events.ts`).
4. If it's a lifecycle event that affects session slot state, add
   the mutation inside the clearLobbySlot/occupyLobbySlot helpers —
   never mutate one slot field without the other.

### Add a new phase transition
The clone-everywhere model means every peer dispatches phase
transitions from its own tick — there is no separate watcher apply
path. Touch `phase-setup.ts` (local-side phase entry) and, if the
host needs to broadcast a marker, add a factory in
`online-serialize.ts` and wire it into the `broadcastXxx` callbacks
in `online-runtime-game.ts:onlinePhaseTicks`. Watchers get the marker
via `online-server-lifecycle.ts` and just acknowledge — their own
local tick has already advanced state.

### Add a new dedup channel
Add the key to `DedupMaps` in `online-session.ts`, initialize in
`createDedupMaps()`, reset in `resetDedupMaps()`. Use
`shouldSend(id, key)` at every send site.

### Debug a "local works, online doesn't" issue
Run `npm run test:network-vs-local` — boots a host-mode headless
runtime and a watcher fed only by host-broadcast wire messages, and
asserts the watcher's bus event log matches the host's. Any
divergence is almost always a missed checkpoint field, a missing
serialize path, or an event that mutates state differently on host
vs. watcher. The test gives you a precise first-divergence frame
count and runs across multiple seeds in classic + modern mode.

### Write a test that injects peer messages
Use `test/online-headless.ts` — `createOnlineHarness()` builds a
headless runtime wired through the REAL `handleServerMessage`
dispatcher, and exposes `deliverMessage(msg)` to inject peer messages.
The runtime treats the specified slots as remote; local AI is disabled
for them so tests can drive them via injected messages.

## Gotchas

- **The test's session is NOT the runtime's network adapter.** When
  you write online tests, remember that `runtime.network.send()`
  goes to a fake observer, not to the real WebSocket. The test's
  session is a *separate* OnlineSession that the dispatcher reads
  for `isRemoteHumanAction` checks. Don't try to unify them — they
  serve different purposes in the test.

- **Full state recovery is for late joiners, not reconnects.** When
  a watcher joins mid-game, it needs the FULL_STATE message to
  bootstrap from the current phase. Reconnects after a brief
  disconnect are handled differently — they re-run `initFromServer`
  and replay the lifecycle sequence.

- **Phase markers are bare triggers.** `BUILD_START` / `BUILD_END` /
  `CANNON_START` / `BATTLE_START` all carry no payload — every peer
  runs the matching engine fn (`enterBuildPhase` / `finalizeBuildPhase` /
  source-prefix + `enterCannonPhase` / `enterBattlePhase`) locally
  from its own tick. The clone-everywhere model means RNG advances
  in lockstep across peers, so no resync payload is needed. The wire
  marker only exists so a watcher can acknowledge receipt and stay
  off the unhandled-message log; the lifecycle dispatcher returns
  `true` and does nothing.

- **`ctx.session` vs `ctx` are different bags.** Some callbacks take
  `session: Pick<OnlineSession, ...>`, some take the full
  `OnlineContext` (session + dedup + presence + reconnect). Read the
  callback's type precisely.

- **`online-runtime-game.ts` uses `defaultClient`, tests use a fresh
  one.** Do not reuse `defaultClient` across tests — `initDeps`
  re-assigns module-level state on each call, and test isolation
  matters. `test/online-headless.ts` builds a fresh
  `createOnlineClient()` for each scenario.

- **`online-dom.ts` is the ONLY file in this folder allowed to call
  `document.getElementById`.** Centralized DOM access is why we can
  shim the DOM in tests (see `test/online-dom-shim.ts`).

- **AI players can be "remote"** — in the online model, a slot
  controlled by another machine's AI is still "remote" from this
  machine's perspective, because the simulation lives on that other
  machine. `remotePlayerSlots` is "not me", not "not human."

## Related reading

- **[docs/protocol.md](../../docs/protocol.md)** — Wire protocol
  reference: message types, checkpoint shapes, serialization details.
- **[src/protocol/](../protocol/)** — Wire protocol types
  (`protocol.ts`), checkpoint data (`checkpoint-data.ts`), routes
  (`routes.ts`).
- **[src/shared/core/phantom-types.ts](../shared/core/phantom-types.ts)** —
  `DedupChannel` definition (the `shouldSend` primitive).
- **[src/runtime/runtime-tick-context.ts](../runtime/runtime-tick-context.ts)** —
  `isHostInContext`, `isRemotePlayer`, `tickPersistentAnnouncement`.
- **[test/online-headless.ts](../../test/online-headless.ts)** — Test
  harness that builds an isolated online client backed by the real
  dispatcher. Good reference for how the bootstrap sequence works.
- **[scripts/lint-checkpoint-fields.ts](../../scripts/lint-checkpoint-fields.ts)**
  — Verifies every GameState field appears in `online-serialize.ts`.
  This is what catches "forgot to serialize X" bugs.
- **[test/network-vs-local.test.ts](../../test/network-vs-local.test.ts)**
  — Host-vs-watcher parity gate (`npm run test:network-vs-local`).
