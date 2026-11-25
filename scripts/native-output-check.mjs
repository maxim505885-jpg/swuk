import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function readArguments(argv) {
  let enginePath = '';
  let playTone = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--engine') enginePath = argv[++index] || '';
    else if (argv[index] === '--play-audible-tone') playTone = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!enginePath || !playTone) {
    throw new Error('Usage: node scripts/native-output-check.mjs --engine <sonora-audio-engine.exe> --play-audible-tone');
  }
  return path.resolve(enginePath);
}

function createLowLevelToneWav() {
  const sampleRate = 48_000;
  const frameCount = sampleRate / 2;
  const dataBytes = frameCount * 4;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 1638);
    wav.writeInt16LE(sample, 44 + frame * 4);
    wav.writeInt16LE(sample, 46 + frame * 4);
  }
  return { wav, sampleRate, frameCount };
}

async function main() {
  const enginePath = readArguments(process.argv.slice(2));
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sonora-native-output-'));
  const wavPath = path.join(tempDir, 'output-check.wav');
  const tone = createLowLevelToneWav();
  await writeFile(wavPath, tone.wav, { flag: 'wx' });

  const child = spawn(enginePath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let activeRequest = null;
  let streamError = null;

  lines.on('line', line => {
    const request = activeRequest;
    if (!request) return;
    activeRequest = null;
    clearTimeout(request.timer);
    try { request.resolve(JSON.parse(line)); }
    catch { request.reject(new Error('Audio engine returned invalid JSON')); }
  });
  child.stderr.on('data', () => {});
  child.once('error', error => {
    streamError = error;
    activeRequest?.reject(error);
    activeRequest = null;
  });
  child.once('close', code => {
    if (activeRequest) {
      clearTimeout(activeRequest.timer);
      activeRequest.reject(new Error(`Audio engine exited before replying (${code ?? 'unknown'})`));
      activeRequest = null;
    }
  });

  const request = (op, payload = {}) => new Promise((resolve, reject) => {
    if (streamError) { reject(streamError); return; }
    if (activeRequest) { reject(new Error('Only one engine request may be outstanding')); return; }
    const current = { resolve, reject, timer: null };
    current.timer = setTimeout(() => {
      if (activeRequest !== current) return;
      activeRequest = null;
      reject(new Error(`Audio engine timed out during ${op}`));
      child.kill();
    }, 5000);
    activeRequest = current;
    child.stdin.write(`${JSON.stringify({ version: 1, op, ...payload })}\n`, error => {
      if (!error || activeRequest !== current) return;
      activeRequest = null;
      clearTimeout(current.timer);
      reject(error);
      child.kill();
    });
  });

  let shutdownRequested = false;
  try {
    const devices = await request('devices');
    if (!devices.ok) throw new Error(devices.error || 'Could not enumerate WASAPI outputs');
    const output = devices.devices?.playback?.find(device => device.default) ?? devices.devices?.playback?.[0];
    if (!output) throw new Error('No WASAPI playback output is available');

    const commands = [
      ['load_asset', { assetId: 'qa-output-tone', path: wavPath }],
      ['set_project', { masterGain: 0.8 }],
      ['set_track', { index: 0, gain: 0.8, pan: 0, mute: false, solo: false, reverb: false, delay: false }],
      ['add_clip', { assetId: 'qa-output-tone', trackIndex: 0, startFrame: 0, sourceOffsetFrame: 0, durationFrames: tone.frameCount, playbackRate: 1, gain: 1, pan: 0 }],
      ['commit_project'],
    ];
    for (const [op, payload] of commands) {
      const response = await request(op, payload);
      if (!response.ok) throw new Error(`${op} failed: ${response.error || 'unknown error'}`);
    }

    const started = await request('play_project', { deviceIndex: output.index, startFrame: 0 });
    if (!started.ok || !started.status?.deviceOpen) throw new Error(`WASAPI could not start: ${started.error || 'output stayed closed'}`);

    let maxPeak = 0;
    let maxPlayhead = 0;
    let completed = false;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      await delay(30);
      const response = await request('status');
      if (!response.ok) throw new Error(response.error || 'Could not read WASAPI status');
      const status = response.status;
      maxPeak = Math.max(maxPeak, status?.peak || 0);
      maxPlayhead = Math.max(maxPlayhead, status?.playheadFrame || 0);
      if (maxPeak > 0.01 && maxPlayhead >= tone.frameCount && status?.playing === false) {
        completed = true;
        break;
      }
    }

    const stopped = await request('stop_project');
    if (!stopped.ok || stopped.status?.playing) throw new Error('WASAPI project transport did not stop cleanly');
    const closed = await request('stop');
    if (!closed.ok || closed.status?.deviceOpen) throw new Error('WASAPI output device did not close cleanly');
    const shutdown = await request('shutdown');
    if (!shutdown.ok) throw new Error(shutdown.error || 'Audio engine did not shut down cleanly');
    shutdownRequested = true;
    child.stdin.end();
    await once(child, 'close');

    if (!completed) throw new Error(`No complete non-silent project render observed (peak=${maxPeak}, frames=${maxPlayhead})`);
    console.log(JSON.stringify({
      status: 'PASS',
      output: output.name,
      backend: started.status.backend,
      sampleRate: tone.sampleRate,
      renderedFrames: maxPlayhead,
      peak: maxPeak,
      toneSeconds: tone.frameCount / tone.sampleRate,
      note: 'A short 440 Hz test tone was sent to the selected Windows output; software metering cannot confirm what was audible at the speakers.',
    }, null, 2));
  } finally {
    if (!shutdownRequested && child.exitCode === null && !child.killed) {
      try { await request('stop_project'); } catch {}
      try { await request('shutdown'); } catch {}
      child.stdin.end();
      const forceExitTimer = setTimeout(() => child.kill(), 1000);
      forceExitTimer.unref?.();
      if (child.exitCode === null) await Promise.race([once(child, 'close'), delay(1100)]);
      clearTimeout(forceExitTimer);
    }
    lines.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`Native output check failed: ${error.message}`);
  process.exitCode = 1;
});
