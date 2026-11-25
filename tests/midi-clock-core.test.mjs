import test from 'node:test';
import assert from 'node:assert/strict';
import { countMidiClockPulses } from '../midi-clock-core.mjs';

test('MIDI clock emits 24 pulses per crossed beat and excludes the previous boundary', () => {
  assert.equal(countMidiClockPulses(0, 1), 24);
  assert.equal(countMidiClockPulses(1, 1.5), 12);
  assert.equal(countMidiClockPulses(0.5, 1), 12);
});

test('MIDI clock pulse calculation ignores invalid ranges and caps catch-up bursts', () => {
  assert.equal(countMidiClockPulses(1, 1), 0);
  assert.equal(countMidiClockPulses(2, 1), 0);
  assert.equal(countMidiClockPulses(Number.NaN, 2), 0);
  assert.equal(countMidiClockPulses(0, 20), 96);
  assert.equal(countMidiClockPulses(0, 1, 0), 0);
});
