import assert from 'node:assert/strict';
import test from 'node:test';

import { readWebmHead, VideoInspector } from './videoInfo';

const u32 = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const box = (type: string, payload: number[]) => [...u32(payload.length + 8), ...[...type].map((char) => char.charCodeAt(0)), ...payload];
const identity = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].flatMap(u32);
const rotated = [0, 0x10000, 0, -0x10000 >>> 0, 0, 0, 0, 0, 0x40000000].flatMap(u32);
const mvhd = (timescale: number, duration: number) => box('mvhd', [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(timescale), ...u32(duration), ...new Array(80).fill(0)]);
const tkhd = (width: number, height: number, matrix = identity) => box('tkhd', [0, 0, 0, 3, ...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(0), ...new Array(8).fill(0), 0, 0, 0, 0, 0, 0, 0, 0, ...matrix, ...u32(width * 65536), ...u32(height * 65536)]);

function mp4(options: { moovFirst: boolean; matrix?: number[] }) {
  const ftyp = box('ftyp', [...'isom'].map((c) => c.charCodeAt(0)).concat(u32(512), [...'isommp42'].map((c) => c.charCodeAt(0))));
  const moov = box('moov', [...mvhd(1000, 8000), ...box('trak', tkhd(0, 0)), ...box('trak', tkhd(720, 1280, options.matrix))]);
  const mdat = box('mdat', new Array(5000).fill(7));
  return Uint8Array.from(options.moovFirst ? [...ftyp, ...moov, ...mdat] : [...ftyp, ...mdat, ...moov]);
}

function inspect(bytes: Uint8Array, chunk: number) {
  const inspector = new VideoInspector(bytes.subarray(0, 12));
  for (let offset = 0; offset < bytes.length; offset += chunk) inspector.push(bytes.subarray(offset, offset + chunk));
  return { container: inspector.container, info: inspector.info(), seen: inspector.bytesSeen };
}

test('MP4 length and size are read whether moov comes first or last, in any chunking', () => {
  for (const moovFirst of [true, false]) {
    const bytes = mp4({ moovFirst });
    for (const chunk of [1, 7, 64, 4096, bytes.length]) {
      const result = inspect(bytes, chunk);
      assert.equal(result.container, 'iso-bmff');
      assert.deepEqual(result.info, { durationSeconds: 8, width: 720, height: 1280 }, `moovFirst=${moovFirst} chunk=${chunk}`);
      assert.equal(result.seen, bytes.length);
    }
  }
});

test('a phone video recorded on its side reports the size it is shown at', () => {
  assert.deepEqual(inspect(mp4({ moovFirst: true, matrix: rotated }), 100).info, { durationSeconds: 8, width: 1280, height: 720 });
});

test('a file without moov reports nothing rather than guessing', () => {
  const bytes = Uint8Array.from([...box('ftyp', [105, 115, 111, 109, 0, 0, 0, 0]), ...box('mdat', [1, 2, 3])]);
  assert.deepEqual(inspect(bytes, 5).info, {});
});

const vint = (value: number, length: number) => { const out: number[] = []; for (let i = length - 1; i >= 0; i -= 1) out.push(Math.floor(value / 256 ** i) & 255); out[0] |= 0x80 >> (length - 1); return out; };
const element = (id: number[], payload: number[]) => [...id, ...vint(payload.length, 4), ...payload];
const float64 = (value: number) => { const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value); return [...new Uint8Array(view.buffer)]; };

test('WebM length and size come from Info and the video track', () => {
  const header = element([0x1a, 0x45, 0xdf, 0xa3], [0x42, 0x86, 0x81, 0x01]);
  const info = element([0x15, 0x49, 0xa9, 0x66], [...element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]), ...element([0x44, 0x89], float64(8000))]);
  const audio = element([0xae], [...element([0x83], [2])]);
  const video = element([0xae], [...element([0x83], [1]), ...element([0xe0], [...element([0xb0], [0x02, 0xd0]), ...element([0xba], [0x05, 0x00])])]);
  const tracks = element([0x16, 0x54, 0xae, 0x6b], [...audio, ...video]);
  const cluster = element([0x1f, 0x43, 0xb6, 0x75], new Array(100).fill(0));
  // A live recording's Segment has an unknown size (all ones).
  const segment = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...info, ...tracks, ...cluster];
  const bytes = Uint8Array.from([...header, ...segment]);
  assert.deepEqual(readWebmHead(bytes), { durationSeconds: 8, width: 720, height: 1280 });
  assert.deepEqual(inspect(bytes, 9).info, { durationSeconds: 8, width: 720, height: 1280 });
  const withoutDuration = Uint8Array.from([...header, 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...tracks]);
  assert.deepEqual(readWebmHead(withoutDuration), { width: 720, height: 1280 }, 'browser recordings often have no duration');
});
