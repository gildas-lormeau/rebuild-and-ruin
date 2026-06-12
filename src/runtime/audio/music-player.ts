/**
 * Music sub-system — PCM playback of player-supplied Rampart music.
 * Tracks + fanfares are rendered once at upload-time and persisted in
 * IndexedDB; in-game `activate()` reads the cache and builds
 * `AudioBuffer`s — no WASM, no live synth. Plays RXMI_TITLE on bus-bind
 * through the first WALL_BUILD start; silent if cache is empty. Autoplay:
 * the first `activate()` must run inside a user gesture (Play button).
 */

import {
  GAME_EVENT,
  type GameEventBus,
  type GameEventHandler,
  type GameEventMap,
} from "../../shared/core/game-event-bus.ts";
import { Phase } from "../../shared/core/game-phase.ts";
import type { ValidPlayerId } from "../../shared/core/player-slot.ts";
import type { GameState } from "../../shared/core/types.ts";
import {
  audioContextCanSuspend,
  audioContextNeedsResume,
  isAudioContextInterrupted,
} from "../../shared/platform/platform.ts";
import {
  type CachedPcm,
  fanfareCacheId,
  loadPcmCache,
  PRERENDER_BG_TRACKS,
  PRERENDER_FANFARE_SONGS,
} from "./music-assets.ts";

/** Narrow music handle exposed on `GameRuntime`. Subset of `MusicSubsystem`
 *  surfaced for the app shell — lets the home-page "Play" button pre-warm
 *  the music synth from a user-gesture click, and the lobby entry start
 *  the title track, both before any game bus exists. */
export interface RuntimeMusic {
  activate(): Promise<void>;
  startTitle(): Promise<void>;
}

export interface MusicSubsystem extends RuntimeMusic {
  // Inherits `activate` + `startTitle` from `RuntimeMusic` (the narrow
  // public surface). The methods below are internal to composition.
  /** Hard-stop the bg track + every in-flight fanfare and clear the
   *  caller's `wantsBg` intent. Called on quit-to-menu so neither a
   *  looped bg track nor a one-shot TETRIS fanfare outlives the game.
   *  Mirrors sfx-player's `stopAll`. Idempotent. */
  stopAll(): void;
  /** Play the one-shot tower-enclosure fanfare for a player. Picks a
   *  TETRIS sub-song by player slot (5/6/7 cycle). Plays through a fresh
   *  AudioBufferSourceNode so it overlaps any in-flight bg track for free. */
  playFanfare(playerId: ValidPlayerId): Promise<void>;
  /** Bind to the supplied game bus so PHASE_START=WALL_BUILD auto-stops the
   *  title track when the first castle goes down. Re-binding to a different
   *  bus (rematch) unbinds the previous one. */
  subscribeBus(bus: GameEventBus): void;
  /** Compute continuous presentational signals from `state` each frame —
   *  currently drives the build bg decrescendo (derived from `state.timer`)
   *  and stop on WALL_BUILD exit. Mirrors sfx-player's equivalent hook. */
  tickPresentation(state: GameState): void;
  /** Suspend or resume the AudioContext — wired to `document.visibilitychange`
   *  so music doesn't keep looping in a backgrounded tab. No-op until
   *  `activate()` has run. */
  setPaused(paused: boolean): Promise<void>;
  /** Drop the in-memory PCM + AudioBuffer caches so the next `activate()`
   *  re-hydrates from the (possibly changed) IDB cache. Call when the user
   *  re-uploads music via the sound modal — `activateOnce` skips already-
   *  loaded ids, so without this the old buffers play forever. Mirrors
   *  `sfx.refreshSamples`. */
  refreshBuffers(): void;
}

type BgTrackId = "title" | "cannon" | "build" | "score" | "lifeLost" | "jaws";

/** Metadata for a track playing through the shared AudioContext. `cacheId`
 *  is the IDB key (matches an entry in `PRERENDER_BG_TRACKS`); `id` is the
 *  opaque label surfaced to the test observer — same string in current
 *  use, kept distinct so the cache key can change without breaking
 *  observer expectations. */
interface BgTrack {
  readonly id: string;
  readonly cacheId: string;
  readonly loop: boolean;
  readonly volume: number;
}

// Centralized per-track mix levels. Numbers are pre-computed products of the
// old per-track base gain × the old global +25 % MIDI boost (libADLMIDI output
// sat noticeably below the PCM SFX layer). Cannon bg is ~4.5× hotter than the
// other tracks because RXMI_CANNON is mixed noticeably quieter in the original
// assets; jaws is 2× hotter so the one-shot cuts through the battle-anim mix.
// Edit these to retune the music layer's perceived volume.
const TRACK_VOLUMES: Record<BgTrackId, number> = {
  title: 1.25,
  cannon: 5.625,
  build: 1.25,
  score: 1.25,
  lifeLost: 1.25,
  jaws: 2.5,
};
const FANFARE_VOLUME = 1.25;
const BG_TRACK_TITLE: BgTrack = {
  id: "RXMI_TITLE.xmi",
  cacheId: "RXMI_TITLE.xmi",
  loop: true,
  volume: TRACK_VOLUMES.title,
};
const BG_TRACK_CANNON: BgTrack = {
  id: "RXMI_CANNON.xmi",
  cacheId: "RXMI_CANNON.xmi",
  loop: true,
  volume: TRACK_VOLUMES.cannon,
};
const BG_TRACK_BUILD: BgTrack = {
  id: "RXMI_TETRIS.xmi",
  cacheId: "RXMI_TETRIS.xmi",
  loop: true,
  volume: TRACK_VOLUMES.build,
};
// Score-overlay bg music — 0-indexed sub-song 4 of RXMI_SCORE.xmi
// (mapping.txt lists it 1-indexed as "5 -> bg music score"). Loops for
// the duration of the between-rounds score-delta overlay.
const BG_TRACK_SCORE: BgTrack = {
  id: "RXMI_SCORE.xmi",
  cacheId: "RXMI_SCORE.xmi",
  loop: true,
  volume: TRACK_VOLUMES.score,
};
// Life-lost popup one-shot — 0-indexed sub-song 1 of RXMI_TETRIS.xmi
// (mapping.txt "2 -> life lost music"). No loop: plays once as the
// dialog appears. Reselect has no bg music of its own, so the stinger
// normally finishes naturally before the next WALL_BUILD banner would
// replace it; if a very short reselect races ahead the tail gets clipped.
const BG_TRACK_LIFE_LOST: BgTrack = {
  id: "RXMI_TETRIS.xmi#life-lost",
  cacheId: "RXMI_TETRIS.xmi#life-lost",
  loop: false,
  volume: TRACK_VOLUMES.lifeLost,
};
// Balloon-capture jaws theme — 0-indexed sub-song 6 of RXMI_BATTLE.xmi
// (mapping.txt "7 -> jaws theme"). One-shot, no loop: the song body is
// ~7.33 s (libADLMIDI playback) plus ~1.5 s of OPL release tail on the
// final F+F# pad stinger. BALLOON_FLIGHT_DURATION (8.5 s) overlaps the
// release; the source plays through naturally, the next phase's playBg
// replaces it if it's still ringing.
const BG_TRACK_JAWS: BgTrack = {
  id: "RXMI_BATTLE.xmi",
  cacheId: "RXMI_BATTLE.xmi",
  loop: false,
  volume: TRACK_VOLUMES.jaws,
};
// Tower-enclosure fanfares live at 0-indexed sub-songs 4/5/6 of
// RXMI_TETRIS.xmi (mapping.txt lists them 1-indexed as 5/6/7). One
// variant per player slot; a hypothetical 4th player reuses slot 0's.
// Sub-songs are persisted in the cache by index; this map picks one
// per player slot.
const FANFARE_SONG_BY_SLOT: readonly number[] = [4, 5, 6, 4];
// Build bg decrescendo runs on the same 1 s window as the snare's
// crescendo in sfx-player.ts (SNARE_CRESCENDO_SEC): fade STARTS at
// timer = 6.72 s (same instant the snare loop kicks in at 0 gain) and
// ends at timer = 5.72 s (snare at full gain, bg silent). Clean
// cross-fade with mirrored ramps.
const BUILD_BG_FADE_START_SEC = 6.72;
const BUILD_BG_FADE_DURATION_SEC = 1;

export function createMusicSubsystem(): MusicSubsystem {
  // Single AudioContext shared by every bg track + every fanfare. Created
  // lazily inside `activate()` so the constructor never touches Web Audio
  // outside a user gesture. No worklet, no WASM at runtime.
  let audioContext: AudioContext | undefined;
  // Active bg source + its volume gain. Stopping bg = `source.stop()` +
  // null these out. Fading bg = ramp `gain.gain` on the audio-clock.
  let activeSource: AudioBufferSourceNode | undefined;
  let activeGain: GainNode | undefined;
  // Track most recently asked to play; cleared by stopBg. Drives
  // tickPresentation's build-bg fade trigger and the setPaused restart hook.
  let bgPlaying: BgTrack | undefined;
  // In-flight fanfare sources. Fanfares overlap the bg track on purpose
  // (they're one-shots fired on tower-enclosure), so they're NOT cleared
  // by stopBg. Tracked here so `stopAll` can silence them on quit-to-menu
  // — without this, a fanfare fired right before ESC keeps ringing under
  // the lobby. Auto-removed via the `ended` listener once the buffer
  // plays through naturally.
  const activeFanfareSources = new Set<AudioBufferSourceNode>();

  // AudioBuffers built from cached PCM during activate(). Bg tracks live
  // by track id, fanfares by player slot. Populated incrementally — each
  // `activateOnce()` call only loads tracks not already cached, so the
  // first activate (cache empty) followed by a settings-modal upload +
  // close (cache populated) ends up loading the new entries on the
  // post-upload activate without needing a page refresh.
  const bgBuffers = new Map<string, CachedPcm>();
  const fanfareBuffers = new Map<number, AudioBuffer>();
  const bgAudioBuffers = new Map<string, AudioBuffer>();
  // Ids/songs found absent in IDB on a prior activateOnce. activateOnce
  // clears `activatingPromise` in its finally (so a post-upload activate
  // re-reads), which means an asset-less user would otherwise re-probe IDB
  // (open + read + close per id) on EVERY music cue, forever. Skipping
  // known-missing entries bounds that to one probe per id until the next
  // `refreshBuffers` (sound-modal upload) clears these sets.
  const missingBgIds = new Set<string>();
  const missingFanfareSongs = new Set<number>();
  let activatingPromise: Promise<void> | undefined;

  // `wantsBg` is the caller's intent — the bg track most recently requested
  // via `playBg`, recorded even while paused and cleared by `stopBg` /
  // `stopAll`. `paused` means the composition told us the host tab is
  // hidden / soundEnabled is off — cues that land while paused are dropped
  // by `playBg` but their intent survives here, and `applyPauseState`
  // restarts the wanted track on unpause (loop tracks only: one-shots like
  // lifeLost / jaws are moment-anchored, so replaying them on tab re-show
  // would be stale). Matters in online games, where the sim keeps ticking
  // under a hidden tab and phase cues fire while silenced.
  let wantsBg: BgTrack | undefined;
  let paused = false;
  // Bumped by `stopAll`. `playFanfare` captures it before
  // `await activateOnce()` and bails after if it changed — a quit-to-menu
  // that lands mid-await would otherwise start the source AFTER `stopAll`
  // ran (so it couldn't be stopped), leaving a jingle ringing under the
  // lobby / landing page. An epoch, not a boolean: the lobby's own title
  // track restarts right after `stopAll` (showLobby → startTitle), so a
  // flag cleared there would re-admit the stale in-flight call — the epoch
  // only invalidates calls that began before the quit.
  let playEpoch = 0;
  // Bg-only sibling of `playEpoch`, bumped by `stopBg` (and therefore by
  // `stopAll`, which routes through it). `playBg` checks THIS epoch: a
  // stop cue that lands while a playBg awaits IDB hydration (first cues
  // of a session, or right after a sound-modal `refreshBuffers`) must
  // invalidate that play, or the stale looped source starts after the
  // stop ran and rings until the next cue. Separate from `playEpoch` so
  // a bg stop can't cancel a pending fanfare — fanfare jingles are
  // independent of the bg track and only die on quit (`stopAll`).
  let bgEpoch = 0;
  // Hydration sibling of `playEpoch`/`bgEpoch` (which cover playback).
  // Bumped by `refreshBuffers` (sound-modal upload). The hydrate loops
  // capture it on entry and bail after every await once it moves: the
  // sound modal's close-click runs `activate()` synchronously (gesture-
  // bound context resume) even while an upload is still writing, and an
  // IDB read STARTED against the mid-write store can RESOLVE after the
  // upload committed and `refreshBuffers` cleared the caches (readonly
  // transactions serialize behind the write). A straddling loop would
  // then re-add `missingBgIds` entries — or cache the superseded
  // upload's PCM — right after the clear, leaving those tracks silent
  // or stale until the NEXT upload.
  let hydrationEpoch = 0;
  // Serializes suspend/resume so a rapid hide→show can't skip the resume —
  // see `setPaused`.
  let pauseTransition: Promise<void> = Promise.resolve();

  // Tracks whether the tick-derived fade signal has already fired in the
  // current WALL_BUILD phase — prevents re-triggering the ramp every frame
  // past the threshold.
  let buildBgFadeTriggered = false;
  // Previous-tick phase for leave-WALL_BUILD edge detection.
  let buildBgLastPhase: Phase | undefined;

  // Bus binding tracker — one array instead of per-event locals so unbind
  // is a one-liner (matches sfx-player's pattern).
  let boundBus: GameEventBus | undefined;
  type EventKey = keyof GameEventMap;
  const boundHandlers: Array<{
    type: EventKey;
    handler: GameEventHandler<EventKey>;
  }> = [];

  function ensureAudioContext(): AudioContext | undefined {
    if (audioContext) return audioContext;
    if (typeof AudioContext === "undefined") return undefined;
    audioContext = new AudioContext();
    return audioContext;
  }

  function pcmToAudioBuffer(ctx: AudioContext, pcm: CachedPcm): AudioBuffer {
    // Cached PCM is rendered at the device sample rate the user had at
    // upload time — usually but not always the same as `ctx.sampleRate`.
    // Constructing the AudioBuffer at the cached rate is correct: the
    // AudioBufferSourceNode resamples on playback if rates differ.
    const buffer = ctx.createBuffer(2, pcm.frames, pcm.sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < pcm.frames; i += 1) {
      left[i] = pcm.pcm[i * 2]!;
      right[i] = pcm.pcm[i * 2 + 1]!;
    }
    return buffer;
  }

  function activateOnce(): Promise<void> {
    if (activatingPromise) return activatingPromise;
    const promise = (async () => {
      const ctx = ensureAudioContext();
      if (!ctx) return;
      // Resume now (we're inside the home-page click). Safe to call repeatedly.
      if (audioContextNeedsResume(ctx)) {
        await ctx.resume().catch(() => {});
      }
      try {
        await hydrateBgTracks(ctx);
        await hydrateFanfares(ctx);
      } catch (error) {
        // A corrupt cached PCM entry (pcmToAudioBuffer throws on
        // zero-frame / out-of-range rates, outside the per-read catch)
        // must not reject every awaiting cue: a rejection escaping here
        // used to orphan the `setPaused` chain — every later
        // `.then(applyPauseState)` on the rejected promise skipped, so
        // suspend/resume stayed dead for the rest of the session. The
        // bad entry's hydration is abandoned; the next `refreshBuffers`
        // (sound-modal upload) clears the caches and re-probes.
        console.error("[music] hydration failed:", error);
      }
    })();
    activatingPromise = promise;
    // Clear the in-flight handle once the load settles, so a later
    // call (e.g. after the settings modal closes with new PCM in IDB)
    // re-runs the cache load instead of returning the cached resolved
    // promise. Identity-guarded: `refreshBuffers` may have already
    // dropped this handle and a newer hydration may own it by the time
    // this one settles — clearing unconditionally would orphan that
    // newer in-flight handle.
    const clear = () => {
      if (activatingPromise === promise) activatingPromise = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  }

  /** Hydrate bg tracks from the upload-time PCM cache. Skips tracks already
   *  loaded (repeat calls only pay the IDB cost for newly-cached entries)
   *  and ids known-missing (so an asset-less user doesn't re-probe IDB on
   *  every cue). A still-missing entry leaves the track silent — playBg
   *  gracefully no-ops. */
  async function hydrateBgTracks(ctx: AudioContext): Promise<void> {
    const epoch = hydrationEpoch;
    for (const spec of PRERENDER_BG_TRACKS) {
      if (bgAudioBuffers.has(spec.id)) continue;
      if (missingBgIds.has(spec.id)) continue;
      const pcm = await loadPcmCache(spec.id).catch((error) => {
        console.warn(`[music] cache read failed for ${spec.id}:`, error);
        return undefined;
      });
      // Read started before a `refreshBuffers` — its result describes a
      // superseded store. Record NOTHING (neither missing nor PCM) and
      // abandon; the next activateOnce re-hydrates from the fresh store.
      if (epoch !== hydrationEpoch) return;
      if (!pcm) {
        missingBgIds.add(spec.id);
        continue;
      }
      bgBuffers.set(spec.id, pcm);
      bgAudioBuffers.set(spec.id, pcmToAudioBuffer(ctx, pcm));
    }
  }

  /** Hydrate fanfares the same way as bg tracks; map every slot that uses
   *  each sub-song to the same AudioBuffer (slots 0 and 3 share song 4). */
  async function hydrateFanfares(ctx: AudioContext): Promise<void> {
    const epoch = hydrationEpoch;
    const fanfareAudioBySong = new Map<number, AudioBuffer>();
    for (const songIndex of PRERENDER_FANFARE_SONGS) {
      const alreadyLoaded = [...fanfareBuffers.keys()].some(
        (slot) => FANFARE_SONG_BY_SLOT[slot] === songIndex,
      );
      if (alreadyLoaded) continue;
      if (missingFanfareSongs.has(songIndex)) continue;
      const pcm = await loadPcmCache(fanfareCacheId(songIndex)).catch(
        (error) => {
          console.warn(
            `[music] cache read failed for fanfare ${songIndex}:`,
            error,
          );
          return undefined;
        },
      );
      // Same stale-read bail as hydrateBgTracks — see the comment there.
      if (epoch !== hydrationEpoch) return;
      if (!pcm) {
        missingFanfareSongs.add(songIndex);
        continue;
      }
      fanfareAudioBySong.set(songIndex, pcmToAudioBuffer(ctx, pcm));
    }
    for (let slot = 0; slot < FANFARE_SONG_BY_SLOT.length; slot += 1) {
      if (fanfareBuffers.has(slot)) continue;
      // In-bounds by the loop condition — the index access can't miss.
      const songIndex = FANFARE_SONG_BY_SLOT[slot]!;
      const buffer = fanfareAudioBySong.get(songIndex);
      if (buffer) fanfareBuffers.set(slot, buffer);
    }
  }

  function stopActiveSource(): void {
    if (!activeSource) return;
    try {
      activeSource.stop();
    } catch {
      // Source already ended — fine.
    }
    activeSource = undefined;
    activeGain = undefined;
  }

  async function playBg(track: BgTrack): Promise<void> {
    // Record intent BEFORE the paused early-return so a cue that lands
    // while silenced can be restarted on unpause (see `wantsBg`).
    wantsBg = track;
    if (paused) return;
    const epoch = bgEpoch;
    await activateOnce();
    // Any `stopBg` during the await (quit-to-menu `stopAll`, battle-banner
    // stop cue, …) invalidates this play — its source would start AFTER
    // the stop ran, with nothing left to stop it.
    if (paused || epoch !== bgEpoch) return;
    const ctx = audioContext;
    const buffer = bgAudioBuffers.get(track.cacheId);
    const pcm = bgBuffers.get(track.cacheId);
    if (!ctx || !buffer || !pcm) return;
    // iOS interruption (phone call, Siri): DROP one-shots (lifeLost,
    // jaws) — they're moment-anchored, and every source started while
    // interrupted bursts out together when iOS releases the context
    // (same rule as sfx-player's playSample). Loops keep starting:
    // they're continuous beds, and nothing re-triggers them when the
    // interruption ends (interruptions fire no event), so dropping a
    // loop would leave the rest of the phase silent.
    if (!track.loop && isAudioContextInterrupted(ctx)) return;
    try {
      stopActiveSource();
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      if (track.loop) {
        source.loop = true;
        // XMI FOR/NEXT markers: re-loop only the marked region. Without
        // markers, source.loop with default loopStart=0 / loopEnd=0
        // re-loops the entire buffer.
        if (pcm.loopStartSec >= 0 && pcm.loopEndSec > 0) {
          source.loopStart = pcm.loopStartSec;
          source.loopEnd = pcm.loopEndSec;
        }
      }
      const gain = ctx.createGain();
      gain.gain.value = track.volume;
      source.connect(gain);
      gain.connect(ctx.destination);
      // Self-clear when the source ends naturally (one-shots only — looped
      // sources keep the references alive until explicit stopBg).
      source.addEventListener("ended", () => {
        if (activeSource === source) {
          activeSource = undefined;
          activeGain = undefined;
        }
      });
      source.start(0);
      activeSource = source;
      activeGain = gain;
      bgPlaying = track;
      buildBgFadeTriggered = false;
    } catch (error) {
      console.error(`[music] ${track.id} playback failed:`, error);
    }
  }

  function stopBg(): void {
    // Invalidate any playBg mid-await — see `bgEpoch`.
    bgEpoch += 1;
    // Stop events fire fine while paused (they only clear state), so
    // clearing the intent here keeps `wantsBg` accurate across e.g. a
    // SCORE_OVERLAY_END that lands under a hidden tab.
    wantsBg = undefined;
    bgPlaying = undefined;
    stopActiveSource();
  }

  function fadeOutBg(): void {
    if (!audioContext || !activeGain) return;
    const now = audioContext.currentTime;
    activeGain.gain.cancelScheduledValues(now);
    activeGain.gain.setValueAtTime(activeGain.gain.value, now);
    activeGain.gain.linearRampToValueAtTime(
      0,
      now + BUILD_BG_FADE_DURATION_SEC,
    );
  }

  async function playTitle(): Promise<void> {
    if (bgPlaying === BG_TRACK_TITLE) return;
    // playBg records the intent and defers while paused — the title
    // starts when setPaused(false) fires.
    await playBg(BG_TRACK_TITLE);
  }

  function stopAll(): void {
    // Invalidate any playBg / playFanfare currently mid-await (activateOnce
    // IDB hydration) so it doesn't start a source after this stop runs.
    playEpoch += 1;
    stopBg();
    for (const source of activeFanfareSources) {
      try {
        source.stop();
      } catch {
        // already ended — fine
      }
    }
    activeFanfareSources.clear();
  }

  async function playFanfare(playerId: ValidPlayerId): Promise<void> {
    if (paused) return;
    const epoch = playEpoch;
    await activateOnce();
    // See playBg: a quit-to-menu `stopAll` during the await invalidates
    // this fanfare so it can't ring under the lobby.
    if (paused || epoch !== playEpoch) return;
    const ctx = audioContext;
    if (!ctx) return;
    // Fanfares are one-shots: drop while interrupted (see playBg) —
    // enclosure fanfares scheduled during a phone call would otherwise
    // pile up in `activeFanfareSources` and burst out together.
    if (isAudioContextInterrupted(ctx)) return;
    const buffer = fanfareBuffers.get(playerId) ?? fanfareBuffers.get(0);
    if (!buffer) return;
    try {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = FANFARE_VOLUME;
      source.connect(gain);
      gain.connect(ctx.destination);
      activeFanfareSources.add(source);
      source.addEventListener("ended", () => {
        activeFanfareSources.delete(source);
      });
      source.start(0);
    } catch (error) {
      console.error(
        `[music] fanfare playback failed for slot ${playerId}:`,
        error,
      );
    }
  }

  function tickPresentation(state: GameState): void {
    const phase = state.phase;
    // Edge: just left WALL_BUILD — hard-stop build-bg (safety net in case
    // the fade signal never crossed, e.g. build phase cut short). Guarded on
    // bgPlaying so we don't cut off the next phase's music (cannon-bg may
    // already have started by the time this frame runs).
    if (buildBgLastPhase === Phase.WALL_BUILD && phase !== Phase.WALL_BUILD) {
      if (bgPlaying === BG_TRACK_BUILD) stopBg();
      buildBgFadeTriggered = false;
    }
    buildBgLastPhase = phase;

    if (phase !== Phase.WALL_BUILD) return;
    if (buildBgFadeTriggered) return;
    if (bgPlaying !== BG_TRACK_BUILD) return;
    if (state.timer <= 0 || state.timer > BUILD_BG_FADE_START_SEC) return;
    buildBgFadeTriggered = true;
    fadeOutBg();
  }

  function unbindCurrentBus(): void {
    if (boundBus) {
      for (const { type, handler } of boundHandlers) {
        boundBus.off(type, handler);
      }
    }
    boundBus = undefined;
    boundHandlers.length = 0;
    buildBgFadeTriggered = false;
    buildBgLastPhase = undefined;
  }

  function subscribeBus(bus: GameEventBus): void {
    if (boundBus === bus) return;
    unbindCurrentBus();
    boundBus = bus;

    const bind = <K extends EventKey>(
      type: K,
      handler: GameEventHandler<K>,
    ): void => {
      bus.on(type, handler);
      boundHandlers.push({
        type,
        handler: handler as GameEventHandler<EventKey>,
      });
    };

    // Stop the title track the moment any player confirms their starting
    // castle (stopBg also drops the `wantsBg` intent). After a mid-game
    // reselect the title isn't playing anyway, so the no-op stop is
    // harmless.
    bind(GAME_EVENT.CASTLE_PLACED, () => {
      stopBg();
    });

    // Cannon-phase bg music: starts when the CANNON_PLACE banner begins
    // sweeping and stops when the BATTLE banner takes over. If the upgrade
    // flow started cannon-bg early (upgrade-pick banner), the Build
    // banner's sweep-start stops it — giving us silence during the
    // actual banner sweep before build-bg picks up at bannerSweepEnd.
    bind(GAME_EVENT.BANNER_START, (event) => {
      if (event.bannerKind === "cannon-place") {
        void playBg(BG_TRACK_CANNON);
      } else if (
        event.bannerKind === "battle" ||
        event.bannerKind === "modifier-reveal"
      ) {
        stopBg();
      } else if (
        event.bannerKind === "build" &&
        bgPlaying === BG_TRACK_CANNON
      ) {
        // Upgrade-pick flow started cannon-bg early to cover the dialog;
        // stop it here so build-bg can take over at bannerSweepEnd.
        stopBg();
      }
    });

    // Build-phase bg music starts AFTER the "Build & Repair" banner
    // finishes sweeping. The "Choose Upgrade" banner also runs under
    // phase=WALL_BUILD but carries bannerKind="upgrade-pick", so
    // discriminating on kind keeps the cue exclusive to the actual
    // build banner. Fade-out is state-derived, see tickPresentation.
    bind(GAME_EVENT.BANNER_SWEEP_END, (event) => {
      if (event.bannerKind === "build") {
        void playBg(BG_TRACK_BUILD);
      }
    });

    // Between-rounds score-delta overlay: looped bg music for as long as
    // the overlay is displayed.
    bind(GAME_EVENT.SCORE_OVERLAY_START, () => {
      void playBg(BG_TRACK_SCORE);
    });
    bind(GAME_EVENT.SCORE_OVERLAY_END, () => {
      stopBg();
    });

    // Life-lost popup: one-shot track. Plays through the dialog and into
    // reselect naturally (no loop flag). The next phase's playBg (usually
    // build-bg after a reselect+banner sweep) will cut the tail if it's
    // still ringing — reselect's timer is normally long enough for the
    // stinger to finish first.
    bind(GAME_EVENT.LIFE_LOST_DIALOG_SHOW, () => {
      void playBg(BG_TRACK_LIFE_LOST);
    });

    // Balloon-capture jaws theme: one-shot. Start on animation start, stop
    // on animation end — the track finishes (body + OPL release) within
    // BALLOON_FLIGHT_DURATION, so the stop is defensive against a long
    // release on an alternate sound bank.
    bind(GAME_EVENT.BALLOON_ANIM_START, () => {
      void playBg(BG_TRACK_JAWS);
    });
    bind(GAME_EVENT.BALLOON_ANIM_END, () => {
      stopBg();
    });

    // Upgrade-pick dialog: play cannon-bg through the whole screen —
    // starts at UPGRADE_PICK_SHOW, keeps playing across the dialog and
    // the following "Build & Repair" banner sweep. The bannerStart
    // handler (kind === "build") stops it; bannerSweepEnd
    // (kind === "build") starts build-bg.
    bind(GAME_EVENT.UPGRADE_PICK_SHOW, () => {
      void playBg(BG_TRACK_CANNON);
    });
  }

  async function activate(): Promise<void> {
    await activateOnce();
  }

  function refreshBuffers(): void {
    // Invalidate any in-flight hydration FIRST: its IDB reads describe
    // the pre-upload store, and one resolving after the clears below
    // would re-poison `missingBgIds` / cache superseded PCM (see
    // `hydrationEpoch`).
    hydrationEpoch++;
    // Drop the in-flight HANDLE too. The epoch bump makes the old
    // hydration record nothing, so an activate awaiting it (the
    // sound-modal close sequence: refreshBuffers → startTitle) would
    // settle against the just-cleared caches and silently play nothing —
    // the lobby title stayed mute until the next unrelated activate. The
    // next activateOnce must start a fresh post-upload hydration.
    activatingPromise = undefined;
    // Drop the hydrated PCM + AudioBuffer caches; activateOnce() re-reads
    // from IDB on next play. The currently-playing source keeps its own
    // buffer reference, so playback isn't cut — the next phase's playBg
    // picks up the new music. The AudioContext + bus binding stay.
    bgBuffers.clear();
    bgAudioBuffers.clear();
    fanfareBuffers.clear();
    // Re-probe IDB for previously-missing entries — the upload may have
    // just rendered them.
    missingBgIds.clear();
    missingFanfareSongs.clear();
  }

  function setPaused(nextPaused: boolean): Promise<void> {
    paused = nextPaused;
    // Serialize transitions — same shape as sfx-player's setPaused: a
    // resume() issued while the suspend() is still in flight reads
    // `ctx.state` as "running" and no-ops, stranding the context suspended
    // with `paused = false`. Each chained step applies the LATEST intent.
    // The rejected branch applies it too: a single rejection must not
    // orphan the chain — every later `.then(onFulfilled)` on a rejected
    // promise skips, which left suspend-on-hide and resume-on-show dead
    // for the rest of the session (plus an unhandled rejection per call,
    // since `applyMute` voids the returned promise).
    pauseTransition = pauseTransition.then(applyPauseState, applyPauseState);
    return pauseTransition;
  }

  async function applyPauseState(): Promise<void> {
    const ctx = audioContext;
    if (ctx) {
      if (paused && audioContextCanSuspend(ctx)) {
        await ctx.suspend().catch(() => {});
      } else if (!paused && audioContextNeedsResume(ctx)) {
        await ctx.resume().catch(() => {});
      }
    }
    // Deferred start: cues that landed while paused recorded their intent
    // in `wantsBg` — restart the wanted track now that we're audible
    // again. Loops only (title + phase bg): one-shots (lifeLost, jaws)
    // are moment-anchored and stay dropped.
    if (!paused && wantsBg?.loop && bgPlaying !== wantsBg) {
      await playBg(wantsBg);
    }
  }

  return {
    activate,
    startTitle: playTitle,
    stopAll,
    playFanfare,
    subscribeBus,
    tickPresentation,
    setPaused,
    refreshBuffers,
  };
}
