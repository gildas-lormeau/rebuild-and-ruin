# Test patterns

Practical catalogue of the ~5 shapes tests in this codebase take. Match
your intent to a shape, copy the template, adapt. See
[skills/add-test.md](../skills/add-test.md) for the end-to-end authoring
workflow.

All templates assume:

```ts
import {
  createScenario,
  step,
  waitForPhase,
  waitForBanner,
  waitForModifier,
  waitForEvent,
} from "./scenario.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
```

---

## 1. State assertion after phase

**When:** you want to assert an invariant once the game reaches a
specific phase/round.

**Shape:** boot scenario → run to phase → assert on `sc.state`.

```ts
Deno.test("scenario: walled-in tower is revived", async () => {
  const sc = await createScenario({ seed: 42, rounds: 3 });
  await step("reach second build phase", () =>
    waitForPhase(sc, Phase.WALL_BUILD),
  );
  const player = sc.state.players[0]!;
  assert(player.towers.some((t) => t.alive), "expected a revived tower");
});
```

**Gotchas:** phase predicates resolve on the *first* frame entering the
phase — if you need end-of-phase state, combine with
`waitForEvent(sc, GAME_EVENT.PHASE_END, …)`.

---

## 2. Event sequence verification

**When:** you want to assert that a set of events fired in the right
order, or that a specific event count matches expectations.

**Shape:** subscribe via `sc.bus.on(GAME_EVENT.X, …)` → drive the game →
assert on the collected list.

```ts
Deno.test("scenario: cannon-fire events match cannon count", async () => {
  const sc = await createScenario({ seed: 42, rounds: 1 });
  const fires: unknown[] = [];
  sc.bus.on(GAME_EVENT.CANNON_FIRED, (ev) => fires.push(ev));
  await step("play one full battle", () => waitForPhase(sc, Phase.WALL_BUILD));
  assert(fires.length > 0, "expected at least one cannon shot");
});
```

**Gotchas:** subscribe *before* driving the runtime — events fired
between scenario creation and your `on()` call are lost. Use
`recordEvents(sc)` if you want a running log with timestamps.

---

## 3. Counterfactual comparison

**When:** you want to prove that a specific modifier/upgrade/setting
changes outcomes. Run the same seed with and without, diff.

**Shape:** two scenarios with matched seeds → run both to the same point
→ compare state or event logs.

```ts
Deno.test("scenario: reinforced walls absorbs one extra hit", async () => {
  const base = await createScenario({ seed: 42, rounds: 1 });
  const upg = await createScenario({
    seed: 42,
    rounds: 1,
    mode: "modern",
    forcedUpgrade: "reinforced-walls",
  });
  await Promise.all([
    waitForPhase(base, Phase.WALL_BUILD),
    waitForPhase(upg, Phase.WALL_BUILD),
  ]);
  // assert walls in `upg` absorbed more damage than `base`
});
```

**Gotchas:** match *every* initial condition — seed, mode, rounds,
player count. Small divergences propagate through RNG substreams.

---

## 4. Determinism check

**When:** asserting that the same seed+mode produces the same event log
byte-for-byte across runs.

**Shape:** recorded bus event log in `test/determinism-fixtures/` →
re-run headless → diff.

See [determinism.test.ts](determinism.test.ts) for the canonical
template. Usually you don't write a new test here — you add a new
fixture via `npm run record-determinism -- --seed N --mode ...` when the
set of code paths you cover needs expanding. Never re-record a failing
fixture without justifying *why* the event log changed.

---

## 5. Online parity

**When:** asserting that `hostMode` produces identical game-state to
`localMode` for the same seed. Validates that checkpoint serialization
and watcher tick logic stay lossless.

**Shape:** wire a host-mode scenario and a local-mode scenario through
the same checkpoint replay, diff their state snapshots each frame.

See [host-vs-local-sync.test.ts](host-vs-local-sync.test.ts) — this is
the network parity gate. New online code paths that change checkpoint
fields should add a new seed to its coverage list.

---

## Anti-patterns

1. **Don't mutate `sc.state` directly** (`state.phase = X`, `state.lives = 0`).
   Tests must play the game through inputs + events. If you need a specific
   condition, find a seed that produces it (see `scripts/find-seed.ts`).
2. **Don't construct subsystems standalone** (`new PhaseSetup(...)`,
   isolated `battleTick(...)`). Go through `createScenario`.
3. **Don't use frame/tick counts for timing** (`{ maxTicks: 1000 }`).
   Use `{ timeoutMs }`. Enforced by `lint:test-timeouts`.
4. **Don't call `page.waitForFunction` directly in E2E.** Use
   `waitForPageFn` / `waitForPageExpr` from `test/e2e-helpers.ts`.
   Enforced by `lint:raw-playwright`.

## Related

- [skills/add-test.md](../skills/add-test.md) — step-by-step authoring flow.
- [scenario.ts](scenario.ts) — public test API.
- [e2e-scenario.ts](e2e-scenario.ts) — Playwright mirror.
- [reference_test_api.md](../../.claude/projects/-Users-gildas-Desktop-Dev-project-castles-99/memory/reference_test_api.md)
  (if present) — living reference notes.
