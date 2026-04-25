/**
 * Run a Deno test file as a plain script so the V8 inspector sees bps fire.
 *
 * The Deno test runner wraps test bodies in a way that prevents
 * `Debugger.setBreakpoint` from triggering inside them (still investigating
 * the exact cause; see scripts/debug/README notes if added). This wrapper
 * intercepts `Deno.test` and just invokes each registered test directly,
 * which makes breakpoints behave normally.
 *
 * Usage:
 *   deno run --inspect-wait=127.0.0.1:0 -A scripts/debug/run-test.ts \
 *     <test-file> [filter-substring]
 *
 * Driven by `cli.ts launch --deno-test-runner -- <test-file> [filter]`.
 */

interface TestEntry {
  name: string;
  fn: (t: Deno.TestContext) => void | Promise<void>;
  ignore?: boolean;
  only?: boolean;
}

await main();

async function main(): Promise<void> {
  const [filePath, filter] = Deno.args;
  if (!filePath) {
    console.error("usage: run-test.ts <test-file> [filter-substring]");
    Deno.exit(2);
  }

  const tests: TestEntry[] = [];
  installTestShim(tests);

  const fileUrl = filePath.startsWith("file://")
    ? filePath
    : `file://${await absPath(filePath)}`;
  await import(fileUrl);

  // Modules are now parsed; pause here so the CLI can set captures /
  // breakpoints with full visibility into the loaded scripts. The daemon's
  // `continue` handler will resume past this debugger statement.
  debugger;

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const t of tests) {
    if (t.ignore) {
      skipped++;
      continue;
    }
    if (filter && !t.name.includes(filter)) {
      skipped++;
      continue;
    }
    const start = performance.now();
    try {
      const ctx = makeMinimalCtx(t.name);
      await t.fn(ctx);
      const ms = (performance.now() - start).toFixed(0);
      console.log(`ok ${t.name} (${ms}ms)`);
      passed++;
    } catch (e) {
      const ms = (performance.now() - start).toFixed(0);
      const err = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
      console.error(`FAIL ${t.name} (${ms}ms): ${err}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  Deno.exit(failed > 0 ? 1 : 0);
}

function installTestShim(tests: TestEntry[]): void {
  // Deno.test has overloads: (name, fn), (config), (name, options, fn), (fn).
  // Cover the common forms; ignore Deno.test.ignore / .only for now.
  const shim = (
    nameOrConfig: string | Deno.TestDefinition | TestEntry["fn"],
    optsOrFn?: TestEntry["fn"] | Deno.TestStepDefinition,
    maybeFn?: TestEntry["fn"],
  ) => {
    if (typeof nameOrConfig === "function") {
      tests.push({
        name: nameOrConfig.name || "<anonymous>",
        fn: nameOrConfig,
      });
      return;
    }
    if (typeof nameOrConfig === "string") {
      const fn = (
        typeof optsOrFn === "function" ? optsOrFn : maybeFn
      ) as TestEntry["fn"];
      const opts =
        typeof optsOrFn === "object" ? (optsOrFn as { ignore?: boolean }) : {};
      tests.push({ name: nameOrConfig, fn, ignore: opts.ignore });
      return;
    }
    const cfg = nameOrConfig as Deno.TestDefinition;
    tests.push({
      name: cfg.name,
      fn: cfg.fn,
      ignore: cfg.ignore,
      only: cfg.only,
    });
  };
  Object.defineProperty(Deno, "test", {
    value: shim,
    configurable: true,
    writable: true,
  });
}

function makeMinimalCtx(name: string): Deno.TestContext {
  // Minimal test context. Sub-steps run inline. Real Deno.TestContext has
  // more surface, but most repo tests don't use it.
  // deno-lint-ignore no-explicit-any
  return {
    name,
    origin: "<debug-runner>",
    parent: undefined,
    step: async (
      stepNameOrFn:
        | string
        | Deno.TestStepDefinition
        | ((t: Deno.TestContext) => void | Promise<void>),
      maybeFn?: (t: Deno.TestContext) => void | Promise<void>,
    ) => {
      const stepName =
        typeof stepNameOrFn === "string"
          ? stepNameOrFn
          : typeof stepNameOrFn === "function"
            ? stepNameOrFn.name || "<step>"
            : stepNameOrFn.name;
      const stepFn =
        typeof stepNameOrFn === "function"
          ? stepNameOrFn
          : typeof stepNameOrFn === "object"
            ? stepNameOrFn.fn
            : maybeFn;
      try {
        await stepFn?.(makeMinimalCtx(stepName));
        return true;
      } catch (e) {
        console.error(`  step "${stepName}" failed: ${e}`);
        return false;
      }
    },
  } as unknown as Deno.TestContext;
}

async function absPath(p: string): Promise<string> {
  if (p.startsWith("/")) return p;
  return `${Deno.cwd()}/${p}`;
}
