// Shared flag-detector classification core.
//
// These are the pure, deterministic functions that turn cropped RGB bytes
// into a flag reading. They were extracted verbatim from detect-flag.mjs so
// that BOTH the live detector and the offline eval/tuning tools run identical
// code — the only difference is the knobs, which are now an explicit `params`
// object instead of module-level env globals.
//
// Nothing here does I/O, ffmpeg, env reads, or network. `paramsFromEnv()` is
// the one bridge to env, used by the CLI detector; the eval harness builds
// `params` from a candidate set instead.
//
// IMPORTANT: behaviour here must stay bit-identical to the historical
// detector for the default/production params — scripts/classify.test.mjs
// pins that with a random-input equivalence check against the original logic.

const FRAME_COUNT = 3;

// Default knobs. The pole + segment values mirror the env *defaults* that
// used to live at the top of detect-flag.mjs (NOT the production overrides,
// which come from flag-detect.yml via paramsFromEnv). The colour thresholds
// were hard-coded constants in the original classifier; they're params now so
// the tuner can vary them, but default to exactly the original values.
export const DEFAULT_PARAMS = {
  // Horizontal-band classifier
  stripSegments: 4,
  minSegmentFraction: 0.02,
  skipSegments: [0],
  // Pole detection
  poleDarkV: 0.3,
  poleDarkS: 0.35,
  poleMinColumnFraction: 0.45,
  poleNeighborRadius: 10,
  poleEdgeMargin: 20,
  // Colour classification: a pixel below either floor is "none" (sky, water,
  // mast, shadow) before hue bucketing.
  satFloor: 0.4,
  valFloor: 0.2,
  // Strict hue buckets (degrees). red wraps around 0.
  hue: { redLo: 15, redHi: 345, orangeHi: 50, greenLo: 80, greenHi: 170, blueLo: 200, blueHi: 260 },
  // Low-saturation green fallback (segment classifier only): washed-out midday
  // green keeps a clearly-dominant green channel even when saturation collapses.
  lowSatGreen: { vMin: 0.2, gOverR: 15, gOverB: 15, hLo: 80, hHi: 170 },
};

// Build params from environment, mirroring the original detect-flag.mjs env
// parsing exactly. Colour thresholds stay at DEFAULT_PARAMS (the original
// code had no env hooks for them), so production behaviour is unchanged.
export function paramsFromEnv(env = process.env) {
  return {
    ...DEFAULT_PARAMS,
    stripSegments: Number(env.FLAG_STRIP_SEGMENTS ?? '4'),
    minSegmentFraction: Number(env.FLAG_MIN_SEGMENT_FRACTION ?? '0.02'),
    skipSegments: (env.FLAG_SKIP_SEGMENTS ?? '0')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n)),
    // Colour sat/val floors. Default to the original hard-coded values so
    // production is unchanged unless set; exposed so the /admin/flag-tuning
    // optimizer's satFloor suggestion is appliable via flag-detect.yml.
    satFloor: Number(env.FLAG_SAT_FLOOR ?? String(DEFAULT_PARAMS.satFloor)),
    valFloor: Number(env.FLAG_VAL_FLOOR ?? String(DEFAULT_PARAMS.valFloor)),
    poleDarkV: Number(env.FLAG_POLE_DARK_V ?? '0.30'),
    poleDarkS: Number(env.FLAG_POLE_DARK_S ?? '0.35'),
    poleMinColumnFraction: Number(env.FLAG_POLE_MIN_COLUMN_FRACTION ?? '0.45'),
    poleNeighborRadius: Number(env.FLAG_POLE_NEIGHBOR_RADIUS ?? '10'),
    poleEdgeMargin: Number(env.FLAG_POLE_EDGE_MARGIN ?? '20'),
  };
}

export function parseCrop(s) {
  const parts = s.split(',').map((x) => Number(x.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`bad FLAG_CROP: ${s}`);
  }
  return parts;
}

export function frameOffsetsFor(durationSec) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [0];
  if (durationSec < 1.5) return [0];
  const step = durationSec / FRAME_COUNT;
  return Array.from({ length: FRAME_COUNT }, (_, i) => +(i * step).toFixed(2));
}

// rgb (0-255) → hue (0-360), s (0-1), v (0-1)
export function rgbToHsv(r, g, b) {
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

// Strict hue → colour bucket (used after the sat/val floor has passed).
function strictHueBucket(h, hue) {
  if (h < hue.redLo || h >= hue.redHi) return 'red';
  if (h < hue.orangeHi) return 'orange';
  if (h >= hue.greenLo && h < hue.greenHi) return 'green';
  if (h >= hue.blueLo && h < hue.blueHi) return 'blue';
  return 'none';
}

function topColour(counts) {
  return ['green', 'orange', 'red', 'blue']
    .map((c) => ({ c, n: counts[c] }))
    .sort((a, b) => b.n - a.n)[0];
}

// Scans each column for "dark + unsaturated" pixels (pole signature), then
// scores each column by *thinness* (its density minus its neighbours'). See
// the original notes in detect-flag.mjs history.
export function detectPole(rgb, width, height, params) {
  const colHits = new Array(width).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      const { s, v } = rgbToHsv(rgb[idx], rgb[idx + 1], rgb[idx + 2]);
      if (v <= params.poleDarkV && s <= params.poleDarkS) colHits[x]++;
    }
  }
  const density = colHits.map((h) => (height > 0 ? h / height : 0));
  const margin = params.poleEdgeMargin + params.poleNeighborRadius;

  let best = { column: -1, density: 0, score: -Infinity };
  for (let x = margin; x < width - margin; x++) {
    if (density[x] < params.poleMinColumnFraction) continue;
    let sum = 0;
    let n = 0;
    for (let dx = -params.poleNeighborRadius; dx <= params.poleNeighborRadius; dx++) {
      if (dx === 0) continue;
      sum += density[x + dx];
      n++;
    }
    const neighbourAvg = sum / n;
    const score = density[x] - neighbourAvg;
    if (score > best.score) {
      best = { column: x, density: density[x], score };
    }
  }
  return {
    detected: best.column >= 0,
    bestColumn: best.column,
    bestHits: best.column >= 0 ? colHits[best.column] : 0,
    bestFraction: best.density,
    bestScore: best.score === -Infinity ? 0 : best.score,
  };
}

// Horizontal-band classifier over the full crop width.
export function classifyBySegments(rgb, width, height, params) {
  const { stripSegments, satFloor, valFloor, hue, lowSatGreen, skipSegments } = params;
  const segHeight = Math.floor(height / stripSegments);
  const segments = [];
  let best = { winner: null, fraction: 0, segment: -1 };

  for (let seg = 0; seg < stripSegments; seg++) {
    const yStart = seg * segHeight;
    const yEnd = seg === stripSegments - 1 ? height : yStart + segHeight;
    const counts = { green: 0, orange: 0, red: 0, blue: 0, none: 0 };
    for (let y = yStart; y < yEnd; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 3;
        const r = rgb[idx];
        const g = rgb[idx + 1];
        const b = rgb[idx + 2];
        const { h, s, v } = rgbToHsv(r, g, b);
        if (s < satFloor || v < valFloor) {
          if (
            v >= lowSatGreen.vMin &&
            g >= r + lowSatGreen.gOverR &&
            g >= b + lowSatGreen.gOverB &&
            h >= lowSatGreen.hLo &&
            h < lowSatGreen.hHi
          ) {
            counts.green++;
          } else {
            counts.none++;
          }
          continue;
        }
        counts[strictHueBucket(h, hue)]++;
      }
    }
    const total = (yEnd - yStart) * width;
    const winner = topColour(counts);
    const fraction = total > 0 ? winner.n / total : 0;
    const skipped = skipSegments.includes(seg);
    segments.push({ seg, counts, fraction, winner: winner.c, skipped });
    if (!skipped && fraction > best.fraction) {
      best = { winner: winner.c, fraction, segment: seg };
    }
  }

  return { best, segments, segHeight };
}

// Whole-crop classify, diagnostic only (the decision lives in
// classifyBySegments). No low-sat green fallback here, matching the original.
export function classify(rgb, params) {
  const { satFloor, valFloor, hue } = params;
  const counts = { green: 0, orange: 0, red: 0, blue: 0, none: 0 };
  for (let i = 0; i < rgb.length; i += 3) {
    const { h, s, v } = rgbToHsv(rgb[i], rgb[i + 1], rgb[i + 2]);
    if (s < satFloor || v < valFloor) {
      counts.none++;
      continue;
    }
    counts[strictHueBucket(h, hue)]++;
  }
  const total = rgb.length / 3;
  const winner = topColour(counts);
  const fraction = winner.n / total;
  return { flag: winner.c, confidence: fraction, counts, total };
}
