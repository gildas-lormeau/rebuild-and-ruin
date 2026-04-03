---
name: architecture-audit
description: Parallel multi-domain architecture audit focused on LLM-agent readability. Finds ambiguous naming, implicit conventions, divergent patterns, large functions, and magic values.
user-invocable: true
---

# Architecture Audit

Parallel multi-domain review focused on making the codebase easy for LLM-based coding agents to work with correctly. An LLM agent that reads these files should be able to understand intent, find the right place to make changes, and produce code that follows existing patterns — without hallucinating wrong field names, missing guards, or placing logic in the wrong file.

Complements `/code-review` which works per-pass on a scoped file set.

## Domain clusters

Each domain is a group of tightly related files that share responsibility for a subsystem.
Domains map to the 15 layer groups in `.import-layers.json` (L0–L14), with small layers
combined and large layers (>10 files) split into sub-domains at audit time.

### 1. Leaf utilities — L0 (11 files)
```
src/ai-constants.ts, src/canvas-layout.ts, src/game-constants.ts,
src/grid.ts, src/jsfxr.d.ts, src/platform.ts, src/rng.ts,
src/router.ts, src/online-dom.ts, src/upgrade-defs.ts, src/utils.ts
```

### 2. Core types, geometry & spatial — L1 + L2 (9 files)
```
src/ai-build-types.ts, src/geometry-types.ts, src/pieces.ts,
src/ai-castle-rect.ts, src/types.ts, src/spatial.ts,
src/board-occupancy.ts, src/checkpoint-data.ts, server/protocol.ts
```

### 3. Shared interfaces, config & scoring — L3 (13 files)
```
src/ai-build-score.ts, src/ai-build-fallback.ts,
src/phase-transition-shared.ts, src/player-config.ts,
src/controller-interfaces.ts, src/life-lost.ts, src/upgrade-pick.ts,
src/castle-build.ts, src/phase-banner.ts, src/render-theme.ts,
src/render-types.ts, src/phantom-types.ts, src/tick-context.ts
```

### 4. Game logic — L4 (14 files)
```
src/ai-build-target.ts, src/cannon-system.ts, src/grunt-movement.ts,
src/grunt-system.ts, src/battle-system.ts, src/build-system.ts,
src/castle-generation.ts, src/map-generation.ts, src/phase-setup.ts,
src/combo-system.ts, src/round-modifiers.ts, src/game-engine.ts,
src/selection.ts, src/host-phase-ticks.ts
```

### 5. AI strategy — L5 (4 files)
```
src/ai-strategy-battle.ts, src/ai-strategy-build.ts,
src/ai-strategy-cannon.ts, src/ai-strategy.ts
```

### 6. Controllers — L6 (8 files)
```
src/ai-phase-select.ts, src/ai-phase-build.ts,
src/ai-phase-cannon.ts, src/ai-phase-battle.ts,
src/controller-ai.ts, src/controller-types.ts,
src/controller-human.ts, src/controller-factory.ts
```

### 7. Input & sound — L7 (9 files)
```
src/haptics-system.ts, src/input-recorder.ts, src/input-dispatch.ts,
src/input-touch-ui.ts, src/input-touch-canvas.ts, src/input-mouse.ts,
src/input-keyboard.ts, src/input.ts, src/sound-system.ts
```

### 8. Render — L8 (10 files)
```
src/render-sprites.ts, src/render-loupe.ts, src/render-effects.ts,
src/render-towers.ts, src/render-composition.ts, src/render-ui-theme.ts,
src/render-ui.ts, src/render-ui-settings.ts, src/render-map.ts,
src/render-canvas.ts
```

### 9. Game UI & runtime support — L9 + L10 (6 files)
```
src/game-ui-types.ts, src/game-ui-screens.ts, src/game-ui-settings.ts,
src/runtime-bootstrap.ts, src/runtime-headless.ts, src/runtime-touch-ui.ts
```

### 10. Online infrastructure — L11 (5 files)
```
src/online-config.ts, src/online-types.ts, src/online-lobby-ui.ts,
src/online-server-lifecycle.ts, src/online-session.ts
```

### 11. Online logic — L12 (12 files)
```
src/online-serialize.ts, src/online-full-state-recovery.ts,
src/online-send-actions.ts, src/online-checkpoints.ts,
src/online-watcher-battle.ts, src/online-watcher-tick.ts,
src/online-phase-transitions.ts, src/online-server-events.ts,
src/online-host-crosshairs.ts, src/online-host-promotion.ts,
src/online-host-battle-ticks.ts, src/online-stores.ts
```

### 12. Runtime — L13 (21 files)
```
src/runtime-state.ts, src/runtime-banner.ts, src/runtime-camera.ts,
src/runtime-life-lost.ts, src/runtime-upgrade-pick.ts,
src/runtime-lobby.ts, src/runtime-options.ts,
src/runtime-game-lifecycle.ts, src/runtime-human.ts,
src/runtime-test-globals.ts, src/runtime-input.ts,
src/runtime-phase-ticks.ts, src/runtime-render.ts,
src/runtime-selection.ts, src/runtime-types.ts, src/runtime.ts,
src/runtime-online-game.ts, src/runtime-online-deps.ts,
src/runtime-online-promote.ts, src/runtime-online-ws.ts,
src/runtime-online-lobby.ts
```

### 13. Entry points & server — L14 (8 files)
```
src/entry.ts, src/main.ts, src/online-client.ts,
server/send-utils.ts, server/game-room.ts, server/room-manager.ts,
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

For each finding: file, line number, what the issue is,
severity (high/medium/low), and a concrete suggestion.
Do NOT make any edits. Only flag things where fixing them would
genuinely help an LLM agent write better code.
```

### Phase 2: Cross-domain audit

After all domain agents complete, spawn one Explore agent with all domain reports combined.
Domains 3 (13 files), 4 (14 files), 11 (12 files), and 12 (21 files) should be split into sub-domains at audit time to keep each agent under 10 files:

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

For each finding: which domains are involved, what the issue is,
severity, suggested fix. Do NOT make any edits.
```

### Phase 3: Triage

Present all findings (domain + cross-domain) to the user, ranked by severity. For each:
- What's wrong and where
- How it would cause an LLM agent to produce incorrect code
- Estimated fix effort (low/medium/high)
- Recommended action (fix now, defer, or ignore)

Ask the user which findings to fix. Then fix them one domain at a time, running `npm run build` and tests after each.

## When to run

- After implementing a non-trivial feature that touches multiple domains
- Periodically (every few weeks) as a health check
- When you suspect drift between local and online code paths
- Before major refactors to establish a clean baseline

## Tips

- Skip domains that were recently audited and had no findings
- The online domains (#10–#11) and runtime (#12) are highest risk — they mirror local logic and drift silently
- Cross-domain findings are often more impactful than within-domain ones
- If a domain has >10 files, split it into sub-domains for the audit

## Known-documented patterns (do NOT report)

The following conventions are already well-documented in code comments. Agents should
NOT flag these as findings — they have been verified and the existing documentation is
sufficient for LLM agents to follow correctly.

1. **recheckTerritoryOnly vs finalizeTerritoryWithScoring** — build-system.ts:173 and 189-193
   explain the difference and when to use each. cannon-system.ts:269 documents the precondition.

2. **canPlaceCannon vs canPlacePiece validation difference** — build-system.ts:92-95 has
   `CONTRAST with canPlaceCannon()...Copying validation from one to the other produces wrong results.`
   cannon-system.ts:264-266 mirrors it. Both sides documented.

3. **RATE_LIMITED_TYPES cosmetic-only invariant** — game-room.ts:59-63 has
   `CRITICAL: Only cosmetic/display messages belong here. Adding a game-state message = DESYNC BUG`.

4. **HOST_ONLY and PHASE_GATES disjoint invariant** — game-room.ts:70-72 documents
   `Invariant: HOST_ONLY and PHASE_GATES are disjoint...Do NOT add a message to both sets.`

5. **applyImpactEvent leaves interior stale during battle** — battle-system.ts:222-226 JSDoc
   and lines 236-240 inline comment both explain this. grunt-system.ts:247 reinforces it.

6. **Wall snapshot MUST precede finalizeBuildPhase** — host-phase-ticks.ts:466-468 documents it;
   snapshotThenFinalize() at line 494-498 enforces it structurally with a full INVARIANT JSDoc.

7. **advancePhaseTimer is the ONLY way to advance phase timers** — tick-context.ts:101-108
   has `INVARIANT: All phase timers MUST use this function. Never manually write accum.X += dt.`

8. **Canvas ctx.save()/ctx.restore() convention** — render-effects.ts:20-28 documents the full
   convention with code example. Applies across all render-* files.

9. **Checkpoint `capturePreState` ordering invariant** — online-checkpoints.ts:53 JSDoc
   explains capturePreState and the lifecycle at each function. online-phase-transitions.ts:105-107
   documents the ordering guarantee. runtime-phase-ticks.ts:165 has INVARIANT comment
   reinforcing that banner captures oldCastles BEFORE applyCheckpoint mutates state.
   Individual checkpoint apply functions have NO payload validation by design — the host
   is authoritative. Only full-state recovery (validateFullState in online-serialize.ts)
   validates, because that payload crosses a trust boundary during host promotion.

10. **`net` required on all tick deps interfaces** — runtime-phase-ticks.ts:5-9 documents
    `net is REQUIRED on all tick deps interfaces...the compiler enforces the choice.`

11. **`session.isHost` is volatile — never cache, always read via `isHostInContext()`** —
    online-session.ts:29-35 marks the field `VOLATILE` with full explanation of when it flips
    and how to read/write it. tick-context.ts:87-88 repeats `VOLATILE...Never cache` on the
    accessor. host-phase-ticks.ts:12-13 says `never cache in a local variable`.
    online-server-events.ts:25-27 repeats the warning. ESLint `no-restricted-syntax` rule
    enforces all direct `.isHost` reads require an explicit disable comment.

12. **RNG consumption order before checkpoint is load-bearing for online sync** —
    phase-setup.ts:307 marks the block with `RNG consumption (BEFORE checkpoint — order is
    load-bearing for online sync)` and warns not to insert RNG calls after it.

13. **ScoringRule null vs 0 semantics** — ai-build-types.ts:77-81 documents the interface
    contract (`null` = hard-reject, `0` = no opinion). ai-build-score.ts:371 repeats the
    convention inline at the scoring loop.

14. **scoreCannonPosition returns negated score** — ai-strategy-cannon.ts:291 JSDoc explains
    penalties are accumulated positive and negated on return so callers see higher = better.

15. **castle-build dt is in seconds, accum/interval are in ms** — castle-build.ts:37 JSDoc
    annotates `@param dt — delta time in SECONDS`, the `dt` field has an inline doc comment,
    and line 48 has an inline comment explaining the ×1000 conversion.

16. **Late-binding closure pattern (initDeps/initPromote/initWs)** —
    runtime-online-deps.ts:56-60 documents the 3-step pattern (declare, init, guard) and
    explains it avoids circular imports. All three init files follow the same structure.

17. **Mode-setting timing in watcher phase transitions** — online-phase-transitions.ts:53-61
    documents when setMode is called immediately vs inside banner callback for each phase type.

18. **AI vs human cursor movement models differ by design** — controller-ai.ts:248-252
    and controller-human.ts:236-239 both warn not to copy between the two files.
    AI uses tile-step (Manhattan + jitter), human uses pixel-velocity (Cartesian).

19. **ROUNDS_TO_THE_DEATH_INDEX and CANNON_HP_DEFAULT_INDEX are array indices** —
    game-ui-types.ts documents both with JSDoc explaining they are indices into their
    respective option arrays, not the option values themselves.

20. **`simulatedOutside` naming is consistent across ai-build files** —
    ai-build-fallback.ts and ai-build-score.ts both use `simulatedOutside` for the
    outside set computed after simulating a candidate placement. CandidateEnv field matches.

21. **`resetBattlePhaseKeepOrbit` name clarifies orbit preservation** —
    ai-phase-battle.ts:87 name makes clear that orbitAngle persists across resets.
    Contrast with `initBattle` which resets everything including chain state.

22. **AI tile-cursor movement constants are named** — controller-ai.ts defines
    TILE_ARRIVAL_TOLERANCE, JITTER_DECAY_RATE, and JITTER_MAX_AMPLITUDE as named constants.

23. **Eliminated-player guard in keyboard dispatch is NOT missing** — keyboard's
    `handleKeyGame` calls `dispatchGameAction` (input-dispatch.ts:336) which has the
    eliminated check built in. Do not report this as a missing guard.

24. **Slot mutation atomicity is already enforced** — online-server-lifecycle.ts:82-101
    defines `clearLobbySlot()` and `occupyLobbySlot()` helpers with explicit invariant
    comments. All incremental slot mutations go through these helpers.

25. **Player-check guard order is documented and consistent** — online-server-events.ts:1-28
    documents three handler categories with explicit patterns (validPid → eliminated →
    isRemoteHumanAction). Every handler in the file follows the documented pattern.

26. **Coordinate system params are already named by space** — render-composition.ts uses
    `screenX`/`screenY` (canvas-pixel, with JSDoc), `canvasX`/`canvasY` (canvas-pixel),
    and `tileX`/`tileY` (game-space) consistently. Conversions are explicit inline.

27. **Phantom vs crosshair dedup strategies differ by design** — phantoms use explicit
    filter+push array replacement (online-server-events.ts:416 JSDoc). Crosshairs use
    DedupChannel's atomic shouldSend() via makeCrosshairDedupKey() (online-host-crosshairs.ts:41).
    Do not unify — they serve different network patterns (accumulated vs fire-and-forget).

28. **`optionsReturnMode` null=lobby (editable), non-null=in-game (read-only)** —
    runtime-state.ts:94-96 JSDoc documents the inverse semantics. game-ui-settings.ts:114
    @param JSDoc repeats it. The value when non-null is the Mode to return to on close.

29. **`modeTickers` is exhaustively typed via `satisfies`** — runtime.ts:184 uses
    `satisfies Record<Exclude<Mode, Mode.STOPPED>, ...>` ensuring all tickable modes have
    a ticker. STOPPED is excluded by design (tickMainLoop returns early for it).
    Adding a new Mode without a corresponding ticker entry is a compile error.

30. **Two-tier server dispatch: lobby switch vs game validation pipeline** —
    server.ts:84-93 JSDoc explains lobby/room messages use a simple switch.
    game-room.ts:329-336 JSDoc explains in-game messages use a 6-stage validation
    pipeline. New game-state messages go in game-room.ts, not server.ts.

31. **Touch-suppression pairing: all click handlers MUST check `isTouchSuppressed()`** —
    input-mouse.ts:25-28 documents the convention. input-dispatch.ts:8-27 documents
    markTouchTime() pairing. Prevents synthetic click events that mobile browsers fire
    after touchend.

32. **`towerPendingRevive` naming is correct — "pending" means awaiting a condition** —
    types.ts:251 JSDoc explains the two-phase rule. build-system.ts:452-454 JSDoc on
    `reviveEnclosedTowers` documents the mechanic. CLAUDE.md line 40 repeats it.
    "Pending" = awaiting one more build phase of enclosure, not awaiting user action.
    Do not rename to `towersAwaitingRevive` or `towersEligibleForRevive`.

33. **`FreshInterior` vs `ReadonlySet<number>` for interior is intentional** —
    `FreshInterior` (branded type, types.ts:151) proves the interior was recomputed
    after the last wall mutation. `ReadonlySet<number>` is used in AI build code
    (ai-build-types.ts, ai-build-target.ts, ai-castle-rect.ts) for simulated/hypothetical
    interiors constructed during candidate scoring. Do not unify — branding simulated
    interiors as fresh would defeat the type safety.

34. **`runtimeState` destructuring is intentionally non-uniform across sub-systems** —
    runtime.ts:10-16 documents the convention. Each createXSystem(deps) factory
    destructures only frequently-used deps at the top; rarely-used deps are accessed
    inline as `deps.X`. The inconsistency reflects actual usage, not drift.

35. **`comboTracker` lifecycle is transient during battle** — types.ts:281 JSDoc says
    "transient during battle, not serialized". Created in `enterBattleFromCannon`
    (phase-setup.ts:273), nulled after awarding bonuses in `enterBuildFromBattle`
    (phase-setup.ts:289). Both sites are in the same file. The `| null` type enforces
    null checks at all access sites. Do not report the lifecycle as undocumented.

36. **MODIFIER_LABELS and MODIFIER_ID must stay in sync** — game-constants.ts:30-37
    documents the invariant on both objects. Adding a modifier requires entries in both.

37. **Interior exclusion set in AI pickPlacement is intentional** —
    ai-strategy-build.ts:485 documents why gaps and castle-rect tiles are excluded
    from the interior set during candidate scoring. Prevents penalizing gap-filling.

38. **`withPointerPlayer` callback may silently not execute** — input.ts:58-61 JSDoc
    explicitly warns that the callback is NOT invoked if no human players exist.

39. **`>>> 0` uint32 coercion in deriveAiStrategySeed** —
    online-host-promotion.ts:111 inline comment explains the idiom.

40. **Preset option sets for collectOccupiedTiles are documented** —
    board-occupancy.ts:50-52 explains the preset pattern and its relationship
    to the collectOccupiedTiles function.

41. **`victimPlayerId` naming reflects the grunt's perspective** —
    ai-strategy-battle.ts:591-593 JSDoc explains the parameter is the player
    being attacked, not the AI. The name is intentional.

42. **Tower identity check (===) in selection is intentional** —
    selection.ts:62-63 documents that tower refs are stable within a session.
    Online mode uses indices for serialization.

43. **Selection tick takes optional `state?` by design** — ai-phase-select.ts:89
    documents that selection can tick without state during initial lobby setup.

44. **Socket validation inlined in online-lobby-ui.ts mirrors online-session.ts** —
    online-lobby-ui.ts:55 comment documents the parallel with isSocketOpen().

45. **Life-lost and upgrade-pick dialog ticks have parallel structure** —
    life-lost.ts:19 and upgrade-pick.ts cross-reference each other. Both loop
    entries for auto-resolve + force-resolve. The duplication is intentional.

46. **drawPanel/drawButton mutate canvas state — callers must save/restore** —
    render-ui-theme.ts JSDoc on both functions documents the convention.

47. **HOME_GAP_REPAIR_THRESHOLD vs MANAGEABLE_GAP_LIMIT serve different decisions** —
    ai-strategy-build.ts:68 and :76 JSDoc explains: threshold = deprioritize home tower,
    limit = skip target entirely. Both are gap counts but at different decision points.

48. **Modifier tuning constants are playtesting-calibrated** —
    round-modifiers.ts:71 block comment warns against adjusting multiple simultaneously.

49. **Fanfare note frequencies are musical constants** — sound-system.ts:587 comment
    documents G4=392, C5=523, E5=659, G5=784 Hz.

50. **isCannonPhaseDone measures different things per controller type** —
    controller-interfaces.ts:129-130 JSDoc documents that Human checks remaining
    slots, AI checks internal phase step. Both are correct.

51. **Canvas coordinate spaces documented in render-effects.ts** —
    render-effects.ts:20+ documents that all render-* positions are canvas-space
    unless parameter names indicate otherwise (screenX/Y, tileX/Y).

52. **pointerPhantomValid() three-way return is documented** —
    runtime-touch-ui.ts JSDoc: true=valid, false=invalid, undefined=no phantom.

53. **Host interface pattern (SelectionHost, BuildHost, etc.) is documented** —
    ai-phase-select.ts JSDoc above SelectionHost explains the convention:
    each ai-phase-*.ts defines a minimal Host interface for decoupling.
