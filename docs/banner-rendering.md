# Banner Rendering

How phase-transition banners draw themselves, and how the "before/after" reveal
works. Read this before touching `runtime-banner.ts`, `render-map.ts`
(`drawBannerPrevScene`), or writing a test that needs to observe the reveal.

## What a banner is

A banner is a full-width text strip that sweeps vertically down the screen
during phase transitions. It acts as a **curtain**: while it's on-screen, the
OLD scene (pre-transition) is visible below the strip, and the NEW scene
(post-transition) is visible above. When the sweep finishes, the new scene is
fully revealed.

Three flavors exist, all routed through the same sub-system
([`src/runtime/runtime-banner.ts`](../src/runtime/runtime-banner.ts)):

1. **Phase banners** — plain text, one per phase transition ("BUILD YOUR
   WALLS", "PLACE YOUR CANNONS", "ATTACK!"). Fire in both `classic` and
   `modern` modes.
2. **Modifier banners** — a phase banner is mid-frame replaced by a modifier
   reveal strip ("WILDFIRE", "HIGH TIDE", ...). Modern mode only. Carries a
   `modifierDiff` payload describing the tiles that changed, which drives a
   pulsing highlight above the sweep line.
3. **Upgrade-round banners** — the same phase banner class, distinguished only
   by the `subtitle` slot (e.g. "UPGRADE ROUND"). The upgrade-pick dialog
   itself is a separate overlay drawn on top of the banner — see the
   "Upgrade-pick dialog interaction" section below for the clip-rect
   handshake that lets the dialog appear with one banner and disappear
   with the next.

## State shape

[`BannerState`](../src/runtime/runtime-contracts.ts) holds everything needed
for the active sweep:

| Field | Meaning |
| --- | --- |
| `active` | True while the banner is on-screen. |
| `progress` | 0 → 1, linear across `BANNER_DURATION` (3 s). Drives the sweep. |
| `text`, `subtitle` | Strings drawn on the strip. |
| `callback` | Fires exactly once at `progress === 1`, via `fireOnce`. |
| `prevScene` | `BannerSnapshot` — atomic frozen scene for the "before" half of the reveal. Set by `showBannerTransition` from `pendingSnapshot`. |
| `pendingSnapshot` | `BannerSnapshot` — captured at a mutation boundary, held across phase gaps until the next banner consumes it. |
| `newTerritory`, `newWalls` | Snapshot of the target battle state (entering BATTLE only). |
| `modifierDiff` | `{ id, changedTiles, gruntsSpawned }` for modifier reveals. |

`prevScene` is cleared when the banner ends — it exists only for the duration
of the sweep. `pendingSnapshot` is consumed (moved to `prevScene`) when
`showBanner` runs with `preservePrevScene=true`.

### BannerSnapshot (overlay-types.ts)

An atomic, immutable snapshot of the full "before" scene:

| Field | Type | Meaning |
| --- | --- | --- |
| `castles` | `CastleData[]` | Per-player walls + interior + cannons. Pre-sweep walls baked in via `wallOverrides`. |
| `entities` | `EntityOverlay` | Houses, grunts, towerAlive, burningPits, bonusSquares, frozenTiles, sinkholeTiles. |
| `territory` | `ReadonlySet<number>[]?` | Battle territory (only for battle→build transition). |
| `walls` | `ReadonlySet<number>[]?` | Battle walls (only for battle→build transition). |

**Rule:** Never construct piecemeal. Always use `createBannerSnapshot()` from `phase-banner.ts`.

## Lifecycle

```
showBanner()  ──►  tickBanner() (per frame)  ──►  BANNER_START  ──►  …  ──►  progress===1  ──►  BANNER_END  ──►  callback()
                   progress += dt / BANNER_DURATION
                   render()
```

1. **`showBanner(text, onDone, preservePrevScene?, newBattle?, subtitle?)`**
   stores the callback, sets `progress = 0`, switches the runtime to
   `Mode.BANNER`, and (when `preservePrevScene` is true) atomically moves
   `pendingSnapshot` → `prevScene`. There is no auto-capture fallback —
   callers must have set `pendingSnapshot` before calling `showBanner`.
   Fires haptics + sound once. Flags `pendingStartEvent = true` — the bus
   event fires on the **next** tick, not here, so that consecutive
   `showBanner` calls in the same tick collapse into a single
   `BANNER_START` event for the final content.
2. **`tickBanner(dt)`** advances `progress`, calls `render()`, and on the
   first tick emits `GAME_EVENT.BANNER_START` with the final text + subtitle +
   `modifierId` + `changedTiles`.
3. When `progress >= 1`, emits `GAME_EVENT.BANNER_END`, wipes the snapshot
   fields, sets `active = false`, then invokes the stored callback via
   `fireOnce` (which also nulls the field, preventing double-fire if the tick
   runs again the same frame).

### Modifier banner flow

Modifier reveals are handled as chained banners. Inside the BATTLE phase
transition, [`runtime-phase-ticks.ts`](../src/runtime/runtime-phase-ticks.ts):

1. Captures `pendingSnapshot` BEFORE `enterBattlePhase` mutates state.
2. Calls `enterBattlePhase(state)` which rolls the modifier and returns
   territory/walls/flights/`ModifierDiff`.
3. If `modifierDiff` is non-null: sets `banner.modifierDiff`, calls
   `showModifierRevealBanner(label, callback)` where the callback chains
   `showBattlePhaseBanner`. Two separate banners, each consuming
   `pendingSnapshot` independently.
4. If no modifier: calls `showBattlePhaseBanner` directly.

## Progressive reveal — the draw pipeline

The curtain effect is implemented by rendering **two complete scenes** and
compositing them with a clip rect.

### Sweep geometry

[`render-composition.ts`](../src/render/render-composition.ts) converts
`progress` → world-space Y:

```
startY = -bannerH / 2      // strip fully above the viewport
endY   = H + bannerH / 2   // strip fully below the viewport
banner.y = lerp(startY, endY, progress)
```

At `progress=0` the strip's centerline sits half a banner-height above the
top edge; at `progress=1` it sits half a banner-height below the bottom.

### Two-scene composition

[`drawMap`](../src/render/render-map.ts) runs once per frame. When a banner
is active with `preservePrevScene` data, the sequence is:

1. **Draw the NEW (live) scene** to the offscreen overlay canvas: terrain →
   castles → sinkhole overlays → bonus squares → houses → towers → burning
   pits → grunts. Uses the live `map` and `overlay`.
2. **`drawBannerPrevScene`** runs next. It:
   - Skips entirely if `clipY >= H` (sweep has finished off-screen) or if no
     snapshot is stored.
   - Rebuilds a synthetic `prevOverlay` from the snapshot fields, clearing
     selection highlights / phantoms / battle effects so the old scene looks
     clean.
   - For tile-mutation modifiers (`high_tide`, `sinkhole`) builds a
     **snapshot map** via
     [`buildModifierSnapshotMap`](../src/render/render-snapshot.ts) — a clone
     of `map.tiles` with the `changedTiles` reverted to `Tile.Grass` — so the
     terrain pass paints the OLD terrain below the sweep line. All other
     banners pass the live map straight through.
   - Draws the full old scene to a temp banner canvas (terrain → water anim
     → frozen → castles → sinkhole overlays → bonus → houses → towers →
     burning pits → grunts).
   - Fires `observer.terrainDrawn("banner", renderMap)` — this is the test
     seam for asserting that the snapshot map reached the terrain pass.
   - Caches the banner canvas by reference identity on
     `{ map, prevScene, modifierTiles }`. The expensive pass
     runs once per banner, not every frame.
   - Composites: `ctx.rect(0, clipY, W, H - clipY); ctx.clip();
     ctx.drawImage(bannerCanvas, 0, 0)`. Everything **below** `clipY` is the
     old scene; everything **above** is the already-drawn new scene.

   `clipY = banner.y - bannerH/2` = the top edge of the strip. As `progress`
   grows, `clipY` grows too, so the clipped region (the old scene) shrinks
   from "full screen" at `progress=0` toward "nothing" at `progress=1`.

3. **`drawModifierRevealHighlight`** pulses a fill over each `changedTiles`
   entry **only if** that tile's bottom edge is above `revealY = banner.y -
   bannerH/2`. Tiles the banner has already swept past pulse in the modifier
   palette color; tiles still below the strip stay hidden under the old
   scene. Pulse: 0.25–0.55 alpha, 400 ms sine.
4. **`drawBanner`** draws the strip itself on top of everything.

Load-bearing ordering: the new scene is drawn first (layers 1–9), the old
scene second (layer 10, clipped), the banner strip last (layer 15). Reordering
these breaks the reveal.

## Event signals

| Event | Fires when | Payload |
| --- | --- | --- |
| `GAME_EVENT.BANNER_START` | First tick after `showBanner` (post mid-frame swap). | `text`, `subtitle`, `phase`, `round`, `modifierId?`, `changedTiles?` |
| `GAME_EVENT.BANNER_END`   | `progress` reaches 1, immediately before the callback runs. | `text`, `phase`, `round` |
| `GAME_EVENT.MODIFIER_APPLIED` | From `enterBattleFromCannon` when the modifier roll returns non-null. Happens *before* the banner is swapped to the modifier reveal. | `modifierId`, `round` |

`BANNER_START` and `BANNER_END` always come in matched pairs per banner; tests
that want to count sweeps should listen to `BANNER_END` (it's guaranteed
exactly once per banner, even if the callback throws).

## Modifier-diff semantics

[`ModifierDiff`](../src/shared/core/game-constants.ts):

```ts
interface ModifierDiff {
  readonly id: ModifierId;
  readonly label: string;
  readonly changedTiles: readonly number[];  // packTile keys
  readonly gruntsSpawned: number;
}
```

| Modifier | `changedTiles` | `gruntsSpawned` | Snapshot map behavior |
| --- | --- | --- | --- |
| `wildfire` | scar tiles (~10) | 0 | Not a terrain mutation — `changedTiles` drives the pulse highlight; snapshot tiles already match live tiles (both Grass). |
| `crumbling_walls` | destroyed wall tiles | 0 | Same — highlight only; underlying tiles unchanged. |
| `grunt_surge` | `[]` | 6–10 | No highlight, no terrain change. Banner is text-only. |
| `frozen_river` | `[]` | 0 | No tile mutation (water stays water); frozen overlay draws on top. Empty `changedTiles` is intentional — see warning below. |
| `sinkhole` | new water tiles | 0 | **Terrain mutation** — snapshot map reverts to `Grass`. |
| `high_tide` | new water tiles | 0 | **Terrain mutation** — snapshot map reverts to `Grass`. Recedes next round. |
| `dust_storm` | `[]` | 0 | Pure VFX (cannonball angle jitter). Banner is text-only. |
| `rubble_clearing` | cleared tiles (debris/pits) | 0 | Highlight only — the cleared positions were already grass underneath. |

Only `sinkhole` and `high_tide` actually *mutate* `state.map.tiles`. The
snapshot-map trick only matters for those two.

> **Warning when adding a new modifier:** `buildModifierSnapshotMap`
> unconditionally reverts every `changedTile` key to `Tile.Grass` when the
> set is non-empty. Returning `changedTiles` for a modifier that **doesn't**
> mutate `state.map.tiles` is only safe if the underlying tiles were already
> grass — otherwise the banner sweep flashes grass strips where the live
> terrain (water, etc.) should be. `frozen_river` previously hit exactly
> this bug. The rule of thumb: if your modifier doesn't write to `map.tiles`
> AND the affected tiles aren't all grass, return `changedTiles: []` and
> draw the visual change as an overlay layer instead.

## Test seams

Four hooks exist specifically for banner-rendering tests:

### `renderObserver.terrainDrawn(target, mapRef)`

[`RenderObserver`](../src/shared/ui/overlay-types.ts) fires from
`drawBannerPrevScene` (with `target === "banner"`) and from the main
`drawMap` pass (with `target === "main"`). The `mapRef` parameter is the
**exact `GameMap` object** that was passed to `drawTerrain` — reference
equality (`===`) is the load-bearing signal. For tile-mutation modifiers the
banner ref is a fresh object from `buildModifierSnapshotMap`, so
`banner.mapRef !== main.mapRef`.

Wire it via `createScenario({ recorder, renderObserver })`. The observer
requires a `recorder` — the no-op stub renderer never draws terrain so the
callback would never fire. `scenario.ts` throws if you pass one without the
other.

`terrainDrawn` only fires once per banner on the banner side (the prev-scene
canvas is cached by reference), so it's not enough to track frame-by-frame
state — pair it with `bannerComposited` for that.

### `renderObserver.bannerComposited(info)`

Fires every frame `drawBannerPrevScene` runs the composite (clip + drawImage),
right before `ctx.restore()`. Reports `{ clipY, H, W, bannerH }` — the exact
clip-rect Y value passed to `ctx.rect(0, clipY, W, H - clipY); ctx.clip()`.
Combined with the two `mapRef`s captured via `terrainDrawn`, this is enough
to **reconstruct the on-screen tile grid per frame** without reading pixels:

```ts
// For every changedTile (row, col):
const tileBottom = (row + 1) * TILE_SIZE;
const tileTop = row * TILE_SIZE;
if (tileBottom <= clipY) {
  // Fully above clip → renderer drew the live (new) tile here
  expected = liveMap.tiles[row][col];
} else if (tileTop >= clipY) {
  // Fully below clip → renderer drew the snapshot (old) tile here
  expected = snapshotMap.tiles[row][col];
}
// else: tile straddles the clip line, skip the assertion
```

`test/banner-progressive-render.test.ts` uses exactly this trick to verify
the bottom-of-screen reveal for the tile-mutation modifiers without ever
inspecting a pixel buffer.

The renderer early-returns when `clipY >= H`, so the last observed compose
frame has `clipY ≤ H - 1`. Tests that need to assert "the very last row got
revealed" should account for this off-by-one (e.g. assert `clipY ≥ H - TILE_SIZE`
or skip the bottom-most row from sample candidates).

### Recording canvas

[`createCanvasRecorder`](../test/recording-canvas.ts) returns a mock canvas
factory that records every 2D-context call. Use
`createCanvasRecorder({ discardCalls: true })` when you only need the
observer seam — accumulating every op across thousands of frames OOMs the
test runner.

### `Scenario.banner()` and `Scenario.dialogs()`

The `BannerState` lives on `runtimeState`, not `state`, so tests reach it
via the [`scenario.ts`](../test/scenario.ts) accessor:

```ts
const sc = await createScenario({ ... });
const banner = sc.banner();             // Readonly<BannerState>
banner.progress;                        // 0..1, advances ~dt/3000 per tick
banner.active;                          // false outside a sweep
banner.prevScene?.castles;              // frozen scene snapshot during sweep
banner.modifierDiff?.changedTiles;      // populated for modifier reveals
```

`sc.dialogs()` is the parallel accessor for `runtimeState.dialogs` (e.g.
`sc.dialogs().upgradePick`) — used by the upgrade-overlay test to check
that the dialog stays alive through the build banner sweep.

Both accessors return live references — read inside a `runUntil` predicate
or right after a `runUntil` call, never hold them across frames.

### Chained-banner gotcha

Modifier banners and the upgrade-pick → build banner flow both **chain**:
when one banner ends, its `callback` synchronously calls `showBanner` again
for the next one. That happens *inside* `tickBanner`, between
`emit(BANNER_END)` and the predicate of the next `runUntil` iteration. So
by the time a `runUntil` predicate runs after the end-tick, the runtime
already holds the **next** banner's state (`progress = 0` again), not the
one you just observed.

If your test samples banner state across the sweep, you have to capture the
end-state from inside the `BANNER_END` handler (where `sc.banner().progress`
still reads 1) and stop pushing samples once the handler latches `ended = true`.
The frame-by-frame tests in `test/banner-progressive-render.test.ts` show
the canonical pattern.

## Upgrade-pick dialog interaction

The upgrade-pick dialog (`runtimeState.dialogs.upgradePick`) is a modal
overlay drawn by [`drawUpgradePick`](../src/render/render-ui.ts) **after**
the banner layer in the draw order. It renders only when the dialog state
is non-null. To make it appear and disappear **with** the banner sweep,
the renderer applies an inverted clip rect tied to `banner.y`:

```ts
// drawUpgradePick:
const clipBottom = Math.round(banner.y - bannerH / 2);
ctx.beginPath();
ctx.rect(0, 0, W, clipBottom);  // top region only
ctx.clip();
// ... draw the dialog ...
```

`clipBottom` grows from negative (clip empty → dialog hidden) at `progress = 0`
to `H` (clip full → dialog fully visible) at `progress = 1`. So the dialog
**top-down reveals together with the new scene** during the upgrade-pick
banner, and the same math during the *build* banner that follows the picks
makes the dialog top-down disappear as the build scene reveals.

This only works if the dialog stays in `runtimeState.dialogs.upgradePick`
through the build banner sweep. The lifecycle is:

1. Picks resolve in [`runtime-upgrade-pick.ts:tick`](../src/runtime/runtime-upgrade-pick.ts).
2. `applyUpgradePicks` writes the chosen upgrades into game state.
3. The resolveCallback fires, queueing the build banner. The dialog
   **stays** non-null on purpose.
4. The build banner sweeps. `drawUpgradePick` clips it against `banner.y`
   each frame.
5. The build banner's `onDone` calls `deps.clearUpgradePickDialog()` →
   `upgradePick.set(null)` → the dialog tears down.

Both the host (`runtime-phase-ticks.ts:enterBuildViaUpgradePick`) and
watcher (`online-phase-transitions.ts:handleBuildStartTransition`) build
banners go through the same `upgradePick.set(null)` subsystem boundary.
The host-promotion (`online-runtime-promote.ts`) and stale-dialog cleanup
(`online-server-lifecycle.ts`) paths also route through `set(null)` so
there's exactly one audited mutation site for the dialog.

## Common mistakes

- **Reading pixels vs reading `mapRef`**: the renderer draws terrain via
  `putImageData` from a terrain cache keyed on the map object identity. You
  don't need to read pixel buffers to verify what's drawn — reference
  equality on `mapRef` is sufficient, and 1000× cheaper.
- **Missing `pendingSnapshot`**: if `showBanner` is called with
  `preservePrevScene=true` but `pendingSnapshot` is undefined, the banner
  will have no "before" scene. There is no auto-capture fallback — this is
  always a bug in the caller. Each phase transition must set
  `banner.pendingSnapshot = createBannerSnapshot(state)` before mutations.
- **Asserting `banner.active === false` inside `BANNER_END`**: the event
  fires *before* `active` is set. Listen to the event, then read `active` on
  the next tick.
- **Clearing snapshots early**: `clearSnapshots()` only wipes
  `pendingSnapshot` (it exists for selection resets, not banner teardown).
  `prevScene` is cleared by `tickBanner` at `progress === 1`.
- **Forgetting to re-set `pendingSnapshot` for chained banners**: When an
  upgrade-pick banner precedes a build banner, the first banner consumes
  `pendingSnapshot`. The caller must save the snapshot in a local variable
  and re-set `pendingSnapshot` before the second `showBanner` call.
