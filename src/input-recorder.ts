/**
 * In-page input recorder for capturing touch/mouse/keyboard events.
 *
 * Activated via `?record-inputs` query parameter. Records all user input
 * with timestamps, then offers the recording as a JSON download when stopped.
 * The JSON can be replayed via `npx tsx test/online-e2e.ts local --replay <file>`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TouchPoint { id: number; x: number; y: number }

type InputStep =
  | { type: "tap"; x: number; y: number; t: number }
  | { type: "click"; x: number; y: number; t: number; button?: number }
  | { type: "mousemove"; x: number; y: number; t: number }
  | { type: "touchstart"; touches: TouchPoint[]; t: number }
  | { type: "touchmove"; touches: TouchPoint[]; t: number }
  | { type: "touchend"; changedTouches: TouchPoint[]; t: number }
  | { type: "keydown"; key: string; code: string; t: number }
  | { type: "keyup"; key: string; code: string; t: number };

interface InputRecording {
  format: "input-recorder";
  title: string;
  url: string;
  viewport: { width: number; height: number; dpr: number };
  userAgent: string;
  startedAt: string;
  steps: InputStep[];
}

const MOUSEMOVE_THROTTLE_MS = 50;
const OVERLAY_CSS = `
  position: fixed; z-index: 99999; top: 8px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px;
  background: rgba(0,0,0,0.75); color: #fff; padding: 6px 14px;
  border-radius: 20px; font: bold 13px sans-serif;
  touch-action: manipulation; -webkit-tap-highlight-color: transparent;
  user-select: none;
`;
const DOT_CSS = `
  width: 10px; height: 10px; border-radius: 50%;
  background: #e33; animation: rec-blink 1s infinite;
`;
const STOP_BTN_CSS = `
  background: #e33; color: #fff; border: none; border-radius: 12px;
  padding: 4px 12px; font: bold 12px sans-serif; cursor: pointer;
  touch-action: manipulation;
`;

export function initRecorder(): void {
  const steps: InputStep[] = [];
  const startTime = performance.now();
  let lastMousemoveT = 0;

  function t(): number { return performance.now() - startTime; }

  function touchPoints(list: TouchList): TouchPoint[] {
    const pts: TouchPoint[] = [];
    for (let i = 0; i < list.length; i++) {
      const touch = list[i]!;
      pts.push({ id: touch.identifier, x: Math.round(touch.clientX), y: Math.round(touch.clientY) });
    }
    return pts;
  }

  // --- Event handlers (capture phase, passive) ---
  const onTouchStart = (e: TouchEvent) => {
    steps.push({ type: "touchstart", touches: touchPoints(e.touches), t: t() });
  };
  const onTouchMove = (e: TouchEvent) => {
    steps.push({ type: "touchmove", touches: touchPoints(e.touches), t: t() });
  };
  const onTouchEnd = (e: TouchEvent) => {
    steps.push({ type: "touchend", changedTouches: touchPoints(e.changedTouches), t: t() });
  };
  const onClick = (e: MouseEvent) => {
    steps.push({ type: "click", x: Math.round(e.clientX), y: Math.round(e.clientY), t: t(), button: e.button || undefined });
  };
  const onMouseMove = (e: MouseEvent) => {
    const now = t();
    if (now - lastMousemoveT < MOUSEMOVE_THROTTLE_MS) return;
    lastMousemoveT = now;
    steps.push({ type: "mousemove", x: Math.round(e.clientX), y: Math.round(e.clientY), t: now });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    steps.push({ type: "keydown", key: e.key, code: e.code, t: t() });
  };
  const onKeyUp = (e: KeyboardEvent) => {
    steps.push({ type: "keyup", key: e.key, code: e.code, t: t() });
  };

  // Attach all listeners in capture phase
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  document.addEventListener("touchstart", onTouchStart, opts);
  document.addEventListener("touchmove", onTouchMove, opts);
  document.addEventListener("touchend", onTouchEnd, opts);
  document.addEventListener("click", onClick, opts);
  document.addEventListener("mousemove", onMouseMove, opts);
  document.addEventListener("keydown", onKeyDown, opts);
  document.addEventListener("keyup", onKeyUp, opts);

  function stopRecording() {
    // Remove listeners
    document.removeEventListener("touchstart", onTouchStart, opts);
    document.removeEventListener("touchmove", onTouchMove, opts);
    document.removeEventListener("touchend", onTouchEnd, opts);
    document.removeEventListener("click", onClick, opts);
    document.removeEventListener("mousemove", onMouseMove, opts);
    document.removeEventListener("keydown", onKeyDown, opts);
    document.removeEventListener("keyup", onKeyUp, opts);

    const recording: InputRecording = {
      format: "input-recorder",
      title: `recording-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-")}`,
      url: location.href,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      userAgent: navigator.userAgent,
      startedAt: new Date().toISOString(),
      steps,
    };

    const json = JSON.stringify(recording, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${recording.title}.json`;
    a.click();
    URL.revokeObjectURL(url);

    // Clipboard fallback
    navigator.clipboard?.writeText(json).catch(() => {});

    // Update overlay
    overlay.textContent = `Saved ${steps.length} events`;
    setTimeout(() => overlay.remove(), 3000);
  }

  // --- Overlay UI ---
  const style = document.createElement("style");
  style.textContent = "@keyframes rec-blink { 0%,100% { opacity: 1 } 50% { opacity: 0.3 } }";
  document.head.appendChild(style);

  const overlay = document.createElement("div");
  overlay.style.cssText = OVERLAY_CSS;

  const dot = document.createElement("span");
  dot.style.cssText = DOT_CSS;
  overlay.appendChild(dot);

  const label = document.createElement("span");
  label.textContent = "REC";
  overlay.appendChild(label);

  const stopBtn = document.createElement("button");
  stopBtn.textContent = "Stop";
  stopBtn.style.cssText = STOP_BTN_CSS;
  stopBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    stopRecording();
  });
  stopBtn.addEventListener("touchstart", (e) => {
    e.stopPropagation();
  }, { passive: false });
  overlay.appendChild(stopBtn);

  document.body.appendChild(overlay);
}
