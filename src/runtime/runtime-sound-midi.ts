/**
 * MIDI → soundfont-player renderer for Rampart's phase music.
 *
 * Pipeline:
 *   Uint8Array (inlined via shared/platform/phase-music.ts) →
 *   parseMidiEvents (in-file, no deps) →
 *   for each noteOn:
 *     - ch9 (drums) → schedule via playOplNote + OPL2 snare patch
 *     - else       → Soundfont.instrument(program).play(note, time)
 *
 * All MIDIs in this game use only snare (note 38) on the drum channel,
 * so we reuse the pre-decoded OPL2 snare from RAMPART.AD bank 0x7F.
 *
 * Runtime is fully async: loadAndPlay() fetches MIDI + all needed
 * instruments, then schedules the entire song up front. stop() cancels
 * everything. This is a fire-and-forget pattern that matches phase
 * transitions (which stop any prior music on entry to a new phase).
 */

/// <reference path="../shared/platform/soundfont-player.d.ts" />

import Soundfont, { type SoundfontPlayer } from "soundfont-player";
import { decodeOplPatch, type OplPatch } from "../shared/platform/opl2.ts";
import { playOplNote } from "./runtime-sound-opl.ts";

interface MidiEvent {
  readonly tick: number;
  readonly kind: "noteOn" | "pc" | "tempo";
  readonly ch?: number;
  readonly note?: number;
  readonly vel?: number;
  readonly durTicks?: number;
  readonly program?: number;
  readonly value?: number;
}

interface ParsedMidi {
  readonly div: number;
  readonly events: readonly MidiEvent[];
  readonly totalTicks: number;
}

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
  /** Parse a MIDI blob and start playing immediately. Any currently
   *  playing song is stopped first. Returns once scheduling is complete
   *  (instruments may still be streaming in the background). */
  startPhaseMusic(midi: Uint8Array, opts?: PhaseMusicOpts): Promise<void>;
  /** Stop any currently playing song. */
  stopPhaseMusic(): void;
}

/** MIDI → frequency reference (A4 = 440 Hz, MIDI note 69). */
const MIDI_A4_HZ = 440;
const MIDI_A4_NOTE = 69;
const SEMITONES_PER_OCTAVE = 12;
/** MIDI velocity max — used to normalize velocity to 0..1. */
const MIDI_VELOCITY_MAX = 127;
/** Default MIDI tempo (μs per quarter note). */
const DEFAULT_TEMPO_US = 1_000_000;
/** MIDI drum channel (ch 10 in 1-indexed conventional MIDI). */
const DRUM_CHANNEL = 9;
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
    parsed: ParsedMidi,
    t0: number,
    volumeScale: number,
  ): number {
    const chProgram = new Array(16).fill(0);
    let currentTempo = DEFAULT_TEMPO_US;
    let tickSec = currentTempo / 1_000_000 / parsed.div;
    let lastTick = 0;
    let clockSec = 0;

    for (const midiEvent of parsed.events) {
      clockSec += (midiEvent.tick - lastTick) * tickSec;
      lastTick = midiEvent.tick;
      if (midiEvent.kind === "tempo") {
        currentTempo = midiEvent.value!;
        tickSec = currentTempo / 1_000_000 / parsed.div;
      } else if (midiEvent.kind === "pc") {
        chProgram[midiEvent.ch!] = midiEvent.program!;
      } else if (midiEvent.kind === "noteOn") {
        const startTime = t0 + clockSec;
        if (midiEvent.ch === DRUM_CHANNEL) {
          const snareFreq = midiToFreq(SNARE_PATCH.transposition);
          playOplNote(
            ctx,
            SNARE_PATCH,
            snareFreq,
            startTime,
            SNARE_HIT_SEC,
            midiEvent.vel! * SNARE_VELOCITY_SCALE * volumeScale,
          );
        } else {
          const inst = instrumentCache.get(chProgram[midiEvent.ch!]);
          if (inst) {
            const node = inst.play(midiEvent.note!, startTime, {
              duration: midiEvent.durTicks! * tickSec,
              gain: (midiEvent.vel! / MIDI_VELOCITY_MAX) * volumeScale,
            });
            activeNodes.push(node);
          }
        }
      }
    }
    return clockSec + (parsed.totalTicks - lastTick) * tickSec;
  }

  async function startPhaseMusic(
    midi: Uint8Array,
    opts: PhaseMusicOpts = {},
  ): Promise<void> {
    stopInternal();
    const requestId = ++playRequestId;
    const ctx = getCtx();
    ctx.resume().catch(() => {});
    const volumeScale = opts.volumeScale ?? 1;

    const parsed = parseMidiEvents(midi);

    const programs = new Set<number>([0]);
    for (const midiEvent of parsed.events) {
      if (midiEvent.kind === "pc") programs.add(midiEvent.program!);
    }
    await Promise.all(
      [...programs].map((program) => ensureInstrument(ctx, program)),
    );
    if (requestId !== playRequestId) return;

    const t0 = ctx.currentTime + START_OFFSET_SEC;
    const songDur = scheduleOnce(ctx, parsed, t0, volumeScale);

    if (opts.loop) {
      const loopSchedule = (nextStart: number) => {
        if (requestId !== playRequestId) return;
        activeNodes.push({
          stop: () => {
            /* loop cancel marker */
          },
        });
        const timer = self.setTimeout(
          () => {
            if (requestId !== playRequestId) return;
            const nextEnd = scheduleOnce(ctx, parsed, nextStart, volumeScale);
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

function parseMidiEvents(data: Uint8Array): ParsedMidi {
  const div = (data[12]! << 8) | data[13]!;
  let index = 22; // skip MThd(14) + MTrk header(8)
  let running = 0;
  let ticks = 0;
  const events: MidiEvent[] = [];
  const pendingOff = new Map<string, { startTick: number; vel: number }>();

  while (index < data.length) {
    let delta = 0;
    while (index < data.length) {
      const byte = data[index++]!;
      delta = (delta << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    ticks += delta;
    if (index >= data.length) break;
    let status = data[index]!;
    if (status < 0x80) {
      status = running;
    } else {
      running = status;
      index++;
    }
    if (status === 0xff) {
      const meta = data[index++]!;
      let metaLen = 0;
      while (index < data.length) {
        const byte = data[index++]!;
        metaLen = (metaLen << 7) | (byte & 0x7f);
        if (!(byte & 0x80)) break;
      }
      if (meta === 0x51 && metaLen === 3) {
        const value =
          (data[index]! << 16) | (data[index + 1]! << 8) | data[index + 2]!;
        events.push({ tick: ticks, kind: "tempo", value });
      }
      index += metaLen;
      if (meta === 0x2f) break;
    } else if (status >= 0x90 && status <= 0x9f) {
      const note = data[index]!;
      const vel = data[index + 1]!;
      const ch = status & 0xf;
      index += 2;
      if (vel > 0) {
        pendingOff.set(`${ch}:${note}`, { startTick: ticks, vel });
      } else {
        flushNoteOff(events, pendingOff, ch, note, ticks);
      }
    } else if (status >= 0x80 && status <= 0x8f) {
      const note = data[index]!;
      const ch = status & 0xf;
      index += 2;
      flushNoteOff(events, pendingOff, ch, note, ticks);
    } else if (status >= 0xa0 && status <= 0xbf) {
      index += 2;
    } else if (status >= 0xe0 && status <= 0xef) {
      index += 2;
    } else if (status >= 0xc0 && status <= 0xcf) {
      const program = data[index++]!;
      events.push({ tick: ticks, kind: "pc", ch: status & 0xf, program });
    } else if (status >= 0xd0 && status <= 0xdf) {
      index += 1;
    }
  }

  events.sort((first, second) => first.tick - second.tick);
  return { div, events, totalTicks: ticks };
}

function flushNoteOff(
  events: MidiEvent[],
  pending: Map<string, { startTick: number; vel: number }>,
  ch: number,
  note: number,
  ticks: number,
): void {
  const key = `${ch}:${note}`;
  const ref = pending.get(key);
  if (!ref) return;
  events.push({
    tick: ref.startTick,
    kind: "noteOn",
    ch,
    note,
    vel: ref.vel,
    durTicks: ticks - ref.startTick,
  });
  pending.delete(key);
}
