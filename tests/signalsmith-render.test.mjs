import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTempoStretch } from '../signalsmith-render.mjs';

function sourceBuffer({ length = 48000, channels = 1, sampleRate = 48000 } = {}) {
  const data = Array.from({ length: channels }, (_, channel) => Float32Array.from({ length }, (_, index) => Math.sin(index / 20 + channel)));
  return {
    length, numberOfChannels: channels, sampleRate,
    getChannelData(index) { return data[index]; },
    data,
  };
}

function harness(outputLength = 60000) {
  const calls = {}, rendered = { length: outputLength, numberOfChannels: 2, sampleRate: 48000 };
  class FakeOfflineAudioContext {
    constructor(channels, length, sampleRate) {
      calls.context = { channels, length, sampleRate };
      this.destination = {};
    }
    async startRendering() { calls.rendered = true; return { ...rendered, length: calls.context.length, numberOfChannels: calls.context.channels, sampleRate: calls.context.sampleRate }; }
  }
  const loadFactory = async () => {
    const factory = async (context, options) => {
      calls.options = options; calls.moduleUrl = factory.moduleUrl;
      return {
        async addBuffers(channels) { calls.buffers = channels; },
        connect(destination) { calls.destination = destination; },
        async start(...args) { calls.start = args; },
      };
    };
    return factory;
  };
  return { calls, rendered, FakeOfflineAudioContext, loadFactory };
}

test('Signalsmith renderer schedules stretch ratio and preserves source channel content', async () => {
  const h = harness(), input = sourceBuffer({ channels: 2 });
  const output = await renderTempoStretch(input, 1.25, { OfflineAudioContext: h.FakeOfflineAudioContext, loadFactory: h.loadFactory });
  assert.equal(h.calls.context.channels, 2);
  assert.equal(h.calls.context.length, 60000);
  assert.deepEqual(h.calls.options, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  assert.match(h.calls.moduleUrl, /native\/vendor\/signalsmith-stretch\/web\/release\/SignalsmithStretch\.mjs$/);
  assert.deepEqual(h.calls.start, [0, 0, 1.25, .8, 0]);
  assert.equal(h.calls.buffers.length, 2);
  assert.notEqual(h.calls.buffers[0].buffer, input.data[0].buffer);
  assert.equal(output.length, 60000);
  assert.equal(h.calls.rendered, true);
});

test('Signalsmith renderer returns the original buffer for a neutral ratio', async () => {
  const input = sourceBuffer(), h = harness();
  assert.equal(await renderTempoStretch(input, 1, { OfflineAudioContext: h.FakeOfflineAudioContext, loadFactory: h.loadFactory }), input);
  assert.equal(h.calls.context, undefined);
});

test('Signalsmith renderer validates buffers, ratios, and memory bounds', async () => {
  const h = harness();
  await assert.rejects(renderTempoStretch(null, 1, h), /AudioBuffer/);
  await assert.rejects(renderTempoStretch(sourceBuffer(), .25, h), /between 0.5 and 2/);
  const huge = { length: 25_000_000, numberOfChannels: 2, sampleRate: 48000, getChannelData() { throw new Error('Must reject before reading source data'); } };
  await assert.rejects(renderTempoStretch(huge, 2, h), /320 MiB/);
});
