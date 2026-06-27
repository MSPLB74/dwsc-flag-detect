// Behaviour-preservation test for scripts/classify.mjs.
//
// Pins the extracted classifier to the ORIGINAL detect-flag.mjs logic: the
// reference implementations below are copied verbatim from the pre-refactor
// detector (with its hard-coded constants). We then assert the new module,
// driven by DEFAULT_PARAMS, produces byte-identical output across hundreds of
// random pixel buffers plus targeted colour/pole cases.
//
//   node --test scripts/classify.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PARAMS,
  rgbToHsv as newRgbToHsv,
  detectPole as newDetectPole,
  classifyBySegments as newClassifyBySegments,
  classify as newClassify,
  frameOffsetsFor,
  parseCrop,
} from './classify.mjs';

// ---- reference (original) implementations, verbatim ----
const STRIP_SEGMENTS = 4;
const SKIP_SEGMENTS = [0];
const POLE_DARK_V = 0.3;
const POLE_DARK_S = 0.35;
const POLE_MIN_COLUMN_FRACTION = 0.45;
const POLE_NEIGHBOR_RADIUS = 10;
const POLE_EDGE_MARGIN = 20;

function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

function detectPole(rgb, width, height) {
  const colHits = new Array(width).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      const { s, v } = rgbToHsv(rgb[idx], rgb[idx + 1], rgb[idx + 2]);
      if (v <= POLE_DARK_V && s <= POLE_DARK_S) colHits[x]++;
    }
  }
  const density = colHits.map((h) => (height > 0 ? h / height : 0));
  const margin = POLE_EDGE_MARGIN + POLE_NEIGHBOR_RADIUS;
  let best = { column: -1, density: 0, score: -Infinity };
  for (let x = margin; x < width - margin; x++) {
    if (density[x] < POLE_MIN_COLUMN_FRACTION) continue;
    let sum = 0;
    let n = 0;
    for (let dx = -POLE_NEIGHBOR_RADIUS; dx <= POLE_NEIGHBOR_RADIUS; dx++) {
      if (dx === 0) continue;
      sum += density[x + dx];
      n++;
    }
    const neighbourAvg = sum / n;
    const score = density[x] - neighbourAvg;
    if (score > best.score) best = { column: x, density: density[x], score };
  }
  return {
    detected: best.column >= 0,
    bestColumn: best.column,
    bestHits: best.column >= 0 ? colHits[best.column] : 0,
    bestFraction: best.density,
    bestScore: best.score === -Infinity ? 0 : best.score,
  };
}

function classifyBySegments(rgb, width, height) {
  const segHeight = Math.floor(height / STRIP_SEGMENTS);
  const segments = [];
  let best = { winner: null, fraction: 0, segment: -1 };
  for (let seg = 0; seg < STRIP_SEGMENTS; seg++) {
    const yStart = seg * segHeight;
    const yEnd = seg === STRIP_SEGMENTS - 1 ? height : yStart + segHeight;
    const counts = { green: 0, orange: 0, red: 0, blue: 0, none: 0 };
    for (let y = yStart; y < yEnd; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 3;
        const r = rgb[idx];
        const g = rgb[idx + 1];
        const b = rgb[idx + 2];
        const { h, s, v } = rgbToHsv(r, g, b);
        if (s < 0.4 || v < 0.2) {
          if (v >= 0.2 && g >= r + 15 && g >= b + 15 && h >= 80 && h < 170) counts.green++;
          else counts.none++;
          continue;
        }
        if (h < 15 || h >= 345) counts.red++;
        else if (h < 50) counts.orange++;
        else if (h >= 80 && h < 170) counts.green++;
        else if (h >= 200 && h < 260) counts.blue++;
        else counts.none++;
      }
    }
    const total = (yEnd - yStart) * width;
    const winner = ['green', 'orange', 'red', 'blue']
      .map((c) => ({ c, n: counts[c] }))
      .sort((a, b) => b.n - a.n)[0];
    const fraction = total > 0 ? winner.n / total : 0;
    const skipped = SKIP_SEGMENTS.includes(seg);
    segments.push({ seg, counts, fraction, winner: winner.c, skipped });
    if (!skipped && fraction > best.fraction) best = { winner: winner.c, fraction, segment: seg };
  }
  return { best, segments, segHeight };
}

function classify(rgb) {
  const counts = { green: 0, orange: 0, red: 0, blue: 0, none: 0 };
  for (let i = 0; i < rgb.length; i += 3) {
    const { h, s, v } = rgbToHsv(rgb[i], rgb[i + 1], rgb[i + 2]);
    if (s < 0.4 || v < 0.2) {
      counts.none++;
      continue;
    }
    if (h < 15 || h >= 345) counts.red++;
    else if (h < 50) counts.orange++;
    else if (h >= 80 && h < 170) counts.green++;
    else if (h >= 200 && h < 260) counts.blue++;
    else counts.none++;
  }
  const total = rgb.length / 3;
  const winner = ['green', 'orange', 'red', 'blue']
    .map((c) => ({ c, n: counts[c] }))
    .sort((a, b) => b.n - a.n)[0];
  const fraction = winner.n / total;
  return { flag: winner.c, confidence: fraction, counts, total };
}

// ---- helpers ----
// Deterministic LCG so failures reproduce.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomImage(rng, width, height, bias) {
  const buf = new Uint8Array(width * height * 3);
  for (let i = 0; i < buf.length; i += 3) {
    if (bias && rng() < 0.5) {
      // bias toward a flag colour / washed green / dark to exercise all paths
      const pick = bias[(rng() * bias.length) | 0];
      buf[i] = pick[0] + ((rng() * 30) | 0) - 15;
      buf[i + 1] = pick[1] + ((rng() * 30) | 0) - 15;
      buf[i + 2] = pick[2] + ((rng() * 30) | 0) - 15;
    } else {
      buf[i] = (rng() * 256) | 0;
      buf[i + 1] = (rng() * 256) | 0;
      buf[i + 2] = (rng() * 256) | 0;
    }
  }
  return buf;
}

const BIAS = [
  [20, 200, 40], // green
  [230, 120, 20], // orange
  [220, 30, 30], // red
  [30, 90, 220], // blue
  [150, 175, 150], // washed low-sat green
  [10, 10, 10], // dark (pole)
  [200, 210, 220], // bright sky
];

test('rgbToHsv matches original on the full byte cube (stride 17)', () => {
  for (let r = 0; r < 256; r += 17)
    for (let g = 0; g < 256; g += 17)
      for (let b = 0; b < 256; b += 17) {
        assert.deepEqual(newRgbToHsv(r, g, b), rgbToHsv(r, g, b), `rgb ${r},${g},${b}`);
      }
});

test('classify + classifyBySegments + detectPole match original over random images', () => {
  const rng = makeRng(0xC0FFEE);
  for (let iter = 0; iter < 400; iter++) {
    const width = 70 + ((rng() * 30) | 0); // >2*(margin) so pole scan runs
    const height = 80 + ((rng() * 50) | 0);
    const img = randomImage(rng, width, height, rng() < 0.7 ? BIAS : null);

    assert.deepEqual(
      newClassify(img, DEFAULT_PARAMS),
      classify(img),
      `classify mismatch iter ${iter} (${width}x${height})`,
    );
    assert.deepEqual(
      newClassifyBySegments(img, width, height, DEFAULT_PARAMS),
      classifyBySegments(img, width, height),
      `classifyBySegments mismatch iter ${iter} (${width}x${height})`,
    );
    assert.deepEqual(
      newDetectPole(img, width, height, DEFAULT_PARAMS),
      detectPole(img, width, height),
      `detectPole mismatch iter ${iter} (${width}x${height})`,
    );
  }
});

test('detectPole locks onto an injected dark column', () => {
  const width = 81;
  const height = 100;
  const img = randomImage(makeRng(1), width, height, [[200, 210, 220]]); // bright bg
  const poleX = 40;
  for (let y = 0; y < height; y++) {
    const idx = (y * width + poleX) * 3;
    img[idx] = 8;
    img[idx + 1] = 8;
    img[idx + 2] = 8;
  }
  const out = newDetectPole(img, width, height, DEFAULT_PARAMS);
  assert.equal(out.detected, true);
  assert.equal(out.bestColumn, poleX);
  assert.deepEqual(out, detectPole(img, width, height));
});

test('solid colour crops classify as that colour', () => {
  const cases = [
    [[20, 200, 40], 'green'],
    [[230, 120, 20], 'orange'],
    [[220, 30, 30], 'red'],
    [[30, 90, 220], 'blue'],
  ];
  for (const [[r, g, b], want] of cases) {
    const img = new Uint8Array(60 * 60 * 3);
    for (let i = 0; i < img.length; i += 3) {
      img[i] = r;
      img[i + 1] = g;
      img[i + 2] = b;
    }
    assert.equal(newClassify(img, DEFAULT_PARAMS).flag, want);
  }
});

test('pure helpers behave', () => {
  assert.deepEqual(parseCrop('0.319,0.050,0.150,0.700'), [0.319, 0.05, 0.15, 0.7]);
  assert.throws(() => parseCrop('1,2,3'));
  assert.deepEqual(frameOffsetsFor(6), [0, 2, 4]);
  assert.deepEqual(frameOffsetsFor(1), [0]);
  assert.deepEqual(frameOffsetsFor(0), [0]);
});
