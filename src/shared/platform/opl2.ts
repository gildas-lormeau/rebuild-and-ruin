/**
 * OPL2 (Yamaha YM3812) 2-operator FM patch data and decoder.
 *
 * Pure data + decoding — the Web Audio renderer lives in
 * runtime/runtime-sound-opl.ts. Keeping synthesis out of this file means
 * headless/deno tests can inspect patches without an AudioContext.
 *
 * On-disk format follows Miles AIL AdLib banks (RAMPART.AD): 14 bytes
 * per instrument record, decoded per ScummVM audio/miles_adlib.cpp:1420-1483.
 */

/** One of the two operators in an OPL2 voice. */

export interface OplOperator {
  /** Amplitude modulation (tremolo) enable. */
  readonly tremolo: number;
  /** Vibrato enable. */
  readonly vib: number;
  /** Envelope-generator type: 1 = sustained, 0 = percussive. */
  readonly envType: number;
  /** Key-scale rate (envelope speeds up at higher pitches). */
  readonly ksr: number;
  /** Frequency multiplier applied to the note's base frequency. */
  readonly mult: number;
  /** Key-scale level (pitch-dependent attenuation). */
  readonly ksl: number;
  /** Total level (attenuation, 0-63; 0 = loudest). */
  readonly totalLevel: number;
  /** Attack rate 0-15 (15 = fastest). */
  readonly ar: number;
  /** Decay rate 0-15. */
  readonly dr: number;
  /** Sustain level 0-15 (0 = peak, 15 = near-silent). */
  readonly sustainLevel: number;
  /** Release rate 0-15. */
  readonly rr: number;
  /** Waveform index 0-3 (0 = sine, 1 = half-sine, 2 = abs-sine, 3 = quarter-sine). */
  readonly wave: number;
}

/** A decoded OPL2 instrument patch. */
export interface OplPatch {
  /** Semitones to transpose each note by (signed). */
  readonly transposition: number;
  /** Modulator operator (op1 in the YM3812 algorithm). */
  readonly op1: OplOperator;
  /** Carrier operator (op2). */
  readonly op2: OplOperator;
  /** Feedback level 0-7 (op1 self-modulation depth). */
  readonly feedback: number;
  /** Connection: 0 = FM (op1 modulates op2), 1 = additive (both play in parallel). */
  readonly cnt: number;
}

/** One chord/note event in a score. */
export interface OplNote {
  /** Time offset from the score's start in seconds. */
  readonly startSec: number;
  /** Note duration in seconds (before release tail). */
  readonly durationSec: number;
  /** MIDI note numbers played simultaneously (multiple = harmony). */
  readonly midiNotes: readonly number[];
  /** MIDI velocity 0-127. */
  readonly velocity: number;
}

/** Sequence of chord events. */
export type OplScore = readonly OplNote[];

/** Authoring form for a score row: [startMs, durMs, [midiNotes...], velocity]. */
type ScoreRow = readonly [number, number, readonly number[], number];

/** Expected instrument record size for Miles AIL .AD banks. */
const OPL_INSTRUMENT_SIZE = 14;
/**
 * XMI's native tick rate is 120 Hz (120 ticks/sec). The XMI→MIDI split
 * writes tempo=428571 μs/quarter with division=120, so SMF playback runs
 * 1000/428.571 ≈ 2.33× faster than the original AIL driver. Scale scores
 * authored from those MIDIs by this factor to match in-game playback speed.
 */
const XMI_SPEED_SCALE = 1000 / 428.571;
/** OPL2 MULT register lookup: raw 0-15 → frequency multiplier. */
const OPL_MULT: readonly number[] = [
  0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15,
];
/** Raw 14-byte record for bank 0 / program 96 from RAMPART.AD (tower-enclosure fanfare). */
const FANFARE_PATCH_BYTES: Uint8Array = new Uint8Array([
  0x0e, 0x00, 0x00, 0x21, 0x1b, 0x71, 0xa6, 0x00, 0x0e, 0x21, 0x00, 0xa1, 0x96,
  0x00,
]);
/** Attack time in ms for AR 0-15 (YM3812 datasheet, KSR=0). */
export const OPL_ATTACK_MS: readonly number[] = [
  Infinity,
  1386,
  867,
  641,
  491,
  367,
  275,
  205,
  151,
  113,
  85,
  63,
  48,
  35,
  27,
  1,
];
/** Decay/release time in ms for DR/RR 0-15 (full attenuation). */
export const OPL_DECAY_MS: readonly number[] = [
  Infinity,
  11176,
  8400,
  6140,
  4480,
  3360,
  2530,
  1870,
  1420,
  1090,
  820,
  620,
  450,
  350,
  260,
  200,
];
/** Sustain-level attenuation in dB for SL 0-15 (0 = 0 dB, 15 ≈ -93 dB). */
export const OPL_SUSTAIN_DB: readonly number[] = [
  0, -3, -6, -9, -12, -15, -18, -21, -24, -27, -30, -33, -36, -39, -42, -93,
];
/** Pre-decoded fanfare patch (module-load cost is paid once). */
export const FANFARE_PATCH: OplPatch = decodeOplPatch(FANFARE_PATCH_BYTES);
/** Fanfare variants indexed by player slot (0 = mid, 1 = high, 2 = low).
 *  Scores extracted from RXMI_TETRIS songs 5/6/7, two-voice harmony. */
export const FANFARE_SCORES: readonly OplScore[] = [
  buildScore([
    [0, 29, [75, 80], 127],
    [43, 32, [75, 80], 127],
    [89, 64, [75, 80], 127],
    [182, 64, [72, 75], 127],
    [275, 64, [68, 72], 127],
    [364, 64, [72, 75], 127],
    [457, 368, [80, 84], 127],
  ]),
  buildScore([
    [0, 29, [80, 84], 127],
    [43, 32, [80, 84], 127],
    [89, 64, [80, 84], 127],
    [182, 64, [75, 80], 127],
    [275, 64, [80, 84], 127],
    [364, 64, [75, 80], 127],
    [457, 368, [84, 87], 127],
  ]),
  buildScore([
    [0, 61, [63, 68], 127],
    [89, 32, [60, 68], 127],
    [136, 32, [63, 68], 127],
    [182, 64, [60, 63], 127],
    [275, 64, [63, 68], 127],
    [364, 368, [63, 72], 127],
  ]),
];

/**
 * Decode a 14-byte Miles AIL OPL2 instrument record.
 *
 * Byte layout (per ScummVM miles_adlib.cpp:1420-1483):
 *   [0..1] size (u16 LE, must be 14)
 *   [2]    transposition (signed)
 *   [3..7] op1 (modulator): regs 20, 40, 60, 80, E0
 *   [8]    regC0 feedback/connection
 *   [9..13] op2 (carrier): regs 20, 40, 60, 80, E0
 */
function decodeOplPatch(bytes: Uint8Array): OplPatch {
  const size = bytes[0]! | (bytes[1]! << 8);
  if (size !== OPL_INSTRUMENT_SIZE) {
    throw new Error(`unsupported OPL patch size ${size}`);
  }
  const regC0 = bytes[8]!;
  return {
    transposition: (bytes[2]! << 24) >> 24,
    op1: decodeOperator(bytes, 3),
    op2: decodeOperator(bytes, 9),
    feedback: (regC0 >> 1) & 7,
    cnt: regC0 & 1,
  };
}

function decodeOperator(bytes: Uint8Array, base: number): OplOperator {
  const reg20 = bytes[base]!;
  const reg40 = bytes[base + 1]!;
  const reg60 = bytes[base + 2]!;
  const reg80 = bytes[base + 3]!;
  const regE0 = bytes[base + 4]!;
  return {
    tremolo: (reg20 >> 7) & 1,
    vib: (reg20 >> 6) & 1,
    envType: (reg20 >> 5) & 1,
    ksr: (reg20 >> 4) & 1,
    mult: OPL_MULT[reg20 & 0xf]!,
    ksl: (reg40 >> 6) & 3,
    totalLevel: reg40 & 0x3f,
    ar: (reg60 >> 4) & 0xf,
    dr: reg60 & 0xf,
    sustainLevel: (reg80 >> 4) & 0xf,
    rr: reg80 & 0xf,
    wave: regE0 & 3,
  };
}

function buildScore(rows: readonly ScoreRow[]): OplScore {
  return rows.map(([startMs, durMs, midiNotes, velocity]) => ({
    startSec: (startMs * XMI_SPEED_SCALE) / 1000,
    durationSec: (durMs * XMI_SPEED_SCALE) / 1000,
    midiNotes,
    velocity,
  }));
}
