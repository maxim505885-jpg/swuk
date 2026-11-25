import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRecordingStartBeat } from '../recording-core.mjs';

test('recording uses the current transport clock instead of the last rendered playhead', () => {
  assert.equal(resolveRecordingStartBeat({
    playheadBeat: 8.9, playing: true, currentTime: 12.25, playStartTime: 10,
    playStartBeat: 8, secondsPerBeat: 0.5,
  }), 12.5);
});

test('recording uses the paused playhead when transport is stopped', () => {
  assert.equal(resolveRecordingStartBeat({
    playheadBeat: 6.25, playing: false, currentTime: 90, playStartTime: 10,
    playStartBeat: 0, secondsPerBeat: 0.5,
  }), 6.25);
});

test('recording start wraps into the active loop after a delayed UI frame', () => {
  assert.equal(resolveRecordingStartBeat({
    playheadBeat: 9.5, playing: true, currentTime: 11, playStartTime: 10,
    playStartBeat: 9.5, secondsPerBeat: 0.5, loop: true, loopStartBeat: 2, loopEndBeat: 10,
  }), 3.5);
});

test('invalid transport timing safely falls back to the last displayed playhead', () => {
  assert.equal(resolveRecordingStartBeat({
    playheadBeat: 4, playing: true, currentTime: Number.NaN, playStartTime: 10,
    playStartBeat: 2, secondsPerBeat: 0.5,
  }), 4);
});

test('valid non-looping transport timing is not clamped to the last displayed beat', () => {
  assert.equal(resolveRecordingStartBeat({
    playheadBeat: 4, playing: true, currentTime: 12, playStartTime: 10,
    playStartBeat: 2, secondsPerBeat: 0.5,
  }), 6);
});
