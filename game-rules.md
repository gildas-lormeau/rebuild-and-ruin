# Rebuild & Ruin - Game Rules

A multiplayer Rampart remake for the web. Up to 3 players compete on a battlefield divided by rivers, building walls, placing cannons, and battling to control territory.

---

## Design Invariants (read first)

These rules are load-bearing across the whole game and easy to miss because they're implied by many sections rather than stated in one. Anyone reasoning about new mechanics, upgrades, or modifiers should treat them as hard constraints — most "obvious" feature ideas that violate one of these are non-starters.

- **Grunts are neutral hazards, not player-owned units.** Once spawned, a grunt belongs to no one. It locks onto the nearest alive tower *in the zone it occupies* and attacks whatever is there. Spawn *direction* can be aimed (destroying/enclosing a house pushes grunts toward opponents' zones), but there is no "your grunts," no commanding them after spawn, and no routing them tile-by-tile. Upgrades that treat grunts as a directed offensive unit don't fit the model.
- **Zones are spatially sealed; you only ever touch your own zone.** A player builds, encloses, and destroys exclusively within their own zone. Enemy towers, houses, cannons, and dead-cannon debris are always in the enemy's zone and are physically unreachable — **the only thing that crosses a river is a cannonball.** You can never enclose, salvage, or otherwise spatially interact with another player's structures.
- **Territory scoring is bracketed, not per-tile.** Interior tiles map to a tiered point table (see Scoring), so adding a handful of tiles usually scores **zero** — only crossing a bracket threshold pays out. Flat per-tile or perimeter bonuses are near-useless against this curve.
- **Enclosure is continuous, not a one-time check.** A cannon fires only while *every* one of its tiles stays inside enclosed territory. Breaking your own wall (to insert a cannon, clear space, etc.) un-encloses the territory and silences every cannon in it until it's sealed again — so self-inflicted wall destruction is usually self-sabotage, not a clever tradeoff.
- **Dead cannons persist as blocking debris.** A destroyed cannon doesn't vanish — its footprint keeps blocking piece placement, cannon placement, and grunt movement until the zone is reset. Mechanics that "make a dead cannon keep blocking" are no-ops; it already does.

---

## Map

- **Grid**: 44 columns × 28 rows.
- **Terrain**: Grass (buildable) and Water (impassable).
- **River**: A Y-shaped river divides the map into **3 zones** of roughly equal size. Generated via Bezier curves from a central junction to 3 map edges; 3 tiles wide.
- **Towers**: 12 total (4 per zone), each occupying 2×2 tiles. Placed via farthest-point sampling with minimum 5-tile gap between towers and a safe zone around each.
- **Houses**: 8 per zone initially, 1×1 tiles. Placed on grass with a 1-tile margin from water and towers, minimum 3-tile Manhattan distance between houses. Houses are spawned after castle construction (visible from the cannon phase onward). Zones are refilled to 8 houses at the start of each build phase when below that count.
- **Bonus squares**: 3 per zone, placed on open (non-enclosed) grass with a 1-tile gap from borders/river and minimum 3-tile Manhattan distance from each other. Replenished after any are captured.

---

## Game Flow

```
CASTLE_SELECT → CANNON_PLACE → BATTLE → WALL_BUILD
  (round 1)         ↑                        │
                    └────────────────────────┘
                        (round 2+ loop)
```

Round 1 opens with Castle Select; the castle walls are auto-built before play begins. Each subsequent round loops Cannon → Battle → Build. Wall Build is the **closing** phase of every round — scoring, tower revival, and life checks are finalized there. The game ends when only one player remains, or when the round limit is reached.

### Configurable Settings

| Setting | Options |
|---------|---------|
| Game mode | Classic, Modern |
| Difficulty | Easy, Normal (scales build timer, cannon placement timer, and round-1 cannon count) |
| Battle length (max rounds) | 3, 5, 8, 12, or "To The Death" (∞) |
| Cannon durability | 3, 6, 9, or 12 HP |
| Lobby wait timer (online only) | 0–120s before auto-start (default 60) |

---

## Phase 1: Castle Select

**Timer**: 16 seconds. Any player who hasn't confirmed when the timer expires is auto-confirmed on their currently-highlighted tower (defaulting to the zone's first candidate). The phase exits once all players have confirmed AND all castle-build animations have completed.

Each player selects one tower as their **home castle**. Towers can only be selected from the zone assigned to that player.

After all players confirm, the game auto-builds castle walls: a rectangular wall ring around the selected tower with an ideal 6×6 interior (gap of 2 tiles from tower edge on each side). The castle adapts to nearby water/edges by shrinking constrained sides and extending opposite sides to compensate.

**Clumsy builders**: After auto-building, random cosmetic noise is applied: ~1/10 chance per wall tile to sprout an adjacent tile, ~1/12 chance per corner to shift inward. Completely isolated stubs (0 wall neighbors) are swept away; tiles with 1+ neighbors are kept as valid bumps.

---

## Phase 2: Cannon Placement

**Timer**: 15 seconds. Ends when all players have filled their slots or the timer expires.

Players place cannons inside their enclosed territory (interior tiles only).

### Cannon Types

| Type | Size | Slot Cost | HP | Special |
|------|------|-----------|-----|---------|
| Normal cannon | 2×2 | 1 | Configurable (default 3) | Standard cannonball |
| Super gun | 3×3 | 4 | Configurable (default 3) | Fires incendiary cannonballs |
| Propaganda balloon | 2×2 | 3 | Immune (removed after battle) | Captures enemy cannon |
| Rampart (modern only) | 2×2 | 3 | Configurable (default 3) | Defensive structure — absorbs cannonball hits on nearby walls |

### Cannon Slot Allowance

**Round 1**: 3 slots for all players.

**Round 2+**: Total budget = slot cost of surviving alive cannons + newly awarded slots. New slots awarded:
- Home castle enclosed with alive tower: **2 new slots**
- Each additional enclosed alive tower: **1 new slot**

**After reselection** (lost a life): formula **replaces** the tower-based award above (a reselecting player has no cannons to carry over). New budget = `firstRoundCannons + livesLost` (where `firstRoundCannons` is difficulty-scaled: 4 Easy / 3 Normal / 2 Hard / 1 Very Hard). With 3 starting lives the 3rd loss eliminates the player, so `livesLost` is at most 2 — realized maximum is 6 (Easy, last-life reselect).

### Placement Rules

All tiles of the cannon must be:
- Inside the player's interior (enclosed territory)
- Not a wall, tower, existing cannon, or burning pit

### Propaganda Balloon Resolution

At the transition from Cannon Place to Battle, all placed balloons are resolved:

1. Each balloon targets the **most dangerous** enemy cannon. Priority: super guns first (large weight), then **highest HP** among same-type candidates.
2. Balloon **hit counts persist across battles** — a normal cannon needs 1 hit, a super gun needs 2. A single player can spread the hits required for a super gun across multiple rounds.
3. The cannon is **captured** in the round the threshold is crossed and immediately fires for the capturer in that battle.
4. Multiple players contributing balloon hits in the **same** deciding round → winner chosen randomly among that round's contributors. **Contributions from prior rounds do not grant claim** — only the deciding round's contributors are in the lottery (hit counts persist, but contributor lists reset every end-of-battle).
5. Balloon bases are removed after battle (one-time use).

### Grunt Spawning

From round 2 onward, at the end of cannon placement, each non-eliminated player has 2 chances of 10% each to have a grunt spawned in their zone.

In modern mode, each spawned grunt has a **25%** chance to be a **catapult** variant (slower, range-3 tower attack — see Modern Mode > Catapults).

---

## Phase 3: Battle

**Timer**: 10 seconds, preceded by a "Ready / Aim / Fire" countdown.

### Pre-Battle Setup

At the cannon-place → battle transition, before the countdown:

- Burning pits decay by 1 (pits at 0 are removed — see Burning Pits).
- Isolated walls are swept (one layer — see Wall Sweep).
- Bonus squares now covered by newly placed walls are removed.

### Firing

- Players aim and fire their cannons at enemy territory.
- Cannons must be **enclosed** (all tiles inside interior) to fire.
- Each cannon can have only **one cannonball in flight** at a time.
- Cannonball speed: 150 pixels/second.
- Cannon facing rotates smoothly toward the target (stored as a continuous angle).
- Each player has their own firing queue: own cannons first, then captured cannons (in capture order). Pressing fire advances that player's round-robin index to the next ready cannon in their queue. A captured cannon only fires when its capturer pulls the trigger.

### Impact Damage

| Target | Damage |
|--------|--------|
| Wall tile | Destroyed in 1 hit |
| Cannon (normal or super, including captured) | -1 HP per hit (destroyed at 0). Captured cannons take damage on their own HP like any other cannon |
| Tower | **Immune** to cannonballs (only grunts can destroy towers) |
| House | Destroyed in 1 hit; 50% chance to spawn a grunt |
| Grunt | Killed in 1 hit |
| Incendiary hit on wall | Also creates a burning pit |

### Burning Pits (Super Gun)

When an incendiary cannonball (from a super gun) destroys a wall tile, a **burning pit** is created:
- Lasts **3 battle rounds** (exists during the battle of creation and the next two)
- Blocks piece placement, cannon placement, and grunt movement
- Decays by 1 at the **start** of each subsequent battle — pits created mid-battle remain at full intensity through the closing build and the next cannon placement

### Grunts

Grunts **move during the build phase** (not during battle) and **attack during the battle phase**. Modern mode adds a **catapult** variant (slower siege grunt with a 3-tile tower-attack range) — the rules below describe the regular grunt; catapult differences are summarized in Modern Mode > Catapults.

#### Targeting

- Each grunt locks onto the nearest alive tower **in its zone** and never retargets (even if the tower dies).
- Grunts never cross rivers.

#### Movement (Build Phase)

Grunts move 1 tile per second during the build phase:

- Movement priority: forward (reduces distance to target) > sideways (doesn't increase distance on moving axis).
- Sorted by distance to target (closest first) to avoid self-blocking.
- Cannot move onto towers, other grunts, enclosed territory, or impassable obstacles.
- Walls, cannons (alive or dead), houses, towers, and burning pits block movement.
- Once adjacent to the target tower, grunts **stay put** - unless a same-target grunt is blocked nearby (within 2 tiles), in which case the adjacent grunt slides along the tower perimeter to an unoccupied adjacent tile, creating natural encirclement.
- Once adjacent to a dead target tower (distance ≤ 1 to 2×2 footprint), grunts stop.
- When fully blocked by walls (no forward or sideways move available), a grunt paces back-and-forth between two adjacent tiles rather than freezing — this keeps the wall-attack eligibility live and produces visible motion.

#### Tower Attacks (Battle Phase)

- A grunt adjacent to an alive tower starts a **3-second attack timer**.
- When the timer reaches 0, the tower is **destroyed** (HP set to 0).
- Timer resets if the grunt moves away.
- Only one tower is attacked at a time.

#### Wall Attacks (Battle Phase, blocked grunts)

- At each battle's end, the `blockedRounds` counter updates per grunt:
  - Target alive **and** grunt in attack range → counter resets to 0.
  - Target alive **and** grunt not in attack range → counter += 1.
  - Target dead → counter **frozen** (no change; the grunt stays put).
- "Attack range" is adjacency (Manhattan distance 1) for regular grunts and Manhattan distance ≤ 3 for catapults — a catapult parked behind a 2-deep cannon row is **not** blocked.
- At the **start** of the next battle, one roll per eligible grunt: 25% chance to attack an adjacent wall. Eligibility: `blockedRounds ≥ 2` AND target tower still alive AND a wall is adjacent. (The Sapper modifier bypasses both the count requirement and the roll.)
- Wall attack uses the same 3-second timer; destroys one wall tile closest to the target tower.
- **Catapults bypass this roll entirely** when a wall lies in their line of fire — they siege the wall directly every tick they're in range. See Modern Mode > Catapults.

### End of Battle

1. Grunt blocked-battle counters are updated.
2. Balloon captures are cleared (one battle only).
3. Balloon hit counters are cleaned up for destroyed cannons; capturerIds reset for non-captured cannons (hit counts persist).
4. All balloon bases are removed.
5. If round 1 had no shots fired: spawn 2 grouped grunts per player (idle penalty).
6. Territory is reclaimed.
7. Round counter increments.
8. Bonus squares are replenished.

---

## Phase 4: Wall Build (Repair)

**Timer**: 25 seconds. Wall Build is the closing phase of every round; round 1 has no opening Wall Build phase (the auto-built castle from Castle Select fills that role).

Players place Tetris-like wall pieces to repair or extend their fortifications.

### Pieces

13 piece shapes, drawn from a weighted bag system:

| Tier | Pieces | Early rounds | Late rounds |
|------|--------|-------------|-------------|
| Simple (tier 1) | 1×1, 1×2, 1×3, Corner | High weight | Low weight |
| Medium (tier 2) | T, L, J, S, SR | Low weight | Medium weight |
| Hard (tier 3) | C, Z, ZR, + | Not available | High weight |

Weights interpolate linearly from "early" (round 2) to "late" (round 8+). Each player has their own bag; when exhausted, it refills. Simple pieces are drawn first, hard pieces last. **Relief**: after building the tiered queue, each simple piece has a 30% chance to be swapped into the harder section, so occasional easy pieces appear among the hard ones.

Pieces can be **rotated** 90° clockwise. They always start in their widest orientation.

### Placement Rules

A piece can be placed if **every tile** of the piece:
- Is on grass
- Is within the player's zone
- Does not overlap any player's walls, towers, cannons, grunts, or burning pits

### Territory Claiming (Inverse Flood-Fill)

After each piece placement, territory is recalculated:

1. Flood from map edges through non-wall tiles to find "outside"
2. Everything not outside and not a wall = **interior** (territory)
3. A tower is **owned** if all 4 of its tiles are interior or wall

### Houses

- Placing a wall on a house **destroys** it and spawns a grunt near the location targeting the player who destroyed it.
- Enclosing a house also destroys it and spawns 1 grunt on **each opponent's** zone.

### Grunts Enclosed by Walls

Grunts caught inside enclosed territory are killed (awards 16 points). Each has a **50% chance** to respawn, distributed evenly across enemy zones (round-robin).

### End of Build Phase

When the timer expires:
1. **Isolated wall sweep**: Wall tiles with ≤1 orthogonal wall neighbor are removed (one layer).
2. Territory is reclaimed with end-of-build-phase flag.
3. **Territory points** are awarded (see Scoring).
4. **Castle bonus** is awarded (see Scoring).
5. **Tower revival** check (see Towers).
6. **Life check**: Any player who does not enclose at least one alive tower loses a life.

---

## Towers

- **Size**: 2×2 tiles.
- **State**: Alive or dead (boolean). A grunt destroys a tower in one attack (after a 3-second timer).
- **Immunity**: Cannonballs have no effect on towers; only grunts can destroy them.
- **Ownership**: A tower is owned if all 4 tiles are inside a player's interior or walls.

### Tower Revival (Delayed)

Dead towers can be revived by enclosing them, but it takes **two consecutive build phases**:

1. **First build phase** where a dead tower is enclosed → marked as **pending**.
2. **Second build phase** where the same tower is still enclosed → **revived**.
3. If no longer enclosed at the second build phase → pending status is removed.

---

## Lives & Elimination

- Each player starts with **3 lives**.
- A life is lost when a player **fails to enclose any alive tower** at the end of a build phase.
- When a life is lost (but lives remain):
  - A **continue/abandon dialog** appears over the player's zone. Players choose with confirm (continue) or rotate (abandon) keys, or click the buttons. The dialog times out after 10 seconds (auto-continue).
  - If the player continues:
    - All walls, interior, cannons, and owned towers are cleared.
    - The player enters **Castle Reselection**: they pick a new home tower and walls are rebuilt with the construction animation.
    - Their zone is reset: grunts, houses, and burning pits are cleared; all towers in the zone are restored to full HP.
    - Cannon allowance after reselection: `firstRoundCannons + livesLost` (difficulty-scaled `firstRoundCannons`, same formula as the Cannon Slot Allowance section above; naturally bounded — `livesLost` ≤ 2, so no fixed cap is applied).
  - If the player abandons: they are immediately eliminated.
- When lives reach 0: the player is **eliminated**.
- **Game ends** in either of two cases:
  - **Last player standing**: 0 or 1 alive players remain after the closing round. The lone survivor wins. (Degenerate 0-alive case: highest score across all players, including eliminated.)
  - **Round limit reached**: closing round equals the configured `maxRounds`. **Winner = highest score among alive players only.** Eliminated players cannot win while any opponent is still alive; remaining-life count doesn't break ties — only score does.
- **Score tiebreak (current behavior):** on an exact score tie among eligible candidates, the lowest-slot player wins (Red > Blue > Gold by slot order). This is a placeholder — a shared-victory or sudden-death rule is on the wishlist.
- **Game-over short-circuit:** if a closing round triggers game-over, the life-lost continue/abandon dialog is **suppressed** for the player(s) who would have seen it. GAME_END fires after the score overlay; `state.round` is left at the closing round (not incremented).

---

## Scoring

### Destruction Points (awarded during battle)

| Action | Points |
|--------|--------|
| Destroy enemy wall tile | 2 |
| Kill a grunt (shooting or enclosing) | 16 |
| Destroy enemy cannon | 16 |

### Territory Points (awarded at end of build phase)

Based on number of interior tiles, tiered:

| Interior tiles | Points |
|---------------|--------|
| ≥ 100 | 1000 |
| ≥ 81 | 900 |
| ≥ 64 | 800 |
| ≥ 49 | 700 |
| ≥ 36 | 600 |
| ≥ 25 | 500 |
| ≥ 16 | 400 |
| ≥ 9 | 300 |
| ≥ 4 | 200 |
| ≥ 1 | 100 |

### Castle Bonus (awarded at end of build phase)

Based on "castle units" enclosed (home castle = 2 units, each other alive tower = 1 unit):

| Castle units | Points |
|-------------|--------|
| 1 | 500 |
| 2 | 700 |
| 3 | 900 |
| 4 | 1000 |
| 5 | 1200 |
| 6+ | 1400 |

### Bonus Squares

Flashing green diamonds on the map. When enclosed by a player's territory:

**Points** = `floor(10 × √(territorySize) / 100) × 100`, clamped to 100–1000.

Replenished immediately after capture.

---

## Wall Sweep

**Isolated wall tiles** (with ≤1 orthogonal wall neighbor) are removed **twice per round**:

- At the end of cannon placement (revealed at battle start, alongside burning-pit decay).
- At the end of wall build (deferred — revealed under the next round's cannons banner).

Each pass peels **one layer**: tiles newly exposed by the removal survive until the next pass. This cleans up debris fragments without dissolving thin walls in a single tick.

---

## Zone Mechanics

- Each player is assigned a zone (determined by their home tower's zone).
- **Pieces can only be placed within the player's zone.**
- Grunts target towers within their zone and never cross rivers.
- When a player loses a life, their entire zone is reset (grunts removed, houses removed, burning pits removed, all towers restored).

---

## Modern Mode

Modern is an optional ruleset selected per match (immutable once the match starts). It layers four capabilities on top of the classic rules: environmental **modifiers**, between-round **upgrades**, battle **combos**, and the **catapult** grunt variant. Classic disables all four.

### Modified Phase Flow

```
CASTLE_SELECT → CANNON_PLACE → [MODIFIER_REVEAL] → BATTLE → [UPGRADE_PICK] → WALL_BUILD
  (round 1)         ↑                                                              │
                    └──────────────────────────────────────────────────────────────┘
                                        (round 2+ loop)
```

Bracketed phases are conditional:

- **MODIFIER_REVEAL** — a 2-second banner shown before Battle whenever a modifier rolled. Modifier rolls start at round 3 with a 65% chance per round; a modifier never repeats consecutively. The roll happens at the CANNON_PLACE → BATTLE transition, **after** cannon placement closes — so players do **not** know during cannon placement whether (or which) modifier will fire. The first signal is the reveal banner.
- **UPGRADE_PICK** — inserted before Wall Build from round 3 onward (skipped in the final round). Each player picks 1 of 3 offered upgrades; controls are Left/Right to move focus, Confirm to lock in, or click/tap a card directly. The 15-second timer is shared across all players. Any player who hasn't chosen when the timer expires is auto-assigned a random offer.

### Modifiers

One modifier may roll each round from round 3 onward (65% chance, no consecutive repeats, weighted random draw from 13 implemented). Pool weights are tiered like upgrades: **Common ×3, Uncommon ×2, Rare ×1** — the most match-defining modifiers (Fog of War, Sapper, Frostbite, Sinkhole, Frozen River) appear least often. Most clear at the end of the battle; **Frozen River**, **High Tide**, and **Low Water** persist for the round and clear at the next Cannon Place transition; **Sinkhole** terrain changes are permanent.

| Modifier | Rarity | Effect |
|----------|--------|--------|
| Wildfire | Common | Elongated burn scar (~10 tiles), destroys walls/grunts/houses/bonus squares |
| Rubble Clearing | Common | All dead cannon debris and burning pits are removed from the map |
| Low Water | Common | Shallow river-edge tiles become grass for one round, expanding buildable land |
| Supply Ship | Common | Three neutral cargo ships sail the river — sink one for a hidden one-round bonus |
| Grunt Surge | Uncommon | Spawns 6–10 extra grunts distributed across alive towers |
| High Tide | Uncommon | River widens 1 tile, flooding banks and destroying structures. Recedes next round |
| Dust Storm | Uncommon | All cannonballs gain ±15° angle jitter on launch |
| Dry Lightning | Uncommon | Random grass tiles ignite as burning pits without needing wall destruction |
| Frozen River | Rare | Water tiles become traversable by grunts; thawed by cannonball impact |
| Sinkhole | Rare | Cluster of grass tiles permanently collapses into water, destroying structures |
| Fog of War | Rare | Thick fog covers every merged castle during battle — aim from memory |
| Frostbite | Rare | Grunts spawn as ice cubes — fully immobile and require two hits to break |
| Sapper | Rare | Grunts attack any adjacent wall on sight — no blocked-rounds requirement |

**Supply Ships** (the Supply Ship modifier): 3 neutral cargo ships (2 HP each) sail the river arms toward the junction during battle. Sink one with cannonballs to claim its **hidden one-round bonus**, rolled at spawn from four types: **extra cannon slot**, **+5s build time** (same as Master Builder), a **mortar shot**, or a **small-pieces bag bias**. The bonus goes to the player who lands the killing hit and is consumed the following round; any ship still afloat auto-sinks as the battle ends.

### Upgrades

From round 3 onward (and not in the final round), each non-eliminated player is offered **3 upgrades** during UPGRADE_PICK. Offers are drawn from a weighted pool (Common ×3, Uncommon ×2, Rare ×1) using the synced RNG. Effects last for one round — through the closing Wall Build, the next Cannon Place, and the next Battle — and reset before the following round's upgrade pick. (**Salvage is the exception**: its banked slots persist past expiry and are spent at the cannon-place *after* the upgrade is gone — see the entry below.)

| Category | Upgrade | Effect |
|----------|---------|--------|
| Battle | Mortar | Slow cannon, 3×3 splash (2 HP at center), creates burning pits |
| Battle | Rapid Fire | Cannonballs travel 2× faster |
| Battle | Ricochet | Cannonballs bounce twice after impact |
| Battle | Shield Battery | Cannons in home castle region are immune for one battle |
| Battle | Rapid Emplacement | Next cannon costs 1 fewer slot (min 1) |
| Build | Reinforced Walls | Walls take 2 hits to destroy (one battle) |
| Build | Master Builder | +5s exclusive build time (see below) |
| Build | Small Pieces | Only simple pieces (1×1, 1×2, 1×3, corner) |
| Build | Double Time | +10s build time for all players |
| Build | Architect | Each piece placed may overlap up to 1 of the placer's own wall tiles (enemy walls still block) |
| Build | Foundations | Walls can be placed on burning pits |
| Build | Reclamation | Dead cannon debris auto-cleared at build start |
| Build | Restoration Crew | One dead tower revives immediately when enclosed |
| Build | Entomb | All players can bury grunts under placed walls |
| Strategic | Territorial Ambition | Territory points doubled at end of build |
| Strategic | Conscription | When the owner **shoots** a grunt dead, 75% chance to respawn it on a random enemy zone (does not trigger on enclosure-kills — those follow the base 50% respawn rule) |
| Strategic | Salvage | While active, each enemy-cannon kill banks +1 future-cannon slot (cap 2 banked per player). The bank persists across upgrade expiry and is consumed at the **next** cannon-place phase (typically the round after the kills, when Salvage itself is no longer owned). Bank then resets to 0 |
| One-use | Ceasefire | Skip the next battle phase |
| One-use | Supply Drop | 2 free cannons bypassing slot limit |
| One-use | Second Wind | Revive all towers for all players |
| One-use | Demolition | Strip all non-load-bearing walls (can merge castles) |
| One-use | Erosion | Sweep one layer of exposed walls from every player |
| One-use | Clear the Field | Remove all grunts from the map |

**Master Builder** special-cases by owner count: **1 owner** gets a +5s *exclusive* build window (other players are locked out during it). **2+ owners** cancel the lockout — instead, +5s is added to every player's timer.

### Combos

During battle, chained destruction earns bonus points on top of base destruction scoring. The combo tracker is per-player and resets each battle.

| Trigger | Bonus |
|---------|-------|
| Wall hit within 1.5s of the previous wall hit (streak of 3+) | +50 per additional wall |
| Grunt kill within 1.5s of the previous grunt kill (streak of 2+) | +75 per additional grunt |
| Enemy cannon destroyed | +100 (every kill — no streak required, stacks on the 16 base destruction points → 116 total) |
| 5+ walls destroyed in one battle | +150 demolition bonus (awarded at end of battle) |

Wall and grunt streak windows reset if the next hit lands outside the 1.5-second window.

### Catapults

A grunt variant rolled per spawn (25%) that fires from up to **3 tiles away** from the target tower — the design counter to a deep cannon row in front of a tower.

| Field | Regular grunt | Catapult |
|-------|---------------|----------|
| Movement speed | 1 tile / second | 1 tile / 2 seconds (skips every other tick) |
| Tower-attack range | Adjacent (Manhattan ≤ 1) | Manhattan ≤ 3 (= up to 2-tile gap) |
| Wall-attack trigger | Random 25% per battle after 2 blocked rounds | Deterministic — any wall in the line of fire is sieged every tick |
| Mesh | Olive tank, turret + horizontal barrel | Weathered olive chassis, wooden launcher arm + iron payload bucket (40° pitch) |

**Line of fire** is the canonical Manhattan path from catapult to the nearest tile of its target tower (greater-axis-first). Cannons in the path do **not** block the shot — that's the whole point — but a wall on the path diverts the catapult to siege the wall. Once that wall is destroyed the catapult re-evaluates next tick: either the path is clear (attack tower) or another wall is up next.

Attack countdown is the same 3 seconds whether attacking a tower or a wall. The countdown resets when the target switches so a freshly-routed siege doesn't insta-destroy a wall with leftover timer from a prior target.

For the "blocked" counter that gates the regular-grunt wall-attack roll, a catapult parked at Manhattan ≤ 3 from its target is **not** blocked even if it's nowhere near adjacent. The catapult doesn't accumulate `blockedRounds` from a successful range-3 standoff.

---

## AI Players

Any player slot not controlled by a human is run by an AI opponent. In local play, slots that no one joins default to AI. In online play, unfilled slots are also AI-controlled.

### AI Behavior

AI players go through every phase automatically:

- **Castle Select**: The AI browses 1–3 towers before confirming a selection.
- **Wall Build**: Continuously places pieces to maximize enclosed territory, fill gaps, and avoid creating trapped pockets. A phantom piece shows where the AI will place next.
- **Cannon Place**: Places a mix of normal cannons, super guns, and propaganda balloons to best use available slots.
- **Battle**: Selects targets (walls, cannons, grunts), animates the crosshair smoothly toward each target, pauses briefly, then fires. Picks the next target while the cannonball is in flight.
- **Upgrade Pick** (modern mode): Auto-picks from the 3 offers after a 1.5-second decision delay.

### AI Skill Levels

AI difficulty is tied to the global difficulty setting:

- **Cursor speed**: Higher difficulty = faster crosshair movement. Skilled AIs move the cursor at double speed when far from the target and slow down near it.
- **Anticipation**: Higher-level AIs pre-select the next target while the current cannonball is still in flight.

### Visual Cues

- **Phantom pieces/cannons**: Ghosted previews show what the AI is about to place.
- **Crosshair animation**: The AI crosshair moves smoothly rather than snapping, so you can see where it's aiming.
- **Orbital countdown**: During the battle countdown, AI crosshairs orbit around their first target.

### Life Lost

When an AI player loses a life, it auto-continues after 2 seconds (no player input required).

---

## Online Multiplayer

One player hosts the game; others join with a room code.

### Hosting a Game

1. Select **Create** from the online menu.
2. Configure settings:
   - **Rounds**: 3, 5, 8, 12, or "To The Death" (infinite).
   - **Cannon HP**: 3, 6, 9, or 12.
   - **Lobby wait timer**: 0–120 seconds before auto-start (default 60).
3. A **4-letter room code** is generated and displayed on screen, along with a QR code for quick mobile joining.
4. Share the code with other players.

### Joining a Game

1. Select **Join** from the online menu.
2. Enter the 4-letter room code (case-insensitive).
3. In the waiting room, click a player slot to claim it.
4. Unclaimed slots become AI players when the game starts.

### Lobby & Starting

- A countdown timer shows "Starting in Xs".
- Any player can press their confirm key to signal readiness.
- The game starts when the timer expires or all players have confirmed.

### Spectators

If all 3 slots are taken or a player joins mid-game, they enter **spectator mode**:

- Full view of the live game: pieces, cannons, grunts, battle animations.
- Opponent crosshairs and phantom piece previews are visible.
- Spectators cannot interact with the game.

### Host Migration

If the host disconnects:

1. The server promotes the next available human player to host.
2. If no humans are available, an AI or spectator is promoted.
3. An announcement is shown ("You are now the host" or "Host migrated to [name]").
4. The game continues with no interruption.

### Disconnection

- When a player disconnects, the remaining players see an announcement and the game continues.
- Spectator disconnections have no impact on the game.
- If a non-host player loses connection mid-match, the client attempts **automatic reconnection** with exponential backoff: up to 3 attempts at 1s / 2s / 4s delays. A "Reconnecting…" announcement is shown during attempts. On successful reconnect, the client resumes from the latest checkpoint and the announcement clears.
- If all 3 reconnect attempts fail, the game stops on that client with a "Disconnected" message. The remaining peers continue.
- Reconnect is not attempted from the lobby or from a stopped session, or by the host (host migration handles host loss instead).
