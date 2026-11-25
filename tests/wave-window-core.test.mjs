import test from 'node:test';
import assert from 'node:assert/strict';
import { moveWaveWindowEdge, normalizeWaveWindow, waveWindowSecondsAtX } from '../wave-window-core.mjs';

test('wave window clamps source markers and keeps the minimum editable span', () => {
  assert.deepEqual(normalizeWaveWindow(10, -3, 0, 0.5), { start: 0, end: 0.5 });
  assert.deepEqual(normalizeWaveWindow(10, 12, 15, 0.5), { start: 9.5, end: 10 });
  assert.deepEqual(normalizeWaveWindow(10, 4, 4.1, 0.5), { start: 4, end: 4.5 });
});

test('moving either edge cannot cross the other edge or exceed source bounds', () => {
  const window = { start: 2, end: 5 };
  assert.deepEqual(moveWaveWindowEdge(10, window, 'start', 9, 0.25), { start: 4.75, end: 5 });
  assert.deepEqual(moveWaveWindowEdge(10, window, 'start', -1, 0.25), { start: 0, end: 5 });
  assert.deepEqual(moveWaveWindowEdge(10, window, 'end', 1, 0.25), { start: 2, end: 2.25 });
  assert.deepEqual(moveWaveWindowEdge(10, window, 'end', 99, 0.25), { start: 2, end: 10 });
  assert.deepEqual(moveWaveWindowEdge(10, window, 'middle', 4), window);
});

test('waveform pointer positions map to source seconds and clamp outside canvas', () => {
  assert.equal(waveWindowSecondsAtX(50, 100, 8), 4);
  assert.equal(waveWindowSecondsAtX(-10, 100, 8), 0);
  assert.equal(waveWindowSecondsAtX(150, 100, 8), 8);
  assert.equal(waveWindowSecondsAtX(1, 0, 8), 0);
  assert.equal(waveWindowSecondsAtX(Number.NaN, 100, 8), 0);
});
