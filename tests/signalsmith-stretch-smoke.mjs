window.__stretchSmokePromise = (async () => {
  const sampleRate = 48000, inputFrames = 36000, ratio = 1.25, outputFrames = Math.round(inputFrames * ratio);
  try {
    const { default: createStretch } = await import('../native/vendor/signalsmith-stretch/web/release/SignalsmithStretch.mjs');
    const context = new OfflineAudioContext(1, outputFrames, sampleRate);
    const stretch = await createStretch(context, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    const input = new Float32Array(inputFrames);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate) * .7;
    await stretch.addBuffers([input]);
    stretch.connect(context.destination);
    await stretch.start(0, 0, outputFrames / sampleRate, 1 / ratio, 0);
    const rendered = await context.startRendering(), samples = rendered.getChannelData(0);
    let crossings = 0, energy = 0;
    const start = Math.floor(samples.length * .15), end = Math.floor(samples.length * .85);
    for (let i = start + 1; i < end; i++) {
      if (samples[i - 1] <= 0 && samples[i] > 0) crossings++;
      energy += samples[i] * samples[i];
    }
    const frequency = crossings * sampleRate / (end - start), rms = Math.sqrt(energy / (end - start));
    return { ok: rendered.length === outputFrames && Math.abs(frequency - 440) < 20 && rms > .2,
      inputFrames, outputFrames: rendered.length, frequency, rms };
  } catch (error) {
    return { ok: false, error: error?.stack || String(error) };
  }
})();
