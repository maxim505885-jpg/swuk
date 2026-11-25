import test from 'node:test';
import assert from 'node:assert/strict';
import { drumHitOccurs, instrumentWaveAt, normalizeDrumRowSettings, normalizeSynthSettings, renderSequencedClip } from '../sequencer-audio.mjs';

test('instrument waveforms are distinct and match the built-in timbre definitions', () => {
  assert.ok(Math.abs(instrumentWaveAt('soft-keys', .25) - .88) < 1e-6);
  assert.ok(Math.abs(instrumentWaveAt('sine', .25) - 1) < 1e-6);
  assert.ok(Math.abs(instrumentWaveAt('bass', .25) + .5) < 1e-6);
  assert.ok(Math.abs(instrumentWaveAt('pad', .25)) < 1e-6);
  assert.equal(instrumentWaveAt('soft-keys', .25, 'square'), 1);
  assert.ok(Math.abs(instrumentWaveAt('soft-keys', .25, 'sawtooth') + .5) < 1e-6);
});

test('synth settings are clamped to supported waveform, filter and envelope ranges', () => {
  assert.deepEqual(normalizeSynthSettings({
    waveform: 'invalid', cutoffHz: 90000, attackMs: -4, releaseMs: Number.NaN, detuneCents: 400,
  }), { waveform: 'preset', cutoffHz: 20000, attackMs: 1, releaseMs: 80, detuneCents: 100 });
  assert.equal(normalizeSynthSettings(null, 'pad').attackMs, 220);
});

test('MIDI oscillator waveform, filter cutoff and envelope settings change generated audio', () => {
  const clip = { kind: 'midi', lengthBeats: 1, notes: [{ beat: 0, length: 1, note: 69, velocity: 1 }] };
  const open = renderSequencedClip(clip, { bpm: 120, sampleRate: 48000, synthSettings: { waveform: 'sine', cutoffHz: 20000, attackMs: 12, releaseMs: 80 } });
  const filtered = renderSequencedClip(clip, { bpm: 120, sampleRate: 48000, synthSettings: { waveform: 'sine', cutoffHz: 200, attackMs: 12, releaseMs: 80 } });
  const slowAttack = renderSequencedClip(clip, { bpm: 120, sampleRate: 48000, synthSettings: { waveform: 'sawtooth', cutoffHz: 20000, attackMs: 300, releaseMs: 200 } });
  const detuned = renderSequencedClip(clip, { bpm: 120, sampleRate: 48000, synthSettings: { waveform: 'sine', cutoffHz: 20000, attackMs: 12, releaseMs: 80, detuneCents: 100 } });
  const rms = (samples, start, end) => Math.sqrt(samples.slice(start, end).reduce((sum, value) => sum + value * value, 0) / (end - start));
  assert.ok(rms(filtered, 2400, 7200) < rms(open, 2400, 7200) * .75, 'lower cutoff attenuates the note');
  assert.ok(rms(slowAttack, 2400, 7200) < rms(open, 2400, 7200) * .35, 'a longer attack keeps the note quiet at the start');
  assert.ok(detuned.some((value, index) => Math.abs(value - open[index]) > .001), 'detune changes the rendered pitch');
  assert.ok(slowAttack.length > open.length, 'release length extends the rendered clip');
  const shortNote = renderSequencedClip({ kind: 'midi', lengthBeats: .25, notes: [{ beat: 0, length: .1, note: 69, velocity: 1 }] }, {
    bpm: 120, sampleRate: 48000, synthSettings: { waveform: 'sine', attackMs: 300, releaseMs: 200 },
  });
  assert.ok(Math.abs(shortNote.at(-1)) < .001, 'a short note releases to silence even when its attack is longer than the note');
});

test('MIDI clip renders a pitched oscillator with the requested note envelope', () => {
  const pcm = renderSequencedClip({ kind: 'midi', lengthBeats: 1, notes: [{ beat: 0, length: .5, note: 69, velocity: 1 }] }, { bpm: 120, sampleRate: 48000, instrument: 'sine' });
  assert.ok(pcm instanceof Float32Array);
  assert.equal(pcm.length, 24_000);
  assert.ok(Math.abs(pcm[1230]) > .1, 'A4 is audible after its attack');
  assert.ok(Math.abs(pcm[0]) < .001, 'the attack begins at a quiet level');
  assert.ok(Math.abs(pcm[pcm.length - 1]) < .001, 'the release reaches silence');
  const softKeys = renderSequencedClip({ kind: 'midi', lengthBeats: 1, notes: [{ beat: 0, length: .5, note: 69, velocity: 1 }] }, { bpm: 120, sampleRate: 48000, instrument: 'soft-keys' });
  assert.ok(Math.abs(softKeys[1230]) < Math.abs(pcm[1230]) * .95, 'soft keys add a quieter octave partial');
});

test('drum hits render at their step positions and include the sample tail', () => {
  const sample = new Float32Array([1, .5, 0, 0]);
  const pcm = renderSequencedClip({ kind: 'drums', lengthBeats: 1, steps: [{ kind: 'kick', hits: [0, 4] }] }, {
    bpm: 120, sampleRate: 48000, createDrumSample: () => sample,
  });
  assert.ok(pcm instanceof Float32Array);
  assert.equal(pcm.length, 24_004);
  assert.ok(Math.abs(pcm[0] - .78) < 1e-6);
  assert.ok(Math.abs(pcm[24_000] - .78) < 1e-6);
  const softer = renderSequencedClip({ kind: 'drums', lengthBeats: 1, steps: [{ kind: 'kick', velocity: .25, hits: [0] }] }, {
    bpm: 120, sampleRate: 48000, createDrumSample: () => sample,
  });
  assert.ok(Math.abs(softer[0] - .25) < 1e-6, 'row velocity controls the drum hit level');
});

test('sequencer renderer rejects malformed or unbounded patterns', () => {
  assert.equal(renderSequencedClip({ kind: 'midi', lengthBeats: 1, notes: [{ beat: 0, length: 1, note: 200, velocity: .8 }] }), null);
  assert.equal(renderSequencedClip({ kind: 'drums', lengthBeats: 1, steps: [{ kind: 'kick', velocity: 2, hits: [0] }] }, { createDrumSample: () => new Float32Array([1]) }), null);
  assert.equal(renderSequencedClip({ kind: 'drums', lengthBeats: 1, steps: [{ kind: 'kick', hits: [0] }] }, { createDrumSample: () => new Float32Array(0) }), null);
  assert.equal(renderSequencedClip({ kind: 'midi', lengthBeats: 1000, notes: [] }), null);
  const denseNotes = Array.from({ length: 50 }, () => ({ beat: 0, length: 20, note: 60, velocity: .5 }));
  assert.equal(renderSequencedClip({ kind: 'midi', lengthBeats: 240, notes: denseNotes }, { bpm: 120 }), null);
});
test('drum probability is deterministic and ratchets retrigger within one step', () => {
  assert.deepEqual(normalizeDrumRowSettings({ probability: 1.5, ratchets: 3.2 }), { probability: 1, ratchets: 3 });
  assert.equal(drumHitOccurs('pattern-a', 1, 4, 0), false);
  assert.equal(drumHitOccurs('pattern-a', 1, 4, 1), true);
  assert.equal(drumHitOccurs('pattern-a', 1, 4, .5), drumHitOccurs('pattern-a', 1, 4, .5), 'probability decisions remain stable for browser and native rendering');
  const randomHits = Array.from({ length: 64 }, (_, hit) => hit);
  const variedClip = { id: 'stable-probability', kind: 'drums', lengthBeats: 16, steps: [{ kind: 'hat', hits: randomHits, probability: .5 }] };
  const renderOptions = { bpm: 120, sampleRate: 8000, createDrumSample: () => new Float32Array([1]) };
  const varied = renderSequencedClip(variedClip, renderOptions), repeated = renderSequencedClip(variedClip, renderOptions);
  assert.deepEqual(repeated, varied, 'the same project produces the same probability decisions on repeated renders');
  const triggered = varied.reduce((count, value) => count + Number(value !== 0), 0);
  assert.ok(triggered > 0 && triggered < randomHits.length, 'intermediate probability suppresses some steps and keeps others');
  const sample = new Float32Array([1, 0]);
  const clip = { id: 'pattern-a', kind: 'drums', lengthBeats: 1, steps: [{ kind: 'kick', hits: [0], ratchets: 3 }] };
  const pcm = renderSequencedClip(clip, { bpm: 120, sampleRate: 8000, createDrumSample: () => sample });
  assert.equal(pcm.length, 4000);
  assert.ok(Math.abs(pcm[0] - .78) < 1e-6);
  assert.ok(Math.abs(pcm[333] - .78) < 1e-6);
  assert.ok(Math.abs(pcm[666] - .78) < 1e-6);
  const silent = renderSequencedClip({ ...clip, steps: [{ kind: 'kick', hits: [0], probability: 0 }] }, {
    bpm: 120, sampleRate: 8000, createDrumSample: () => sample,
  });
  assert.equal(silent.some(value => value !== 0), false, 'zero probability suppresses a step');
  assert.equal(renderSequencedClip({ ...clip, steps: [{ kind: 'kick', hits: [0], ratchets: 9 }] }, {
    bpm: 120, sampleRate: 8000, createDrumSample: () => sample,
  }), null, 'ratchet count is bounded');
});

test('sampler MIDI notes transpose an imported mono source from its root key', () => {
  const source = Float32Array.from({ length: 600 }, (_, index) => index / 600);
  const clip = { kind: 'midi', lengthBeats: 1, notes: [{ beat: 0, length: .5, note: 60, velocity: 1 }] };
  const root = renderSequencedClip(clip, { instrument: 'sampler', samplerBuffer: source, samplerSampleRate: 8000, samplerRootNote: 60, sampleRate: 8000, bpm: 120, synthSettings: { attackMs: 1, releaseMs: 10 } });
  const octave = renderSequencedClip({ ...clip, notes: [{ ...clip.notes[0], note: 72 }] }, { instrument: 'sampler', samplerBuffer: source, samplerSampleRate: 8000, samplerRootNote: 60, sampleRate: 8000, bpm: 120, synthSettings: { attackMs: 1, releaseMs: 10 } });
  assert.ok(Math.abs(root[100] - octave[50]) < .002, 'one octave up consumes source samples twice as fast');
  assert.ok(root[100] > 0 && root.length === 4000, 'root key plays the source at its original rate');
  assert.equal(renderSequencedClip(clip, { instrument: 'sampler', sampleRate: 8000, bpm: 120 }), null, 'sampler requires a source sample');
  assert.equal(renderSequencedClip(clip, { instrument: 'sampler', samplerBuffer: source, samplerSampleRate: 8000, samplerRootNote: 128, sampleRate: 8000, bpm: 120 }), null, 'sampler root key is bounded');
});

