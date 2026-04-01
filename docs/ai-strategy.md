# Rebuild & Ruin — AI Strategy

How the AI plays the game. Covers tower selection, piece placement, cannon placement, battle targeting, and the animation/timing layer that makes AI actions visible on screen.

---

## Architecture

The AI is split into two layers:

1. **AiController** (`player-controller.ts`) — execution layer. Manages cursors, timers, animation, and delegates decisions to the strategy.
2. **AiStrategy** (`ai-strategy.ts`) — decision layer. Decides _what_ to do. Strategy-specific logic lives in four files:
   - `ai-strategy-build.ts` — piece placement scoring and selection
   - `ai-castle-rect.ts` — castle rectangle geometry and gap analysis
   - `ai-strategy-cannon.ts` — cannon placement & tower selection
   - `ai-strategy-battle.ts` — battle planning & target picking

The controller calls strategy methods, receives decisions, then animates the cursor moving to the target position before executing the action.

### Seeded PRNG

Each AI player has a seeded pseudo-random number generator (`Rng` in `rng.ts`, Mulberry32 algorithm). All AI decisions — trait rolls, cannon scoring noise, battle targeting, timing jitter — use this seeded RNG instead of `Math.random()`. Logging `strategy.rng.seed` allows reproducing an AI's exact behavior. The `DefaultStrategy` constructor accepts an optional `seed` parameter for replay.

---

## AI Personality

Each AI player is assigned an **archetype** at creation that determines correlated personality traits. This prevents incoherent combinations (e.g. a master builder who places cannons randomly) and produces recognizable play styles.

### Archetypes

| Archetype | Playstyle |
|-----------|-----------|
| **Builder** | Excellent construction, defensive posture, slow and careful. Avoids collateral damage. Tight castles (no bank hugging). |
| **Aggressive** | Mediocre builder but pushes super guns eagerly, fast cursor, tactical battle. Doesn't care about houses/bonuses. Hugs banks for cannon space. |
| **Tactician** | Good all-rounder with top-tier battle tactics and spatial awareness. Cares about the map. |
| **Chaotic** | Fast and sloppy — low build skill, no spatial awareness, fires randomly. Unpredictable and hard to read. |
| **Balanced** | Middle-of-the-road in every dimension. The baseline opponent. |

Each archetype defines ranges for each trait. Values are rolled within those ranges, so two Builders will still differ slightly.

### Trait Table

| Trait | Range | Effect |
|-------|-------|--------|
| `castleMargin` | 2 or 3 (from aggressiveness) | Secondary tower ring size. Aggressive (3) → margin 3 (room for super guns); others → margin 2 (tighter, faster to close). |
| `bankHugging` | true/false (per archetype) | Whether castle rects follow river banks (larger but more gaps) or shrink away (tighter). See [Water corner handling](#water-corner-handling-bankhugging). |
| `caresAboutHouses` | true/false (per archetype) | When true, avoids placing pieces on houses (×8 scoring penalty). When false, places over houses freely. |
| `caresAboutBonuses` | true/false (per archetype) | When true, avoids placing pieces on bonus squares (×8 scoring penalty). When false, places over them freely. |
| `buildSkill` | 1–5 (per archetype) | Controls build quality — search depth, fat-wall tolerance, and pocket awareness. |
| `thinkingSpeed` | 1–3 (per archetype) | How quickly the AI acts. Multiplies all dwell/think delays: 1 = slow (×1.4), 2 = normal (×1.0), 3 = fast (×0.65). |
| `cursorSkill` | 1–3 (per archetype) | Cursor control quality. Affects speed-boost threshold and target anticipation. |
| `aggressiveness` | 1–3 (per archetype) | Super gun eagerness. 1 = never, 2 = default (1/3 at 8+ slots), 3 = eager (2/3 at 6+ slots). |
| `defensiveness` | 1–3 (per archetype) | Balloon placement. 1 = never, 2 = reactive (enemy super guns or space-constrained), 3 = proactive (any enemy cannons). |
| `battleTactics` | 1–3 (per archetype) | Battle intelligence. Controls strategic targeting, chain attacks, and charity sweeps. |
| `spatialAwareness` | 1–3 (per archetype) | Cannon placement quality and tower selection. 1 = noisy/random, 3 = precise/centroid. |

### Archetype Trait Ranges

| Trait | Builder | Aggressive | Tactician | Chaotic | Balanced |
|-------|---------|------------|-----------|---------|----------|
| `buildSkill` | 4–5 | 2–3 | 3–4 | 1–2 | 3 |
| `spatialAwareness` | 2–3 | 2–3 | 3 | 1 | 2 |
| `aggressiveness` | 1 | 3 | 2 | 2–3 | 2 |
| `defensiveness` | 2–3 | 1 | 2 | 1–2 | 2 |
| `battleTactics` | 1–2 | 2–3 | 3 | 1 | 2 |
| `cursorSkill` | 1–2 | 2–3 | 2–3 | 2–3 | 2 |
| `thinkingSpeed` | 1–2 | 2–3 | 2–3 | 3 | 2 |
| `caresAboutHouses` | 80% | 20% | 70% | 20% | 50% |
| `caresAboutBonuses` | 80% | 20% | 70% | 20% | 50% |
| `bankHugging` | 20% | 80% | 50% | 80% | 50% |

### Cursor Skill Levels

| Level | Build/cannon boost threshold | Battle speed boost | Target anticipation |
|-------|-----------------------------|--------------------|---------------------|
| 1 | 8 tiles (rarely boosts) | always ×1 (no boost) | no — picks next target only after think delay |
| 2 | 5 tiles (default) | always ×2 | yes — pre-picks next target immediately after firing |
| 3 | 3 tiles (boosts early) | always ×2 | yes |

**Target anticipation**: Skilled AIs (level ≥ 2) pick their next target immediately after firing, so the crosshair starts moving during the think delay. Unskilled AIs (level 1) wait until the think delay expires, then pick — the crosshair sits idle between shots.

### Build Skill Levels

| Level | Top candidates | Fat gain/block | Pocket penalty | Fat wall penalty | Tiny pocket reject |
|-------|---------------|---------------|---------------|-----------------|-------------------|
| 1 | 12 | 0 (disabled) | ×0.25 | ×0.25 | off |
| 2 | 20 | 1 | ×0.5 | ×0.5 | off |
| 3 | 30 | 2 | ×0.75 | ×0.75 | on |
| 4 | 36 | 2 | ×1.0 | ×1.0 | on |
| 5 | 40 | 3 | ×1.25 | ×1.25 | on |

- **Top candidates**: How many placements get full territory-gain evaluation. Fewer = finds suboptimal but functional placements.
- **Fat gain/block**: Useful-gain required per 2×2 fat block to pass the hard reject. 0 = fat blocks never rejected outright.
- **Pocket/fat wall penalty**: Multiplier on the scoring penalties. Lower = more tolerant of wasted space and thick walls.
- **Tiny pocket reject**: Whether placements creating small pockets (< 9 tiles) are hard-rejected. Tiny pockets (≤ 3 tiles) are rejected even when filling gaps; larger small pockets only when not gap-filling. Off = clumsy builders leave small gaps.

Level 1 still builds functional castles — it just produces thicker walls and more wasted interior space. Level 5 builds cleaner than the old default, actively rejecting more fat blocks.

### Battle Tactics Levels

| Level | Focus fire | Strategic target | Grunt-blocking | Wall demolition | Super attack | Charity sweep |
|-------|-----------|-----------------|---------------|----------------|-------------|--------------|
| 1 | 20% | 0 | 0 | 0 | 0 | 0 |
| 2 | 50% | 1/4 | 1/8 | 1/3 | 1/8 | 1/10 |
| 3 | 80% | 1/2 | 1/4 | 1/2 | 1/4 | 1/5 |

Level 1 fires randomly with no chain attacks and rarely focuses — effective but not smart. Level 3 consistently targets hard-to-repair walls and launches coordinated chain attacks.

### Spatial Awareness Levels

| Level | Centroid tower probability | Cannon score noise |
|-------|---------------------------|-------------------|
| 1 | 1/3 (mostly random) | ×5 (noisy — cannons often placed near edges/water) |
| 2 | 2/3 (default) | ×1 |
| 3 | always centroid | ×0.25 (precise — cannons tightly clustered near center) |

---

## Tower Selection

**When**: Castle Select and Castle Reselect phases.

Two strategies, with probabilities controlled by `spatialAwareness`:

| Probability | Strategy |
|-------------|----------|
| 1/3 to 1.0 (by `spatialAwareness`) | Pick the tower closest to the zone centroid (Manhattan distance from tower center to zone center of mass) |
| remainder | Pick a random tower from the zone |

AI tower selection completes instantly (no timer needed).

---

## Build Phase — Piece Placement

Each frame the AI follows this pipeline:

1. **Compute placement** for the current piece
2. **Animate rotation** from bag orientation to target orientation
3. **Move cursor** toward target position
4. **Dwell** briefly on target
5. **Place** the piece
6. **Think** briefly, then advance to next piece and repeat

### Step 1: Determine Repair Target

The AI decides which castle/tower to repair, in priority order:

1. **Home castle not enclosed** and gaps are small (<=5 tiles): repair home castle gaps.
2. **Home castle was broken last round** and other towers are unenclosed: skip home, target those towers instead.
3. **Any unenclosed towers**: build walls around them.
4. **All towers enclosed**: expand territory outward. Computes the bounding box of existing walls, expands it by 2 tiles, and treats the expanded ring as gaps to fill. This gives the AI a multi-round expansion goal — each piece fills part of the ring, and once closed the AI gains a new territory enclosure (~10 tiles). Uses the existing gap-filling pipeline (`computeFillableGaps` filters water/pits). If scoring finds no positive placement (`bestScore <= 0`), the AI stops building.

### Enclosure Detection

The AI detects tower enclosure using `computeOutside(player.walls)` **without** water barriers — the same flood-fill that `claimTerritory` uses. This ensures the AI and territory always agree on which towers are enclosed. An 8-directional flood from map edges finds all "outside" tiles; any tower whose tiles are all outside is unenclosed.

Two verification layers catch edge cases where 8-dir flood and 4-dir BFS disagree:

**False positives (8-dir says enclosed, but isn't)**: Diagonal wall connections can fool `computeOutside` into thinking a tower is enclosed when a 4-dir path still reaches outside. A 4-dir BFS from each tower that reaches an "outside" tile overrides the 8-dir result — the tower stays unenclosed.

**False negatives (8-dir says not enclosed, but nearly is)**: A tower with a single missing corner tile is *not* enclosed by 8-dir flood (diagonal leak), but the 4-dir BFS can't escape either (walls block orthogonally). Without correction, the AI would skip repair. The fix: when `towerReachesEdge` returns false, compute the expected castle ring and check for fillable gaps. If gaps exist, the tower genuinely needs repair and stays in the unenclosed list. If no gaps exist, the tower is treated as enclosed.

**Home castle ring gaps** (`homeHasRingGaps`): The home castle uses a similar verification. When `computeOutside` says the home tower is enclosed, a 4-dir BFS checks whether the tower truly can't reach outside. If the BFS does reach outside (diagonal leak), ring gaps are checked — they need filling. If the BFS confirms enclosure, ring gaps are cosmetic (shape imperfections from non-rectangular walls) and filling them would only create fat walls.

### Castle Ring Sizing

When building walls around **secondary towers**, the AI computes a castle rectangle with a margin randomized per AI player (2 or 3, chosen once at creation). Margin 3 provides enough interior depth for a 3x3 super gun; margin 2 produces tighter, faster-to-close castles. When water, map edges, or nearby towers block one side, the rectangle **shifts** toward the open side — the constrained side shrinks while the opposite side expands to absorb the surplus (up to its own terrain limit). This preserves interior area for super gun placement. The ring can be rectangular — e.g., wider horizontally than vertically if terrain constrains one axis. The **home castle** always uses its original bounds from `buildCastle` — existing walls match that ring, so repairs target the actual gaps rather than trying to upgrade to a larger castle.

#### Water corner handling (`bankHugging`)

`maxMarginForSide` only samples water along the tower's own columns/rows when computing margins. On stepped river banks, ring **corners** (where two ring edges meet) can land on water tiles that neither side's check detects. This is handled by the `bankHugging` property on `AiStrategy` (default: `false`):

| Mode | Behavior |
|------|----------|
| `bankHugging = false` (default) | After computing the rect, shrink sides when ring corners land on water. Produces a tighter, more rectangular castle that avoids water entirely — fewer gaps to fill but less interior area near banks. |
| `bankHugging = true` | Keep the full bank-hugging rect. Water gaps on the ring are replaced with **bank plug** tiles — grass tiles just inside the rect that seal diagonal flood leaks. The 8-directional flood can jump diagonally past walls, so a wall at the interior tile adjacent to a water corner blocks entry. Produces larger castles that follow the bank contour, at the cost of 1–2 extra interior walls per water corner. |

### Step 2: Find Gap Tiles

For the target castle rectangle:

- **Ring gaps**: Missing wall tiles on the wall ring (1 tile outside the castle interior rectangle).
- **Diagonal leak plugs**: Tiles just outside the ring that connect diagonally to two wall tiles with both orthogonal neighbors also being walls — these are "leak" positions where territory escapes through diagonal gaps.
- **Burning pit plug gaps** (always): When ring gaps fall on burning pits, the 8-connected grass tiles inside the rect adjacent to those pit tiles are added as replacement gaps. Same diagonal-leak-seal logic as water plugs.
- **Bank plug gaps** (bank-hugging mode only): When ring gaps fall on water, the 8-connected grass tiles inside the rect adjacent to those water tiles are added as replacement gaps.
- **Unreachable gap plugs**: After computing fillable gaps, if the current piece can't fill any gap, the AI checks each gap against all 13 standard piece shapes (in all rotations). Gaps that no piece shape can physically reach — e.g., outer ring tiles blocked by 3-wide walls from plus (+) pieces — are treated as permanently unfillable obstacles. Interior plug tiles are added for them (same diagonal-leak seal as water/pit plugs), and the unreachable gaps are removed from the target set. This prevents the AI from endlessly trying to fill gaps that are structurally impossible to reach.

Gaps are only considered fillable if the tile is grass and not blocked by burning pits.

### Step 3: Defensive Expansion

When gaps are blocked by impassable terrain (water, grunts, burning pits), the AI expands the castle rectangle outward to route walls around the obstacle. Expansion limit depends on how full the castle interior is:

| Free interior ratio | Max expansion (tiles) |
|--------------------|-----------------------|
| > 60% | 2 |
| > 30% | 3 |
| > 10% | 4 |
| <= 10% | 5 |

### Step 4: Score All Candidate Placements

For each of 4 rotations and every valid grid position, the AI computes:

- **gapsFilled** — tiles that close holes in the target castle ring
- **wallAdjacent** — adjacent tiles that touch existing walls
- **connectedTiles** — piece tiles that form contiguous wall with existing walls
- **gapAdjacent** — gap tiles adjacent to piece tiles (not directly filled but nearby)
- **isolated** — piece tiles with no wall or gap adjacency
- **housesHit** — houses that would be destroyed by placement
- **bonusHit** — bonus squares that would be covered by placement

**Early rejection**:
- Any piece with at least one tile inside the player's already-enclosed interior is skipped unconditionally (never place walls inside existing territory).
- Gap-closing placements that create 2x2 all-wall blocks ("fat walls") are penalized via the scoring formula (see below).

### Step 5: Territory Gain Calculation

The top candidates (12–40, depending on `buildSkill`) sorted by initial score are evaluated with a full flood-fill simulation:

1. Simulate the placement on a copy of the player's walls.
2. Run `computeOutside()` without water barriers (flood from map edges) to measure the new "outside" area — matching territory's own flood-fill.
3. `usefulGain = baselineOutside - newOutside - pieceTiles` — net territory gained, excluding the wall tiles themselves.

**Fat wall hard reject** (`countFatBlocks`): After computing `usefulGain`, count the number of 2x2 all-wall blocks the placement would create (no exemptions — unlike the scoring penalty's `checkFatWall`, which exempts small gap-closing pieces). If `fatBlocks > 0` and `usefulGain < fatBlocks × fatGainPerBlock`, the candidate is rejected outright — **unless** the placement fills a gap and the castle is still open (`fatExempt`), because closing the ring is more important than avoiding fat walls. The `fatGainPerBlock` threshold comes from `buildSkill` (0 at level 1 = disabled, 3 at level 5 = strictest). Each fat block wastes ~2 tiles of interior space, so higher-skill AIs demand more territory gain to justify them.

**Pocket detection**: Count tiles in small enclosures (< 9 tiles) created by this placement. At `buildSkill` ≥ 3, reject placements that create new tiny pockets (≤ 3 tiles) even when filling gaps, and reject larger small pockets (< 9 tiles) when not gap-filling. At levels 1–2, these hard rejects are disabled — only the scoring penalty discourages pockets.

**Final score formula**:

```
score = usefulGain
      + gapBonus                    -- 0.5–5 base + 0.3 per extra gap filled
      + innerObstacleBonus          -- 2 × tiles adjacent to inner water obstacles
      + difficultyBonus             -- 1x1 pieces: prefer hardest gaps (see below)
      - pocketDelta × 3 × pocketScale    -- small pocket tiles (scaled by buildSkill)
      - housesHit × 8              -- houses destroyed (0 if !caresAboutHouses)
      - bonusHit × 8               -- bonus squares covered (0 if !caresAboutBonuses)
      - fatWallPenalty × fatPenaltyScale  -- fat walls (scaled by buildSkill)
      - wastefulClosurePenalty      -- tiles placed inside castle that don't help
      + sweepSafeBonus              -- 2 per gap tile with ≥2 cardinal wall neighbors
      + cursorProximityBonus        -- guides early placements when no walls exist yet
      + towerProximityBonus         -- guides expansion toward unowned towers
```

**1x1 difficulty priority**: When a 1x1 piece fills a gap, the AI counts orthogonal obstacles (water, towers, map edges, cannons, burning pits). Gaps with 2+ obstacles including an opposite pair (N/S or W/E) get `obstacles × 3` bonus; gaps with at least 1 obstacle get `obstacles × 1`. This ensures the AI fills the hardest-to-repair gaps first, since larger pieces can handle easier gaps later.

### Step 6: Fallback Logic

When the best score is <= 0 (no useful territory gain):

**No scored candidates** (`scored.length === 0`):
- If all castles are enclosed with no gaps and no unenclosed towers: return null (`all-enclosed-no-scored`) — nothing to build.
- Otherwise, prefer non-wall-adjacent candidates with `countFatBlocks === 0` that don't create small enclosures (`open-noFat`), then any fat-free candidate without small enclosures (`noFat-fallback`), then least-fat preferring no small enclosures as last resort (`least-fat-fallback`).

**Gap-filler with no gain** (`gapFiller-noGain`): When the best candidate fills a gap but has `usefulGain <= 0`, only accept it if `countFatBlocks === 0`. Otherwise, search other gap-fillers for one with no fat blocks (`gapFiller-noGain-noFat`). If all gap-fillers create fat blocks and the castle is still open, accept the best one anyway (`gapFiller-fat-forced`) — closing the ring outweighs the fat penalty.

**Tower extension** (`extend`): Place near unenclosed towers, avoiding tiles too close to the tower (inside the castle margin), placements that create small empty enclosures, and placements with `countFatBlocks > 0`. If all extension candidates are fat: try scored candidates outside the ring without fat blocks (`extend-fallback`), or return null (`extend-all-fat`).

**Discard** (`discard`): If no useful placement exists, place anywhere, filtering by `countFatBlocks === 0` and preferring placements that avoid destroying houses and covering bonus squares (only when the AI cares about them per `caresAboutHouses`/`caresAboutBonuses`), and avoiding small enclosures. If all discard candidates are fat: return null (`discard-all-fat`).

Every return path is tagged with a `reason=` string for traceability. The `logTime` wrapper is a passthrough that can be re-enabled for diagnostics by uncommenting the debug logging inside it.

If absolutely nothing works, the AI gives up for 1 second, then retries (grunts may move and free up space). With < 2 seconds remaining in the phase, it stops trying.

---

## Cannon Placement

### Placement Order

1. **Super gun** (3x3, cost 4 slots) — controlled by `aggressiveness`:
   - Level 1: never places super guns.
   - Level 2: 1/3 chance when 8+ total slots (default).
   - Level 3: 2/3 chance when 6+ total slots.
   - At most one super gun, placed at the best-scoring interior position.
2. **Propaganda balloon** (2x2, cost 3 slots) — controlled by `defensiveness`:
   - Level 1: never places balloons.
   - Level 2: places when an enemy has an uncaptured super gun fully enclosed in their territory, or when space-constrained (≤1 normal position left) and enemies have live cannons.
   - Level 3: places whenever enemies have any live cannons.
   - Placed at the best-scoring normal position (lowest score).
3. **Normal cannons** (2x2, cost 1 slot) — fill remaining slots, re-scoring positions after each placement.

### Position Scoring (lower = better)

| Factor | Score contribution |
|--------|--------------------|
| Proximity to map edge (distance <= 2) | `(3 - distance) × 10` per tile |
| Adjacent to water (distance 1) | `+15` per tile-pair |
| Near water (distance 2) | `+8` per tile-pair |
| Adjacent to any tower (cardinal neighbor is a 2×2 tower tile) | `+8` per adjacency |
| Distance to nearest owned tower | `+2 × Manhattan distance` |
| Creates dead-end interior tiles (<=1 free neighbor) | `+10` per dead-end |
| Random noise | `+0 to 2 × noiseScale` (scaled by `spatialAwareness`: ×5 / ×1 / ×0.25) |

The AI places cannons centrally, away from edges, water, and tower walls, near (but not adjacent to) owned towers, and avoids wasting interior space. The tower adjacency penalty prevents cannons from being placed right next to tower walls — enemy fire aimed at the cannon would splash into the wall, breaking the tower enclosure. At low `spatialAwareness`, the heavy noise often overrides the positional penalties, leading to cannons placed near edges or water.

---

## Battle Phase

### Battle Planning

At the start of each battle, the AI makes two decisions:

**1. Focus fire** (20%/50%/80% by `battleTactics`): Target the weakest enemy (fewest towers, then lowest score). Otherwise, fight all enemies equally.

**2. Chain attacks** — checked in priority order, first match wins. Probabilities scale with `battleTactics` (level 1 = no chain attacks except grunt sweep):

| Attack | Probability (by `battleTactics` 1/2/3) | Condition | Behavior |
|--------|----------------------------------------|-----------|----------|
| **Grunt sweep** | always (reactive) | > 15 grunts targeting this AI and > 6 usable cannons | Rapid-fire at grunts on own territory, nearest-neighbor order from random start |
| **Charity sweep** | 0 / 1/10 / 1/5 | > 6 usable cannons | Kill grunts on an enemy's territory when that enemy has <= 6 cannons |
| **Pocket destruction** | always | > 5 small pockets in own interior | Fire at one wall per pocket to free wasted space (max 5 targets). 2x2 pockets are kept. |
| **Wall demolition** | 0 / 1/3 / 1/2 | >= 6 usable cannons | Random-walk a connected enemy wall segment, fire at 4 to min(segment, cannons, 10) tiles |
| **Super attack** | 0 / 1/8 / 1/4 | >= 6 usable cannons | Like wall demolition but hits every other tile (stride 2) for wider coverage |

Chain attacks move the crosshair at 2x speed and dwell 200-300ms per target before firing. Destroyed wall targets are skipped automatically.

### Normal Target Picking

When not executing a chain attack, the AI picks one target at a time:

**1. Target pool**: Collect all enemy cannon tiles and wall tiles. Filter out tiles already targeted by a cannonball in flight.

**2. Focus filtering**: If focus fire is active, only target that player. In the second half of battle (timer <= 5s), 25% chance to switch to the other enemy.

**3. Strategic target** (0 / 1/4 / 1/2 by `battleTactics`): Find enemy wall tiles adjacent to 2+ obstacles (water, towers, map edges, cannons, burning pits) with at least one opposite pair (N/S or W/E). These are hard to repair — the enemy can't bridge across. Pick from the 3 closest, randomly.

**4. Grunt-blocking target** (0 / 1/8 / 1/4 by `battleTactics`): Find enemy wall tiles blocking a grunt's path to its target tower. Checks the direction from grunt toward the nearest corner of its target tower's 2x2 footprint.

**5. Default targeting**:
- **Priority targets**: Cannons the AI already shot at (to finish them off, tracking accumulated hits vs cannon max HP).
- **Spread damage**: Prefer targets 3-8 tiles from the current crosshair to distribute destruction.
- Pick randomly from the top 3 best candidates.

**6. Jitter**: Target coordinates are randomized within the target tile (1-pixel margin from edges) to avoid always hitting the exact center.

### Shot Tracking

The AI tracks how many shots it has fired at each enemy cannon. Once the count reaches the cannon's max HP, the AI stops targeting that cannon (it should be destroyed). Counts reset when a life is lost.

---

## Countdown Behavior

During the "Ready / Aim / Fire" countdown (6 seconds before battle starts):

- If a chain attack is planned, the crosshair moves toward the first chain target.
- Otherwise, the crosshair travels to the first picked target, then **orbits** around it in a randomized ellipse with speed and direction variation. This creates a natural-looking "aiming" animation.

Orbit parameters (randomized per countdown):
- Radius: 3 +/- 1 pixel (1.5x larger for strategic targets)
- Speed: variable with sinusoidal modulation
- Direction: 50/50 clockwise or counter-clockwise

---

## Timing & Animation

All AI actions are animated with smooth cursor movement and human-like pauses. Base durations below are multiplied by the `thinkingSpeed` delay scale (×1.4 / ×1.0 / ×0.65). The 2× speed-boost threshold depends on `cursorSkill` (8 / 5 / 3 tiles for build/cannon; disabled / always-on / always-on for battle).

### Build Phase

| Action | Base duration |
|--------|---------------|
| Cursor speed | 12 tiles/sec (2× when far from target) |
| Rotation frame display | 120-200ms each |
| Dwell on target before placing | 200-300ms × delayScale |
| Think delay after placing | 300-400ms × delayScale |
| Blocked retry wait | 1000ms (then retry same spot once) |
| Give-up retry interval | 1000ms |

Rotation and movement happen concurrently — the piece visually rotates while the cursor moves. Placement only begins once both the cursor arrives and rotation completes.

If a grunt blocks the target tile, the AI waits 1 second and retries once. If still blocked, it recomputes a new placement.

### Cannon Phase

| Action | Base duration |
|--------|---------------|
| Cursor speed | 6 tiles/sec (2× when far from target) |
| Mode switch dwell (normal→super, normal→balloon) | 250-450ms × delayScale |
| Dwell on target before placing | 200-300ms × delayScale |
| Think delay after placing | 300-400ms × delayScale |
| Initial think delay | 300-400ms × delayScale |

When the next cannon to place has a different type (super gun or balloon) than the previous one, the AI pauses to visually show the phantom changing — the same animation a human would see when pressing the rotation key. The phantom switches at the current cursor position before the cursor moves to the target.

### Battle Phase

| Action | Base duration |
|--------|---------------|
| Crosshair speed | 80 px/sec (2× always for `cursorSkill` ≥ 2; 1× only for level 1) |
| Dwell on target before firing | 150-250ms × delayScale |
| Post-fire think delay | 100-300ms × delayScale |
| Chain attack dwell per target | 200-300ms × delayScale |
| Cannon not ready retry | 50ms |

---

## State Reset

### On Life Lost
All AI state is cleared: pending placements, cannon queue, chain targets, crosshair target, timers, idle orbit state. The strategy resets shot counts, focus target, and home-broken flag.

### On New Game
Full reset of all controller and strategy state.

---

## Headless / Fallback AI

A simpler `aiBattleTick()` function exists in `ai-strategy-battle.ts` for headless tests and fallback scenarios. It fires every ready cannon at a random enemy wall or cannon tile each tick, with no timing simulation.
