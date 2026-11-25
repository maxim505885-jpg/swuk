import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../record-worklet.js', import.meta.url), 'utf8');

function loadProcessor(channelMode = 'mono') {
  let processorClass;
  const sent = [];
  class AudioWorkletProcessor {
    constructor(options = {}) {
      this.options = options;
      this.port = {
        postMessage: (data, transfer) => sent.push({ data, transfer }),
        close() {},
      };
    }
  }
  vm.runInNewContext(source, {
    AudioWorkletProcessor,
    registerProcessor: (name, implementation) => {
      assert.equal(name, 'sonora-record-processor');
      processorClass = implementation;
    },
  });
  return { processor: new processorClass({ processorOptions: { channelMode } }), sent };
}

test('record worklet batches mono input, transfers copies and emits silence', () => {
  const { processor, sent } = loadProcessor();
  const input = Float32Array.from({ length: 128 }, (_, index) => index / 128);
  const output = new Float32Array(128).fill(1);

  for (let block = 0; block < 16; block++) assert.equal(processor.process([[input]], [[output]]), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.length, 2048);
  assert.deepEqual([...sent[0].data.slice(0, 128)], [...input]);
  assert.deepEqual([...sent[0].data.slice(-128)], [...input]);
  assert.notEqual(sent[0].data.buffer, input.buffer);
  assert.equal(sent[0].transfer.length, 1);
  assert.equal(sent[0].transfer[0], sent[0].data.buffer);
  assert.deepEqual([...output], new Array(128).fill(0));
  processor.port.onmessage({ data: 'stop' });
  assert.equal(processor.process([[input]], [[output]]), false);
  assert.equal(sent.at(-1).data.type, 'stopped');
});

test('record worklet flushes a final partial chunk and stays silent without input', () => {
  const { processor, sent } = loadProcessor();
  const input = Float32Array.from({ length: 300 }, (_, index) => index / 300);
  const output = new Float32Array(300).fill(1);

  assert.equal(processor.process([[input]], [[output]]), true);
  assert.equal(sent.length, 0);
  processor.port.onmessage({ data: 'stop' });
  assert.equal(sent[0].data.length, 300);
  assert.deepEqual([...sent[0].data], [...input]);
  assert.equal(sent[1].data.type, 'stopped');
  assert.equal(processor.process([[]], [[output]]), false);
  assert.deepEqual([...output], new Array(300).fill(0));
});

test('record worklet selects the right input channel and averages stereo to mono', () => {
  const left = new Float32Array(128).fill(0.2);
  const right = new Float32Array(128).fill(0.8);
  const output = new Float32Array(128).fill(1);
  const selected = loadProcessor('right');
  for (let block = 0; block < 16; block++) selected.processor.process([[left, right]], [[output]]);
  assert.ok(Math.abs(selected.sent[0].data[0] - 0.8) < 1e-6);

  const mono = loadProcessor('mono');
  mono.processor.process([[left, right]], [[output]]);
  mono.processor.port.onmessage({ data: 'stop' });
  assert.ok(Math.abs(mono.sent[0].data[0] - 0.5) < 1e-6);
});

test('record worklet captures stereo pairs, transfers both channels and silences both outputs', () => {
  const { processor, sent } = loadProcessor('stereo');
  const left = new Float32Array(128).fill(0.25), right = new Float32Array(128).fill(-0.5);
  const outputLeft = new Float32Array(128).fill(1), outputRight = new Float32Array(128).fill(1);
  for (let block = 0; block < 16; block++) processor.process([[left, right]], [[outputLeft, outputRight]]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.type, 'audio');
  assert.equal(sent[0].data.channels.length, 2);
  assert.equal(sent[0].data.channels[0].length, 2048);
  assert.deepEqual([...sent[0].data.channels[0].slice(0, 128)], [...left]);
  assert.deepEqual([...sent[0].data.channels[1].slice(0, 128)], [...right]);
  assert.equal(sent[0].transfer.length, 2);
  assert.deepEqual([...outputLeft], new Array(128).fill(0));
  assert.deepEqual([...outputRight], new Array(128).fill(0));
});
