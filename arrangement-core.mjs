export function normalizeLoopRange(firstBeat, secondBeat, quantum = 0.25) {
  if (!Number.isFinite(firstBeat) || !Number.isFinite(secondBeat) || !Number.isFinite(quantum) || quantum <= 0) return null;
  const low = Math.max(0, Math.min(firstBeat, secondBeat));
  const high = Math.max(0, Math.max(firstBeat, secondBeat));
  const startBeat = Math.round(low / quantum) * quantum;
  let endBeat = Math.round(high / quantum) * quantum;
  if (endBeat - startBeat < quantum) endBeat = startBeat + quantum;
  return { startBeat, endBeat };
}

export function normalizeTrackName(value, fallback = 'Дорожка') {
  const candidate = typeof value === 'string'
    ? value.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  const normalized = Array.from(candidate).slice(0, 80).join('');
  return normalized || fallback;
}

export function beatFromRulerPointer(clientX, rulerLeft, pixelsPerBeat, quantum = 0.25) {
  if (!Number.isFinite(clientX) || !Number.isFinite(rulerLeft) || !Number.isFinite(pixelsPerBeat) || pixelsPerBeat <= 0 || !Number.isFinite(quantum) || quantum <= 0) return null;
  const beat = Math.max(0, (clientX - rulerLeft) / pixelsPerBeat);
  return Math.round(beat / quantum) * quantum;
}

export function wrapLoopBeat(beat, startBeat, endBeat) {
  if (!Number.isFinite(beat) || !Number.isFinite(startBeat) || !Number.isFinite(endBeat) || startBeat < 0 || endBeat <= startBeat) return null;
  if (beat < endBeat) return beat;
  const length = endBeat - startBeat;
  return startBeat + ((beat - startBeat) % length);
}

export function sampleAutomation(points, beat, fallback = 0) {
  if (!Array.isArray(points) || !Number.isFinite(beat) || !Number.isFinite(fallback) || !points.length) return fallback;
  const ordered = points.filter(point => Number.isFinite(point?.beat) && Number.isFinite(point?.value))
    .slice().sort((left, right) => left.beat - right.beat);
  if (!ordered.length) return fallback;
  if (beat <= ordered[0].beat) return ordered[0].value;
  for (let index = 1; index < ordered.length; index++) {
    const right = ordered[index], left = ordered[index - 1];
    if (beat <= right.beat) {
      const span = right.beat - left.beat;
      if (span <= 0) return right.value;
      const amount = (beat - left.beat) / span;
      return left.value + (right.value - left.value) * amount;
    }
  }
  return ordered.at(-1).value;
}

export function flattenGainAutomation(automationClips, fallbackGain, bpm, sampleRate = 48_000) {
  if (!Array.isArray(automationClips) || !Number.isFinite(fallbackGain) || fallbackGain < 0 || fallbackGain > 4 ||
      !Number.isFinite(bpm) || bpm <= 0 || !Number.isSafeInteger(sampleRate) || sampleRate < 1) return null;
  const ordered = automationClips.map((clip, index) => ({ clip, index }))
    .sort((left, right) => left.clip?.startBeat - right.clip?.startBeat || left.index - right.index);
  if (ordered.some(({ clip }) => !Number.isFinite(clip?.startBeat) || clip.startBeat < 0 ||
      !Number.isFinite(clip?.lengthBeats) || clip.lengthBeats <= 0 || !Array.isArray(clip.points) || clip.points.length < 2 ||
      clip.points.some(point => !Number.isFinite(point?.beat) || point.beat < 0 || point.beat > clip.lengthBeats ||
        !Number.isFinite(point?.value) || point.value < 0 || point.value > 4))) return null;
  const starts = ordered.filter((entry, index) => index === ordered.length - 1 ||
    ordered[index + 1].clip.startBeat !== entry.clip.startBeat);
  const events = new Map(), framesPerBeat = sampleRate * 60 / bpm;
  for (let index = 0; index < starts.length; index += 1) {
    const { clip } = starts[index], nextStart = starts[index + 1]?.clip.startBeat ?? Number.POSITIVE_INFINITY;
    const cutoff = nextStart - clip.startBeat;
    const points = clip.points.filter(point => point.beat < cutoff);
    if (!points.some(point => point.beat === 0)) points.unshift({ beat: 0, value: sampleAutomation(clip.points, 0, fallbackGain) });
    for (const point of points) {
      const frame = Math.round((clip.startBeat + point.beat) * framesPerBeat);
      if (!Number.isSafeInteger(frame) || frame < 0) return null;
      events.set(frame, { frame, value: point.value });
      if (events.size > 8192) return null;
    }
  }
  return [...events.values()].sort((left, right) => left.frame - right.frame);
}

export function splitSequencerEvents(clip, splitBeat) {
  if (!clip || !Number.isFinite(clip.lengthBeats) || clip.lengthBeats <= 0 || !Number.isFinite(splitBeat) ||
      splitBeat <= 0 || splitBeat >= clip.lengthBeats) return null;
  if (clip.kind === 'midi') {
    if (!Array.isArray(clip.notes) || clip.notes.length > 8192 || clip.notes.some(note =>
      !note || !Number.isFinite(note.beat) || note.beat < 0 || !Number.isFinite(note.length) || note.length <= 0 ||
      !Number.isInteger(note.note) || note.note < 0 || note.note > 127 ||
      !Number.isFinite(note.velocity) || note.velocity < 0 || note.velocity > 1)) return null;
    const leftEvents = [], rightEvents = [];
    for (const note of clip.notes) {
      const start = note.beat, end = start + note.length;
      if (start < splitBeat) {
        const leftEnd = Math.min(end, splitBeat);
        if (leftEnd > start) leftEvents.push({ ...note, length: leftEnd - start });
      }
      if (end > splitBeat) {
        const rightStart = Math.max(start, splitBeat);
        rightEvents.push({ ...note, beat: rightStart - splitBeat, length: end - rightStart });
      }
    }
    return { leftEvents, rightEvents };
  }
  if (clip.kind === 'drums') {
    const splitStepPosition = splitBeat * 4, splitStep = Math.round(splitStepPosition);
    if (Math.abs(splitStepPosition - splitStep) > 1e-7 || !Array.isArray(clip.steps) || clip.steps.length > 128 ||
        clip.steps.some(row => !row || typeof row.kind !== 'string' || !Array.isArray(row.hits) || row.hits.length > 8192 ||
          row.hits.some(hit => !Number.isInteger(hit) || hit < 0 || hit > 4095))) return null;
    const leftEvents = clip.steps.map(row => ({ ...row, hits: row.hits.filter(hit => hit < splitStep) }));
    const rightEvents = clip.steps.map(row => ({ ...row, hits: row.hits.filter(hit => hit >= splitStep).map(hit => hit - splitStep) }));
    return { leftEvents, rightEvents };
  }
  return null;
}

export function projectRenderDurationSeconds(tracks, bpm, effectTailSeconds = 3) {
  if (!Array.isArray(tracks) || !Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(effectTailSeconds) || effectTailSeconds < 0) return null;
  let lastBeat = 16;
  let hasEffectClip = false;
  for (const track of tracks) {
    if (!track || !Array.isArray(track.clips)) return null;
    hasEffectClip ||= track.clips.length > 0 && Boolean(track.effects?.reverb || track.effects?.delay);
    for (const clip of track.clips) {
      if (!Number.isFinite(clip?.startBeat) || clip.startBeat < 0 || !Number.isFinite(clip.lengthBeats) || clip.lengthBeats <= 0) return null;
      lastBeat = Math.max(lastBeat, clip.startBeat + clip.lengthBeats);
    }
  }
  const arrangementSeconds = (lastBeat + 2) * 60 / bpm;
  return Math.ceil(arrangementSeconds + (hasEffectClip ? effectTailSeconds : 0));
}
