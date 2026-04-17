/**
 * Convert a Miles AIL AdLib bank (.AD) to a WOPL v3 bank in memory.
 *
 * Used by the music subsystem so the game can accept a player-supplied RAMP.AD
 * (from a legitimate Rampart DOS install) and hand libadlmidi-js the WOPL form
 * it can actually read. Pure data transform — no DOM, audio, or IO dependencies,
 * safe at leaf layer L1. Reference implementations and both format specs live in
 * tmp/music-player/docs/{ail-ad-format,wopl-format}.md. Python mirror:
 * tmp/music-player/scripts/ail-to-wopl.py (produces byte-identical output).
 *
 * The one non-obvious invariant that tripped us up for hours: WOPL's op1 slot
 * stores the CARRIER and op2 stores the MODULATOR — inverse of AIL's naming.
 * Flip them and brass patches sound like chaotic percussion.
 */

const MELODIC_TAGS = [0x00, 0x01, 0x02] as const;
const PERCUSSION_TAG = 0x7f;
/** YM3812/YMF262 decay/release durations in ms for rate 0-15 at KSR=0. */
const OPL_DECAY_MS: readonly number[] = [
  65535, 11176, 8400, 6140, 4480, 3360, 2530, 1870, 1420, 1090, 820, 620, 450,
  350, 260, 200,
];
/** YM3812/YMF262 attack durations in ms for rate 0-15 at KSR=0. */
const OPL_ATTACK_MS: readonly number[] = [
  65535, 1386, 867, 641, 491, 367, 275, 205, 151, 113, 85, 63, 48, 35, 27, 1,
];
/** Sustain-level attenuation in dB for SL 0-15 (0 = 0 dB, 15 ≈ -93 dB). */
const OPL_SUSTAIN_DB: readonly number[] = [
  0, -3, -6, -9, -12, -15, -18, -21, -24, -27, -30, -33, -36, -39, -42, -93,
];
/** Operator registers that produce silent output: TL=63, SL=15. */
const SILENCED_OP = Uint8Array.of(0x00, 0x3f, 0x00, 0xf0, 0x00);
const AIL_PATCH_SIZE = 14;
const AIL_HEADER_ENTRY_SIZE = 6;
const WOPL_HEADER_SIZE = 19;
const WOPL_BANK_META_SIZE = 34;
const WOPL_INSTRUMENT_SIZE = 66;
const WOPL_BLANK_FLAG = 0x04;
const WOPL_FIXED_NOTE_FLAG = 0x08;
const WOPL_DEEP_TREMOLO_VIBRATO = 0x03;
const BANK_SLOTS_PER_BANK = 128;

export function ailToWopl(ail: Uint8Array): Uint8Array {
  const melodic = new Map<number, (Uint8Array | null)[]>();
  for (const tag of MELODIC_TAGS) {
    melodic.set(
      tag,
      new Array<Uint8Array | null>(BANK_SLOTS_PER_BANK).fill(null),
    );
  }
  const percussion = new Array<Uint8Array | null>(BANK_SLOTS_PER_BANK).fill(
    null,
  );
  for (const { program, bankTag, patch } of parseAilHeader(ail)) {
    const instrument = convertPatch(patch, bankTag, program);
    if (bankTag === PERCUSSION_TAG) {
      if (program < BANK_SLOTS_PER_BANK) percussion[program] = instrument;
    } else {
      const bank = melodic.get(bankTag);
      if (bank && program < BANK_SLOTS_PER_BANK) bank[program] = instrument;
    }
  }

  const totalInstruments = (MELODIC_TAGS.length + 1) * BANK_SLOTS_PER_BANK;
  const totalSize =
    WOPL_HEADER_SIZE +
    (MELODIC_TAGS.length + 1) * WOPL_BANK_META_SIZE +
    totalInstruments * WOPL_INSTRUMENT_SIZE;
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  out.set(new TextEncoder().encode("WOPL3-BANK\0"), 0);
  view.setUint16(11, 3, true); // version, LE — every other multi-byte value in WOPL is BE
  view.setUint16(13, MELODIC_TAGS.length, false);
  view.setUint16(15, 1, false);
  out[17] = WOPL_DEEP_TREMOLO_VIBRATO;
  out[18] = 0; // volume model = auto — AIL banks should not force a specific curve

  let position = WOPL_HEADER_SIZE;
  for (let index = 0; index < MELODIC_TAGS.length; index++) {
    const tag = MELODIC_TAGS[index]!;
    const bank = melodic.get(tag)!;
    const filled = bank.reduce<number>(
      (accumulator, entry) => accumulator + (entry ? 1 : 0),
      0,
    );
    writeBankMeta(
      out,
      position,
      `Rampart melodic bank 0x${tag.toString(16).padStart(2, "0")} (${filled})`,
      index,
      0,
    );
    position += WOPL_BANK_META_SIZE;
  }
  const drumsFilled = percussion.reduce<number>(
    (accumulator, entry) => accumulator + (entry ? 1 : 0),
    0,
  );
  writeBankMeta(out, position, `Rampart drums (${drumsFilled})`, 0, 0);
  position += WOPL_BANK_META_SIZE;

  const blank = buildBlankInstrument();
  for (const tag of MELODIC_TAGS) {
    for (const instrument of melodic.get(tag)!) {
      out.set(instrument ?? blank, position);
      position += WOPL_INSTRUMENT_SIZE;
    }
  }
  for (const instrument of percussion) {
    out.set(instrument ?? blank, position);
    position += WOPL_INSTRUMENT_SIZE;
  }
  return out;
}

function* parseAilHeader(
  ail: Uint8Array,
): Generator<{ program: number; bankTag: number; patch: Uint8Array }> {
  const view = new DataView(ail.buffer, ail.byteOffset, ail.byteLength);
  const firstOffset = view.getUint32(2, true) & 0xffff;
  for (
    let position = 0;
    position < firstOffset;
    position += AIL_HEADER_ENTRY_SIZE
  ) {
    const program = ail[position];
    const bankTag = ail[position + 1];
    if (program === undefined || bankTag === undefined) return;
    if (program === 0xff && bankTag === 0xff) return;
    const offset = view.getUint32(position + 2, true);
    if (offset + AIL_PATCH_SIZE > ail.byteLength) return;
    const patch = ail.subarray(offset, offset + AIL_PATCH_SIZE);
    const size = patch[0]! | (patch[1]! << 8);
    if (size !== AIL_PATCH_SIZE) {
      throw new Error(
        `patch at 0x${offset.toString(16)} has size ${size}, expected ${AIL_PATCH_SIZE}`,
      );
    }
    yield { program, bankTag, patch };
  }
}

function convertPatch(
  patch: Uint8Array,
  bankTag: number,
  program: number,
): Uint8Array {
  const isDrum = bankTag === PERCUSSION_TAG;
  const transposition = (patch[2]! << 24) >> 24; // sign-extend int8
  const ailModulator = patch.subarray(3, 8);
  const regC0 = patch[8]!;
  const ailCarrier = patch.subarray(9, 14);

  const out = new Uint8Array(WOPL_INSTRUMENT_SIZE);
  const view = new DataView(out.buffer);
  const label = isDrum
    ? `drum_${String(program).padStart(3, "0")}`
    : `prog_${String(program).padStart(3, "0")}`;
  out.set(new TextEncoder().encode(label).slice(0, 32), 0);

  if (isDrum) {
    view.setInt16(32, 0, false);
    out[38] = transposition & 0xff;
    out[39] = WOPL_FIXED_NOTE_FLAG;
  } else {
    view.setInt16(32, transposition, false);
    out[38] = 0;
    out[39] = 0;
  }
  view.setInt16(34, 0, false);
  out[36] = 0;
  out[37] = 0;
  out[40] = regC0;
  out[41] = 0;
  // WOPL op1 slot = CARRIER, op2 slot = MODULATOR. Do NOT flip these.
  out.set(ailCarrier, 42);
  out.set(ailModulator, 47);
  out.set(SILENCED_OP, 52);
  out.set(SILENCED_OP, 57);

  const { delayOn, delayOff } = soundingDelays(ailCarrier, isDrum);
  view.setUint16(62, delayOn, false);
  view.setUint16(64, delayOff, false);
  return out;
}

function soundingDelays(
  carrierBytes: Uint8Array,
  isDrum: boolean,
): { delayOn: number; delayOff: number } {
  const reg20 = carrierBytes[0]!;
  const reg60 = carrierBytes[2]!;
  const reg80 = carrierBytes[3]!;
  const envelopeSustained = (reg20 >> 5) & 1;
  const attackRate = (reg60 >> 4) & 0xf;
  const decayRate = reg60 & 0xf;
  const sustainLevel = (reg80 >> 4) & 0xf;
  const releaseRate = reg80 & 0xf;

  let delayOn: number;
  if (envelopeSustained && !isDrum) {
    delayOn = 40000;
  } else {
    const decayTime = OPL_DECAY_MS[decayRate]!;
    const dbDrop = -OPL_SUSTAIN_DB[sustainLevel]!;
    const fraction = Math.min(1, dbDrop / 93);
    delayOn = Math.floor(OPL_ATTACK_MS[attackRate]! + decayTime * fraction);
    delayOn = Math.max(200, Math.min(delayOn, 10000));
  }
  let delayOff = OPL_DECAY_MS[releaseRate]!;
  delayOff = Math.max(50, Math.min(delayOff, 5000));
  return { delayOn, delayOff };
}

function writeBankMeta(
  out: Uint8Array,
  offset: number,
  name: string,
  lsb: number,
  msb: number,
): void {
  const encoded = new TextEncoder().encode(name).slice(0, 32);
  out.set(encoded, offset);
  out[offset + 32] = lsb;
  out[offset + 33] = msb;
}

function buildBlankInstrument(): Uint8Array {
  const record = new Uint8Array(WOPL_INSTRUMENT_SIZE);
  record.set(new TextEncoder().encode("blank"), 0);
  record[39] = WOPL_BLANK_FLAG;
  return record;
}
