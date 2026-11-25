export function normalizeClipFades(durationSec, fadeInSec = 0, fadeOutSec = 0) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return { fadeInSec: 0, fadeOutSec: 0 };
  const fadeIn = Math.min(durationSec, Math.max(0, Number.isFinite(fadeInSec) ? fadeInSec : 0));
  const fadeOut = Math.min(durationSec, Math.max(0, Number.isFinite(fadeOutSec) ? fadeOutSec : 0));
  const total = fadeIn + fadeOut;
  if (total <= durationSec) return { fadeInSec: fadeIn, fadeOutSec: fadeOut };
  const scale = durationSec / total;
  return { fadeInSec: fadeIn * scale, fadeOutSec: fadeOut * scale };
}

export function clipFadeGainAt(positionSec, durationSec, fadeInSec = 0, fadeOutSec = 0) {
  if (!Number.isFinite(positionSec) || !Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const fades = normalizeClipFades(durationSec, fadeInSec, fadeOutSec);
  const position = Math.max(0, Math.min(durationSec, positionSec));
  const fadeIn = fades.fadeInSec > 0 ? Math.min(1, position / fades.fadeInSec) : 1;
  const remaining = durationSec - position;
  const fadeOut = fades.fadeOutSec > 0 ? Math.min(1, remaining / fades.fadeOutSec) : 1;
  return Math.max(0, Math.min(fadeIn, fadeOut));
}

export function scheduleClipFade(param, startAt, durationSec, baseGain, fadeInSec = 0, fadeOutSec = 0, offsetSec = 0) {
  const fades = normalizeClipFades(durationSec, fadeInSec, fadeOutSec);
  const offset = Math.max(0, Math.min(durationSec, Number.isFinite(offsetSec) ? offsetSec : 0));
  const startGain = Math.max(0, baseGain) * clipFadeGainAt(offset, durationSec, fades.fadeInSec, fades.fadeOutSec);
  param.setValueAtTime(startGain, startAt);
  if (fades.fadeInSec > offset) param.linearRampToValueAtTime(baseGain, startAt + fades.fadeInSec - offset);
  const fadeOutStart = durationSec - fades.fadeOutSec;
  if (fades.fadeOutSec > 0 && fadeOutStart > offset) {
    param.setValueAtTime(baseGain, startAt + fadeOutStart - offset);
    param.linearRampToValueAtTime(0, startAt + durationSec - offset);
  } else if (fades.fadeOutSec > 0 && fadeOutStart <= offset) {
    param.linearRampToValueAtTime(0, startAt + durationSec - offset);
  }
  return fades;
}
