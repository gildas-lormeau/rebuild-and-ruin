// Minimal ambient declarations for libadlmidi-js's `dosbox/slim` profile.
// Upstream ships no .d.ts; we only use the headless `AdlMidiCore` (the live
// `AdlMidi` worklet wrapper isn't used — all music is pre-rendered to PCM).

declare module "libadlmidi-js/dosbox/slim" {
  // Headless WASM synth — no AudioContext, no AudioWorklet. Drives the
  // libADLMIDI core directly to render PCM frames synchronously. All
  // returned numbers are seconds; loop times are -1 when the source MIDI
  // has no `FOR/NEXT` (XMI) or `loopStart`/`loopEnd` (SMF) markers.
  interface AdlMidiCoreInstance {
    init(sampleRate?: number): boolean;
    loadBankData(data: ArrayBuffer | Uint8Array): boolean;
    loadMidi(data: ArrayBuffer | Uint8Array): boolean;
    setLoopEnabled(enabled: boolean): void;
    /** Render up to `frames` stereo frames from the loaded MIDI. Returns a
     *  stereo-interleaved Float32Array; length may be < frames * 2 at end
     *  of song. */
    play(frames: number): Float32Array;
    rewind(): void;
    getLoopStartTime(): number;
    getLoopEndTime(): number;
    readonly duration: number;
    readonly position: number;
    readonly atEnd: boolean;
    close(): void;
  }

  export class AdlMidiCore {
    static create(options?: {
      corePath?: string;
      /** Pre-fetched WASM bytes. When set, the Emscripten module skips its
       *  own auto-fetch (which resolves the .wasm relative to the .core.js
       *  URL — wrong under Vite's hashed-filename output). */
      wasmBinary?: ArrayBuffer | Uint8Array;
    }): Promise<AdlMidiCoreInstance>;
  }
}
