#!/usr/bin/env node
// DWSC water-status flag detector.
//
// Pipeline:
//   1. Pull the latest DatchetCam clip from live.dwsc.co.uk/static/0.mp4
//   2. ffmpeg → one frame, cropped to the flagpole region, as raw RGB bytes
//   3. HSV-histogram those bytes; pick the dominant saturated colour
//   4. POST the result to ${API_URL}/admin/flag-status using FLAG_DETECTOR_SECRET
//
// The crop is hardcoded via FLAG_CROP env (default below). Auto-discovery
// of the pole position turned out to be flaky in this scene because there
// are other thin dark verticals (mooring posts on the right of frame), so
// the operational model is: an admin sets FLAG_CROP once, and users can
// "Report wrong reading" if it ever drifts. Pole detection still runs
// inside the static crop as a sanity check — if no pole-like column is
// found inside the crop, the detector emits no_pole.
//
// Env vars (all optional; defaults at point of use):
//   API_URL                       Worker base URL (no trailing slash)
//   FLAG_DETECTOR_SECRET          bearer token expected by the Worker
//   MP4_URL                       override DatchetCam source URL
//   FLAG_CROP                     "left,top,w,h" in 0–1 fractions of frame
//   FLAG_POLE_DARK_V/S            HSV thresholds for "looks dark + unsaturated"
//   FLAG_POLE_MIN_COLUMN_FRACTION min column-density to call a pole "detected"
//   FLAG_POLE_NEIGHBOR_RADIUS     ± columns for thin-spike scoring
//   FLAG_POLE_EDGE_MARGIN         columns excluded at the crop edge
//   FLAG_STRIP_SEGMENTS           number of horizontal bands
//   FLAG_MIN_SEGMENT_FRACTION     min dominant-colour share inside any band
//   FLAG_ANNOTATE_OUT             write an overlaid PNG here for diagnostics
//   FLAG_FRAME_ARCHIVE            "1" → POST a sampled (≈hourly) annotated
//                                 frame to ${API_URL}/admin/flag-frame for R2
//                                 archival (offline crop/threshold tuning)

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classify,
  classifyBySegments,
  detectPole,
  frameOffsetsFor,
  paramsFromEnv,
} from './classify.mjs';

const MP4_URL = process.env.MP4_URL ?? 'https://live.dwsc.co.uk/static/0.mp4';
const API_URL = process.env.API_URL ?? '';
const SECRET = process.env.FLAG_DETECTOR_SECRET ?? '';

// Static crop hardcoded from a known-good calibration (2026-05-21 morning).
// Tune via FLAG_CROP env if the camera is permanently re-aimed.
const CROP = parseCrop(process.env.FLAG_CROP ?? '0.097,0.050,0.220,0.700');

// All classifier knobs (horizontal-band segmentation + pole detection +
// colour thresholds) live in the shared classify.mjs module so the live
// detector and the offline eval/tuning tools run identical code.
// paramsFromEnv() reproduces the historical env parsing exactly; see the
// per-knob notes in classify.mjs (DEFAULT_PARAMS) for what each one does.
const params = paramsFromEnv();

function parseCrop(s) {
  const parts = s.split(',').map((x) => Number(x.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
    throw new Error(`bad FLAG_CROP: ${s}`);
  }
  return { left: parts[0], top: parts[1], w: parts[2], h: parts[3] };
}

function run(cmd, args, { input, captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', captureStdout ? 'pipe' : 'inherit', 'inherit'] });
    const chunks = [];
    if (captureStdout) child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${cmd} exited ${code}`));
      else resolve(Buffer.concat(chunks));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

// The DatchetCam box is hand-maintained and occasionally drops the connection
// mid-download (fetch/arrayBuffer throws "terminated") or returns a transient
// 5xx — ~2/60 cron fires, self-healing on the next try. Retry a couple of times
// with a short backoff so a blip doesn't fail the run (and email an alert), but
// STILL throw after the last attempt so a genuine outage does alert. Backoff is
// deliberately gentle (2s, 4s) — the upstream box is fragile, don't hammer it.
const MP4_FETCH_ATTEMPTS = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchMp4(dest) {
  let lastErr;
  for (let attempt = 1; attempt <= MP4_FETCH_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(MP4_URL, { headers: { 'User-Agent': 'dwsc-flag-detector/1.0' } });
      if (!r.ok) throw new Error(`fetch mp4 ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      await writeFile(dest, buf);
      console.log(`mp4 ${buf.length} bytes → ${dest}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < MP4_FETCH_ATTEMPTS) {
        const backoffMs = 2000 * attempt; // 2s, then 4s
        console.log(
          `mp4 fetch attempt ${attempt}/${MP4_FETCH_ATTEMPTS} failed ` +
            `(${e instanceof Error ? e.message : e}); retrying in ${backoffMs / 1000}s`,
        );
        await sleep(backoffMs);
      }
    }
  }
  throw new Error(
    `mp4 fetch failed after ${MP4_FETCH_ATTEMPTS} attempts: ${lastErr instanceof Error ? lastErr.message : lastErr}`,
  );
}

async function probeDimensions(mp4) {
  const out = await run(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,duration',
      '-of', 'csv=p=0',
      mp4,
    ],
    { captureStdout: true },
  );
  const parts = out.toString().trim().split(',');
  const w = Number(parts[0]);
  const h = Number(parts[1]);
  // duration may be 'N/A' for some streams; fall back to ffprobe at the
  // container level if needed. 6s is the empirical floor we've seen.
  let duration = Number(parts[2]);
  if (!Number.isFinite(duration) || duration <= 0) {
    try {
      const dur = await run(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4],
        { captureStdout: true },
      );
      duration = Number(dur.toString().trim());
    } catch {
      duration = 6;
    }
  }
  if (!w || !h) throw new Error(`bad dimensions: ${out}`);
  return { width: w, height: h, duration: Number.isFinite(duration) ? duration : 6 };
}

async function extractCroppedRgb(mp4, dims, crop, ss = null) {
  // Snap crop to even pixel boundaries — ffmpeg crop filter needs even ints
  // for some pixel formats and we don't lose anything meaningful by aligning.
  const cw = Math.max(2, Math.floor((crop.w * dims.width) / 2) * 2);
  const ch = Math.max(2, Math.floor((crop.h * dims.height) / 2) * 2);
  const cx = Math.floor(crop.left * dims.width);
  const cy = Math.floor(crop.top * dims.height);
  if (ss == null) {
    console.log(`crop: ${cw}x${ch} at (${cx},${cy}) in ${dims.width}x${dims.height}`);
  }
  const args = ['-loglevel', 'error'];
  // -ss before -i is a fast seek; for short MP4 clips it's accurate enough.
  if (ss != null) args.push('-ss', String(ss));
  args.push(
    '-i', mp4,
    '-vframes', '1',
    '-filter:v', `crop=${cw}:${ch}:${cx}:${cy}`,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    '-',
  );
  const buf = await run('ffmpeg', args, { captureStdout: true });
  if (buf.length !== cw * ch * 3) {
    throw new Error(`expected ${cw * ch * 3} bytes, got ${buf.length}`);
  }
  return { rgb: buf, width: cw, height: ch, originX: cx, originY: cy };
}

// The classification core (frameOffsetsFor, detectPole, classifyBySegments,
// classify) is imported from classify.mjs — a pure module shared with the
// offline eval/tuning tools so both run identical code. The knobs come from
// `params` (paramsFromEnv()); this file owns only the I/O, ffmpeg, frame
// sampling, annotation, and POST.
//
// Frame sampling rationale: the DatchetCam MP4 is a short rolling clip (~6s
// empirically, not the 30s the live page suggests). Wind gusts can furl the
// flag out of the crop or bunch it up so a single frame catches it at its
// least-visible moment, so we sample several frames (frameOffsetsFor) evenly
// across the clip and pick the strongest classification.

// Produces an annotated PNG showing what the detector is "seeing": the
// production crop region in red, the detected "pole" column in lime, and
// the strip in which segment classification happens in cyan dashes. Useful
// for confirming whether the algorithm is locking onto the actual flagpole
// or some other vertical structure (clubhouse edge, pontoon, etc).
async function writeAnnotatedFrame({
  mp4,
  outPath,
  dims,
  crop,
  poleColumn,
  segHeight,
  numSegments,
  bestSegment,
  ss = null,
}) {
  const cropX = Math.floor(crop.left * dims.width);
  const cropY = Math.floor(crop.top * dims.height);
  const cropW = Math.max(2, Math.floor((crop.w * dims.width) / 2) * 2);
  const cropH = Math.max(2, Math.floor((crop.h * dims.height) / 2) * 2);
  const poleX = cropX + poleColumn;

  const filters = [
    // Red box: the dynamic classification crop.
    `drawbox=x=${cropX}:y=${cropY}:w=${cropW}:h=${cropH}:color=red@0.9:t=3`,
  ];

  // Cyan horizontal lines between the N bands.
  for (let i = 1; i < numSegments; i++) {
    const y = cropY + i * segHeight;
    filters.push(`drawbox=x=${cropX}:y=${y}:w=${cropW}:h=2:color=cyan@0.7:t=fill`);
  }

  // Yellow border around the segment with the highest dominant-colour fraction.
  if (bestSegment >= 0) {
    const segY = cropY + bestSegment * segHeight;
    const segH = bestSegment === numSegments - 1 ? cropH - bestSegment * segHeight : segHeight;
    filters.push(
      `drawbox=x=${cropX}:y=${segY}:w=${cropW}:h=${segH}:color=yellow@0.95:t=3`,
    );
  }

  // Lime line: the column the pole-detector locked onto.
  filters.push(`drawbox=x=${poleX - 1}:y=${cropY}:w=3:h=${cropH}:color=lime@0.95:t=fill`);

  const args = ['-loglevel', 'error', '-y'];
  if (ss != null) args.push('-ss', String(ss));
  args.push('-i', mp4, '-vframes', '1', '-filter:v', filters.join(','), outPath);
  await run('ffmpeg', args);
  console.log(
    `annotated frame: ${outPath} — crop=${cropX},${cropY},${cropW}x${cropH}, ` +
      `pole frame_x=${poleX}, ${numSegments} bands, best=${bestSegment}`,
  );
}

async function postResult(payload) {
  if (!API_URL || !SECRET) {
    console.log('DRY RUN — API_URL/FLAG_DETECTOR_SECRET not set');
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const r = await fetch(`${API_URL}/admin/flag-status`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${SECRET}`,
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`POST /admin/flag-status ${r.status}: ${text}`);
  }
  console.log('posted:', await r.text());
}

// True only on the top-of-hour cron fire. The detector runs every 30 min
// (fires land ~:00–:02 and ~:30–:32 after dispatch latency), so a "minute
// < 15" window selects the :00 fire and skips the :30 one — i.e. archive
// roughly one frame per hour rather than every run.
function isTopOfHourUk() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '99');
  return m < 15;
}

// Sampled archival to R2 (via the Worker, which holds the R2 binding) of a
// CLEAN, un-annotated full frame at the winning sample offset. Clean and
// full-frame on purpose: the offline eval/tuning harness (eval-flag.mjs)
// re-crops and re-runs classify.mjs on these exact pixels, so any overlay or
// pre-applied crop would make offline results diverge from what the detector
// saw — and a full frame lets the crop itself be tuned offline, not just the
// thresholds. The annotated PNG is still produced separately for the GH
// artifact (human eyeballing); it is NOT what gets archived.
//
// Best-effort: any failure is logged and swallowed so it never fails the
// detector run. Gated on FLAG_FRAME_ARCHIVE so local/dry runs never archive.
async function maybeArchiveRawFrame(mp4, ss, dir, label) {
  try {
    if (process.env.FLAG_FRAME_ARCHIVE !== '1') return;
    if (!API_URL || !SECRET) return;
    if (!isTopOfHourUk()) return;
    // Extract the full frame at the winning offset with no crop/filters.
    const rawPng = join(dir, 'archive-raw.png');
    const args = ['-loglevel', 'error', '-y'];
    if (ss != null) args.push('-ss', String(ss));
    args.push('-i', mp4, '-vframes', '1', rawPng);
    await run('ffmpeg', args);
    const bytes = await readFile(rawPng);
    const qs = new URLSearchParams({
      flag: label.flag ?? '',
      confidence: label.confidence == null ? '' : String(label.confidence),
      status: label.status ?? '',
    });
    const r = await fetch(`${API_URL}/admin/flag-frame?${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', authorization: `Bearer ${SECRET}` },
      body: bytes,
    });
    if (!r.ok) {
      console.log(`frame archive: skipped (${r.status} ${(await r.text()).slice(0, 120)})`);
      return;
    }
    console.log('frame archived (raw):', await r.text());
  } catch (e) {
    console.log(`frame archive: skipped (${e instanceof Error ? e.message : e})`);
  }
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'dwsc-flag-'));
  const mp4 = join(dir, 'cam.mp4');
  try {
    await fetchMp4(mp4);
    const dims = await probeDimensions(mp4);

    // 1. Pull the first frame for pole detection — pole position doesn't
    //    change within a 30s clip, so one detection serves all sampled frames.
    const first = await extractCroppedRgb(mp4, dims, CROP);
    const { rgb, width, height } = first;

    // 2. Sanity-check pole detection inside the crop. If no strong thin
    //    vertical streak is found, the camera has probably been moved /
    //    obscured — emit no_pole rather than a guess.
    const pole = detectPole(rgb, width, height, params);
    console.log(
      `pole: best column=${pole.bestColumn} of ${width}, ` +
        `density=${(pole.bestFraction * 100).toFixed(1)}%, ` +
        `thinness=${(pole.bestScore * 100).toFixed(1)}%, detected=${pole.detected}`,
    );

    if (!pole.detected) {
      console.log('→ status=no_pole (no thin vertical streak found inside the static crop)');
      await postResult({
        status: 'no_pole',
        confidence: pole.bestFraction,
        raw: JSON.stringify({ pole, crop: CROP }),
      });
      return;
    }

    // 3. Classify several frames spread across the MP4 and pick the strongest.
    //    Wind furls the flag in and out of the crop — a single frame can catch
    //    it bunched up against the pole, even though it's clearly visible
    //    elsewhere in the same clip. Picking the max smooths over this.
    const offsets = frameOffsetsFor(dims.duration);
    console.log(`clip duration ${dims.duration.toFixed(2)}s, sampling at ss=[${offsets.join(', ')}]`);
    const frames = [first];
    for (let i = 1; i < offsets.length; i++) {
      try {
        frames.push(await extractCroppedRgb(mp4, dims, CROP, offsets[i]));
      } catch (e) {
        console.log(`frame at -ss ${offsets[i]} failed: ${(e instanceof Error ? e.message : e)}`);
      }
    }

    const classifications = frames.map((f, i) => ({
      ss: offsets[i] ?? 0,
      seg: classifyBySegments(f.rgb, f.width, f.height, params),
    }));
    for (const c of classifications) {
      console.log(
        `  frame ss=${c.ss}s → best seg ${c.seg.best.segment}: ${c.seg.best.winner} @ ${(c.seg.best.fraction * 100).toFixed(1)}%`,
      );
    }
    const winning = classifications.reduce((a, b) =>
      b.seg.best.fraction > a.seg.best.fraction ? b : a,
    );
    const seg = winning.seg;
    console.log(
      `→ best across frames (ss=${winning.ss}s) segment ${seg.best.segment}: ${seg.best.winner} @ ${(seg.best.fraction * 100).toFixed(1)}%`,
    );

    // Per-segment dump from the winning frame for diagnostics.
    console.log(
      `bands (winning frame): ${params.stripSegments} segments × ${seg.segHeight}px tall over full ${width}px crop width`,
    );
    for (const s of seg.segments) {
      console.log(
        `  seg ${s.seg}${s.skipped ? ' [skipped]' : ''}: ${s.winner}=${(s.fraction * 100).toFixed(1)}% ${JSON.stringify(s.counts)}`,
      );
    }

    // Whole-crop classify on the winning frame, kept for diagnostic comparison.
    const winningRgb = frames[classifications.indexOf(winning)]?.rgb ?? rgb;
    const whole = classify(winningRgb, params);
    console.log(
      `whole-crop (diagnostic): pixels=${whole.total}, ` +
        `winner=${whole.flag} @ ${(whole.confidence * 100).toFixed(2)}%`,
    );

    const hasWinner = seg.best.fraction >= params.minSegmentFraction;
    const flag = hasWinner ? seg.best.winner : null;
    const confidence = seg.best.fraction;
    console.log(
      `→ ${hasWinner ? `flag=${flag}` : 'status=no_flag'} ` +
        `confidence=${confidence.toFixed(3)} (threshold ${params.minSegmentFraction})`,
    );

    // Annotated diagnostic frame so we can SEE what's being measured. Goes to
    // the path in FLAG_ANNOTATE_OUT (workflow uploads it as an artifact); skipped
    // when env not set, so local dry-runs aren't slowed down. This is for human
    // review only — the R2 tuning archive uses the clean raw frame below.
    const annotateOut = process.env.FLAG_ANNOTATE_OUT;
    if (annotateOut) {
      try {
        await writeAnnotatedFrame({
          mp4,
          outPath: annotateOut,
          dims,
          crop: CROP,
          poleColumn: pole.bestColumn,
          segHeight: seg.segHeight,
          numSegments: params.stripSegments,
          bestSegment: seg.best.segment,
          ss: winning.ss,
        });
      } catch (e) {
        console.log(`annotation failed: ${e.message}`);
      }
    }

    // Sampled archive of the CLEAN raw frame to R2 for offline tuning. Runs
    // independently of FLAG_ANNOTATE_OUT (internally gated on FLAG_FRAME_ARCHIVE
    // + ~hourly), so the tuning archive no longer piggybacks on annotation.
    await maybeArchiveRawFrame(mp4, winning.ss, dir, {
      flag,
      confidence,
      status: hasWinner ? 'ok' : 'no_flag',
    });

    const rawPayload = JSON.stringify({
      bestSegment: seg.best,
      segments: seg.segments,
      whole: { winner: whole.flag, fraction: whole.confidence, counts: whole.counts },
      pole: { columnInCrop: pole.bestColumn, density: pole.bestFraction },
      crop: CROP,
    });
    if (hasWinner) {
      await postResult({ flag, confidence, raw: rawPayload });
    } else {
      await postResult({ status: 'no_flag', confidence, raw: rawPayload });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('detector failed:', e.message);
  process.exit(1);
});
