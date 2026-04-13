# Adding Modifiers & Upgrades

Agent-facing guide for implementing new environmental modifiers and player
upgrades. Both use the pool pattern with compile-time exhaustiveness checks.

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
| 4 | `src/game/modifiers/round-modifiers.ts` | Import the impl and add entry to `MODIFIER_IMPLS` |
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
  round-modifiers.ts      — MODIFIER_IMPLS registry, rollModifier, checkpoint orchestration
  wildfire.ts             — wildfire impl + shared fire helpers (buildCanBurnPredicate, applyWildfireScar)
  crumbling-walls.ts
  grunt-surge.ts
  frozen-river.ts
  sinkhole.ts
  high-tide.ts
  dust-storm.ts           — impl + applyDustStormJitter (re-exported by round-modifiers.ts)
  rubble-clearing.ts
  low-water.ts
  dry-lightning.ts        — reuses wildfire's burn predicate + scar applicator
```

### ModifierImpl interface

Every modifier exports a `ModifierImpl` object from its file, then
`round-modifiers.ts` imports it into the `MODIFIER_IMPLS` map. The
`satisfies Record<ModifierId, ModifierImpl>` check catches omissions at
compile time.

```ts
// src/game/modifiers/my-modifier.ts
export const myModifierImpl: ModifierImpl = {
  apply: (state: GameState) => ({
    changedTiles: [...applyMyModifier(state)],
    gruntsSpawned: 0,
  }),
  needsRecheck: true,          // true if territory changes (tile mutations, wall destruction)
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

Then in `round-modifiers.ts`:
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

**`needsRecheck`** — set `true` when the modifier changes territory
(tile mutations, wall destruction). `recheckTerritory()` runs automatically
after apply.

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
4. An import + entry in `MODIFIER_IMPLS` in `round-modifiers.ts`
5. A banner color in `render-ui.ts`

---

## Upgrades (player draft picks)

Upgrades are offered starting round 3 in modern mode. Players pick one of
three weighted-random offers. All upgrades last one round (cleared by
`resetPlayerUpgrades()`).

### Files to touch

| Step | File | What to do |
|------|------|------------|
| 1 | `src/shared/core/upgrade-defs.ts` | Add string literal to `UpgradeId` union + `UID` map + `UPGRADE_POOL` entry |
| 2 | `src/game/upgrades/<name>.ts` | Create upgrade file with the effect function(s) |
| 3 | *(varies)* Consumer file | Import and call the effect at the right hook point |
| 4 | `.import-layers.json` | Register the new file at the correct layer |
| 5 | `.domain-boundaries.json` | Register the new file in the `game` domain |

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

### Hook points

Upgrades integrate through `upgrade-system.ts` which provides lifecycle hooks.
Choose the hook that matches your effect's timing:

| Hook | When it fires | Example upgrades |
|------|---------------|------------------|
| `onUpgradePicked()` | Immediately at pick time | second wind, clear the field, demolition, reclamation |
| `onBuildPhaseStart()` | Start of build phase | master builder |
| `tickBuildUpgrades()` | Every build-phase frame | master builder (lockout timer) |
| `onBattlePhaseStart()` | Start of battle phase | mortar (cannon election), shield battery |
| `onImpactResolved()` | After each cannonball impact | ricochet |
| `onGruntKilled()` | After a grunt is killed | conscription |
| `onCannonKilled()` | After a cannon is destroyed | salvage |

For **query-style** upgrades (where game code checks "does this player have X?"),
export a query function from your upgrade file and call it directly from the
consumer (e.g. `rapidFireBallMult()`, `foundationsIgnoresPits()`,
`architectWallOverlapAllowance()`). These don't go through upgrade-system.ts
hooks — they're called inline by the relevant game system.

For **build-phase effects** that modify `reviveEnclosedTowers` or similar
end-of-build logic, the upgrade file exports a function that `build-system.ts`
calls directly (e.g. `restorationCrewInstantRevive()`).

### Pick-time upgrades (one-shot side effects)

If your upgrade should fire immediately when picked:

1. Export a `fooOnPick(state, choice)` function from your upgrade file
2. Add a call to `onUpgradePicked()` in `upgrade-system.ts`
3. Guard with `if (choice !== UID.FOO) return;`

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

Upgrade files that only import from `upgrade-defs.ts` (L0) and
`player-types.ts` (L3, type-only) land at L4 (core state & interfaces).
Files that also import from `spatial.ts` (L4) or `types.ts` (L4) land at
L5 (first logic). Check `.import-layers.json` before placing.

---

## Compile-time safety

Both registries use the same exhaustiveness pattern:

1. A `type PoolComplete = Id extends PoolIds ? true : never` check ensures
   every ID has a pool entry
2. `MODIFIER_IMPLS satisfies Record<ModifierId, ModifierImpl>` ensures every
   modifier has an implementation
3. `MODIFIER_CONSUMERS satisfies Record<ModifierId, ...>` ensures every
   modifier has consumer documentation
4. The `lint:registries` pre-commit check verifies every consumer file path
   exists on disk

If you add an ID without the matching entries, `tsc` fails before you can
commit.
