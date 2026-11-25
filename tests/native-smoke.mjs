import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const executable = process.env.SONORA_ENGINE_PATH
  ? resolve(process.env.SONORA_ENGINE_PATH)
  : resolve('native/build/sonora-audio-engine.exe');

function makeTestWave() {
  const frameCount = 48_000;
  const wav = Buffer.alloc(44 + frameCount * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48_000, 24); wav.writeUInt32LE(96_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(frameCount * 2, 40);
  return wav;
}

test('native engine decodes a project clip and advances WASAPI transport with digital silence', async t => {
  assert.ok(existsSync(executable), 'run npm run native:build before this smoke test');
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = [];
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => pending.shift()?.resolve(JSON.parse(line)));
  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(chunk.toString()));
  t.after(() => { if (!child.killed && child.exitCode === null) child.kill(); });

  function request(command) {
    return new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => rejectResponse(new Error(`native engine timeout; stderr: ${stderr.join('')}`)), 5000);
      pending.push({ resolve: value => { clearTimeout(timer); resolveResponse(value); } });
      child.stdin.write(`${JSON.stringify(command)}\n`, error => {
        if (error) { clearTimeout(timer); rejectResponse(error); }
      });
    });
  }

  const ping = await request({ version: 1, op: 'ping' });
  assert.equal(ping.ok, true);
  assert.equal(ping.engine, 'SONORA Native Audio');

  const vst3Status = await request({ version: 1, op: 'vst3_status' });
  assert.equal(vst3Status.ok, true);
  assert.equal(vst3Status.plugin.format, 'VST3');
  assert.equal(vst3Status.plugin.active, false);
  assert.equal(vst3Status.plugin.ready, false);

  const incompatible = await request({ version: 2, op: 'status' });
  assert.equal(incompatible.ok, false);

  const devices = await request({ version: 1, op: 'devices' });
  assert.equal(devices.ok, true);
  assert.ok(Array.isArray(devices.devices.playback));
  assert.ok(Array.isArray(devices.devices.capture));
  for (const device of [...devices.devices.playback, ...devices.devices.capture]) {
    assert.equal(typeof device.name, 'string');
    assert.equal(typeof device.default, 'boolean');
  }
  if (devices.devices.capture.length === 0) {
    const captureUnavailable = await request({ version: 1, op: 'start_capture', deviceIndex: 0, sampleRate: 48_000, channelMode: 'mono', path: 'unavailable-capture.wav' });
    assert.equal(captureUnavailable.ok, false);
    assert.match(captureUnavailable.error, /No WASAPI capture devices/);
  }

  const midiDevices = await request({ version: 1, op: 'midi_devices' });
  assert.equal(midiDevices.ok, true);
  assert.ok(Array.isArray(midiDevices.devices.inputs));
  assert.ok(Array.isArray(midiDevices.devices.outputs));
  for (const port of [...midiDevices.devices.inputs, ...midiDevices.devices.outputs]) {
    assert.equal(typeof port.name, 'string');
    assert.ok(port.name.length > 0);
  }
  const midiEvents = await request({ version: 1, op: 'midi_read' });
  assert.equal(midiEvents.ok, true);
  assert.ok(Array.isArray(midiEvents.events));
  assert.equal(typeof midiEvents.dropped, 'number');
  const invalidMidiNote = await request({ version: 1, op: 'midi_send_note', channel: 16, pitch: 60, velocity: 100, on: true });
  assert.equal(invalidMidiNote.ok, false);

  const status = await request({ version: 1, op: 'status' });
  assert.equal(status.status.backend, 'WASAPI shared');
  assert.equal(status.status.playing, false);
  assert.equal(status.status.deviceOpen, false);
  const diagnostics = await request({ version: 1, op: 'diagnostics' });
  assert.equal(diagnostics.ok, true);
  assert.ok(diagnostics.diagnostics.workingSetBytes > 0);
  assert.ok(diagnostics.diagnostics.peakWorkingSetBytes >= diagnostics.diagnostics.workingSetBytes);
  assert.ok(diagnostics.diagnostics.privateBytes > 0);

  const tempDirectory = await mkdtemp(join(tmpdir(), 'sonora-native-smoke-'));
  t.after(() => rm(tempDirectory, { recursive: true, force: true }));
  const assetPath = join(tempDirectory, 'tone.wav');
  await writeFile(assetPath, makeTestWave());
  const clear = await request({ version: 1, op: 'clear_project' });
  assert.equal(clear.ok, true);
  const asset = await request({ version: 1, op: 'load_asset', assetId: 'smoke-tone', path: assetPath });
  assert.equal(asset.ok, true);
  assert.ok(asset.frames > 0);
  const project = await request({ version: 1, op: 'set_project', masterGain: 0.75 });
  assert.equal(project.ok, true);
  const malformedAutomation = await request({ version: 1, op: 'set_track', index: 0, gain: 0.8, pan: 0, mute: false, solo: false, isBus: false, outputBusIndex: -1, reverb: false, delay: false, gainAutomation: [48_000, 0.2, 24_000, 0.8] });
  assert.equal(malformedAutomation.ok, false, 'the native protocol rejects out-of-order automation events');
  const invalidBands = await request({ version: 1, op: 'set_track', index: 0, gain: 0.8, pan: 0, mute: false, solo: false, isBus: false, outputBusIndex: -1, reverb: false, delay: false, equalizer: true, equalizerBands: [60, 0, 1] });
  assert.equal(invalidBands.ok, false, 'the native protocol requires seven complete EQ band triples');
  const invalidEq = await request({ version: 1, op: 'set_track', index: 0, gain: 0.8, pan: 0, mute: false, solo: false, isBus: false, outputBusIndex: -1, reverb: false, delay: false, equalizer: true, equalizerFrequencyHz: 1000, equalizerGainDb: 6, equalizerQ: 0 });
  assert.equal(invalidEq.ok, true, 'track settings are staged before the native graph is prepared');
  assert.equal((await request({ version: 1, op: 'commit_project' })).ok, false, 'the native graph rejects an out-of-range EQ Q');
  const invalidCompressor = await request({ version: 1, op: 'set_track', index: 0, gain: 0.8, pan: 0, mute: false, solo: false, isBus: false, outputBusIndex: -1, compressor: true, compressorThresholdDb: -18, compressorRatio: 0, compressorAttackMs: 10, compressorReleaseMs: 120, compressorMakeupDb: 0 });
  assert.equal(invalidCompressor.ok, true, 'native protocol stages compressor settings before graph validation');
  assert.equal((await request({ version: 1, op: 'commit_project' })).ok, false, 'native project validation rejects an invalid compressor ratio');
  const invalidLimiter = await request({ version: 1, op: 'set_track', index: 0, gain: 0.8, pan: 0, mute: false, solo: false, isBus: false, outputBusIndex: -1, limiter: true, limiterCeilingDb: 1, limiterReleaseMs: 80 });
  assert.equal(invalidLimiter.ok, true, 'native protocol stages limiter settings before graph validation');
  assert.equal((await request({ version: 1, op: 'commit_project' })).ok, false, 'native project validation rejects a limiter ceiling above zero dB');
  const track = await request({ version: 1, op: 'set_track', index: 0, gain: 0.8, pan: 0, mute: false, solo: false, isBus: false, outputBusIndex: -1, reverb: true, delay: true, equalizer: true, compressor: true, compressorThresholdDb: -18, compressorRatio: 4, compressorAttackMs: 10, compressorReleaseMs: 120, compressorMakeupDb: 2, limiter: true, limiterCeilingDb: -1, limiterReleaseMs: 80, equalizerFrequencyHz: 1000, equalizerGainDb: 0, equalizerQ: 1, equalizerBands: [60, 3, 1, 150, 0, 1, 400, 0, 1, 1000, 0, 1, 2400, -2, 1, 6000, 0, 1, 14000, 1, 1], gainAutomation: [0, 0.8, 48_000, 0.2] });
  assert.equal(track.ok, true);
  const invalidFades = await request({ version: 1, op: 'add_clip', assetId: 'smoke-tone', trackIndex: 0, startFrame: 0, sourceOffsetFrame: 0, durationFrames: 48_000, playbackRate: 1, gain: 1, pan: 0, fadeInFrames: 30_000, fadeOutFrames: 20_000 });
  assert.equal(invalidFades.ok, false, 'the native protocol rejects fades whose combined duration exceeds the clip');
  const invalidGainEnvelope = await request({ version: 1, op: 'add_clip', assetId: 'smoke-tone', trackIndex: 0, startFrame: 0, sourceOffsetFrame: 0, durationFrames: 48_000, playbackRate: 1, gain: 1, pan: 0, gainAutomation: [0, 1, 24_000, 0.5, 24_000, 0.25, 48_000, 1] });
  assert.equal(invalidGainEnvelope.ok, false, 'the native protocol rejects duplicate clip envelope frames');
  const clip = await request({ version: 1, op: 'add_clip', assetId: 'smoke-tone', trackIndex: 0, startFrame: 0, sourceOffsetFrame: 0, durationFrames: 48_000, playbackRate: 1, gain: 1, pan: 0, fadeInFrames: 12_000, fadeOutFrames: 12_000, gainAutomation: [0, 1, 24_000, 0.25, 48_000, 0.5] });
  assert.equal(clip.ok, true);
  const committed = await request({ version: 1, op: 'commit_project' });
  assert.equal(committed.ok, true);
  assert.equal(committed.durationFrames, 192_000, 'native playback reserves a three-second tail for per-track effects');
  assert.equal(committed.loadedAssets, 1);
  assert.ok(committed.decodedBytes > 0);
  const loadedStatus = await request({ version: 1, op: 'status' });
  assert.equal(loadedStatus.status.playing, false);
  assert.equal(loadedStatus.status.deviceOpen, false);
  assert.deepEqual(loadedStatus.status.trackPeaks, [0], 'status exposes one cleared meter value per project track');

  if (devices.devices.playback.length) {
    const started = await request({ version: 1, op: 'play_project', deviceIndex: devices.devices.playback[0].index, startFrame: 0 });
    assert.equal(started.ok, true);
    let playingStatus;
    for (let attempt = 0; attempt < 20; attempt++) {
      playingStatus = await request({ version: 1, op: 'status' });
      if (playingStatus.status.playheadFrame > 0) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(playingStatus.status.playheadFrame > 0, 'WASAPI callback advances the native project playhead');
    assert.equal(playingStatus.status.playing, true);
    assert.deepEqual(playingStatus.status.trackPeaks, [0], 'silent project reports a real zero peak for its track');
    const paused = await request({ version: 1, op: 'pause_project' });
    assert.equal(paused.status.playing, false);
    assert.ok(paused.status.playheadFrame > 0, 'pause preserves the current project position');
    const stopped = await request({ version: 1, op: 'stop_project' });
    assert.equal(stopped.status.playheadFrame, 0);
  }

  const badClip = await request({ version: 1, op: 'add_clip', assetId: 'missing', trackIndex: 0, startFrame: 0, sourceOffsetFrame: 0, durationFrames: 1, playbackRate: 1, gain: 1, pan: 0 });
  assert.equal(badClip.ok, false);

  await request({ version: 1, op: 'clear_project' });
  const replacementAsset = await request({ version: 1, op: 'load_asset', assetId: 'replacement-tone', path: assetPath });
  assert.equal(replacementAsset.ok, true);
  await request({ version: 1, op: 'set_project', masterGain: 0.75 });
  await request({ version: 1, op: 'set_track', index: 0, gain: 0.8, pan: 0, mute: false, solo: false, isBus: false, outputBusIndex: -1, reverb: false, delay: false });
  await request({ version: 1, op: 'add_clip', assetId: 'replacement-tone', trackIndex: 0, startFrame: 0, sourceOffsetFrame: 0, durationFrames: 48_000, playbackRate: 1, gain: 1, pan: 0 });
  const replacement = await request({ version: 1, op: 'commit_project' });
  assert.equal(replacement.ok, true);
  assert.equal(replacement.loadedAssets, 1, 'commit releases decoded assets that the active graph no longer references');
  assert.equal(replacement.decodedBytes, committed.decodedBytes);

  await request({ version: 1, op: 'clear_project' });
  const restoredAsset = await request({ version: 1, op: 'load_asset', assetId: 'smoke-tone', path: assetPath });
  assert.equal(restoredAsset.ok, true, 'a previously released asset can be staged again');
  await request({ version: 1, op: 'set_project', masterGain: 0.75 });
  await request({ version: 1, op: 'set_track', index: 0, gain: 0.8, pan: 0, mute: false, solo: false, isBus: false, outputBusIndex: -1, reverb: false, delay: false });
  await request({ version: 1, op: 'add_clip', assetId: 'smoke-tone', trackIndex: 0, startFrame: 0, sourceOffsetFrame: 0, durationFrames: 48_000, playbackRate: 1, gain: 1, pan: 0 });
  assert.equal((await request({ version: 1, op: 'commit_project' })).ok, true);

  for (let revision = 0; revision < 300; revision++) {
    await request({ version: 1, op: 'set_track', index: 0, gain: 0.8, pan: (revision % 3 - 1) * 0.1, mute: false, solo: false, isBus: false, outputBusIndex: -1, reverb: false, delay: false });
    const result = await request({ version: 1, op: 'commit_project' });
    assert.equal(result.ok, true, `project revision ${revision + 1} should commit without exhausting snapshot storage`);
    assert.equal(result.loadedAssets, 1);
  }

  const shutdown = await request({ version: 1, op: 'shutdown' });
  assert.equal(shutdown.shutdown, true);
});
