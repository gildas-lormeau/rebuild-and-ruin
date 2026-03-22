/**
 * E2E test for both local and online play.
 *
 * Usage:
 *   npx tsx test/online-e2e.ts local             # local mode: 3 AI, no server needed
 *   npx tsx test/online-e2e.ts local 1           # local mode: 1 human + 2 AI
 *   npx tsx test/online-e2e.ts online            # online mode: 2 humans (default)
 *   npx tsx test/online-e2e.ts online 0          # online mode: 0 humans (3 AI demo)
 *   npx tsx test/online-e2e.ts online 1          # online mode: 1 human + 2 AI + watcher
 *   npx tsx test/online-e2e.ts online 3   # online mode: 3 humans + watcher
 *   npx tsx test/online-e2e.ts online 1 https://example.deno.dev  # remote server
 *   npx tsx test/online-e2e.ts local 0 "" 5   # local, 5 battles before stopping
 *   npx tsx test/online-e2e.ts local 0 --screenshot  # capture screenshots at phase transitions
 *   npx tsx test/online-e2e.ts local 0 --mobile     # emulate mobile (Pixel 7, landscape)
 *   npx tsx test/online-e2e.ts local 0 --mobile --screenshot  # both
 *   npx tsx test/online-e2e.ts local 0 --mobile --action "phase:BATTLE click:zoom screenshot:zoomed exit"
 *   npx tsx test/online-e2e.ts local 0 --headless          # run without browser window
 *   npx tsx test/online-e2e.ts local 0 --seed 12345        # force specific map seed
 *   npx tsx test/online-e2e.ts local 0 --assert "phase:BATTLE button:quit visible"  # assert UI state
 *
 * Online mode requires: deno task server (port 8001) + npm run dev (port 5173)
 *   — or pass a remote URL as the 4th argument (uses that URL for both site and server)
 * Local mode requires: npm run dev (port 5173)
 */

import { chromium, devices, type Page, type Browser } from "playwright";
import { writeFileSync, mkdirSync } from "fs";
import process from "node:process";

const SCREENSHOTS = process.argv.includes("--screenshot");
const MOBILE = process.argv.includes("--mobile");
const HEADLESS = process.argv.includes("--headless");
const RECORD = process.argv.includes("--record");
const SEED = (() => {
  const idx = process.argv.indexOf("--seed");
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1]! : "";
})();

// Parse --action flags: "phase:BATTLE click:zoom screenshot:label exit"
interface TestAction {
  trigger: { type: "phase" | "mode"; value: string };
  click?: string; // "zoom" | "rotate" | "quit" | "X,Y"
  screenshot?: string;
  exit?: boolean;
  done?: boolean;
}
const ACTIONS: TestAction[] = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--action" && process.argv[i + 1]) {
    const parts = process.argv[++i]!.split(/\s+/);
    const action: TestAction = { trigger: { type: "phase", value: "" } };
    for (const part of parts) {
      if (part.startsWith("phase:")) action.trigger = { type: "phase", value: part.slice(6) };
      else if (part.startsWith("mode:")) action.trigger = { type: "mode", value: part.slice(5) };
      else if (part.startsWith("click:")) action.click = part.slice(6);
      else if (part.startsWith("screenshot:")) action.screenshot = part.slice(11);
      else if (part === "exit") action.exit = true;
    }
    if (action.trigger.value) ACTIONS.push(action);
  }
}

// Parse --assert flags: "phase:BATTLE button:zoom visible"
interface TestAssert {
  trigger: { type: "phase" | "mode"; value: string };
  button?: string; // "zoom" | "rotate" | "quit"
  expected?: "visible" | "hidden";
  text?: string; // check that text appears in the page
  done?: boolean;
  passed?: boolean;
}
const ASSERTS: TestAssert[] = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--assert" && process.argv[i + 1]) {
    const parts = process.argv[++i]!.split(/\s+/);
    const assert: TestAssert = { trigger: { type: "phase", value: "" } };
    for (const part of parts) {
      if (part.startsWith("phase:")) assert.trigger = { type: "phase", value: part.slice(6) };
      else if (part.startsWith("mode:")) assert.trigger = { type: "mode", value: part.slice(5) };
      else if (part.startsWith("button:")) assert.button = part.slice(7);
      else if (part === "visible") assert.expected = "visible";
      else if (part === "hidden") assert.expected = "hidden";
      else if (part.startsWith("text:")) assert.text = part.slice(5);
    }
    if (assert.trigger.value) ASSERTS.push(assert);
  }
}

// Filter positional args: skip --flags and their values
const positionalArgs: string[] = [];
{
  const args = process.argv.slice(2);
  const flagsWithValue = new Set(["--action", "--assert", "--seed"]);
  for (let i = 0; i < args.length; i++) {
    if (flagsWithValue.has(args[i]!)) { i++; continue; } // skip flag + value
    if (args[i]!.startsWith("--")) continue; // skip boolean flags
    positionalArgs.push(args[i]!);
  }
}
const MODE = positionalArgs[0] === "local" ? "local" : "online";
const NUM_HUMANS = Math.min(3, Math.max(0, Number(positionalArgs[1] ?? (MODE === "local" ? 0 : 2))));
const SERVER_URL = positionalArgs[2] || process.env.E2E_SERVER_URL || "";
const MIN_BATTLES = Math.max(1, Number(positionalArgs[3] ?? 2)); // stop after N battles (default 2)
const BASE_URL = "http://localhost:5173/";
const PAGE_URL = SERVER_URL ? `${BASE_URL}?server=${new URL(SERVER_URL).host}` : BASE_URL;
const GAME_TIMEOUT_MS = 600_000; // 10 minutes — enough for "To The Death"
const PLAYER_NAMES = ["Red", "Blue", "Gold"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ts(): string {
  return `[${(performance.now() / 1000).toFixed(1)}s]`;
}

function printAssertSummary(): void {
  if (ASSERTS.length === 0) return;
  const passed = ASSERTS.filter(a => a.done && a.passed).length;
  const failed = ASSERTS.filter(a => a.done && !a.passed).length;
  const skipped = ASSERTS.filter(a => !a.done).length;
  console.log(`\n=== ASSERTIONS: ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
}

function btnSelector(name: string): string {
  if (name === "zoom") return "button[style*='left: 24px'][style*='bottom']";
  if (name === "rotate") return "button[style*='right: 24px'][style*='bottom']";
  if (name === "quit") return "button[style*='right: 12px'][style*='top']";
  return `button:has-text("${name}")`;
}

/** Execute pending asserts that match current phase/mode. Returns false if any assert failed. */
async function executeAsserts(page: Page, phase: string, mode: string): Promise<boolean> {
  let allPassed = true;
  for (const assert of ASSERTS) {
    if (assert.done) continue;
    const match = assert.trigger.type === "phase"
      ? phase === assert.trigger.value
      : mode === assert.trigger.value;
    if (!match) continue;
    assert.done = true;

    if (assert.button && assert.expected) {
      const btn = await page.$(btnSelector(assert.button));
      const isVisible = btn ? await btn.isVisible() : false;
      const expectVisible = assert.expected === "visible";
      assert.passed = isVisible === expectVisible;
      const status = assert.passed ? "PASS" : "FAIL";
      console.log(`${ts()} Assert ${status}: button:${assert.button} ${assert.expected} (actual: ${isVisible ? "visible" : "hidden"})`);
      if (!assert.passed) allPassed = false;
    }

    if (assert.text) {
      const content = await page.evaluate(() => document.body.innerText).catch(() => "");
      const found = content.includes(assert.text);
      assert.passed = found;
      const status = found ? "PASS" : "FAIL";
      console.log(`${ts()} Assert ${status}: text:"${assert.text}" ${found ? "found" : "not found"}`);
      if (!found) allPassed = false;
    }
  }
  return allPassed;
}

/** Install a vibrate spy on mobile-emulated pages. */
async function installVibrateSpy(page: Page): Promise<void> {
  if (!MOBILE) return;
  await page.addInitScript(() => {
    const calls: number[] = [];
    // deno-lint-ignore no-explicit-any
    (window as any).__vibrateCalls = calls;
    const orig = navigator.vibrate?.bind(navigator);
    // @ts-expect-error overload mismatch
    navigator.vibrate = (pattern: VibratePattern) => {
      const ms = typeof pattern === "number" ? pattern : [...pattern][0] ?? 0;
      calls.push(ms);
      return orig ? orig(pattern) : true;
    };
  });
}

const HAPTIC_LABELS: Record<number, string> = {
  15: "fired", 30: "wall_hit", 40: "phase_change",
  80: "cannon_dmg", 150: "cannon_dead", 200: "tower_kill",
};

async function printHapticSummary(page: Page): Promise<void> {
  if (!MOBILE) return;
  // deno-lint-ignore no-explicit-any
  const calls = await page.evaluate(() => (window as any).__vibrateCalls as number[] ?? []).catch(() => []);
  if (calls.length === 0) { console.log("\n=== HAPTICS: no vibrate calls ==="); return; }
  const counts: Record<number, number> = {};
  for (const c of calls) counts[c] = (counts[c] || 0) + 1;
  console.log(`\n=== HAPTICS: ${calls.length} vibrate calls ===`);
  for (const [ms, n] of Object.entries(counts).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const label = HAPTIC_LABELS[Number(ms)] ?? "?";
    console.log(`  ${ms}ms (${label}): ${n}x`);
  }
}

/** Execute pending actions that match current phase/mode. Returns true if an action requested exit. */
async function executeActions(page: Page, phase: string, mode: string): Promise<boolean> {
  for (const action of ACTIONS) {
    if (action.done) continue;
    const match = action.trigger.type === "phase"
      ? phase === action.trigger.value
      : mode === action.trigger.value;
    if (!match) continue;
    action.done = true;
    console.log(`${ts()} Action triggered: ${action.trigger.type}:${action.trigger.value}`);

    if (action.click) {
      const target = action.click;
      if (target === "zoom" || target === "rotate" || target === "quit") {
        const btn = await page.$(btnSelector(target));
        if (btn) {
          await btn.click();
          console.log(`${ts()} Clicked ${target} button`);
        } else {
          console.log(`${ts()} WARNING: ${target} button not found`);
        }
      } else if (target.includes(",")) {
        const [x, y] = target.split(",").map(Number);
        await page.mouse.click(x!, y!);
        console.log(`${ts()} Clicked at (${x},${y})`);
      }
      // Brief pause for render to update
      await page.waitForTimeout(200);
    }

    if (action.screenshot) {
      await takeScreenshot(page, "action", action.screenshot, true);
    }

    if (action.exit) {
      console.log(`${ts()} Action requested exit`);
      return true;
    }
  }
  return false;
}

const screenshotsTaken = new Set<string>();
async function takeScreenshot(page: Page, prefix: string, label: string, force = false): Promise<void> {
  if (!SCREENSHOTS && !force) return;
  const key = `${prefix}-${label}`;
  if (screenshotsTaken.has(key)) return; // one per label
  screenshotsTaken.add(key);
  const filename = `logs/screenshot-${prefix}-${label}.png`;
  await page.screenshot({ path: filename, fullPage: true });
  console.log(`${ts()} Screenshot: ${filename}`);
}

const MOBILE_DEVICE = devices["Pixel 7"];

async function newPage(browser: Browser): Promise<Page> {
  const recordVideo = RECORD ? { dir: "logs/", size: { width: 1024, height: 600 } } : undefined;
  if (MOBILE) {
    const ctx = await browser.newContext({
      ...MOBILE_DEVICE,
      viewport: { width: MOBILE_DEVICE.viewport.height, height: MOBILE_DEVICE.viewport.width },
      recordVideo,
    });
    return ctx.newPage();
  }
  const ctx = await browser.newContext({ recordVideo });
  return ctx.newPage();
}

function collectLogs(page: Page, prefix: string, logs: string[]): void {
  page.on("console", (m: { type: () => string; text: () => string }) =>
    logs.push(`${ts()} [${prefix} ${m.type()}] ${m.text()}`));
  page.on("pageerror", (err: Error) =>
    logs.push(`${ts()} [${prefix} ERROR] ${err.message}`));
}

// ---------------------------------------------------------------------------
// Online helpers
// ---------------------------------------------------------------------------

async function createRoom(page: Page): Promise<string> {
  await page.goto(PAGE_URL);
  await page.click("#btn-online");
  await page.waitForSelector("#lobby[data-ready]", { timeout: 10000 });
  await page.click("#btn-create");
  await page.waitForSelector("#lobby-create.active");
  await page.selectOption("#set-wait", "10");
  await page.selectOption("#set-rounds", "3");
  await page.click("#btn-create-confirm");
  await page.waitForFunction(
    () => document.getElementById("lobby")?.style.display === "none",
    { timeout: 10000 },
  );
  await page.waitForTimeout(300);
  const code = await page.evaluate(() => {
    const el = document.getElementById("room-code-overlay");
    return el?.innerText?.trim()?.match(/[A-Z]{4}/)?.[0] ?? "";
  });
  if (code.length !== 4) throw new Error("Failed to extract room code");
  return code;
}

async function joinRoom(page: Page, code: string): Promise<void> {
  await page.goto(PAGE_URL);
  await page.click("#btn-online");
  await page.waitForSelector("#lobby[data-ready]", { timeout: 10000 });
  await page.click("#btn-join-show");
  await page.waitForSelector("#lobby-join.active");
  await page.fill("#join-code", code);
  await page.click("#btn-join-confirm");
  await page.waitForFunction(
    () => document.getElementById("lobby")?.style.display === "none",
    { timeout: 10000 },
  );
}

async function selectSlot(page: Page, slot: number): Promise<void> {
  const keys = ["n", "f", "h"];
  const key = keys[slot];
  if (!key) throw new Error(`Invalid slot ${slot}`);
  await page.keyboard.press(key);
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
// Local mode
// ---------------------------------------------------------------------------

async function runLocal() {
  const browser = await chromium.launch({ headless: HEADLESS, args: ["--window-size=1024,600"] });
  const page = await newPage(browser);
  await installVibrateSpy(page);
  const logs: string[] = [];
  collectLogs(page, "LOCAL", logs);

  console.log(`${ts()} Starting local E2E test: ${NUM_HUMANS} human${NUM_HUMANS !== 1 ? "s" : ""} + ${3 - NUM_HUMANS} AI`);

  await page.goto(BASE_URL);
  // Set rounds + optional seed via localStorage
  await page.evaluate((seed: string) => {
    const settings = JSON.parse(localStorage.getItem("castles99_settings") || "{}");
    settings.rounds = 0; // ROUNDS_OPTIONS[0] = { value: 3, label: "3" }
    if (seed) {
      settings.seedMode = "custom";
      settings.seed = seed;
    }
    localStorage.setItem("castles99_settings", JSON.stringify(settings));
    document.title = "Local Play";
  }, SEED);
  // Click "Local Play" to load main.ts and show canvas lobby
  await page.click("#btn-local");
  await page.waitForSelector("canvas[style*='display: block']", { timeout: 5000 });
  await page.waitForTimeout(500);

  // Join human slots (keys: n=P0, f=P1, h=P2)
  const slotKeys = ["n", "f", "h"];
  for (let i = 0; i < NUM_HUMANS; i++) {
    await page.keyboard.press(slotKeys[i]!);
    console.log(`${ts()} Joined slot ${i} (${PLAYER_NAMES[i]}) as human`);
    await page.waitForTimeout(300);
  }

  // Wait for the game to start (lobby timer expires or all slots filled)
  console.log(`${ts()} Waiting for lobby timer to expire...`);
  await takeScreenshot(page, "game", "lobby");
  await page.waitForFunction(
    () => {
      const w = window as unknown as Record<string, unknown>;
      return w.__testMode !== undefined && w.__testMode !== "LOBBY";
    },
    { timeout: 90_000 },
  );
  console.log(`${ts()} Game started`);

  // Simulate human play or wait for AI-only game
  let allActions: string[][] = [];
  if (NUM_HUMANS > 0) {
    allActions = [await simulateHumanPlayLoop(page, "LOCAL", GAME_TIMEOUT_MS)];
  } else {
    // All-AI: poll until first battle ends (enough to check orbit), or game over
    const deadline = Date.now() + GAME_TIMEOUT_MS;
    let lastReported = "";
    let battleCount = 0;
    let inBattle = false;
    while (Date.now() < deadline) {
      const info = await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        return {
          mode: w.__testMode as string ?? "",
          phase: w.__testPhase as string ?? "",
          timer: w.__testTimer as number ?? 0,
        };
      }).catch(() => ({ mode: "", phase: "", timer: 0 }));
      if (info.mode === "STOPPED") {
        console.log(`${ts()} Game over detected`);
        await takeScreenshot(page, "game", "game-over");
        break;
      }
      const key = `${info.mode}/${info.phase}`;
      if (key !== lastReported) {
        console.log(`${ts()} Phase: ${info.mode} / ${info.phase} (timer=${info.timer.toFixed(1)})`);
        const label = `${info.mode}-${info.phase}`.toLowerCase().replace(/[^a-z0-9]/g, "-");
        await takeScreenshot(page, "game", label);
        lastReported = key;
        if (await executeActions(page, info.phase, info.mode)) break;
        await executeAsserts(page, info.phase, info.mode);
      }
      if (info.phase === "BATTLE" && info.mode === "GAME" && !inBattle) { battleCount++; inBattle = true; }
      if (info.phase !== "BATTLE") inBattle = false;
      // Stop after second battle ends (need 2 battles to verify crosshair reset)
      if (battleCount >= MIN_BATTLES && info.phase === "WALL_BUILD") {
        console.log(`${ts()} ${MIN_BATTLES} battle(s) complete — stopping early`);
        break;
      }
      await page.waitForTimeout(500);
    }
  }

  // Check final game state
  const finalMode = await page.evaluate(() =>
    (window as unknown as Record<string, unknown>).__testMode as string
  ).catch(() => "unknown");
  if (finalMode === "STOPPED") {
    logs.push(`[LOCAL] game_over — game ended normally`);
  } else {
    logs.push(`[LOCAL] game still running (mode=${finalMode})`);
  }

  // --- ANALYSIS ---
  analyzeResults(
    allActions,
    [logs],
    NUM_HUMANS > 0 ? ["LOCAL"] : [],
    ["LOCAL"],
    `local-${NUM_HUMANS}h`,
  );

  await printHapticSummary(page);
  if (RECORD) {
    const videoPath = await page.video()?.path();
    if (videoPath) console.log(`${ts()} Video: ${videoPath}`);
  }
  printAssertSummary();
  await page.close(); // finalize video before closing browser
  await browser.close();
  console.log(`\n${ts()} Local E2E test complete.`);
  if (ASSERTS.some(a => a.done && !a.passed)) process.exit(1);
}

// ---------------------------------------------------------------------------
// Online mode
// ---------------------------------------------------------------------------

async function runOnline() {
  const browser = await chromium.launch({ headless: HEADLESS, args: ["--window-size=1024,600"] });
  const clientLogs: string[][] = [];
  const clientLabels: string[] = [];
  const clientPages: Page[] = [];
  const humanPages: Page[] = [];

  console.log(`${ts()} Starting online E2E test: ${NUM_HUMANS} human${NUM_HUMANS !== 1 ? "s" : ""} + ${3 - NUM_HUMANS} AI, 3 rounds`);

  // --- HOST ---
  const hostPage = await newPage(browser);
  await installVibrateSpy(hostPage);
  const hostLogs: string[] = [];
  collectLogs(hostPage, "HOST", hostLogs);
  const code = await createRoom(hostPage);

  const isHostHuman = NUM_HUMANS >= 1;
  if (isHostHuman) {
    await hostPage.evaluate(() => { document.body.style.zoom = "70%"; document.title = "P0 Red — Host"; });
    await selectSlot(hostPage, 0);
    console.log(`${ts()} Host selected slot 0 (Red) — human`);
    humanPages.push(hostPage);
  } else {
    await hostPage.evaluate(() => { document.body.style.zoom = "70%"; document.title = "Host (demo)"; });
    console.log(`${ts()} Host created room (demo mode, no slot)`);
  }
  clientPages.push(hostPage);
  clientLogs.push(hostLogs);
  clientLabels.push("HOST");
  await hostPage.waitForTimeout(1500);

  // --- ADDITIONAL HUMAN PLAYERS ---
  for (let i = 1; i < NUM_HUMANS; i++) {
    const page = await newPage(browser);
    const logs: string[] = [];
    const label = `P${i}`;
    collectLogs(page, label, logs);
    await joinRoom(page, code);
    await page.evaluate((info: { i: number; name: string }) => {
      document.body.style.zoom = "70%";
      document.title = `P${info.i} ${info.name} — Player`;
    }, { i, name: PLAYER_NAMES[i]! });
    await selectSlot(page, i);
    console.log(`${ts()} Player joined as slot ${i} (${PLAYER_NAMES[i]}) — human`);
    humanPages.push(page);
    clientPages.push(page);
    clientLogs.push(logs);
    clientLabels.push(label);
    await page.waitForTimeout(1000);
  }

  // --- WATCHER ---
  const watcherPage = await newPage(browser);
  const watcherLogs: string[] = [];
  collectLogs(watcherPage, "WATCH", watcherLogs);
  await joinRoom(watcherPage, code);
  await watcherPage.evaluate(() => { document.body.style.zoom = "70%"; document.title = "Watcher"; });
  console.log(`${ts()} Watcher joined room ${code}`);
  clientPages.push(watcherPage);
  clientLogs.push(watcherLogs);
  clientLabels.push("WATCHER");

  // --- SIMULATION ---
  console.log(`${ts()} Starting simulation (${humanPages.length} human loops)`);

  let allActions: string[][] = [];
  if (humanPages.length > 0) {
    allActions = await Promise.all(
      humanPages.map((page, i) => {
        const label = i === 0 ? "HOST" : `P${i}`;
        return simulateHumanPlayLoop(page, label, GAME_TIMEOUT_MS);
      }),
    );
  } else {
    // All-AI demo: poll host page for game over
    const deadline = Date.now() + GAME_TIMEOUT_MS;
    let lastReported = "";
    while (Date.now() < deadline) {
      const info = await hostPage.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        return {
          mode: w.__testMode as string ?? "",
          phase: w.__testPhase as string ?? "",
          timer: w.__testTimer as number ?? 0,
        };
      }).catch(() => ({ mode: "", phase: "", timer: 0 }));
      if (info.mode === "STOPPED") {
        console.log(`${ts()} Game over detected`);
        await takeScreenshot(hostPage, "game", "game-over");
        break;
      }
      const key = `${info.mode}/${info.phase}`;
      if (key !== lastReported) {
        console.log(`${ts()} Phase: ${info.mode} / ${info.phase} (timer=${info.timer.toFixed(1)})`);
        const label = `${info.mode}-${info.phase}`.toLowerCase().replace(/[^a-z0-9]/g, "-");
        await takeScreenshot(hostPage, "game", label);
        lastReported = key;
        if (await executeActions(hostPage, info.phase, info.mode)) break;
        await executeAsserts(hostPage, info.phase, info.mode);
      }
      await hostPage.waitForTimeout(500);
    }
  }

  // --- ANALYSIS ---
  const actionLabels = humanPages.map((_, i) => i === 0 ? "HOST" : `P${i}`);
  analyzeResults(allActions, clientLogs, actionLabels, clientLabels, `online-${NUM_HUMANS}h`);

  // Online-specific: critical messages check
  const critical = ["castle_walls", "cannon_start", "battle_start", "build_start"];
  for (let i = 1; i < clientLabels.length; i++) {
    const counts = countMessageTypes(clientLogs[i]!);
    const missing = critical.filter(t => !counts[t]);
    if (missing.length > 0) {
      console.log(`\n=== MISSING CRITICAL MESSAGES (${clientLabels[i]}) ===`);
      for (const t of missing) console.log(`  ${t}: NOT received`);
    } else {
      console.log(`\n=== ALL CRITICAL MESSAGES RECEIVED BY ${clientLabels[i]} ===`);
    }
  }

  await printHapticSummary(hostPage);
  printAssertSummary();
  await browser.close();
  console.log(`\n${ts()} Online E2E test complete.`);
  if (ASSERTS.some(a => a.done && !a.passed)) process.exit(1);
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

async function simulateHumanPlayLoop(page: Page, label: string, durationMs: number): Promise<string[]> {
  const actions: string[] = [];
  const start = Date.now();
  let iteration = 0;

  while (Date.now() - start < durationMs) {
    iteration++;

    const { mode, phase } = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const testMode = w.__testMode as string | undefined;
      if (!testMode) {
        const lobby = document.getElementById("lobby");
        if (lobby && lobby.style.display !== "none") return { mode: "DOM_LOBBY", phase: "" };
      }
      return {
        mode: testMode ?? "unknown",
        phase: (w.__testPhase as string) ?? "",
      };
    }).catch(() => ({ mode: "unknown", phase: "" }));

    if (mode === "LOBBY" && iteration > 50) {
      actions.push(`${ts()} ${label}: game ended (lobby visible)`);
      break;
    }

    if (mode === "DOM_LOBBY") {
      await page.waitForTimeout(500);
      continue;
    }

    if (mode === "STOPPED") {
      actions.push(`${ts()} ${label}: game over`);
      break;
    }

    if (mode === "LIFE_LOST") {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(100);
      await page.keyboard.press("n");
      actions.push(`${ts()} ${label}: life-lost dialog — pressed abandon`);
      await page.waitForTimeout(300);
      continue;
    }

    if (mode === "BANNER" || mode === "BALLOON_ANIM" || mode === "CASTLE_BUILD") {
      await page.waitForTimeout(200);
      continue;
    }

    if (mode === "SELECTION") {
      const timer = await page.evaluate(() => {
        return (window as unknown as Record<string, unknown>).__testTimer as number ?? 10;
      }).catch(() => 10);

      if (timer > 4) {
        await page.keyboard.press(Math.random() < 0.5 ? "ArrowRight" : "ArrowLeft");
        await page.waitForTimeout(500);
      } else {
        await page.keyboard.press("n");
        actions.push(`${ts()} ${label}: confirmed tower selection`);
        await page.waitForTimeout(300);
      }
      continue;
    }

    if (phase === "CANNON_PLACE") {
      await page.keyboard.press("n");
      await page.waitForTimeout(100);
      const dir = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"][Math.floor(Math.random() * 4)]!;
      await page.keyboard.press(dir);
      await page.waitForTimeout(50);
      await page.keyboard.press("n");
      if (iteration % 50 === 0) actions.push(`${ts()} ${label}: cannon phase iteration ${iteration}`);
      await page.waitForTimeout(200);
      continue;
    }

    if (phase === "WALL_BUILD") {
      const dirs = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
      for (let i = 0; i < 1 + Math.floor(Math.random() * 3); i++) {
        await page.keyboard.press(dirs[Math.floor(Math.random() * dirs.length)]!);
        await page.waitForTimeout(30);
      }
      if (Math.random() < 0.3) await page.keyboard.press("b");
      await page.keyboard.press("n");
      if (iteration % 50 === 0) actions.push(`${ts()} ${label}: build phase iteration ${iteration}`);
      await page.waitForTimeout(150);
      continue;
    }

    if (phase === "BATTLE") {
      const aim = await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const targets = w.__testEnemyTargets as { x: number; y: number }[] | undefined;
        const ch = w.__testCrosshair as { x: number; y: number } | undefined;
        if (!targets || targets.length === 0 || !ch) return null;
        let best = targets[0]!, bestDist = Infinity;
        for (const t of targets) {
          const d = Math.hypot(t.x - ch.x, t.y - ch.y);
          if (d < bestDist) { bestDist = d; best = t; }
        }
        return { dx: best.x - ch.x, dy: best.y - ch.y, dist: bestDist };
      }).catch(() => null);

      if (aim && aim.dist > 8) {
        const key = Math.abs(aim.dx) > Math.abs(aim.dy)
          ? (aim.dx > 0 ? "ArrowRight" : "ArrowLeft")
          : (aim.dy > 0 ? "ArrowDown" : "ArrowUp");
        await page.keyboard.down(key);
        await page.waitForTimeout(150);
        await page.keyboard.up(key);
      } else {
        await page.keyboard.press("n");
        await page.waitForTimeout(100);
      }
      if (iteration % 50 === 0) actions.push(`${ts()} ${label}: battle iteration ${iteration}`);
      await page.waitForTimeout(30);
      continue;
    }

    if (iteration % 50 === 0) actions.push(`${ts()} ${label}: iteration ${iteration} (mode=${mode} phase=${phase})`);
    await page.waitForTimeout(200);
  }

  actions.push(`${ts()} ${label}: simulation ended after ${iteration} iterations`);
  return actions;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function countMessageTypes(logs: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const l of logs) {
    const match = l.match(/received:\s+(\S+)/);
    if (match) counts[match[1]!] = (counts[match[1]!] ?? 0) + 1;
  }
  return counts;
}

function analyzeResults(
  allActions: string[][],
  clientLogs: string[][],
  actionLabels: string[],
  clientLabels: string[],
  filePrefix: string,
): void {
  const output: string[] = [];
  const log = (s: string) => { console.log(s); output.push(s); };

  for (let i = 0; i < allActions.length; i++) {
    const actions = allActions[i]!;
    const label = actionLabels[i] ?? `P${i}`;
    log(`\n=== ${label} ACTIONS (${actions.length}) ===`);
    for (const a of actions.slice(-15)) log(`  ${a}`);
  }

  // Errors
  const allLogs = clientLogs.flat();
  const errors = allLogs.filter(l => l.includes("ERROR"));
  if (errors.length > 0) {
    log(`\n=== ERRORS (${errors.length}) ===`);
    for (const e of errors.slice(0, 20)) log(`  ${e}`);
  } else {
    log("\n=== NO ERRORS ===");
  }

  // Message counts (online only)
  for (let i = 0; i < clientLabels.length; i++) {
    const counts = countMessageTypes(clientLogs[i]!);
    if (Object.keys(counts).length > 0) {
      log(`\n=== ${clientLabels[i]} MESSAGE COUNTS ===`);
      for (const [type, count] of Object.entries(counts).sort()) log(`  ${type}: ${count}`);
    }
  }

  // Game over
  log(`\n=== GAME OVER ===`);
  for (let i = 0; i < clientLabels.length; i++) {
    const saw = clientLogs[i]!.some(l => l.includes("game_over") || l.includes("endGame"));
    log(`  ${clientLabels[i]} saw game_over: ${saw}`);
  }

  // Life-lost
  log("\n=== LIFE-LOST DIALOG ===");
  for (let i = 0; i < clientLabels.length; i++) {
    for (const l of clientLogs[i]!) {
      if (l.includes("showLifeLostDialog") || l.includes("lifeLostDialog resolved") ||
          l.includes("life_lost_choice") || l.includes("dismissing stale")) {
        log(`  ${clientLabels[i]}: ${l}`);
      }
    }
  }

  // Save logs
  mkdirSync("logs", { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
  const logPath = `logs/e2e-${filePrefix}-${timestamp}.log`;
  const rawLogs: string[] = [];
  for (let i = 0; i < clientLabels.length; i++) {
    rawLogs.push(`\n=== RAW ${clientLabels[i]} LOGS ===`);
    rawLogs.push(...clientLogs[i]!);
  }
  writeFileSync(logPath, [...output, ...rawLogs].join("\n"));
  log(`\nLogs saved to ${logPath}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (MODE === "local") {
  runLocal().catch((err: Error) => {
    console.error("Local E2E test failed:", err.message);
    process.exit(1);
  });
} else {
  runOnline().catch((err: Error) => {
    console.error("Online E2E test failed:", err.message);
    process.exit(1);
  });
}
