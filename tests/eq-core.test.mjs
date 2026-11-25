import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEqSettings } from '../eq-core.mjs';

test('parametric EQ settings normalize to supported frequency, gain and Q ranges', () => {
  assert.deepEqual(normalizeEqSettings({ frequencyHz: 1000, gainDb: 6, q: 1.2 }), { frequencyHz: 1000, gainDb: 6, q: 1.2 });
  assert.deepEqual(normalizeEqSettings({ frequencyHz: 25_000, gainDb: -50, q: 0 }), { frequencyHz: 20_000, gainDb: -24, q: 0.1 });
  assert.deepEqual(normalizeEqSettings({ frequencyHz: Number.NaN }), { frequencyHz: 1000, gainDb: 0, q: 1 });
});
