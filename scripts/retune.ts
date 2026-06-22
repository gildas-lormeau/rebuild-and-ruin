/**
 * retune — one command to find (and optionally heal) everything that drifts
 * when you change battle/grunt/house dynamics. Replaces the serial "run six
 * suites, infer which fixture/seed broke, run the right probe" dance.
 *
 *   npm run retune            # dry-run: detect drift + print the fix for each
 *   npm run retune -- --apply # auto-heal the mechanical ones, then re-verify
 *
 * Checks, in order:
 *   1. determinism   — test:determinism; on fail, check-determinism classifies
 *                      SAFE (auto: record-determinism --all) vs BUG (ABORT).
 *   2. seed-registry — test:reveals + test:supply-ship; auto: record-seeds.
 *   3. abandon /      — hand-tuned seed tests: detect + print the exact re-probe
 *      upgrades /       (no auto-edit of test source — a wrong seed silently
 *      modifiers        passes vacuously, so a human/agent confirms the swap).
 *
 * A determinism BUG aborts everything: if the runtime is non-deterministic,
 * re-tuning seeds/fixtures is meaningless until that's fixed.
 */

type Status = "ok" | "drift" | "manual" | "healed" | "bug";

const APPLY = Deno.args.includes("--apply");
const rows: { label: string; status: Status; note: string }[] = [];

if (import.meta.main) Deno.exit(await main());

async function main(): Promise<number> {
  console.log(
    `retune — ${APPLY ? "AUTO-HEAL" : "dry-run (pass --apply to heal)"}\n`,
  );

  // 1. DETERMINISM ─────────────────────────────────────────────────────────
  const det = await run("npm", ["run", "test:determinism"]);
  if (det.code === 0) {
    record("determinism", "ok", "fixtures current");
  } else {
    const cls = await run("deno", [
      "run",
      "-A",
      "scripts/check-determinism.ts",
    ]);
    if (cls.code === 1) {
      record(
        "determinism",
        "bug",
        `non-deterministic — ${saveLog("determinism", cls.log)}`,
      );
      console.log(
        "\n=> ABORT: two fresh runs of a fixture disagree — the runtime is non-deterministic now.\n" +
          "   Re-tuning seeds/fixtures is meaningless until this is fixed. Investigate the RNG/iteration-order drift.",
      );
      return 1;
    }
    if (APPLY) {
      const rec = await run("deno", [
        "run",
        "-A",
        "scripts/record-determinism.ts",
        "--all",
      ]);
      if (rec.code === 0)
        record("determinism", "healed", "re-recorded all fixtures");
      else
        record(
          "determinism",
          "manual",
          `record --all failed (coverage lost?) — ${saveLog("determinism-rec", rec.log)}`,
        );
    } else {
      record(
        "determinism",
        "drift",
        "SAFE → npm run record-determinism -- --all",
      );
    }
  }

  // 2. SEED REGISTRY (loadSeed consumers) ───────────────────────────────────
  const reveals = await run("npm", ["run", "test:reveals"]);
  const supply = await run("npm", ["run", "test:supply-ship"]);
  if (reveals.code === 0 && supply.code === 0) {
    record("seed-registry", "ok", "reveals + supply pass");
  } else if (APPLY) {
    await run("npm", ["run", "record-seeds"]);
    const r2 = await run("npm", ["run", "test:reveals"]);
    const s2 = await run("npm", ["run", "test:supply-ship"]);
    if (r2.code === 0 && s2.code === 0)
      record("seed-registry", "healed", "regenerated via record-seeds");
    else
      record(
        "seed-registry",
        "manual",
        `still failing after record-seeds — ${saveLog("seed-registry", r2.log + s2.log)}`,
      );
  } else {
    record("seed-registry", "drift", "→ npm run record-seeds");
  }

  // 3. HAND-TUNED SEED TESTS (detect + guide; no auto-edit) ─────────────────
  const manual = [
    {
      label: "abandon-parity",
      script: "test:network-abandon",
      hint: "re-probe: npm run probe-abandon-seeds -- --mode <classic|modern> --rounds <N>; update TRIALS in test/network-bidirectional-abandon.test.ts",
    },
    {
      label: "upgrades",
      script: "test:upgrades",
      hint: "re-scan SEED in test/upgrades.test.ts (seed where the demolition probe strips walls in the pick→battle window)",
    },
    {
      label: "modifiers",
      script: "test:modifiers",
      hint: "re-scan the failing PER_MODIFIER_SEED entry in test/modifiers.test.ts",
    },
  ];
  for (const check of manual) {
    const result = await run("npm", ["run", check.script]);
    if (result.code === 0) record(check.label, "ok");
    else
      record(
        check.label,
        "manual",
        `${check.hint}  [log: ${saveLog(check.label, result.log)}]`,
      );
  }

  // SUMMARY ─────────────────────────────────────────────────────────────────
  const count = (s: Status) => rows.filter((r) => r.status === s).length;
  console.log(
    `\nSummary: ${count("ok")} ok, ${count("healed")} healed, ${count("drift")} drift, ${count("manual")} manual`,
  );
  const todo = rows.filter(
    (r) => r.status === "drift" || r.status === "manual",
  );
  if (todo.length) {
    console.log(`\nNeeds attention:`);
    for (const t of todo) console.log(`  - ${t.label}: ${t.note}`);
  } else {
    console.log(`\nAll dynamics-sensitive artifacts current.`);
  }
  console.log(
    `\nThen verify parity (not auto-run — slow):\n` +
      `  npm run test:network-vs-local && npm run test:network-bidirectional && npm run test:camera-zoom-parity`,
  );
  return 0;
}

async function run(
  cmd: string,
  args: string[],
): Promise<{ code: number; log: string }> {
  const out = await new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    log: dec.decode(out.stdout) + dec.decode(out.stderr),
  };
}

function saveLog(label: string, log: string): string {
  const path = `/tmp/retune-${label}.log`;
  Deno.writeTextFileSync(path, log);
  return path;
}

function record(label: string, status: Status, note = ""): void {
  rows.push({ label, status, note });
  const icon = { ok: "✓", drift: "~", manual: "!", healed: "✓", bug: "✗" }[
    status
  ];
  console.log(
    `  ${icon} ${label.padEnd(16)} ${status.toUpperCase().padEnd(7)} ${note}`,
  );
}
