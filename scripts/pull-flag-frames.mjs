// Pull archived flag-detector frames from R2 (via the Worker) to your local
// machine for offline crop/threshold tuning and labelling.
//
// The CI detector POSTs a sampled (~hourly) annotated frame to the Worker,
// which stores it in R2 under flag-frames/<YYYY-MM-DD>/<HH-MM>.png with the
// detector's reading as object metadata. This script lists those frames for
// a date (or range), downloads any it doesn't already have, and writes a
// labels.json sidecar per day so you can review/relabel locally.
//
// Usage:
//   FLAG_DETECTOR_SECRET=... node scripts/pull-flag-frames.mjs            # today (UK)
//   FLAG_DETECTOR_SECRET=... node scripts/pull-flag-frames.mjs --date 2026-06-20
//   FLAG_DETECTOR_SECRET=... node scripts/pull-flag-frames.mjs --from 2026-06-15 --to 2026-06-20
//   ... --out ./training-frames        # change the output dir (default ./flag-frames)
//
// Env vars:
//   FLAG_DETECTOR_SECRET   required — same bearer the CI detector uses
//   API_URL                override the API base (default prod Worker)
//
// Exits 0 on success, non-zero on the first hard failure (auth, network).

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const API_URL = process.env.API_URL || 'https://dwsc-api.marksbraganza.workers.dev';
const SECRET = process.env.FLAG_DETECTOR_SECRET || '';

function parseArgs(argv) {
  const out = { out: './flag-frames' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') out.date = argv[++i];
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

// Today's date in UK local time as YYYY-MM-DD (en-CA renders ISO order).
function todayUk() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Inclusive list of YYYY-MM-DD between from..to. Steps in UTC (noon, so DST
// shifts never cross a day boundary) and re-renders each day as ISO.
function dateRange(from, to) {
  for (const d of [from, to]) {
    if (!DATE_RE.test(d)) {
      console.error(`bad date "${d}" — expected YYYY-MM-DD`);
      process.exit(2);
    }
  }
  const days = [];
  let cur = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  if (cur > end) {
    console.error(`--from (${from}) is after --to (${to})`);
    process.exit(2);
  }
  while (cur <= end) {
    days.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
  }
  return days;
}

async function api(path) {
  const r = await fetch(`${API_URL}${path}`, {
    headers: { authorization: `Bearer ${SECRET}` },
  });
  if (!r.ok) {
    throw new Error(`GET ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  return r;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!SECRET) {
    console.error('FLAG_DETECTOR_SECRET is required (same bearer the detector uses).');
    process.exit(2);
  }
  const args = parseArgs(process.argv.slice(2));
  let dates;
  if (args.from || args.to) {
    if (!args.from || !args.to) {
      console.error('--from and --to must be given together');
      process.exit(2);
    }
    dates = dateRange(args.from, args.to);
  } else {
    dates = [args.date || todayUk()];
  }

  let downloaded = 0;
  let skipped = 0;
  for (const date of dates) {
    if (!DATE_RE.test(date)) {
      console.error(`bad date "${date}" — expected YYYY-MM-DD`);
      process.exit(2);
    }
    const { frames } = await (await api(`/admin/flag-frames?date=${date}`)).json();
    if (!frames.length) {
      console.log(`${date}: no frames`);
      continue;
    }
    const dir = join(args.out, date);
    await mkdir(dir, { recursive: true });

    // Merge labels with anything already on disk so local edits survive.
    const labelsPath = join(dir, 'labels.json');
    let labels = {};
    if (await exists(labelsPath)) {
      try {
        labels = JSON.parse(await readFile(labelsPath, 'utf8'));
      } catch {
        labels = {};
      }
    }

    for (const f of frames) {
      // Derive the local filename from the LAST path segment of the R2 key only.
      // The key is server-issued (the Worker controls R2 keys), but treat it as
      // untrusted defence-in-depth: take only the basename and require it to be a
      // plain filename (no separators, no "..") before joining it to the output
      // dir, so a malformed/hostile key can never traverse out of `dir`.
      const name = f.key.split('/').pop() ?? '';
      if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') {
        console.error(`skipping frame with unsafe key: ${f.key}`);
        continue;
      }
      const dest = join(dir, name);
      if (await exists(dest)) {
        skipped++;
      } else {
        const buf = Buffer.from(await (await api(`/admin/flag-frame?key=${encodeURIComponent(f.key)}`)).arrayBuffer());
        await writeFile(dest, buf);
        downloaded++;
      }
      // Refresh the detector-reported label unless a local 'review' field
      // has been added (preserve manual annotations).
      labels[name] = {
        ...labels[name],
        flag: f.flag,
        confidence: f.confidence,
        status: f.status,
        uploaded: f.uploaded,
        size: f.size,
      };
    }
    await writeFile(labelsPath, JSON.stringify(labels, null, 2) + '\n');
    console.log(`${date}: ${frames.length} frame(s) → ${dir}`);
  }
  console.log(`\nDone. ${downloaded} downloaded, ${skipped} already present.`);
}

main().catch((e) => {
  console.error('pull-flag-frames failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
