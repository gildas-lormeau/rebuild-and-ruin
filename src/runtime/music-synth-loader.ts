/**
 * Browser-only synth loader — isolates the Vite-specific `?url` imports for
 * libadlmidi-js's AudioWorklet + WASM assets. music-player.ts dynamically
 * imports this on first play so the Deno test harness never resolves the
 * URLs (Deno doesn't understand Vite's `?url` suffix).
 */

import wasmUrl from "libadlmidi-js/dist/libadlmidi.nuked.core.wasm?url";
import processorUrl from "libadlmidi-js/dist/libadlmidi.nuked.processor.js?url";
import { ailToWopl } from "../shared/platform/ail-to-wopl.ts";
import type { MusicAssets } from "./music-assets.ts";

export interface SynthHandle {
  readonly audioContext: AudioContext | null;
  loadMidi(buffer: ArrayBuffer): Promise<void>;
  play(): Promise<void>;
  stop(): Promise<void>;
  selectSongNum(num: number): void;
}

export async function loadSynth(assets: MusicAssets): Promise<SynthHandle> {
  const module = await import("libadlmidi-js/nuked");
  const synth = new module.AdlMidi();
  await synth.init(processorUrl, wasmUrl);
  const wopl = ailToWopl(assets.rampAd);
  const buffer = new ArrayBuffer(wopl.byteLength);
  new Uint8Array(buffer).set(wopl);
  await synth.loadBankData(buffer);
  return synth;
}
