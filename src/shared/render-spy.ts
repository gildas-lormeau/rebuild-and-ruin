/** Render spy — records drawSprite and text draw calls per frame for E2E test inspection.
 *
 *  Lives in shared/ so both render-sprites.ts (writer) and
 *  runtime-e2e-bridge.ts (reader) can import without crossing domain
 *  boundaries. */

interface SpriteDraw {
  name: string;
  x: number;
  y: number;
}

export interface TextDraw {
  text: string;
  color: string;
  x: number;
  y: number;
  /** Scale factor applied when drawing (1.0 = normal). */
  scale: number;
}

let spyLog: SpriteDraw[] | undefined;
let textSpyLog: TextDraw[] | undefined;

/** Enable the render spy. Call once at startup (dev only). */
export function enableRenderSpy(): void {
  spyLog = [];
  textSpyLog = [];
}

/** Clear the spy log. Call at the start of each frame. */
export function clearRenderSpy(): void {
  if (spyLog) spyLog.length = 0;
  if (textSpyLog) textSpyLog.length = 0;
}

/** Read the current frame's draw log. Returns undefined if spy is disabled. */
export function getRenderSpyLog(): readonly SpriteDraw[] | undefined {
  return spyLog;
}

/** Read the current frame's text draw log. Returns undefined if spy is disabled. */
export function getTextSpyLog(): readonly TextDraw[] | undefined {
  return textSpyLog;
}

/** Append a sprite draw to the spy log (no-op when spy is disabled). */
export function recordSpriteDraw(name: string, x: number, y: number): void {
  spyLog?.push({ name, x, y });
}

/** Append a text draw to the spy log (no-op when spy is disabled). */
export function recordTextDraw(
  text: string,
  color: string,
  x: number,
  y: number,
  scale: number,
): void {
  textSpyLog?.push({ text, color, x, y, scale });
}
