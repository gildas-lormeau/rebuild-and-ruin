/**
 * Build-trace observer — captures the AI's build-phase decisions for ONE
 * specific (round, player) and renders them as a relative-position
 * play-by-play instead of raw coordinates.
 *
 * Why a separate observer: AI behavior is hard to reason about from
 * absolute `(row, col)` coordinates. Reading "GOLD placed L-piece on
 * south edge of T9 ring, fills 1 of 3 south gaps" is a lot more
 * tractable than "GOLD placed L at (8,18)(8,19)(7,18)(9,18) targetGaps
 * {289, 290, ...}".
 *
 * Subscribes to the legacy `setAiBuildDiagHook` (test-only) which
 * carries each placement's intent (`targetRect`, `targetGaps`,
 * `pieceShapeName`). The narrative observer can't do this — game-bus
 * `WALL_PLACED` doesn't carry AI-internal target context.
 *
 * Singleton caveat: `setAiBuildDiagHook` is a global. Only one
 * build-trace observer can be active at a time; calling `attach` twice
 * throws.
 */

import { setAiBuildDiagHook } from "../src/ai/ai-build-diag.ts";
import type { TileRect } from "../src/shared/core/geometry-types.ts";
import type { TileKey } from "../src/shared/core/grid.ts";
import { unpackTile } from "../src/shared/core/spatial.ts";

export interface BuildTraceOptions {
  /** Round to capture (1-indexed). */
  readonly round: number;
  /** Player index (0=RED, 1=BLUE, 2=GOLD). */
  readonly playerId: 0 | 1 | 2;
}

export interface BuildTraceObserver {
  /** Accumulated trace lines in event order. */
  readonly lines: readonly string[];
  attach(): void;
  detach(): void;
}

const PLAYER_NAMES = ["RED", "BLUE", "GOLD"] as const;

export function createBuildTraceObserver(
  opts: BuildTraceOptions,
): BuildTraceObserver {
  const lines: string[] = [];
  let attached = false;
  // Dedup by target IDENTITY (path + rect), NOT by gap count — the AI
  // re-emits target-selected every tick with shrinking gaps, but we
  // only want one header per actual ring change.
  let lastTargetIdentity = "";
  // Track the previous target's remaining gaps to detect abandonment
  // (switching to a fresh target with MORE gaps than were left to close
  // on the previous one).
  let lastTargetGapsRemaining = Number.POSITIVE_INFINITY;
  let lastTargetLabel = "";

  function maybeEmitAbandon(newTargetGaps: number, newTargetLabel: string): void {
    if (
      lastTargetLabel === "" ||
      lastTargetGapsRemaining === Number.POSITIVE_INFINITY
    ) {
      return;
    }
    if (newTargetGaps <= lastTargetGapsRemaining) return;
    lines.push(
      `↓ ABANDON: ${lastTargetLabel} had ${lastTargetGapsRemaining} gap(s) left; switching to ${newTargetLabel} with ${newTargetGaps} gap(s)`,
    );
  }

  return {
    get lines() {
      return lines;
    },

    attach() {
      if (attached) throw new Error("build-trace observer already attached");
      attached = true;

      setAiBuildDiagHook((ev) => {
        if (ev.round !== opts.round || ev.playerId !== opts.playerId) return;

        if (ev.kind === "target-selected") {
          if (!ev.targetRect) {
            const identity = `${ev.path}|none`;
            if (identity !== lastTargetIdentity) {
              maybeEmitAbandon(0, ev.path);
              lastTargetIdentity = identity;
              lastTargetGapsRemaining = 0;
              lastTargetLabel = ev.path;
              lines.push("");
              lines.push(`target: ${ev.path} (no rect)`);
            }
            return;
          }
          const rect = ev.targetRect;
          const identity = `${ev.path}|${rect.top},${rect.left}-${rect.bottom},${rect.right}`;
          if (identity === lastTargetIdentity) return;
          const towerLabel = ev.chosenTowerIndex !== undefined
            ? ` (T${ev.chosenTowerIndex})`
            : "";
          const newLabel = `${ev.path}${towerLabel}`;
          maybeEmitAbandon(ev.targetGaps.size, newLabel);
          lastTargetIdentity = identity;
          lastTargetGapsRemaining = ev.targetGaps.size;
          lastTargetLabel = newLabel;
          lines.push("");
          lines.push(
            `target: ${newLabel} rect=${formatRect(rect)} → ${ev.targetGaps.size} gap(s) ${formatGapEdges(ev.targetGaps, rect)}`,
          );
          if (ev.alternatives.length > 0) {
            // Identify the chosen alt by towerIdx if available; fall back to
            // matching gap count against the committed target's gap count
            // (the chosen target's rect has the same gap geometry, so the
            // gap count match is reliable except when two alternatives
            // happen to have the same gap count — rare and not worth the
            // complexity to disambiguate further).
            const chosenIdxByTower = ev.chosenTowerIndex;
            const chosenIdxByGaps = chosenIdxByTower === undefined
              ? ev.alternatives.find(
                (alt) => alt.gapCount === ev.targetGaps.size,
              )?.towerIdx
              : undefined;
            const top = ev.alternatives.slice(0, 3);
            for (const alt of top) {
              const isChosen = alt.towerIdx === chosenIdxByTower ||
                alt.towerIdx === chosenIdxByGaps;
              const marker = isChosen ? "← chosen" : "";
              const bagClause = alt.bagFitDenom > 0
                ? ` bagFit=${alt.bagFit}/${alt.bagFitDenom}`
                : "";
              lines.push(
                `    alt T${alt.towerIdx}: score=${alt.score.toFixed(1)} gaps=${alt.gapCount}${bagClause} ${marker}`.trimEnd(),
              );
            }
          }
        } else if (ev.kind === "wall-placed") {
          const gapsBefore = ev.targetGaps.size;
          const filled = countFilled(ev.cells, ev.targetGaps);
          const gapsAfter = Math.max(0, gapsBefore - filled);
          lastTargetGapsRemaining = gapsAfter;
          const where = ev.targetRect
            ? describePlacement(ev.cells, ev.targetRect)
            : "no-target";
          const gapClause = filled > 0
            ? `fills ${filled}/${gapsBefore} → ${gapsAfter} left`
            : `fills 0/${gapsBefore} (wasted) → ${gapsAfter} left`;
          const cellList = ev.cells
            .map((key) => {
              const { row, col } = unpackTile(key);
              return `(${row},${col})`;
            })
            .join("");
          lines.push(
            `  ${ev.pieceShapeName} (${ev.cells.length}t) ${where} ${cellList} — ${gapClause}`,
          );
        }
      });
    },

    detach() {
      if (!attached) return;
      setAiBuildDiagHook(undefined);
      attached = false;
      lines.unshift(
        `─── build trace: r${opts.round} ${PLAYER_NAMES[opts.playerId]} ───`,
      );
    },
  };
}

function formatRect(rect: TileRect): string {
  return `(${rect.top},${rect.left})-(${rect.bottom},${rect.right})`;
}

/** Compact summary of where the gaps lie around the ring perimeter.
 *  Helps see "south edge has 3 gaps" vs "scattered around". */
function formatGapEdges(
  gaps: ReadonlySet<TileKey>,
  rect: TileRect,
): string {
  if (gaps.size === 0) return "";
  let north = 0;
  let south = 0;
  let east = 0;
  let west = 0;
  let other = 0;
  for (const key of gaps) {
    const { row, col } = unpackTile(key);
    if (row === rect.top - 1) north++;
    else if (row === rect.bottom + 1) south++;
    else if (col === rect.left - 1) west++;
    else if (col === rect.right + 1) east++;
    else other++;
  }
  const parts: string[] = [];
  if (north > 0) parts.push(`N=${north}`);
  if (south > 0) parts.push(`S=${south}`);
  if (east > 0) parts.push(`E=${east}`);
  if (west > 0) parts.push(`W=${west}`);
  if (other > 0) parts.push(`other=${other}`);
  return `[${parts.join(" ")}]`;
}

/** Where the placement sits relative to the target ring. Uses the
 *  4-edge ring AROUND the rect (top-1, bottom+1, left-1, right+1) as
 *  the reference. */
function describePlacement(
  cells: readonly TileKey[],
  rect: TileRect,
): string {
  let avgRow = 0;
  let avgCol = 0;
  for (const key of cells) {
    const { row, col } = unpackTile(key);
    avgRow += row;
    avgCol += col;
  }
  avgRow /= cells.length;
  avgCol /= cells.length;

  const ringTop = rect.top - 1;
  const ringBottom = rect.bottom + 1;
  const ringLeft = rect.left - 1;
  const ringRight = rect.right + 1;

  // Distance OUTSIDE the ring rect (positive = outside, 0 or negative = on/inside).
  const above = ringTop - avgRow;
  const below = avgRow - ringBottom;
  const leftOf = ringLeft - avgCol;
  const rightOf = avgCol - ringRight;

  if (above > 0.5) return `${Math.round(above)} tiles N of ring`;
  if (below > 0.5) return `${Math.round(below)} tiles S of ring`;
  if (leftOf > 0.5) return `${Math.round(leftOf)} tiles W of ring`;
  if (rightOf > 0.5) return `${Math.round(rightOf)} tiles E of ring`;

  // On-edge cases — the centroid sits on one of the four ring lines.
  const onTop = Math.abs(avgRow - ringTop) < 0.6;
  const onBot = Math.abs(avgRow - ringBottom) < 0.6;
  const onLeft = Math.abs(avgCol - ringLeft) < 0.6;
  const onRight = Math.abs(avgCol - ringRight) < 0.6;
  if (onTop && onLeft) return "NW corner of ring";
  if (onTop && onRight) return "NE corner of ring";
  if (onBot && onLeft) return "SW corner of ring";
  if (onBot && onRight) return "SE corner of ring";
  if (onTop) return `N edge of ring (col ~${Math.round(avgCol)})`;
  if (onBot) return `S edge of ring (col ~${Math.round(avgCol)})`;
  if (onLeft) return `W edge of ring (row ~${Math.round(avgRow)})`;
  if (onRight) return `E edge of ring (row ~${Math.round(avgRow)})`;

  // Inside the ring rect (interior of the castle) — unusual.
  return `INSIDE ring (~${Math.round(avgRow)},${Math.round(avgCol)})`;
}

function countFilled(
  cells: readonly TileKey[],
  gaps: ReadonlySet<TileKey>,
): number {
  let count = 0;
  for (const key of cells) {
    if (gaps.has(key)) count++;
  }
  return count;
}
