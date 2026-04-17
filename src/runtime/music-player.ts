/**
 * Music sub-system — libadlmidi-js-driven OPL3 playback of player-supplied
 * Rampart music files.
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
} from "../shared/core/game-event-bus.ts";
import type { MusicObserver } from "../shared/core/system-interfaces.ts";
import {
  xmiContainerBlocks,
  xmidToSmf,
} from "../shared/platform/xmi-to-smf.ts";
import type { MusicAssets } from "./music-assets.ts";
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
  /** Bind to the supplied game bus so PHASE_START=WALL_BUILD auto-stops the
   *  title track when the first castle goes down. Re-binding to a different
   *  bus (rematch) unbinds the previous one. */
  subscribeBus(bus: GameEventBus): void;
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

const TITLE_TRACK = "RXMI_TITLE.xmi";
const TITLE_SONG_INDEX = 0;

export function createMusicSubsystem(deps: MusicSubsystemDeps): MusicSubsystem {
  let synthPromise: Promise<SynthHandle> | undefined;
  let boundBus: GameEventBus | undefined;
  let boundHandler: GameEventHandler<"castlePlaced"> | undefined;
  // `wantsTitle` is the caller's intent (lobby said "play title"). `playing`
  // is the actual synth state. `paused` means the composition told us the
  // host tab is hidden / externally quieted — we honor wantsTitle but defer
  // the play call until un-paused.
  let wantsTitle = false;
  let playing = false;
  let paused = false;

  async function ensureSynth(): Promise<SynthHandle | undefined> {
    const assets = deps.getAssets();
    if (!assets) return undefined;
    if (!synthPromise) {
      synthPromise = (async () => {
        const loader = await import("./music-synth-loader.ts");
        return loader.loadSynth(assets);
      })().catch((error) => {
        console.error("[music] synth init failed:", error);
        synthPromise = undefined;
        deps.observer?.onInitError?.(error);
        throw error;
      });
    }
    try {
      return await synthPromise;
    } catch {
      return undefined;
    }
  }

  async function playTitle(): Promise<void> {
    wantsTitle = true;
    // Wait for the initial IDB read — the lobby's startTitle() can race ahead.
    if (deps.assetsReady) await deps.assetsReady;
    if (paused) return; // will start when setPaused(false) fires
    await startPlaybackNow();
  }

  async function startPlaybackNow(): Promise<void> {
    if (playing || !wantsTitle || paused) return;
    const assets = deps.getAssets();
    if (!assets) return;
    const synth = await ensureSynth();
    if (!synth || !wantsTitle || paused) return;
    try {
      // Convert XMI sub-song → SMF in memory before handing to libADLMIDI.
      // Its native XMI parser reorders same-tick note-offs and retriggers
      // percussion voices on the "wrong" cleanups, which is catastrophic for
      // drum-channel SFX (verified by `tmp/music-player/scripts/
      // render-and-compare.mjs`; SMF path produces bit-identical PCM to the
      // Python reference tool). Title = sub-song 0 of RXMI_TITLE.xmi.
      const blocks = xmiContainerBlocks(assets.xmi[TITLE_TRACK]);
      const smf = xmidToSmf(blocks[TITLE_SONG_INDEX]!.block);
      if (!smf) {
        console.error("[music] title sub-song has no EVNT chunk");
        return;
      }
      await synth.loadMidi(copyBuffer(smf));
      // Lobby can sit on the title screen indefinitely — loop the ~30s track
      // instead of dropping to silence. Must be set after loadMidi (the flag
      // applies to the currently loaded file).
      synth.setLoopEnabled(true);
      await logLoopInfo(synth);
      await synth.play();
      playing = true;
      deps.observer?.onPlay?.(TITLE_TRACK);
    } catch (error) {
      console.error("[music] startPlaybackNow failed:", error);
    }
  }

  async function stopPlayback(
    reason: "phase" | "rematch" | "dispose",
  ): Promise<void> {
    wantsTitle = false;
    playing = false;
    if (!synthPromise) return;
    try {
      const synth = await synthPromise;
      await synth.stop();
    } catch {
      // synth failed to init or is already gone — nothing to stop
    }
    deps.observer?.onStop?.(reason);
  }

  function unbindCurrentBus(): void {
    if (boundBus && boundHandler)
      boundBus.off(GAME_EVENT.CASTLE_PLACED, boundHandler);
    boundBus = undefined;
    boundHandler = undefined;
  }

  function subscribeBus(bus: GameEventBus): void {
    if (boundBus === bus) return;
    unbindCurrentBus();
    // Stop the title track the moment any player confirms their starting
    // castle. Ignore `isReselect` — after a mid-game castle reselect the
    // title isn't playing anyway.
    const handler: GameEventHandler<"castlePlaced"> = (event) => {
      if (!event.isReselect) void stopPlayback("phase");
    };
    bus.on(GAME_EVENT.CASTLE_PLACED, handler);
    boundBus = bus;
    boundHandler = handler;
  }

  async function activate(): Promise<void> {
    if (deps.assetsReady) await deps.assetsReady;
    await ensureSynth();
  }

  async function setPaused(nextPaused: boolean): Promise<void> {
    paused = nextPaused;
    const synth = synthPromise
      ? await synthPromise.catch(() => undefined)
      : undefined;
    const context = synth?.audioContext;
    if (context) {
      if (nextPaused && context.state === "running") await context.suspend();
      else if (!nextPaused && context.state === "suspended")
        await context.resume();
    }
    // Deferred start: if we were asked to play title while paused, kick it off
    // now that the tab is visible again.
    if (!nextPaused && wantsTitle && !playing) {
      await startPlaybackNow();
    }
  }

  async function dispose(): Promise<void> {
    unbindCurrentBus();
    await stopPlayback("dispose");
  }

  return {
    activate,
    startTitle: playTitle,
    stopTitle: () => stopPlayback("phase"),
    subscribeBus,
    setPaused,
    dispose,
  };
}

async function logLoopInfo(synth: SynthHandle): Promise<void> {
  try {
    const [start, end, title, markers, songs] = await Promise.all([
      synth.getLoopStartTime(),
      synth.getLoopEndTime(),
      synth.getMusicTitle(),
      synth.getMarkerCount(),
      synth.getSongsCount(),
    ]);
    const startStr = start < 0 ? "—" : `${start.toFixed(3)}s`;
    const endStr = end < 0 ? "—" : `${end.toFixed(3)}s`;
    console.log(
      `[music] title="${title}" songs=${songs} markers=${markers} loop=${startStr}→${endStr}`,
    );
  } catch (error) {
    console.warn("[music] loop info query failed:", error);
  }
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  // AudioWorklet messaging transfers ownership — always hand over a copy so the
  // caller's view of MusicAssets stays intact after postMessage.
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
