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

### 1. Input (7 files)
```
src/input.ts, src/input-dispatch.ts, src/input-keyboard.ts,
src/input-mouse.ts, src/input-touch-canvas.ts, src/input-touch-ui.ts,
src/input-recorder.ts
```

### 2. Online client — core wiring (7 files)
```
src/online-client.ts, src/online-client-stores.ts, src/online-client-runtime.ts,
src/online-client-deps.ts, src/online-client-promote.ts, src/online-client-ws.ts,
src/online-client-lobby.ts
```

### 3. Online client — game logic (9 files)
```
src/online-phase-transitions.ts, src/online-checkpoints.ts,
src/online-host-promotion.ts, src/online-host-crosshairs.ts,
src/online-watcher-tick.ts, src/online-watcher-battle.ts,
src/online-send-actions.ts, src/online-server-events.ts,
src/online-full-state-recovery.ts
```

### 4. Online client — infrastructure (5 files)
```
src/online-config.ts, src/online-types.ts, src/online-lobby-ui.ts,
src/online-server-lifecycle.ts, src/online-session.ts, src/online-serialize.ts
```

### 5. Phase transitions & game engine (5 files)
```
src/game-engine.ts, src/runtime-phase-ticks.ts,
src/runtime-host-phase-ticks.ts, src/runtime-host-battle-ticks.ts,
src/tick-context.ts
```

### 6. Controllers (4 files)
```
src/controller-interfaces.ts, src/controller-types.ts,
src/controller-human.ts, src/controller-factory.ts
```

### 7. Rendering (10 files)
```
src/render-map.ts, src/render-effects.ts, src/render-composition.ts,
src/render-theme.ts, src/render-canvas.ts, src/render-loupe.ts,
src/render-sprites.ts, src/render-towers.ts, src/render-ui.ts,
src/render-types.ts
```

### 8. Runtime sub-systems (10 files)
```
src/runtime.ts, src/runtime-state.ts, src/runtime-types.ts,
src/runtime-camera.ts, src/runtime-selection.ts, src/runtime-life-lost.ts,
src/runtime-lobby.ts, src/runtime-options.ts, src/runtime-input.ts,
src/runtime-game-lifecycle.ts
```

### 9. Game systems (5 files)
```
src/battle-system.ts, src/build-system.ts, src/cannon-system.ts,
src/grunt-system.ts, src/board-occupancy.ts
```

### 10. Server (3 files)
```
server/server.ts, server/game-room.ts, server/room-manager.ts
```

## Execution

### Phase 1: Parallel domain audits

Spawn one Explore sub-agent per domain (up to 10 in parallel). Each agent receives this prompt template:

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
Online client is split into 3 sub-domains (core wiring, game logic, infrastructure) to keep each under 10 files:

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
- The online client domains (#2–#4) are highest risk — they mirror local runtime logic and drift silently
- Cross-domain findings are often more impactful than within-domain ones
- If a domain has >10 files, split it into sub-domains for the audit
