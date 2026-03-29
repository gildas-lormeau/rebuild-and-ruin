---
name: architecture-audit
description: Parallel multi-domain architecture audit. Spawns sub-agents per domain to find semantic duplication, misplaced logic, and cross-domain inconsistencies.
user-invocable: true
---

# Architecture Audit

Parallel multi-domain review that detects semantic duplication (same behavior implemented differently across files) and cross-domain inconsistencies. Complements `/code-review` which works per-pass on a scoped file set.

## Domain clusters

Each domain is a group of tightly related files that share responsibility for a subsystem.

### 1. Input (6 files)
```
src/input.ts, src/input-dispatch.ts, src/input-keyboard.ts,
src/input-mouse.ts, src/input-touch-canvas.ts, src/input-touch-ui.ts
```

### 2. Online client (10 files)
```
src/online-client.ts, src/online-client-stores.ts, src/online-client-runtime.ts,
src/online-client-deps.ts, src/online-client-promote.ts, src/online-client-ws.ts,
src/online-client-lobby.ts, src/online-phase-transitions.ts,
src/online-checkpoints.ts, src/online-host-promotion.ts
```

### 3. Phase transitions & game engine (5 files)
```
src/game-engine.ts, src/runtime-phase-ticks.ts,
src/runtime-host-phase-ticks.ts, src/runtime-host-battle-ticks.ts,
src/tick-context.ts
```

### 4. Controllers (4 files)
```
src/controller-interfaces.ts, src/controller-types.ts,
src/controller-human.ts, src/controller-factory.ts
```

### 5. Rendering (5 files)
```
src/map-renderer.ts, src/render-effects.ts, src/render-composition.ts,
src/render-theme.ts, src/render-canvas.ts
```

### 6. Runtime sub-systems (10 files)
```
src/runtime.ts, src/runtime-state.ts, src/runtime-types.ts,
src/runtime-camera.ts, src/runtime-selection.ts, src/runtime-life-lost.ts,
src/runtime-lobby.ts, src/runtime-options.ts, src/runtime-input.ts,
src/runtime-game-lifecycle.ts
```

### 7. Game systems (5 files)
```
src/battle-system.ts, src/build-system.ts, src/cannon-system.ts,
src/grunt-system.ts, src/board-occupancy.ts
```

### 8. Server (3 files)
```
server/server.ts, server/game-room.ts, server/room-manager.ts
```

## Execution

### Phase 1: Parallel domain audits

Spawn one Explore sub-agent per domain (up to 8 in parallel). Each agent receives this prompt template:

```
Read ALL files in this domain completely:
[file list]

Report findings in these categories:

1. SEMANTIC DUPLICATION — same behavior implemented via different code.
   Detection: multiple files branching on the same enum/phase/mode,
   parallel guard checks, same controller/state methods called from
   different paths with different subsets of checks.

2. MISPLACED LOGIC — code that belongs in another domain.
   Detection: file imports types/functions from a domain it shouldn't
   depend on, or implements behavior that another domain already owns.

3. INCONSISTENT GUARDS — same action reachable via multiple paths
   with different precondition checks (e.g., one path checks eliminated,
   another doesn't).

4. INTERFACE BLOAT — deps interfaces with fields that are only
   pass-throughs to another consumer. Should carry a sub-object instead.

For each finding: file, line number, what's duplicated/misplaced,
severity (high/medium/low), suggested fix. Do NOT make any edits.
Be pragmatic — only flag things where the fix genuinely improves
the codebase.
```

### Phase 2: Cross-domain audit

After all domain agents complete, spawn one Explore agent with all domain reports combined:

```
Given these domain audit findings:
[paste all domain reports]

Now check for CROSS-DOMAIN issues:

1. SHARED TYPES used inconsistently — same interface/enum imported by
   multiple domains but with different field subsets or different
   type signatures (e.g., one domain uses `boolean`, another uses
   `boolean | undefined` for the same concept).

2. ENUM BRANCHING scattered — the same enum (Phase, Mode, CannonMode)
   branched independently in multiple domains. Each domain implements
   its own phase-specific behavior instead of delegating to a shared
   dispatch.

3. PARALLEL DEPS — two domains define similar deps interfaces that
   could share a common base or sub-object.

4. IMPORT OVERLAP — two files in different domains that import the
   same set of 3+ game types/functions, suggesting they both implement
   the same responsibility.

For each finding: which domains are involved, what's duplicated,
severity, suggested fix. Do NOT make any edits.
```

### Phase 3: Triage

Present all findings (domain + cross-domain) to the user, ranked by severity. For each:
- What's wrong and where
- Whether it's an actual bug, latent risk, or just messy
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
- The online client domain (#2) is highest risk — it mirrors local runtime logic and drifts silently
- Cross-domain findings are often more impactful than within-domain ones
- If a domain has >15 files, split it into sub-domains for the audit
