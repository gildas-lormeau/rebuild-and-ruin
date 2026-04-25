/**
 * Music render path — drives the headless libadlmidi WASM core to convert
 * player-supplied Rampart XMIs into raw PCM, and wraps the persistence
 * layer that caches the result in IndexedDB.
 *
 * Music playback is fully PCM-based: every track (bg loops, one-shot
 * stingers, tower-enclosure fanfares) is rendered once at upload-time
 * (`renderAllTracksToCache`) so the in-game `activate()` path is a pure
 * IDB read + `AudioBuffer` construction. No live AudioWorklet, no
 * per-frame synth CPU. Browser-native loop support handles XMI `FOR/NEXT`
 * markers at playback via `source.loop` / `loopStart` / `loopEnd`.
 *
 * Vite-specific `?url` import is isolated here so the Deno test harness
 * never resolves it (Deno doesn't understand the `?url` suffix).
 */

import coreUrl from "libadlmidi-js/dist/libadlmidi.dosbox.slim.core.js?url";
import wasmUrl from "libadlmidi-js/dist/libadlmidi.dosbox.slim.core.wasm?url";
import { ailToWopl } from "../shared/platform/ail-to-wopl.ts";
import {
  xmiContainerBlocks,
  xmidToSmf,
} from "../shared/platform/xmi-to-smf.ts";
import {
  type CachedPcm,
  fanfareCacheId,
  type MusicAssets,
  PRERENDER_BG_TRACKS,
  PRERENDER_FANFARE_SONGS,
  storePcmCache,
  type XmiFileKey,
} from "./music-assets.ts";

interface PcmRenderer {
  render(midi: Uint8Array): CachedPcm | undefined;
  close(): void;
}

const FANFARE_FILE: XmiFileKey = "RXMI_TETRIS.xmi";

export async function renderAllTracksToCache(
  assets: MusicAssets,
  sampleRate: number,
  onProgress?: (done: number, total: number) => void,
): Promise<{ rendered: number; total: number; failed: readonly string[] }> {
  const total = PRERENDER_BG_TRACKS.length + PRERENDER_FANFARE_SONGS.length;
  const failed: string[] = [];
  const renderer = await createPcmRenderer(assets, sampleRate);
  if (!renderer) {
    return { rendered: 0, total, failed: ["renderer-init-failed"] };
  }
  let done = 0;
  let rendered = 0;
  // Yield to the event loop so UI can paint the progress between renders.
  // Render is synchronous WASM and would otherwise block the main thread.
  const yieldToUi = () =>
    new Promise<void>((resolve) => setTimeout(resolve, 0));
  try {
    for (const spec of PRERENDER_BG_TRACKS) {
      const smf = extractSmfBlock(assets, spec.file, spec.songIndex);
      if (!smf) {
        failed.push(spec.id);
      } else {
        const pcm = renderer.render(smf);
        if (pcm) {
          await storePcmCache(spec.id, pcm);
          rendered += 1;
        } else {
          failed.push(spec.id);
        }
      }
      done += 1;
      onProgress?.(done, total);
      await yieldToUi();
    }
    for (const songIndex of PRERENDER_FANFARE_SONGS) {
      const id = fanfareCacheId(songIndex);
      const smf = extractSmfBlock(assets, FANFARE_FILE, songIndex);
      if (!smf) {
        failed.push(id);
      } else {
        const pcm = renderer.render(smf);
        if (pcm) {
          await storePcmCache(id, pcm);
          rendered += 1;
        } else {
          failed.push(id);
        }
      }
      done += 1;
      onProgress?.(done, total);
      await yieldToUi();
    }
  } finally {
    renderer.close();
  }
  return { rendered, total, failed };
}

async function createPcmRenderer(
  assets: MusicAssets,
  sampleRate: number,
): Promise<PcmRenderer | undefined> {
  const module = await import("libadlmidi-js/dosbox/slim");
  // Pre-fetch the WASM bytes and pass them via `wasmBinary` so
  // Emscripten doesn't try to auto-locate the `.wasm` next to its
  // `.core.js` — Vite hashes those filenames separately, so the
  // auto-fetch hits a 404 (which is served as an HTML page, hence
  // the "unsupported MIME type 'text/html'" error in production).
  const wasmResponse = await fetch(wasmUrl);
  if (!wasmResponse.ok) {
    console.error(
      `[music] WASM fetch failed (${wasmResponse.status}) at ${wasmUrl}`,
    );
    return undefined;
  }
  const wasmBinary = await wasmResponse.arrayBuffer();
  const core = await module.AdlMidiCore.create({
    corePath: coreUrl,
    wasmBinary,
  });
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
    render(midi) {
      const midiBuf = new ArrayBuffer(midi.byteLength);
      new Uint8Array(midiBuf).set(midi);
      if (!core.loadMidi(midiBuf)) return undefined;
      // Loops disabled for offline render: we capture one full pass (intro +
      // one loop body iteration). At playback time the AudioBufferSourceNode
      // re-loops the marked region indefinitely — far cheaper than re-running
      // the synth.
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
      // Trim the buffer to the actual frame count rather than handing the
      // padded full-length array to the cache.
      const pcm =
        writtenFrames * 2 < interleaved.length
          ? interleaved.slice(0, writtenFrames * 2)
          : interleaved;
      return {
        pcm,
        frames: writtenFrames,
        sampleRate,
        loopStartSec: core.getLoopStartTime(),
        loopEndSec: core.getLoopEndTime(),
      };
    },
    close() {
      core.close();
    },
  };
}

/** Extract one sub-song from an XMI container and convert it to standard
 *  MIDI bytes. Returns undefined if the container is missing the requested
 *  block or if the conversion fails. */
function extractSmfBlock(
  assets: MusicAssets,
  file: XmiFileKey,
  songIndex: number,
): Uint8Array | undefined {
  const blocks = xmiContainerBlocks(assets.xmi[file]);
  const block = blocks[songIndex]?.block;
  if (!block) return undefined;
  return xmidToSmf(block) ?? undefined;
}
