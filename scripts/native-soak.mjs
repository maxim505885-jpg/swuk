import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const executable = process.env.SONORA_ENGINE_PATH
  ? resolve(process.env.SONORA_ENGINE_PATH)
  : resolve('native/build/sonora-audio-engine.exe');
const requestedDuration = Number(process.env.SONORA_SOAK_DURATION_MS || 120_000);
if (!Number.isFinite(requestedDuration) || requestedDuration < 10_000 || requestedDuration > 600_000) {
  throw new Error('SONORA_SOAK_DURATION_MS must be between 10000 and 600000.');
}

function makeSilentWave(durationMs) {
  const frames = Math.ceil(durationMs / 1000) * 48_000;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48_000, 24); wav.writeUInt32LE(96_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
  return wav;
}

if (!existsSync(executable)) throw new Error(`Native engine not found: ${executable}`);

const directory = await mkdtemp(join(tmpdir(), 'sonora-native-soak-'));
const assetPath = join(directory, 'silence.wav');
const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = [];
const stderr = [];
const memorySamples = [];
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const processExit = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
lines.on('line', line => {
  let response;
  try { response = JSON.parse(line); }
  catch (error) { pending.shift()?.reject(new Error(`Invalid engine response: ${line}`, { cause: error })); return; }
  pending.shift()?.resolve(response);
});
child.stderr.on('data', chunk => stderr.push(chunk.toString()));
child.on('error', error => { while (pending.length) pending.shift().reject(error); });
child.on('exit', (code, signal) => {
  const error = new Error(`Audio engine exited (code=${code}, signal=${signal}): ${stderr.join('')}`);
  while (pending.length) pending.shift().reject(error);
});

function request(command) {
  return new Promise((resolveResponse, rejectResponse) => {
    const timer = setTimeout(() => {
      const index = pending.findIndex(item => item.resolveResponse === resolveResponse);
      if (index >= 0) pending.splice(index, 1);
      rejectResponse(new Error(`Native engine request timed out: ${command.op}; ${stderr.join('')}`));
    }, 10_000);
    pending.push({
      resolveResponse,
      resolve: value => { clearTimeout(timer); resolveResponse(value); },
      reject: error => { clearTimeout(timer); rejectResponse(error); },
    });
    child.stdin.write(`${JSON.stringify(command)}\n`, error => {
      if (!error) return;
      const index = pending.findIndex(item => item.resolveResponse === resolveResponse);
      if (index >= 0) pending.splice(index, 1);
      clearTimeout(timer); rejectResponse(error);
    });
  });
}

async function sampleProcessMemory() {
  const response = await request({ version: 1, op: 'diagnostics' });
  const { workingSetBytes, peakWorkingSetBytes, privateBytes } = response.diagnostics || {};
  if (!response.ok || ![workingSetBytes, peakWorkingSetBytes, privateBytes].every(Number.isFinite)) {
    throw new Error(`Native process memory diagnostics failed: ${response.error || 'incomplete memory counters'}`);
  }
  memorySamples.push({ elapsedMs: Date.now() - startTimeForMetrics, workingSetBytes, peakWorkingSetBytes, privateBytes });
}

let shutdownRequested = false;
let startTimeForMetrics = Date.now();
try {
  await writeFile(assetPath, makeSilentWave(requestedDuration + 10_000));
  const ping = await request({ version: 1, op: 'ping' });
  if (!ping.ok) throw new Error(ping.error || 'Native engine ping failed');
  const devices = await request({ version: 1, op: 'devices' });
  if (!devices.ok) throw new Error(devices.error || 'WASAPI device enumeration failed');
  const output = devices.devices?.playback?.find(device => device.default) || devices.devices?.playback?.[0];
  if (!output) throw new Error('No WASAPI playback device is available for the silent soak run.');

  for (const [op, payload] of [
    ['clear_project', {}],
    ['load_asset', { assetId: 'soak-silence', path: assetPath }],
    ['set_project', { masterGain: 0 }],
    ['set_track', { index: 0, gain: 1, pan: 0, mute: false, solo: false, reverb: false, delay: false }],
    ['add_clip', { assetId: 'soak-silence', trackIndex: 0, startFrame: 0, sourceOffsetFrame: 0, durationFrames: Math.ceil((requestedDuration + 10_000) / 1000) * 48_000, playbackRate: 1, gain: 1, pan: 0 }],
  ]) {
    const response = await request({ version: 1, op, ...payload });
    if (!response.ok) throw new Error(`${op} failed: ${response.error || 'unknown engine error'}`);
  }
  const committed = await request({ version: 1, op: 'commit_project' });
  if (!committed.ok) throw new Error(`commit_project failed: ${committed.error || 'unknown engine error'}`);
  if (committed.decodedBytes < 1) throw new Error('The silent asset was not decoded.');

  const started = await request({ version: 1, op: 'play_project', deviceIndex: output.index, startFrame: 0 });
  if (!started.ok) throw new Error(`WASAPI playback start failed: ${started.error || 'unknown engine error'}`);
  const startTime = Date.now();
  startTimeForMetrics = startTime;
  let lastSampleTime = startTime;
  let previousFrame = 0;
  let polls = 0;
  let minimumFrameAdvance = Number.POSITIVE_INFINITY;
  await sampleProcessMemory();

  while (Date.now() - startTime < requestedDuration) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1000));
    const response = await request({ version: 1, op: 'status' });
    if (!response.ok) throw new Error(`status failed: ${response.error || 'unknown engine error'}`);
    const status = response.status;
    if (!status.playing || !status.deviceOpen) throw new Error(`Playback stopped unexpectedly at frame ${status.playheadFrame}.`);
    const frameAdvance = status.playheadFrame - previousFrame;
    if (frameAdvance <= 0) throw new Error(`WASAPI playhead stopped advancing at frame ${status.playheadFrame}.`);
    minimumFrameAdvance = Math.min(minimumFrameAdvance, frameAdvance);
    previousFrame = status.playheadFrame;
    polls++;
    if (Date.now() - lastSampleTime >= 10_000) { await sampleProcessMemory(); lastSampleTime = Date.now(); }
  }

  const stopped = await request({ version: 1, op: 'stop_project' });
  if (!stopped.ok || stopped.status?.playing || stopped.status?.playheadFrame !== 0) {
    throw new Error(`WASAPI did not stop cleanly: ${JSON.stringify(stopped.status)}`);
  }
  const shutdown = await request({ version: 1, op: 'shutdown' });
  shutdownRequested = true;
  if (!shutdown.shutdown) throw new Error('Native engine did not acknowledge shutdown.');
  const exited = await Promise.race([
    processExit,
    new Promise(resolveExit => setTimeout(() => resolveExit(null), 5000)),
  ]);
  if (!exited || exited.code !== 0) throw new Error(`Native engine did not exit cleanly: ${JSON.stringify(exited)}`);

  console.log(JSON.stringify({
    result: 'PASS', durationMs: Date.now() - startTime, polls,
    finalPlayheadFrames: previousFrame, minimumOneSecondFrameAdvance: minimumFrameAdvance,
    memory: memorySamples.length ? {
      samples: memorySamples.length,
      workingSetBytes: {
        first: memorySamples[0].workingSetBytes,
        last: memorySamples.at(-1).workingSetBytes,
        delta: memorySamples.at(-1).workingSetBytes - memorySamples[0].workingSetBytes,
        highestObserved: Math.max(...memorySamples.map(sample => sample.workingSetBytes)),
        processPeak: Math.max(...memorySamples.map(sample => sample.peakWorkingSetBytes)),
      },
      privateBytes: {
        first: memorySamples[0].privateBytes,
        last: memorySamples.at(-1).privateBytes,
        delta: memorySamples.at(-1).privateBytes - memorySamples[0].privateBytes,
        highestObserved: Math.max(...memorySamples.map(sample => sample.privateBytes)),
      },
    } : null,
    output: output.name, audioContent: 'digital silence', shutdownExitCode: exited.code,
  }, null, 2));
} finally {
  if (!shutdownRequested && child.exitCode === null) {
    try { await request({ version: 1, op: 'shutdown' }); } catch { child.kill(); }
  }
  if (child.exitCode === null) child.kill();
  await rm(directory, { recursive: true, force: true });
}
