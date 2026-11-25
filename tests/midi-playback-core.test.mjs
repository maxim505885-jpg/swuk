import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMidiPlaybackEvents, midiEventsCrossed } from '../midi-playback-core.mjs';

const track = {
  type: 'instrument', mute: false, solo: false,
  clips: [{ kind: 'midi', startBeat: 8, notes: [
    { beat: 0, length: 1, note: 60, velocity: .8 },
    { beat: 1, length: .5, note: 64, velocity: .5 },
  ] }],
};

test('builds absolute MIDI note events with scaled velocity and stable same-beat order', () => {
  const events = buildMidiPlaybackEvents([track]);
  assert.deepEqual(events, [
    { beat: 8, type: 'noteon', pitch: 60, velocity: 102 },
    { beat: 9, type: 'noteoff', pitch: 60, velocity: 0 },
    { beat: 9, type: 'noteon', pitch: 64, velocity: 64 },
    { beat: 9.5, type: 'noteoff', pitch: 64, velocity: 0 },
  ]);
});

test('honors mute and solo state and ignores malformed events', () => {
  const muted = { ...track, mute: true };
  assert.deepEqual(buildMidiPlaybackEvents([muted]), []);
  const other = { ...track, solo: true, clips: [{ kind: 'audio', startBeat: 0, notes: [] }] };
  assert.deepEqual(buildMidiPlaybackEvents([track, other]), []);
  const malformed = { ...track, clips: [{ kind: 'midi', startBeat: 0, notes: [{ beat: -1, length: 1, note: 999, velocity: 2 }] }] };
  assert.deepEqual(buildMidiPlaybackEvents([malformed]), []);
});

test('returns only events crossed after the previous beat and through the current beat', () => {
  const events = buildMidiPlaybackEvents([track]);
  assert.deepEqual(midiEventsCrossed(events, 8, 9), [
    { beat: 9, type: 'noteoff', pitch: 60, velocity: 0 },
    { beat: 9, type: 'noteon', pitch: 64, velocity: 64 },
  ]);
  assert.deepEqual(midiEventsCrossed(events, 9, 9.5), [
    { beat: 9.5, type: 'noteoff', pitch: 64, velocity: 0 },
  ]);
  assert.deepEqual(midiEventsCrossed(events, 10, 9), []);
});
