const METER_FLOOR_DB = -60;

function amplitudeDb(amplitude) {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : Number.NEGATIVE_INFINITY;
}

function formatDb(value) {
  return Number.isFinite(value) ? `${value < 0 ? '−' : value > 0 ? '+' : ''}${Math.abs(value).toFixed(1)}` : '−∞';
}

export function presentMeter(peak, rms = null) {
  const safePeak = Number.isFinite(peak) ? Math.abs(peak) : 0;
  const safeRms = Number.isFinite(rms) ? Math.abs(rms) : null;
  const peakDb = amplitudeDb(safePeak);
  const rmsDb = safeRms === null ? null : amplitudeDb(safeRms);
  const percent = Number.isFinite(peakDb)
    ? Math.max(0, Math.min(100, ((peakDb - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100))
    : 0;
  const zone = peakDb >= 0 ? 'clip' : peakDb >= -6 ? 'warning' : 'normal';
  const text = `Пик ${formatDb(peakDb)} dBFS${rmsDb === null ? '' : ` · RMS ${formatDb(rmsDb)} dBFS`}`;

  return { peak: safePeak, rms: safeRms, peakDb, rmsDb, percent, value: Math.round(percent), zone, text };
}

export function analyzeMeter(samples) {
  if (!samples || typeof samples.length !== 'number') return presentMeter(0, 0);

  let peak = 0;
  let sumSquares = 0;
  let validSamples = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Number(samples[index]);
    if (!Number.isFinite(sample)) continue;
    const magnitude = Math.abs(sample);
    peak = Math.max(peak, magnitude);
    sumSquares += sample * sample;
    validSamples += 1;
  }

  return presentMeter(peak, validSamples ? Math.sqrt(sumSquares / validSamples) : 0);
}
