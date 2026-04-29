/**
 * Minimal per-frame performance HUD for the 3D renderer. Renders a tiny
 * fixed-position overlay showing FPS plus three.js `renderer.info`
 * counters (draw calls, triangles, allocated geometries/textures/shader
 * programs). Invisible by default; toggled via `__dev.perfHud(true)`.
 *
 * The renderer calls `updatePerfHud` every frame; the update is an
 * early-return no-op when the HUD is disabled so the cost in
 * production (where `__dev` is never attached) is a pointer chase and
 * a branch. When enabled, the DOM element is created lazily.
 */

interface PerfStats {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  readonly programs: number;
}

const FPS_UPDATE_INTERVAL_MS = 500;
const HUD_STYLE =
  "position:fixed;top:8px;right:8px;z-index:9999;padding:4px 8px;" +
  "background:rgba(0,0,0,0.7);color:#8be9fd;font:12px monospace;" +
  "pointer-events:none;white-space:nowrap;";

let overlay: HTMLElement | undefined;
let enabled = false;
let frameCount = 0;
let lastFpsAnchor = 0;
let fps = 0;

export function setPerfHudEnabled(on: boolean): void {
  enabled = on;
  if (overlay) overlay.style.display = on ? "block" : "none";
}

export function isPerfHudEnabled(): boolean {
  return enabled;
}

export function updatePerfHud(stats: PerfStats, now: number): void {
  if (!enabled) return;
  if (!overlay) overlay = createOverlay();

  frameCount += 1;
  const dt = now - lastFpsAnchor;
  if (dt >= FPS_UPDATE_INTERVAL_MS) {
    fps = Math.round((frameCount * 1000) / dt);
    frameCount = 0;
    lastFpsAnchor = now;
  }

  overlay.textContent =
    `${fps} FPS  calls ${formatCompact(stats.drawCalls)}  ` +
    `tri ${formatCompact(stats.triangles)}  ` +
    `geom ${formatCompact(stats.geometries)}  tex ${formatCompact(stats.textures)}  ` +
    `shd ${formatCompact(stats.programs)}`;
}

function formatCompact(value: number): string {
  if (value < 1000) return value.toString();
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function createOverlay(): HTMLElement {
  const node = document.createElement("div");
  node.style.cssText = HUD_STYLE;
  document.body.appendChild(node);
  return node;
}
