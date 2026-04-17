/**
 * Pre-parsed phase-music → Web Audio renderer.
 *
 * Takes a PhaseMusic (tempo-resolved event array from
 * shared/platform/phase-music.ts) and schedules each event on the given
 * AudioContext:
 *   - ch10 note-ons  → RAMPART.AD bank-0 OPL2 patch selected by the
 *     channel's most recent programChange (each Rampart song picks a
 *     different melodic patch to carry its percussive line)
 *   - other note-ons → soundfont-player GM instrument looked up by the
 *     channel's most recent programChange
 *
 * The entire song is scheduled up-front at start time. stop() cancels
 * any pending voices. Fire-and-forget — no per-frame driver loop.
 */

/// <reference path="../shared/platform/soundfont-player.d.ts" />

import Soundfont, { type SoundfontPlayer } from "soundfont-player";
import { CH10_PATCHES } from "../shared/platform/opl2.ts";
import type { PhaseMusic } from "../shared/platform/phase-music.ts";
import { playOplNote } from "./runtime-sound-opl.ts";

interface ScheduledNode {
  stop(when?: number): void;
}

export interface PhaseMusicOpts {
  readonly loop?: boolean;
  /** Per-phase gain multiplier on top of MIDI_MASTER_GAIN. Needed
   *  because MusyngKite instruments have very different natural
   *  loudness (music_box ~0.2 peak, cello ~0.8 peak). Default 1.0. */
  readonly volumeScale?: number;
}

export interface MidiMusicPlayer {
  /** Schedule a pre-parsed song and start playing immediately. Any
   *  currently playing song is stopped first. Returns once scheduling
   *  is complete (instruments may still be streaming in the background). */
  startPhaseMusic(song: PhaseMusic, opts?: PhaseMusicOpts): Promise<void>;
  /** Stop any currently playing song. */
  stopPhaseMusic(): void;
}

/** MIDI → frequency reference (A4 = 440 Hz, MIDI note 69). */
const MIDI_A4_HZ = 440;
const MIDI_A4_NOTE = 69;
const SEMITONES_PER_OCTAVE = 12;
/** MIDI velocity max — used to normalize velocity to 0..1. */
const MIDI_VELOCITY_MAX = 127;
/** GM drum channel (1-indexed in phase-music.ts event data). */
const DRUM_CHANNEL = 10;
/** Master gain baseline for all MIDI music. MusyngKite samples have
 *  wildly different natural loudness per instrument (music box is quiet,
 *  cello is LOUD), so a single gain can't balance them. The master here
 *  is conservative — per-phase compensation lives in the volumeScale
 *  arg passed to startPhaseMusic (see runtime-phase-ticks.ts PHASE_MUSIC). */
const MIDI_MASTER_GAIN = 1;
/** Initial delay from ctx.currentTime so scheduling has headroom. */
const START_OFFSET_SEC = 0.05;
/** Lookahead window for loop scheduling (seconds) — schedule a new loop
 *  pass before the previous one runs out so there's no gap. */
const LOOP_LOOKAHEAD_SEC = 0.5;
/** General MIDI program → soundfont-player instrument name (MusyngKite).
 *  Covers programs actually referenced by Rampart's phase MIDIs; callers
 *  that hit an unmapped program fall back to acoustic_grand_piano. */
const GM_INSTRUMENT: Record<number, string> = {
  0: "acoustic_grand_piano",
  6: "harpsichord",
  8: "celesta",
  10: "music_box",
  17: "percussive_organ",
  19: "church_organ",
  20: "reed_organ",
  24: "acoustic_guitar_nylon",
  28: "electric_guitar_muted",
  40: "violin",
  74: "recorder",
  75: "pan_flute",
  76: "blown_bottle",
  88: "pad_1_new_age",
  89: "pad_2_warm",
  91: "pad_4_choir",
  // p93 in RAMP.AD is the low bass ostinato used for the "Jaws" battle
  // stinger (RXMI_BATTLE_song07). GM's Pad 6 metallic is nothing like
  // that — route to cello instead so the menace sits right.
  93: "cello",
  94: "pad_7_halo",
  96: "fx_1_rain",
  112: "tinkle_bell",
  115: "woodblock",
  118: "synth_drum",
};

export function createMidiMusicPlayer(
  getCtx: () => AudioContext,
): MidiMusicPlayer {
  const instrumentCache = new Map<number, SoundfontPlayer>();
  let masterGain: GainNode | undefined;
  let masterConnected = false;
  let activeNodes: ScheduledNode[] = [];
  let playRequestId = 0;

  /** The master gain that both soundfont-player samples and OPL2 drum
   *  hits feed into. Disconnecting it on stop silences every voice
   *  that was scheduled ahead of time — including Web Audio oscillators
   *  we have no direct stop-handle for. */
  function getMaster(ctx: AudioContext): GainNode {
    if (!masterGain) {
      masterGain = ctx.createGain();
      masterGain.gain.value = MIDI_MASTER_GAIN;
    }
    if (!masterConnected) {
      masterGain.connect(ctx.destination);
      masterConnected = true;
    }
    return masterGain;
  }

  async function ensureInstrument(
    ctx: AudioContext,
    program: number,
  ): Promise<SoundfontPlayer> {
    const cached = instrumentCache.get(program);
    if (cached) return cached;
    const name = GM_INSTRUMENT[program] ?? "acoustic_grand_piano";
    const inst = await Soundfont.instrument(ctx, name, {
      destination: getMaster(ctx),
      soundfont: "MusyngKite",
    });
    instrumentCache.set(program, inst);
    return inst;
  }

  function stopInternal(): void {
    for (const node of activeNodes) {
      try {
        node.stop();
      } catch {
        // Node may already have stopped.
      }
    }
    activeNodes = [];
    // Pre-scheduled OPL2 drum oscillators and any soundfont-player
    // voices that didn't respond to .stop() are still live in the
    // graph. Cutting masterGain → destination silences all of them.
    if (masterGain && masterConnected) {
      masterGain.disconnect();
      masterConnected = false;
    }
  }

  function scheduleOnce(
    ctx: AudioContext,
    song: PhaseMusic,
    t0: number,
    volumeScale: number,
  ): number {
    const chProgram = new Array(17).fill(0); // 1-indexed channels 1-16
    for (const event of song.events) {
      const startTime = t0 + event.t / 1000;
      if ("program" in event) {
        chProgram[event.ch] = event.program;
      } else if (event.ch === DRUM_CHANNEL) {
        // Rampart songs use ch10 melodically, not as a GM drum kit: each
        // song's program change on ch10 selects a distinct RAMP.AD bank-0
        // patch. Render the note at its actual pitch through straight FM.
        const patch = CH10_PATCHES[chProgram[event.ch]];
        if (patch) {
          const freq = midiToFreq(event.note + patch.transposition);
          playOplNote(
            ctx,
            patch,
            freq,
            startTime,
            event.dur / 1000,
            event.vel * volumeScale,
            getMaster(ctx),
            activeNodes,
          );
        }
      } else {
        const inst = instrumentCache.get(chProgram[event.ch]);
        if (inst) {
          const node = inst.play(event.note, startTime, {
            duration: event.dur / 1000,
            gain: (event.vel / MIDI_VELOCITY_MAX) * volumeScale,
          });
          activeNodes.push(node);
        }
      }
    }
    return song.durationMs / 1000;
  }

  async function startPhaseMusic(
    song: PhaseMusic,
    opts: PhaseMusicOpts = {},
  ): Promise<void> {
    stopInternal();
    const requestId = ++playRequestId;
    const ctx = getCtx();
    ctx.resume().catch(() => {});
    const volumeScale = opts.volumeScale ?? 1;

    const programs = new Set<number>([0]);
    for (const event of song.events) {
      if ("program" in event) programs.add(event.program);
    }
    await Promise.all(
      [...programs].map((program) => ensureInstrument(ctx, program)),
    );
    if (requestId !== playRequestId) return;

    const t0 = ctx.currentTime + START_OFFSET_SEC;
    const songDur = scheduleOnce(ctx, song, t0, volumeScale);

    if (opts.loop) {
      const loopSchedule = (nextStart: number) => {
        if (requestId !== playRequestId) return;
        const timer = self.setTimeout(
          () => {
            if (requestId !== playRequestId) return;
            const nextEnd = scheduleOnce(ctx, song, nextStart, volumeScale);
            const wait = Math.max(0, nextEnd - LOOP_LOOKAHEAD_SEC) * 1000;
            self.setTimeout(() => loopSchedule(nextStart + nextEnd), wait);
          },
          Math.max(
            0,
            (nextStart - ctx.currentTime - LOOP_LOOKAHEAD_SEC) * 1000,
          ),
        );
        activeNodes.push({ stop: () => self.clearTimeout(timer) });
      };
      loopSchedule(t0 + songDur);
    }
  }

  function stopPhaseMusic(): void {
    playRequestId++;
    stopInternal();
  }

  return { startPhaseMusic, stopPhaseMusic };
}

function midiToFreq(note: number): number {
  return MIDI_A4_HZ * 2 ** ((note - MIDI_A4_NOTE) / SEMITONES_PER_OCTAVE);
}
