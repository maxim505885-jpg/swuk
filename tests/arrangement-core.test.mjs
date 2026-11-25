import assert from 'node:assert/strict';
import test from 'node:test';
import { beatFromRulerPointer, flattenGainAutomation, normalizeLoopRange, normalizeTrackName, projectRenderDurationSeconds, sampleAutomation, splitSequencerEvents, wrapLoopBeat } from '../arrangement-core.mjs';

test('loop range sorts reverse drags, snaps to quarter beats and starts at zero or later', () => {
  assert.deepEqual(normalizeLoopRange(5.13, 1.11), { startBeat: 1, endBeat: 5.25 });
  assert.deepEqual(normalizeLoopRange(-2, 0.5), { startBeat: 0, endBeat: 0.5 });
});

test('track names are normalized, bounded and fall back when blank', () => {
  assert.equal(normalizeTrackName('  Vocal\n  Take  '), 'Vocal Take');
  assert.equal(normalizeTrackName('e\u0301'), 'é');
  assert.equal(Array.from(normalizeTrackName('🎹'.repeat(100))).length, 80);
  assert.equal(normalizeTrackName(' \t\n ', 'Audio 1'), 'Audio 1');
  assert.equal(normalizeTrackName(null, 'Rhythm'), 'Rhythm');
});

test('loop range always contains at least one snap step', () => {
  assert.deepEqual(normalizeLoopRange(2.01, 2.02), { startBeat: 2, endBeat: 2.25 });
  assert.deepEqual(normalizeLoopRange(1, 1, 0.5), { startBeat: 1, endBeat: 1.5 });
});

test('loop range rejects non-finite positions and invalid grid sizes', () => {
  assert.equal(normalizeLoopRange(Number.NaN, 1), null);
  assert.equal(normalizeLoopRange(0, 1, 0), null);
  assert.equal(normalizeLoopRange(0, Number.POSITIVE_INFINITY), null);
});

test('loop wraps at the selected end and preserves playback overshoot', () => {
  assert.equal(wrapLoopBeat(8, 2, 8), 2);
  assert.equal(wrapLoopBeat(8.5, 2, 8), 2.5);
  assert.equal(wrapLoopBeat(5, 2, 8), 5);
});

test('invalid loop ranges do not produce a wrapped playhead', () => {
  assert.equal(wrapLoopBeat(8, 4, 4), null);
  assert.equal(wrapLoopBeat(Number.NaN, 0, 4), null);
});

test('volume automation linearly interpolates, clamps to endpoints and tolerates invalid points', () => {
  const points = [{ beat: 0, value: 0 }, { beat: 4, value: 1 }];
  assert.equal(sampleAutomation(points, 2), .5);
  assert.equal(sampleAutomation(points, -1), 0);
  assert.equal(sampleAutomation(points, 5), 1);
  assert.equal(sampleAutomation([{ beat: 0, value: 0 }, { beat: 2, value: Number.NaN }, { beat: 4, value: 1 }], 1), .25);
  assert.equal(sampleAutomation([], 2, .8), .8);
  assert.equal(sampleAutomation(points, Number.NaN, .8), .8);
});

test('native gain automation flattens clips and lets the latest overlapping clip take control', () => {
  const points = flattenGainAutomation([
    { startBeat: 0, lengthBeats: 16, points: [{ beat: 0, value: .8 }, { beat: 8, value: .2 }, { beat: 16, value: .6 }] },
    { startBeat: 4, lengthBeats: 16, points: [{ beat: 0, value: .4 }, { beat: 4, value: 1 }, { beat: 16, value: .9 }] },
  ], .8, 120);
  assert.deepEqual(points, [
    { frame: 0, value: .8 },
    { frame: 96_000, value: .4 },
    { frame: 192_000, value: 1 },
    { frame: 480_000, value: .9 },
  ]);
});

test('native gain automation rejects malformed clips and unsafe frame ranges', () => {
  assert.equal(flattenGainAutomation([{ startBeat: 0, lengthBeats: 4, points: [{ beat: 0, value: 1 }] }], .8, 120), null);
  assert.equal(flattenGainAutomation([{ startBeat: Number.MAX_VALUE, lengthBeats: 4, points: [{ beat: 0, value: 1 }, { beat: 4, value: 1 }] }], .8, 120), null);
  assert.deepEqual(flattenGainAutomation([], .8, 120), []);
  const pan = flattenGainAutomation([{ startBeat: 0, lengthBeats: 4, points: [{ beat: 0, value: -1 }, { beat: 4, value: 1 }] }], 0, 120, 48_000, -1, 1);
  assert.deepEqual(pan?.map(point => point.value), [-1, 1]);
  assert.equal(flattenGainAutomation([{ startBeat: 0, lengthBeats: 4, points: [{ beat: 0, value: -1.1 }, { beat: 4, value: 1 }] }], 0, 120, 48_000, -1, 1), null);
});

test('splitting a MIDI clip partitions events and cuts notes crossing the boundary', () => {
  const result = splitSequencerEvents({ kind: 'midi', lengthBeats: 4, notes: [
    { beat: 0, length: 1, note: 60, velocity: .5 },
    { beat: 1, length: 2, note: 64, velocity: .75 },
    { beat: 3, length: 1, note: 67, velocity: 1 },
  ] }, 2);
  assert.deepEqual(result, {
    leftEvents: [
      { beat: 0, length: 1, note: 60, velocity: .5 },
      { beat: 1, length: 1, note: 64, velocity: .75 },
    ],
    rightEvents: [
      { beat: 0, length: 1, note: 64, velocity: .75 },
      { beat: 1, length: 1, note: 67, velocity: 1 },
    ],
  });
});

test('splitting a drum clip partitions hits and rebases steps on the right clip', () => {
  const result = splitSequencerEvents({ kind: 'drums', lengthBeats: 4, steps: [
    { kind: 'kick', name: 'Kick', velocity: .8, hits: [0, 7, 8, 12] },
    { kind: 'hat', name: 'Hat', velocity: .5, hits: [2, 6, 10, 14] },
  ] }, 2);
  assert.deepEqual(result, {
    leftEvents: [
      { kind: 'kick', name: 'Kick', velocity: .8, hits: [0, 7] },
      { kind: 'hat', name: 'Hat', velocity: .5, hits: [2, 6] },
    ],
    rightEvents: [
      { kind: 'kick', name: 'Kick', velocity: .8, hits: [0, 4] },
      { kind: 'hat', name: 'Hat', velocity: .5, hits: [2, 6] },
    ],
  });
});

test('sequencer split rejects invalid boundaries and malformed event data', () => {
  assert.equal(splitSequencerEvents({ kind: 'midi', lengthBeats: 4, notes: [] }, 0), null);
  assert.equal(splitSequencerEvents({ kind: 'midi', lengthBeats: 4, notes: [{ beat: 0, length: 0, note: 60, velocity: .5 }] }, 2), null);
  assert.equal(splitSequencerEvents({ kind: 'drums', lengthBeats: 4, steps: [{ kind: 'kick', hits: [1] }] }, .3), null);
  assert.equal(splitSequencerEvents({ kind: 'audio', lengthBeats: 4 }, 2), null);
});

test('ruler pointer coordinates use viewport geometry once, including after horizontal scroll', () => {
  assert.equal(beatFromRulerPointer(480, -2_200, 26.5), 101.25);
  assert.equal(beatFromRulerPointer(-20, 0, 26.5), 0);
  assert.equal(beatFromRulerPointer(100, 0, 0), null);
});

test('WAV render duration reserves an effect tail only for tracks containing clips', () => {
  assert.equal(projectRenderDurationSeconds([{ clips: [] }], 120), 9);
  assert.equal(projectRenderDurationSeconds([{ effects: { delay: true }, clips: [{ startBeat: 0, lengthBeats: 4 }] }], 120), 12);
  assert.equal(projectRenderDurationSeconds([{ effects: { reverb: true }, clips: [{ startBeat: 20, lengthBeats: 4 }] }], 120), 16);
  assert.equal(projectRenderDurationSeconds([{ effects: { reverb: true }, clips: [] }], 120), 9);
});

test('WAV render duration rejects invalid tempo and clip boundaries', () => {
  assert.equal(projectRenderDurationSeconds([], 0), null);
  assert.equal(projectRenderDurationSeconds([{ clips: [{ startBeat: 0, lengthBeats: 0 }] }], 120), null);
});
