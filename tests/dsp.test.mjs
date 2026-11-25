import test from 'node:test';
import assert from 'node:assert/strict';
import { autoTuneChannels, pitchShiftChannels, timeStretchChannels } from '../dsp-core.mjs';

function sine(frequency, sampleRate = 48000, seconds = .5, phase = 0) {
  const data = new Float32Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < data.length; i++) data[i] = Math.sin(2 * Math.PI * frequency * i / sampleRate + phase) * .7;
  return data;
}

function estimateFrequency(data, sampleRate) {
  const start = Math.floor(data.length * .15), end = Math.floor(data.length * .85);
  let crossings = 0;
  for (let i = start + 1; i < end; i++) if (data[i - 1] <= 0 && data[i] > 0) crossings++;
  return crossings * sampleRate / (end - start);
}

test('zero semitones preserves the source samples exactly', () => {
  const input = sine(440), [output] = pitchShiftChannels([input], 48000, 0);
  assert.equal(output.length, input.length);
  assert.deepEqual(output, input);
});

test('one octave up changes pitch and preserves duration', () => {
  const input = sine(440), [output] = pitchShiftChannels([input], 48000, 12);
  assert.equal(output.length, input.length);
  assert.ok(Math.abs(estimateFrequency(output, 48000) - 880) < 35, `frequency was ${estimateFrequency(output, 48000)} Hz`);
});

test('one octave down changes pitch and preserves duration', () => {
  const input = sine(440), [output] = pitchShiftChannels([input], 48000, -12);
  assert.equal(output.length, input.length);
  assert.ok(Math.abs(estimateFrequency(output, 48000) - 220) < 20, `frequency was ${estimateFrequency(output, 48000)} Hz`);
});

test('stereo channels retain their count and sample alignment', () => {
  const left = sine(440), right = sine(440, 48000, .5, .35), shifted = pitchShiftChannels([left, right], 48000, 5);
  assert.equal(shifted.length, 2);
  assert.equal(shifted[0].length, left.length);
  assert.equal(shifted[1].length, right.length);
  assert.ok(shifted.every(channel => channel.every(Number.isFinite)));
});

test('autotune corrects a sharp monophonic tone to the selected major scale', () => {
  const input = sine(452, 48000, 1), [output] = autoTuneChannels([input], 48000, 'До мажор', 1, 1);
  assert.equal(output.length, input.length);
  assert.ok(Math.abs(estimateFrequency(output, 48000) - 440) < 25, `frequency was ${estimateFrequency(output, 48000)} Hz`);
});

test('autotune respects the selected minor scale', () => {
  const input = sine(466.16, 48000, 1), [output] = autoTuneChannels([input], 48000, 'Ре минор', 1, 1);
  assert.ok(Math.abs(estimateFrequency(output, 48000) - 466.16) < 25, `frequency was ${estimateFrequency(output, 48000)} Hz`);
});


test('time stretch changes duration without changing a sustained tone pitch', () => {
  const input = sine(440, 48000, 1), [output] = timeStretchChannels([input], 1.25);
  assert.equal(output.length, Math.round(input.length * 1.25));
  assert.ok(Math.abs(estimateFrequency(output, 48000) - 440) < 20, `frequency was ${estimateFrequency(output, 48000)} Hz`);
});

test('time compression shortens a sustained tone while retaining its pitch', () => {
  const input = sine(330, 48000, 1), [output] = timeStretchChannels([input], .75);
  assert.equal(output.length, Math.round(input.length * .75));
  assert.ok(Math.abs(estimateFrequency(output, 48000) - 330) < 20, `frequency was ${estimateFrequency(output, 48000)} Hz`);
});

test('time stretch handles short samples and aligned stereo channels', () => {
  const [single] = timeStretchChannels([new Float32Array([.25])], 1.5);
  assert.deepEqual([...single], [.25, .25]);
  const left = sine(440, 48000, .012), right = sine(440, 48000, .012, .4);
  const output = timeStretchChannels([left, right], 1.5);
  assert.equal(output.length, 2);
  assert.equal(output[0].length, Math.round(left.length * 1.5));
  assert.equal(output[1].length, output[0].length);
  assert.ok(output.every(channel => channel.every(Number.isFinite)));
});

test('time stretch rejects invalid channels and ratios', () => {
  assert.throws(() => timeStretchChannels([], 1), /channel/);
  assert.throws(() => timeStretchChannels([new Float32Array(4), new Float32Array(3)], 1), /same length/);
  assert.throws(() => timeStretchChannels([new Float32Array(8)], .25), /between 0.5 and 2/);
});
