# Domain Analysis — Spec vs. Implementation

## Step 1: Abbott's Noun Extraction

Nouns extracted from the spec, classified by type:

### Candidate Aggregates (rich state + behavior)
- **Player** — walls, territory, cannons, lives, score, upgrades
- **Map** — tiles, towers, houses, zones, bonus squares (immutable after generation)
- **Grunt** — position, target, attack state, blocked count

### Candidate Entities (identity + lifecycle)
- Tower, Castle, House, Cannon, Cannonball, BurningPit, CapturedCannon, BonusSquare

### Candidate Value Objects (no identity, defined by attributes)
- Tile, TilePos, PieceShape, Zone (index), Crosshair, Impact, CannonSlot, Viewport

### Candidate Services / Processes (verbs → operations)
- Territory computation (flood-fill), Scoring, Piece bag generation
- Cannon firing (round-robin), Grunt movement, Grunt spawning
- Castle construction, Wall sweep, Tower revival check
- Modifier rolling, Upgrade offering/drafting, Combo tracking
- Checkpoint serialization, Host migration

### Candidate Domain Events
- PiecePlaced, WallDestroyed, CannonFired, CannonDamaged, CannonCaptured
- GruntSpawned, GruntKilled, TowerKilled, TowerRevived, HouseDestroyed
- PitCreated, TileThawed, LifeLost, PlayerEliminated
- PhaseChanged, RoundStarted, GameOver
- ModifierApplied, UpgradePicked, ComboTriggered
- RoomCreated, PlayerJoined, HostMigrated, CheckpointSent

---

## Step 2: DDD Bounded Context Analysis

Events cluster into 10 natural bounded contexts:

### BC1: Battlefield Geography
*Entities*: Map, Tile, Zone, Tower, House, BonusSquare, River, Junction, Exit
*Events*: MapGenerated, ZonesAssigned
*Nature*: **Genesis context** — created once from seed, immutable thereafter.
All other contexts read from it but never write to it.

### BC2: Fortification
*Aggregates*: Player's walls + territory + castle
*Entities*: Wall, Castle, CastleWall, DamagedWall, Piece, PieceBag
*Events*: PiecePlaced, TerritoryRecomputed, CastleBuilt, WallDestroyed, WallDamaged
*Key rule*: Territory = flood-fill complement of walls from edges.
*Coupled to*: BC1 (map tiles), BC5 (burning pits block placement)

### BC3: Artillery
*Aggregates*: Player's cannons + captured cannons
*Entities*: Cannon (Normal/Super/Balloon), Cannonball, CapturedCannon, CannonSlot
*Events*: CannonPlaced, CannonFired, CannonballImpact, CannonDamaged, CannonCaptured
*Key rule*: Round-robin firing. Balloon hits accumulate across battles.
*Coupled to*: BC2 (placement requires territory), BC4 (hits create impacts on walls)

### BC4: Ground Forces
*Entities*: Grunt
*Events*: GruntSpawned, GruntMoved, GruntAttackedTower, GruntAttackedWall, GruntKilled
*Key rules*: No retargeting. Blocked pacing. Wall attack after 2+ blocked rounds.
*Coupled to*: BC1 (zones, towers), BC2 (walls block movement), BC5 (frozen rivers)

### BC5: Environmental Hazards
*Entities*: BurningPit, FrozenTile
*Events*: PitCreated, PitExpired, TileFrozen, TileThawed
*Nature*: **Cross-cutting** — affects BC2 (placement), BC4 (movement), BC3 (super cannon creates pits)

### BC6: Game Flow (Orchestration)
*Entities*: Match, Round, Phase, PhaseTimer, BattleCountdown, Difficulty
*Events*: PhaseChanged, RoundStarted, TimerExpired, LifeLost, PlayerEliminated, GameOver
*Key rules*: Phase loop, life check at build end, delayed tower revival, scoring
*Nature*: This is the **core orchestrator** — it drives all other contexts.

### BC7: Modern Mode Extensions
*Entities*: Modifier, Upgrade, Combo
*Events*: ModifierRolled, ModifierApplied, UpgradeOffered, UpgradePicked, ComboTriggered
*Key rules*: No repeat modifier. 65% roll chance from round 3. Upgrade draft pick.
*Nature*: **Extension of BC6** — adds alternate rules to the phase loop.

### BC8: Multiplayer Infrastructure
*Entities*: Room, Lobby, Host, Watcher, Checkpoint, Seed
*Events*: RoomCreated, PlayerJoined, PlayerLeft, HostMigrated, CheckpointSent, FullStateRecovered
*Key rules*: Host authority, checkpoint reconciliation, migration continuity.
*Nature*: **Infrastructure** — orthogonal to game rules.

### BC9: Player Control (Adapters)
*Entities*: Controller (Human/AI), Intent (Fire/PlacePiece), InputReceiver
*Events*: IntentProduced, InputReceived, CrosshairMoved
*Nature*: **Adapter** — translates human input or AI strategy into domain intents.

### BC10: Presentation
*Entities*: Viewport, SoundSystem, HapticsSystem, Banner, Impact (visual)
*Events*: FrameRendered, SoundPlayed, HapticFired
*Nature*: **Output adapter** — consumes domain events, produces sensory output.

---

## Step 3: Context Map (relationships)

```
BC1 Battlefield Geography ←── read by all
       │
       ▼
BC2 Fortification ◄──────── BC6 Game Flow (orchestrates build phase)
       │                         │
       ▼                         ▼
BC3 Artillery ◄──────────── BC6 Game Flow (orchestrates cannon + battle phases)
       │                         │
       ▼                         ▼
BC4 Ground Forces ◄─────── BC6 Game Flow (grunt ticks during battle)
       │                         │
       ▼                         │
BC5 Env. Hazards ◄──cross-cutting (affects BC2, BC3, BC4)
                                 │
BC7 Modern Extensions ──────────┘ (plugs into BC6 phase loop)

BC8 Multiplayer ── wraps BC6 (same game flow, different transport)

BC9 Player Control ──► BC6 (produces intents consumed by orchestrator)

BC10 Presentation ◄── BC6 + all (reads state, renders)
```

---

## Step 4: Comparison with Actual Architecture

### Derived contexts → Actual domains

| Derived Bounded Context | Actual Domain | Match? |
|------------------------|---------------|--------|
| BC1: Battlefield Geography | `shared/` (geometry-types, grid, spatial, map data) | Partial — mixed into shared |
| BC2: Fortification | `game/` (build-system, castle-build, castle-generation) + `shared/` (board-occupancy, pieces) | Split across shared + game |
| BC3: Artillery | `game/` (cannon-system, battle-system) + `shared/` (battle-types) | Split across shared + game |
| BC4: Ground Forces | `game/` (grunt-system, grunt-movement) | Good fit |
| BC5: Env. Hazards | `game/` (round-modifiers) + `shared/` (types, battle-types) | Correctly cross-cutting, not isolated |
| BC6: Game Flow | `game/` (phase-setup, game-engine, host-phase-ticks, host-battle-ticks, phase-transition-steps) + `runtime/` (runtime-phase-ticks, runtime-life-lost, runtime-selection) | Split across game + runtime |
| BC7: Modern Extensions | `game/` (combo-system, round-modifiers, upgrade-pick) + `shared/` (upgrade-defs, game-constants) | Integrated into game — not isolated |
| BC8: Multiplayer | `online/` + `server/` | Good fit |
| BC9: Player Control | `player/` + `ai/` + `input/` | Split into 3 domains |
| BC10: Presentation | `render/` + `input/` (sound, haptics) | Split — sound/haptics in input, not render |

### Key observations

**1. `shared/` is not a bounded context — it's a dependency inversion layer.**
The spec analysis would never produce a "shared" context. What `shared/` contains is *the type vocabulary* consumed by all contexts. In DDD terms, this is closest to a **Shared Kernel** — but it's much larger than a typical shared kernel. It contains:
- Pure types (geometry-types, battle-types, player-types, types) → should belong to their respective BCs
- Infrastructure (rng, grid, utils) → genuinely shared
- Contracts (system-interfaces) → anti-corruption layer definitions
- Domain logic (board-occupancy, spatial, pieces) → should be in BC2 (Fortification)

**Verdict**: `shared/` is doing double duty — part shared kernel, part misplaced domain logic.

**2. `game/` conflates 4+ bounded contexts.**
The `game/` domain contains BC2 (fortification), BC3 (artillery), BC4 (ground forces), BC5 (hazards), BC6 (orchestration), and BC7 (modern extensions) — all in one flat directory. The spec analysis would separate these.

**Verdict**: `game/` is the right *layer* (game logic), but it doesn't reflect domain boundaries internally.

**3. The layer system compensates for flat domain structure.**
The 18-layer import hierarchy does what subdomain boundaries would normally do — it prevents cannons from depending on build logic, grunts from depending on cannon logic, etc. The layering is *mechanically enforcing* what bounded contexts would *architecturally express*.

**Verdict**: The layer system is doing the job of subdomain isolation through import rules rather than directory boundaries. This works — but it means the architecture is encoded in tooling config (`.import-layers.json`) rather than visible in the file tree.

**4. `runtime/` vs `game/` split is an orchestration boundary, not a domain boundary.**
The spec would place phase orchestration (BC6) as a single context. The implementation splits it: pure game rules in `game/`, state management + lifecycle in `runtime/`. This is actually a *clean technical split* (pure vs. effectful) that the spec-driven analysis wouldn't produce — but it's arguably better than what the spec suggests.

**Verdict**: This split has no domain justification but has strong engineering justification. Good pragmatic choice.

**5. Controller split (ai/ + player/ + input/) matches the spec's adapter pattern.**
BC9 (Player Control) in the spec is one context, but the implementation separates AI strategy, human controllers, and raw input handling. This maps well to the Ports & Adapters pattern: `input/` is the port (raw events), `player/` and `ai/` are adapters (translate to intents).

**Verdict**: More granular than the spec suggests, but correctly motivated.

**6. Sound/haptics in `input/` is debatable.**
The spec clusters them with Presentation (BC10), but the implementation puts them in `input/`. They share the input domain boundary — `input/` is really "human I/O" (input + feedback), not just "input."

**Verdict**: Naming is slightly misleading, but the grouping is defensible as "human interface."

**7. Extension point registries and the battle event catalog add mechanical exhaustiveness.**
Three extension points (upgrades in `upgrade-defs.ts`, cannon modes in `cannon-mode-defs.ts`, modifiers in `modifier-defs.ts`) use a pool pattern: a type union defines valid IDs, a pool array maps each ID to metadata, and a compile-time `PoolComplete` check ensures every union member has a pool entry. Adding a new ID without a matching entry is a type error.

The battle event catalog (`.battle-event-catalog.json`) maps each `BattleEvent`/`ImpactEvent` union member to its consumer files by role (stateApply, sound, haptics, networkHandle, networkRelay, orchestrator, combo). A pre-commit linter verifies exhaustiveness — adding a new event type without updating the catalog fails the commit.

**Verdict**: These are mechanical guardrails that the spec-derived analysis wouldn't produce — they enforce cross-cutting consistency (every new game concept must declare its handlers) without relying on directory boundaries or import layers. They narrow the gap between the flat `game/` structure and what bounded contexts would provide.

---

## Summary

| Aspect | Spec-Derived Architecture | Actual Architecture | Assessment |
|--------|--------------------------|--------------------|----|
| Top-level split | 10 bounded contexts | 8 domains + shared | **Comparable** — different cuts, similar count |
| Geography isolation | Own BC | Dissolved in shared | **Spec is cleaner** — but geography is immutable, so low coupling risk |
| Game rules granularity | 4 BCs (fortification, artillery, grunts, hazards) | 1 domain (`game/`) | **Spec is more expressive** — actual uses layers to compensate |
| Orchestration | 1 BC (game flow) | Split game/ + runtime/ | **Actual is better** — pure/effectful split has engineering value |
| Modern mode | Separate BC | Integrated in game/ | **Correct integration** — too small to justify isolation overhead |
| Multiplayer | Own BC | online/ + server/ | **Both good** — actual correctly separates client from server |
| Controllers | 1 adapter BC | 3 domains (ai, player, input) | **Actual is better** — finer-grained adapters |
| Presentation | 1 BC | render/ + sound in input/ | **Actual is practical** — I/O grouping is defensible |
| Shared kernel | Small type vocabulary | Large `shared/` directory | **Spec is leaner** — actual shared/ carries domain logic |
| Isolation mechanism | Directory boundaries | Layer rules + domain config | **Different but equivalent** — layers are mechanically enforced |
| Cross-cutting consistency | Bounded context contracts | Pool registries + battle event catalog + pre-commit linters | **Actual adds mechanical exhaustiveness** — compile-time and commit-time checks catch incomplete additions |

### Bottom line

The architecture you have is not what a from-scratch DDD analysis would produce — but it's not worse. The differences fall into three categories:

1. **Shared kernel size**: `shared/` is larger than a pure DDD analysis would recommend. Domain logic like board-occupancy and pieces would live in their respective bounded contexts. But since TypeScript doesn't have module visibility, and the layer system prevents upward imports, this is a non-issue in practice.

2. **game/ is flat**: A spec-driven design would sub-divide `game/` into fortification, artillery, ground forces. Your layer system achieves the same isolation mechanically. The trade-off: file tree doesn't reveal the structure, but `.import-layers.json` enforces it.

3. **runtime/ split is better than the spec**: The pure-rules vs. effectful-orchestration split is an engineering insight that domain analysis alone wouldn't produce. This is where implementation experience adds value over theoretical analysis.

**The implementation's architecture is a pragmatic, mechanically-enforced equivalent of what DDD would prescribe.** The layer system is doing the heavy lifting that bounded context boundaries would normally do. Extension point registries (pool pattern with compile-time exhaustiveness) and the battle event catalog (with pre-commit linting) add a second layer of mechanical enforcement — ensuring that new domain concepts declare their cross-cutting handlers. The main thing missing is visibility — someone reading the file tree doesn't see "fortification" and "artillery" as concepts, they see "game" and "shared."
