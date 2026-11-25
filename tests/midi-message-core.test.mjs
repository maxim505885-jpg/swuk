import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeMidiNoteEvent } from '../midi-message-core.mjs';

test('decodes note on/off messages with channel and velocity', () => {
  assert.deepEqual(decodeMidiNoteEvent([0x93, 60, 100]), { type: 'noteon', channel: 3, pitch: 60, velocity: 100 });
  assert.deepEqual(decodeMidiNoteEvent(new Uint8Array([0x82, 64, 0])), { type: 'noteoff', channel: 2, pitch: 64, velocity: 0 });
  assert.deepEqual(decodeMidiNoteEvent([0x90, 61, 0]), { type: 'noteoff', channel: 0, pitch: 61, velocity: 0 });
});

test('rejects malformed, system, and non-note MIDI messages', () => {
  assert.equal(decodeMidiNoteEvent(null), null);
  assert.equal(decodeMidiNoteEvent([0x90, 60]), null);
  assert.equal(decodeMidiNoteEvent([0xf8, 0, 0]), null);
  assert.equal(decodeMidiNoteEvent([0xc0, 1, 0]), null);
  assert.equal(decodeMidiNoteEvent([0x90, 128, 100]), null);
  assert.equal(decodeMidiNoteEvent([0x90, 60, 256]), null);
});
