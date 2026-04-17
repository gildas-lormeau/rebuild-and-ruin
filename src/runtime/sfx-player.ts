/**
 * SFX sub-system — plays PCM samples from Rampart's SOUND.RSC via Web Audio.
 *
 * Parallel to [music-player.ts](./music-player.ts) but for Sound Blaster
 * digital-sample SFX (brick clunks, cannon shots, banner whoosh, voice
 * announcements, firework whistles). The 37 VOC chunks are parsed once from
 * `assets.soundRsc`; each is decoded to an AudioBuffer lazily on first use
 * and cached for re-play. BufferSource per trigger = native polyphony for
 * free (rapid-fire brick hits can overlap).
 *
 * Observer hook mirrors music/haptics so scenario tests can assert
 * "wallPlaced emitted sample 'clunk1'" without needing an AudioContext.
 *
 * The map from game bus events → sample names lives in `SFX_EVENT_MAP` so
 * tuning the mapping (swap clunk1 → clunk2, assign per-player cues) doesn't
 * touch the bus-subscription code.
 */

import type {
  GameEventBus,
  GameEventHandler,
  GameEventMap,
} from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { SfxObserver } from "../shared/core/system-interfaces.ts";
import {
  AUDIO_CONTEXT_RUNNING,
  AUDIO_CONTEXT_SUSPENDED,
} from "../shared/platform/platform.ts";
import { type PcmSample, parseSoundRsc } from "../shared/platform/sound-rsc.ts";
import type { MusicAssets } from "./music-assets.ts";

interface SfxSubsystem {
  /** Prime the AudioContext inside a user-gesture handler. Safe to call
   *  repeatedly; later calls are no-ops. */
  activate(): Promise<void>;
  /** Play a named SOUND.RSC sample once. Returns immediately; actual audio
   *  output is scheduled on the shared AudioContext. No-op if assets aren't
   *  loaded or the name doesn't exist in SOUND.RSC. */
  playSample(name: string): Promise<void>;
  /** Bind to a per-game bus so entity/lifecycle events fire the mapped
   *  sample. Re-binding unsubscribes from the previous bus. */
  subscribeBus(bus: GameEventBus): void;
  /** Suspend/resume the AudioContext — wired to `visibilitychange`. */
  setPaused(paused: boolean): Promise<void>;
  dispose(): Promise<void>;
}

interface SfxSubsystemDeps {
  readonly getAssets: () => MusicAssets | undefined;
  readonly assetsReady?: Promise<void>;
  readonly observer?: SfxObserver;
}

interface SfxMapping<K extends keyof GameEventMap> {
  readonly sample: string;
  /** Optional predicate — sample only plays when this returns true. Used to
   *  scope per-event-type handlers to specific payload shapes (e.g. the banner
   *  whoosh fires on BATTLE transitions only, not every phase swap). */
  readonly filter?: (event: GameEventMap[K]) => boolean;
}

type SfxEventMap = {
  readonly [K in keyof GameEventMap]?: SfxMapping<K>;
};

/** Map of bus-event → sample (+ optional filter). Lookup happens at emit
 *  time, so editing an entry only affects subsequent events. */
const SFX_EVENT_MAP: SfxEventMap = {
  cannonPlaced: { sample: "clunk1" },
  cannonFired: { sample: "cannon1" },
  bannerStart: {
    sample: "whoosh2",
    filter: (event) => event.phase === Phase.BATTLE,
  },
  // Unmapped on purpose:
  //   - wallPlaced: the authentic per-tile brick stinger is an XMI sub-song
  //     (music-player territory), not a SOUND.RSC sample.
  //   - tower-enclosed (clunk2): will wire once we have a dedicated bus event
  //     for enclosure completion.
  //   - placecan: tutorial voice line; scoped to the tutorial when we add it.
};

export function createSfxSubsystem(deps: SfxSubsystemDeps): SfxSubsystem {
  let audioContext: AudioContext | undefined;
  let samplesByName: Map<string, PcmSample> | undefined;
  const buffers = new Map<string, AudioBuffer>();
  let boundBus: GameEventBus | undefined;
  type EventKey = keyof GameEventMap;
  const boundHandlers: Array<{
    type: EventKey;
    handler: GameEventHandler<EventKey>;
  }> = [];
  let paused = false;
  let disposed = false;

  function ensureSamples(): Map<string, PcmSample> | undefined {
    if (samplesByName) return samplesByName;
    const assets = deps.getAssets();
    if (!assets?.soundRsc) return undefined;
    const parsed = parseSoundRsc(assets.soundRsc);
    samplesByName = new Map(parsed.map((sample) => [sample.name, sample]));
    return samplesByName;
  }

  function ensureContext(): AudioContext | undefined {
    if (audioContext) return audioContext;
    if (typeof AudioContext === "undefined") return undefined;
    audioContext = new AudioContext();
    return audioContext;
  }

  async function activate(): Promise<void> {
    if (deps.assetsReady) await deps.assetsReady;
    const context = ensureContext();
    if (context && context.state === AUDIO_CONTEXT_SUSPENDED) {
      try {
        await context.resume();
      } catch {
        // Browser may refuse outside a user gesture — caller handles the retry.
      }
    }
    ensureSamples();
  }

  function decodeSample(sample: PcmSample, context: AudioContext): AudioBuffer {
    const cached = buffers.get(sample.name);
    if (cached) return cached;
    // Creative VOC codec 0 is unsigned 8-bit PCM: 0 → -1, 128 → 0, 255 → ~1.
    const buffer = context.createBuffer(
      1,
      sample.pcm.length,
      sample.sampleRate,
    );
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < sample.pcm.length; i += 1) {
      channel[i] = (sample.pcm[i]! - 128) / 128;
    }
    buffers.set(sample.name, buffer);
    return buffer;
  }

  async function playSample(name: string): Promise<void> {
    if (disposed || paused) return;
    const samples = ensureSamples();
    const sample = samples?.get(name);
    if (!sample) {
      deps.observer?.onMissing?.(name);
      return;
    }
    const context = ensureContext();
    if (!context) return;
    if (context.state === AUDIO_CONTEXT_SUSPENDED) {
      try {
        await context.resume();
      } catch {
        return;
      }
    }
    const buffer = decodeSample(sample, context);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(0);
    deps.observer?.onPlaySample?.(name);
  }

  function unbindCurrentBus(): void {
    if (boundBus) {
      for (const { type, handler } of boundHandlers) {
        boundBus.off(type, handler);
      }
    }
    boundBus = undefined;
    boundHandlers.length = 0;
  }

  function subscribeBus(bus: GameEventBus): void {
    if (boundBus === bus) return;
    unbindCurrentBus();
    boundBus = bus;
    for (const [eventType, mapping] of Object.entries(SFX_EVENT_MAP) as Array<
      [EventKey, SfxMapping<EventKey>]
    >) {
      const { sample, filter } = mapping;
      const handler: GameEventHandler<EventKey> = (event) => {
        if (filter && !filter(event)) return;
        void playSample(sample);
      };
      bus.on(eventType, handler);
      boundHandlers.push({ type: eventType, handler });
    }
  }

  async function setPaused(next: boolean): Promise<void> {
    paused = next;
    if (!audioContext) return;
    if (next && audioContext.state === AUDIO_CONTEXT_RUNNING) {
      await audioContext.suspend();
    } else if (!next && audioContext.state === AUDIO_CONTEXT_SUSPENDED) {
      try {
        await audioContext.resume();
      } catch {
        // user gesture may be required — try again on next play
      }
    }
  }

  async function dispose(): Promise<void> {
    disposed = true;
    unbindCurrentBus();
    if (audioContext) {
      try {
        await audioContext.close();
      } catch {
        // ignore — context may already be closed
      }
      audioContext = undefined;
    }
    buffers.clear();
    samplesByName = undefined;
  }

  return { activate, playSample, subscribeBus, setPaused, dispose };
}
