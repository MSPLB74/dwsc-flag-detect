#!/usr/bin/env node
// Daily crop-drift check for the flag detector.
//
// Pulls a frame from the DatchetCam, scans the full frame width for the
// flagpole using the SAME thin-spike pole detector the live detector uses
// (classify.mjs detectPole — picks the column that is dense AND denser than
// its neighbours, so wide/edge dark structures don't masquerade as the
// pole), and reports:
//   - where the pole actually is (% of frame width)
//   - where the current FLAG_CROP would place it (column within crop)
//   - verdict: OK if pole sits in the configured crop's safe zone, DRIFT
//     otherwise — exit 1 in the DRIFT case so the workflow fails and
//     GitHub emails Mark.
//
// Bonus: if it's during opening hours and a flag is up, the colour
// classifier should find a clear winner. We log whatever it picks for
// visibility but don't fail on the colour result (the daily detector
// already covers that).
//
// Env:
//   MP4_URL                       override source (default DatchetCam)
//   FLAG_CROP                     the production crop string, e.g.
//                                 "0.15,0.10,0.30,0.60" — same format
//                                 detect-flag uses
//   FLAG_POLE_DARK_V/S            pole HSV thresholds — keep in sync with
//   FLAG_POLE_MIN_COLUMN_FRACTION flag-detect.yml so the check finds the
//   FLAG_POLE_NEIGHBOR_RADIUS     pole the way production does
//   FLAG_POLE_EDGE_MARGIN
//   POLE_SAFE_MIN                 pole position threshold inside crop (0.25)
//   POLE_SAFE_MAX                 pole position threshold inside crop (0.75)
//
// No API_URL/secret — this script reads only, never writes to D1.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classify, detectPole, paramsFromEnv } from './classify.mjs';

const MP4_URL = process.env.MP4_URL ?? 'https://live.dwsc.co.uk/static/0.mp4';
const PROD_CROP = parseCrop(process.env.FLAG_CROP ?? '0.15,0.10,0.30,0.60');
const POLE_SAFE_MIN = Number(process.env.POLE_SAFE_MIN ?? '0.25');
const POLE_SAFE_MAX = Number(process.env.POLE_SAFE_MAX ?? '0.75');

// Wide diagnostic crop: covers full frame width and the pole's likely
// vertical extent (sky band through the water line). Wider horizontally
// than the production crop so we can find the pole wherever it's drifted.
const SCAN_CROP = { left: 0.0, top: 0.10, w: 1.0, h: 0.60 };

// Pole detection + colour thresholds come from the SAME shared classifier
// the live detector uses (classify.mjs). Critically this brings the
// thin-spike scoring + edge margin: the old naive "column with the most
// dark pixels" scan would latch onto wide/edge dark structures (a far-left
// clubhouse edge, treeline, shadow band) instead of the thin flagpole and
// fire false DRIFT alarms. detectPole rejects those by demanding the
// winning column be denser than its neighbours.
const params = paramsFromEnv();

function parseCrop(s) {
  const parts = s.split(',').map((x) => Number(x.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
    throw new Error(`bad crop string: ${s}`);
  }
  return { left: parts[0], top: parts[1], w: parts[2], h: parts[3] };
}

function run(cmd, args, { captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', captureStdout ? 'pipe' : 'inherit', 'inherit'],
    });
    const chunks = [];
    if (captureStdout) child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${cmd} exited ${code}`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

async function fetchMp4(dest) {
  const r = await fetch(MP4_URL, {
    headers: { 'User-Agent': 'dwsc-crop-check/1.0' },
  });
  if (!r.ok) throw new Error(`fetch mp4 ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await writeFile(dest, buf);
  console.log(`mp4 ${buf.length} bytes → ${dest}`);
}

async function probeDimensions(mp4) {
  const out = await run(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0',
      mp4,
    ],
    { captureStdout: true },
  );
  const [w, h] = out.toString().trim().split(',').map(Number);
  if (!w || !h) throw new Error(`bad dimensions: ${out}`);
  return { width: w, height: h };
}

async function extractCroppedRgb(mp4, dims, crop) {
  const cw = Math.max(2, Math.floor((crop.w * dims.width) / 2) * 2);
  const ch = Math.max(2, Math.floor((crop.h * dims.height) / 2) * 2);
  const cx = Math.floor(crop.left * dims.width);
  const cy = Math.floor(crop.top * dims.height);
  const buf = await run(
    'ffmpeg',
    [
      '-loglevel', 'error',
      '-i', mp4,
      '-vframes', '1',
      '-filter:v', `crop=${cw}:${ch}:${cx}:${cy}`,
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      '-',
    ],
    { captureStdout: true },
  );
  if (buf.length !== cw * ch * 3) {
    throw new Error(`expected ${cw * ch * 3} bytes, got ${buf.length}`);
  }
  return { rgb: buf, width: cw, height: ch, originX: cx, originY: cy };
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'dwsc-cropcheck-'));
  const mp4 = join(dir, 'cam.mp4');
  try {
    await fetchMp4(mp4);
    const dims = await probeDimensions(mp4);
    console.log(`frame: ${dims.width}x${dims.height}`);

    // Step 1: find the pole anywhere in the frame, using the same thin-spike
    // detector the live classifier uses. detectPole only returns detected
    // when a column clears the density floor AND is denser than its
    // neighbours, so wide/edge dark structures don't masquerade as the pole.
    const scan = await extractCroppedRgb(mp4, dims, SCAN_CROP);
    const pole = detectPole(scan.rgb, scan.width, scan.height, params);

    if (!pole.detected) {
      console.error(
        `DRIFT — no thin vertical pole found anywhere in the frame ` +
          `(best column density ${(pole.bestFraction * 100).toFixed(1)}%, ` +
          `min required ${(params.poleMinColumnFraction * 100).toFixed(0)}%). ` +
          `Camera may be obscured / offline / re-aimed.`,
      );
      process.exit(1);
    }

    const poleFrameX = scan.originX + pole.bestColumn;
    const polePct = poleFrameX / dims.width;
    console.log(
      `pole scan: best column=${pole.bestColumn} of ${scan.width} ` +
        `(frame x=${poleFrameX}, ${(polePct * 100).toFixed(1)}% of width), ` +
        `density=${(pole.bestFraction * 100).toFixed(1)}%, ` +
        `thinness=${(pole.bestScore * 100).toFixed(1)}%`,
    );

    // Step 2: check where production FLAG_CROP places the pole.
    const prodLeftPx = Math.floor(PROD_CROP.left * dims.width);
    const prodWidthPx = Math.floor(PROD_CROP.w * dims.width);
    const polePosInProdCrop = (poleFrameX - prodLeftPx) / prodWidthPx;
    console.log(
      `prod crop: ${PROD_CROP.left.toFixed(2)},${PROD_CROP.top.toFixed(2)},` +
        `${PROD_CROP.w.toFixed(2)},${PROD_CROP.h.toFixed(2)} → ` +
        `pole would sit at ${(polePosInProdCrop * 100).toFixed(0)}% of crop width`,
    );

    // Step 3: bonus colour classification on prod-crop region (diagnostic
    // only — never fails the check; the live detector owns the colour call).
    try {
      const prod = await extractCroppedRgb(mp4, dims, PROD_CROP);
      const { flag, confidence, counts } = classify(prod.rgb, params);
      console.log(
        `colour scan (prod crop): counts=${JSON.stringify(counts)}, ` +
          `winner=${flag} @ ${(confidence * 100).toFixed(2)}%`,
      );
    } catch (e) {
      console.log(`colour scan skipped: ${e.message}`);
    }

    // Verdict: is the (genuinely pole-shaped) pole inside the crop's safe zone?
    if (polePosInProdCrop < POLE_SAFE_MIN || polePosInProdCrop > POLE_SAFE_MAX) {
      // Propose a new crop centred on the actual pole.
      const newLeft = Math.max(0, polePct - PROD_CROP.w / 2);
      const proposed = `${newLeft.toFixed(2)},${PROD_CROP.top.toFixed(2)},${PROD_CROP.w.toFixed(2)},${PROD_CROP.h.toFixed(2)}`;
      console.error(
        `DRIFT — pole sits at ${(polePosInProdCrop * 100).toFixed(0)}% of crop width ` +
          `(safe zone ${(POLE_SAFE_MIN * 100).toFixed(0)}-${(POLE_SAFE_MAX * 100).toFixed(0)}%). ` +
          `Suggested FLAG_CROP: "${proposed}"`,
      );
      process.exit(1);
    }
    console.log(
      `OK — pole at ${(polePosInProdCrop * 100).toFixed(0)}% of crop width, ` +
        `within safe zone ${(POLE_SAFE_MIN * 100).toFixed(0)}-${(POLE_SAFE_MAX * 100).toFixed(0)}%.`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('crop-check failed:', e.message);
  process.exit(2);
});
