---
name: architecture-audit
description: Parallel multi-domain architecture audit focused on LLM-agent readability. Finds ambiguous naming, implicit conventions, divergent patterns, large functions, and magic values.
user-invocable: true
---

# Architecture Audit

Parallel multi-domain review focused on making the codebase easy for LLM-based coding agents to work with correctly. An LLM agent that reads these files should be able to understand intent, find the right place to make changes, and produce code that follows existing patterns — without hallucinating wrong field names, missing guards, or placing logic in the wrong file.

Complements `/code-review` which works per-pass on a scoped file set.

## Repo reality

This repository has, so far, been authored and heavily refactored by LLM-based agents. There is little or no reliable "human team folklore" to fall back on. The practical source of truth is the combination of code comments, architectural config files, lint scripts, tests, and skills like this one.

Audit with that in mind:
- Prioritize places where an agent would have to infer behavior from scattered examples instead of from one explicit contract.
- Treat drift between docs, scripts, and code as a high-value finding, because future agents will optimize against whichever source looks most authoritative.
- Favor fixes that make intent machine-legible: narrower types, better names, extracted helpers, stronger comments, and executable checks.
- Do not assume a divergence is intentional just because it has existed for a while; agent-written code can preserve accidental patterns very effectively.

## Domain clusters

Each domain is a group of tightly related files that share responsibility for a subsystem.
Domains map to the 19 layer groups in `.import-layers.json` (L0–L18), with small layers
combined and large layers (>10 files) split into sub-domains at audit time.

### 1. Leaf utilities — L0 (21 files)
```
src/ai/ai-constants.ts, src/shared/canvas-layout.ts, src/shared/game-constants.ts,
src/shared/grid.ts, src/shared/jsfxr.d.ts, src/shared/platform.ts, src/shared/rng.ts,
src/runtime/router.ts, src/online/online-dom.ts, src/shared/upgrade-defs.ts,
src/shared/settings-defs.ts, src/shared/player-slot.ts, src/shared/game-phase.ts,
src/shared/ui-mode.ts, src/shared/input-action.ts, src/shared/render-spy.ts,
src/shared/utils.ts, src/online/online-config.ts, src/shared/dialog-types.ts,
src/shared/checkpoint-data.ts, server/send-utils.ts
```

### 2. Derived constants + geometry + pieces — L1 + L2 (5 files)
```
src/shared/geometry-types.ts, src/shared/theme.ts, src/shared/player-config.ts,
src/shared/settings-ui.ts, src/shared/pieces.ts
```

### 3. Core game types — L3 (5 files)
```
src/shared/battle-types.ts, src/shared/types.ts, src/shared/player-types.ts,
src/shared/phantom-types.ts, server/protocol.ts
```

### 4. Game state & orchestration — L4 (11 files)
```
src/shared/spatial.ts, src/shared/board-occupancy.ts, src/shared/system-interfaces.ts,
src/shared/overlay-types.ts, src/shared/tick-context.ts, src/game/life-lost.ts,
src/game/upgrade-pick.ts, src/game/castle-build.ts, src/game/phase-banner.ts,
src/game/phase-transition-steps.ts
```

### 5. Online infrastructure — L5 (5 files)
```
src/online/online-types.ts, src/online/online-lobby-ui.ts,
src/online/online-server-lifecycle.ts, src/online/online-session.ts,
server/game-room.ts
```

### 6. Runtime primitives — L6 (11 files)
```
src/input/input-touch-update.ts, src/runtime/runtime-state.ts,
src/runtime/runtime-banner.ts, src/runtime/runtime-human.ts,
src/runtime/runtime-types.ts, src/runtime/runtime-camera.ts,
src/runtime/runtime-score-deltas.ts, src/runtime/runtime-upgrade-pick.ts,
src/runtime/runtime-game-lifecycle.ts, src/runtime/runtime-e2e-bridge.ts,
src/runtime/runtime-screen-builders.ts
```

### 7. Game logic — L7 (14 files)
```
src/game/cannon-system.ts, src/game/grunt-movement.ts,
src/game/grunt-system.ts, src/game/battle-system.ts, src/game/build-system.ts,
src/game/castle-generation.ts, src/game/map-generation.ts, src/game/phase-setup.ts,
src/game/combo-system.ts, src/game/round-modifiers.ts, src/game/game-engine.ts,
src/game/selection.ts, src/game/host-phase-ticks.ts, src/game/host-battle-ticks.ts
```

### 8. Phase orchestration — L8 (3 files)
```
src/runtime/runtime-phase-ticks.ts, src/runtime/runtime-life-lost.ts,
src/runtime/runtime-selection.ts
```

### 9. AI strategy — L9 (9 files)
```
src/ai/ai-build-types.ts, src/ai/ai-castle-rect.ts, src/ai/ai-build-score.ts,
src/ai/ai-build-fallback.ts, src/ai/ai-build-target.ts,
src/ai/ai-strategy-battle.ts, src/ai/ai-strategy-build.ts,
src/ai/ai-strategy-cannon.ts, src/ai/ai-strategy.ts
```

### 10. Controllers — L10 (8 files)
```
src/ai/ai-phase-select.ts, src/ai/ai-phase-build.ts,
src/ai/ai-phase-cannon.ts, src/ai/ai-phase-battle.ts,
src/ai/controller-ai.ts, src/player/controller-types.ts,
src/player/controller-human.ts, src/player/controller-factory.ts
```

### 11. Game bootstrap — L11 (2 files)
```
src/runtime/runtime-bootstrap.ts, src/runtime/runtime-headless.ts
```

### 12. Input & sound — L12 (9 files)
```
src/input/haptics-system.ts, src/input/input-recorder.ts, src/input/input-dispatch.ts,
src/input/input-touch-ui.ts, src/input/input-touch-canvas.ts, src/input/input-mouse.ts,
src/input/input-keyboard.ts, src/input/input.ts, src/input/sound-system.ts
```

### 13. Render — L13 (10 files)
```
src/render/render-sprites.ts, src/render/render-loupe.ts, src/render/render-effects.ts,
src/render/render-towers.ts, src/render/render-composition.ts, src/render/render-ui-theme.ts,
src/render/render-ui.ts, src/render/render-ui-settings.ts, src/render/render-map.ts,
src/render/render-canvas.ts
```

### 14. Runtime sub-systems — L14 (4 files)
```
src/runtime/runtime-input.ts, src/runtime/runtime-lobby.ts,
src/runtime/runtime-options.ts, src/runtime/runtime-render.ts
```

### 15. Online logic — L15 (12 files)
```
src/online/online-serialize.ts, src/online/online-full-state-recovery.ts,
src/online/online-send-actions.ts, src/online/online-checkpoints.ts,
src/online/online-watcher-battle.ts, src/online/online-watcher-tick.ts,
src/online/online-phase-transitions.ts, src/online/online-server-events.ts,
src/online/online-host-crosshairs.ts, src/online/online-host-promotion.ts,
src/online/online-stores.ts, server/room-manager.ts
```

### 16. Local runtime — L16 (2 files)
```
src/runtime/assembly.ts, src/runtime/runtime.ts
```

### 17. Online runtime — L17 (7 files)
```
src/online/online-runtime-game.ts, src/online/online-runtime-deps.ts,
src/online/online-runtime-session.ts, src/online/online-runtime-transition.ts,
src/online/online-runtime-promote.ts, src/online/online-runtime-ws.ts,
src/online/online-runtime-lobby.ts
```

### 18. Entry points & server — L18 (4 files)
```
src/entry.ts, src/main.ts, src/online-client.ts,
server/server.ts
```

## Execution

### Phase 1: Parallel domain audits

Spawn one Explore sub-agent per domain (up to 13 in parallel; split domains with >10 files into sub-domains first). Each agent receives this prompt template:

```
Read ALL files in this domain completely:
[file list]

Our primary goal is making this codebase easy for LLM-based coding
agents to work with correctly. An LLM agent that reads these files
should be able to understand intent, find the right place to make
changes, and produce code that follows existing patterns — without
hallucinating wrong field names, missing guards, or placing logic
in the wrong file.

Report findings in these categories:

1. AMBIGUOUS NAMING — identifiers whose meaning an LLM could easily
   misinterpret. E.g., a function called "update" that actually resets,
   a boolean whose true/false semantics are unclear, or two
   similarly-named functions with different behavior.

2. IMPLICIT CONVENTIONS — patterns that are followed consistently but
   never documented in types or comments. An LLM would need to see
   many examples to infer the rule. E.g., "always check isActive()
   before calling confirm()", or "this callback must be called
   exactly once."

3. DIVERGENT PATTERNS — places where two files handle the same concern
   differently for no clear reason. An LLM copying from file A would
   produce wrong code for file B. E.g., one handler destructures deps
   at the top, another accesses deps.X inline.

4. LARGE FUNCTIONS — functions over ~50 lines where an LLM might lose
   track of which variables are in scope or what the current branch
   handles.

5. MAGIC VALUES — literal numbers, strings, or enum values used
   without named constants, making it hard for an LLM to know what
   they represent.

6. SOURCE-OF-TRUTH DRIFT — docs, comments, scripts, and code disagree
    about the same rule. In an agent-maintained repo, this is more
    dangerous than a normal style inconsistency because later agents
    will confidently follow the wrong authority.

For each finding: file, line number, what the issue is,
severity (high/medium/low), and a concrete suggestion.
Do NOT make any edits. Only flag things where fixing them would
genuinely help an LLM agent write better code.
```

### Phase 2: Cross-domain audit

After all domain agents complete, spawn one Explore agent with all domain reports combined.
Domains 4 (11 files), 7 (14 files), 6 (10 files), 15 (12 files), and 13 (10 files) should be split into sub-domains at audit time to keep each agent under 10 files:

```
Given these domain audit findings:
[paste all domain reports]

Now check for CROSS-DOMAIN issues that would trip up an LLM agent:

1. AMBIGUOUS NAMING across domains — same name used for different
   things in different files, or different names used for the same
   concept. An LLM working in one domain would use the wrong
   identifier in another.

2. DIVERGENT PATTERNS across domains — same concern (guards, deps
   access, phase checks, error handling) handled differently in
   different domains. An LLM copying a pattern from domain A would
   produce wrong code in domain B.

3. IMPLICIT CONVENTIONS spanning domains — rules an LLM must follow
   when code in one domain calls into another (e.g., "always check
   eliminated before calling controller methods", "net context is
   optional and defaults to local-play no-ops"). These are easy to
   miss when only reading one domain.

4. SHARED TYPES used inconsistently — same interface/enum imported
   by multiple domains but with different field subsets or different
   type signatures (e.g., one domain uses `boolean`, another uses
   `boolean | undefined` for the same concept).

5. SOURCE-OF-TRUTH DRIFT across domains — one domain's comments,
    skills, or scripts describe a contract differently from another
    domain's actual code. Future agents will usually trust the more
    explicit artifact, not necessarily the correct one.

For each finding: which domains are involved, what the issue is,
severity, suggested fix. Do NOT make any edits.
```

### Phase 3: Triage

Present all findings (domain + cross-domain) to the user, ranked by severity. For each:
- What's wrong and where
- How it would cause an LLM agent to produce incorrect code
- Estimated fix effort (low/medium/high)
- Recommended action (fix now, defer, or ignore)

When two findings have similar severity, rank explicit source-of-truth drift above local style issues. In this repo, bad documentation or stale scripts mislead every later agent pass.

Ask the user which findings to fix. Then fix them one domain at a time, running `npm run build` and tests after each.

## When to run

- After implementing a non-trivial feature that touches multiple domains
- Periodically (every few weeks) as a health check
- When you suspect drift between local and online code paths
- Before major refactors to establish a clean baseline

## Tips

- Skip domains that were recently audited and had no findings
- The online domains (#5, #15) and runtime (#14, #16) are highest risk — they mirror local logic and drift silently
- Cross-domain findings are often more impactful than within-domain ones
- If a domain has >10 files, split it into sub-domains for the audit

## Known-documented patterns (do NOT report)

The following conventions are already well-documented in code comments. Agents should
NOT flag these as findings — they have been verified and the existing documentation is
sufficient for LLM agents to follow correctly.

1. **recheckTerritoryOnly vs finalizeTerritoryWithScoring** — game/build-system.ts:173 and 189-193
   explain the difference and when to use each. game/cannon-system.ts:269 documents the precondition.

2. **canPlaceCannon vs canPlacePiece validation difference** — game/build-system.ts:92-95 has
   `CONTRAST with canPlaceCannon()...Copying validation from one to the other produces wrong results.`
   game/cannon-system.ts:264-266 mirrors it. Both sides documented.

3. **RATE_LIMITED_TYPES cosmetic-only invariant** — game-room.ts:59-63 has
   `CRITICAL: Only cosmetic/display messages belong here. Adding a game-state message = DESYNC BUG`.

4. **HOST_ONLY and PHASE_GATES disjoint invariant** — game-room.ts:70-72 documents
   `Invariant: HOST_ONLY and PHASE_GATES are disjoint...Do NOT add a message to both sets.`

5. **applyImpactEvent leaves interior stale during battle** — game/battle-system.ts:222-226 JSDoc
   and lines 236-240 inline comment both explain this. game/grunt-system.ts:247 reinforces it.

6. **Wall snapshot MUST precede finalizeBuildPhase** — game/host-phase-ticks.ts:466-468 documents it;
   snapshotThenFinalize() at line 494-498 enforces it structurally with a full INVARIANT JSDoc.

7. **advancePhaseTimer is the ONLY way to advance phase timers** — shared/tick-context.ts:101-108
   has `INVARIANT: All phase timers MUST use this function. Never manually write accum.X += dt.`

8. **Canvas ctx.save()/ctx.restore() convention** — render/render-effects.ts:20-28 documents the full
   convention with code example. Applies across all render-* files.

9. **Checkpoint `capturePreState` ordering invariant** — online/online-checkpoints.ts:53 JSDoc
   explains capturePreState and the lifecycle at each function. online/online-phase-transitions.ts:105-107
   documents the ordering guarantee. runtime/runtime-phase-ticks.ts:165 has INVARIANT comment
   reinforcing that banner captures oldCastles BEFORE applyCheckpoint mutates state.
   Individual checkpoint apply functions have NO payload validation by design — the host
   is authoritative. Only full-state recovery (validateFullState in online/online-serialize.ts)
   validates, because that payload crosses a trust boundary during host promotion.

10. **`net` required on all tick deps interfaces** — runtime/runtime-phase-ticks.ts:5-9 documents
    `net is REQUIRED on all tick deps interfaces...the compiler enforces the choice.`

11. **`session.isHost` is volatile — never cache, always read via `isHostInContext()`** —
    online/online-session.ts:29-35 marks the field `VOLATILE` with full explanation of when it flips
    and how to read/write it. shared/tick-context.ts:87-88 repeats `VOLATILE...Never cache` on the
    accessor. game/host-phase-ticks.ts:12-13 says `never cache in a local variable`.
    online/online-server-events.ts:25-27 repeats the warning. ESLint `no-restricted-syntax` rule
    enforces all direct `.isHost` reads require an explicit disable comment.

12. **RNG consumption order before checkpoint is load-bearing for online sync** —
    game/phase-setup.ts:307 marks the block with `RNG consumption (BEFORE checkpoint — order is
    load-bearing for online sync)` and warns not to insert RNG calls after it.

13. **ScoringRule null vs 0 semantics** — ai/ai-build-types.ts:77-81 documents the interface
    contract (`null` = hard-reject, `0` = no opinion). ai/ai-build-score.ts:371 repeats the
    convention inline at the scoring loop.

14. **scoreCannonPosition returns negated score** — ai/ai-strategy-cannon.ts:291 JSDoc explains
    penalties are accumulated positive and negated on return so callers see higher = better.

15. **castle-build dt is in seconds, accum/interval are in ms** — game/castle-build.ts:37 JSDoc
    annotates `@param dt — delta time in SECONDS`, the `dt` field has an inline doc comment,
    and line 48 has an inline comment explaining the ×1000 conversion.

16. **Late-binding closure pattern (initDeps/initPromote/initWs)** —
    online/online-runtime-deps.ts:56-60 documents the 3-step pattern (declare, init, guard) and
    explains it avoids circular imports. All three init files follow the same structure.

17. **Mode-setting timing in watcher phase transitions** — online/online-phase-transitions.ts:53-61
    documents when setMode is called immediately vs inside banner callback for each phase type.

18. **AI vs human cursor movement models differ by design** — ai/controller-ai.ts:248-252
    and player/controller-human.ts:236-239 both warn not to copy between the two files.
    AI uses tile-step (Manhattan + jitter), human uses pixel-velocity (Cartesian).

19. **ROUNDS_TO_THE_DEATH_INDEX and CANNON_HP_DEFAULT_INDEX are array indices** —
    shared/settings-defs.ts documents both with JSDoc explaining they are indices into their
    respective option arrays, not the option values themselves.

20. **`simulatedOutside` naming is consistent across ai-build files** —
    ai/ai-build-fallback.ts and ai/ai-build-score.ts both use `simulatedOutside` for the
    outside set computed after simulating a candidate placement. CandidateEnv field matches.

21. **`resetBattlePhaseKeepOrbit` name clarifies orbit preservation** —
    ai/ai-phase-battle.ts:87 name makes clear that orbitAngle persists across resets.
    Contrast with `initBattle` which resets everything including chain state.

22. **AI tile-cursor movement constants are named** — ai/controller-ai.ts defines
    TILE_ARRIVAL_TOLERANCE, JITTER_DECAY_RATE, and JITTER_MAX_AMPLITUDE as named constants.

23. **Eliminated-player guard in keyboard dispatch is NOT missing** — keyboard's
    `handleKeyGame` calls `dispatchGameAction` (input/input-dispatch.ts:336) which has the
    eliminated check built in. Do not report this as a missing guard.

24. **Slot mutation atomicity is already enforced** — online/online-server-lifecycle.ts:82-101
    defines `clearLobbySlot()` and `occupyLobbySlot()` helpers with explicit invariant
    comments. All incremental slot mutations go through these helpers.

25. **Player-check guard order is documented and consistent** — online/online-server-events.ts:1-28
    documents three handler categories with explicit patterns (validPid → eliminated →
    isRemoteHumanAction). Every handler in the file follows the documented pattern.

26. **Coordinate system params are already named by space** — render/render-composition.ts uses
    `screenX`/`screenY` (canvas-pixel, with JSDoc), `canvasX`/`canvasY` (canvas-pixel),
    and `tileX`/`tileY` (game-space) consistently. Conversions are explicit inline.

27. **Phantom vs crosshair dedup strategies differ by design** — phantoms use explicit
    filter+push array replacement (online/online-server-events.ts:416 JSDoc). Crosshairs use
    DedupChannel's atomic shouldSend() via makeCrosshairDedupKey() (online/online-host-crosshairs.ts:41).
    Do not unify — they serve different network patterns (accumulated vs fire-and-forget).

28. **`optionsUI.returnMode` null=lobby (editable), non-null=in-game (read-only)** —
    runtime/runtime-state.ts OptionsUIState JSDoc documents the inverse semantics. shared/settings-ui.ts:114
    @param JSDoc repeats it. The value when non-null is the Mode to return to on close.

29. **`modeTickers` is exhaustively typed via `satisfies`** — runtime/runtime.ts:184 uses
    `satisfies Record<Exclude<Mode, Mode.STOPPED>, ...>` ensuring all tickable modes have
    a ticker. STOPPED is excluded by design (tickMainLoop returns early for it).
    Adding a new Mode without a corresponding ticker entry is a compile error.

30. **Two-tier server dispatch: lobby switch vs game validation pipeline** —
    server.ts:84-93 JSDoc explains lobby/room messages use a simple switch.
    game-room.ts:329-336 JSDoc explains in-game messages use a 6-stage validation
    pipeline. New game-state messages go in game-room.ts, not server.ts.

31. **Touch-suppression pairing: all click handlers MUST check `isTouchSuppressed()`** —
    input/input-mouse.ts:25-28 documents the convention. input/input-dispatch.ts:8-27 documents
    markTouchTime() pairing. Prevents synthetic click events that mobile browsers fire
    after touchend.

32. **`towerPendingRevive` naming is correct — "pending" means awaiting a condition** —
    shared/types.ts:251 JSDoc explains the two-phase rule. game/build-system.ts:452-454 JSDoc on
    `reviveEnclosedTowers` documents the mechanic. CLAUDE.md line 40 repeats it.
    "Pending" = awaiting one more build phase of enclosure, not awaiting user action.
    Do not rename to `towersAwaitingRevive` or `towersEligibleForRevive`.

33. **`FreshInterior` vs `ReadonlySet<number>` for interior is intentional** —
    `FreshInterior` (branded type, shared/types.ts:151) proves the interior was recomputed
    after the last wall mutation. `ReadonlySet<number>` is used in AI build code
    (ai/ai-build-types.ts, ai/ai-build-target.ts, ai/ai-castle-rect.ts) for simulated/hypothetical
    interiors constructed during candidate scoring. Do not unify — branding simulated
    interiors as fresh would defeat the type safety.

34. **`runtimeState` destructuring is intentionally non-uniform across sub-systems** —
    runtime/runtime.ts:10-16 documents the convention. Each createXSystem(deps) factory
    destructures only frequently-used deps at the top; rarely-used deps are accessed
    inline as `deps.X`. The inconsistency reflects actual usage, not drift.

35. **`comboTracker` lifecycle is transient during battle** — shared/types.ts:281 JSDoc says
    "transient during battle, not serialized". Created in `enterBattleFromCannon`
    (game/phase-setup.ts:273), nulled after awarding bonuses in `enterBuildFromBattle`
    (game/phase-setup.ts:289). Both sites are in the same file. The `| null` type enforces
    null checks at all access sites. Do not report the lifecycle as undocumented.

36. **MODIFIER_LABELS and MODIFIER_ID must stay in sync** — shared/game-constants.ts:30-37
    documents the invariant on both objects. Adding a modifier requires entries in both.

37. **Interior exclusion set in AI pickPlacement is intentional** —
    ai/ai-strategy-build.ts:485 documents why gaps and castle-rect tiles are excluded
    from the interior set during candidate scoring. Prevents penalizing gap-filling.

38. **`withPointerPlayer` callback may silently not execute** — input/input.ts:58-61 JSDoc
    explicitly warns that the callback is NOT invoked if no human players exist.

39. **`>>> 0` uint32 coercion in deriveAiStrategySeed** —
    online/online-host-promotion.ts:111 inline comment explains the idiom.

40. **Preset option sets for collectOccupiedTiles are documented** —
    shared/board-occupancy.ts:50-52 explains the preset pattern and its relationship
    to the collectOccupiedTiles function.

41. **`victimPlayerId` naming reflects the grunt's perspective** —
    ai/ai-strategy-battle.ts:591-593 JSDoc explains the parameter is the player
    being attacked, not the AI. The name is intentional.

42. **Tower identity check (===) in selection is intentional** —
    game/selection.ts:62-63 documents that tower refs are stable within a session.
    Online mode uses indices for serialization.

43. **Selection tick takes optional `state?` by design** — ai/ai-phase-select.ts:89
    documents that selection can tick without state during initial lobby setup.

44. **Socket validation inlined in online/online-lobby-ui.ts mirrors online/online-session.ts** —
    online/online-lobby-ui.ts:55 comment documents the parallel with isSocketOpen().

45. **Life-lost and upgrade-pick dialog ticks have parallel structure** —
    game/life-lost.ts:19 and game/upgrade-pick.ts cross-reference each other. Both loop
    entries for auto-resolve + force-resolve. The duplication is intentional.

46. **drawPanel/drawButton mutate canvas state — callers must save/restore** —
    render-ui-shared/theme.ts JSDoc on both functions documents the convention.

47. **HOME_GAP_REPAIR_THRESHOLD vs MANAGEABLE_GAP_LIMIT serve different decisions** —
    ai/ai-strategy-build.ts:68 and :76 JSDoc explains: threshold = deprioritize home tower,
    limit = skip target entirely. Both are gap counts but at different decision points.

48. **Modifier tuning constants are playtesting-calibrated** —
    game/round-modifiers.ts:71 block comment warns against adjusting multiple simultaneously.

49. **Fanfare note frequencies are musical constants** — input/sound-system.ts:587 comment
    documents G4=392, C5=523, E5=659, G5=784 Hz.

50. **isCannonPhaseDone measures different things per controller type** —
    shared/system-interfaces.ts:129-130 JSDoc documents that Human checks remaining
    slots, AI checks internal phase step. Both are correct.

51. **Canvas coordinate spaces documented in render/render-effects.ts** —
    render/render-effects.ts:20+ documents that all render-* positions are canvas-space
    unless parameter names indicate otherwise (screenX/Y, tileX/Y).

52. **pointerPhantomValid() three-way return is documented** —
    input/input-touch-update.ts JSDoc: true=valid, false=invalid, undefined=no phantom.

53. **Host interface pattern (SelectionHost, BuildHost, etc.) is documented** —
    ai/ai-phase-select.ts JSDoc above SelectionHost explains the convention:
    each ai-phase-*.ts defines a minimal Host interface for decoupling.

54. **capturePreState two-variant pattern in checkpoints** —
    online/online-checkpoints.ts:41-49 JSDoc documents both variants (delegated via
    applyCommonCheckpoint, and direct inline call). Both guarantee capturePreState
    runs before any player mutation.

55. **scaledDelay convention and typical ranges per phase** —
    ai/controller-ai.ts:154-161 JSDoc documents `(base + rng * spread) * delayScale`
    with typical ranges: selection 0.8–1.0s, build/cannon 0.2–0.3s, battle 0.1–0.2s.

56. **Null vs undefined convention in online-serialize** —
    online/online-serialize.ts:1-12 file header documents: `null` = always-present modern-mode
    fields, `undefined` = bandwidth-saving omitted per-entity enrichments.

57. **PASS 1 / PASS 2 controller dispatch pattern** —
    game/host-phase-ticks.ts:8-14 documents PASS 1 (per-frame, local only) vs PASS 2
    (phase end, all controllers). Finalization method differs by role and phase.

58. **Phantom key format (comma-separated, 1/0 booleans, : and ; separators)** —
    shared/shared/phantom-types.ts:70-81 JSDoc documents exact format for cannonPhantomKey
    (`row,col,mode,valid`) and piecePhantomKey (`row,col,valid,r0:c0;r1:c1;...`).

59. **Sound level guard convention (play() internal vs Web Audio entry)** —
    input/sound-system.ts:15-19 JSDoc documents three tiers: play() guards internally,
    Web Audio public methods guard at entry, internal helpers rely on caller guard.

60. **Upgrade weight constants (WEIGHT_COMMON/UNCOMMON/RARE)** —
    shared/upgrade-defs.ts:51-54 defines WEIGHT_COMMON=3, WEIGHT_UNCOMMON=2, WEIGHT_RARE=1.
    All UPGRADE_POOL entries use these constants.

61. **poolComplete compile-time exhaustiveness check** —
    shared/upgrade-defs.ts:42-49 JSDoc explains the PoolIds/PoolComplete pattern and the
    `void poolComplete` idiom for suppressing unused-variable warnings.

62. **Cannon boom voice mix ratios and named frequency constants** —
    input/sound-system.ts:209-221 defines CANNON_BASS_END_HZ, CANNON_MID_START/END_HZ,
    CANNON_BLAST_DURATION, CANNON_TAIL_DURATION, etc. Voice mix comment at line 312.

63. **Dialog get/set methods are for watcher-mode synchronization** —
    runtime-game/life-lost.ts:209-212 and runtime-game/upgrade-pick.ts:144-147 JSDoc explains
    get() reads state for watcher overlay, set() applies host-broadcast state.

64. **`onResolved` naming for dialog completion callbacks** —
    runtime/runtime-types.ts:287 uses `onResolved` (life-lost) matching the `on*` prefix
    convention. upgrade-pick uses `onDone` (passed at tryShow time, different lifecycle).

65. **Coordinate spaces documented in render/render-composition.ts** —
    render/render-composition.ts:8-12 documents screenX/screenY (canvas pixels),
    tileX/tileY (grid indices), and overlayCtx naming convention.

66. **OPTION_NAMES must match OPT_* constant order** —
    shared/settings-defs.ts:34-35 INVARIANT comment links OPTION_NAMES array to OPT_*
    constants. Reordering one without the other silently breaks UI display.

67. **`excludeBalloonCannons` is the canonical parameter name** —
    shared/board-occupancy.ts uses `excludeBalloonCannons` consistently across all public
    and internal functions. Do not use the abbreviation `excludeBalloon`.

68. **`REMOTE_CROSSHAIR_MULTIPLIER` follows the `_MULTIPLIER` suffix convention** —
    online/online-types.ts:21 uses `REMOTE_CROSSHAIR_MULTIPLIER` matching the rest of the
    codebase (CROSSHAIR_SPRINT_MULTIPLIER, CURSOR_PROXIMITY_MULTIPLIER, etc.).

69. **`ctx` shorthand destructuring from defaultClient is documented** —
    online/online-runtime-game.ts:67-69 comment explains the five destructured names
    reference the same defaultClient singleton used throughout the module.

70. **Lobby timer: local uses accumulator, online uses wall-clock subtraction** —
    main.ts:43-45 documents the local path (timerAccum counting up). The online
    path (online/online-runtime-game.ts:135-141) uses server-provided countdown minus a
    -1 grace offset to prevent UI/server race.

71. **Coordinate space divergence between options and lobby hit-tests is documented** —
    runtime/runtime-options.ts:221-224 documents that canvasX/Y are CSS pixels divided by
    SCALE before hit-tests. runtime/runtime-lobby.ts:87-89 documents that lobby passes raw
    CSS pixels (hit-tests handle TILE_SIZE internally). Both include CONTRAST comments.

72. **Remote human finalization differs between cannon and build — documented at function level** —
    game/host-phase-ticks.ts tickHostCannonPhase JSDoc (line 168+) and tickHostBuildPhase
    JSDoc (line 277+) both document the CONTRAST: cannon calls initCannons() on remotes,
    build skips remotes entirely. Inline CONTRAST comments at lines 250 and 472 reinforce.

73. **Zone validation constants hierarchy is documented** —
    game/map-generation.ts:26-35 block comment documents the 6-layer validation model
    (edge gap, safe zone, tower gap, zone count, zone balance, zone height).

74. **drawMap render layer order is documented** —
    render/render-map.ts:191-214 block comment lists all 19 render layers in order with
    rationale (scene layers affected by zoom, HUD layers at display resolution).

75. **drawImpacts phase boundaries are documented inline** —
    render/render-effects.ts drawImpacts() has phase markers: Phase 1 (0.0–0.25 core flash),
    Phase 2 (0.0–0.6 shockwave ring), Phase 3 (0.0–0.8 debris), Phase 4 (0.2–1.0 smoke).
    Constants at lines 75-78 define the thresholds.

76. **AI phase timing constants have `_SEC`, `_RAD_S`, `_PX` unit suffixes** —
    ai/ai-phase-build.ts, ai/ai-phase-cannon.ts, ai/ai-phase-battle.ts all define named
    constants with unit suffixes (e.g. `POST_PLACE_DELAY_SEC`, `ORBIT_SPEED_STRATEGIC_RAD_S`,
    `ORBIT_RADIUS_BASE_PX`). Each file has a header comment: "All timing constants are in
    seconds." No inline magic numbers remain in scaledDelay calls or timer assignments.

77. **`cannonRotationIdx` uses undefined (not null) for "not yet fired"** —
    player/controller-types.ts:53-55 JSDoc says "undefined = no cannon fired yet this round".
    Type is `number | undefined`. Consistent with the codebase's convention of `undefined`
    for "not yet set" (see commit d339814).

78. **`WatcherTimingState` zero-sentinel convention is documented** —
    shared/tick-context.ts:84 JSDoc documents: "All timestamps are performance.now() values
    (ms since page load). Sentinel: 0 = not yet started." Each field has inline JSDoc
    specifying units (ms for timestamps, seconds for durations) and the 0-sentinel meaning.

79. **`occupiedSlots` ⊇ `remoteHumanSlots` invariant is documented** —
    online/online-session.ts:41-46 INVARIANT JSDoc documents the subset relationship and
    points to clearLobbySlot/occupyLobbySlot as the only mutation sites.

80. **`roomGameMode` is typed as `GameMode` (not string)** —
    online/online-session.ts:50 uses the `GameMode` union type from game-constants.ts,
    not a raw string. Protocol boundary uses `as GameMode` cast (server-validated).

81. **Dialog completion callback patterns differ by design** —
    runtime-types.ts:293-322 block comment documents three intentionally different patterns:
    ScoreDelta stores onDone on runtimeState (mode-independent tick), LifeLost exposes
    onResolved as a method (multi-path resolution), UpgradePick uses a local closure
    (single-path, transient). Each factory file header cross-references runtime-types.ts.

82. **ViewState interfaces are read-only projections of GameState** —
    system-interfaces.ts defines `GameViewState` (phase + players + map), `BuildViewState`,
    `CannonViewState`, `BattleViewState`. GameState structurally satisfies all of them.
    Controllers and AI strategy modules accept ViewStates; game/ mutation functions accept
    full GameState. Do not add mutable fields to ViewState interfaces.

83. **Controllers return intent objects, orchestrators execute mutations** —
    `BattleController.fire()` returns `FireIntent | null` (not void). `InputReceiver.tryPlacePiece()`
    returns `PlacePieceIntent | null` (not boolean). The orchestrator (runtime.ts, online-runtime-game.ts,
    controller-ai.ts battleTick) calls `fireNextReadyCannon()` or `placePiece()` with mutable GameState.
    `tryPlaceCannon` does NOT follow this pattern — `placeCannon` already accepts structural types.
    Do not add mutation calls inside controller methods.

84. **`executeFire` callback pattern in AI battle tick** —
    ai/ai-phase-battle.ts `tickBattle` receives `executeFire: (intent: FireIntent) => boolean`.
    controller-ai.ts builds the closure from mutable GameState and updates `cannonRotationIdx`.
    The AI constructs `FireIntent` inline for chain attacks (target row/col known).
    Do not make AI phase modules import `fireNextReadyCannon` directly.

85. **`advanceBag` must be called by the orchestrator after `tryPlacePiece`** —
    HumanController.tryPlacePiece() returns intent without advancing the bag.
    The orchestrator calls `ctrl.advanceBag(true)` after confirming placement via `placePiece()`.
    All three execution sites (runtime.ts, online-runtime-game.ts, ai-phase-build.ts) do this.

86. **`FreshInterior` and `Player` live in `player-types.ts`, not `types.ts`** —
    Extracted to break the system-interfaces → types.ts coupling chain. `types.ts` re-imports
    Player for GameState's `players` field. Consumers that only need Player/FreshInterior
    should import from `player-types.ts`, not `types.ts`.

87. **`TileKey` branded type lives in `spatial.ts`, not `types.ts`** —
    Moved alongside its constructor `packTile()`. Only `spatial.ts` produces TileKey values.
