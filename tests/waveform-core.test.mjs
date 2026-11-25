import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleWaveformPeaks } from '../waveform-core.mjs';

test('waveform peak sampler preserves transients across fixed-size buckets', () => {
  const samples = new Float32Array(16);
  samples[6] = -.75;
  samples[14] = 1.4;
  assert.deepEqual([...sampleWaveformPeaks(samples, 4)], [0, .75, 0, 1]);
});

test('waveform peak sampler returns silence and tolerates non-finite samples', () => {
  assert.deepEqual([...sampleWaveformPeaks(new Float32Array(8), 3)], [0, 0, 0]);
  assert.deepEqual([...sampleWaveformPeaks([Number.NaN, Number.POSITIVE_INFINITY, -.5, .25], 2)], [0, .5]);
});

test('waveform peak sampler bounds bucket count and rejects invalid input', () => {
  assert.equal(sampleWaveformPeaks(new Float32Array(4), 9999).length, 0);
  assert.equal(sampleWaveformPeaks(null).length, 0);
  assert.equal(sampleWaveformPeaks(new Float32Array(0)).length, 0);
  assert.equal(sampleWaveformPeaks(new Float32Array(4), 8).length, 4);
});

test('waveform peak sampler renders the requested source range', () => {
  const samples = new Float32Array([.9,.8,.1,-.6,.2,.7,.3,.4]);
  assert.deepEqual([...sampleWaveformPeaks(samples,3,2,7)].map(value=>Number(value.toFixed(1))),[.1,.6,.7]);
  assert.equal(sampleWaveformPeaks(samples,3,7,2).length,0);
});
