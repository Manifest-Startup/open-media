import { sniffVideoContainer } from './postVideo';

/**
 * Reads a video's length and frame size from its own container while the file streams past, so the
 * Worker can store an upload (ADR 0041) without holding 100 MB in memory. MP4 and MOV keep these
 * in the `moov` box (at the start or the end of the file), WebM in its first few kilobytes. Only
 * those small parts are kept; the rest of the file is hashed and passed on untouched.
 */

export interface VideoInfo {
  durationSeconds?: number;
  width?: number;
  height?: number;
}

const maxMoovBytes = 16 * 1024 * 1024;
const webmHeadBytes = 2 * 1024 * 1024;

export class VideoInspector {
  readonly container: 'iso-bmff' | 'webm' | undefined;
  private total = 0;
  private readonly head: Uint8Array[] = [];
  private headLength = 0;
  // MP4/MOV top-level box scan.
  private nextBox = 0;
  private header: number[] = [];
  private capture?: { start: number; end: number; bytes: Uint8Array };
  private scanning = true;
  private found: VideoInfo = {};

  /** `first` is the start of the file (at least 12 bytes), used to tell the container apart. */
  constructor(first: Uint8Array) {
    this.container = sniffVideoContainer(first);
  }

  get bytesSeen(): number { return this.total; }

  push(chunk: Uint8Array): void {
    const start = this.total;
    const end = start + chunk.length;
    this.total = end;
    if (this.container === 'webm' && this.headLength < webmHeadBytes) {
      const part = chunk.subarray(0, webmHeadBytes - this.headLength);
      this.head.push(part.slice());
      this.headLength += part.length;
    }
    if (this.container !== 'iso-bmff' || !this.scanning) return;
    let position = start;
    while (position < end && this.scanning) {
      if (this.capture) {
        const until = Math.min(end, this.capture.end);
        this.capture.bytes.set(chunk.subarray(position - start, until - start), position - this.capture.start);
        position = until;
        if (position >= this.capture.end) {
          this.found = readMoov(this.capture.bytes);
          this.capture = undefined;
        }
        continue;
      }
      if (position < this.nextBox) { position = Math.min(end, this.nextBox); continue; }
      // Collect the box header (8 bytes, or 16 with a 64-bit size) across chunk boundaries.
      const wanted = this.header.length >= 8 && readUint32(Uint8Array.from(this.header), 0) === 1 ? 16 : 8;
      const take = Math.min(wanted - this.header.length, end - position);
      for (let index = 0; index < take; index += 1) this.header.push(chunk[position - start + index]);
      position += take;
      if (this.header.length < wanted) continue;
      const header = Uint8Array.from(this.header);
      let size = readUint32(header, 0);
      if (size === 1 && wanted === 8) continue; // Now read the 64-bit size.
      if (size === 1) size = readUint32(header, 8) * 2 ** 32 + readUint32(header, 12);
      const type = fourcc(header, 4);
      const boxStart = this.nextBox;
      this.header = [];
      if (size === 0) { this.scanning = false; break; } // The box runs to the end of the file; nothing follows.
      if (size < wanted) { this.scanning = false; break; } // Malformed: stop looking.
      this.nextBox = boxStart + size;
      if (type === 'moov' && size - wanted <= maxMoovBytes) {
        this.capture = { start: boxStart + wanted, end: boxStart + size, bytes: new Uint8Array(size - wanted) };
      }
    }
  }

  info(): VideoInfo {
    if (this.container === 'webm') return readWebmHead(concat(this.head, this.headLength));
    return this.found;
  }
}

/** Duration from `mvhd`, frame size from the first track whose `tkhd` has one (the video track). */
export function readMoov(moov: Uint8Array): VideoInfo {
  const info: VideoInfo = {};
  for (const box of boxes(moov, 0, moov.length)) {
    if (box.type === 'mvhd') {
      const version = moov[box.payload];
      const base = box.payload;
      const timescale = version === 1 ? readUint32(moov, base + 20) : readUint32(moov, base + 12);
      const duration = version === 1 ? readUint32(moov, base + 24) * 2 ** 32 + readUint32(moov, base + 28) : readUint32(moov, base + 16);
      if (timescale > 0 && duration > 0 && duration !== 0xffffffff) info.durationSeconds = duration / timescale;
    }
    if (box.type === 'trak' && info.width === undefined) {
      for (const inner of boxes(moov, box.payload, box.end)) {
        if (inner.type !== 'tkhd') continue;
        const version = moov[inner.payload];
        const matrix = inner.payload + (version === 1 ? 52 : 40);
        const sizeAt = inner.payload + (version === 1 ? 88 : 76);
        if (sizeAt + 8 > inner.end) continue;
        let width = Math.round(readUint32(moov, sizeAt) / 65536);
        let height = Math.round(readUint32(moov, sizeAt + 4) / 65536);
        if (width <= 0 || height <= 0) continue;
        // A 90° or 270° rotation (a, d = 0) shows the frame on its side: swap the sides.
        if (readUint32(moov, matrix) === 0 && readUint32(moov, matrix + 16) === 0) [width, height] = [height, width];
        info.width = width;
        info.height = height;
      }
    }
  }
  return info;
}

function* boxes(bytes: Uint8Array, start: number, end: number): Generator<{ type: string; payload: number; end: number }> {
  let offset = start;
  while (offset + 8 <= end) {
    let size = readUint32(bytes, offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return;
      size = readUint32(bytes, offset + 8) * 2 ** 32 + readUint32(bytes, offset + 12);
      header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) return;
    yield { type: fourcc(bytes, offset + 4), payload: offset + header, end: offset + size };
    offset += size;
  }
}

// WebM (Matroska EBML) element IDs.
const ebml = { segment: 0x18538067, info: 0x1549a966, timecodeScale: 0x2ad7b1, duration: 0x4489, tracks: 0x1654ae6b, trackEntry: 0xae, trackType: 0x83, video: 0xe0, pixelWidth: 0xb0, pixelHeight: 0xba, cluster: 0x1f43b675 };
const masters = new Set([ebml.segment, ebml.info, ebml.tracks, ebml.trackEntry, ebml.video]);

/** Duration (Info) and frame size (the first video TrackEntry) from the start of a WebM file. */
export function readWebmHead(bytes: Uint8Array): VideoInfo {
  let timecodeScale = 1_000_000;
  let duration: number | undefined;
  const info: VideoInfo = {};
  let entry: { type?: number; width?: number; height?: number } | undefined;
  const finishEntry = () => {
    if (entry && info.width === undefined && (entry.type === undefined || entry.type === 1) && entry.width && entry.height) {
      info.width = entry.width;
      info.height = entry.height;
    }
    entry = undefined;
  };
  const walk = (start: number, end: number, depth: number): boolean => {
    let offset = start;
    while (offset < end) {
      const id = readVint(bytes, offset, true);
      if (!id) return false;
      const size = readVint(bytes, offset + id.length, false);
      if (!size) return false;
      const payload = offset + id.length + size.length;
      const elementEnd = size.value < 0 ? end : Math.min(end, payload + size.value);
      if (id.value === ebml.cluster) return true; // Media starts here; the header is complete.
      if (masters.has(id.value) && depth < 6) {
        if (id.value === ebml.trackEntry) entry = {};
        if (walk(payload, elementEnd, depth + 1)) return true;
        if (id.value === ebml.trackEntry) finishEntry();
      } else if (payload + size.value <= bytes.length && size.value >= 0) {
        if (id.value === ebml.timecodeScale) timecodeScale = readUint(bytes, payload, size.value) || timecodeScale;
        if (id.value === ebml.duration) duration = readFloat(bytes, payload, size.value);
        if (entry && id.value === ebml.trackType) entry.type = readUint(bytes, payload, size.value);
        if (entry && id.value === ebml.pixelWidth) entry.width = readUint(bytes, payload, size.value);
        if (entry && id.value === ebml.pixelHeight) entry.height = readUint(bytes, payload, size.value);
      }
      if (size.value < 0) return false;
      offset = payload + size.value;
    }
    return false;
  };
  walk(0, bytes.length, 0);
  finishEntry();
  if (duration !== undefined && duration > 0) info.durationSeconds = (duration * timecodeScale) / 1e9;
  return info;
}

function readVint(bytes: Uint8Array, offset: number, keepMarker: boolean): { value: number; length: number } | undefined {
  if (offset >= bytes.length) return undefined;
  const first = bytes[offset];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
  if (length > 8 || offset + length > bytes.length) return undefined;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + bytes[offset + index];
    if (bytes[offset + index] !== 0xff) allOnes = false;
  }
  return { value: !keepMarker && allOnes ? -1 : value, length };
}

function readUint(bytes: Uint8Array, offset: number, length: number): number {
  let value = 0;
  for (let index = 0; index < Math.min(length, 8); index += 1) value = value * 256 + bytes[offset + index];
  return value;
}

function readFloat(bytes: Uint8Array, offset: number, length: number): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, length);
  if (length === 4) return view.getFloat32(0);
  if (length === 8) return view.getFloat64(0);
  return undefined;
}

function concat(parts: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}
