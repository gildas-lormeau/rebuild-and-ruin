# Rebuild & Ruin - Game Rules

A multiplayer Rampart remake for the web. Up to 3 players compete on a battlefield divided by rivers, building walls, placing cannons, and battling to control territory.

---

## Map

- **Grid**: 42 columns × 28 rows.
- **Terrain**: Grass (buildable) and Water (impassable).
- **River**: A Y-shaped river divides the map into **3 zones** of roughly equal size. Generated via Bezier curves from a central junction to 3 map edges; 3 tiles wide.
- **Towers**: 12 total (4 per zone), each occupying 2×2 tiles. Placed via farthest-point sampling with minimum 4-tile gap between towers and a safe zone around each.
- **Houses**: 8 per zone initially, 1×1 tiles. Placed on grass with a 1-tile margin from water and towers, minimum 3-tile Manhattan distance between houses. Houses are spawned after castle construction (visible from the cannon phase onward). Zones are refilled to 8 houses at the start of each build phase when below that count.
- **Bonus squares**: 3 per zone, placed on open (non-enclosed) grass with a 1-tile gap from borders/river and minimum 3-tile Manhattan distance from each other. Replenished after any are captured.

---

## Game Flow

```
CASTLE_SELECT → WALL_BUILD → CANNON_PLACE → BATTLE
                    ↑                           │
                    └───────────────────────────┘
```

The game loops through Build → Cannon → Battle until one player remains or the round limit is reached.

### Configurable Settings

| Setting | Options |
|---------|---------|
| Battle length (max rounds) | 3, 5, 8, 12, or "To The Death" (∞) |
| Cannon durability | 3, 6, 9, or 12 HP |

---

## Phase 1: Castle Select

Each player selects one tower as their **home castle**. Towers can only be selected from the zone assigned to that player.

After all players confirm, the game auto-builds castle walls: a rectangular wall ring around the selected tower with an ideal 6×6 interior (gap of 2 tiles from tower edge on each side). The castle adapts to nearby water/edges by shrinking constrained sides and extending opposite sides to compensate.

**Clumsy builders**: After auto-building, random cosmetic noise is applied: ~1/10 chance per wall tile to sprout an adjacent tile, ~1/12 chance per corner to shift inward. Completely isolated stubs (0 wall neighbors) are swept away; tiles with 1+ neighbors are kept as valid bumps.

---

## Phase 2: Wall Build (Repair)

**Timer**: 25 seconds (first round: 0 seconds, walls are auto-built).

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

## Phase 3: Cannon Placement

**Timer**: 15 seconds. Ends when all players have filled their slots or the timer expires.

Players place cannons inside their enclosed territory (interior tiles only).

### Cannon Types

| Type | Size | Slot Cost | HP | Special |
|------|------|-----------|-----|---------|
| Normal cannon | 2×2 | 1 | Configurable (default 3) | Standard cannonball |
| Super gun | 3×3 | 4 | Configurable (default 3) | Fires incendiary cannonballs |
| Propaganda balloon | 2×2 | 3 | Immune (removed after battle) | Captures enemy cannon |

### Cannon Slot Allowance

**Round 1**: 3 slots for all players.

**Round 2+**: Existing alive cannons carry over. New slots awarded:
- Home castle enclosed with alive tower: **2 new slots**
- Each additional enclosed alive tower: **1 new slot**

**After reselection** (lost a life): `min(3 + livesLost, 8)` new slots.

### Placement Rules

All tiles of the cannon must be:
- Inside the player's interior (enclosed territory)
- Not a wall, tower, existing cannon, or burning pit

### Propaganda Balloon Resolution

At the transition from Cannon Place to Battle, all placed balloons are resolved:

1. Each balloon targets the **most dangerous** enemy cannon (super guns strongly preferred, ties broken by HP).
2. Balloon hits **accumulate across battles** - a normal cannon needs 1 hit, a super gun needs 2.
3. When enough hits accumulate, the cannon is **captured**: it fires for the capturer during battle.
4. Multiple players contributing balloon hits → winner chosen randomly among contributors.
5. Balloon bases are removed after battle (one-time use).

### Grunt Spawning

From round 2 onward, at the end of cannon placement, each non-eliminated player has 2 chances of 10% each to have a grunt spawned in their zone.

---

## Phase 4: Battle

**Timer**: 10 seconds, preceded by a "Ready / Aim / Fire" countdown.

### Firing

- Players aim and fire their cannons at enemy territory.
- Cannons must be **enclosed** (all tiles inside interior) to fire.
- Each cannon can have only **one cannonball in flight** at a time.
- Cannonball speed: 150 pixels/second.
- Cannon facing snaps to **45° increments** toward the target.
- Captured cannons are appended to the capturer's firing queue (after their own cannons) and fire in the same round-robin order.

### Impact Damage

| Target | Damage |
|--------|--------|
| Wall tile | Destroyed in 1 hit |
| Cannon (normal or super) | -1 HP per hit (destroyed at 0) |
| Tower | **Immune** to cannonballs (only grunts can destroy towers) |
| House | Destroyed in 1 hit; 50% chance to spawn a grunt |
| Grunt | Killed in 1 hit |
| Incendiary hit on wall | Also creates a burning pit |

### Burning Pits (Super Gun)

When an incendiary cannonball (from a super gun) destroys a wall tile, a **burning pit** is created:
- Lasts **3 battle rounds**
- Blocks piece placement, cannon placement, and grunt movement
- Decays by 1 round at the end of each battle

### Grunts

Grunts **move during the build phase** (not during battle) and **attack during the battle phase**.

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

#### Tower Attacks (Battle Phase)

- A grunt adjacent to an alive tower starts a **3-second attack timer**.
- When the timer reaches 0, the tower is **destroyed** (HP set to 0).
- Timer resets if the grunt moves away.
- Only one tower is attacked at a time.

#### Wall Attacks (Battle Phase, blocked grunts)

- At each battle's end, grunts that were blocked (not adjacent to their alive target tower) increment a `blockedBattles` counter.
- At the start of the next battle, grunts blocked for **≥2 battles** with an adjacent wall have a **25% chance** to attack that wall.
- Wall attack uses the same 3-second timer; destroys one wall tile closest to the target tower.

### End of Battle

1. Grunt blocked-battle counters are updated.
2. Balloon captures are cleared (one battle only).
3. Balloon hit counters are cleaned up for destroyed cannons; capturerIds reset for non-captured cannons (hit counts persist).
4. All balloon bases are removed.
5. If round 1 had no shots fired: spawn 2 grouped grunts per player (idle penalty).
6. Territory is reclaimed.
7. Round counter increments.
8. Bonus squares are replenished.

> **Note**: Burning pits decay at the **start** of each battle (not at the end), so pits created during a battle remain at full intensity through the repair and cannon phases.

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
  - A **continue/abandon dialog** appears over the player's zone. Human players choose with confirm (continue) or rotate (abandon) keys, or click the buttons. AI players auto-continue after 2 seconds. The dialog times out after 10 seconds (auto-continue).
  - If the player continues:
    - All walls, interior, cannons, and owned towers are cleared.
    - The player enters **Castle Reselection**: they pick a new home tower and walls are rebuilt with the construction animation.
    - Their zone is reset: grunts, houses, and burning pits are cleared; all towers in the zone are restored to full HP.
    - Cannon allowance after reselection: `min(3 + livesLost, 8)`.
  - If the player abandons: they are immediately eliminated.
- When lives reach 0: the player is **eliminated**.
- **Game ends** when only 1 player remains (that player wins), or when the round limit is reached (highest score wins).

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

At the end of both the build phase and cannon phase, **isolated wall tiles** (with ≤1 orthogonal wall neighbor) are swept away in a single batch pass. This cleans up debris fragments.

---

## Zone Mechanics

- Each player is assigned a zone (determined by their home tower's zone).
- **Pieces can only be placed within the player's zone.**
- Grunts target towers within their zone and never cross rivers.
- When a player loses a life, their entire zone is reset (grunts removed, houses removed, burning pits removed, all towers restored).

---

## AI Players

Any player slot not controlled by a human is run by an AI opponent. In local play, slots that no one joins default to AI. In online play, unfilled slots are also AI-controlled.

### AI Behavior

AI players go through every phase automatically:

- **Castle Select**: The AI browses 1–3 towers before confirming a selection.
- **Wall Build**: Continuously places pieces to maximize enclosed territory, fill gaps, and avoid creating trapped pockets. A phantom piece shows where the AI will place next.
- **Cannon Place**: Places a mix of normal cannons, super guns, and propaganda balloons to best use available slots.
- **Battle**: Selects targets (walls, cannons, grunts), animates the crosshair smoothly toward each target, pauses briefly, then fires. Picks the next target while the cannonball is in flight.

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
- If a non-host player loses connection, the game stops with a "Disconnected" message on their end.
