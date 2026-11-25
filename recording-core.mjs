export function resolveRecordingStartBeat({
  playheadBeat = 0,
  playing = false,
  currentTime,
  playStartTime,
  playStartBeat,
  secondsPerBeat,
  loop = false,
  loopStartBeat = 0,
  loopEndBeat = 0,
} = {}) {
  const fallback = Number.isFinite(playheadBeat) && playheadBeat >= 0 ? playheadBeat : 0;
  if (!playing || !Number.isFinite(currentTime) || !Number.isFinite(playStartTime) ||
      !Number.isFinite(playStartBeat) || playStartBeat < 0 ||
      !Number.isFinite(secondsPerBeat) || secondsPerBeat <= 0) return fallback;

  const elapsed = Math.max(0, currentTime - playStartTime);
  const beat = playStartBeat + elapsed / secondsPerBeat;
  if (!Number.isFinite(beat)) return fallback;
  if (loop && Number.isFinite(loopStartBeat) && Number.isFinite(loopEndBeat) &&
      loopStartBeat >= 0 && loopEndBeat > loopStartBeat && beat >= loopEndBeat) {
    const length = loopEndBeat - loopStartBeat;
    return loopStartBeat + ((beat - loopStartBeat) % length);
  }
  return beat;
}
