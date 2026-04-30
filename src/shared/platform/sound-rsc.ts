/**
 * Miles RSC bundle parser + Creative VOC → PCM converter for Rampart's
 * SOUND.RSC (37 digital-sample SFX: brick clunks, cannon shots, banner
 * whoosh, voice announcements, explosion variants, etc.). Sound Blaster
 * DSP samples, parallel to the OPL3/AdLib XMI tracks.
 *
 * Pure data transform — no DOM, audio, or IO. Safe at L1 leaf layer.
 *
 * RSC directory format (same bundle layout as RMUSIC.RSC): byte 0 holds the
 * chunk count; entries start at 0x14 and are 20 bytes each — 8-byte name
 * (NUL-padded), 4 bytes reserved, uint32 LE offset, uint32 LE size.
 *
 * VOC format:
 *   Header "Creative Voice File\x1A" + uint16 header_end + uint16 version + uint16 checksum.
 *   Then typed blocks until type=0 terminator:
 *     Block type 1 (sound data): byte divisor, byte codec, then raw samples.
 *       sampleRate = round(1_000_000 / (256 - divisor))
 *       codec 0 = unsigned 8-bit PCM (all Rampart uses)
 *     Block type 2: continuation of the previous type-1 block (same rate/codec).
 *     Other block types (silence, marker, text, repeat, extended info) are
 *     skipped — Rampart's SOUND.RSC doesn't use them.
 */

export interface PcmSample {
  readonly name: string;
  readonly sampleRate: number;
  /** Unsigned 8-bit mono PCM, one byte per sample. 128 = silence midpoint. */
  readonly pcm: Uint8Array;
}

export function parseSoundRsc(bytes: Uint8Array): PcmSample[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes[0] ?? 0;
  const samples: PcmSample[] = [];
  for (let i = 0; i < count; i += 1) {
    const dirOffset = 0x14 + i * 20;
    if (dirOffset + 20 > bytes.length) break;
    const name = readName(bytes, dirOffset);
    const chunkOffset = view.getUint32(dirOffset + 12, true);
    const chunkSize = view.getUint32(dirOffset + 16, true);
    if (chunkOffset + chunkSize > bytes.length) continue;
    const voc = bytes.subarray(chunkOffset, chunkOffset + chunkSize);
    const decoded = vocToPcm(voc);
    if (!decoded) continue;
    samples.push({ name, ...decoded });
  }
  return samples;
}

function vocToPcm(
  voc: Uint8Array,
): { sampleRate: number; pcm: Uint8Array } | null {
  if (!readAscii(voc, 0, 19).startsWith("Creative Voice File")) return null;
  const view = new DataView(voc.buffer, voc.byteOffset, voc.byteLength);
  const headerEnd = view.getUint16(20, true);
  let cursor = headerEnd;
  let sampleRate = 0;
  let codec = 0;
  const chunks: Uint8Array[] = [];
  while (cursor < voc.length) {
    const blockType = voc[cursor]!;
    if (blockType === 0) break;
    const blockSize =
      (voc[cursor + 1]! |
        (voc[cursor + 2]! << 8) |
        (voc[cursor + 3]! << 16)) >>>
      0;
    cursor += 4;
    const block = voc.subarray(cursor, cursor + blockSize);
    cursor += blockSize;
    if (blockType === 1) {
      const divisor = block[0]!;
      codec = block[1]!;
      sampleRate = divisor < 256 ? Math.round(1_000_000 / (256 - divisor)) : 0;
      chunks.push(block.subarray(2));
    } else if (blockType === 2) {
      chunks.push(block);
    }
  }
  if (chunks.length === 0 || codec !== 0 || sampleRate === 0) return null;
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const pcm = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(chunk, offset);
    offset += chunk.length;
  }
  return { sampleRate, pcm };
}

function readName(bytes: Uint8Array, offset: number): string {
  // SOUND.RSC directory entries have a fixed 8-byte name field.
  const NAME_LENGTH = 8;
  let end = offset;
  while (end < offset + NAME_LENGTH && bytes[end] !== 0) end += 1;
  return readAscii(bytes, offset, end - offset);
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1)
    out += String.fromCharCode(bytes[offset + i]!);
  return out;
}
