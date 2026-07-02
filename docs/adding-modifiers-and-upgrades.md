# Adding Modifiers & Upgrades

Agent-facing guide for implementing new environmental modifiers and player
upgrades. Both use the pool pattern with compile-time exhaustiveness checks
and registry-driven dispatch.

## Modifiers (environmental round effects)

Modifiers fire once per battle start in modern mode (round 3+, 65% chance).
They range from tile mutations (sinkhole) to entity effects (grunt surge,
supply ship) to passive overlays (frozen river, dust storm, high tide,
low water — the last two track/derive their tile sets without mutating
`map.tiles`).

### Files to touch

| Step | File | What to do |
|------|------|------------|
| 1 | `src/shared/core/game-constants.ts` | Add string literal to `ModifierId` union + `MODIFIER_ID` map |
| 2 | `src/shared/core/modifier-defs.ts` | Add pool entry (`weight`, `needsCheckpoint`) + `MODIFIER_CONSUMERS` entry |
| 3 | `src/game/modifiers/<name>.ts` | Create modifier file exporting a `ModifierImpl` object |
| 4 | `src/game/modifier-system.ts` | Import the impl and add entry to `MODIFIER_IMPLS` |
| 5 | `src/render/render-ui.ts` | Add banner color entry to `MODIFIER_COLORS` |
| 6 | `.import-layers.json` + `.import-cells.json` | Regenerate — `deno run -A scripts/generate-import-layers.ts` then `deno run -A scripts/cells/regen-cells.ts` (never hand-assign) |
| 7 | *(if tile-mutating)* `src/shared/core/types.ts` | Add `fooTiles: Set<TileKey> \| null` to `ModernState` + initial `null` in `createModernState()` |
| 8 | *(if tile-mutating)* `src/online/online-serialize.ts` + `src/shared/core/modifier-defs.ts` | Add the field to `SerializedModifierTiles` (modifier-defs.ts) and emit it in `serializeModifierTileSets()` — spread into every checkpoint via `serializeModernFields()` |

Behavior outside the impl file (a battle-system tick, a grunt-system
attack rule) and cosmetic consumers (a `src/render/3d/effects/` burst, a
`src/runtime/modifier-effects/` reveal-overlay deriver, an
`src/ai/` strategy branch) are per-modifier extras — add them where
needed and list every such file in your `MODIFIER_CONSUMERS` entry (the
role-name conventions are documented above the map in modifier-defs.ts).

### Files you do NOT touch

- **`phase-setup.ts`** — dispatch, clear, and zone-reset are registry-driven
  via `MODIFIER_IMPLS_BY_ID` (exported by `modifier-system.ts`). The generic
  `applyBattleStartModifiers()` (phase-setup.ts) plus `clearActiveModifiers()`
  and `clearActiveInstantModifier()` (modifier-system.ts) handle apply/clear
  automatically. Zone teardown after a life loss is also generic:
  `resetZoneState()` → `restoreZoneGrass()` forces the zone's tiles back to
  grass and prunes `sinkholeTiles` — no per-modifier hook.

### Per-modifier file layout

Each modifier lives in its own file under `src/game/modifiers/`, exporting a
`ModifierImpl` object. This mirrors the `src/game/upgrades/` layout. The
`ModifierImpl` discriminated union lives in `src/shared/core/types.ts`; the
`SerializedModifierTiles` wire shape lives in `src/shared/core/modifier-defs.ts`.

```
src/game/
  modifier-system.ts      — MODIFIER_IMPLS registry, rollModifier, checkpoint orchestration
  modifiers/
    fire.ts                 — wildfire + dry_lightning impls (shared burn predicate + scar applicator)
    grunt-surge.ts
    frozen-river.ts
    sinkhole.ts
    high-tide.ts
    dust-storm.ts           — impl + applyDustStormJitter
    rubble-clearing.ts
    low-water.ts
    fog-of-war.ts
    frostbite.ts
    sapper.ts
    supply-ship.ts
    evict-tiles.ts          — shared eviction helper (sinkhole/high-tide/low-water converge here)
    modifier-eligibility.ts — fresh-castle (grace-period) protection helpers for modifier targeting
```

### ModifierImpl interface

`ModifierImpl` (in `src/shared/core/types.ts`) is a discriminated union of
three variants, tagged by the `lifecycle` field. Pick the variant that
matches your modifier; the type checker enforces that the right hooks are
present.

| Lifecycle | Active for | Required hooks | Optional hooks | Examples |
|-----------|------------|----------------|----------------|----------|
| `"instant"` | apply at battle-start; any battle-only state drops at BATTLE_END | `apply` | `clear` (fires at BATTLE_END), `skipsRecheck`, `resolutionLog` | wildfire, dry_lightning, rubble_clearing, grunt_surge, dust_storm, fog_of_war, frostbite, sapper, supply_ship |
| `"permanent"` | forever (or until zone reset) | `apply`, `restore` | `skipsRecheck`, `resolutionLog` | sinkhole |
| `"round-scoped"` | this round's BATTLE → next CANNON_PLACE-done | `apply`, `clear` | `restore`, `skipsRecheck`, `resolutionLog` | frozen_river, high_tide, low_water |

Pick the lifecycle by asking: does my effect leave any state behind that
needs to be reverted? If no (or only battle-only state) → `instant`. If
state survives forever → `permanent`. If state should clear at next round's
CANNON_PLACE-done → `round-scoped`.

```ts
// src/game/modifiers/my-modifier.ts — round-scoped example
import type { GameState, ModifierImpl } from "../../shared/core/types.ts";

export const myModifierImpl: ModifierImpl = {
  lifecycle: "round-scoped",
  apply: (state: GameState) => ({
    changedTiles: [...applyMyModifier(state)],
    gruntsSpawned: 0,
  }),
  clear: clearMyModifier,          // REQUIRED for round-scoped
  restore: (state, data) => {      // optional — needed if you carry checkpointable state
    state.modern!.myModifierTiles = data.myModifierTiles
      ? new Set(data.myModifierTiles as TileKey[])
      : null;
    reapplyMyModifierTiles(state);
  },
  // skipsRecheck omitted = recheckTerritory runs after apply (default).
};
```

Then in `modifier-system.ts`:
```ts
import { myModifierImpl } from "./modifiers/my-modifier.ts";

const MODIFIER_IMPLS = {
  // ...existing entries...
  my_modifier: myModifierImpl,
} as const satisfies Record<ModifierId, ModifierImpl>;
```

**`lifecycle`** (REQUIRED, all variants) — the discriminator. The type
system uses it to enforce the rest of the contract. Don't omit it.

**`apply`** — called at battle start. Returns `{ changedTiles, gruntsSpawned }`
for the reveal banner. Tile-mutating modifiers return the changed keys;
overlay modifiers (frozen river, dust storm) return empty arrays. An impl
that needs grunts spawned (grunt surge) returns optional `spawnRequests`
descriptors instead of calling grunt-system directly — the orchestrator
(`applyBattleStartModifiers` in phase-setup.ts) executes them and merges
the spawn tiles/count into the banner diff.

**`skipsRecheck`** — opt-OUT flag (default: omit, recheck happens). The
dispatcher always runs `recheckTerritory()` after apply unless this is
`true`. Set it ONLY when the modifier provably touches no walls and no
tile passability — visual-only effects (dust storm jitter), grunt-spawn-only
(grunt surge), water-overlay (frozen river), debris cleanup (rubble
clearing). Forgetting to opt out wastes one recheck per battle (cheap);
forgetting to opt IN under the old `needsRecheck` design silently desynced
host vs watcher territory, which is why the default flipped.

**`clear`** (REQUIRED on round-scoped, optional on instant, never fires on
permanent) — idempotent function that reverts temporary state. Timing is
derived from the lifecycle:
- `round-scoped` → fires from `clearActiveModifiers` in `prepareBattleState`
  at the end of every CANNON_PLACE phase, just before `rollModifier` (so the
  new modifier rolls against neutral terrain). Runs for EVERY round-scoped
  impl even if the previous round's modifier wasn't yours — guard with a
  null check on your tile set. Round-scoped means each modifier is active
  from its own battle-start through the entire round, including
  UPGRADE_PICK + WALL_BUILD + the next round's CANNON_PLACE.
- `instant` → fires at BATTLE_END via `clearActiveInstantModifier` (from
  `finalizeBattle`), only for the ACTIVE modifier. Use it to drop
  battle-only state (dust-storm's jitter buffer, rubble-clearing's held
  snapshot) before the WALL_BUILD checkpoint would carry it.

**`restore`** (REQUIRED on permanent, optional on round-scoped, forbidden
on instant) — deserializes checkpoint data and re-applies tile mutations
on a map regenerated from seed. Each modifier reads only its own field
from `SerializedModifierTiles` (modifier-defs.ts). Dispatched by
`applyCheckpointModifierTiles` in modifier-system.ts.

**`resolutionLog`** (optional, all variants) — post-battle diagnostic
trace: returns a one-line summary of what the modifier resolved to this
battle (e.g. supply-ship bonuses awarded), or null when there's nothing
to say. Dispatched generically by the `battle-done` transition via
`describeModifierResolution` (modifier-system.ts), keyed on
`lastModifierId`. Log-only — must never mutate state, so it can't affect
cross-peer parity.

### Per-fire RNG draws (modifiers that affect cannon fires)

Most modifiers draw `state.rng` only inside `apply` (battle-start),
which is symmetric across peers because every peer runs `apply`
identically at the same logical sim tick. **Per-fire** RNG draws
(trajectory jitter, damage variance, etc.) are different — the lockstep
cannon-fire schedule opens an 8-tick SAFETY window between an
originator's fire-time function and the receiver's apply, and any
`state.rng.next()` inside that window drifts cross-peer. Peer-symmetric
per-fire effects need precompute-at-battle-start.

**Pattern: precompute at battle-start.** Pre-draw a buffer of N values
from `state.rng` inside your impl's `apply` (which
`applyBattleStartModifiers` runs right after `rollModifier`, on every peer
at the same logical sim tick), store it on `ModernState`, and index by
`state.shotsFired` at fire time. Both peers populate from the same rng
prefix at the same logical sim tick → identical buffers → no per-fire rng
draws → SAFETY window stays rng-quiet. The canonical exemplar is
`precomputedDustStormJitters` (dust-storm.ts).

Concretely (see `dust-storm.ts` for the canonical example):

1. Add a `readonly number[]` field to `ModernState` (e.g.
   `precomputedFooValues`). Empty array when your modifier isn't
   active this round.
2. Fill the buffer inside your impl's `apply`:
   ```ts
   apply: (state: GameState) => {
     const buf = new Array<number>(BUFFER_SIZE);
     for (let i = 0; i < BUFFER_SIZE; i++) buf[i] = state.rng.next();
     state.modern!.precomputedFooValues = buf;
     return { changedTiles: [], gruntsSpawned: 0 };
   },
   ```
   Pick `BUFFER_SIZE` generously (1024 covers the worst-case
   fires-per-battle by ~3×) and modulo at lookup time so an unexpected
   overflow stays deterministic. `apply` only runs when your modifier IS
   the active one, so no `activeModifier` guard is needed there — gate
   the fire-time lookup on `activeModifier` instead.
3. Drop the buffer in `clear` (fires at BATTLE_END for instant impls):
   ```ts
   clear: (state: GameState) => {
     if (state.modern) state.modern.precomputedFooValues = [];
   },
   ```
4. At fire time, look up by `state.shotsFired`:
   ```ts
   const value = buf[state.shotsFired % buf.length];
   ```
   `state.shotsFired` is bumped by both `applyCannonFiredOriginator`
   and `applyCannonFired` at the lockstep apply tick, so both peers
   read the same index for the same logical fire.
5. Serialize the buffer in `online-serialize.ts` (alongside the existing
   `precomputedDustStormJitters` entry in `serializeModernFields`, and
   restore it in `restoreFullStateSnapshot`) — late-joiners and
   host-migration receivers restore post-precompute `state.rng` and can't
   reroll the buffer without drifting.
6. The `lint:checkpoint-fields` lint enforces step 5.

**State-dependent per-fire draws** (rng draws whose value depends on
state-at-fire-time, e.g. "pick a random target among currently-visible
ones") don't fit this pattern — the input set isn't knowable at
battle-start. None today; the lockstep cannon-fire schedule would need
to defer the originator's draw from schedule-time to apply-time on both
peers if such a modifier is added. Cross that bridge when it arrives.

**Most modifiers don't need either pattern.** RNG draws inside `apply`
are symmetric across peers because every peer runs `apply` identically
at the same logical sim tick — no wire involved.

### Pool entry fields

`ModifierDef` extends the shared `PoolDef` base (`id`, `label`,
`description`, `implemented` — see `src/shared/core/pool-def.ts`) with:

| Field | Meaning |
|-------|---------|
| `weight` | Roll selection weight. Use the `WEIGHT_COMMON` / `WEIGHT_UNCOMMON` / `WEIGHT_RARE` aliases of the shared `RARITY_WEIGHTS` table in pool-def.ts (common = 3, uncommon = 2, rare = 1 — shared vocabulary with the upgrade draft pool) |
| `needsCheckpoint` | `true` if the modifier stores tile state that must be serialized in checkpoints, restored via `restore` on join/reconnect, and reverted on zone reset |

### Checkpoint & serialization (checkpointed tile-set modifiers only)

First ask whether you need a checkpointed tile set at all. The three
current `ModernState` tile sets are `frozenTiles`, `sinkholeTiles`, and
`exposedRiverbedTiles` — each exists because the tiles are RNG-dependent
or cumulative and can't be re-derived by a joining peer. Two modifiers
that LOOK tile-mutating deliberately avoid the machinery:

- **high_tide** derives its flooded set from the static map every time
  (`computeFloodedTiles`) — no tile mutation, no `ModernState` field,
  `needsCheckpoint: false`.
- **low_water** keeps `exposedRiverbedTiles` as the source of truth but
  never mutates `map.tiles` (the tiles stay water; grunt movement and
  render read the set). It still checkpoints, because the RNG-shuffled
  erosion produces a different set per draw.

If your tile set IS deterministic from the static map, derive it like
high_tide and skip everything below. Otherwise
(`needsCheckpoint: true`), you need:

1. A `Set<TileKey> | null` field on `ModernState` to track the tile keys
2. A matching field on `SerializedModifierTiles` in
   `src/shared/core/modifier-defs.ts` (the compiler then trips on both
   the serializer and the restorers at once)
3. Emission in `serializeModifierTileSets()` in `online-serialize.ts`
   (spread into every checkpoint via `serializeModernFields`)
4. A `restore` hook on your `ModifierImpl` that deserializes + reapplies
   tiles, plus a `reapplyFooTiles()` private function in your modifier
   file (called by `restore`)

The `lint:checkpoint-fields` lint verifies that every `ModernState` field
appears in the serialization file. That applies to NON-tile modifier
state too: anything you add to `ModernState` (a precompute buffer, a held
snapshot, an entity list — cf. `precomputedDustStormJitters`,
`rubbleClearingHeld`, `supplyShips`) must ride `serializeModernFields()`
in online-serialize.ts, even when `needsCheckpoint` is false.

### Instant modifiers are simpler

Modifiers like grunt surge, rubble clearing, dust storm, fog of war,
frostbite, sapper, supply ship, and the fire variants are
`lifecycle: "instant"` — they fire once at battle-start and any side
effects flow through normal game state (spawned grunts, destroyed walls,
ignited burning pits). They need:
1. The ID in `ModifierId` + `MODIFIER_ID`
2. A pool entry in `modifier-defs.ts` (`needsCheckpoint: false`)
3. A file in `src/game/modifiers/` exporting a `ModifierImpl` with `lifecycle: "instant"`
4. An import + entry in `MODIFIER_IMPLS` in `src/game/modifier-system.ts`
5. A banner color in `render-ui.ts`

The discriminated union forbids `restore` on instant impls, so you can't
accidentally write dead code that the dispatcher would never call. `clear`
IS allowed on instant — it fires at BATTLE_END (via
`clearActiveInstantModifier`) for battle-only state like dust-storm's
jitter buffer or rubble-clearing's held snapshot; omit it when there's
nothing to drop.

If the effect provably leaves walls and tile passability alone (visual-only
like dust storm, or grunt-spawn-only like grunt surge), set
`skipsRecheck: true` on the impl — see the `skipsRecheck` section above.
Wildfire is the counter-example: it destroys walls, so it takes the
default (recheck runs).

---

## Upgrades (player draft picks)

Upgrades are offered starting round 3 in modern mode. Players pick one of
three weighted-random offers. All upgrades last one round (cleared by
`resetPlayerUpgrades()`).

Upgrades use the same registry-driven dispatch as modifiers. Each upgrade
exports an `UpgradeImpl` object from its file, and `upgrade-system.ts`
imports them all into the `UPGRADE_IMPLS` map with compile-time
exhaustiveness via `satisfies Record<UpgradeId, UpgradeImpl>`.

### Files to touch

| Step | File | What to do |
|------|------|------------|
| 1 | `src/shared/core/upgrade-defs.ts` | Add string literal to `UpgradeId` union + `UID` map + `UPGRADE_POOL` entry |
| 2 | `src/game/upgrades/<name>.ts` | Create upgrade file exporting an `UpgradeImpl` object |
| 3 | `src/game/upgrade-system.ts` | Import the impl and add entry to `UPGRADE_IMPLS` |
| 4 | `.import-layers.json` + `.import-cells.json` | Regenerate — `deno run -A scripts/generate-import-layers.ts` then `deno run -A scripts/cells/regen-cells.ts` (never hand-assign; the file's domain is derived from its `src/game/` path automatically) |

### Files you do NOT touch

- **`upgrade-system.ts` dispatchers** — all lifecycle, event, and query hooks
  are registry-driven. Adding your impl to `UPGRADE_IMPLS` is enough for the
  dispatchers to pick up your hooks automatically.

### Per-upgrade file layout

Each upgrade lives in its own file under `src/game/upgrades/`, exporting an
`UpgradeImpl` object. The `UpgradeImpl` interface (and its
`BattleStartCannonDeps` helper type) is defined in
`src/shared/core/types.ts`.

```
src/game/upgrades/
  architect.ts
  ceasefire.ts
  clear-the-field.ts
  conscription.ts
  demolition.ts
  double-time.ts
  entomb.ts
  erosion.ts
  foundations.ts
  master-builder.ts
  mortar.ts               — impl + mortarSpeedMult (direct export for ballSpeedMult interaction)
  rapid-emplacement.ts    — impl + rapidEmplacementDiscount direct export for cannon-system
  rapid-fire.ts           — empty impl; speed effect lives in upgrade-system's ballSpeedMult dispatcher
  reclamation.ts
  reinforced-walls.ts
  restoration-crew.ts     — impl + restorationCrewInstantRevive direct export for build-system
  ricochet.ts
  salvage.ts
  second-wind.ts
  shield-battery.ts
  small-pieces.ts
  supply-drop.ts
  territorial-ambition.ts
```

### UpgradeImpl interface

All hooks are optional — upgrades only implement the hooks relevant to their
mechanic. Dispatchers in `upgrade-system.ts` iterate the registry and call
each hook with the appropriate aggregation strategy.

```ts
// src/game/upgrades/my-upgrade.ts
import type { UpgradeImpl } from "../../shared/core/types.ts";

function buildTimerBonus(state: GameState): number {
  // ... your logic
}

export const myUpgradeImpl: UpgradeImpl = { buildTimerBonus };
```

Then in `upgrade-system.ts`:
```ts
import { myUpgradeImpl } from "./upgrades/my-upgrade.ts";

const UPGRADE_IMPLS = {
  // ...existing entries...
  my_upgrade: myUpgradeImpl,
} as const satisfies Record<UpgradeId, UpgradeImpl>;
```

### Hook points

#### Pick-time hooks (called once when upgrade is picked)

| Hook | Aggregation | Example upgrades |
|------|-------------|------------------|
| `onPick(state, player)` | Targeted lookup by choice ID | second wind, clear the field, demolition, erosion, reclamation |

The registry lookup by choice ID means no UID guard is needed inside the
implementation — your `onPick` receives only the state and the picking player.

#### Phase lifecycle hooks (called at phase boundaries, iterate all impls)

| Hook | When it fires | Example upgrades |
|------|---------------|------------------|
| `onBuildPhaseStart(state)` | Start of build phase | master builder |
| `tickBuild(state, dt)` | Every build-phase frame | master builder (lockout timer) |
| `onBattlePhaseStart(state, deps)` | Start of battle phase | mortar (cannon election), shield battery |

#### Event hooks (called on specific game events, iterate all impls)

| Hook | When it fires | Example upgrades |
|------|---------------|------------------|
| `onPiecePlaced(state, player, pieceKeys)` | After a piece is placed | foundations, entomb |
| `onImpactResolved(state, shooterId, ...)` | After each cannonball impact | ricochet |
| `onGruntKilled(state, shooterId, killedGruntTile)` | After a grunt is killed (first non-null wins) | conscription |
| `onCannonKilled(state, shooterId)` | After a cannon is destroyed | salvage |
| `onCannonPlaced(player)` | After a cannon is placed | rapid emplacement (consume step) |

#### Query hooks (aggregated across all impls)

| Hook | Aggregation | Example upgrades |
|------|-------------|------------------|
| `shouldSkipBattle(state)` | boolean OR | ceasefire |
| `canPlayerBuild(state, playerId)` | boolean AND | master builder |
| `buildTimerBonus(state)` | additive sum | master builder, double time |
| `shouldAbsorbWallHit(player, tileKey)` | boolean OR | reinforced walls |
| `territoryScoreMult(player)` | multiplicative | territorial ambition |
| `cannonSlotsBonus(player)` | additive sum | supply drop |
| `useSmallPieces(player)` | boolean OR | small pieces |
| `wallOverlapAllowance(player)` | additive sum | architect |
| `canPlaceOverBurningPit(player)` | boolean OR | foundations |
| `canPlaceOverGrunt(players, player)` | boolean OR | entomb (global — takes the players array) |

### Direct exports (outside the registry)

Some upgrades have effects that don't fit the registry dispatch:

- **`ballSpeedMult`** (upgrade-system.ts) — cross-upgrade interaction
  between Rapid Fire and Mortar (they cancel out), plus the cannon-tier
  speed multiplier on top. The dispatcher checks `UID.RAPID_FIRE` on the
  player directly and calls `mortarSpeedMult()` (named export from
  mortar.ts); rapid-fire's registry impl is empty.
- **`restorationCrewInstantRevive()`** — called by `build-system.ts` during
  end-of-build tower revival. Direct export alongside an empty impl.
- **`rapidEmplacementDiscount()`** — called by `cannon-system.ts` to compute
  the slot-cost discount before placement validation. Direct export alongside
  the impl. The matching consume step is registry-driven (the impl wires
  `onCannonPlaced` to delete the upgrade from the player after a successful
  placement); call sites use `applyCannonAtDrain` / `placeCannon` which
  dispatch the hook automatically.

For new upgrades, prefer using the registry hooks. Only use direct exports
when your effect involves cross-upgrade interaction or is called from a
system that doesn't go through `upgrade-system.ts`.

### Upgrade categories

| Category | Timing | Examples |
|----------|--------|---------|
| `battle` | Active during battle phase | mortar, rapid fire, ricochet, shield battery |
| `build` | Active during build phase | master builder, small pieces, architect, foundations |
| `strategic` | Persistent cross-phase effect | territorial ambition, conscription, salvage |
| `one_use` | Applied immediately at pick time | ceasefire, supply drop, second wind, clear the field |

### Pool entry fields

`UpgradeDef` extends the shared `PoolDef` base (`id`, `label`,
`description`, `implemented` — see `src/shared/core/pool-def.ts`) with:

| Field | Meaning |
|-------|---------|
| `category` | `battle` / `build` / `strategic` / `one_use` (see the categories table above) |
| `weight` | Draft selection weight: `WEIGHT_COMMON` (3), `WEIGHT_UNCOMMON` (2), `WEIGHT_RARE` (1) — aliases of the shared `RARITY_WEIGHTS` table in pool-def.ts (same vocabulary as the modifier roll pool) |
| `oneUse` | Metadata flag — all upgrades are cleared each round regardless |
| `global` | `true` = effect applies to all players when any player picks it |
| `implemented` | Set `true` when gameplay code exists (gates draft eligibility) |

### Consuming the upgrade in game code

The standard pattern to check if a player has an upgrade:

```ts
if (!player.upgrades.get(UID.MY_UPGRADE)) return;
// ... apply effect
```

To consume (spend) a one-use upgrade mid-round:

```ts
if (!player.upgrades.get(UID.MY_UPGRADE)) return false;
player.upgrades.delete(UID.MY_UPGRADE);
return true;
```

### Layer placement

Layer indices are mechanical (import depth) and auto-assigned — after
adding a file, run `deno run -A scripts/generate-import-layers.ts` then
`deno run -A scripts/cells/regen-cells.ts`; never hand-edit the maps. For
orientation: the `ModifierImpl` / `UpgradeImpl` interfaces live in
`src/shared/core/types.ts` (L5) and the def/pool files at L1–L4, so impls
under `src/game/modifiers/` and `src/game/upgrades/` land above them
(L6–L8 today, depending on what each impl imports).

---

## Compile-time safety

Both registries use the same exhaustiveness pattern:

1. A `type PoolComplete = Id extends PoolIds ? true : never` check ensures
   every ID has a pool entry
2. `MODIFIER_IMPLS satisfies Record<ModifierId, ModifierImpl>` and
   `UPGRADE_IMPLS satisfies Record<UpgradeId, UpgradeImpl>` ensure every
   entry has an implementation
3. `MODIFIER_CONSUMERS satisfies Record<ModifierId, ...>` ensures every
   modifier has consumer documentation
4. The `lint:registries` pre-commit check verifies every consumer file path
   exists on disk

If you add an ID without the matching entries, `tsc` fails before you can
commit.
