# dwsc-flag-detect

The water-status **flag detector** for the [Datchet Water Sailing Club member
app](https://dwsc.pages.dev). It reads the safety flag flying outside the club
office from the public DatchetCam feed and posts the result back to the app's
Cloudflare Worker.

This is a **standalone public repo on purpose**. The detector needs `ffmpeg`
to decode the webcam clip, which Cloudflare Workers can't run — so it runs on
GitHub Actions. Public repos get **unlimited** Actions minutes, where private
repos are capped (2,000/month on the free plan); the detector fires ~every
30 min through the day, which alone would dominate that cap. Splitting the
ffmpeg pipeline out keeps the private app repo well under its limit and gives
this CV workload room to run. It holds **no member data, no secrets in code,
and no images** (see Security).

## How it runs

```
Cloudflare Worker cron  ──workflow_dispatch──▶  GitHub Actions (this repo)
  (the scheduler)                                 ffmpeg + classifier
                                                        │
                                                 POST result ▼
                                          dwsc-api…workers.dev /admin/flag-status
```

Scheduling lives on the **Cloudflare side** (its cron is reliable; GitHub's
free-tier `schedule:` silently drops fires). The Worker calls
`workflow_dispatch` on `flag-detect.yml` during opening hours. Nothing here is
scheduled by GitHub — `workflow_dispatch` only.

## What's here

| Path | Role |
| --- | --- |
| `scripts/detect-flag.mjs` | The detector: fetch clip → ffmpeg crop → classify → POST result; archive a clean frame to R2 |
| `scripts/classify.mjs` | Pure classification core (HSV, pole detection, band classifier). Shared by the detector, crop-check, and the tuner so they run identical code |
| `scripts/crop-check.mjs` | Daily drift check — is the flagpole still inside the production crop? |
| `scripts/png.mjs` | Dependency-free PNG decoder so the tuner needs no ffmpeg |
| `scripts/pull-flag-frames.mjs` | Pull archived frames from R2 for offline labelling/tuning |
| `scripts/eval-flag.mjs` | Offline eval/tuning harness: re-run `classify.mjs` over pulled frames, score vs labels, sweep candidate crops/params |
| `.github/workflows/` | `flag-detect.yml`, `crop-check.yml` — both `workflow_dispatch`, fired by the Worker cron |

No dependencies — pure Node (≥22) builtins. `npm test` runs the unit tests.

## Tuning loop

```sh
FLAG_DETECTOR_SECRET=… node scripts/pull-flag-frames.mjs --from 2026-06-26 --to 2026-06-27
node scripts/eval-flag.mjs --reviewed-only            # baseline accuracy
node scripts/eval-flag.mjs --sweep sweep.json         # rank candidate configs
```
Hand-correct frames by adding a `"review": "green"` field in the day's
`labels.json`; the eval scores against those. When a candidate config wins,
copy its crop/params into `.github/workflows/flag-detect.yml` (and keep
`crop-check.yml`'s `FLAG_POLE_*` in sync).

## Security

- **No secret in code.** `FLAG_DETECTOR_SECRET` is a GitHub Actions secret,
  injected at runtime, masked in logs. The scripts reference only its *name*.
- **No PII.** The detector touches the public webcam and a single bearer-gated
  endpoint. It never reads member data. The flag-status response it logs
  contains only enums (`detector`/`admin`/`ok`/`green`…) and a confidence
  number.
- **No images.** Frames are stored in R2 via the Worker and pulled locally
  into `flag-frames/` (gitignored) — never committed.
- **Workflows are `workflow_dispatch`-only**, so forks can't run them or reach
  the secret. The secret's entire blast radius is the flag-status + frame
  endpoints; it cannot reach the app's admin/session auth (a separate secret
  and codebase in the private repo).
