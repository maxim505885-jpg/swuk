import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const renderer = resolve('native/build/sonora-clap-offline.exe');
const plugin = resolve('native/build/sonora-clap-test-gain.clap');
const realtimeBridge = resolve('native/build/sonora-realtime-clap-bridge-tests.exe');

function makeToneWav(frameCount = 4_800) {
  const channels = 2, rate = 48_000, bytes = Buffer.alloc(44 + frameCount * channels * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels * 2, 28); bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frameCount * channels * 2, 40);
  for (let frame = 0; frame < frameCount; frame++) {
    const sample = Math.round(Math.sin(frame * 2 * Math.PI * 440 / rate) * 12_000);
    bytes.writeInt16LE(sample, 44 + frame * channels * 2); bytes.writeInt16LE(sample, 46 + frame * channels * 2);
  }
  return bytes;
}

function runRenderer(args) {
  return new Promise(resolveRun => {
    const child = spawn(renderer, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => resolveRun({ code: null, error, stdout: '', stderr: '' }));
    child.on('close', code => resolveRun({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

function runRealtimeBridge(args) {
  return new Promise(resolveRun => {
    const child = spawn(realtimeBridge, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => resolveRun({ code: null, error, stdout: '', stderr: '' }));
    child.on('close', code => resolveRun({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

test('native master insert keeps a fixed latency and processes CLAP blocks out of process', { skip: !existsSync(realtimeBridge) || !existsSync(plugin) }, async () => {
  const result = await runRealtimeBridge([plugin]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true, isolatedProcess: true, masterInsert: true, pipelineLatencyFrames: 512,
  });
});

test('CLAP realtime helper processes shared audio blocks in a separate process', { skip: !existsSync(renderer) || !existsSync(plugin) }, async () => {
  const result = await runRenderer(['selftest', plugin]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, isolatedProcess: true, frames: 32 });
});

test('isolated CLAP helper applies a stereo effect and preserves its reported tail in PCM WAV', { skip: !existsSync(renderer) || !existsSync(plugin) }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sonora-clap-render-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'input.wav'), output = join(directory, 'output.wav');
  await writeFile(input, makeToneWav());

  const inspected = await runRenderer(['inspect', plugin]);
  assert.equal(inspected.code, 0, inspected.stderr);
  const pluginInfo = JSON.parse(inspected.stdout);
  assert.equal(pluginInfo.pluginId, 'com.sonora.test.gain');
  assert.deepEqual(pluginInfo.parameters.map(({ id, name, min, max, value }) => ({ id, name, min, max, value })), [
    { id: 1, name: 'Gain', min: 0, max: 1, value: 0.5 },
  ]);

  const result = await runRenderer(['process', plugin, input, output]);

  assert.equal(result.code, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true);
  assert.equal(response.pluginName, 'SONORA Test Gain');
  assert.equal(response.pluginId, pluginInfo.pluginId);
  assert.equal(response.sampleRate, 48_000);
  assert.equal(response.frames, 4_800 + 256);
  const wav = await readFile(output);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), 48_000);
  assert.equal(wav.readUInt32LE(40) / 4, response.frames);
  const source = makeToneWav();
  const frame = 101;
  const inputSample = source.readInt16LE(44 + frame * 4);
  const outputSample = wav.readInt16LE(44 + frame * 4);
  assert.ok(Math.abs(outputSample / inputSample - 0.5) < 0.01, 'the CLAP effect applies its default half-gain');

  const adjustedOutput = join(directory, 'adjusted.wav');
  const adjusted = await runRenderer(['process', plugin, input, adjustedOutput, '1=0.75']);
  assert.equal(adjusted.code, 0, adjusted.stderr);
  const adjustedWav = await readFile(adjustedOutput);
  const adjustedSample = adjustedWav.readInt16LE(44 + frame * 4);
  assert.ok(Math.abs(adjustedSample / inputSample - 0.75) < 0.01, 'the host sends CLAP parameter events before the first audio block');
});

test('CLAP helper rejects a non-plugin module without crashing its caller', { skip: !existsSync(renderer) }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sonora-clap-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const invalid = join(directory, 'invalid.clap'), input = join(directory, 'input.wav'), output = join(directory, 'output.wav');
  await writeFile(invalid, 'not a dynamic library'); await writeFile(input, makeToneWav(32));

  const result = await runRenderer(['process', invalid, input, output]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /load this CLAP module|clap_entry/);
});

