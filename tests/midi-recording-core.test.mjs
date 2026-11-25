import assert from 'node:assert/strict';
import test from 'node:test';
import { createMidiTake, finishMidiTake, recordMidiNoteEvent } from '../midi-recording-core.mjs';

function fixture() {
  const clip = { kind: 'midi', startBeat: 8, lengthBeats: 4, notes: [] };
  return { clip, take: createMidiTake(clip) };
}

test('records note-on and note-off as a velocity-scaled MIDI note', () => {
  const { clip, take } = fixture();
  assert.equal(recordMidiNoteEvent(take, { type: 'noteon', channel: 1, pitch: 64, velocity: 96 }, 8.5), true);
  assert.equal(recordMidiNoteEvent(take, { type: 'noteoff', channel: 1, pitch: 64, velocity: 0 }, 9.75), true);
  assert.deepEqual(clip.notes, [{ beat: .5, length: 1.25, note: 64, velocity: 96 / 127 }]);
  assert.equal(clip.lengthBeats, 4);
});

test('separates channels and repeated notes and extends the clip in bars', () => {
  const { clip, take } = fixture();
  recordMidiNoteEvent(take, { type: 'noteon', channel: 0, pitch: 60, velocity: 127 }, 8);
  recordMidiNoteEvent(take, { type: 'noteon', channel: 1, pitch: 60, velocity: 80 }, 9);
  recordMidiNoteEvent(take, { type: 'noteon', channel: 0, pitch: 60, velocity: 90 }, 10);
  recordMidiNoteEvent(take, { type: 'noteoff', channel: 1, pitch: 60, velocity: 0 }, 11);
  recordMidiNoteEvent(take, { type: 'noteoff', channel: 0, pitch: 60, velocity: 0 }, 17);
  assert.equal(clip.notes.length, 3);
  assert.deepEqual(clip.notes.map(note => note.beat), [0, 1, 2]);
  assert.equal(clip.lengthBeats, 12);
});

test('finishes held notes with a bounded minimum duration', () => {
  const { clip, take } = fixture();
  recordMidiNoteEvent(take, { type: 'noteon', channel: 0, pitch: 72, velocity: 60 }, 8.5);
  assert.equal(finishMidiTake(take, 8.5), 1);
  assert.equal(clip.notes[0].length, 1 / 16);
  assert.equal(take.active.size, 0);
});

test('rejects malformed note events and unknown note-offs', () => {
  const { take } = fixture();
  assert.equal(recordMidiNoteEvent(take, { type: 'noteon', channel: 16, pitch: 60, velocity: 90 }, 8), false);
  assert.equal(recordMidiNoteEvent(take, { type: 'noteoff', channel: 0, pitch: 60, velocity: 0 }, 8), false);
  assert.equal(recordMidiNoteEvent(take, { type: 'noteon', channel: 0, pitch: 128, velocity: 90 }, 8), false);
  assert.equal(finishMidiTake(take, Number.NaN), 0);
});
