/**
 * Convert a Miles XMI (Miles Sound System) sub-song to a Standard MIDI File
 * in memory.
 *
 * Background: libADLMIDI has a native XMI parser, but it disagrees with Miles
 * AIL on same-tick note-off ordering — the library's queue re-fires percussion
 * voices when it processes the "wrong" note-off first, which comes out as
 * garbage noise on drum-channel SFX. Converting XMI → SMF up-front and feeding
 * libADLMIDI the SMF bytes sidesteps the bug entirely. TypeScript port of
 * `tmp/music-player/scripts/xmi-split.py`; `xmi-to-smf.js` in the prototype
 * produces byte-identical output (verified by
 * `tmp/music-player/scripts/diff-js-vs-python.mjs` across all 34 Rampart
 * sub-songs). Pure data transform — no DOM, audio, or IO.
 *
 * The XMI-specific transforms: (a) delay encoding sums bytes <0x80 where SMF
 * uses variable-length quantity; (b) XMI note-on carries an implicit note-off
 * duration after the velocity byte, which we schedule as an explicit 0x8n
 * event at `t + duration`; (c) XMI tempo metas are authoring metadata that
 * Miles AIL plays back at a fixed 120 Hz tick rate regardless, so we drop
 * them and inject a canonical 1_000_000 us/quarter + division 120 (matching
 * the Python reference).
 *
 * Same-tick note-off ordering MUST match Python's implicit tuple sort
 * (ascending tick, note, channel). Any other order causes libADLMIDI to play
 * the bytes differently.
 */

/** MIDI status-byte threshold (0x80). Bytes below this are running-status
 *  data; bytes at or above are the start of a new MIDI message. Also appears
 *  as the high bit in variable-length-quantity continuation bytes. */

interface XmiSubSongHandle {
  readonly index: number;
  /** Raw FORM-XMID block for this sub-song. */
  readonly block: Uint8Array;
}

const STATUS_BYTE_MASK = 0x80;
/** IFF chunk tag — opens XMI's FORM container and its nested FORM XMID/XDIR
 *  sub-forms. */
const FORM_TAG = "FORM";
/** IFF sub-form tag for a single XMI sub-song block (`FORM XMID`). */
const XMID_TAG = "XMID";

/**
 * Split a Miles XMI container into per-sub-song FORM-XMID blocks. Accepts
 * both FORM-XDIR + CAT multi-song containers and bare single-song FORM-XMID.
 */
export function xmiContainerBlocks(data: Uint8Array): XmiSubSongHandle[] {
  if (readTag(data, 0) !== FORM_TAG)
    throw new Error("not an XMI container: missing FORM at 0");
  const formLen = readU32BE(data, 4);
  const formType = readTag(data, 8);
  if (formType === XMID_TAG) {
    return [{ index: 0, block: data.subarray(0, 8 + formLen + (formLen & 1)) }];
  }
  if (formType !== "XDIR")
    throw new Error(`unexpected top FORM type: ${formType}`);
  const pos = 8 + formLen + (formLen & 1);
  if (readTag(data, pos) !== "CAT ")
    throw new Error(`expected CAT at 0x${pos.toString(16)}`);
  const catLen = readU32BE(data, pos + 4);
  const catPayload = data.subarray(pos + 8, pos + 8 + catLen);
  if (readTag(catPayload, 0) !== XMID_TAG)
    throw new Error(`expected XMID after CAT, got ${readTag(catPayload, 0)}`);
  const blocks: XmiSubSongHandle[] = [];
  let sub = 4;
  while (sub < catLen) {
    if (readTag(catPayload, sub) !== FORM_TAG) break;
    const subLen = readU32BE(catPayload, sub + 4);
    blocks.push({
      index: blocks.length,
      block: catPayload.subarray(sub, sub + 8 + subLen),
    });
    sub += 8 + subLen;
    if (subLen & 1) sub += 1;
  }
  return blocks;
}

/**
 * Convert one FORM-XMID block to a single-track SMF. Returns `null` if the
 * block has no EVNT chunk (a rare padding entry seen in some containers).
 */
export function xmidToSmf(xmid: Uint8Array, division = 120): Uint8Array | null {
  if (readTag(xmid, 0) !== FORM_TAG || readTag(xmid, 8) !== XMID_TAG)
    throw new Error("not a FORM XMID block");
  const formLen = readU32BE(xmid, 4);
  const end = 8 + formLen;
  let pos = 12;
  let evnt: Uint8Array | undefined;
  while (pos < end) {
    const cid = readTag(xmid, pos);
    const clen = readU32BE(xmid, pos + 4);
    if (cid === "EVNT") {
      evnt = xmid.subarray(pos + 8, pos + 8 + clen);
      break;
    }
    pos += 8 + clen;
    if (clen & 1) pos += 1;
  }
  if (!evnt) return null;

  interface OffEvent {
    t: number;
    note: number;
    channel: number;
  }

  type Event = [absTick: number, secondaryKey: number, bytes: Uint8Array];

  const events: Event[] = [];
  const pendingOffs: OffEvent[] = [];
  let cursor = 0;
  let t = 0;
  while (cursor < evnt.length) {
    let delay = 0;
    while (cursor < evnt.length && evnt[cursor]! < STATUS_BYTE_MASK) {
      delay += evnt[cursor]!;
      cursor += 1;
    }
    t += delay;
    // Same-tick note-off ordering must match Python's list.sort on tuples:
    // primary key tick, secondary note, tertiary channel. Any other order
    // causes libADLMIDI to re-fire percussion voices on duplicate cleanups.
    pendingOffs.sort(
      (a, b) => a.t - b.t || a.note - b.note || a.channel - b.channel,
    );
    while (pendingOffs.length > 0 && pendingOffs[0]!.t <= t) {
      const off = pendingOffs.shift()!;
      events.push([
        off.t,
        1,
        new Uint8Array([0x80 | off.channel, off.note, 0x40]),
      ]);
    }
    if (cursor >= evnt.length) break;
    const status = evnt[cursor]!;
    cursor += 1;
    if (status >= STATUS_BYTE_MASK && status <= 0xef) {
      const hi = status & 0xf0;
      if (hi === 0x90) {
        const note = evnt[cursor]!;
        cursor += 1;
        const vel = evnt[cursor]!;
        cursor += 1;
        const [dur, nextCursor] = readMidiVarlen(evnt, cursor);
        cursor = nextCursor;
        events.push([t, 0, new Uint8Array([status, note, vel])]);
        pendingOffs.push({ t: t + dur, note, channel: status & 0x0f });
      } else if (hi === 0xc0 || hi === 0xd0) {
        const b1 = evnt[cursor]!;
        cursor += 1;
        events.push([t, 0, new Uint8Array([status, b1])]);
      } else {
        const b1 = evnt[cursor]!;
        cursor += 1;
        const b2 = evnt[cursor]!;
        cursor += 1;
        events.push([t, 0, new Uint8Array([status, b1, b2])]);
      }
    } else if (status === 0xff) {
      const meta = evnt[cursor]!;
      cursor += 1;
      const [mlen, nextCursor] = readMidiVarlen(evnt, cursor);
      cursor = nextCursor;
      const payload = evnt.subarray(cursor, cursor + mlen);
      cursor += mlen;
      // XMI tempo metas are authoring metadata; Miles AIL plays XMI at a
      // fixed 120 Hz tick rate regardless, so drop them here and inject a
      // canonical tempo below.
      if (meta === 0x51) continue;
      const prefix = new Uint8Array([0xff, meta]);
      const lenBytes = varlen(mlen);
      const merged = new Uint8Array(prefix.length + lenBytes.length + mlen);
      merged.set(prefix, 0);
      merged.set(lenBytes, prefix.length);
      merged.set(payload, prefix.length + lenBytes.length);
      events.push([t, 0, merged]);
    } else if (status === 0xf0 || status === 0xf7) {
      const [mlen, nextCursor] = readMidiVarlen(evnt, cursor);
      cursor = nextCursor;
      const payload = evnt.subarray(cursor, cursor + mlen);
      cursor += mlen;
      const prefix = new Uint8Array([status]);
      const lenBytes = varlen(mlen);
      const merged = new Uint8Array(prefix.length + lenBytes.length + mlen);
      merged.set(prefix, 0);
      merged.set(lenBytes, prefix.length);
      merged.set(payload, prefix.length + lenBytes.length);
      events.push([t, 0, merged]);
    } else {
      break;
    }
  }

  for (const off of pendingOffs) {
    events.push([
      off.t,
      1,
      new Uint8Array([0x80 | off.channel, off.note, 0x40]),
    ]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const track: number[] = [];
  // Canonical XMI tempo: 1_000_000 us/quarter with division=120 → 120 Hz.
  pushBytes(track, varlen(0));
  pushBytes(track, new Uint8Array([0xff, 0x51, 0x03, 0x0f, 0x42, 0x40]));
  let prev = 0;
  for (const [absTick, , bytes] of events) {
    pushBytes(track, varlen(absTick - prev));
    pushBytes(track, bytes);
    prev = absTick;
  }
  pushBytes(track, varlen(0));
  pushBytes(track, new Uint8Array([0xff, 0x2f, 0x00]));

  const trackBytes = Uint8Array.from(track);
  const mthd = new Uint8Array(14);
  mthd.set([0x4d, 0x54, 0x68, 0x64], 0);
  writeU32BE(mthd, 4, 6);
  writeU16BE(mthd, 8, 0); // format 0
  writeU16BE(mthd, 10, 1); // 1 track
  writeU16BE(mthd, 12, division);

  const mtrk = new Uint8Array(8 + trackBytes.length);
  mtrk.set([0x4d, 0x54, 0x72, 0x6b], 0);
  writeU32BE(mtrk, 4, trackBytes.length);
  mtrk.set(trackBytes, 8);

  const out = new Uint8Array(mthd.length + mtrk.length);
  out.set(mthd, 0);
  out.set(mtrk, mthd.length);
  return out;
}

function readTag(buf: Uint8Array, offset: number): string {
  if (offset + 4 > buf.length) return "";
  return String.fromCharCode(
    buf[offset]!,
    buf[offset + 1]!,
    buf[offset + 2]!,
    buf[offset + 3]!,
  );
}

function readU32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset]! << 24) |
      (buf[offset + 1]! << 16) |
      (buf[offset + 2]! << 8) |
      buf[offset + 3]!) >>>
    0
  );
}

function writeU32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function writeU16BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 8) & 0xff;
  buf[offset + 1] = value & 0xff;
}

function readMidiVarlen(buf: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let cursor = offset;
  while (cursor < buf.length) {
    const byte = buf[cursor]!;
    cursor += 1;
    value = (value << 7) | (byte & 0x7f);
    if ((byte & STATUS_BYTE_MASK) === 0) break;
  }
  return [value, cursor];
}

function varlen(value: number): Uint8Array {
  if (value === 0) return new Uint8Array([0]);
  const buf: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    buf.push(remaining & 0x7f);
    remaining >>>= 7;
  }
  buf.reverse();
  for (let i = 0; i < buf.length - 1; i += 1) buf[i]! |= STATUS_BYTE_MASK;
  return Uint8Array.from(buf);
}

function pushBytes(target: number[], bytes: Uint8Array): void {
  for (const byte of bytes) target.push(byte);
}
