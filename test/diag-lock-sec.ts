/**
 * Per-tick trace of selectTarget for a single AI build-survival stall round.
 * Used to characterize LOCK SEC sub-modes (scatter / plateau / steady-progress /
 * stragglers) — see Mode #8 in project_ai_build_stall_investigation memory.
 *
 * Usage: deno run -A test/diag-lock-sec.ts <seed> <round> <playerId>
 * Where playerId is 0=RED, 1=BLUE, 2=GOLD.
 *
 * Emits per-tick path/chosen-tower/gap-count/rect-bbox plus a round summary:
 * wall-row distribution, walls-in-target-gaps ratio, gap-set evolution, and
 * an ASCII snapshot of the target rect area at the first selectTarget call.
 */

await main();

async function main() {
  const seedArg = Deno.args[0];
  const roundArg = Deno.args[1];
  const playerArg = Deno.args[2];
  if (!seedArg || !roundArg || !playerArg) {
    console.error("Usage: deno run -A diag-lock-sec.ts <seed> <round> <playerId>");
    Deno.exit(1);
  }
  const seed = Number(seedArg);
  const targetRound = Number(roundArg);
  const targetPlayer = Number(playerArg);

  const { createScenario, waitForEvent } = await import("./scenario.ts");
  const { setSelectTargetPathHook } = await import(
    "../src/ai/ai-build-target.ts"
  );
  const { Phase } = await import("../src/shared/core/game-phase.ts");
  const { GAME_EVENT } = await import(
    "../src/shared/core/game-event-bus.ts"
  );

  const sc = await createScenario({
    seed,
    mode: "modern",
    rounds: targetRound + 2,
    renderer: "ascii",
  });

  type Tick = {
    tick: number;
    path: string;
    chosen?: number;
    gaps?: number;
    rect?: string;
    gapKeys?: string[];
  };
  const ticks: Tick[] = [];
  let tickIdx = 0;

  let firstTickSnapshot: string | null = null;
  setSelectTargetPathHook((playerId, round, path, result) => {
    if (round !== targetRound || playerId !== targetPlayer) return;
    const r = result;
    const gapKeys: string[] = r?.targetGaps
      ? [...r.targetGaps].map((k) => String(k)).sort()
      : [];
    if (firstTickSnapshot === null && r?.targetRect && sc.renderer) {
      const rect = r.targetRect;
      firstTickSnapshot = sc.renderer.snapshot({
        coords: true,
        cropTo: {
          minRow: Math.max(0, rect.top - 4),
          maxRow: rect.bottom + 4,
          minCol: Math.max(0, rect.left - 4),
          maxCol: rect.right + 4,
        },
      });
    }
    ticks.push({
      tick: tickIdx++,
      path,
      chosen: r?.chosenTowerIndex,
      gaps: r?.targetGaps?.size,
      rect: r?.targetRect
        ? `[${r.targetRect.top},${r.targetRect.left}-${r.targetRect.bottom},${r.targetRect.right}]`
        : undefined,
      gapKeys,
    });
  });

  const { unpackTile } = await import("../src/shared/core/spatial.ts");
  const walls: { row: number; col: number }[] = [];
  sc.bus.on(GAME_EVENT.WALL_PLACED, (ev) => {
    if (ev.playerId !== targetPlayer || sc.state.round !== targetRound) return;
    for (const k of ev.tileKeys) {
      const { row, col } = unpackTile(k);
      walls.push({ row, col });
    }
  });

  let enclosures = 0;
  sc.bus.on(GAME_EVENT.TOWER_ENCLOSED, (ev) => {
    if (ev.playerId !== targetPlayer || sc.state.round !== targetRound) return;
    enclosures++;
  });

  try {
    waitForEvent(
      sc,
      GAME_EVENT.PHASE_START,
      (ev) => ev.phase === Phase.WALL_BUILD && sc.state.round === targetRound + 1,
      { timeoutMs: 5_500_000, label: `seed=${seed} r${targetRound + 1} WB` },
    );
  } catch {
    // Game may end early - partial data still useful
  } finally {
    setSelectTargetPathHook(undefined);
  }

  console.log(`\n=== seed=${seed} r${targetRound} player=${targetPlayer} ===`);
  console.log(`Total selectTarget ticks: ${ticks.length}`);
  console.log(`Total walls placed: ${walls.length}`);
  console.log(`Total enclosures: ${enclosures}`);

  const byPath: Record<string, number> = {};
  for (const t of ticks) byPath[t.path] = (byPath[t.path] || 0) + 1;
  console.log(`Path distribution: ${JSON.stringify(byPath)}`);

  const uniqueTowers = new Set(
    ticks.filter((t) => t.chosen !== undefined).map((t) => t.chosen),
  );
  console.log(`Unique chosen towers: ${[...uniqueTowers].join(", ") || "(none)"}`);

  const uniqueRects = new Set(ticks.map((t) => t.rect).filter(Boolean));
  console.log(`Unique rects: ${[...uniqueRects].slice(0, 5).join(" | ")}`);

  // Track gap evolution
  console.log(`\n--- Per-tick trace ---`);
  let lastGapKeys = "";
  for (const t of ticks) {
    const gapStr = t.gapKeys ? t.gapKeys.slice(0, 8).join(",") : "";
    const diff = gapStr === lastGapKeys ? "" : " (changed)";
    console.log(
      `tick=${t.tick} path=${t.path} chosen=${t.chosen ?? "-"} gaps=${t.gaps ?? "-"} rect=${t.rect ?? "-"}${diff}`,
    );
    lastGapKeys = gapStr;
  }

  // Compute first/last gap sets to see evolution
  if (ticks.length > 0) {
    const first = ticks[0]!.gapKeys ?? [];
    const last = ticks[ticks.length - 1]!.gapKeys ?? [];
    console.log(`\nFirst gap set (${first.length}): ${first.join(",")}`);
    console.log(`Last gap set (${last.length}): ${last.join(",")}`);
  }

  // Compute "did walls land IN the target gaps?" using packTile
  const { packTile } = await import("../src/shared/core/spatial.ts");
  const allTargetGaps = new Set<string>();
  for (const t of ticks) {
    for (const k of t.gapKeys ?? []) allTargetGaps.add(k);
  }
  const wallsInGaps = walls.filter((w) => {
    return allTargetGaps.has(String(packTile(w.row, w.col)));
  });
  console.log(
    `\nWalls landed IN any target gap: ${wallsInGaps.length}/${walls.length} (${((wallsInGaps.length * 100) / Math.max(walls.length, 1)).toFixed(0)}%)`,
  );

  // Wall distribution by row
  const wallByRow: Record<number, number> = {};
  for (const w of walls) wallByRow[w.row] = (wallByRow[w.row] || 0) + 1;
  console.log(`\nWall row distribution:`);
  for (const row of Object.keys(wallByRow).map(Number).sort((a, b) => a - b)) {
    console.log(`  row ${row}: ${wallByRow[row]}`);
  }

  // Decode rect & gap positions
  const lastTick = ticks[ticks.length - 1];
  if (lastTick?.rect) {
    console.log(`\nLast rect: ${lastTick.rect}`);
    const decodedGaps = (lastTick.gapKeys ?? []).map((k) => {
      const n = Number(k);
      return `(${Math.floor(n / 44)},${n % 44})`;
    });
    console.log(`Last gap positions: ${decodedGaps.join(" ")}`);
  }

  if (firstTickSnapshot) {
    console.log(`\n--- ASCII snapshot at tick 0 ---`);
    console.log(firstTickSnapshot);
  }

  Deno.exit(0);
}
