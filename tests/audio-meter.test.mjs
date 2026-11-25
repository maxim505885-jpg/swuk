import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMeter, presentMeter } from '../audio-meter.mjs';

test('time-domain meter reports sample peak and RMS in dBFS', () => {
  const reading = analyzeMeter(Float32Array.from([0.6, -0.6, 0.6, -0.6]));

  assert.ok(Math.abs(reading.peak - 0.6) < 1e-7);
  assert.ok(Math.abs(reading.rms - 0.6) < 1e-7);
  assert.ok(Math.abs(reading.peakDb - -4.437) < 0.001);
  assert.ok(Math.abs(reading.rmsDb - -4.437) < 0.001);
  assert.equal(reading.zone, 'warning');
  assert.equal(reading.value, 93);
  assert.match(reading.text, /Пик −4\.4 dBFS · RMS −4\.4 dBFS/);
});

test('meter maps silence to the floor without inventing signal', () => {
  const reading = analyzeMeter(new Float32Array(128));

  assert.equal(reading.peak, 0);
  assert.equal(reading.rms, 0);
  assert.equal(reading.percent, 0);
  assert.equal(reading.zone, 'normal');
  assert.match(reading.text, /Пик −∞ dBFS/);
});

test('meter identifies full-scale and over-range samples as clipping', () => {
  assert.equal(presentMeter(1).zone, 'clip');
  assert.equal(presentMeter(1.25).value, 100);
  assert.ok(presentMeter(1.25).peakDb > 0);
});

test('meter ignores non-finite samples and bounds its display level', () => {
  const reading = analyzeMeter([Number.NaN, Number.POSITIVE_INFINITY, -0.002]);

  assert.equal(reading.peak, 0.002);
  assert.equal(reading.value, 10);
  assert.equal(presentMeter(Number.NaN).percent, 0);
});
