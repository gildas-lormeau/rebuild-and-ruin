---
description: Run the hot-exports report to show exports imported by many files (coupling breadth signal)
---

Run `npm run hot-exports` in the project directory and display the output.

## Why this matters for agents

Exports consumed by only one file can signal an architecture issue: the export may belong in or near its sole consumer rather than in a shared module. A large layer gap (e.g., L0→L13) on a single-consumer export is a strong smell — the function/constant was likely placed in a shared layer out of habit, not necessity. Use `--max 1` to find these; see `/layer-graph-cleanup` Step 7 for the full workflow.
