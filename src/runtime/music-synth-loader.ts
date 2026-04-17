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
  /** Enable/disable looping for the loaded file. XMI files with explicit
   *  loopstart/loopend markers honor them; files without markers loop from
   *  the end back to the start. */
  setLoopEnabled(enabled: boolean): void;
  /** Detected loop markers in seconds, or -1 if absent. XMI `FOR/NEXT` and
   *  standard MIDI `loopStart`/`loopEnd` text markers both surface here. */
  getLoopStartTime(): Promise<number>;
  getLoopEndTime(): Promise<number>;
  getMusicTitle(): Promise<string>;
  getMarkerCount(): Promise<number>;
  getSongsCount(): Promise<number>;
  /** Output-level gain for this synth. 1.0 = neutral, applied between the
   *  worklet node and the AudioContext destination. Use to level tracks
   *  whose XMI mix is quieter than others (e.g. RXMI_CANNON vs TETRIS). */
  setVolume(value: number): void;
  /** Ramp the gain linearly to `value` over `durationSec` on the synth's
   *  AudioContext clock. Cancels any prior ramp in flight. Used for
   *  phase-transition decrescendos (e.g. build bg fading into the
   *  countdown snare). */
  fadeTo(value: number, durationSec: number): void;
}

export async function loadSynth(assets: MusicAssets): Promise<SynthHandle> {
  const module = await import("libadlmidi-js/nuked");
  const synth = new module.AdlMidi();
  await synth.init(processorUrl, wasmUrl);
  const wopl = ailToWopl(assets.rampAd);
  const buffer = new ArrayBuffer(wopl.byteLength);
  new Uint8Array(buffer).set(wopl);
  await synth.loadBankData(buffer);

  // Insert a GainNode between the worklet and the destination so callers
  // can trim per-track volume. Transparent at value=1.0. The nuked profile's
  // AdlMidi re-export doesn't publish types for the inherited `node` field,
  // so access via a structural cast.
  const ctx = synth.audioContext;
  const workletNode = (synth as unknown as { node: AudioWorkletNode | null })
    .node;
  let gainNode: GainNode | undefined;
  if (ctx && workletNode) {
    gainNode = ctx.createGain();
    gainNode.gain.value = 1;
    workletNode.disconnect();
    workletNode.connect(gainNode);
    gainNode.connect(ctx.destination);
  }

  return Object.assign(synth, {
    setVolume(value: number): void {
      if (gainNode) gainNode.gain.value = value;
    },
    fadeTo(value: number, durationSec: number): void {
      if (!gainNode || !ctx) return;
      const now = ctx.currentTime;
      // Pin current value then ramp — without setValueAtTime the ramp
      // would start from the last scheduled point, which breaks mid-fade
      // cancellations (e.g. immediate stop during a decrescendo).
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setValueAtTime(gainNode.gain.value, now);
      gainNode.gain.linearRampToValueAtTime(value, now + durationSec);
    },
  });
}
