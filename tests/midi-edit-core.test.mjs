import assert from 'node:assert/strict';
import test from 'node:test';
import { clampMidiPitch, generateChordPitches, midiOctaveStart, quantizeMidiNotes, shiftMidiOctave } from '../midi-edit-core.mjs';

test('MIDI pitch stays in the complete 0–127 range', () => {
  assert.equal(clampMidiPitch(-1), 0);
  assert.equal(clampMidiPitch(60.6), 61);
  assert.equal(clampMidiPitch(128), 127);
  assert.equal(clampMidiPitch(Number.NaN), null);
});

test('octave windows include every MIDI pitch and stop at the full-range edges', () => {
  assert.equal(midiOctaveStart(0), 0);
  assert.equal(midiOctaveStart(11), 0);
  assert.equal(midiOctaveStart(12), 12);
  assert.equal(midiOctaveStart(127), 120);
  assert.equal(midiOctaveStart(-1), null);
  assert.equal(midiOctaveStart(128), null);
  assert.equal(shiftMidiOctave(60, 1), 72);
  assert.equal(shiftMidiOctave(120, 1), 120);
  assert.equal(shiftMidiOctave(0, -1), 0);
  assert.equal(shiftMidiOctave(61, 1), null);
});

test('chord generator returns supported triads and sevenths from the selected MIDI root', () => {
  assert.deepEqual(generateChordPitches(60, 'major'), [60, 64, 67]);
  assert.deepEqual(generateChordPitches(60, 'minor'), [60, 63, 67]);
  assert.deepEqual(generateChordPitches(60, 'dominant7'), [60, 64, 67, 70]);
  assert.deepEqual(generateChordPitches(60, 'major9'), [60, 64, 67, 71, 74]);
});

test('chord generator rejects unknown qualities and omits pitches above MIDI 127', () => {
  assert.deepEqual(generateChordPitches(125, 'major'), [125]);
  assert.equal(generateChordPitches(-1, 'major'), null);
  assert.equal(generateChordPitches(60, 'unknown'), null);
});

test('MIDI quantization moves note starts to the chosen grid while preserving other data', () => {
  const notes = [
    { beat: .13, length: .5, note: 60, velocity: .8, tag: 'keep' },
    { beat: .37, length: .25, note: 64, velocity: .6 },
  ];
  assert.deepEqual(quantizeMidiNotes(notes, .25, 1, 4), [
    { beat: .25, length: .5, note: 60, velocity: .8, tag: 'keep' },
    { beat: .25, length: .25, note: 64, velocity: .6 },
  ]);
  assert.equal(quantizeMidiNotes(notes, .25, .5, 4)[0].beat, .19, 'strength blends original and quantized start');
});

test('MIDI quantization clamps to clip bounds and rejects invalid controls', () => {
  assert.equal(quantizeMidiNotes([{ beat: 3.9, length: .5, note: 60 }], .25, 1, 4)[0].beat, 3.5);
  assert.equal(quantizeMidiNotes([], 0), null);
  assert.equal(quantizeMidiNotes([{ beat: -1, length: .5 }]), null);
});
