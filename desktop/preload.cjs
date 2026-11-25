const { contextBridge, ipcRenderer } = require('electron');

function validDeviceIndex(index) {
  return Number.isInteger(index) && index >= 0 && index <= 128;
}

function validAssetId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validWav(value) {
  if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) return false;
  const view = new DataView(value instanceof ArrayBuffer ? value : value.buffer, value instanceof ArrayBuffer ? 0 : value.byteOffset, value instanceof ArrayBuffer ? value.byteLength : value.byteLength);
  return view.byteLength >= 44 && view.byteLength <= 256 * 1024 * 1024 &&
    view.getUint32(0, false) === 0x52494646 && view.getUint32(8, false) === 0x57415645;
}

contextBridge.exposeInMainWorld('sonoraNative', Object.freeze({
  audioDevices: () => ipcRenderer.invoke('native-audio:devices'),
  midiDevices: () => ipcRenderer.invoke('native-midi:devices'),
  openMidiInput: deviceIndex => Number.isInteger(deviceIndex) && deviceIndex >= 0 && deviceIndex <= 128
    ? ipcRenderer.invoke('native-midi:open-input', deviceIndex)
    : Promise.resolve({ ok: false, error: 'Недопустимый номер MIDI-входа' }),
  closeMidiInput: () => ipcRenderer.invoke('native-midi:close-input'),
  readMidiEvents: () => ipcRenderer.invoke('native-midi:read'),
  openMidiOutput: deviceIndex => Number.isInteger(deviceIndex) && deviceIndex >= 0 && deviceIndex <= 128
    ? ipcRenderer.invoke('native-midi:open-output', deviceIndex)
    : Promise.resolve({ ok: false, error: 'Недопустимый номер MIDI-выхода' }),
  closeMidiOutput: () => ipcRenderer.invoke('native-midi:close-output'),
  sendMidiNote: (channel, pitch, velocity, on) => Number.isInteger(channel) && channel >= 0 && channel <= 15 &&
      Number.isInteger(pitch) && pitch >= 0 && pitch <= 127 &&
      Number.isInteger(velocity) && velocity >= 0 && velocity <= 127 && typeof on === 'boolean'
    ? ipcRenderer.invoke('native-midi:send-note', channel, pitch, velocity, on)
    : Promise.resolve({ ok: false, error: 'Параметры MIDI-ноты некорректны' }),
  audioStatus: () => ipcRenderer.invoke('native-audio:status'),
  startTestTone: deviceIndex => {
    if (!validDeviceIndex(deviceIndex)) return Promise.resolve({ ok: false, error: 'Недопустимый номер устройства' });
    return ipcRenderer.invoke('native-audio:start-test-tone', deviceIndex);
  },
  stopTestTone: () => ipcRenderer.invoke('native-audio:stop-test-tone'),
  stageAudioAsset: (assetId, wavBytes) => validAssetId(assetId) && validWav(wavBytes)
    ? ipcRenderer.invoke('native-audio:stage-asset', assetId, wavBytes)
    : Promise.resolve({ ok: false, error: 'Некорректный WAV или идентификатор аудио' }),
  inspectClapEffect: () => ipcRenderer.invoke('native-clap:inspect'),
  loadRealtimeClapEffect: selectionToken => typeof selectionToken === 'string' && /^[\da-f-]{36}$/i.test(selectionToken)
    ? ipcRenderer.invoke('native-clap:load-realtime', selectionToken)
    : Promise.resolve({ ok: false, error: 'Некорректный идентификатор CLAP' }),
  unloadRealtimeClapEffect: () => ipcRenderer.invoke('native-clap:unload-realtime'),
  realtimeClapStatus: () => ipcRenderer.invoke('native-clap:realtime-status'),
  renderClapEffect: (selectionToken, wavBytes, values) => typeof selectionToken === 'string' && /^[\da-f-]{36}$/i.test(selectionToken) && validWav(wavBytes) &&
    values && typeof values === 'object' && !Array.isArray(values) && Object.keys(values).length <= 128
    ? ipcRenderer.invoke('native-clap:render', selectionToken, wavBytes, values)
    : Promise.resolve({ ok: false, error: 'Некорректный WAV для обработки CLAP' }),
  inspectVst3Effect: () => ipcRenderer.invoke('native-vst3:inspect'),
  loadRealtimeVst3Effect: selectionToken => typeof selectionToken === 'string' && /^[\da-f-]{36}$/i.test(selectionToken)
    ? ipcRenderer.invoke('native-vst3:load-realtime', selectionToken)
    : Promise.resolve({ ok: false, error: 'Некорректный идентификатор VST3' }),
  unloadRealtimeVst3Effect: () => ipcRenderer.invoke('native-vst3:unload-realtime'),
  realtimeVst3Status: () => ipcRenderer.invoke('native-vst3:realtime-status'),
  loadProject: project => ipcRenderer.invoke('native-audio:load-project', project),
  playProject: (deviceIndex, startFrame) => validDeviceIndex(deviceIndex) && Number.isSafeInteger(startFrame) && startFrame >= 0
    ? ipcRenderer.invoke('native-audio:play-project', deviceIndex, startFrame)
    : Promise.resolve({ ok: false, error: 'Недопустимая позиция воспроизведения' }),
  pauseProject: () => ipcRenderer.invoke('native-audio:pause-project'),
  stopProject: () => ipcRenderer.invoke('native-audio:stop-project'),
  startCapture: (deviceIndex, sampleRate, channelMode) => validDeviceIndex(deviceIndex) && [44100, 48000, 96000].includes(sampleRate) &&
    ['mono', 'left', 'right', 'stereo'].includes(channelMode)
    ? ipcRenderer.invoke('native-audio:start-capture', deviceIndex, sampleRate, channelMode)
    : Promise.resolve({ ok: false, error: 'Недопустимые параметры WASAPI-записи' }),
  stopCapture: () => ipcRenderer.invoke('native-audio:stop-capture'),
}));

