const WAVEFORMS = new Set(['preset', 'sine', 'triangle', 'sawtooth', 'square']);
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function normalizeDrumRowSettings(row = {}) {
  return {
    probability: Number.isFinite(row.probability) ? clamp(row.probability, 0, 1) : 1,
    ratchets: Number.isFinite(row.ratchets) ? clamp(Math.round(row.ratchets), 1, 8) : 1,
  };
}

export function drumHitOccurs(clipId, rowIndex, hit, probability = 1) {
  if (!Number.isFinite(probability) || probability <= 0) return false;
  if (probability >= 1) return true;
  const seed = `${clipId || ''}:${rowIndex}:${hit}`;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619) >>> 0;
  return hash / 0x100000000 < probability;
}

export function normalizeSynthSettings(value, instrument = 'soft-keys') {
  const settings = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const number = (candidate, fallback, minimum, maximum) => Number.isFinite(candidate) ? clamp(candidate, minimum, maximum) : fallback;
  return {
    waveform: WAVEFORMS.has(settings.waveform) ? settings.waveform : 'preset',
    cutoffHz: number(settings.cutoffHz, 20_000, 200, 20_000),
    attackMs: number(settings.attackMs, instrument === 'pad' ? 220 : 12, 1, 1000),
    releaseMs: number(settings.releaseMs, 80, 10, 1200),
    detuneCents: number(settings.detuneCents, 0, -100, 100),
  };
}

export function instrumentWaveAt(instrument, phase, waveform = 'preset') {
  if (!Number.isFinite(phase)) return 0;
  const cycle = ((phase % 1) + 1) % 1;
  if (waveform === 'sine') return Math.sin(cycle * Math.PI * 2);
  if (waveform === 'triangle') return 1 - 4 * Math.abs(cycle - .5);
  if (waveform === 'square') return cycle < .5 ? 1 : -1;
  if (waveform === 'sawtooth') return 2 * cycle - 1;
  if (instrument === 'bass') return 2 * cycle - 1;
  if (instrument === 'pad') return 1 - 4 * Math.abs(cycle - .5);
  if (instrument === 'soft-keys') return Math.sin(cycle * Math.PI * 2) * .88 + Math.sin(cycle * Math.PI * 4) * .12;
  return Math.sin(cycle * Math.PI * 2);
}

export function renderSequencedClip(clip, { instrument = 'soft-keys', synthSettings: rawSynthSettings, bpm = 120, sampleRate = 48000, createDrumSample, samplerBuffer = null, samplerSampleRate = sampleRate, samplerRootNote = 60 } = {}) {
  if (!clip || (clip.kind !== 'drums' && clip.kind !== 'midi') || !Number.isFinite(bpm) || bpm < 40 || bpm > 240 ||
      !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) return null;
  if (instrument === 'sampler' && (!(samplerBuffer instanceof Float32Array) || samplerBuffer.length === 0 ||
      samplerBuffer.length > sampleRate * 120 || !Number.isInteger(samplerSampleRate) || samplerSampleRate < 8000 || samplerSampleRate > 192000 ||
      !Number.isInteger(samplerRootNote) || samplerRootNote < 0 || samplerRootNote > 127)) return null;
  const secondsPerBeat = 60 / bpm, clipSeconds = clip.lengthBeats * secondsPerBeat;
  if (!Number.isFinite(clipSeconds) || clipSeconds <= 0 || clipSeconds > 120) return null;
  const events = [];
  const synthSettings = clip.kind === 'midi' ? normalizeSynthSettings(rawSynthSettings, instrument) : null;
  const attackSeconds = synthSettings?.attackMs / 1000 || 0;
  const releaseSeconds = synthSettings?.releaseMs / 1000 || 0;
  const cutoffHz = synthSettings?.cutoffHz || 20_000;
  const filterCoefficient = cutoffHz >= sampleRate * .49 ? 1 : 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  let duration = clipSeconds, estimatedVoiceFrames = 0;
  if (clip.kind === 'drums') {
    if (!Array.isArray(clip.steps) || clip.steps.length > 128 || typeof createDrumSample !== 'function') return null;
    for (const [rowIndex, row] of clip.steps.entries()) {
      if (!Array.isArray(row.hits) || typeof row.kind !== 'string' || events.length + row.hits.length > 8192) return null;
      const velocity = row.velocity ?? .78;
      const { probability, ratchets } = normalizeDrumRowSettings(row);
      if (!Number.isFinite(velocity) || velocity < 0 || velocity > 1 ||
          (row.probability !== undefined && (!Number.isFinite(row.probability) || row.probability < 0 || row.probability > 1)) ||
          (row.ratchets !== undefined && (!Number.isInteger(row.ratchets) || row.ratchets < 1 || row.ratchets > 8))) return null;
      const acceptedHits = [];
      for (const hit of row.hits) {
        if (!Number.isFinite(hit) || hit < 0 || hit > 4095) return null;
        if (drumHitOccurs(clip.id, rowIndex, hit, probability)) acceptedHits.push(hit);
      }
      if (!acceptedHits.length) continue;
      const sample = createDrumSample(row.kind);
      if (!(sample instanceof Float32Array) || sample.length === 0) return null;
      for (const hit of acceptedHits) {
        const stepSeconds = secondsPerBeat / 4;
        for (let ratchet = 0; ratchet < ratchets; ratchet++) {
          const start = hit / 4 * secondsPerBeat + ratchet * stepSeconds / ratchets;
          events.push({ kind: 'drum', start, sample, velocity });
          duration = Math.max(duration, start + sample.length / sampleRate);
        }
      }
    }
  } else {
    if (!Array.isArray(clip.notes) || clip.notes.length > 8192) return null;
    for (const note of clip.notes) {
      if (!Number.isFinite(note.beat) || note.beat < 0 || !Number.isFinite(note.length) || note.length <= 0 ||
          !Number.isInteger(note.note) || note.note < 0 || note.note > 127 ||
          !Number.isFinite(note.velocity) || note.velocity < 0 || note.velocity > 1) return null;
      const start = note.beat * secondsPerBeat, noteDuration = note.length * secondsPerBeat;
      const release = synthSettings.releaseMs / 1000;
      estimatedVoiceFrames += Math.ceil((noteDuration + release) * sampleRate);
      if (estimatedVoiceFrames > 24_000_000) return null;
      events.push({ kind: 'note', start, noteDuration, release, note: note.note, velocity: note.velocity });
      duration = Math.max(duration, start + noteDuration + release);
    }
  }

  if (!Number.isFinite(duration) || duration > 120) return null;
  const output = new Float32Array(Math.ceil(duration * sampleRate));
  for (const event of events) {
    const firstFrame = Math.max(0, Math.floor(event.start * sampleRate));
    if (event.kind === 'drum') {
      const count = Math.min(event.sample.length, output.length - firstFrame);
      for (let frame = 0; frame < count; frame++) output[firstFrame + frame] += event.sample[frame] * event.velocity;
      continue;
    }
    const frequency = 440 * 2 ** ((event.note - 69 + synthSettings.detuneCents / 100) / 12), attack = attackSeconds;
    const velocity = Number.isFinite(event.velocity) ? clamp(event.velocity, 0, 1) : .7;
    const volume = .18 * velocity, releaseStartLevel = attack > 0 && event.noteDuration < attack
      ? .0001 * (Math.max(.0001, volume) / .0001) ** (event.noteDuration / attack)
      : Math.max(.0001, volume);
    const voiceFrames = Math.min(output.length - firstFrame, Math.ceil((event.noteDuration + event.release) * sampleRate));
    let filterState = 0;
    for (let frame = 0; frame < voiceFrames; frame++) {
      const time = frame / sampleRate;
      const releaseTime = Math.max(0, time - event.noteDuration);
      let envelope;
      if (releaseTime > 0) envelope = releaseStartLevel * (.0001 / releaseStartLevel) ** clamp(releaseTime / event.release, 0, 1);
      else if (time < attack) envelope = .0001 * (Math.max(.0001, volume) / .0001) ** (time / attack);
      else envelope = volume;
      let sourceSample;
      if (instrument === 'sampler') {
        const sourcePosition = time * samplerSampleRate * 2 ** ((event.note - samplerRootNote + synthSettings.detuneCents / 100) / 12);
        const sourceIndex = Math.floor(sourcePosition), fraction = sourcePosition - sourceIndex;
        sourceSample = sourceIndex < samplerBuffer.length
          ? samplerBuffer[sourceIndex] * (1 - fraction) + (samplerBuffer[sourceIndex + 1] ?? 0) * fraction
          : 0;
      } else sourceSample = instrumentWaveAt(instrument, time * frequency, synthSettings.waveform);
      filterState += filterCoefficient * (sourceSample - filterState);
      output[firstFrame + frame] += filterState * envelope;
    }
  }
  return output;
}
