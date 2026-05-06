# Adding Modifiers & Upgrades

Agent-facing guide for implementing new environmental modifiers and player
upgrades. Both use the pool pattern with compile-time exhaustiveness checks
and registry-driven dispatch.

## Modifiers (environmental round effects)

Modifiers fire once per battle start in modern mode (round 3+, 65% chance).
They range from tile mutations (high tide, sinkhole, low water) to entity
effects (grunt surge, crumbling walls) to passive overlays (frozen river,
dust storm).

### Files to touch

| Step | File | What to do |
|------|------|------------|
| 1 | `src/shared/core/game-constants.ts` | Add string literal to `ModifierId` union + `MODIFIER_ID` map |
| 2 | `src/shared/core/modifier-defs.ts` | Add pool entry (`weight`, `needsCheckpoint`, `tileMutationPrev`) + `MODIFIER_CONSUMERS` entry |
| 3 | `src/game/modifiers/<name>.ts` | Create modifier file exporting a `ModifierImpl` object |
| 4 | `src/game/modifier-system.ts` | Import the impl and add entry to `MODIFIER_IMPLS` |
| 5 | `src/render/render-ui.ts` | Add banner color entry to `MODIFIER_COLORS` |
| 6 | `.import-layers.json` | Register the new file (most modifiers land in "deep logic") |
| 7 | *(if tile-mutating)* `src/shared/core/types.ts` | Add `fooTiles: Set<number> \| null` to `ModernState` + initial `null` in `createModernState()` |
| 8 | *(if tile-mutating)* `src/online/online-serialize.ts` | Add to both `createBuildStartMessage()` and `serializeModifierTileSets()` |

### Files you do NOT touch

- **`phase-setup.ts`** — dispatch, clear, and zone-reset are registry-driven
  via `MODIFIER_REGISTRY`. The generic `applyBattleStartModifiers()`,
  `clearActiveModifiers()`, and `resetModifierTilesForZone()` handle
  everything automatically.

### Per-modifier file layout

Each modifier lives in its own file under `src/game/modifiers/`, exporting a
`ModifierImpl` object. This mirrors the `src/game/upgrades/` layout.

```
src/game/
  modifier-system.ts      — MODIFIER_IMPLS registry, rollModifier, checkpoint orchestration
  modifiers/
    modifier-types.ts       — ModifierImpl discriminated union + ModifierTileData
    fire.ts                 — wildfire + dry_lightning impls (shared burn predicate + scar applicator)
    crumbling-walls.ts
    grunt-surge.ts
    frozen-river.ts
    sinkhole.ts
    high-tide.ts
    dust-storm.ts           — impl + applyDustStormJitter (re-exported by modifier-system.ts)
    rubble-clearing.ts
    low-water.ts
    fog-of-war.ts
    frostbite.ts
```

### ModifierImpl interface

`ModifierImpl` is a discriminated union of three variants, tagged by the
`lifecycle` field. Pick the variant that matches your modifier; the type
checker enforces that the right hooks are present.

| Lifecycle | Active for | Required hooks | Optional hooks | Examples |
|-----------|------------|----------------|----------------|----------|
| `"instant"` | apply at battle-start, no own state afterwards | `apply` | `skipsRecheck` | wildfire, dry_lightning, crumbling_walls, rubble_clearing, grunt_surge, dust_storm, fog_of_war |
| `"permanent"` | forever (or until zone reset) | `apply`, `restore` | `zoneReset`, `skipsRecheck` | sinkhole |
| `"round-scoped"` | this round's BATTLE → next CANNON_PLACE-done | `apply`, `clear` | `restore`, `zoneReset`, `skipsRecheck` | frozen_river, high_tide, low_water, frostbite |

Pick the lifecycle by asking: does my effect leave any state behind that
needs to be reverted? If no → `instant`. If state survives forever → `permanent`. If state should clear at next round's CANNON_PLACE-done →
`round-scoped`.

```ts
// src/game/modifiers/my-modifier.ts — round-scoped example
export const myModifierImpl: ModifierImpl = {
  lifecycle: "round-scoped",
  apply: (state: GameState) => ({
    changedTiles: [...applyMyModifier(state)],
    gruntsSpawned: 0,
  }),
  clear: clearMyModifier,             // REQUIRED for round-scoped
  zoneReset: resetMyModifierForZone,  // optional — eliminated-zone cleanup
  restore: (state, data) => {         // optional — needed if you carry checkpointable state
    state.modern!.myModifierTiles = data.myModifierTiles
      ? new Set(data.myModifierTiles)
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
overlay modifiers (frozen river, dust storm) return empty arrays.

**`skipsRecheck`** — opt-OUT flag (default: omit, recheck happens). The
dispatcher always runs `recheckTerritory()` after apply unless this is
`true`. Set it ONLY when the modifier provably touches no walls and no
tile passability — visual-only effects (dust storm jitter), grunt-spawn-only
(grunt surge), water-overlay (frozen river), debris cleanup (rubble
clearing). Forgetting to opt out wastes one recheck per battle (cheap);
forgetting to opt IN under the old `needsRecheck` design silently desynced
host vs watcher territory, which is why the default flipped.

**`clear`** (REQUIRED on round-scoped, forbidden elsewhere) — idempotent
function that reverts temporary state. Called from `prepareBattleState` at
the end of every CANNON_PLACE phase, just before `rollModifier` (so the
new modifier rolls against neutral terrain). Runs even if the previous
round's modifier wasn't yours — guard with a null check on your tile set.
The round-scoped lifecycle means each modifier is active from its own
battle-start through the entire round, including UPGRADE_PICK + WALL_BUILD
+ the next round's CANNON_PLACE.

**`zoneReset`** (optional on permanent + round-scoped, forbidden on instant)
— reverts tiles belonging to a specific zone when a player is eliminated.
Only needed for modifiers with `needsCheckpoint: true`.

**`restore`** (REQUIRED on permanent, optional on round-scoped, forbidden
on instant) — deserializes checkpoint data and re-applies tile mutations
on a map regenerated from seed. Each modifier reads only its own field
from `ModifierTileData`.

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
from `state.rng` inside `prepareBattleState` (right after `rollModifier`),
store on `ModernState`, and index by `state.shotsFired` at fire time.
Both peers populate from the same rng prefix at the same logical sim
tick → identical buffers → no per-fire rng draws → SAFETY window stays
rng-quiet. Same shape as `precomputedUpgradePicks` (commit `9e942a65`).

Concretely (see `dust-storm.ts` for the canonical example):

1. Add a `readonly number[]` field to `ModernState` (e.g.
   `precomputedFooValues`). Empty array when your modifier isn't
   active this round.
2. Export a precompute helper from your modifier file:
   ```ts
   export function precomputeFooValues(state: GameState): void {
     if (state.modern?.activeModifier !== MODIFIER_ID.FOO) {
       state.modern!.precomputedFooValues = [];
       return;
     }
     const buf = new Array<number>(BUFFER_SIZE);
     for (let i = 0; i < BUFFER_SIZE; i++) buf[i] = state.rng.next();
     state.modern!.precomputedFooValues = buf;
   }
   ```
   Pick `BUFFER_SIZE` generously (1024 covers the worst-case
   fires-per-battle by ~3×) and modulo at lookup time so an unexpected
   overflow stays deterministic.
3. Call your helper from `prepareBattleState` immediately after the
   `rollModifier` block in `phase-setup.ts`. It runs on every peer at
   the same simTick, so both peers' buffers come out identical.
4. At fire time, look up by `state.shotsFired`:
   ```ts
   const value = buf[state.shotsFired % buf.length];
   ```
   `state.shotsFired` is bumped by both `applyCannonFiredOriginator`
   and `applyCannonFired` at the lockstep apply tick, so both peers
   read the same index for the same logical fire.
5. Serialize the buffer in `online-serialize.ts` (alongside the existing
   `precomputedUpgradePicks` block) — late-joiners and host-migration
   receivers restore post-precompute `state.rng` and can't reroll the
   buffer without drifting.
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

| Field | Meaning |
|-------|---------|
| `weight` | Draft pool selection weight (1 = rare, 2 = uncommon, 3 = common) |
| `needsCheckpoint` | `true` if the modifier stores tile state that must survive host migration |
| `tileMutationPrev` | The tile value *before* mutation, for the banner snapshot. `0` = Tile.Grass (used by grass-to-water modifiers like sinkhole/high_tide). `1` = Tile.Water (used by water-to-grass like low_water). `null` = no tile mutation (overlay or entity-only modifier). |

### Checkpoint & serialization (tile-mutating modifiers only)

If your modifier mutates `map.tiles`, you need:

1. A `Set<number> | null` field on `ModernState` to track the mutated keys
2. Serialization in `online-serialize.ts` (both checkpoint functions)
3. A `restore` hook on your `ModifierImpl` that deserializes + reapplies tiles
4. A `reapplyFooTiles()` private function in your modifier file (called by `restore`)
5. Update `ModifierTileData` interface in `src/game/modifiers/modifier-types.ts`

The `lint:checkpoint-fields` lint verifies that every `ModernState` field
appears in the serialization file.

### Instant modifiers are simpler

Modifiers like grunt surge, crumbling walls, rubble clearing, dust storm,
fog of war, and the fire variants are `lifecycle: "instant"` — they fire
once at battle-start and any side effects flow through normal game state
(spawned grunts, destroyed walls, ignited burning pits). They need:
1. The ID in `ModifierId` + `MODIFIER_ID`
2. A pool entry in `modifier-defs.ts` (`needsCheckpoint: false`)
3. A file in `src/game/modifiers/` exporting a `ModifierImpl` with `lifecycle: "instant"`
4. An import + entry in `MODIFIER_IMPLS` in `src/game/modifier-system.ts`
5. A banner color in `render-ui.ts`

The discriminated union forbids `clear`/`restore`/`zoneReset` on instant
impls, so you can't accidentally write dead code that the dispatcher would
never call.

If the effect provably leaves walls and tile passability alone (visual-only
like dust storm, or grunt-spawn-only like grunt surge), set
`skipsRecheck: true` on the impl — see the `skipsRecheck` section above.
Crumbling walls is the counter-example: it destroys walls, so it takes the
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
| 4 | `.import-layers.json` | Register the new file (most upgrades land in "first logic") |
| 5 | `.domain-boundaries.json` | Register the new file in the `game` domain |

### Files you do NOT touch

- **`upgrade-system.ts` dispatchers** — all lifecycle, event, and query hooks
  are registry-driven. Adding your impl to `UPGRADE_IMPLS` is enough for the
  dispatchers to pick up your hooks automatically.

### Per-upgrade file layout

Each upgrade lives in its own file under `src/game/upgrades/`, exporting an
`UpgradeImpl` object. The interface is defined in `upgrade-types.ts`.

```
src/game/upgrades/
  upgrade-types.ts        — UpgradeImpl interface + BattleStartCannonDeps + shared types
  architect.ts
  ceasefire.ts
  clear-the-field.ts
  conscription.ts
  demolition.ts
  double-time.ts
  foundations.ts
  master-builder.ts
  mortar.ts               — impl + mortarSpeedMult (direct export for ballSpeedMult interaction)
  rapid-emplacement.ts    — impl + direct exports for cannon-system
  rapid-fire.ts           — impl + direct exports for ballSpeedMult interaction
  reclamation.ts
  reinforced-walls.ts
  restoration-crew.ts     — impl + direct export for build-system
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
import type { UpgradeImpl } from "./upgrade-types.ts";

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
| `onPick(state, player)` | Targeted lookup by choice ID | second wind, clear the field, demolition, reclamation |

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
| `onPiecePlaced(state, player, pieceKeys)` | After a piece is placed | foundations |
| `onImpactResolved(state, shooterId, ...)` | After each cannonball impact | ricochet |
| `onGruntKilled(state, shooterId)` | After a grunt is killed (first non-null wins) | conscription |
| `onCannonKilled(state, shooterId)` | After a cannon is destroyed | salvage |

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

### Direct exports (outside the registry)

Some upgrades have effects that don't fit the registry dispatch:

- **`ballSpeedMult`** — cross-upgrade interaction between Rapid Fire and
  Mortar (they cancel out). The dispatcher calls `rapidFireOwns()`,
  `rapidFireBallMult()`, and `mortarSpeedMult()` directly. These functions
  stay as named exports alongside the impl.
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

| Field | Meaning |
|-------|---------|
| `weight` | Draft selection weight: `WEIGHT_COMMON` (3), `WEIGHT_UNCOMMON` (2), `WEIGHT_RARE` (1) |
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

All upgrade files land at L5 (first logic) alongside `modifier-types.ts`
and `upgrade-types.ts` (L4). The `upgrade-types.ts` interface file sits at
L4 (core state & interfaces) so that upgrade impls can import downward from
it. Check `.import-layers.json` before placing.

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
