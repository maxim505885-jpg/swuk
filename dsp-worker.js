import { autoTuneChannels, pitchShiftChannels, timeStretchChannels } from './dsp-core.mjs';

self.addEventListener('message', event => {
  const { id, channels, sampleRate, semitones, factor, mode, key, strength, speed } = event.data;
  try {
    const input = channels.map(buffer => new Float32Array(buffer));
    const output = mode === 'autotune'
      ? autoTuneChannels(input, sampleRate, key, strength, speed)
      : mode === 'stretch'
        ? timeStretchChannels(input, factor)
        : pitchShiftChannels(input, sampleRate, semitones);
    const buffers = output.map(channel => channel.buffer);
    self.postMessage({ id, channels: buffers, sampleRate }, buffers);
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
});
