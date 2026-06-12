/**
 * AudioContext suspend/resume gates vs iOS interruptions + gesture order.
 *
 * iOS Safari parks an AudioContext in the non-standard "interrupted"
 * state during system audio interruptions (phone call, Siri, alarm) —
 * it is neither "suspended" nor "running", so strict-equality gates
 * skip it entirely: one-shots scheduled during a call queue silently
 * and burst out together when iOS releases the interruption, pause
 * never pins the context down, and unpause never recovers the
 * documented stuck-interrupted state. Interruptions don't fire
 * visibilitychange, so the pause plumbing can meet "interrupted" in
 * both directions.
 *
 * Separately, `sfx.activate()` used to await the IndexedDB-backed
 * `assetsReady` BEFORE calling resume() — activation runs inside the
 * user gesture, and the await consumed it, leaving the context
 * suspended (the exact hazard music's `activateOnce` orders around).
 *
 * Headless Deno has no AudioContext, so these drive the real players
 * against a minimal fake installed at `globalThis.AudioContext`.
 */

import { assert, assertEquals } from "@std/assert";
import type { MusicAssets } from "../src/runtime/audio/music-assets.ts";
import { createMusicSubsystem } from "../src/runtime/audio/music-player.ts";
import { createSfxSubsystem } from "../src/runtime/audio/sfx-player.ts";

const SAMPLE_NAME = "shot";

class FakeAudioContext {
  static initialState = "running";
  state = FakeAudioContext.initialState;
  resumeCalls = 0;
  suspendCalls = 0;
  sourcesStarted = 0;
  destination = {};

  static instances: FakeAudioContext[] = [];
  constructor() {
    FakeAudioContext.instances.push(this);
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = "running";
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.suspendCalls += 1;
    this.state = "suspended";
    return Promise.resolve();
  }

  createBuffer(_channels: number, frames: number, _rate: number): unknown {
    return { getChannelData: () => new Float32Array(frames) };
  }

  createBufferSource(): unknown {
    return {
      buffer: null,
      connect: () => {},
      addEventListener: () => {},
      start: () => {
        this.sourcesStarted += 1;
      },
    };
  }
}

Deno.test(
  "sfx: a one-shot during an iOS interruption is dropped, not queued",
  async () => {
    await withFakeAudioContext(async (latest) => {
      const sfx = buildSfx();
      assert(await sfx.playSample(SAMPLE_NAME), "sanity: sample plays");
      const context = latest();
      assertEquals(context.sourcesStarted, 1);

      context.state = "interrupted";
      const source = await sfx.playSample(SAMPLE_NAME);
      assertEquals(source, undefined);
      assertEquals(
        context.sourcesStarted,
        1,
        "a one-shot scheduled against an interrupted context queues " +
          "silently and bursts out when the interruption ends — it must " +
          "be dropped instead",
      );
    });
  },
);

Deno.test(
  "sfx: the pause gates treat an interrupted context as suspendable and resumable",
  async () => {
    await withFakeAudioContext(async (latest) => {
      const sfx = buildSfx();
      await sfx.playSample(SAMPLE_NAME); // constructs the context
      const context = latest();

      context.state = "interrupted";
      await sfx.setPaused(true);
      assertEquals(
        context.suspendCalls,
        1,
        "pausing during an interruption must pin the context down, or " +
          "the interruption-end auto-resume un-pauses the audio",
      );

      context.state = "interrupted";
      await sfx.setPaused(false);
      assertEquals(
        context.resumeCalls,
        1,
        "unpausing must recover a stuck-interrupted context",
      );
    });
  },
);

Deno.test(
  "music: the pause gates treat an interrupted context as suspendable and resumable",
  async () => {
    await withFakeAudioContext(async (latest) => {
      const music = createMusicSubsystem();
      await music.activate(); // constructs the context (no PCM cache headless)
      const context = latest();

      context.state = "interrupted";
      await music.setPaused(true);
      assertEquals(context.suspendCalls, 1);

      context.state = "interrupted";
      await music.setPaused(false);
      assertEquals(context.resumeCalls, 1);
    });
  },
);

Deno.test(
  "sfx: activate() resumes inside the gesture, before the asset await",
  async () => {
    await withFakeAudioContext(async (latest) => {
      // Never-settling assetsReady — the old order (await assets, THEN
      // resume) consumed the user gesture in the IndexedDB await and
      // left the context suspended.
      FakeAudioContext.initialState = "suspended";
      const sfx = buildSfx(new Promise<void>(() => {}));
      void sfx.activate();
      const context = latest();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(
        context.resumeCalls,
        1,
        "resume() must be issued within the gesture's activation " +
          "window, not after the IndexedDB-backed assetsReady settles",
      );
    });
  },
);

/** Run `body` with the fake AudioContext installed, restoring after. */
async function withFakeAudioContext(
  body: (latest: () => FakeAudioContext) => Promise<void>,
): Promise<void> {
  const globals = globalThis as { AudioContext?: unknown };
  FakeAudioContext.instances = [];
  FakeAudioContext.initialState = "running";
  globals.AudioContext = FakeAudioContext;
  try {
    await body(() => {
      const latest = FakeAudioContext.instances.at(-1);
      assert(latest, "expected the player to have constructed a context");
      return latest;
    });
  } finally {
    delete globals.AudioContext;
  }
}

function buildSfx(assetsReady?: Promise<void>) {
  return createSfxSubsystem({
    getAssets: () => ({ soundRsc: buildSoundRsc() }) as MusicAssets,
    assetsReady,
    getState: () => undefined,
  });
}

/** Minimal SOUND.RSC: one directory entry pointing at a one-block
 *  Creative VOC chunk (codec 0, u8 PCM) — just enough for
 *  `parseSoundRsc` to yield a playable sample. */
function buildSoundRsc(): Uint8Array {
  const magic = "Creative Voice File";
  const pcmLength = 32;
  const blockSize = 2 + pcmLength;
  const voc = new Uint8Array(26 + 4 + blockSize + 1);
  for (let i = 0; i < magic.length; i += 1) voc[i] = magic.charCodeAt(i);
  new DataView(voc.buffer).setUint16(20, 26, true);
  voc[26] = 1; // block type 1: sound data
  voc[27] = blockSize & 0xff;
  voc[28] = (blockSize >> 8) & 0xff;
  voc[29] = (blockSize >> 16) & 0xff;
  voc[30] = 156; // divisor → 10 kHz
  voc[31] = 0; // codec 0: unsigned 8-bit PCM

  const headerSize = 0x14 + 20;
  const rsc = new Uint8Array(headerSize + voc.length);
  rsc[0] = 1; // chunk count
  for (let i = 0; i < SAMPLE_NAME.length; i += 1) {
    rsc[0x14 + i] = SAMPLE_NAME.charCodeAt(i);
  }
  const view = new DataView(rsc.buffer);
  view.setUint32(0x14 + 12, headerSize, true);
  view.setUint32(0x14 + 16, voc.length, true);
  rsc.set(voc, headerSize);
  return rsc;
}
