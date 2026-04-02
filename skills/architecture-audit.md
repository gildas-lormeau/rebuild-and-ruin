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
