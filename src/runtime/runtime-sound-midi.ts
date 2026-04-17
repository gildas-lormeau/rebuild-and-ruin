/**
 * Pre-parsed phase-music → Web Audio renderer.
 *
 * Takes a PhaseMusic (tempo-resolved event array from
 * shared/platform/phase-music.ts) and schedules each event on the given
 * AudioContext:
 *   - ch10 note-ons  → RAMPART.AD OPL2 snare (via runtime-sound-opl.ts)
 *   - other note-ons → soundfont-player GM instrument looked up by the
 *     channel's most recent programChange
 *
 * All Rampart phase MIDIs only ever hit snare (MIDI note 38) on the
 * drum channel, so the drum path is hard-coded to one OPL2 patch.
 *
 * The entire song is scheduled up-front at start time. stop() cancels
 * any pending voices. Fire-and-forget — no per-frame driver loop.
 */

/// <reference path="../shared/platform/soundfont-player.d.ts" />

import Soundfont, { type SoundfontPlayer } from "soundfont-player";
import { decodeOplPatch, type OplPatch } from "../shared/platform/opl2.ts";
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
/** Snare-hit duration (seconds) for OPL2 drum rendering. */
const SNARE_HIT_SEC = 0.12;
/** Velocity scale for drum hits — drums hit on every beat and through
 *  the loud fanfare MASTER_SCALE they dominate the mix. Halve the
 *  perceived velocity so snares sit underneath the melody, not on top. */
const SNARE_VELOCITY_SCALE = 0.5;
/** Initial delay from ctx.currentTime so scheduling has headroom. */
const START_OFFSET_SEC = 0.05;
/** Lookahead window for loop scheduling (seconds) — schedule a new loop
 *  pass before the previous one runs out so there's no gap. */
const LOOP_LOOKAHEAD_SEC = 0.5;
/** RAMPART.AD bank 0x7F / note 38 — fixed-pitch snare patch. 14 bytes
 *  per Miles AIL format. Duplicated from the offset we extracted once
 *  rather than parsing RAMP.AD at runtime. */
const SNARE_PATCH_BYTES: Uint8Array = new Uint8Array([
  0x0e, 0x00, 0x3c, 0x2e, 0x00, 0xff, 0x0f, 0x00, 0x0e, 0x00, 0x18, 0xf6, 0x4c,
  0x00,
]);
const SNARE_PATCH: OplPatch = decodeOplPatch(SNARE_PATCH_BYTES);
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
  let activeNodes: ScheduledNode[] = [];
  let playRequestId = 0;

  function getMaster(ctx: AudioContext): GainNode {
    if (!masterGain) {
      masterGain = ctx.createGain();
      masterGain.gain.value = MIDI_MASTER_GAIN;
      masterGain.connect(ctx.destination);
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
        const snareFreq = midiToFreq(SNARE_PATCH.transposition);
        playOplNote(
          ctx,
          SNARE_PATCH,
          snareFreq,
          startTime,
          SNARE_HIT_SEC,
          event.vel * SNARE_VELOCITY_SCALE * volumeScale,
        );
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
