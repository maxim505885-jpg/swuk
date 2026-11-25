export const CLIP_GAIN_ENVELOPE_MAX_POINTS = 128;

export function isValidClipGainEnvelope(points) {
  return Array.isArray(points) && points.length >= 2 && points.length <= CLIP_GAIN_ENVELOPE_MAX_POINTS &&
    points.every((point, index) => point && typeof point === 'object' &&
      Number.isFinite(point.position) && point.position >= 0 && point.position <= 1 &&
      Number.isFinite(point.gain) && point.gain >= 0 && point.gain <= 1.5 &&
      (index === 0 ? point.position === 0 : point.position > points[index - 1].position)) &&
    points[points.length - 1].position === 1;
}

export function normalizeClipGainEnvelope(points) {
  if (!isValidClipGainEnvelope(points)) return [{ position: 0, gain: 1 }, { position: 1, gain: 1 }];
  return points.map(point => ({ position: point.position, gain: point.gain }));
}

export function sampleClipGainEnvelope(points, position) {
  if (!isValidClipGainEnvelope(points) || !Number.isFinite(position)) return 1;
  const at = Math.min(1, Math.max(0, position));
  let upper = points.findIndex(point => point.position >= at);
  if (upper < 0) return points.at(-1).gain;
  if (upper === 0) return points[0].gain;
  const left = points[upper - 1], right = points[upper];
  const amount = (at - left.position) / (right.position - left.position);
  return left.gain + (right.gain - left.gain) * amount;
}

export function splitClipGainEnvelope(points, splitPosition) {
  if (!isValidClipGainEnvelope(points) || !Number.isFinite(splitPosition) || splitPosition <= 0 || splitPosition >= 1) return null;
  const gain = sampleClipGainEnvelope(points, splitPosition);
  const left = [
    ...points.filter(point => point.position < splitPosition).map(point => ({ position: point.position / splitPosition, gain: point.gain })),
    { position: 1, gain },
  ];
  const right = [
    { position: 0, gain },
    ...points.filter(point => point.position > splitPosition).map(point => ({ position: (point.position - splitPosition) / (1 - splitPosition), gain: point.gain })),
  ];
  return { left, right };
}

export function clipGainEnvelopeValueAt(points, position, durationSec, baseGain, fadeInSec = 0, fadeOutSec = 0) {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || !Number.isFinite(baseGain)) return 0;
  const time = Math.min(durationSec, Math.max(0, Number.isFinite(position) ? position : 0));
  const envelope = sampleClipGainEnvelope(points, time / durationSec);
  const fadeIn = fadeInSec > 0 ? Math.min(1, time / fadeInSec) : 1;
  const remaining = durationSec - time;
  const fadeOut = fadeOutSec > 0 ? Math.min(1, remaining / fadeOutSec) : 1;
  return baseGain * envelope * Math.min(fadeIn, fadeOut);
}

export function scheduleClipGain(param, startAt, durationSec, baseGain, points, fadeInSec = 0, fadeOutSec = 0, offsetSec = 0) {
  if (!param || typeof param.cancelScheduledValues !== 'function' || typeof param.setValueAtTime !== 'function' ||
      typeof param.linearRampToValueAtTime !== 'function' || !Number.isFinite(startAt) ||
      !Number.isFinite(durationSec) || durationSec <= 0) return false;
  const offset = Math.min(durationSec, Math.max(0, Number.isFinite(offsetSec) ? offsetSec : 0));
  const fadeIn = Number.isFinite(fadeInSec) ? Math.min(durationSec, Math.max(0, fadeInSec)) : 0;
  const fadeOut = Number.isFinite(fadeOutSec) ? Math.min(durationSec, Math.max(0, fadeOutSec)) : 0;
  const envelope = isValidClipGainEnvelope(points) ? points : null;
  const times = new Set([durationSec]);
  for (const point of envelope || []) times.add(point.position * durationSec);
  if (fadeIn > 0) times.add(fadeIn);
  if (fadeOut > 0) times.add(durationSec - fadeOut);
  const ordered = [...times].filter(time => time > offset && time <= durationSec).sort((a, b) => a - b);
  param.cancelScheduledValues(startAt);
  param.setValueAtTime(clipGainEnvelopeValueAt(envelope, offset, durationSec, baseGain, fadeIn, fadeOut), startAt);
  for (const time of ordered) {
    param.linearRampToValueAtTime(
      clipGainEnvelopeValueAt(envelope, time, durationSec, baseGain, fadeIn, fadeOut),
      startAt + time - offset,
    );
  }
  return true;
}
