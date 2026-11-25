import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clipGainEnvelopeValueAt,
  isValidClipGainEnvelope,
  normalizeClipGainEnvelope,
  sampleClipGainEnvelope,
  scheduleClipGain,
  splitClipGainEnvelope,
} from '../clip-envelope.mjs';

const envelope = [{ position: 0, gain: 1 }, { position: .5, gain: .2 }, { position: 1, gain: 0 }];

test('clip gain envelope schema requires bounded sorted points at both clip edges', () => {
  assert.equal(isValidClipGainEnvelope(envelope), true);
  assert.equal(isValidClipGainEnvelope([{ position: .1, gain: 1 }, { position: 1, gain: 1 }]), false);
  assert.equal(isValidClipGainEnvelope([{ position: 0, gain: 1 }, { position: .9, gain: 1 }]), false);
  assert.equal(isValidClipGainEnvelope([{ position: 0, gain: 1 }, { position: .5, gain: 1 }, { position: .5, gain: .5 }, { position: 1, gain: 1 }]), false);
  assert.equal(isValidClipGainEnvelope([{ position: 0, gain: 1 }, { position: 1, gain: 2 }]), false);
  assert.deepEqual(normalizeClipGainEnvelope(null), [{ position: 0, gain: 1 }, { position: 1, gain: 1 }]);
});

test('clip gain envelope interpolates linearly and clamps positions to the clip', () => {
  assert.equal(sampleClipGainEnvelope(envelope, 0), 1);
  assert.ok(Math.abs(sampleClipGainEnvelope(envelope, .25) - .6) < 1e-12);
  assert.equal(sampleClipGainEnvelope(envelope, 2), 0);
  assert.ok(Math.abs(sampleClipGainEnvelope(envelope, .5) - .2) < 1e-12);
});

test('split partitions the envelope at its interpolated gain without discontinuity', () => {
  const split = splitClipGainEnvelope(envelope, .25);
  assert.ok(split);
  assert.ok(Math.abs(split.left.at(-1).gain - .6) < 1e-12);
  assert.ok(Math.abs(split.right[0].gain - .6) < 1e-12);
  assert.deepEqual(split.left.map(point => point.position), [0, 1]);
  assert.deepEqual(split.right.map(point => point.position), [0, 1 / 3, 1]);
  assert.equal(splitClipGainEnvelope(envelope, 0), null);
});

test('scheduled clip gain combines fade and envelope events across seeks', () => {
  const events = [];
  const param = {
    cancelScheduledValues: at => events.push(['cancel', at]),
    setValueAtTime: (value, at) => events.push(['set', value, at]),
    linearRampToValueAtTime: (value, at) => events.push(['ramp', value, at]),
  };
  assert.equal(scheduleClipGain(param, 10, 4, .8, envelope, 1, 1, .5), true);
  assert.deepEqual(events[0], ['cancel', 10]);
  assert.equal(events[1][0], 'set');
  assert.ok(Math.abs(events[1][1] - .32) < 1e-12);
  assert.equal(events[1][2], 10);
  assert.ok(events.some(event => event[0] === 'ramp' && Math.abs(event[1] - .16) < 1e-12 && event[2] === 11.5));
});
