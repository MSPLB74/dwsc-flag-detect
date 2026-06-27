// Minimal, dependency-free PNG decoder.
//
// Exists so the offline flag-tuning harness (eval-flag.mjs) can turn archived
// frames into raw RGB bytes WITHOUT depending on ffmpeg — the harness then
// runs the exact same classify.mjs core the live detector uses. ffmpeg is a
// heavy, platform-specific dependency; a ~150-line pure-JS decoder keeps the
// tuning loop runnable on any machine (and in CI) with just Node.
//
// Scope: 8-bit, non-interlaced, colour type 2 (RGB) and 6 (RGBA) — exactly
// what `ffmpeg -i clip.mp4 -vframes 1 out.png` emits for our rgb24 frames.
// Anything else throws rather than silently mis-decoding. Uses node:zlib for
// the DEFLATE stream (PNG's only compression method).

import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG Paeth predictor (spec §9.4). a=left, b=above, c=upper-left.
export function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Reverse the per-scanline filter (spec §9.2) in place over `data`, which is
// the inflated stream: height rows, each (1 + stride) bytes (filter byte +
// filtered pixels). Returns a tightly-packed Buffer of height*stride bytes.
export function unfilter(data, height, stride, bpp) {
  const out = Buffer.alloc(height * stride);
  let prevRow = null;
  for (let y = 0; y < height; y++) {
    const filterType = data[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    data.copy(cur, 0, rowStart, rowStart + stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0; // left
      const b = prevRow ? prevRow[i] : 0; // above
      const c = prevRow && i >= bpp ? prevRow[i - bpp] : 0; // upper-left
      switch (filterType) {
        case 0: break; // None
        case 1: cur[i] = (cur[i] + a) & 0xff; break; // Sub
        case 2: cur[i] = (cur[i] + b) & 0xff; break; // Up
        case 3: cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff; break; // Average
        case 4: cur[i] = (cur[i] + paethPredictor(a, b, c)) & 0xff; break; // Paeth
        default: throw new Error(`bad PNG filter type ${filterType} on row ${y}`);
      }
    }
    prevRow = cur;
  }
  return out;
}

// Decode a PNG buffer to { width, height, rgb } where rgb is a tightly-packed
// width*height*3 Buffer (alpha dropped for RGBA). Throws on anything outside
// the supported subset.
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG (bad signature)');
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      const interlace = buf[dataStart + 12];
      if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth} (need 8)`);
      if (colorType !== 2 && colorType !== 6) {
        throw new Error(`unsupported PNG colour type ${colorType} (need 2 RGB or 6 RGBA)`);
      }
      if (interlace !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataStart + len));
    } else if (type === 'IEND') {
      break;
    }
    off = dataStart + len + 4; // skip data + CRC
  }

  if (!width || !height) throw new Error('PNG missing IHDR');
  if (!idat.length) throw new Error('PNG missing IDAT');

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const expected = height * (stride + 1);
  if (raw.length !== expected) {
    throw new Error(`PNG inflated size ${raw.length}, expected ${expected}`);
  }
  const pixels = unfilter(raw, height, stride, channels);

  if (channels === 3) return { width, height, rgb: pixels };

  // Drop alpha → rgb24.
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
    rgb[j] = pixels[i];
    rgb[j + 1] = pixels[i + 1];
    rgb[j + 2] = pixels[i + 2];
  }
  return { width, height, rgb };
}
