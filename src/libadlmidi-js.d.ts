// Minimal ambient declarations for libadlmidi-js's public profile entrypoints.
// Upstream ships no .d.ts; we use just the AdlMidi class surface from the
// `dosbox/slim` profile. Extend this file (don't scatter `as { ... }` casts)
// if we start using more of the library.

declare module "libadlmidi-js/dosbox/slim" {
  export class AdlMidi {
    readonly audioContext: AudioContext | null;
    init(processorUrl?: string, wasmUrl?: string): Promise<void>;
    loadBankData(buffer: ArrayBuffer): Promise<void>;
    loadMidi(buffer: ArrayBuffer): Promise<void>;
    play(): Promise<void>;
    stop(): Promise<void>;
    selectSongNum(num: number): void;
    setLoopEnabled(enabled: boolean): void;
    getLoopStartTime(): Promise<number>;
    getLoopEndTime(): Promise<number>;
    getMusicTitle(): Promise<string>;
    getMarkerCount(): Promise<number>;
    getSongsCount(): Promise<number>;
  }

  // Headless WASM synth — no AudioContext, no AudioWorklet. Drives the
  // libADLMIDI core directly to render PCM frames synchronously. Used for
  // offline rendering of short fanfares to AudioBuffer.
  interface AdlMidiCoreInstance {
    init(sampleRate?: number): boolean;
    loadBankData(data: ArrayBuffer | Uint8Array): boolean;
    loadMidi(data: ArrayBuffer | Uint8Array): boolean;
    selectSongNum(num: number): void;
    setLoopEnabled(enabled: boolean): void;
    /** Renders up to `frames` stereo frames from the loaded MIDI. Returns
     *  a stereo-interleaved Float32Array; length may be < frames * 2 at end
     *  of song. */
    play(frames: number): Float32Array;
    rewind(): void;
    readonly duration: number;
    readonly position: number;
    readonly atEnd: boolean;
    close(): void;
  }

  export class AdlMidiCore {
    static create(options?: {
      corePath?: string;
    }): Promise<AdlMidiCoreInstance>;
  }
}
