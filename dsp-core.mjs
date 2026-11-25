const WINDOW_SIZE = 1024;
const SYNTHESIS_HOP = WINDOW_SIZE >> 1;
const SEARCH_RADIUS = 160;
const SEARCH_STEP = 2;
const CORRELATION_STEP = 8;

/** Pitch-shifts PCM while keeping its sample count and duration unchanged. */
export function pitchShiftChannels(channels, sampleRate, semitones) {
  if (!Array.isArray(channels) || !channels.length || !channels[0]?.length) throw new TypeError('At least one non-empty channel is required');
  if (!Number.isFinite(sampleRate) || sampleRate < 8000) throw new RangeError('Invalid sample rate');
  if (!Number.isFinite(semitones) || semitones < -24 || semitones > 24) throw new RangeError('Pitch must be between -24 and +24 semitones');
  const length = channels[0].length;
  if (channels.some(channel => channel.length !== length)) throw new RangeError('All channels must have the same length');
  if (semitones === 0) return channels.map(channel => channel.slice());

  const ratio = 2 ** (semitones / 12);
  const stretched = stretchWsola(channels, ratio);
  return stretched.map(channel => {
    const output = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const position = Math.min(channel.length - 1, i * ratio);
      const lower = Math.floor(position), upper = Math.min(channel.length - 1, lower + 1), fraction = position - lower;
      output[i] = channel[lower] * (1 - fraction) + channel[upper] * fraction;
    }
    return output;
  });
}

/** Basic monophonic vocal correction to a named major/minor scale. */
export function autoTuneChannels(channels, sampleRate, key = 'До мажор', strength = 1, speed = .75) {
  if (!Array.isArray(channels) || !channels.length || !channels[0]?.length) throw new TypeError('At least one non-empty channel is required');
  if (channels.some(channel => channel.length !== channels[0].length)) throw new RangeError('All channels must have the same length');
  strength = Math.max(0, Math.min(1, Number(strength)));
  speed = Math.max(0, Math.min(1, Number(speed)));
  if (!strength) return channels.map(channel => channel.slice());

  const sampleCount = channels[0].length, downsample = 4, detectorRate = sampleRate / downsample;
  const mono = new Float32Array(Math.ceil(sampleCount / downsample));
  for (let i = 0; i < mono.length; i++) {
    let sum = 0, count = 0;
    for (let k = 0; k < downsample; k++) {
      const sampleIndex = i * downsample + k;
      if (sampleIndex >= sampleCount) break;
      for (const channel of channels) sum += channel[sampleIndex] / channels.length;
      count++;
    }
    mono[i] = count ? sum / count : 0;
  }

  const rootAndMode = parseScale(key), frameSize = 1024, detectorHop = 128, minLag = Math.max(2, Math.floor(detectorRate / 900)), maxLag = Math.min(190, Math.floor(detectorRate / 70));
  const frames = [];
  for (let start = 0; start + frameSize <= mono.length; start += detectorHop) {
    let rms = 0; for (let i = 0; i < frameSize; i++) rms += mono[start + i] ** 2;
    rms = Math.sqrt(rms / frameSize);
    if (rms < .008) { frames.push(null); continue; }
    const difference = new Float64Array(maxLag + 1); let cumulative = 0;
    for (let lag = 1; lag <= maxLag; lag++) {
      let error = 0;
      for (let i = 0; i < frameSize - maxLag; i += 2) { const delta = mono[start + i] - mono[start + i + lag]; error += delta * delta; }
      difference[lag] = error; cumulative += error;
    }
    if (cumulative < 1e-8) { frames.push(null); continue; }
    let running = 0, bestLag = 0, bestValue = 1;
    for (let lag = 1; lag <= maxLag; lag++) {
      running += difference[lag]; difference[lag] = running ? difference[lag] * lag / running : 1;
      if (lag < minLag) continue;
      if (difference[lag] < .18) {
        while (lag + 1 <= maxLag && difference[lag + 1] < difference[lag]) lag++;
        bestLag = lag; bestValue = difference[lag]; break;
      }
      if (difference[lag] < bestValue) { bestValue = difference[lag]; bestLag = lag; }
    }
    if (!bestLag || bestValue > .32) { frames.push(null); continue; }
    const left = difference[Math.max(minLag, bestLag - 1)], center = difference[bestLag], right = difference[Math.min(maxLag, bestLag + 1)];
    const curve = left - 2 * center + right;
    const refinedLag = bestLag + (Math.abs(curve) > 1e-8 ? .5 * (left - right) / curve : 0);
    const frequency = detectorRate / refinedLag;
    if (frequency < 65 || frequency > 900) { frames.push(null); continue; }
    const midi = 69 + 12 * Math.log2(frequency / 440), target = nearestScaleNote(midi, rootAndMode.root, rootAndMode.intervals);
    const correction = (target - midi) * strength;
    frames.push(Math.abs(correction) < .035 ? 0 : correction);
  }

  const radius = Math.round((1 - speed) * 3), smoothed = frames.map((value, index) => {
    if (value === null || radius === 0) return value;
    const neighbors = frames.slice(Math.max(0, index - radius), Math.min(frames.length, index + radius + 1)).filter(item => item !== null).sort((a, b) => a - b);
    return neighbors.length ? neighbors[Math.floor(neighbors.length / 2)] : null;
  });
  const hop = detectorHop * downsample, output = channels.map(channel => channel.slice());
  const groups = [];
  for (let frame = 0; frame < smoothed.length; frame++) {
    const correction = smoothed[frame] === null ? 0 : Math.round(smoothed[frame] * 20) / 20;
    const start = frame * hop, end = Math.min(sampleCount, (frame + 1) * hop);
    const last = groups.at(-1);
    if (last && last.correction === correction) last.end = end;
    else groups.push({ start, end, correction });
  }
  if (groups.length) groups.at(-1).end = sampleCount;
  for (const group of groups) {
    if (!group.correction || group.end - group.start < 4096) continue;
    const shifted = pitchShiftChannels(channels.map(channel => channel.slice(group.start, group.end)), sampleRate, group.correction);
    shifted.forEach((channel, index) => output[index].set(channel, group.start));
    group.rendered = shifted;
  }
  const fadeLength = Math.round(sampleRate * .018);
  for (let index = 1; index < groups.length; index++) {
    const boundary = groups[index].start, left = groups[index - 1], right = groups[index];
    const begin = Math.max(left.start, boundary - fadeLength), end = Math.min(right.end, boundary + fadeLength), span = Math.max(1, end - begin);
    if (!left.rendered && !right.rendered) continue;
    for (let sample = begin; sample < end; sample++) {
      const amount = (sample - begin) / span;
      for (let channel = 0; channel < channels.length; channel++) {
        const leftValue = left.rendered ? left.rendered[channel][sample - left.start] : channels[channel][sample];
        const rightValue = right.rendered ? right.rendered[channel][sample - right.start] : channels[channel][sample];
        output[channel][sample] = leftValue * (1 - amount) + rightValue * amount;
      }
    }
  }
  return output;
}

function parseScale(key) {
  const scales = {
    'До мажор': { root: 0, intervals: [0, 2, 4, 5, 7, 9, 11] },
    'Ре минор': { root: 2, intervals: [0, 2, 3, 5, 7, 8, 10] },
    'Соль мажор': { root: 7, intervals: [0, 2, 4, 5, 7, 9, 11] },
    'Ля минор': { root: 9, intervals: [0, 2, 3, 5, 7, 8, 10] },
  };
  return scales[key] || scales['До мажор'];
}

function nearestScaleNote(midi, root, intervals) {
  let best = Math.round(midi), distance = Infinity;
  for (let note = Math.floor(midi) - 12; note <= Math.ceil(midi) + 12; note++) {
    const pitchClass = ((note - root) % 12 + 12) % 12;
    if (!intervals.includes(pitchClass)) continue;
    const candidateDistance = Math.abs(note - midi);
    if (candidateDistance < distance) { best = note; distance = candidateDistance; }
  }
  return best;
}

function stretchWsola(channels, factor) {
  const inputLength = channels[0].length;
  const outputLength = Math.max(WINDOW_SIZE, Math.round(inputLength * factor));
  const output = channels.map(() => new Float32Array(outputLength));
  const weights = new Float32Array(outputLength);
  const window = new Float32Array(WINDOW_SIZE);
  for (let i = 0; i < WINDOW_SIZE; i++) window[i] = .5 - .5 * Math.cos(2 * Math.PI * i / (WINDOW_SIZE - 1));

  const maxStart = Math.max(0, inputLength - WINDOW_SIZE);
  let sourcePosition = 0;
  for (let outputPosition = 0; outputPosition < outputLength; outputPosition += SYNTHESIS_HOP) {
    const predicted = Math.round(outputPosition / factor);
    sourcePosition = outputPosition === 0 ? 0 : findBestOffset(channels, output, weights, outputPosition, predicted, maxStart);
    const end = Math.min(WINDOW_SIZE, outputLength - outputPosition, inputLength - sourcePosition);
    for (let i = 0; i < end; i++) {
      const weight = window[i], target = outputPosition + i;
      weights[target] += weight;
      for (let channel = 0; channel < channels.length; channel++) output[channel][target] += channels[channel][sourcePosition + i] * weight;
    }
  }

  for (let channel = 0; channel < channels.length; channel++) {
    for (let i = 0; i < outputLength; i++) if (weights[i] > 1e-6) output[channel][i] /= weights[i];
  }
  return output;
}

function findBestOffset(channels, output, weights, outputPosition, predicted, maxStart) {
  const low = Math.max(0, Math.min(maxStart, predicted - SEARCH_RADIUS));
  const high = Math.max(low, Math.min(maxStart, predicted + SEARCH_RADIUS));
  let best = Math.max(0, Math.min(maxStart, predicted)), bestScore = -Infinity;
  for (let candidate = low; candidate <= high; candidate += SEARCH_STEP) {
    let dot = 0, targetEnergy = 0, candidateEnergy = 0;
    for (let i = 0; i < SYNTHESIS_HOP; i += CORRELATION_STEP) {
      const index = outputPosition + i;
      if (index >= weights.length || weights[index] <= .05) continue;
      let target = 0, sample = 0;
      for (let channel = 0; channel < channels.length; channel++) {
        target += output[channel][index] / weights[index];
        sample += channels[channel][candidate + i] || 0;
      }
      target /= channels.length; sample /= channels.length;
      dot += target * sample; targetEnergy += target * target; candidateEnergy += sample * sample;
    }
    const score = targetEnergy && candidateEnergy ? dot / Math.sqrt(targetEnergy * candidateEnergy) : -Infinity;
    if (score > bestScore) { bestScore = score; best = candidate; }
  }
  return best;
}
