export function sampleWaveformPeaks(samples, bucketCount = 180, startIndex = 0, endIndex = samples?.length) {
  if (!samples || !Number.isInteger(samples.length) || samples.length <= 0 ||
      !Number.isInteger(bucketCount) || bucketCount <= 0 || bucketCount > 2048 ||
      !Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex < 0 ||
      endIndex > samples.length || endIndex <= startIndex) return new Float32Array();
  const length = endIndex - startIndex, count = Math.min(length, bucketCount), peaks = new Float32Array(count);
  for (let bucket = 0; bucket < count; bucket++) {
    const start = startIndex + Math.floor(bucket * length / count);
    const end = Math.max(start + 1, startIndex + Math.floor((bucket + 1) * length / count));
    let peak = 0;
    for (let index = start; index < end; index++) {
      const sample = samples[index];
      if (Number.isFinite(sample)) peak = Math.max(peak, Math.abs(sample));
    }
    peaks[bucket] = Math.min(1, peak);
  }
  return peaks;
}
