const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const { createReadStream, existsSync, statSync } = require('node:fs');
const { readFile, unlink, writeFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { extname, join, resolve, sep } = require('node:path');
const { createSerializedJsonClient } = require('./serialized-json-client.cjs');

const WEB_ROOT = resolve(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const MAX_NATIVE_ASSET_BYTES = 256 * 1024 * 1024;
const MAX_NATIVE_PROJECT_TRACKS = 128;
const MAX_NATIVE_PROJECT_CLIPS = 8192;

let server;
let windowInstance;
let audioEngineProcess;
let quitting = false;
let activeNativeCapturePath = null;
const clapSelections = new Map();
const audioEngineClient = createSerializedJsonClient({
  onDisconnect: child => { if (audioEngineProcess === child) audioEngineProcess = null; },
  onTimeout: child => child.kill(),
});

function startAudioEngine() {
  if (audioEngineProcess && !audioEngineProcess.killed && !audioEngineProcess.stdin.destroyed) return;
  const executable = app.isPackaged
    ? join(process.resourcesPath, 'engine', 'sonora-audio-engine.exe')
    : join(WEB_ROOT, 'native', 'build', 'sonora-audio-engine.exe');
  if (!existsSync(executable)) return;

  const child = spawn(executable, [], {
    cwd: app.getPath('userData'),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  audioEngineProcess = child;
  audioEngineClient.attach(child);
  child.stderr.on('data', () => {});
}

function requestAudioEngine(operation, payload = {}) {
  if ((!audioEngineProcess || audioEngineProcess.killed || audioEngineProcess.stdin.destroyed) && !quitting) startAudioEngine();
  if (!audioEngineProcess || audioEngineProcess.killed || audioEngineProcess.stdin.destroyed) {
    return Promise.resolve({ ok: false, error: 'Нативный аудиодвижок не запущен' });
  }
  return audioEngineClient.request({ version: 1, op: operation, ...payload });
}

function isFiniteRange(value, minimum, maximum) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function validNativeAssetId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function getWavBuffer(value) {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function runClapHelper(helper, args) {
  return new Promise(resolveResult => {
    const child = spawn(helper, args, { cwd: app.getPath('temp'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolveResult(value); };
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-512 * 1024); });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16 * 1024); });
    child.once('error', () => finish({ error: 'Не удалось запустить CLAP-обработчик' }));
    child.once('close', code => finish(code === 0 ? { stdout } : { error: stderr.trim().slice(-2000) || `CLAP-обработчик завершился (${code ?? 'unknown'})` }));
    const timer = setTimeout(() => { child.kill(); finish({ error: 'Обработка CLAP заняла больше 120 секунд' }); }, 120_000);
    timer.unref();
  });
}

function parseClapDescription(value) {
  if (!value?.ok || typeof value.pluginId !== 'string' || value.pluginId.length > 512 || typeof value.pluginName !== 'string' ||
      value.pluginName.length > 256 || !Array.isArray(value.parameters) || value.parameters.length > 128) return null;
  const parameters = [];
  const seen = new Set();
  for (const parameter of value.parameters) {
    if (!Number.isInteger(parameter?.id) || parameter.id < 0 || parameter.id > 0xffffffff || seen.has(parameter.id) ||
        typeof parameter.name !== 'string' || parameter.name.length > 256 || typeof parameter.module !== 'string' || parameter.module.length > 256 ||
        !isFiniteRange(parameter.min, -1e15, 1e15) || !isFiniteRange(parameter.max, -1e15, 1e15) || parameter.min >= parameter.max ||
        !isFiniteRange(parameter.value, parameter.min, parameter.max) || !isFiniteRange(parameter.defaultValue, parameter.min, parameter.max) ||
        typeof parameter.stepped !== 'boolean') return null;
    seen.add(parameter.id);
    parameters.push({ id: parameter.id, name: parameter.name, module: parameter.module, min: parameter.min, max: parameter.max,
      value: parameter.value, defaultValue: parameter.defaultValue, stepped: parameter.stepped });
  }
  return { pluginId: value.pluginId, pluginName: value.pluginName, parameters };
}

async function stageNativeAsset(assetId, value) {
  if (!validNativeAssetId(assetId)) return { ok: false, error: 'Недопустимый идентификатор аудиофайла' };
  const bytes = getWavBuffer(value);
  if (!bytes || bytes.length < 44 || bytes.length > MAX_NATIVE_ASSET_BYTES || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, error: 'Нативный движок принимает WAV до 256 МиБ' };
  }
  const path = join(app.getPath('temp'), `sonora-${randomUUID()}.wav`);
  try {
    await writeFile(path, bytes, { flag: 'wx' });
    return await requestAudioEngine('load_asset', { assetId, path });
  } catch {
    return { ok: false, error: 'Не удалось подготовить аудиофайл для WASAPI' };
  } finally {
    try { await unlink(path); } catch {}
  }
}

function validClipGainAutomation(points, durationFrames) {
  if (points === undefined) return true;
  if (!Array.isArray(points) || points.length > 2048 || points.length % 2 !== 0) return false;
  if (points.length === 0) return true;
  if (points.length < 4 || points[0] !== 0 || points.at(-2) !== durationFrames) return false;
  let previousFrame = -1;
  for (let index = 0; index < points.length; index += 2) {
    const frame = points[index], gain = points[index + 1];
    if (!Number.isSafeInteger(frame) || frame < 0 || frame > durationFrames || frame <= previousFrame ||
        !isFiniteRange(gain, 0, 1.5)) return false;
    previousFrame = frame;
  }
  return true;
}

async function loadNativeProject(project) {
  if (!project || typeof project !== 'object' || !Array.isArray(project.tracks) || !Array.isArray(project.clips) ||
      project.tracks.length < 1 || project.tracks.length > MAX_NATIVE_PROJECT_TRACKS || project.clips.length > MAX_NATIVE_PROJECT_CLIPS ||
      !isFiniteRange(project.masterGain, 0, 4)) {
    return { ok: false, error: 'Структура native-проекта некорректна' };
  }
  for (const clip of project.clips) {
    if (!validNativeAssetId(clip?.assetId) || !Number.isInteger(clip.trackIndex) || clip.trackIndex < 0 || clip.trackIndex >= project.tracks.length || project.tracks[clip.trackIndex]?.isBus === true ||
        !Number.isSafeInteger(clip.startFrame) || clip.startFrame < 0 || !Number.isSafeInteger(clip.sourceOffsetFrame) || clip.sourceOffsetFrame < 0 ||
        !Number.isSafeInteger(clip.durationFrames) || clip.durationFrames < 1 || !isFiniteRange(clip.playbackRate, 0.01, 8) ||
        !isFiniteRange(clip.gain, 0, 4) || !isFiniteRange(clip.pan, -1, 1) || !validClipGainAutomation(clip.gainAutomation, clip.durationFrames) ||
        !Number.isSafeInteger(clip.fadeInFrames ?? 0) || (clip.fadeInFrames ?? 0) < 0 || (clip.fadeInFrames ?? 0) > clip.durationFrames ||
        !Number.isSafeInteger(clip.fadeOutFrames ?? 0) || (clip.fadeOutFrames ?? 0) < 0 || (clip.fadeOutFrames ?? 0) > clip.durationFrames ||
        (clip.fadeInFrames ?? 0) > clip.durationFrames - (clip.fadeOutFrames ?? 0)) {
      return { ok: false, error: 'В native-проекте есть неподдерживаемый аудиоклип' };
    }
  }
  let automationPointCount = 0;
  for (const track of project.tracks) {
    if (!isFiniteRange(track?.gain, 0, 4) || !isFiniteRange(track?.pan, -1, 1) || typeof track.mute !== 'boolean' || typeof track.solo !== 'boolean' ||
        typeof track.isBus !== 'boolean' || !Number.isInteger(track.outputBusIndex) || track.outputBusIndex < -1 ||
        typeof track.reverb !== 'boolean' || typeof track.delay !== 'boolean' || typeof track.equalizer !== 'boolean' ||
        typeof track.compressor !== 'boolean' || typeof track.limiter !== 'boolean' ||
        !isFiniteRange(track.compressorThresholdDb, -60, 0) || !isFiniteRange(track.compressorRatio, 1, 20) ||
        !isFiniteRange(track.compressorAttackMs, 0.1, 100) || !isFiniteRange(track.compressorReleaseMs, 10, 1000) ||
        !isFiniteRange(track.compressorMakeupDb, 0, 24) ||
        !isFiniteRange(track.limiterCeilingDb, -24, 0) || !isFiniteRange(track.limiterReleaseMs, 10, 500) ||
        !isFiniteRange(track.equalizerFrequencyHz, 20, 20_000) || !isFiniteRange(track.equalizerGainDb, -24, 24) || !isFiniteRange(track.equalizerQ, 0.1, 18) ||
        !Array.isArray(track.equalizerBands) || track.equalizerBands.length !== 21 || track.equalizerBands.some((value, index) =>
          !isFiniteRange(value, index % 3 === 0 ? 20 : index % 3 === 1 ? -24 : 0.1, index % 3 === 0 ? 20_000 : index % 3 === 1 ? 24 : 18))) {
      return { ok: false, error: 'В native-проекте есть некорректный микшерный канал' };
    }
    const validateLane = (points, minimum, maximum, label) => {
      if (!Array.isArray(points) || points.length > 8192) return { ok: false, error: `Кривая ${label} native-проекта слишком велика` };
      let previousFrame = -1;
      for (const point of points) {
        if (!Number.isSafeInteger(point?.frame) || point.frame < 0 || point.frame <= previousFrame || !isFiniteRange(point.value, minimum, maximum)) {
          return { ok: false, error: `В native-проекте есть некорректная точка автоматизации ${label}` };
        }
        previousFrame = point.frame;
      }
      return { ok: true };
    };
    const gainPoints = track.gainAutomation ?? [], panPoints = track.panAutomation ?? [];
    const gainValidation = validateLane(gainPoints, 0, 4, 'громкости');
    if (!gainValidation.ok) return gainValidation;
    const panValidation = validateLane(panPoints, -1, 1, 'панорамы');
    if (!panValidation.ok) return panValidation;
    automationPointCount += gainPoints.length + panPoints.length;
    if (automationPointCount > 8192) return { ok: false, error: 'Количество точек автоматизации превышает лимит' };
  }
  for (const [index, track] of project.tracks.entries()) {
    if ((track.isBus && track.outputBusIndex !== -1) ||
        (track.outputBusIndex !== -1 && (track.outputBusIndex >= project.tracks.length ||
          !project.tracks[track.outputBusIndex]?.isBus || track.outputBusIndex === index))) {
      return { ok: false, error: 'Маршрутизация native-проекта должна идти только с дорожки на шину' };
    }
  }

  let result = await requestAudioEngine('clear_project');
  if (!result.ok) return result;
  result = await requestAudioEngine('set_project', { masterGain: project.masterGain });
  if (!result.ok) return result;
  for (const [index, track] of project.tracks.entries()) {
    result = await requestAudioEngine('set_track', {
      index, gain: track.gain, pan: track.pan, mute: track.mute, solo: track.solo, reverb: track.reverb, delay: track.delay,
      isBus: track.isBus, outputBusIndex: track.outputBusIndex,
      equalizer: track.equalizer, equalizerFrequencyHz: track.equalizerFrequencyHz, equalizerGainDb: track.equalizerGainDb, equalizerQ: track.equalizerQ,
      compressor: track.compressor, compressorThresholdDb: track.compressorThresholdDb, compressorRatio: track.compressorRatio,
      compressorAttackMs: track.compressorAttackMs, compressorReleaseMs: track.compressorReleaseMs, compressorMakeupDb: track.compressorMakeupDb,
      limiter: track.limiter, limiterCeilingDb: track.limiterCeilingDb, limiterReleaseMs: track.limiterReleaseMs,
      equalizerBands: track.equalizerBands,
      gainAutomation: (track.gainAutomation ?? []).flatMap(point => [point.frame, point.value]),
      panAutomation: (track.panAutomation ?? []).flatMap(point => [point.frame, point.value]),
    });
    if (!result.ok) return result;
  }
  for (const clip of project.clips) {
    result = await requestAudioEngine('add_clip', clip);
    if (!result.ok) return result;
  }
  return requestAudioEngine('commit_project');
}

function registerAudioHandlers() {
  const trustedRenderer = event => windowInstance && event.sender === windowInstance.webContents &&
    event.senderFrame === windowInstance.webContents.mainFrame;
  ipcMain.handle('native-audio:devices', event => trustedRenderer(event)
    ? requestAudioEngine('devices')
    : { ok: false, error: 'Запрос отклонён' });
  ipcMain.handle('native-midi:devices', event => trustedRenderer(event)
    ? requestAudioEngine('midi_devices')
    : { ok: false, error: 'Запрос отклонён' });
  ipcMain.handle('native-midi:open-input', (event, deviceIndex) => {
    if (!trustedRenderer(event)) return { ok: false, error: 'Запрос отклонён' };
    if (!Number.isInteger(deviceIndex) || deviceIndex < 0 || deviceIndex > 128) return { ok: false, error: 'Недопустимый номер MIDI-входа' };
    return requestAudioEngine('midi_open_input', { deviceIndex });
  });
  ipcMain.handle('native-midi:close-input', event => trustedRenderer(event)
    ? requestAudioEngine('midi_close_input')
    : { ok: false, error: 'Запрос отклонён' });
  ipcMain.handle('native-midi:read', event => trustedRenderer(event)
    ? requestAudioEngine('midi_read')
    : { ok: false, error: 'Запрос отклонён' });
  ipcMain.handle('native-midi:open-output', (event, deviceIndex) => {
    if (!trustedRenderer(event)) return { ok: false, error: 'Запрос отклонён' };
    if (!Number.isInteger(deviceIndex) || deviceIndex < 0 || deviceIndex > 128) return { ok: false, error: 'Недопустимый номер MIDI-выхода' };
    return requestAudioEngine('midi_open_output', { deviceIndex });
  });
  ipcMain.handle('native-midi:close-output', event => trustedRenderer(event)
    ? requestAudioEngine('midi_close_output')
    : { ok: false, error: 'Запрос отклонён' });
  ipcMain.handle('native-midi:send-note', (event, channel, pitch, velocity, on) => {
    if (!trustedRenderer(event)) return { ok: false, error: 'Запрос отклонён' };
    if (!Number.isInteger(channel) || channel < 0 || channel > 15 ||
        !Number.isInteger(pitch) || pitch < 0 || pitch > 127 ||
        !Number.isInteger(velocity) || velocity < 0 || velocity > 127 || typeof on !== 'boolean') {
      return { ok: false, error: 'Параметры MIDI-ноты некорректны' };
    }
    return requestAudioEngine('midi_send_note', { channel, pitch, velocity, on });
  });
  ipcMain.handle('native-audio:status', event => trustedRenderer(event)
    ? requestAudioEngine('status')
    : { ok: false, error: 'Запрос отклонён' });
  ipcMain.handle('native-audio:start-test-tone', (event, deviceIndex) => {
    if (!trustedRenderer(event)) return { ok: false, error: 'Запрос отклонён' };
    if (!Number.isInteger(deviceIndex) || deviceIndex < 0 || deviceIndex > 128) {
      return { ok: false, error: 'Недопустимый номер устройства' };
    }
    return requestAudioEngine('start_test_tone', { deviceIndex, frequencyHz: 440, gain: 0.05 });
  });
  ipcMain.handle('native-audio:stop-test-tone', event => trustedRenderer(event)
    ? requestAudioEngine('stop')
    : { ok: false, error: 'Запрос отклонён' });
  ipcMain.handle('native-audio:stage-asset', (event, assetId, bytes) => trustedRenderer(event)
    ? stageNativeAsset(assetId, bytes)
    : { ok: false, error: 'Запрос отклонён' });
  ipcMain.handle('native-clap:inspect', async event => {
    if (!trustedRenderer(event)) return { ok: false, error: 'Запрос отклонён' };
    const selection = await dialog.showOpenDialog(windowInstance, {
      title: 'Выберите CLAP эффект',
      properties: ['openFile'],
      filters: [{ name: 'CLAP effects', extensions: ['clap'] }],
    });
    if (selection.canceled || selection.filePaths.length !== 1) return { ok: false, cancelled: true };

    const pluginPath = selection.filePaths[0];
    try {
      if (extname(pluginPath).toLowerCase() !== '.clap' || !statSync(pluginPath).isFile() || statSync(pluginPath).size > MAX_NATIVE_ASSET_BYTES) {
        return { ok: false, error: 'Выберите файл CLAP (.clap) до 256 МиБ' };
      }
    } catch { return { ok: false, error: 'Файл CLAP недоступен' }; }

    const helper = app.isPackaged
      ? join(process.resourcesPath, 'engine', 'sonora-clap-offline.exe')
      : join(WEB_ROOT, 'native', 'build', 'sonora-clap-offline.exe');
    if (!existsSync(helper)) return { ok: false, error: 'Offline-обработчик CLAP не собран' };

    const inspected = await runClapHelper(helper, ['inspect', pluginPath]);
    if (inspected.error) return { ok: false, error: inspected.error };
    let description;
    try { description = parseClapDescription(JSON.parse(inspected.stdout)); } catch {}
    if (!description) return { ok: false, error: 'CLAP-плагин вернул некорректные параметры' };
    if (clapSelections.size >= 16) clapSelections.delete(clapSelections.keys().next().value);
    const selectionToken = randomUUID();
    clapSelections.set(selectionToken, { pluginPath, ...description, parameters: new Map(description.parameters.map(parameter => [parameter.id, parameter])) });
    return { ok: true, selectionToken, ...description };
  });

  ipcMain.handle('native-clap:load-realtime', (event, selectionToken) => {
    if (!trustedRenderer(event)) return { ok: false, error: 'Запрос отклонён' };
    const clapSelection = typeof selectionToken === 'string' ? clapSelections.get(selectionToken) : null;
    if (!clapSelection) return { ok: false, error: 'Сначала выберите локальный CLAP-эффект' };
    return requestAudioEngine('load_clap', { path: clapSelection.pluginPath });
  });
  ipcMain.handle('native-clap:unload-realtime', event => trustedRenderer(event)
    ? requestAudioEngine('unload_clap')
    : { ok: false, error: 'Запрос отклонён' });
  ipcMain.handle('native-clap:realtime-status', event => trustedRenderer(event)
    ? requestAudioEngine('clap_status')
    : { ok: false, error: 'Запрос отклонён' });

  ipcMain.handle('native-clap:render', async (event, selectionToken, wavValue, values) => {
    if (!trustedRenderer(event)) return { ok: false, error: 'Запрос отклонён' };
    const clapSelection = typeof selectionToken === 'string' ? clapSelections.get(selectionToken) : null;
    if (!clapSelection) return { ok: false, error: 'Выберите CLAP-эффект повторно' };
    const inputWav = getWavBuffer(wavValue);
    if (!inputWav || inputWav.length < 44 || inputWav.length > MAX_NATIVE_ASSET_BYTES || inputWav.toString('ascii', 0, 4) !== 'RIFF' || inputWav.toString('ascii', 8, 12) !== 'WAVE') {
      return { ok: false, error: 'Для CLAP нужен WAV не больше 256 МиБ' };
    }
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 128) {
      return { ok: false, error: 'Список параметров CLAP некорректен' };
    }
    const parameterArgs = [];
    for (const [idText, value] of Object.entries(values)) {
      if (!/^\d{1,10}$/.test(idText)) return { ok: false, error: 'Идентификатор параметра CLAP некорректен' };
      const parameter = clapSelection.parameters.get(Number(idText));
      if (!parameter || !isFiniteRange(value, parameter.min, parameter.max)) return { ok: false, error: 'Значение параметра CLAP вне допустимого диапазона' };
      parameterArgs.push(`${parameter.id}=${value}`);
    }

    const helper = app.isPackaged
      ? join(process.resourcesPath, 'engine', 'sonora-clap-offline.exe')
      : join(WEB_ROOT, 'native', 'build', 'sonora-clap-offline.exe');
    if (!existsSync(helper)) return { ok: false, error: 'Offline-обработчик CLAP не собран' };
    const inputPath = join(app.getPath('temp'), `sonora-clap-in-${randomUUID()}.wav`);
    const outputPath = join(app.getPath('temp'), `sonora-clap-out-${randomUUID()}.wav`);
    try {
      await writeFile(inputPath, inputWav, { flag: 'wx' });
      const result = await runClapHelper(helper, ['process', clapSelection.pluginPath, inputPath, outputPath, ...parameterArgs]);
      if (result.error) return { ok: false, error: result.error };
      let metadata;
      try { metadata = JSON.parse(result.stdout); }
      catch { return { ok: false, error: 'CLAP-обработчик вернул некорректный результат' }; }
      const wav = await readFile(outputPath);
      if (!metadata.ok || metadata.pluginId !== clapSelection.pluginId || typeof metadata.pluginName !== 'string' || wav.length < 44 || wav.length > MAX_NATIVE_ASSET_BYTES || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
        return { ok: false, error: 'Результат CLAP некорректен или превышает 256 МиБ' };
      }
      return { ok: true, pluginName: metadata.pluginName, pluginId: metadata.pluginId, values, wav: Uint8Array.from(wav).buffer };
    } catch { return { ok: false, error: 'Не удалось обработать WAV эффектом CLAP' }; }
    finally {
      try { await unlink(inputPath); } catch {}
      try { await unlink(outputPath); } catch {}
    }
  });
  ipcMain.handle('native-audio:load-project', (event, project) => trustedRenderer(event)
    ? loadNativeProject(project)
    : { ok: false, error: 'Запрос отклонён' });
  ipcMain.handle('native-audio:play-project', (event, deviceIndex, startFrame) => {
    if (!trustedRenderer(event)) return { ok: false, error: 'Запрос отклонён' };
    if (!Number.isInteger(deviceIndex) || deviceIndex < 0 || deviceIndex > 128 || !Number.isSafeInteger(startFrame) || startFrame < 0) {
      return { ok: false, error: 'Недопустимая позиция воспроизведения' };
    }
    return requestAudioEngine('play_project', { deviceIndex, startFrame });
  });
  ipcMain.handle('native-audio:pause-project', event => trustedRenderer(event)
    ? requestAudioEngine('pause_project')
    : { ok: false, error: 'Запрос отклонён' });
  ipcMain.handle('native-audio:stop-project', event => trustedRenderer(event)
    ? requestAudioEngine('stop_project')
    : { ok: false, error: 'Запрос отклонён' });
  ipcMain.handle('native-audio:start-capture', async (event, deviceIndex, sampleRate, channelMode) => {
    if (!trustedRenderer(event)) return { ok: false, error: 'Запрос отклонён' };
    if (activeNativeCapturePath) return { ok: false, error: 'Запись WASAPI уже выполняется' };
    if (!Number.isInteger(deviceIndex) || deviceIndex < 0 || deviceIndex > 128 || ![44100, 48000, 96000].includes(sampleRate) || !['mono', 'left', 'right', 'stereo'].includes(channelMode)) {
      return { ok: false, error: 'Параметры записи WASAPI некорректны' };
    }
    const path = join(app.getPath('temp'), `sonora-capture-${randomUUID()}.wav`);
    const result = await requestAudioEngine('start_capture', { deviceIndex, sampleRate, channelMode, path });
    if (!result?.ok) {
      try { await unlink(path); } catch {}
      return result;
    }
    activeNativeCapturePath = path;
    return result;
  });
  ipcMain.handle('native-audio:stop-capture', async event => {
    if (!trustedRenderer(event)) return { ok: false, error: 'Запрос отклонён' };
    const path = activeNativeCapturePath;
    if (!path) return { ok: false, error: 'Запись WASAPI не выполняется' };
    activeNativeCapturePath = null;
    try {
      const result = await requestAudioEngine('stop_capture');
      if (!result?.ok) return result;
      const wav = await readFile(path);
      if (wav.length < 44 || wav.length > 256 * 1024 * 1024 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
        return { ok: false, error: 'Файл WASAPI-записи некорректен или превышает 256 МиБ' };
      }
      return { ...result, wav: Uint8Array.from(wav).buffer };
    } catch {
      return { ok: false, error: 'Не удалось прочитать WAV-файл нативной записи' };
    } finally {
      try { await unlink(path); } catch {}
    }
  });
}

async function stopAudioEngine() {
  const child = audioEngineProcess;
  if (!child) return;
  if (activeNativeCapturePath) {
    try { await requestAudioEngine('stop_capture'); } catch {}
    try { await unlink(activeNativeCapturePath); } catch {}
    activeNativeCapturePath = null;
  }
  await requestAudioEngine('shutdown');
  child.stdin.end();
  const forceExitTimer = setTimeout(() => child.kill(), 1000);
  forceExitTimer.unref();
}

function serveProject() {
  return new Promise((resolveListen, rejectListen) => {
    server = createServer((request, response) => {
      let pathname;
      try { pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); }
      catch { response.writeHead(400).end('Bad request'); return; }
      const file = resolve(WEB_ROOT, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + sep)) { response.writeHead(403).end('Forbidden'); return; }
      try {
        if (!statSync(file).isFile()) throw new Error('not a file');
        response.writeHead(200, {
          'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-src 'none'",
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        });
        createReadStream(file).pipe(response);
      } catch { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found'); }
    });
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen(`http://127.0.0.1:${server.address().port}`));
  });
}

async function createMainWindow() {
  startAudioEngine();
  registerAudioHandlers();
  const origin = await serveProject();
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowed = permission === 'media' && details?.requestingUrl?.startsWith(origin);
    callback(Boolean(allowed));
  });
  windowInstance = new BrowserWindow({
    icon: join(WEB_ROOT, "icon.svg"),
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    title: 'SONORA Studio',
    backgroundColor: '#11151c',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: join(__dirname, 'preload.cjs'),
    },
  });
  windowInstance.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  windowInstance.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  });
  windowInstance.on('closed', () => { windowInstance = null; });
  await windowInstance.loadURL(origin);
}

app.whenReady().then(createMainWindow).catch(error => {
  console.error('SONORA failed to start:', error);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting) { if (server) server.close(); return; }
  quitting = true;
  event.preventDefault();
  stopAudioEngine().finally(() => app.quit());
});

