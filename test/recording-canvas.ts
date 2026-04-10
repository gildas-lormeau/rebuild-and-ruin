/**
 * Recording canvas mock — duck-typed `HTMLCanvasElement` whose 2D context
 * logs every method call into a shared array. Tests assert on the *shape*
 * of the call sequence (which methods were called, on which canvas, with
 * what argument shape) without ever inspecting pixel buffers.
 *
 * Why a shared log: render-map.ts holds two offscreen canvases (the main
 * scene and the banner prev-scene). Calls to both interleave with calls
 * on the main display canvas. A flat log keyed by `canvasId` lets tests
 * filter to a specific canvas while still preserving global ordering.
 *
 * Usage:
 *
 *     const recorder = createCanvasRecorder();
 *     const sc = await createScenario({ canvasFactory: recorder.factory });
 *     // ... drive scenario ...
 *     const drawImageCalls = recorder.calls("drawImage");
 *
 * Loadable in deno: this module installs an `ImageData` polyfill on
 * `globalThis` if one is missing, so `render-map.ts` (which calls
 * `new ImageData(W, H)` directly) loads without DOM globals.
 */

// ── ImageData polyfill ──────────────────────────────────────────────
// `render-map.ts` builds terrain bitmaps via `new ImageData(w, h)`. In
// browsers ImageData is a global; in deno it isn't. We install a minimal
// shim before any render code runs.
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

// ── Types ───────────────────────────────────────────────────────────

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

export interface CanvasRecorder {
  /** Hand to `setCanvasFactory()` (or pass via `createScenario`). Each call
   *  returns a fresh recording canvas with a new id. */
  readonly factory: () => HTMLCanvasElement;
  /** A pre-allocated "main display canvas" (id 0). Pass to `createCanvasRenderer`. */
  readonly displayCanvas: HTMLCanvasElement;
  /** Flat log of every method call across every canvas, in invocation order. */
  readonly log: RecordedCall[];
  /** Filter `log` to calls of a single method name. */
  calls(method: string): RecordedCall[];
  /** Filter `log` to calls on a single canvas. */
  callsOn(canvasId: number): RecordedCall[];
  /** Drop all recorded calls (used to ignore pre-banner setup noise). */
  reset(): void;
}

// ── Implementation ──────────────────────────────────────────────────

/** Methods that must return a real value to keep the renderer working.
 *  Anything not listed returns `undefined` (which is correct for mutators
 *  like fillRect, drawImage, beginPath, save, restore, ...). */
const RETURNING_METHODS = new Set([
  "createImageData",
  "getImageData",
  "measureText",
  "createLinearGradient",
  "createRadialGradient",
  "createPattern",
  "getLineDash",
  "isPointInPath",
  "isPointInStroke",
]);

export function createCanvasRecorder(): CanvasRecorder {
  const log: RecordedCall[] = [];
  let nextCanvasId = 0;

  function makeCanvas(): HTMLCanvasElement {
    const id = nextCanvasId++;
    const stub = createRecordingCanvas(id, log);
    return stub;
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

/** Build a single recording canvas with its own context. The context's
 *  state (fillStyle, font, etc.) is stored on a backing object so reads
 *  return whatever was last written — the renderer reads back some
 *  properties and we don't want to break those round-trips. */
function createRecordingCanvas(
  id: number,
  log: RecordedCall[],
): HTMLCanvasElement {
  const ctxState: Record<string, unknown> = {
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
  };

  let width = 0;
  let height = 0;

  const ctx = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop in ctxState) return ctxState[prop];
        if (prop === "canvas") return canvas;
        // Return a stub function that records the call.
        return (...args: unknown[]) => {
          log.push({
            method: prop,
            args: args.map((arg) => sanitizeArg(arg)),
            canvasId: id,
          });
          return defaultReturn(prop, args);
        };
      },
      set(_target, prop: string, value: unknown) {
        ctxState[prop] = value;
        return true;
      },
    },
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
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HTMLCanvasElement;

  return canvas;
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

/** Provide sensible return values for the few context methods that the
 *  renderer reads back from. */
function defaultReturn(method: string, args: unknown[]): unknown {
  if (!RETURNING_METHODS.has(method)) return undefined;
  switch (method) {
    case "createImageData":
    case "getImageData": {
      const w = (args[0] as number) || 1;
      const h = (args[1] as number) || 1;
      return new ImageData(w, h);
    }
    case "measureText":
      return { width: ((args[0] as string)?.length ?? 0) * 6 };
    case "getLineDash":
      return [];
    case "isPointInPath":
    case "isPointInStroke":
      return false;
    default:
      return null;
  }
}

function createStubParent(): HTMLElement {
  const stub = {
    clientHeight: 720,
    clientWidth: 1280,
    classList: {
      add: () => {},
      remove: () => {},
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
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return stub as unknown as HTMLElement;
}
