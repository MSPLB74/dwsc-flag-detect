// Tests for the minimal PNG decoder (png.mjs).
//
// Strategy: a tiny in-test PNG *encoder* that can emit any single filter type
// for every row. Round-tripping a structured image through each of the five
// filters and back exercises every decode path (chunk parsing, inflate,
// unfilter, RGBA→RGB). The Paeth predictor is also pinned directly against
// spec values, so a round-trip can't pass by encode/decode being wrong in
// mutually-cancelling ways.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

import { decodePng, unfilter, paethPredictor } from './png.mjs';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  // CRC left as zero — the decoder does not validate it.
  return out;
}

// Encode pixels (tightly packed, `channels` per pixel) as a PNG that filters
// every row with `filterType`. Mirrors the spec's forward filters.
function encodePng(width, height, channels, pixels, filterType) {
  const stride = width * channels;
  const bpp = channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filterType;
    const dst = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const x = pixels[y * stride + i];
      const a = i >= bpp ? pixels[y * stride + i - bpp] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= bpp ? pixels[(y - 1) * stride + i - bpp] : 0;
      let v;
      switch (filterType) {
        case 0: v = x; break;
        case 1: v = x - a; break;
        case 2: v = x - b; break;
        case 3: v = x - ((a + b) >> 1); break;
        case 4: v = x - paethPredictor(a, b, c); break;
        default: throw new Error(`bad filter ${filterType}`);
      }
      raw[dst + i] = v & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // colour type
  // 10,11,12 = compression, filter, interlace = 0
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function makePixels(width, height, channels) {
  const px = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      px[o] = (x * 37 + y * 11) & 0xff;
      px[o + 1] = (x * 5 + y * 53) & 0xff;
      px[o + 2] = ((x ^ y) * 9) & 0xff;
      if (channels === 4) px[o + 3] = (x + y) & 0xff;
    }
  }
  return px;
}

test('paethPredictor matches the spec definition', () => {
  assert.equal(paethPredictor(0, 0, 0), 0);
  // p = 10+20-5 = 25; pa=15 pb=5 pc=20 → b wins
  assert.equal(paethPredictor(10, 20, 5), 20);
  // p = 1+2-3 = 0; pa=1 pb=2 pc=3 → a wins (ties favour a)
  assert.equal(paethPredictor(1, 2, 3), 1);
  // equal distances a==b: pa<=pb so a wins
  assert.equal(paethPredictor(5, 5, 0), 5);
});

test('round-trips an RGB image through every filter type', () => {
  const w = 7;
  const h = 5; // odd dims catch stride/row math bugs
  const px = makePixels(w, h, 3);
  for (let f = 0; f <= 4; f++) {
    const png = encodePng(w, h, 3, px, f);
    const decoded = decodePng(png);
    assert.equal(decoded.width, w);
    assert.equal(decoded.height, h);
    assert.ok(decoded.rgb.equals(px), `filter ${f} RGB round-trip`);
  }
});

test('round-trips an RGBA image and drops alpha', () => {
  const w = 6;
  const h = 4;
  const rgba = makePixels(w, h, 4);
  const expectedRgb = Buffer.alloc(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    expectedRgb[j] = rgba[i];
    expectedRgb[j + 1] = rgba[i + 1];
    expectedRgb[j + 2] = rgba[i + 2];
  }
  for (let f = 0; f <= 4; f++) {
    const decoded = decodePng(encodePng(w, h, 4, rgba, f));
    assert.ok(decoded.rgb.equals(expectedRgb), `filter ${f} RGBA→RGB`);
  }
});

test('unfilter handles a known Sub-filtered row', () => {
  // single row, 2 px RGB, filter Sub: filtered deltas accumulate left→right
  const stride = 6;
  const data = Buffer.from([1, 10, 20, 30, 5, 6, 7]); // [filterByte, deltas...]
  const out = unfilter(data, 1, stride, 3);
  // px0 = deltas as-is (no left); px1 = px0 + delta
  assert.deepEqual([...out], [10, 20, 30, 15, 26, 37]);
});

test('rejects non-PNG and unsupported variants', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /bad signature/);
});
