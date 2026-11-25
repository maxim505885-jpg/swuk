import test from 'node:test';
import assert from 'node:assert/strict';
import { EQ_BAND_FREQUENCIES, normalizeEqSettings } from '../eq-core.mjs';

test('seven EQ bands default to musical center frequencies and a flat response', () => {
  const settings = normalizeEqSettings();
  assert.deepEqual(settings.bands.map(({ frequencyHz }) => frequencyHz), EQ_BAND_FREQUENCIES);
  assert.equal(settings.bands.length, 7);
  assert.ok(settings.bands.every(({ gainDb }) => gainDb === 0));
});

test('legacy parametric EQ migrates to the nearest band without losing its sound', () => {
  const settings = normalizeEqSettings({ frequencyHz: 2400, gainDb: 6, q: 1.2 });
  assert.deepEqual(settings.bands[4], { frequencyHz: 2400, gainDb: 6, q: 1.2 });
  assert.deepEqual({ frequencyHz: settings.frequencyHz, gainDb: settings.gainDb, q: settings.q },
    { frequencyHz: 1000, gainDb: 0, q: 1 });
});

test('seven EQ bands clamp malformed values to supported ranges', () => {
  const settings = normalizeEqSettings({ bands: [
    { frequencyHz: 1, gainDb: -50, q: 0 },
    { frequencyHz: 25000, gainDb: 50, q: 99 },
    null, {}, {}, {}, {},
  ] });
  assert.deepEqual(settings.bands[0], { frequencyHz: 20, gainDb: -24, q: 0.1 });
  assert.deepEqual(settings.bands[1], { frequencyHz: 20000, gainDb: 24, q: 18 });
  assert.deepEqual(settings.bands.slice(2), EQ_BAND_FREQUENCIES.slice(2).map(frequencyHz => ({ frequencyHz, gainDb: 0, q: 1 })));
});

test('non-finite legacy settings fall back to a flat seven-band response', () => {
  const settings = normalizeEqSettings({ frequencyHz: Number.NaN, gainDb: Number.POSITIVE_INFINITY });
  assert.equal(settings.bands.length, 7);
  assert.ok(settings.bands.every(({ gainDb }) => gainDb === 0));
});
