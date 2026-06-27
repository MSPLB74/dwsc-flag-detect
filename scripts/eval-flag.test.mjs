// Tests for the eval harness's own logic (eval-flag.mjs). The classification
// core is already pinned by classify.test.mjs; here we cover what's new:
// crop math (must match detect-flag's even-pixel snapping), the production
// decision wiring in decide(), and ground-truth resolution.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cropFrame, decide, truthOf, BASELINE_PARAMS } from './eval-flag.mjs';

function makeFrame(width, height, fill) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      const [r, g, b] = fill(x, y);
      rgb[o] = r;
      rgb[o + 1] = g;
      rgb[o + 2] = b;
    }
  }
  return { width, height, rgb };
}

test('cropFrame snaps to even dims and copies the right region', () => {
  // Each pixel encodes its x in red, y in green so we can verify placement.
  const frame = makeFrame(100, 80, (x, y) => [x & 0xff, y & 0xff, 0]);
  const c = cropFrame(frame, [0.3, 0.1, 0.155, 0.5]);
  // cw = floor(0.155*100/2)*2 = 14 ; ch = floor(0.5*80/2)*2 = 40
  assert.equal(c.width, 14);
  assert.equal(c.height, 40);
  // origin cx=30, cy=8 → crop (0,0) is frame (30,8)
  assert.equal(c.rgb[0], 30); // red carries x
  assert.equal(c.rgb[1], 8); // green carries y
  // crop (13,0) is frame (43,8)
  assert.equal(c.rgb[13 * 3], 43);
});

test('cropFrame clamps a crop that would overrun the frame edge', () => {
  const frame = makeFrame(50, 50, () => [0, 0, 0]);
  // left 0.9 + width 0.5 would run to 1.4× width; must clamp inside 50px
  const c = cropFrame(frame, [0.9, 0.0, 0.5, 1.0]);
  assert.ok(c.width >= 2 && 45 + c.width <= 50);
});

test('decide returns no_pole when there is no dark column', () => {
  const frame = makeFrame(100, 40, () => [0, 200, 0]); // solid bright green, no pole
  const { decision, poleDetected } = decide(frame.rgb, frame.width, frame.height, BASELINE_PARAMS);
  assert.equal(poleDetected, false);
  assert.equal(decision, 'no_pole');
});

test('decide finds the pole then classifies the band colour', () => {
  // Bright green everywhere except a black vertical pole at x=50 (well inside
  // the edge margin of 30). Pole → detected; bands → green wins.
  const frame = makeFrame(100, 40, (x) => (x === 50 ? [0, 0, 0] : [0, 200, 0]));
  const { decision, poleDetected } = decide(frame.rgb, frame.width, frame.height, BASELINE_PARAMS);
  assert.equal(poleDetected, true);
  assert.equal(decision, 'green');
});

test('truthOf prefers a hand review, then status, then flag', () => {
  assert.equal(truthOf({ review: 'orange', flag: 'red', status: 'ok' }), 'orange');
  assert.equal(truthOf({ flag: 'blue', status: 'ok' }), 'blue');
  assert.equal(truthOf({ flag: '', status: 'no_pole' }), 'no_pole');
  assert.equal(truthOf({ flag: 'green', status: 'no_flag' }), 'no_flag');
  assert.equal(truthOf({}), 'no_flag');
  assert.equal(truthOf({ review: '  ' }), 'no_flag'); // blank review ignored
});
