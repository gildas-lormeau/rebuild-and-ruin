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

## Domain clusters and tiers

Each domain is a group of tightly related files that share responsibility for a subsystem.
See `.import-layers.json` for the full layer map (group names, tier assignments, file lists)
and `.domain-boundaries.json` for domain membership and allowed cross-domain imports.

Groups are named by role/abstraction level, not by domain — files from any domain land at their
minimum import-depth layer. Each group has a `tier` field: **types** (L0–L4), **logic** (L5–L6),
**systems** (L7–L9), **assembly** (L10–L13), **roots** (L14–L17). Phase 1 audits by domain
(vertical coherence), Phase 2 audits by tier (horizontal consistency across domains).

**Reading order.** `.import-layers.json` is an array where **array index = layer number**: the
*first* entry is L0 (leaves, no deps), the *last* entry is L17 (top — `online-client.ts`).
Imports flow **downward by number** (L17 may import from L0, never the reverse). When tracing
from an entry point, scroll to the bottom of the file first; when tracing a dependency chain
toward leaves, scroll up. Layer numbers are mechanical (`layer(f) = 1 + max(layer(dep))`), not
semantic — a file's layer is determined by its deepest import, not by what "feels" architectural.

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

### Phase 2: Cross-domain tier audits

After all domain agents complete, spawn one Explore sub-agent per tier (up to 5 in parallel).
Each tier groups files from different domains at the same abstraction level — this is where
cross-domain divergence is most visible. Read `.import-layers.json` to get the tier assignments.

Each tier agent receives domain audit findings for files in its tier, plus this prompt:

```
Read ALL files in this tier completely:
[file list, grouped by domain]

Relevant domain audit findings for these files:
[paste findings from Phase 1 that reference files in this tier]

Tier: [types | logic | systems | assembly | roots]

Compare files ACROSS domains at this abstraction level. Report:

1. AMBIGUOUS NAMING across domains — same name used for different
   things in different files, or different names used for the same
   concept. An LLM working in one domain would use the wrong
   identifier in another.

2. DIVERGENT PATTERNS across domains — same concern (guards, deps
   access, phase checks, error handling) handled differently in
   different domains at this tier. An LLM copying a pattern from
   domain A would produce wrong code in domain B.

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
   domain's actual code at this tier. Future agents will usually
   trust the more explicit artifact, not necessarily the correct one.

For each finding: which domains are involved, what the issue is,
severity, suggested fix. Do NOT make any edits.
```

Tier focus guidance:
- **types** (L0–L4): type consistency, field naming, enum/const drift between shared/ and consumer domains
- **logic** (L5–L6): algorithm patterns, guard conventions, helper usage across game/, ai/, render/
- **systems** (L7–L9): deps destructuring, lifecycle conventions, handler patterns across runtime/, input/, render/, online/
- **assembly** (L10–L13): phase transition patterns, controller wiring, orchestration across ai/, game/, runtime/, online/
- **roots** (L14–L17): local/online parity, bootstrap conventions, composition root patterns

### Phase 3: Triage

Present all findings (domain + tier) to the user, ranked by severity. For each:
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
- The **roots** tier (online + runtime bootstrap) is highest risk — local/online parity drift is silent
- The **systems** tier catches the most divergent-pattern findings — handler conventions vary across domains
- Tier findings are often more impactful than within-domain ones
- If a domain has >10 files, split it into sub-domains for the Phase 1 audit

## Known-documented patterns (do NOT report)

The following conventions are already well-documented in code comments. Agents should
NOT flag these as findings — they have been verified and the existing documentation is
sufficient for LLM agents to follow correctly.
