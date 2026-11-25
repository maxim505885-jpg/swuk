import assert from 'node:assert/strict';
import test from 'node:test';
import { clampMidiPitch, midiOctaveStart, shiftMidiOctave } from '../midi-edit-core.mjs';

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
