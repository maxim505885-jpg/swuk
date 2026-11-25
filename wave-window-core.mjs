export function normalizeWaveWindow(durationSeconds, startSeconds, endSeconds, minSpanSeconds = 0.02) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration < 0.02) return { start: 0, end: 0 };
  const minSpan = Math.min(duration, Math.max(0.02, Number.isFinite(Number(minSpanSeconds)) ? Number(minSpanSeconds) : 0.02));
  let start = Number.isFinite(Number(startSeconds)) ? Number(startSeconds) : 0;
  let end = Number.isFinite(Number(endSeconds)) ? Number(endSeconds) : duration;
  start = Math.max(0, Math.min(duration - minSpan, start));
  end = Math.max(0, Math.min(duration, end));
  if (end - start < minSpan) {
    if (start + minSpan <= duration) end = start + minSpan;
    else start = end - minSpan;
  }
  return { start, end };
}

export function moveWaveWindowEdge(durationSeconds, window, edge, positionSeconds, minSpanSeconds = 0.02) {
  const duration = Number(durationSeconds);
  const current = normalizeWaveWindow(duration, window?.start, window?.end, minSpanSeconds);
  const minSpan = Math.min(duration, Math.max(0.02, Number.isFinite(Number(minSpanSeconds)) ? Number(minSpanSeconds) : 0.02));
  const position = Number.isFinite(Number(positionSeconds)) ? Number(positionSeconds) : (edge === 'start' ? current.start : current.end);
  if (edge === 'start') {
    return { start: Math.max(0, Math.min(current.end - minSpan, position)), end: current.end };
  }
  if (edge === 'end') {
    return { start: current.start, end: Math.min(duration, Math.max(current.start + minSpan, position)) };
  }
  return current;
}

export function waveWindowSecondsAtX(x, width, durationSeconds) {
  const duration = Number(durationSeconds), span = Number(width), position = Number(x);
  if (!Number.isFinite(duration) || duration < 0 || !Number.isFinite(span) || span <= 0 || !Number.isFinite(position)) return 0;
  return Math.max(0, Math.min(duration, position / span * duration));
}
