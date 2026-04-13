/**
 * Recording canvas mock — duck-typed `HTMLCanvasElement` whose 2D context
 * either records every method call into a shared array or no-ops them
 * entirely (when `discardCalls: true`).
 *
 * Tests assert on the *shape* of the call sequence (which methods were
 * called, on which canvas, with what argument shape) without ever
 * inspecting pixel buffers.
 *
 * Implementation notes:
 *
 *   - The default-and-fast path (`discardCalls: true`) installs a plain
 *     object whose every method is a no-op function. No `Proxy`. This is
 *     the hot path for long-running tests that drive thousands of frames
 *     through the real renderer — Proxy traps were ~10× slower than
 *     direct method dispatch in our benchmark.
 *
 *   - The recording path (`discardCalls: false`) wraps each method with
 *     a closure that pushes a `RecordedCall`. Tests that want to assert
 *     on individual calls (rare) opt into this.
 *
 *   - `ImageData` is polyfilled on `globalThis` if missing so render-map.ts
 *     loads in deno (it calls `new ImageData(W, H)` directly).
 *
 * Usage:
 *
 *     const recorder = createCanvasRecorder({ discardCalls: true });
 *     const sc = await createScenario({
 *       renderer: { canvas: recorder, observer: { terrainDrawn: (target, mapRef) => { ... } } },
 *     });
 *     // ... drive scenario ...
 *     // assertions via the observer callbacks, not recorder.log
 */

// ── ImageData polyfill ──────────────────────────────────────────────
// `render-map.ts` builds terrain bitmaps via `new ImageData(w, h)`. In
// browsers ImageData is a global; in deno it isn't. We install a minimal
// shim before any render code runs.

export interface RecordedCall {
  /** 2D context method name (drawImage, putImageData, fillRect, ...). */
  readonly method: string;
  /** Argument array. For canvas/ImageData arguments we replace the value
   *  with a tagged descriptor (`{ __canvasId: 1 }` or `{ __imageData: ... }`)
   *  so the log stays JSON-serializable and trivially queryable. */
  readonly args: readonly unknown[];
  /** Which recording canvas the call was made on. The display canvas is 0,
   *  the offscreen scene is 1, the offscreen banner scene is 2. */
  readonly canvasId: number;
}

export interface CanvasRecorderOptions {
  /** When true, the mock context's methods are no-ops and recording is
   *  skipped entirely. Use this for long-running tests that drive many
   *  thousands of frames and observe the renderer through the
   *  `renderer.observer` scenario option rather than the call log —
   *  recording every context call would dwarf the test's CPU budget. */
  discardCalls?: boolean;
}

export interface CanvasRecorder {
  /** Pass via `createScenario({ renderer: { canvas: recorder } })`. Each
   *  call returns a fresh
   *  recording canvas with a new id. */
  readonly factory: () => HTMLCanvasElement;
  /** A pre-allocated "main display canvas" (id 0). Pass to `createCanvasRenderer`. */
  readonly displayCanvas: HTMLCanvasElement;
  /** Flat log of every method call across every canvas, in invocation order.
   *  Empty when constructed with `discardCalls: true`. */
  readonly log: RecordedCall[];
  /** Filter `log` to calls of a single method name. */
  calls(method: string): RecordedCall[];
  /** Filter `log` to calls on a single canvas. */
  callsOn(canvasId: number): RecordedCall[];
  /** Drop all recorded calls (used to ignore pre-banner setup noise). */
  reset(): void;
}

/** Backing storage for stateful 2D context properties. The renderer
 *  reads back some of these (e.g. fillStyle), so we let writes round-trip. */
interface ContextState {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  miterLimit: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  direction: string;
  globalAlpha: number;
  globalCompositeOperation: string;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: string;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  filter: string;
}

const NOOP = (): void => {};

export function createCanvasRecorder(
  opts: CanvasRecorderOptions = {},
): CanvasRecorder {
  const log: RecordedCall[] = [];
  const recordTarget: RecordedCall[] | null = opts.discardCalls ? null : log;
  let nextCanvasId = 0;

  function makeCanvas(): HTMLCanvasElement {
    const id = nextCanvasId++;
    return createRecordingCanvas(id, recordTarget);
  }

  const displayCanvas = makeCanvas();

  return {
    factory: makeCanvas,
    displayCanvas,
    log,
    calls: (method) => log.filter((entry) => entry.method === method),
    callsOn: (canvasId) => log.filter((entry) => entry.canvasId === canvasId),
    reset: () => {
      log.length = 0;
    },
  };
}

if (typeof (globalThis as { ImageData?: unknown }).ImageData === "undefined") {
  class ImageDataShim {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  }
  (globalThis as { ImageData: unknown }).ImageData =
    ImageDataShim as unknown as typeof ImageData;
}

function createRecordingCanvas(
  id: number,
  log: RecordedCall[] | null,
): HTMLCanvasElement {
  let width = 0;
  let height = 0;

  // Holder pattern: the context's `canvas` getter reads from `holder.canvas`,
  // which gets assigned just below. This avoids a forward-declared `let`
  // (deno-lint flags it because canvas is only assigned once).
  const holder: { canvas?: HTMLCanvasElement } = {};
  const getCanvas = () => holder.canvas as HTMLCanvasElement;
  const ctx = (
    log === null
      ? buildNoopContext(getCanvas)
      : buildRecordingContext(id, log, getCanvas)
  ) as unknown as CanvasRenderingContext2D;

  const canvas = {
    __recordingId: id,
    get width() {
      return width;
    },
    set width(value: number) {
      width = value;
    },
    get height() {
      return height;
    },
    set height(value: number) {
      height = value;
    },
    parentElement: createStubParent(),
    getContext: (_kind: string, _opts?: unknown) => ctx,
    getBoundingClientRect: () => ({
      x: 0,
      y: 0,
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      toJSON: () => ({}),
    }),
    addEventListener: NOOP,
    removeEventListener: NOOP,
  } as unknown as HTMLCanvasElement;
  holder.canvas = canvas;

  return canvas;
}

/** Build a recording context — wraps each method with a closure that
 *  pushes to the log. Slower than the no-op path, only used when a test
 *  needs to assert on individual calls. */
function buildRecordingContext(
  id: number,
  log: RecordedCall[],
  getCanvas: () => HTMLCanvasElement,
): object {
  const noop = buildNoopContext(getCanvas);
  const recording: Record<string, unknown> = { ...noop };

  for (const key of Object.keys(noop)) {
    const original = (noop as Record<string, unknown>)[key];
    if (typeof original !== "function") continue;
    recording[key] = (...args: unknown[]) => {
      log.push({
        method: key,
        args: args.map((arg) => sanitizeArg(arg)),
        canvasId: id,
      });
      return (original as (...a: unknown[]) => unknown)(...args);
    };
  }

  // Preserve the live `canvas` getter (it's not a function so the loop
  // above didn't replace it, but we need it to point at the right canvas).
  Object.defineProperty(recording, "canvas", {
    get: () => getCanvas(),
    enumerable: true,
  });

  return recording;
}

/** Build a no-op context — every method is a direct function reference,
 *  no Proxy traps. This is the fast path used by tests that don't read
 *  from the recorder log. */
function buildNoopContext(getCanvas: () => HTMLCanvasElement): object {
  const state = createContextState();

  // Stateful read/write properties via plain object spread. The renderer
  // reads `fillStyle`, `font`, `globalAlpha`, etc. and expects round-trip.
  return {
    ...state,
    get canvas() {
      return getCanvas();
    },

    // Drawing rectangles
    clearRect: NOOP,
    fillRect: NOOP,
    strokeRect: NOOP,

    // Path API
    beginPath: NOOP,
    closePath: NOOP,
    moveTo: NOOP,
    lineTo: NOOP,
    arc: NOOP,
    arcTo: NOOP,
    bezierCurveTo: NOOP,
    quadraticCurveTo: NOOP,
    rect: NOOP,
    roundRect: NOOP,
    ellipse: NOOP,
    fill: NOOP,
    stroke: NOOP,
    clip: NOOP,

    // State stack
    save: NOOP,
    restore: NOOP,

    // Transforms
    translate: NOOP,
    rotate: NOOP,
    scale: NOOP,
    transform: NOOP,
    setTransform: NOOP,
    resetTransform: NOOP,
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),

    // Text
    fillText: NOOP,
    strokeText: NOOP,
    measureText: (text: string) => ({
      width: ((text as string | undefined)?.length ?? 0) * 6,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 0,
      actualBoundingBoxAscent: 0,
      actualBoundingBoxDescent: 0,
      fontBoundingBoxAscent: 0,
      fontBoundingBoxDescent: 0,
    }),

    // Images & pixel data
    drawImage: NOOP,
    putImageData: NOOP,
    createImageData: (w: number, h: number) =>
      new ImageData(w || 1, h || 1),
    getImageData: (_x: number, _y: number, w: number, h: number) =>
      new ImageData(w || 1, h || 1),

    // Line dash
    setLineDash: NOOP,
    getLineDash: () => [] as number[],

    // Hit testing
    isPointInPath: () => false,
    isPointInStroke: () => false,

    // Gradients & patterns (return inert objects with addColorStop no-op)
    createLinearGradient: () => ({ addColorStop: NOOP }),
    createRadialGradient: () => ({ addColorStop: NOOP }),
    createConicGradient: () => ({ addColorStop: NOOP }),
    createPattern: () => null,

    // Focus
    drawFocusIfNeeded: NOOP,
    scrollPathIntoView: NOOP,
  };
}

function createContextState(): ContextState {
  return {
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    miterLimit: 10,
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    direction: "inherit",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "low",
    shadowColor: "rgba(0,0,0,0)",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    filter: "none",
  };
}

/** Replace arguments that are canvases or ImageData with tagged descriptors.
 *  Keeps the log easy to query (`args[0].__canvasId === 1`) and prevents
 *  giant pixel buffers from leaking into test assertion failures. */
function sanitizeArg(arg: unknown): unknown {
  if (arg && typeof arg === "object") {
    const obj = arg as { __recordingId?: number; data?: Uint8ClampedArray };
    if (typeof obj.__recordingId === "number") {
      return { __canvasId: obj.__recordingId };
    }
    if (obj.data instanceof Uint8ClampedArray) {
      const id = obj as unknown as { width: number; height: number };
      return { __imageData: { width: id.width, height: id.height } };
    }
  }
  return arg;
}

function createStubParent(): HTMLElement {
  const stub = {
    clientHeight: 720,
    clientWidth: 1280,
    classList: {
      add: NOOP,
      remove: NOOP,
      contains: () => false,
      toggle: () => false,
    },
    querySelector: () => null,
    querySelectorAll: () => [] as unknown as NodeListOf<Element>,
    getBoundingClientRect: () => ({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
      top: 0,
      left: 0,
      right: 1280,
      bottom: 720,
      toJSON: () => ({}),
    }),
    addEventListener: NOOP,
    removeEventListener: NOOP,
  };
  return stub as unknown as HTMLElement;
}
