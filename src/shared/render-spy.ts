/** Render spy — records drawSprite calls per frame for E2E test inspection.
 *
 *  Lives in shared/ so both render-sprites.ts (writer) and
 *  runtime-e2e-bridge.ts (reader) can import without crossing domain
 *  boundaries. */

interface SpriteDraw {
  name: string;
  x: number;
  y: number;
}

let spyLog: SpriteDraw[] | undefined;

/** Enable the render spy. Call once at startup (dev only). */
export function enableRenderSpy(): void {
  spyLog = [];
}

/** Clear the spy log. Call at the start of each frame. */
export function clearRenderSpy(): void {
  if (spyLog) spyLog.length = 0;
}

/** Read the current frame's draw log. Returns undefined if spy is disabled. */
export function getRenderSpyLog(): readonly SpriteDraw[] | undefined {
  return spyLog;
}

/** Append a sprite draw to the spy log (no-op when spy is disabled). */
export function recordSpriteDraw(name: string, x: number, y: number): void {
  spyLog?.push({ name, x, y });
}
