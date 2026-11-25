export function sampleWaveformPeaks(samples, bucketCount = 180) {
  if (!samples || !Number.isInteger(samples.length) || samples.length <= 0 ||
      !Number.isInteger(bucketCount) || bucketCount <= 0 || bucketCount > 2048) return new Float32Array();
  const count = Math.min(samples.length, bucketCount), peaks = new Float32Array(count);
  for (let bucket = 0; bucket < count; bucket++) {
    const start = Math.floor(bucket * samples.length / count);
    const end = Math.max(start + 1, Math.floor((bucket + 1) * samples.length / count));
    let peak = 0;
    for (let index = start; index < end; index++) {
      const sample = samples[index];
      if (Number.isFinite(sample)) peak = Math.max(peak, Math.abs(sample));
    }
    peaks[bucket] = Math.min(1, peak);
  }
  return peaks;
}
