import test from 'node:test';
import assert from 'node:assert/strict';
import { clipFadeGainAt, normalizeClipFades, scheduleClipFade } from '../clip-fade-core.mjs';

test('clip fades are bounded and proportionally fitted to clip duration', () => {
  assert.deepEqual(normalizeClipFades(4, 3, 3), { fadeInSec: 2, fadeOutSec: 2 });
  assert.deepEqual(normalizeClipFades(4, -1, Number.NaN), { fadeInSec: 0, fadeOutSec: 0 });
  assert.deepEqual(normalizeClipFades(0, 2, 2), { fadeInSec: 0, fadeOutSec: 0 });
});

test('clip fade envelope reaches full level between fades and zero at both edges', () => {
  assert.equal(clipFadeGainAt(0, 4, 1, 1), 0);
  assert.equal(clipFadeGainAt(.5, 4, 1, 1), .5);
  assert.equal(clipFadeGainAt(2, 4, 1, 1), 1);
  assert.equal(clipFadeGainAt(3.5, 4, 1, 1), .5);
  assert.equal(clipFadeGainAt(4, 4, 1, 1), 0);
});

test('scheduled clip envelope accounts for playback that begins inside a fade', () => {
  const calls = [];
  const param = { setValueAtTime: (value, time) => calls.push(['set', value, time]), linearRampToValueAtTime: (value, time) => calls.push(['ramp', value, time]) };
  scheduleClipFade(param, 10, 4, .8, 1, 1, .5);
  assert.deepEqual(calls, [['set', .4, 10], ['ramp', .8, 10.5], ['set', .8, 12.5], ['ramp', 0, 13.5]]);
});
