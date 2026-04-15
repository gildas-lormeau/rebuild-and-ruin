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
2. **Modifier banners** — shown before the battle banner, revealing a modifier
   effect ("WILDFIRE", "HIGH TIDE", ...). Modern mode only. Carries a
   `modifierDiff` payload describing the tiles that changed, which drives a
   pulsing highlight above the sweep line. Chains into the battle banner
   via its callback.
3. **Upgrade-round banners** — the same phase banner class, distinguished only
   by the `subtitle` slot (e.g. "UPGRADE ROUND"). The upgrade-pick dialog
   itself is a separate overlay drawn on top of the banner.

## State shape

[`BannerState`](../src/runtime/runtime-contracts.ts) holds everything needed
for the active sweep:

| Field | Meaning |
| --- | --- |
| `active` | True while the banner is on-screen. |
| `progress` | 0 → 1, linear across `BANNER_DURATION` (3 s). Drives the sweep. |
| `text`, `subtitle` | Strings drawn on the strip. |
| `callback` | Fires exactly once at `progress === 1`, via `fireOnce`. |
| `prevSceneImageData` | Pixel snapshot (`ImageData`) of the offscreen canvas captured before phase mutations. Composited below the sweep line. |
| `modifierDiff` | `{ id, changedTiles, gruntsSpawned }` for modifier reveals. Drives the tile pulse highlight. |

`prevSceneImageData` and `modifierDiff` are cleared when the banner ends.

## Lifecycle

```
captureScene() → showBanner() → tickBanner() (per frame) → BANNER_START → … → progress===1 → BANNER_END → callback()
```

1. **Before the transition**, the caller captures `renderer.captureScene()`
   which grabs the offscreen canvas pixels as `ImageData`. This is stored on
   `banner.prevSceneImageData`.
2. **`showBanner(text, onDone, subtitle?)`** stores the callback, sets
   `progress = 0`, switches the runtime to `Mode.BANNER`. Fires haptics +
   sound once. Flags `pendingStartEvent = true` — the bus event fires on the
   **next** tick so that mid-frame mutations land in the event payload.
3. **`tickBanner(dt)`** advances `progress`, calls `render()`, and on the
   first tick emits `GAME_EVENT.BANNER_START` with the final text + subtitle +
   `modifierId` + `changedTiles`.
4. When `progress >= 1`, emits `GAME_EVENT.BANNER_END`, wipes
   `prevSceneImageData` and `modifierDiff`, sets `active = false`, then
   invokes the stored callback via `fireOnce`.

## Progressive reveal — the draw pipeline

The curtain effect composites two images with a clip rect: the new scene
(rendered live each frame) and the old scene (a captured `ImageData` snapshot).

### Sweep geometry

[`render-composition.ts`](../src/render/render-composition.ts) converts
`progress` → world-space Y:

```
startY = -bannerH / 2      // strip fully above the viewport
endY   = H + bannerH / 2   // strip fully below the viewport
banner.y = lerp(startY, endY, progress)
```

### Two-scene composition

[`drawMap`](../src/render/render-map.ts) runs once per frame. When
`prevSceneImageData` is set, the sequence is:

1. **Draw the NEW (live) scene** to the offscreen overlay canvas: terrain →
   castles → sinkhole overlays → bonus squares → houses → towers → burning
   pits → grunts.
2. **`drawBannerPrevScene`** runs next. It:
   - Skips if `clipY >= H` (sweep finished) or no `prevSceneImageData`.
   - On first call, paints the `ImageData` onto a temp banner canvas via
     `putImageData` (once — stays valid for the whole banner).
   - Composites: `ctx.rect(0, clipY, W, H - clipY); ctx.clip();
     ctx.drawImage(bannerCanvas, 0, 0)`. Everything **below** `clipY` is the
     old scene; everything **above** is the already-drawn new scene.
3. **`drawModifierRevealHighlight`** pulses a fill over each `changedTiles`
   entry above the sweep line.
4. **`drawBanner`** draws the strip itself on top of everything.

No re-rendering from game state, no synthetic overlays, no banner cache.
The old scene is a pixel-perfect snapshot of what the player last saw.

## Capture timing

Capture is centralized in [`runtime-phase-machine.ts`](../src/runtime/runtime-phase-machine.ts).
`runTransition(id, ctx)` does **one thing first**:

```ts
ctx.runtimeState.banner.prevSceneImageData = ctx.captureScene();
```

…before any mutate fn runs. Every transition (host or watcher) goes
through this single point, so capture-before-mutate is structural — not
something call sites have to remember.

Chained banners (modifier-reveal → battle, upgrade-pick → build) flag
the first display step with `recaptureAfter: true`; the runner grabs a
fresh snapshot when that step's `onDone` fires, so the next banner in
the chain reveals its own delta.

Watcher parity: the watcher's `runTransition` call is the same call,
with `role: "watcher"` selecting a different mutate (apply checkpoint
instead of run game logic). The pre-mutation capture happens
identically.

## Event signals

| Event | Fires when | Payload |
| --- | --- | --- |
| `GAME_EVENT.BANNER_START` | First tick after `showBanner` (post mid-frame swap). | `text`, `subtitle`, `phase`, `round`, `modifierId?`, `changedTiles?` |
| `GAME_EVENT.BANNER_END`   | `progress` reaches 1, immediately before the callback runs. | `text`, `phase`, `round` |

`BANNER_START` and `BANNER_END` always come in matched pairs per banner.

## Modifier-diff semantics

[`ModifierDiff`](../src/shared/core/game-constants.ts):

```ts
interface ModifierDiff {
  readonly id: ModifierId;
  readonly changedTiles: readonly number[];  // packTile keys
  readonly gruntsSpawned: number;
}
```

| Modifier | `changedTiles` | `gruntsSpawned` | Notes |
| --- | --- | --- | --- |
| `wildfire` | scar tiles (~10) | 0 | Highlight only; underlying tiles unchanged. |
| `crumbling_walls` | destroyed wall tiles | 0 | Highlight only. |
| `grunt_surge` | `[]` | 6–10 | Banner is text-only. |
| `frozen_river` | `[]` | 0 | No tile mutation; frozen overlay draws on top. |
| `sinkhole` | new water tiles | 0 | **Terrain mutation** — captured ImageData naturally shows pre-mutation Grass. |
| `high_tide` | new water tiles | 0 | **Terrain mutation** — recedes next round. |
| `dust_storm` | `[]` | 0 | Pure VFX (cannonball angle jitter). Banner is text-only. |
| `rubble_clearing` | cleared tiles (debris/pits) | 0 | Highlight only. |

With `ImageData` capture, tile-mutation modifiers (sinkhole, high_tide) are
handled automatically — the captured scene was taken before the modifier
applied, so old terrain shows below the sweep line without any snapshot-map
tricks.

## Test seams

### `renderObserver.bannerComposited(info)`

Fires every frame `drawBannerPrevScene` runs the composite (clip + drawImage).
Reports `{ clipY, H, W, bannerH }`.

### `Scenario.banner()` and `Scenario.dialogs()`

The `BannerState` lives on `runtimeState`, not `state`, so tests reach it
via the [`scenario.ts`](../test/scenario.ts) accessor:

```ts
const sc = await createScenario({ ... });
const banner = sc.banner();         // Readonly<BannerState>
banner.progress;                    // 0..1, advances ~dt/3000 per tick
banner.active;                      // false outside a sweep
banner.modifierDiff?.changedTiles;  // populated for modifier reveals
```

### Headless mode

The headless runtime (`test/runtime-headless.ts`) provides a stub
`captureScene()` that returns `undefined` — no real canvas exists.
`prevSceneImageData` is `undefined` in headless tests, so
`drawBannerPrevScene` is a no-op. Banner behavior (progress, events,
callbacks) is fully testable; pixel composition is verified via E2E tests.

### Chained-banner gotcha

Modifier banners and the upgrade-pick → build banner flow both **chain**:
when one banner ends, its `callback` synchronously calls `showBanner` again
for the next one. That happens *inside* `tickBanner`, between
`emit(BANNER_END)` and the predicate of the next `runUntil` iteration.

If your test samples banner state across the sweep, capture the
end-state from inside the `BANNER_END` handler (where `sc.banner().progress`
still reads 1).

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

The dialog top-down reveals with the upgrade banner and top-down disappears
with the build banner that follows.

## Common mistakes

- **Capturing too late**: the `ImageData` must be captured before phase
  mutations. Capturing after the upgrade dialog appears gives you the dialog
  overlay instead of the game map.
- **Forgetting chained re-capture**: when a modifier banner chains into a
  battle banner, call `captureScene()` in the callback before showing the
  next banner — otherwise the battle banner reuses the modifier's pre-scene.
- **`clearSnapshots()` scope**: wipes `prevSceneImageData` on selection
  reset so a stale capture from a previous banner cycle doesn't bleed into
  the next one. `modifierDiff` is cleared by `tickBanner` at
  `progress === 1` alongside the ImageData clear.
