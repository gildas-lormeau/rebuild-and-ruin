/**
 * Music sub-system — libadlmidi-js-driven OPL3 playback of player-supplied
 * Rampart music files.
 *
 * ### Synth topology
 *
 * All non-overlapping tracks (title / cannon-bg / build-bg / score-bg /
 * life-lost / jaws) share one `bgSynth`. Game flow guarantees only one plays
 * at a time — phases are sequential and the stingers (life-lost, jaws) sit in
 * windows where no other bg track is running. Collapsing them onto one synth
 * means one AudioContext + WASM instance instead of six, well below the
 * browser's active-context cap.
 *
 * Fanfares overlap bg music (an enclosure completed mid-build fires a fanfare
 * while build-bg keeps playing). Rather than spinning a second worklet per
 * slot, they're pre-rendered once at activate-time via the headless WASM core
 * (no AudioContext, no AudioWorklet) and replayed via plain
 * `AudioBufferSourceNode` on the bg synth's AudioContext. Free overlap, zero
 * idle CPU.
 *
 * Plays RXMI_TITLE.xmi from the moment the subsystem is bound to a game bus
 * (first launch + rematch) until the first WALL_BUILD phase starts. Silent if
 * `MusicAssets` is null (player hasn't dropped in their Rampart files). Mirrors
 * the observer+bus pattern used by [runtime-haptics.ts](./runtime-haptics.ts).
 *
 * ### Autoplay policy
 *
 * Browsers suspend a fresh AudioContext until a user gesture. The first
 * `synth.init()` call therefore may hang pending a click/tap. We don't try to
 * start music at construction time; instead the composition root wires it to
 * the first UI_TAP on each new bus.
 *
 * ### libadlmidi-js
 *
 * Bundled as an npm dep, lazy-loaded on the first `activate()` so the main
 * entry chunk stays small. The processor.js + core.wasm files ship as
 * `new URL(..., import.meta.url)` asset references that Vite emits into
 * dist/ at build time — no CDN at runtime.
 *
 * ### Test observer
 *
 * Tests pass an optional `observer` that captures `onPlay(track)` / `onStop`
 * intents, so a scenario can assert "binding this bus would trigger title
 * music" without booting an AudioContext or fetching WASM.
 */

import {
  GAME_EVENT,
  type GameEventBus,
  type GameEventHandler,
  type GameEventMap,
} from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type { MusicObserver } from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import {
  AUDIO_CONTEXT_RUNNING,
  AUDIO_CONTEXT_SUSPENDED,
} from "../shared/platform/platform.ts";
import {
  xmiContainerBlocks,
  xmidToSmf,
} from "../shared/platform/xmi-to-smf.ts";
import type { MusicAssets, XmiFileKey } from "./music-assets.ts";
import type { SynthHandle } from "./music-synth-loader.ts";

interface MusicSubsystem {
  /** Pre-warm the AudioContext + WASM inside a user-gesture handler (the
   *  home-page "Play" button click). Pure side-effect: kicks off synth init
   *  and returns when WOPL is loaded. No playback yet. Safe to call repeatedly;
   *  subsequent calls are no-ops. */
  activate(): Promise<void>;
  /** Start the RXMI_TITLE.xmi track. Called from the lobby entry point so
   *  music covers the pre-game screen. Idempotent per instance. */
  startTitle(): Promise<void>;
  /** Stop any active playback. Idempotent. */
  stopTitle(): Promise<void>;
  /** Play the one-shot tower-enclosure fanfare for a player. Picks a
   *  TETRIS sub-song by player slot (5/6/7 cycle). Runs on its own synth
   *  so it can overlap build-bg during WALL_BUILD. */
  playFanfare(playerId: ValidPlayerSlot): Promise<void>;
  /** Bind to the supplied game bus so PHASE_START=WALL_BUILD auto-stops the
   *  title track when the first castle goes down. Re-binding to a different
   *  bus (rematch) unbinds the previous one. */
  subscribeBus(bus: GameEventBus): void;
  /** Compute continuous presentational signals from `state` each frame —
   *  currently drives the build bg decrescendo (derived from `state.timer`)
   *  and stop on WALL_BUILD exit. Mirrors sfx-player's equivalent hook. */
  tickPresentation(state: GameState): void;
  /** Suspend or resume the AudioContext — wired to `document.visibilitychange`
   *  so music doesn't keep looping in a backgrounded tab. No-op until the
   *  synth has been initialized. */
  setPaused(paused: boolean): Promise<void>;
  /** Release the bus listener and stop playback. */
  dispose(): Promise<void>;
}

interface MusicSubsystemDeps {
  /** Live getter so the composition root can construct the subsystem once and
   *  let the settings dialog populate IDB later — the first `activate()` or
   *  bus subscription after files are loaded will pick them up. */
  readonly getAssets: () => MusicAssets | undefined;
  /** Optional promise the subsystem awaits inside `activate()` so the
   *  home-page click handler can race ahead of the initial IDB read without
   *  silently getting null assets. */
  readonly assetsReady?: Promise<void>;
  readonly observer?: MusicObserver;
}

type BgTrackId = "title" | "cannon" | "build" | "score" | "lifeLost" | "jaws";

/** Descriptor for a track that plays on the shared `bgSynth`. `id` is the
 *  opaque label surfaced to the test observer — disambiguates same-file
 *  different-sub-song tracks (build-bg vs life-lost both live in TETRIS.xmi). */
interface BgTrack {
  readonly id: string;
  readonly file: XmiFileKey;
  readonly songIndex: number;
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
  file: "RXMI_TITLE.xmi",
  songIndex: 0,
  loop: true,
  volume: TRACK_VOLUMES.title,
};
const BG_TRACK_CANNON: BgTrack = {
  id: "RXMI_CANNON.xmi",
  file: "RXMI_CANNON.xmi",
  songIndex: 0,
  loop: true,
  volume: TRACK_VOLUMES.cannon,
};
const BG_TRACK_BUILD: BgTrack = {
  id: "RXMI_TETRIS.xmi",
  file: "RXMI_TETRIS.xmi",
  songIndex: 0,
  loop: true,
  volume: TRACK_VOLUMES.build,
};
// Score-overlay bg music — 0-indexed sub-song 4 of RXMI_SCORE.xmi
// (mapping.txt lists it 1-indexed as "5 -> bg music score"). Loops for
// the duration of the between-rounds score-delta overlay.
const BG_TRACK_SCORE: BgTrack = {
  id: "RXMI_SCORE.xmi",
  file: "RXMI_SCORE.xmi",
  songIndex: 4,
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
  file: "RXMI_TETRIS.xmi",
  songIndex: 1,
  loop: false,
  volume: TRACK_VOLUMES.lifeLost,
};
// Balloon-capture jaws theme — 0-indexed sub-song 6 of RXMI_BATTLE.xmi
// (mapping.txt "7 -> jaws theme"). One-shot, no loop: the track is
// ~7.66 s long (libADLMIDI playback). BALLOON_FLIGHT_DURATION is set
// to 5.5 s so balloonAnimEnd cuts the track's tail — an intentional
// trim to keep the animation beat tight.
const BG_TRACK_JAWS: BgTrack = {
  id: "RXMI_BATTLE.xmi",
  file: "RXMI_BATTLE.xmi",
  songIndex: 6,
  loop: false,
  volume: TRACK_VOLUMES.jaws,
};
const FANFARE_TRACK: XmiFileKey = "RXMI_TETRIS.xmi";
// Tower-enclosure fanfares live at 0-indexed sub-songs 4/5/6 of
// RXMI_TETRIS.xmi (mapping.txt lists them 1-indexed as 5/6/7). One
// variant per player slot; a hypothetical 4th player reuses slot 0's.
const FANFARE_SONG_BY_SLOT: readonly number[] = [4, 5, 6, 4];
// Build bg decrescendo runs on the same 1 s window as the snare's
// crescendo in sfx-player.ts (SNARE_CRESCENDO_SEC): fade STARTS at
// timer = 6.72 s (same instant the snare loop kicks in at 0 gain) and
// ends at timer = 5.72 s (snare at full gain, bg silent). Clean
// cross-fade with mirrored ramps.
const BUILD_BG_FADE_START_SEC = 6.72;
const BUILD_BG_FADE_DURATION_SEC = 1;
const STOP_REASON_PHASE = "phase" as const;
const STOP_REASON_DISPOSE = "dispose" as const;

export function createMusicSubsystem(deps: MusicSubsystemDeps): MusicSubsystem {
  // Shared synth for all non-fanfare tracks. Game flow guarantees only one
  // bg track plays at a time, so one AudioContext + WASM instance handles
  // all six.
  let bgSynth: Promise<SynthHandle | undefined> | undefined;
  // Track currently loaded into bgSynth. loadMidi is skipped when the same
  // track is (re)played — repeat triggers only pay the stop+play rewind cost.
  let bgLoaded: BgTrack | undefined;
  // Track most recently asked to play; cleared by stopBg. Drives
  // tickPresentation's build-bg fade trigger and the setPaused restart hook.
  let bgPlaying: BgTrack | undefined;
  // Cached SMF bytes per (file, songIndex). XMI→SMF conversion happens once
  // per unique track per session; switching tracks only replays cached bytes
  // plus a fresh copy (AudioWorklet transfers ownership on loadMidi). null
  // means "we tried to parse this once and it failed" — don't warn again.
  const smfCache = new Map<string, Uint8Array | null>();

  // Pre-rendered PCM AudioBuffers for each fanfare variant, keyed by player
  // slot. Built once during `activate()` via the headless WASM core (no
  // worklet, no extra AudioContext). Playback creates an AudioBufferSourceNode
  // on the bg synth's context — free overlap, no per-slot worklet ticking.
  const fanfareBuffers = new Map<number, AudioBuffer>();
  let fanfaresPrerendered = false;
  let fanfaresPrerenderingPromise: Promise<void> | undefined;

  // `wantsTitle` is the caller's intent (lobby said "play title"). `paused`
  // means the composition told us the host tab is hidden / externally
  // quieted — we honor wantsTitle but defer the play call until un-paused.
  let wantsTitle = false;
  let paused = false;

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

  function loadSmf(track: BgTrack): Uint8Array | undefined {
    const key = `${track.file}#${track.songIndex}`;
    if (smfCache.has(key)) return smfCache.get(key) ?? undefined;
    const assets = deps.getAssets();
    if (!assets) return undefined;
    const blocks = xmiContainerBlocks(assets.xmi[track.file]);
    const block = blocks[track.songIndex]?.block;
    if (!block) {
      console.warn(
        `[music] ${track.id} sub-song ${track.songIndex} missing in ${track.file}`,
      );
      smfCache.set(key, null);
      return undefined;
    }
    const smf = xmidToSmf(block);
    if (!smf) {
      console.warn(`[music] ${track.id} has no EVNT chunk`);
      smfCache.set(key, null);
      return undefined;
    }
    smfCache.set(key, smf);
    return smf;
  }

  // Permanent-fail latch: a failed synth init (dynamic import error, WASM load
  // failure, loadSynth throw) is deterministic within a session — the asset
  // bundle and browser caps don't change. Without the latch, every subsequent
  // playBg/activate would re-run the same guaranteed-failing init.
  let bgSynthLoadFailed = false;

  function ensureBgSynth(): Promise<SynthHandle | undefined> {
    if (bgSynthLoadFailed) return Promise.resolve(undefined);
    if (bgSynth) return bgSynth;
    bgSynth = (async () => {
      const assets = deps.getAssets();
      if (!assets) return undefined;
      const loader = await import("./music-synth-loader.ts");
      return loader.loadSynth(assets);
    })().catch((error) => {
      console.error("[music] synth init failed:", error);
      bgSynthLoadFailed = true;
      bgSynth = undefined;
      deps.observer?.onInitError?.(error);
      return undefined;
    });
    return bgSynth;
  }

  async function playBg(track: BgTrack): Promise<void> {
    if (paused) return;
    if (deps.assetsReady) await deps.assetsReady;
    const synth = await ensureBgSynth();
    if (!synth || paused) return;
    try {
      // stop() before (re)play rewinds so a repeat trigger replays from the
      // top. Also cancels any in-flight fade from the previous use of this
      // synth (the build-bg decrescendo leaves the gain ramped to 0).
      await synth.stop();
      if (bgLoaded !== track) {
        const smf = loadSmf(track);
        if (!smf) return;
        // AudioWorklet messaging transfers ownership — hand over a copy so
        // the cached SMF stays intact for subsequent replays.
        await synth.loadMidi(copyBuffer(smf));
        // Loop flag applies to the currently loaded file; must be set after
        // loadMidi, not before.
        synth.setLoopEnabled(track.loop);
        bgLoaded = track;
      }
      // Reset gain every play — the previous track's fade (or its own
      // different volume) otherwise bleeds in. setVolume writes .gain.value
      // directly, which beats an already-settled ramp; active ramps are
      // cancelled by the preceding stop().
      synth.setVolume(track.volume);
      await synth.play();
      bgPlaying = track;
      buildBgFadeTriggered = false;
      deps.observer?.onPlay?.(track.id);
    } catch (error) {
      console.error(`[music] ${track.id} playback failed:`, error);
    }
  }

  async function stopBg(
    reason: "phase" | "rematch" | "dispose",
  ): Promise<void> {
    if (!bgSynth) return;
    const wasPlaying = bgPlaying !== undefined;
    bgPlaying = undefined;
    try {
      const synth = await bgSynth;
      await synth?.stop();
    } catch {
      // synth failed to init or is already gone — nothing to stop
    }
    if (wasPlaying) deps.observer?.onStop?.(reason);
  }

  async function fadeOutBg(): Promise<void> {
    if (!bgSynth) return;
    const synth = await bgSynth;
    synth?.fadeTo(0, BUILD_BG_FADE_DURATION_SEC);
  }

  async function playTitle(): Promise<void> {
    wantsTitle = true;
    // Wait for the initial IDB read — the lobby's startTitle() can race ahead.
    if (deps.assetsReady) await deps.assetsReady;
    if (paused) return; // will start when setPaused(false) fires
    if (bgPlaying === BG_TRACK_TITLE) return;
    await playBg(BG_TRACK_TITLE);
  }

  async function stopTitle(): Promise<void> {
    wantsTitle = false;
    await stopBg(STOP_REASON_PHASE);
  }

  function prerenderFanfares(): Promise<void> {
    if (fanfaresPrerendered) return Promise.resolve();
    if (fanfaresPrerenderingPromise) return fanfaresPrerenderingPromise;
    fanfaresPrerenderingPromise = (async () => {
      if (deps.assetsReady) await deps.assetsReady;
      const synth = await ensureBgSynth();
      const ctx = synth?.audioContext;
      if (!ctx) return;
      const assets = deps.getAssets();
      if (!assets) return;
      const blocks = xmiContainerBlocks(assets.xmi[FANFARE_TRACK]);
      const loader = await import("./music-synth-loader.ts");
      const renderer = await loader
        .createFanfareRenderer(assets, ctx)
        .catch((error) => {
          console.error("[music] fanfare renderer init failed:", error);
          return undefined;
        });
      if (!renderer) return;
      try {
        // Render each unique sub-song once, then map every slot that uses
        // that sub-song to the same AudioBuffer (slots 0 and 3 share song 4).
        const buffersBySong = new Map<number, AudioBuffer>();
        for (let slot = 0; slot < FANFARE_SONG_BY_SLOT.length; slot += 1) {
          const songIdx =
            FANFARE_SONG_BY_SLOT[slot] ?? FANFARE_SONG_BY_SLOT[0]!;
          let buffer = buffersBySong.get(songIdx);
          if (!buffer) {
            const block = blocks[songIdx]?.block;
            if (!block) {
              console.warn(
                `[music] fanfare song ${songIdx} missing in TETRIS.xmi`,
              );
              continue;
            }
            const smf = xmidToSmf(block);
            if (!smf) {
              console.warn(`[music] fanfare song ${songIdx} has no EVNT chunk`);
              continue;
            }
            let rendered: AudioBuffer | undefined;
            try {
              rendered = renderer.render(smf, songIdx);
            } catch (error) {
              console.error(
                `[music] fanfare song ${songIdx} render failed:`,
                error,
              );
              continue;
            }
            if (!rendered) continue;
            buffersBySong.set(songIdx, rendered);
            buffer = rendered;
          }
          fanfareBuffers.set(slot, buffer);
        }
      } finally {
        renderer.close();
      }
      fanfaresPrerendered = true;
    })();
    return fanfaresPrerenderingPromise;
  }

  async function playFanfare(playerId: ValidPlayerSlot): Promise<void> {
    if (paused) return;
    await prerenderFanfares();
    const synth = await ensureBgSynth();
    const ctx = synth?.audioContext;
    if (!ctx) return;
    const buffer = fanfareBuffers.get(playerId) ?? fanfareBuffers.get(0);
    if (!buffer) return;
    try {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = FANFARE_VOLUME;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start(0);
      deps.observer?.onPlay?.(`${FANFARE_TRACK}#slot${playerId}`);
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
    // already have started on the same synth by the time this frame runs).
    if (buildBgLastPhase === Phase.WALL_BUILD && phase !== Phase.WALL_BUILD) {
      if (bgPlaying === BG_TRACK_BUILD) void stopBg(STOP_REASON_PHASE);
      buildBgFadeTriggered = false;
    }
    buildBgLastPhase = phase;

    if (phase !== Phase.WALL_BUILD) return;
    if (buildBgFadeTriggered) return;
    if (bgPlaying !== BG_TRACK_BUILD) return;
    if (state.timer <= 0 || state.timer > BUILD_BG_FADE_START_SEC) return;
    buildBgFadeTriggered = true;
    void fadeOutBg();
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
    // castle. Ignore `isReselect` — after a mid-game castle reselect the
    // title isn't playing anyway.
    bind(GAME_EVENT.CASTLE_PLACED, (event) => {
      if (event.isReselect) return;
      wantsTitle = false;
      void stopBg(STOP_REASON_PHASE);
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
        void stopBg(STOP_REASON_PHASE);
      } else if (
        event.bannerKind === "build" &&
        bgPlaying === BG_TRACK_CANNON
      ) {
        // Upgrade-pick flow started cannon-bg early to cover the dialog;
        // stop it here so build-bg can take over at bannerSweepEnd.
        void stopBg(STOP_REASON_PHASE);
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
      void stopBg(STOP_REASON_PHASE);
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
    // on animation end — the track is pinned to exactly BALLOON_FLIGHT_DURATION
    // so natural playback finish and the end event land on the same frame.
    bind(GAME_EVENT.BALLOON_ANIM_START, () => {
      void playBg(BG_TRACK_JAWS);
    });
    bind(GAME_EVENT.BALLOON_ANIM_END, () => {
      void stopBg(STOP_REASON_PHASE);
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
    if (deps.assetsReady) await deps.assetsReady;
    await ensureBgSynth();
    // Pre-render fanfares now (we're inside a user gesture and the bg
    // AudioContext is warm) so the first enclosure plays without latency.
    await prerenderFanfares();
  }

  async function suspendContext(context: AudioContext | null): Promise<void> {
    if (!context || context.state !== AUDIO_CONTEXT_RUNNING) return;
    await context.suspend().catch(() => {});
  }

  async function resumeContext(context: AudioContext | null): Promise<void> {
    if (!context || context.state !== AUDIO_CONTEXT_SUSPENDED) return;
    await context.resume().catch(() => {});
  }

  async function setPaused(nextPaused: boolean): Promise<void> {
    paused = nextPaused;
    const bgHandle = bgSynth ? await bgSynth.catch(() => undefined) : undefined;
    // Fanfares share the bg synth's AudioContext, so suspending it quiets
    // any in-flight AudioBufferSourceNodes alongside the bg track.
    if (nextPaused) await suspendContext(bgHandle?.audioContext ?? null);
    else await resumeContext(bgHandle?.audioContext ?? null);
    // Deferred start: if we were asked to play title while paused, kick it off
    // now that the tab is visible again.
    if (!nextPaused && wantsTitle && bgPlaying !== BG_TRACK_TITLE) {
      await playBg(BG_TRACK_TITLE);
    }
  }

  async function dispose(): Promise<void> {
    unbindCurrentBus();
    await stopBg(STOP_REASON_DISPOSE);
    wantsTitle = false;
    if (bgSynth) {
      const synth = await bgSynth.catch(() => undefined);
      await synth?.audioContext?.close().catch(() => {});
      bgSynth = undefined;
      bgLoaded = undefined;
    }
    // Fanfare AudioBuffers are tied to the bg synth's context; closing that
    // context above unbinds them. Just clear the map so a rematch
    // re-renders.
    fanfareBuffers.clear();
    fanfaresPrerendered = false;
    fanfaresPrerenderingPromise = undefined;
    smfCache.clear();
  }

  return {
    activate,
    startTitle: playTitle,
    stopTitle,
    playFanfare,
    subscribeBus,
    tickPresentation,
    setPaused,
    dispose,
  };
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  // AudioWorklet messaging transfers ownership — always hand over a copy so the
  // caller's view of MusicAssets (and the SMF cache) stays intact after postMessage.
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
