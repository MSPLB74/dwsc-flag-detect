#!/usr/bin/env node
// Offline flag-detector eval / tuning harness.
//
// Re-runs the EXACT live classification core (classify.mjs) over archived
// frames pulled from R2 (scripts/pull-flag-frames.mjs → ./flag-frames/<date>/),
// scores the result against each frame's label, and reports accuracy + a
// confusion matrix. Because it shares classify.mjs with the live detector and
// reproduces detect-flag.mjs's crop math + decision rule, "what this harness
// says" == "what production would have said" for the same params — so you can
// trial a different crop / threshold set offline before touching
// flag-detect.yml, with no ffmpeg and no live camera.
//
// Frames must be the CLEAN raw frames archived by detect-flag.mjs (full frame,
// no overlay). Frames archived before that change were the annotated PNGs and
// will score garbage — pull a date after the cutover.
//
// Ground truth: a frame's label is label.review if you've hand-corrected it in
// labels.json, else the detector's own auto-label (flag/status). Tuning is
// only meaningful against reviewed frames; --reviewed-only restricts to those.
//
// Usage:
//   node scripts/eval-flag.mjs                         # baseline params, ./flag-frames, all dates
//   node scripts/eval-flag.mjs --date 2026-06-26
//   node scripts/eval-flag.mjs --crop "0.30,0.05,0.17,0.70"
//   node scripts/eval-flag.mjs --reviewed-only
//   node scripts/eval-flag.mjs --sweep sweep.json      # rank candidate configs
//
// sweep.json: [{ "label": "wider-crop", "crop": "0.30,0.05,0.17,0.70",
//                "params": { "minSegmentFraction": 0.02 } }, ...]
// Each entry merges over the baseline; omit crop/params to inherit it.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_PARAMS,
  classifyBySegments,
  detectPole,
  parseCrop,
} from './classify.mjs';
import { decodePng } from './png.mjs';

// Baseline = the live production config. MUST stay in sync with flag-detect.yml
// (same rule as crop-check.yml). This is what "no overrides" evaluates, so the
// baseline accuracy is the bar any candidate config has to beat.
export const BASELINE_CROP = '0.319,0.050,0.150,0.700';
export const BASELINE_PARAMS = {
  ...DEFAULT_PARAMS,
  poleDarkV: 0.45,
  poleMinColumnFraction: 0.3,
  minSegmentFraction: 0.01,
  skipSegments: [0, 3],
};

const FLAG_TOKENS = ['green', 'orange', 'red', 'blue', 'no_flag', 'no_pole'];

// Crop a decoded full frame to a [left,top,w,h] fractional crop, reproducing
// detect-flag.mjs extractCroppedRgb's even-pixel snapping so the cropped bytes
// are identical to what the live ffmpeg crop would have produced.
export function cropFrame(frame, crop) {
  const [left, top, w, h] = crop;
  const W = frame.width;
  const H = frame.height;
  const cx = Math.floor(left * W);
  const cy = Math.floor(top * H);
  let cw = Math.max(2, Math.floor((w * W) / 2) * 2);
  let ch = Math.max(2, Math.floor((h * H) / 2) * 2);
  // Clamp to the frame so a generous crop near the edge can't read past it.
  cw = Math.min(cw, Math.floor((W - cx) / 2) * 2);
  ch = Math.min(ch, Math.floor((H - cy) / 2) * 2);
  if (cw < 2 || ch < 2) throw new Error(`crop ${crop} lands outside ${W}x${H}`);
  const rgb = Buffer.alloc(cw * ch * 3);
  for (let y = 0; y < ch; y++) {
    const src = ((cy + y) * W + cx) * 3;
    frame.rgb.copy(rgb, y * cw * 3, src, src + cw * 3);
  }
  return { rgb, width: cw, height: ch };
}

// The production decision rule, lifted from detect-flag.mjs main(): no pole →
// no_pole; pole but no band clears the threshold → no_flag; else the winning
// band's colour. Returns { decision, fraction, poleDetected }.
export function decide(crgb, width, height, params) {
  const pole = detectPole(crgb, width, height, params);
  if (!pole.detected) return { decision: 'no_pole', fraction: pole.bestFraction, poleDetected: false };
  const seg = classifyBySegments(crgb, width, height, params);
  const decision = seg.best.fraction >= params.minSegmentFraction ? seg.best.winner : 'no_flag';
  return { decision, fraction: seg.best.fraction, poleDetected: true };
}

// Resolve a frame's ground-truth token: a hand-entered review wins; otherwise
// fall back to the detector's own auto-label (status when not 'ok', else flag).
export function truthOf(label) {
  if (label && typeof label.review === 'string' && label.review.trim()) {
    return label.review.trim();
  }
  if (label && label.status && label.status !== 'ok') return label.status;
  return (label && label.flag) || 'no_flag';
}

async function loadFrames(dir, dateFilter) {
  const dates = (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
    .map((d) => d.name)
    .filter((d) => !dateFilter || d === dateFilter)
    .sort();
  const frames = [];
  for (const date of dates) {
    const dayDir = join(dir, date);
    let labels = {};
    try {
      labels = JSON.parse(await readFile(join(dayDir, 'labels.json'), 'utf8'));
    } catch {
      labels = {};
    }
    const pngs = (await readdir(dayDir)).filter((f) => f.endsWith('.png')).sort();
    for (const name of pngs) {
      frames.push({ id: `${date}/${name}`, path: join(dayDir, name), label: labels[name] ?? {} });
    }
  }
  return frames;
}

function blankConfusion() {
  const m = {};
  for (const t of FLAG_TOKENS) m[t] = Object.fromEntries(FLAG_TOKENS.map((p) => [p, 0]));
  return m;
}

async function evalConfig(frames, crop, params, { reviewedOnly }) {
  const cropArr = parseCrop(crop);
  const confusion = blankConfusion();
  const mismatches = [];
  let n = 0;
  let correct = 0;
  let reviewed = 0;
  let errored = 0;

  for (const f of frames) {
    const hasReview = typeof f.label.review === 'string' && f.label.review.trim();
    if (reviewedOnly && !hasReview) continue;
    let decoded;
    try {
      decoded = decodePng(await readFile(f.path));
    } catch (e) {
      errored++;
      mismatches.push({ id: f.id, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const c = cropFrame(decoded, cropArr);
    const { decision, fraction } = decide(c.rgb, c.width, c.height, params);
    const truth = truthOf(f.label);
    n++;
    if (hasReview) reviewed++;
    if (confusion[truth] && confusion[truth][decision] != null) confusion[truth][decision]++;
    if (decision === truth) correct++;
    else mismatches.push({ id: f.id, truth, predicted: decision, fraction: +fraction.toFixed(3), reviewed: !!hasReview });
  }
  return { n, correct, reviewed, errored, accuracy: n ? correct / n : 0, confusion, mismatches };
}

function printConfusion(confusion) {
  const used = FLAG_TOKENS.filter((t) =>
    FLAG_TOKENS.some((p) => confusion[t][p] > 0 || confusion[p][t] > 0),
  );
  if (!used.length) return;
  const pad = (s) => String(s).padStart(8);
  console.log(`\nconfusion (rows=truth, cols=predicted):`);
  console.log(['        ', ...used.map(pad)].join(''));
  for (const t of used) {
    console.log([pad(t), ...used.map((p) => pad(confusion[t][p]))].join(''));
  }
}

function parseArgs(argv) {
  const out = { dir: './flag-frames', reviewedOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--date') out.date = argv[++i];
    else if (a === '--crop') out.crop = argv[++i];
    else if (a === '--sweep') out.sweep = argv[++i];
    else if (a === '--reviewed-only') out.reviewedOnly = true;
    else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const frames = await loadFrames(args.dir, args.date);
  if (!frames.length) {
    console.error(`no frames under ${args.dir}${args.date ? ` for ${args.date}` : ''}`);
    process.exit(1);
  }
  console.log(`${frames.length} frame(s) loaded from ${args.dir}${args.date ? ` (${args.date})` : ''}`);

  // Build the list of configs to evaluate.
  const configs = [{ label: 'baseline', crop: BASELINE_CROP, params: BASELINE_PARAMS }];
  if (args.sweep) {
    const sweep = JSON.parse(await readFile(args.sweep, 'utf8'));
    for (const s of sweep) {
      configs.push({
        label: s.label ?? 'candidate',
        crop: s.crop ?? BASELINE_CROP,
        params: { ...BASELINE_PARAMS, ...(s.params ?? {}) },
      });
    }
  } else if (args.crop) {
    configs[0] = { label: 'override', crop: args.crop, params: BASELINE_PARAMS };
  }

  const results = [];
  for (const cfg of configs) {
    const r = await evalConfig(frames, cfg.crop, cfg.params, { reviewedOnly: args.reviewedOnly });
    results.push({ cfg, r });
  }

  // Ranked summary (most useful when sweeping).
  results.sort((a, b) => b.r.accuracy - a.r.accuracy);
  console.log(`\n=== ranked by accuracy${args.reviewedOnly ? ' (reviewed frames only)' : ''} ===`);
  for (const { cfg, r } of results) {
    console.log(
      `${(r.accuracy * 100).toFixed(1)}%  ${cfg.label}  ` +
        `(${r.correct}/${r.n} correct, ${r.reviewed} reviewed${r.errored ? `, ${r.errored} undecodable` : ''})  ` +
        `crop=${cfg.crop}`,
    );
  }

  // Detail for the winning config.
  const top = results[0];
  printConfusion(top.r.confusion);
  const realMiss = top.r.mismatches.filter((m) => !m.error);
  if (realMiss.length) {
    console.log(`\nmismatches for "${top.cfg.label}" (${realMiss.length}):`);
    for (const m of realMiss.slice(0, 40)) {
      console.log(`  ${m.id}: truth=${m.truth} predicted=${m.predicted} @ ${m.fraction}${m.reviewed ? ' [reviewed]' : ''}`);
    }
    if (realMiss.length > 40) console.log(`  … ${realMiss.length - 40} more`);
  }
  const decodeErrs = top.r.mismatches.filter((m) => m.error);
  if (decodeErrs.length) {
    console.log(`\n${decodeErrs.length} undecodable frame(s) (annotated/pre-cutover?): ${decodeErrs.slice(0, 5).map((m) => m.id).join(', ')}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('eval-flag failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
