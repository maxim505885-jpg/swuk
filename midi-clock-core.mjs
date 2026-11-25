export function countMidiClockPulses(fromExclusive, toInclusive, ppqn = 24, maximumBatch = 96) {
  if (!Number.isFinite(fromExclusive) || !Number.isFinite(toInclusive) || toInclusive <= fromExclusive ||
      !Number.isInteger(ppqn) || ppqn < 1 || ppqn > 192 ||
      !Number.isInteger(maximumBatch) || maximumBatch < 1 || maximumBatch > 4096) return 0;
  const firstPulse = Math.floor(fromExclusive * ppqn + 1e-9) + 1;
  const lastPulse = Math.floor(toInclusive * ppqn + 1e-9);
  if (!Number.isFinite(firstPulse) || !Number.isFinite(lastPulse) || lastPulse < firstPulse) return 0;
  return Math.min(maximumBatch, lastPulse - firstPulse + 1);
}
