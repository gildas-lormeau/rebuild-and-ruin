# Rebuild & Ruin — Domain Specification

Reverse-engineered from the implementation. Describes *what* the system does, not *how*.

---

## 1. Domain Glossary

### 1.1 Battlefield (Geography)

| Term | Definition |
|------|-----------|
| **Map** | A rectangular tile grid (44x28) composed of grass and water tiles, containing towers, houses, zones, a junction, and exits. Generated once per match from a seed. |
| **Tile** | The atomic unit of the map. Either grass (buildable, traversable) or water (impassable barrier). |
| **Zone** | An isolated land region separated by rivers. Each zone is assigned to one player. No cross-zone interaction for grunts, walls, or pieces — only cannonballs cross zone boundaries. |
| **River** | Water tiles dividing the map into zones. Acts as impassable barrier for ground units and wall placement. Can be frozen (modern mode). |
| **Junction** | The point where rivers meet (visual landmark). |
| **Exit** | Edge points where rivers flow off the map (visual landmark). |
| **Tower** | A 2x2 indestructible structure placed during map generation. Can be alive or dead. Belongs to a zone. A dead tower can be revived if enclosed by walls for two consecutive build phases. |
| **Castle** | A walled perimeter automatically built around a player's chosen home tower. Defines the player's starting territory. |
| **House** | A single-tile destructible structure on the map. When destroyed by a cannonball, has a 50% chance of spawning a grunt. |
| **Bonus Square** | Special tiles (3 per zone) that award extra points when enclosed in territory. |

### 1.2 Player

| Term | Definition |
|------|-----------|
| **Player** | A participant in the match, identified by a slot (1-4). Has a home tower, castle, owned towers, walls, interior territory, cannons, lives, score, and (in modern mode) upgrades. |
| **Player Slot** | A numbered seat (1-4) that a player occupies. Determines zone assignment and turn order. |
| **Home Tower** | The tower a player selected as their base. Determines castle location and default cannon facing. |
| **Owned Towers** | All towers currently enclosed by a player's walls. More towers = more cannon slots. |
| **Lives** | A player starts with 3 lives. Loses 1 when failing to enclose any tower at the end of a build phase. At 0 lives, the player must choose to continue or forfeit. |
| **Elimination** | A player is eliminated when they lose all lives and choose not to continue (or fail to reselect a castle). Eliminated players no longer participate. |
| **Score** | Accumulated points from territory size, castle bonuses, wall/grunt/cannon destruction. Tiered by interior size (SNES scoring table). |
| **Default Facing** | The initial angle cannons point — toward the enemy, computed at castle creation. |

### 1.3 Fortification (Walls & Territory)

| Term | Definition |
|------|-----------|
| **Wall** | A tile placed by a player during the build phase. Walls form the boundary for territory calculation. Can be damaged (reinforced walls upgrade) or destroyed by cannonballs/grunts. |
| **Castle Wall** | The initial wall perimeter built automatically around a home tower. Protected from debris sweep. |
| **Territory (Interior)** | All tiles fully enclosed by a player's walls, computed by flood-fill from map edges (interior = not-outside, not-wall). Used for scoring, cannon placement eligibility, and grunt blocking. |
| **Piece** | A tetromino-like shape (1-5 tiles) drawn from a bag during the build phase. 13 distinct shapes, drawn in difficulty-weighted random order that gets harder over rounds. Pieces can be rotated. |
| **Piece Bag** | A shuffled pool of pieces. Simple pieces (1x1, 1x2, corner) are drawn first, complex pieces (Z, plus, C) later. Pool composition interpolates from easy (round 2) to hard (round 8+). Relief: some simple pieces are scattered into the hard section. |
| **Damaged Wall** | A wall that has absorbed one hit (reinforced walls upgrade). A second hit destroys it normally. Cleared at build phase start. |

### 1.4 Artillery

| Term | Definition |
|------|-----------|
| **Cannon** | A player-placed weapon (2x2 normal, 3x3 super, 2x2 balloon). Has HP (default 3, configurable). Placed during cannon phase on owned territory. Dead cannons persist as debris. |
| **Normal Cannon** | Standard 2x2 cannon. Fires regular cannonballs. Costs 1 cannon slot. |
| **Super Cannon** | A 3x3 cannon that fires incendiary cannonballs (creates burning pits on impact). Costs 4 cannon slots. |
| **Balloon (Propaganda)** | A 2x2 cannon that fires propaganda balloons to capture enemy cannons. Costs 3 cannon slots. 1 hit captures a normal cannon; 2 hits capture a super cannon. |
| **Cannonball** | A projectile in flight, traveling from a cannon to a target at a fixed speed (150 px/s, or 2x with Rapid Fire). Has a firing player and optionally a different scoring player (when cannon was captured). |
| **Captured Cannon** | An enemy cannon taken over by propaganda balloon hits. The capturer receives scoring credit for its shots. Capture lasts one battle round. Balloon hit counts accumulate across battles. |
| **Cannon Slot** | The budget for placing cannons. Determined by number of owned towers. Special cannons cost multiple slots. |
| **Crosshair** | The aiming cursor during battle. Each player has one. Moved by input or AI strategy. |
| **Cannon Rotation** | Cannons fire in round-robin order through the player's combined cannon list (own + captured). |

### 1.5 Ground Forces

| Term | Definition |
|------|-----------|
| **Grunt** | A ground enemy unit that targets a specific player's towers. Spawned from destroyed houses (50% chance), between battles, or by grunt surge modifier. |
| **Grunt Target** | A grunt locks onto a tower and moves toward it. No retargeting after the target tower is killed — the grunt stays put. |
| **Grunt Attack** | When adjacent to a target tower (or wall, if blocked long enough), a grunt starts a 3-second attack countdown. |
| **Blocked Grunt** | A grunt that can't reach its target (walls in the way). After 2+ consecutive blocked rounds, has 25% chance per battle to attack a wall tile instead. |
| **Grunt Movement** | Grunts pace back-and-forth when blocked by walls. Distance is computed to nearest tile of 2x2 tower (not just top-left corner). Grunts only move within their victim's zone (unless river is frozen). |

### 1.6 Hazards

| Term | Definition |
|------|-----------|
| **Burning Pit** | A fire hazard left by super cannon incendiary impact. Blocks wall placement on the tile. Lasts 3 battle rounds, then expires. |
| **Impact** | Visual flash effect at the point where a cannonball hit (0.3s duration). |

### 1.7 Game Flow

| Term | Definition |
|------|-----------|
| **Match** | A complete game from lobby to game-over. Settings (rounds, difficulty, mode) are immutable. |
| **Round** | One cycle through build → cannon → battle. The game lasts 3/5/8/12 rounds or "to the death." |
| **Phase** | A discrete game state: CASTLE_SELECT, WALL_BUILD, CANNON_PLACE, or BATTLE. CASTLE_SELECT is re-entered between rounds when a player loses lives (reselect cycle); the cycle type is derived from `state.round` (1 vs >1), not a separate phase tag. |
| **Phase Timer** | A countdown timer governing phase duration (e.g., 25s build, 15s cannon, 10s battle). Difficulty-scaled. |
| **Battle Countdown** | A 6-second pre-battle sequence (Ready 3s + Aim 2s + Fire! 1s) before combat begins. |
| **Banner** | A 3-second visual sweep between phases announcing the next phase. |
| **Difficulty** | Four levels (Easy/Normal/Hard/Very Hard) that scale build timer, cannon timer, and first-round cannon count. |

### 1.8 Modern Mode

| Term | Definition |
|------|-----------|
| **Game Mode** | Classic (original Rampart rules) or Modern (environmental modifiers + upgrades). Set at match start, immutable. |
| **Modifier** | An environmental event that alters the battlefield between rounds (from round 3, 65% chance). No repeat of last round's modifier. |
| **Wildfire** | Modifier: burns grass tiles, blocking placement. |
| **Crumbling Walls** | Modifier: randomly destroys existing wall tiles. |
| **Grunt Surge** | Modifier: spawns extra grunts on the map. |
| **Frozen River** | Modifier: water tiles become traversable by grunts. Thawed by cannonball impact. |
| **Upgrade** | A per-player power-up drafted between rounds (from round 3, modern mode only). 3 offered, 1 picked. Weighted rarity (common/uncommon/rare). Some persist, some are one-use. |
| **Master Builder** | Upgrade: +5s exclusive build time. When exactly one player owns it, opponents are locked out for 5s. When 2+ own it, no lockout. |
| **Rapid Fire** | Upgrade: cannonballs travel at 2x speed. |
| **Reinforced Walls** | Upgrade: walls absorb one hit before being destroyed. One-use (lasts one round). |
| **Combo** | Modern-mode scoring streak for consecutive hits within a time window (wall streaks, grunt kill streaks). |

### 1.9 Multiplayer

| Term | Definition |
|------|-----------|
| **Room** | A multiplayer game session identified by a short code. Has settings, a seed, and player slots. |
| **Lobby** | The pre-game state where players join a room, pick slots, and wait for the game to start. 15-second countdown after enough players join. |
| **Host** | The authoritative player running game logic. Computes state, sends checkpoints. |
| **Watcher** | A non-host client that receives state updates and renders them. Recomputes timer from wall-clock time. |
| **Checkpoint** | A full state snapshot sent at phase boundaries for client reconciliation (select start, build start, cannon start, battle start, build end, game over). |
| **Host Migration** | When the host disconnects, the server promotes another player to host. The new host sends a full state snapshot to all watchers. |
| **Seed** | A number that deterministically generates the map and drives the shared RNG. Ensures all clients produce the same map and random events. |

### 1.10 Controllers & Input

| Term | Definition |
|------|-----------|
| **Controller** | The decision-making interface for a player — either human (input-driven) or AI (strategy-driven). Phase-scoped: selection, build, cannon, and battle sub-interfaces. |
| **Human Controller** | Receives keyboard/mouse/touch input. Returns intents (FireIntent, PlacePieceIntent) that the orchestrator executes. |
| **AI Controller** | Computes strategy decisions (target selection, piece placement, cannon placement, battle aim). Idle countdown wobble is rendered natively by the local controller. |
| **Intent** | A declarative action request (fire at target, place piece at position). Controllers produce intents; the runtime/orchestrator executes mutations against game state. |
| **Input Receiver** | Human-specific input handling: key matching, piece rotation, placement attempts, cannon mode cycling. |

### 1.11 Presentation

| Term | Definition |
|------|-----------|
| **Viewport** | The visible portion of the map (tile-pixel coordinates). Supports zoom and pan. Auto-zooms to player's zone during gameplay, unzooms at phase end or during overlays. |
| **Sound System** | Audio feedback: phase transitions, battle events, piece placement, fanfare, background music. Two levels: phase-only or all sounds. |
| **Haptics System** | Vibration feedback for game events. Two levels: phase changes only or all events. |
| **Frame Context** | Per-frame identity and state flags: current player, mode, phase, overlay status, camera directives. |

---

## 2. Event-Command Narratives

### 2.1 Match Lifecycle

```
LOBBY
  Player → Creates room (settings: rounds, cannon HP, difficulty, mode, seed)
  Server → Assigns room code
  Player → Joins room, picks slot
  Server → Broadcasts player joined
  Timer expires OR enough players →
    Server → Sends Init (seed, settings)
    → CASTLE_SELECT

CASTLE_SELECT
  Each player → Highlights a tower in their zone
  Each player → Confirms tower selection
  System → Builds castle walls around each selected tower (animated)
  System → Computes initial territory
  → WALL_BUILD (round 1)

[Round loop begins]

WALL_BUILD
  [Modern: If upgrade round → UPGRADE_PICK first]
  System → Generates piece bag for current round
  Each player → Places tetromino wall pieces before timer expires
  [Modern: Master Builder → opponents locked out for first 5s if single owner]
  Grunts → move toward target towers (1 tile/sec; pace back-and-forth if blocked)
  System → Sweeps isolated walls (batch collect-then-delete, one layer per player)
  System → Recomputes territory (flood-fill)
  System → Scores territory (tiered points + castle bonus)
  System → Checks tower enclosure:
    - Enclosed dead towers → marked "pending revive"
    - Previously pending towers still enclosed → revived
  System → Checks if each player encloses at least one tower
    - No tower enclosed → player loses a life
    - 0 lives → LIFE_LOST_DIALOG
  → CANNON_PLACE (or CASTLE_SELECT for a reselect cycle if any player needs reselection)

CANNON_PLACE
  System → Computes cannon slot limits (based on owned towers)
  Each player → Places cannons on owned territory (normal/super/balloon)
  [Round 1: auto-place if player placed none]
  System → Flushes remaining auto-placements
  System → Initializes cannons for battle
  → BATTLE

BATTLE
  [Pre-battle setup (cannon → battle transition)]:
    System → Decays burning pits (remove expired)
    System → Sweeps isolated walls (second sweep per cycle)
    System → Recomputes territory
    System → Spawns inter-battle grunts (round 2+)
    [Modern: System → Rolls modifier (round 3+, 65% chance), applies effect]
    System → Rolls grunt wall attacks for blocked grunts
  System → Plays countdown (Ready / Aim / Fire! — 6s)
  [10s battle timer]
  Each player → Aims crosshair, fires cannons (round-robin through cannon list)
  Cannonballs in flight → resolved on impact:
    - Hit wall → wall destroyed (or damaged if reinforced)
    - Hit cannon → cannon takes damage (destroyed at 0 HP)
    - Hit house → house destroyed, 50% grunt spawn
    - Hit grunt → grunt killed
    - Hit frozen tile → tile thawed
    - Super cannon hit → creates burning pit
    - Balloon hit → accumulates toward cannon capture
  Grunts → attack target tower when adjacent (3s countdown; do not move during battle)
  [Blocked grunts may attack walls after 2+ rounds blocked]
  Timer expires →
    [Post-battle cleanup (battle → build transition)]:
    [Modern: System → Awards combo bonuses]
    System → Updates grunt blocked counts
    System → Resolves balloon captures, clears captured cannons
    System → Removes balloon launchers from cannon lists
    [Round 1: spawns punishment grunts if no shots were fired]
    System → Increments round counter
    [Modern: System → Generates upgrade offers (round 3+)]
    System → Resets one-round upgrades (reinforced walls, damaged walls)
  → WALL_BUILD (next round) or GAME_OVER (if max rounds reached)

CASTLE_SELECT (reselect cycle, after life loss; round > 1)
  Player who lost life → Selects a new tower
  System → Builds new castle walls
  → Return to normal phase flow

LIFE_LOST_DIALOG
  System → Presents continue/forfeit choice (auto-resolves after 10s)
  Player → Chooses to continue (→ CASTLE_SELECT reselect cycle) or forfeit (→ eliminated)

UPGRADE_PICK (modern mode, round 3+)
  System → Generates 3 upgrade offers per player (weighted random, no dupes)
  Each player → Picks one upgrade
  → WALL_BUILD continues

GAME_OVER
  System → Determines winner (highest score among non-eliminated)
  System → Displays final scores
```

### 2.2 Scoring Events

| Event | Points |
|-------|--------|
| Territory enclosure | 100-1000 (tiered by area: 1-100+ tiles) |
| Castle bonus | 500-1400 (by number of castle units enclosed) |
| Wall destroyed | 2 per tile |
| Grunt killed | 16 |
| Cannon destroyed | 16 |
| Bonus square enclosed | (extra territory contribution) |
| [Modern] Combo streaks | Bonus for consecutive hits within time window |

### 2.3 Tower Revival Sequence

```
Round N build end:
  Dead tower enclosed → marked "pending revive"
Round N+1 build end:
  Still enclosed → tower revived (alive again)
  No longer enclosed → pending status removed
```

---

## 3. Key Invariants

1. **Zone isolation**: Walls, pieces, grunts, and territory cannot cross rivers. Only cannonballs cross zone boundaries.
2. **Deterministic RNG**: All gameplay randomness uses a seeded RNG. Same seed = same game (given same inputs).
3. **Intent-execute separation**: Controllers produce intents; only the orchestrator mutates game state.
4. **Checkpoint reconciliation**: At each phase boundary, the host sends a full state snapshot. Watchers reconcile from it.
5. **Host authority**: The host computes all game logic. Watchers render from received state. Host migration preserves continuity.
6. **Cannon debris**: Dead cannons remain on the map as obstacles. Only cleared on zone reset.
7. **Territory = flood-fill complement**: Interior is computed as "not reachable from map edges without crossing walls."
8. **Delayed tower revival**: Requires enclosure for two consecutive build phases.
9. **No grunt retargeting**: Once a grunt's target tower is killed, it stays put.
10. **Modern mode atomicity**: gameMode and modernState are always set together.
11. **Pool pattern exhaustiveness**: Extension point registries (upgrades, cannon modes, modifiers) enforce compile-time exhaustiveness — every ID in the type union must have a pool entry.
12. **Balloon hit accumulation**: Balloon hit counts persist across battles (cumulative toward capture threshold). Captured cannons and capturerIds are cleared each battle.
