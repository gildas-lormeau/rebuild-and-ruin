/**
 * Browser-only synth loader — isolates the Vite-specific `?url` imports for
 * libadlmidi-js's AudioWorklet + WASM assets. music-player.ts dynamically
 * imports this on first play so the Deno test harness never resolves the
 * URLs (Deno doesn't understand Vite's `?url` suffix).
 */

import coreUrl from "libadlmidi-js/dist/libadlmidi.dosbox.slim.core.js?url";
import wasmUrl from "libadlmidi-js/dist/libadlmidi.dosbox.slim.core.wasm?url";
import processorUrl from "libadlmidi-js/dist/libadlmidi.dosbox.slim.processor.js?url";
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

/** Headless renderer for short MIDI sub-songs — drives the libadlmidi WASM
 *  core directly (no AudioWorklet, no live AudioContext) and returns a
 *  PCM AudioBuffer ready to play via AudioBufferSourceNode. Used for the
 *  tower-enclosure fanfares: each variant is a fixed one-shot ~1.5 s long,
 *  so rendering once at activate-time and replaying via plain BufferSources
 *  drops idle CPU to zero (no per-slot worklet ticking) and supports free
 *  overlap when two enclosures land in the same window. */
interface FanfareRenderer {
  /** Render a sub-song from `midi` (SMF bytes) to a stereo AudioBuffer
   *  on `destinationContext`. Returns undefined if the WASM core rejects
   *  the data — caller falls back to silence for that slot. Synchronous
   *  WASM call; the `Promise` shape on `createFanfareRenderer` covers the
   *  one-time WASM module load, not per-track render. */
  render(midi: Uint8Array, songIndex: number): AudioBuffer | undefined;
  /** Free the WASM player. Idempotent. */
  close(): void;
}

export async function loadSynth(assets: MusicAssets): Promise<SynthHandle> {
  const module = await import("libadlmidi-js/dosbox/slim");
  const synth = new module.AdlMidi();
  await synth.init(processorUrl, wasmUrl);
  const wopl = ailToWopl(assets.rampAd);
  const buffer = new ArrayBuffer(wopl.byteLength);
  new Uint8Array(buffer).set(wopl);
  await synth.loadBankData(buffer);

  // Insert a GainNode between the worklet and the destination so callers
  // can trim per-track volume. Transparent at value=1.0. The AdlMidi profile
  // re-exports don't publish types for the inherited `node` field, so access
  // via a structural cast.
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

export async function createFanfareRenderer(
  assets: MusicAssets,
  destinationContext: AudioContext,
): Promise<FanfareRenderer | undefined> {
  const module = await import("libadlmidi-js/dosbox/slim");
  const core = await module.AdlMidiCore.create({ corePath: coreUrl });
  const sampleRate = destinationContext.sampleRate;
  if (!core.init(sampleRate)) {
    core.close();
    return undefined;
  }
  const wopl = ailToWopl(assets.rampAd);
  const woplBuf = new ArrayBuffer(wopl.byteLength);
  new Uint8Array(woplBuf).set(wopl);
  if (!core.loadBankData(woplBuf)) {
    core.close();
    return undefined;
  }

  // Pre-roll budget: 100 ms of trailing silence past the reported duration
  // covers OPL release tails (notes still ringing after the last event).
  const TAIL_PAD_SEC = 0.1;
  const CHUNK_FRAMES = 4096;

  return {
    render(midi, songIndex) {
      const midiBuf = new ArrayBuffer(midi.byteLength);
      new Uint8Array(midiBuf).set(midi);
      if (!core.loadMidi(midiBuf)) return undefined;
      core.selectSongNum(songIndex);
      core.setLoopEnabled(false);

      const totalFrames = Math.ceil(
        (core.duration + TAIL_PAD_SEC) * sampleRate,
      );
      if (!Number.isFinite(totalFrames) || totalFrames <= 0) return undefined;
      const interleaved = new Float32Array(totalFrames * 2);

      let writtenFrames = 0;
      while (writtenFrames < totalFrames && !core.atEnd) {
        const wantFrames = Math.min(CHUNK_FRAMES, totalFrames - writtenFrames);
        const chunk = core.play(wantFrames);
        if (chunk.length === 0) break;
        const wroteFrames = chunk.length / 2;
        interleaved.set(chunk, writtenFrames * 2);
        writtenFrames += wroteFrames;
        if (wroteFrames < wantFrames) break;
      }

      if (writtenFrames === 0) return undefined;
      const buffer = destinationContext.createBuffer(
        2,
        writtenFrames,
        sampleRate,
      );
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      for (let i = 0; i < writtenFrames; i += 1) {
        left[i] = interleaved[i * 2]!;
        right[i] = interleaved[i * 2 + 1]!;
      }
      return buffer;
    },
    close() {
      core.close();
    },
  };
}
