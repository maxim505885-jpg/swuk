import assert from 'node:assert/strict';
import test from 'node:test';
import { splitAudioClip } from '../arrangement-core.mjs';

test('audio split follows the exact cursor and advances source time by playback rate', () => {
  const clip = {
    id: 'audio-1', startBeat: 2, lengthBeats: 8, offsetSec: .25, rate: 1.5,
    trimEndSec: .4, fadeInSec: .2, fadeOutSec: .3,
  };
  const parts = splitAudioClip(clip, 5.333, 120);
  assert.ok(parts);
  assert.equal(parts.left.startBeat, 2);
  assert.equal(parts.left.lengthBeats, 3.333);
  assert.equal(parts.right.startBeat, 5.333);
  assert.equal(parts.right.lengthBeats, 4.667);
  assert.ok(Math.abs(parts.right.offsetSec - 2.74975) < 1e-10);
  assert.equal(parts.left.trimEndSec, 0);
  assert.equal(parts.right.trimEndSec, .4);
  assert.equal(parts.left.fadeInSec, .2);
  assert.equal(parts.left.fadeOutSec, 0);
  assert.equal(parts.right.fadeInSec, 0);
  assert.equal(parts.right.fadeOutSec, .3);
  assert.deepEqual(clip, {
    id: 'audio-1', startBeat: 2, lengthBeats: 8, offsetSec: .25, rate: 1.5,
    trimEndSec: .4, fadeInSec: .2, fadeOutSec: .3,
  });
});

test('audio split defaults to normal speed and leaves the right clip at the cursor', () => {
  const parts = splitAudioClip({ startBeat: 0, lengthBeats: 4 }, 1.5, 120);
  assert.ok(parts);
  assert.equal(parts.right.offsetSec, .75);
  assert.equal(parts.left.lengthBeats + parts.right.lengthBeats, 4);
  assert.equal(parts.right.startBeat, 1.5);
});

test('audio split rejects invalid beat boundaries, tempos, rates and offsets', () => {
  const clip = { startBeat: 2, lengthBeats: 4, rate: 1 };
  assert.equal(splitAudioClip(clip, 2, 120), null);
  assert.equal(splitAudioClip(clip, 6, 120), null);
  assert.equal(splitAudioClip(clip, 4, 0), null);
  assert.equal(splitAudioClip({ ...clip, rate: 0 }, 4, 120), null);
  assert.equal(splitAudioClip({ ...clip, offsetSec: -1 }, 4, 120), null);
  assert.equal(splitAudioClip(null, 4, 120), null);
});
