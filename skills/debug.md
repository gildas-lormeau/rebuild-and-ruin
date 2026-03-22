---
name: debug
description: Systematic debugging workflow — add logs, run test, analyze with a script, fix, repeat. Never guess.
user-invocable: true
---

# Debug Workflow

When the user reports a bug or asks you to debug something, follow this process strictly. Never skip steps. Never guess at causes.

## Step 1: Identify what to log

Determine the decision points in the code path where the bug could occur. Add `console.log` (or the project's logging mechanism) at each point with:
- The function name or location
- Key variable values — actual numbers, positions, states, not just booleans
- Enough context to distinguish which entity / iteration / frame produced the log

## Step 2: Write an analysis script BEFORE running the test

Write a temporary script (inline `node -e`, a small script file, or whatever fits the project) that will:
- Parse the log output
- Check the specific assertion relevant to the bug
- Output PASS/FAIL per entity, with the actual values on failure

Never plan to read logs by eye. The script reads them.

## Step 3: Run the test

Run the shortest test that reproduces the bug. Adapt timeouts and scope — if the bug happens early, stop the test as soon as the relevant phase is captured. Don't waste the user's time with long runs.

## Step 4: Run the analysis script on the logs

Read the script output. It says PASS or FAIL with details.

## Step 5: If FAIL — understand WHY from the script's output

The script printed the actual values that failed. Use those to understand the root cause.

If the logs don't contain enough data, go back to Step 1 and add more logs. Do NOT guess.

## Step 6: Fix the code

Only now, with facts from the logs, make the fix.

## Step 7: Verify

Run the test again + analysis script. Confirm PASS. Run multiple times if the bug was intermittent.

## Step 8: Clean up

Remove ALL debug logs added during this process. Verify the code compiles clean. No debug logging should remain in the codebase after the fix.

## Rules

- NEVER read raw log lines in chat to validate a fix. Always use a script.
- NEVER declare "it works" without the script confirming it.
- NEVER change code to "try something" without first understanding the cause from logs.
- NEVER leave debug logs in the code after the bug is fixed.
- If the user says "read the logs" outside of debugging, that's fine — read them directly.
- If a test takes too long, shorten it to cover only the relevant window.
- NEVER use `sleep N && cat file` or similar blocking patterns to poll for results. Use `run_in_background` and wait for the task notification, or run the command directly with an appropriate timeout.
- Use reasonable timeout values — match them to the expected duration of the operation. A 30s test doesn't need a 300s timeout. A 3-minute game doesn't need a 10-minute timeout. Calculate from the known timing (phase durations, lobby timers, etc.).
