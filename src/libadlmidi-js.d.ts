// Minimal ambient declarations for libadlmidi-js's public profile entrypoints.
// Upstream ships no .d.ts; we use just the AdlMidi class surface from the
// `nuked` profile. Extend this file (don't scatter `as { ... }` casts) if we
// start using more of the library.

declare module "libadlmidi-js/nuked" {
  export class AdlMidi {
    readonly audioContext: AudioContext | null;
    init(processorUrl?: string, wasmUrl?: string): Promise<void>;
    loadBankData(buffer: ArrayBuffer): Promise<void>;
    loadMidi(buffer: ArrayBuffer): Promise<void>;
    play(): Promise<void>;
    stop(): Promise<void>;
    selectSongNum(num: number): void;
  }
}
