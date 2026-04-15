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
| 4 | `src/game/modifiers/modifier-system.ts` | Import the impl and add entry to `MODIFIER_IMPLS` |
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
src/game/modifiers/
  modifier-types.ts       — ModifierImpl interface + ModifierTileData
  modifier-system.ts      — MODIFIER_IMPLS registry, rollModifier, checkpoint orchestration
  wildfire.ts             — wildfire impl + shared fire helpers (buildCanBurnPredicate, applyWildfireScar)
  crumbling-walls.ts
  grunt-surge.ts
  frozen-river.ts
  sinkhole.ts
  high-tide.ts
  dust-storm.ts           — impl + applyDustStormJitter (re-exported by modifier-system.ts)
  rubble-clearing.ts
  low-water.ts
  dry-lightning.ts        — reuses wildfire's burn predicate + scar applicator
```

### ModifierImpl interface

Every modifier exports a `ModifierImpl` object from its file, then
`modifier-system.ts` imports it into the `MODIFIER_IMPLS` map. The
`satisfies Record<ModifierId, ModifierImpl>` check catches omissions at
compile time.

```ts
// src/game/modifiers/my-modifier.ts
export const myModifierImpl: ModifierImpl = {
  apply: (state: GameState) => ({
    changedTiles: [...applyMyModifier(state)],
    gruntsSpawned: 0,
  }),
  // skipsRecheck omitted = recheckTerritory runs after apply (default).
  // Set `skipsRecheck: true` ONLY if your modifier provably leaves walls
  // and tile passability untouched (e.g. visual-only or grunt-spawn-only).
  clear: clearMyModifier,      // optional — revert temporary state before next battle
  zoneReset: resetMyModifierForZone,  // optional — revert tiles for an eliminated zone
  restore: (state, data) => {  // optional — restore tile state from checkpoint
    state.modern!.myModifierTiles = data.myModifierTiles
      ? new Set(data.myModifierTiles)
      : null;
    reapplyMyModifierTiles(state);
  },
};
```

Then in `modifier-system.ts`:
```ts
import { myModifierImpl } from "./my-modifier.ts";

const MODIFIER_IMPLS = {
  // ...existing entries...
  my_modifier: myModifierImpl,
} as const satisfies Record<ModifierId, ModifierImpl>;
```

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

**`clear`** — idempotent function that reverts temporary state. Called before
every battle start (not just when this modifier was active). Guard with a
null check on your tile set.

**`zoneReset`** — reverts tiles belonging to a specific zone when a player is
eliminated. Only needed for modifiers with `needsCheckpoint: true`.

**`restore`** — deserializes checkpoint data and re-applies tile mutations on
a map regenerated from seed. Only needed for tile-mutating modifiers. Each
modifier reads only its own field from `ModifierTileData`.

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

### Non-tile modifiers are simpler

Modifiers like grunt surge, crumbling walls, and rubble clearing don't need
checkpoint state, serialization, clear, or zoneReset. They just need:
1. The ID in `ModifierId` + `MODIFIER_ID`
2. A pool entry in `modifier-defs.ts`
3. A file in `src/game/modifiers/` exporting a `ModifierImpl`
4. An import + entry in `MODIFIER_IMPLS` in `modifier-system.ts`
5. A banner color in `render-ui.ts`

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
| `canBuildThisFrame(state, playerId)` | boolean AND | master builder |
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
- **`rapidEmplacementDiscount()` / `consumeRapidEmplacement()`** — called
  by `cannon-system.ts` during placement. Direct exports alongside an empty
  impl.

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
