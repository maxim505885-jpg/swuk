const MAX_STRETCHED_AUDIO_BYTES = 320 * 1024 * 1024;

function finiteAudioBuffer(buffer) {
  return buffer && Number.isSafeInteger(buffer.length) && buffer.length > 0 &&
    Number.isSafeInteger(buffer.numberOfChannels) && buffer.numberOfChannels > 0 &&
    Number.isFinite(buffer.sampleRate) && buffer.sampleRate >= 8000 &&
    typeof buffer.getChannelData === 'function';
}

/**
 * Render pitch-preserving tempo stretch through Signalsmith's official
 * AudioWorklet/WASM release inside an OfflineAudioContext.
 */
export async function renderTempoStretch(audioBuffer, ratio, options = {}) {
  if (!finiteAudioBuffer(audioBuffer)) throw new TypeError('A valid non-empty AudioBuffer is required');
  if (!Number.isFinite(ratio) || ratio < .5 || ratio > 2) throw new RangeError('Time-stretch ratio must be between 0.5 and 2');
  if (ratio === 1) return audioBuffer;
  const outputFrames = Math.max(1, Math.round(audioBuffer.length * ratio));
  const inputBytes = audioBuffer.length * audioBuffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
  const outputBytes = outputFrames * audioBuffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
  if (inputBytes + outputBytes > MAX_STRETCHED_AUDIO_BYTES) {
    throw new RangeError('Stretched audio exceeds the 320 MiB processing limit');
  }

  const Context = options.OfflineAudioContext || globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (typeof Context !== 'function') throw new Error('OfflineAudioContext is unavailable');
  const context = new Context(audioBuffer.numberOfChannels, outputFrames, audioBuffer.sampleRate);
  const module = await (options.loadFactory || (() => import('./native/vendor/signalsmith-stretch/web/release/SignalsmithStretch.mjs')))();
  const createStretch = typeof module === 'function' ? module : module?.default;
  if (typeof createStretch !== 'function') throw new Error('Signalsmith Stretch module could not be loaded');
  createStretch.moduleUrl = options.moduleUrl || new URL('./native/vendor/signalsmith-stretch/web/release/SignalsmithStretch.mjs', import.meta.url).href;
  const stretch = await createStretch(context, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [audioBuffer.numberOfChannels],
  });
  const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) => audioBuffer.getChannelData(index).slice());
  stretch.connect(context.destination);
  await stretch.addBuffers(channels, channels.map(channel => channel.buffer));
  await stretch.schedule({ active: true, input: 0, output: 0, rate: 1 / ratio, semitones: 0 });
  const rendered = await context.startRendering();
  if (!rendered || rendered.length !== outputFrames || rendered.numberOfChannels !== audioBuffer.numberOfChannels) {
    throw new Error('Signalsmith returned an unexpected render format');
  }
  return rendered;
}
