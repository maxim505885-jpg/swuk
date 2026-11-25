import { beatFromRulerPointer, flattenGainAutomation, normalizeLoopRange, normalizeTrackName, projectRenderDurationSeconds, sampleAutomation, splitAudioClip, splitSequencerEvents, wrapLoopBeat } from './arrangement-core.mjs?v=7';
import { instrumentWaveAt, normalizeSynthSettings, renderSequencedClip as renderSequencedPcm } from './sequencer-audio.mjs?v=3';
import { createProjectDocument, PROJECT_LIMITS, validateProjectDocument } from './project-io.mjs?v=3';
import { normalizeTheme, readTheme, THEMES, THEME_KEY } from './theme-core.mjs';
import { analyzeMeter, presentMeter } from './audio-meter.mjs?v=1';
import { sampleWaveformPeaks } from './waveform-core.mjs?v=2';
import { detectTransientFrames } from './transient-core.mjs?v=1';
import { clampMidiPitch, midiOctaveStart, shiftMidiOctave } from './midi-edit-core.mjs?v=1';
import { normalizeClipFades } from './clip-fade-core.mjs?v=1';
import { CLIP_GAIN_ENVELOPE_MAX_POINTS, normalizeClipGainEnvelope, sampleClipGainEnvelope, scheduleClipGain, splitClipGainEnvelope } from './clip-envelope.mjs?v=1';
import { EQ_BAND_FREQUENCIES, normalizeEqSettings } from './eq-core.mjs?v=2';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
function normalizeCompressorSettings(settings) {
  const bounded = (key, fallback, min, max) => clamp(Number.isFinite(settings?.[key]) ? settings[key] : fallback, min, max);
  return { thresholdDb: bounded('thresholdDb', -18, -60, 0), ratio: bounded('ratio', 4, 1, 20),
    attackMs: bounded('attackMs', 10, .1, 100), releaseMs: bounded('releaseMs', 120, 10, 1000), makeupDb: bounded('makeupDb', 0, 0, 24) };
}
function normalizeLimiterSettings(settings) {
  const bounded = (key, fallback, min, max) => clamp(Number.isFinite(settings?.[key]) ? settings[key] : fallback, min, max);
  return { ceilingDb: bounded('ceilingDb', -1, -24, 0), releaseMs: bounded('releaseMs', 80, 10, 500) };
}
let selectedTheme = readTheme({ getItem: key => { try { return localStorage.getItem(key); } catch { return null; } } });
const COLORS = THEMES.find(theme => theme.id === selectedTheme)?.trackPalette || THEMES[0].trackPalette;
const themePalette = () => THEMES.find(theme => theme.id === selectedTheme)?.trackPalette || THEMES[0].trackPalette;
const BEATS_PER_BAR = 4;
const DB_NAME = 'sonora-local';
const DB_STORE = 'settings';
const MAX_AUDIO_FILE_BYTES = 256 * 1024 * 1024;
const MAX_PROJECT_FILE_BYTES = 256 * 1024 * 1024;
const SAMPLE_RATES = [44100, 48000, 96000];
document.documentElement.dataset.theme = selectedTheme;
const savedAudioPreferences = (() => {
  try { return JSON.parse(localStorage.getItem('sonora-audio-preferences') || '{}'); }
  catch { return {}; }
})();

const SAMPLE_LIBRARY = [
  { id: 'kick', name: 'Бочка · короткая', category: 'Бочки', kind: 'kick', duration: '0:01' },
  { id: 'kick-deep', name: 'Бочка · низкая', category: 'Бочки', kind: 'deepKick', duration: '0:01' },
  { id: 'snare', name: 'Малый · сухой', category: 'Малый барабан', kind: 'snare', duration: '0:01' },
  { id: 'clap', name: 'Хлопок · слои', category: 'Хлопки', kind: 'clap', duration: '0:01' },
  { id: 'hat-closed', name: 'Хэт · закрытый', category: 'Хай-хэты', kind: 'hat', duration: '0:01' },
  { id: 'hat-open', name: 'Хэт · открытый', category: 'Хай-хэты', kind: 'openHat', duration: '0:02' },
  { id: 'tom', name: 'Том · низкий', category: 'Томы и перкуссия', kind: 'tom', duration: '0:01' },
  { id: 'shaker', name: 'Шейкер', category: 'Томы и перкуссия', kind: 'shaker', duration: '0:01' },
  { id: 'noise', name: 'Шумовой свип', category: 'Атмосфера', kind: 'sweep', duration: '0:04' },
];
const INSTRUMENTS = [
  { id: 'sine', name: 'Чистый синтезатор', category: 'Клавишные', detail: 'Встроенный осциллятор' },
  { id: 'soft-keys', name: 'Мягкие клавиши', category: 'Клавишные', detail: 'Синус с тихой октавой' },
  { id: 'bass', name: 'Пульсирующий бас', category: 'Струнные', detail: 'Моно-синтезатор' },
  { id: 'pad', name: 'Тёплая подложка', category: 'Синтезаторы', detail: 'Медленная атака' },
];
const INSTRUMENT_PRESETS = [
  { id: 'preset-soft-keys', name: 'Мягкая клавиша', instrument: 'soft-keys', category: 'Клавишные', detail: 'Нежная атака · полный спектр', synthSettings: { waveform: 'preset', cutoffHz: 9600, attackMs: 22, releaseMs: 180, detuneCents: 0 } },
  { id: 'preset-glass-sine', name: 'Стеклянный тон', instrument: 'sine', category: 'Клавишные', detail: 'Чистая синусоида · короткое затухание', synthSettings: { waveform: 'sine', cutoffHz: 18_000, attackMs: 4, releaseMs: 95, detuneCents: 0 } },
  { id: 'preset-warm-bass', name: 'Тёплый бас', instrument: 'bass', category: 'Бас', detail: 'Пила · закрытый фильтр', synthSettings: { waveform: 'sawtooth', cutoffHz: 2100, attackMs: 7, releaseMs: 120, detuneCents: -3 } },
  { id: 'preset-slow-pad', name: 'Медленная подложка', instrument: 'pad', category: 'Пэды', detail: 'Треугольник · длинная атака и хвост', synthSettings: { waveform: 'triangle', cutoffHz: 5200, attackMs: 360, releaseMs: 720, detuneCents: 4 } },
];

const state = {
  name: 'Новый проект', tempo: 120, key: 'До мажор', masterVolume: 0.82,
  tracks: [
    { id: 'track-audio-1', name: 'Аудио 1', type: 'audio', color: COLORS[0], volume: 0.8, pan: 0, mute: false, solo: false, clips: [] },
    { id: 'track-drums', name: 'Ритм', type: 'drums', color: COLORS[1], volume: 0.8, pan: 0, mute: false, solo: false, clips: [] },
    { id: 'track-synth', name: 'Синтезатор', type: 'instrument', instrument: 'soft-keys', color: COLORS[2], volume: 0.8, pan: 0, mute: false, solo: false, clips: [] },
  ],
  buses: [], assets: new Map(), selectedClipId: null, selectedTrackId: 'track-audio-1', playheadBeat: 0,
  playing: false, loop: false, loopStartBeat: 0, loopEndBeat: 16, metronome: false, recording: false, browserTab: 'samples',
  view: 'arrangement', zoom: 106, markers: [], recordings: [], inputDeviceId: savedAudioPreferences.inputDeviceId || '', outputDeviceId: savedAudioPreferences.outputDeviceId || '',
  sampleRate: SAMPLE_RATES.includes(savedAudioPreferences.sampleRate) ? savedAudioPreferences.sampleRate : 48000,
  recordChannelMode: ['mono', 'left', 'right', 'stereo'].includes(savedAudioPreferences.recordChannelMode) ? savedAudioPreferences.recordChannelMode : 'mono',
  recordingTargetTrackId: 'track-audio-1',
  undoStack: [], redoStack: [],
};
let selectedBrowserItem = null;
let browserPreviewSource = null;
let browserPreviewSourceId = null;
let browserPreviewGeneration = 0;
const libraryBuffers = new Map();
let fileImportQueue = Promise.resolve();

let audioContext;
let playStartTime = 0;
let playStartBeat = 0;
let nativePlaybackActive = false;
let nativePlaybackPending = false;
let forceBrowserPlayback = false;
let nativeGraphDirty = true;
let nativeGraphRevision = 0;
let nativeSynthCacheRevision = -1;
const nativeSynthCache = new Map();
let selectedMidiNote = null;
let pianoRangeStart = 60;
let inspectorOpen = true;
let nativeOutputDeviceIndex = 0;
let nativeCaptureDevices = [];
let nativeInputDeviceIndex = Number.isInteger(savedAudioPreferences.nativeInputDeviceIndex) && savedAudioPreferences.nativeInputDeviceIndex >= 0 ? savedAudioPreferences.nativeInputDeviceIndex : 0;
let nativePlaybackEndBeat = 0;
let lastNativeMeterPoll = 0;
let nativeMeterPollPending = false;
let nativeAssetCounter = 0;
const nativeAssetIds = new WeakMap();
let nativeStagedAssets = new WeakSet();
let scheduledNodes = [];
let playRAF = 0;
let masterAnalyser;
let masterMeterBuffer;
let masterSpectrumAnalyser;
let masterSpectrumBuffer;
let recordMeterBuffer;
let liveMasterGain;
const liveTrackGains = new Map();
const liveTrackPans = new Map();
const liveTrackEqualizers = new Map();
const liveTrackCompressors = new Map();
const liveTrackLimiters = new Map();
const liveTrackMeters = new Map();
const liveTrackMeterBuffers = new Map();
const liveClipGains = new Map();
const liveClipPans = new Map();
const liveClipSources = new Map();
let recordingStream;
let recordingPending = false;
let nativeRecordingActive = false;
let recordingWorkletReady;
let recordingStopResolver;
let recordingStopping = false;
let recordAnalyser;
let recordProcessor;
let recordInput;
let recordingTargetTrackId = '';
let recordingChannelMode = 'mono';
let recordingChunks = [];
let toastTimer;
let modalReturnFocus = null;
let nativeToneActive = false;
let followPlayhead = true;
let splitMode = false;
let dragState = null;
let loopDrag = null;
let assetCounter = 0;
let lastMetronomeBeat = -1;
let pitchJobCounter = 0;
const pitchJobs = new Map();
const pitchPendingClips = new Set();
const clapSelections = new Map();
const pitchWorker = new Worker('/dsp-worker.js?v=2', { type: 'module' });
pitchWorker.addEventListener('message', event => {
  window.__SONORA_DEBUG__?.messages?.push({ id: event.data.id, keys: Object.keys(event.data), error: event.data.error || null });
  const job = pitchJobs.get(event.data.id); if (!job) return;
  pitchJobs.delete(event.data.id);
  clearTimeout(job.timeout);
  if (event.data.error) { job.reject(new Error(event.data.error)); return; }
  try {
    const context = getAudioContext(), channels = event.data.channels.map(buffer => new Float32Array(buffer));
    const output = context.createBuffer(channels.length, channels[0].length, event.data.sampleRate);
    channels.forEach((channel, index) => output.copyToChannel(channel, index));
    job.resolve(output);
  } catch (error) { job.reject(error); }
});
pitchWorker.addEventListener('error', event => {
  window.__SONORA_DEBUG__?.errors?.push(event.message || 'DSP worker failed');
  for (const job of pitchJobs.values()) { clearTimeout(job.timeout); job.reject(new Error(event.message || 'DSP worker failed')); }
  pitchJobs.clear();
});

function snapshot() {
  return structuredClone({ name: state.name, tempo: state.tempo, key: state.key, masterVolume: state.masterVolume, tracks: state.tracks, buses: state.buses, markers: state.markers, loop: state.loop, loopStartBeat: state.loopStartBeat, loopEndBeat: state.loopEndBeat, selectedTrackId: state.selectedTrackId, selectedClipId: state.selectedClipId });
}
function recordUndo({ audioGraph = true } = {}) {
  state.undoStack.push(snapshot()); if (state.undoStack.length > 40) state.undoStack.shift(); state.redoStack.length = 0; updateHistoryButtons();
  if (audioGraph) markProjectDirty(); else markProjectMetadataDirty();
}
function markProjectDirty() { nativeGraphDirty = true; nativeGraphRevision++; const saveState = $('#saveState'); if (saveState) saveState.textContent = '● Есть изменения'; }
function markProjectMetadataDirty() { const saveState = $('#saveState'); if (saveState) saveState.textContent = '● Есть изменения'; }
function applyHistory(target, source) {
  if (!source.length) return;
  target.push(snapshot()); const value = source.pop();
  Object.assign(state, value); markProjectDirty(); updateHistoryButtons(); renderAll();
}
function updateHistoryButtons() { $('#undoBtn').disabled = !state.undoStack.length; $('#redoBtn').disabled = !state.redoStack.length; $('#undoBtn').classList.toggle('disabled-control', !state.undoStack.length); $('#redoBtn').classList.toggle('disabled-control', !state.redoStack.length); }

function uid(prefix = 'id') { return `${prefix}-${Date.now().toString(36)}-${(++assetCounter).toString(36)}`; }
function beatSeconds() { return 60 / state.tempo; }
function beatsToPx(beat) { return beat * Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar')) / BEATS_PER_BAR; }
function pxToBeats(px) { return px / Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar')) * BEATS_PER_BAR; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function getAudioContext() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const requestedRate = state.sampleRate;
    try { audioContext = new AudioContextClass({ sampleRate: requestedRate }); }
    catch { audioContext = new AudioContextClass(); state.sampleRate = audioContext.sampleRate; }
    if (audioContext.sampleRate !== requestedRate) { state.sampleRate = audioContext.sampleRate; saveAudioPreferences(); }
    if (state.outputDeviceId && audioContext.setSinkId) audioContext.setSinkId(state.outputDeviceId).catch(() => {});
  }
  if (audioContext.state === 'suspended') audioContext.resume();
  return audioContext;
}

function saveAudioPreferences() {
  try {
    localStorage.setItem('sonora-audio-preferences', JSON.stringify({
      sampleRate: state.sampleRate, inputDeviceId: state.inputDeviceId, outputDeviceId: state.outputDeviceId,
      recordChannelMode: state.recordChannelMode, nativeInputDeviceIndex,
    }));
  } catch {}
}

async function changeSampleRate(sampleRate) {
  if (!SAMPLE_RATES.includes(sampleRate)) return false;
  if (state.playing || state.recording || recordingPending) {
    showToast('Остановите воспроизведение и запись перед сменой частоты');
    return false;
  }
  const previousRate = audioContext?.sampleRate || state.sampleRate;
  try { if (audioContext && audioContext.state !== 'closed') await audioContext.close(); }
  catch { showToast('Не удалось остановить текущий аудиоконтекст'); return false; }
  audioContext = undefined;
  state.sampleRate = sampleRate;
  try {
    const context = getAudioContext();
    if (context.sampleRate !== sampleRate) throw new Error(`Браузер открыл ${context.sampleRate} Гц вместо ${sampleRate} Гц`);
    saveAudioPreferences();
    showToast(`Частота аудио: ${context.sampleRate} Гц`);
    return true;
  } catch (error) {
    state.sampleRate = previousRate;
    audioContext = undefined;
    try { getAudioContext(); } catch {}
    showToast(error.message || 'Эта частота дискретизации не поддерживается');
    return false;
  }
}

function showToast(message) {
  const toast = $('#toast'); toast.textContent = message; toast.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600);
}

function makeNoiseSamples(length, seed = 1) {
  const data = new Float32Array(length);
  let x = seed >>> 0;
  for (let i = 0; i < data.length; i++) { x = (x * 1664525 + 1013904223) >>> 0; data[i] = (x / 2147483648 - 1) * (1 - i / data.length); }
  return data;
}

function createSampleBuffer(kind, context = null) {
  const lengths = { kick: .48, deepKick: .62, snare: .38, clap: .31, hat: .12, openHat: .48, tom: .4, shaker: .22, sweep: 2.4 };
  const duration = lengths[kind] || .35, sampleRate = context?.sampleRate || state.sampleRate || 48000, length = Math.ceil(sampleRate * duration);
  const buffer = new AudioBuffer({ numberOfChannels: 1, length, sampleRate }), out = buffer.getChannelData(0);
  const noise = (kind === 'kick' || kind === 'deepKick' || kind === 'tom' || kind === 'sweep') ? null : makeNoiseSamples(length, kind.length * 700 + 23);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate, p = i / length;
    if (kind === 'kick' || kind === 'deepKick') {
      const base = kind === 'deepKick' ? 88 : 132, freq = base * Math.exp(-t * 13) + 38;
      out[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * (kind === 'deepKick' ? 7 : 11)) * .88;
      if (i < 120) out[i] += (Math.random() * 2 - 1) * .09 * (1 - i / 120);
    } else if (kind === 'tom') out[i] = Math.sin(2 * Math.PI * (110 * Math.exp(-t * 5) + 48) * t) * Math.exp(-t * 7) * .75;
    else if (kind === 'sweep') out[i] = (Math.random() * 2 - 1) * Math.sin(Math.PI * p) * .34;
    else if (kind === 'hat' || kind === 'openHat' || kind === 'shaker') {
      const decay = kind === 'openHat' ? 7 : kind === 'shaker' ? 17 : 27;
      const metallic = Math.sin(2 * Math.PI * 6450 * t) + Math.sin(2 * Math.PI * 8110 * t) * .7;
      out[i] = (noise[i] * .55 + metallic * .16) * Math.exp(-t * decay) * .56;
    } else {
      const burst = kind === 'clap' ? Math.exp(-Math.pow((t - .04) * 24, 2)) + .65 * Math.exp(-Math.pow((t - .095) * 30, 2)) + .38 * Math.exp(-Math.pow((t - .15) * 34, 2)) : 1;
      out[i] = noise[i] * Math.exp(-t * 12) * burst * .62;
    }
  }
  return buffer;
}

function registerAsset(name, buffer, extra = {}) {
  const id = extra.id || uid('asset');
  if (!canStoreAudioAsset(buffer, id)) return null;
  state.assets.set(id, { id, name, buffer, source: extra.source || 'user', type: extra.type || 'audio', mime: extra.mime || 'audio/wav', fileName: extra.fileName || name });
  return id;
}

function ensureLibraryAsset(item) {
  const id = `builtin-${item.id}`;
  if (!state.assets.has(id)) return registerAsset(item.name, getLibraryBuffer(item), { id, source: 'built-in', fileName: item.name });
  return id;
}

function getLibraryBuffer(item) {
  if (!libraryBuffers.has(item.id)) libraryBuffers.set(item.id, createSampleBuffer(item.kind));
  return libraryBuffers.get(item.id);
}

function canStoreAudioAsset(buffer, replacingId = null, report = true) {
  const isNewAsset = !state.assets.has(replacingId);
  if (isNewAsset && state.assets.size >= PROJECT_LIMITS.assets) {
    if (report) showToast(`В проекте достигнут лимит аудиофайлов (${PROJECT_LIMITS.assets})`);
    return false;
  }
  const currentBytes = [...state.assets.values()].reduce((total, asset) => total + asset.buffer.length * asset.buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT, 0);
  const bufferBytes = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
  if (currentBytes + (isNewAsset ? bufferBytes : bufferBytes - (state.assets.get(replacingId)?.buffer.length * state.assets.get(replacingId)?.buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT || 0)) > PROJECT_LIMITS.decodedAudioBytes) {
    if (report) showToast('Проект достиг безопасного лимита аудиоданных в памяти');
    return false;
  }
  return true;
}

function canAddTrack() {
  if (state.tracks.length < PROJECT_LIMITS.tracks) return true;
  showToast(`В проекте достигнут лимит дорожек (${PROJECT_LIMITS.tracks})`); return false;
}

function projectClipCount() { return state.tracks.reduce((total, track) => total + track.clips.length, 0); }
function canAddClip() {
  if (projectClipCount() < PROJECT_LIMITS.clips) return true;
  showToast(`В проекте достигнут лимит клипов (${PROJECT_LIMITS.clips})`); return false;
}
function projectEventCount() {
  return state.tracks.reduce((total, track) => total + track.clips.reduce((trackTotal, clip) => trackTotal +
    (clip.kind === 'midi' ? clip.notes.length : clip.kind === 'drums' ? clip.steps.reduce((stepTotal, row) => stepTotal + row.hits.length, 0) : clip.kind === 'automation' ? clip.points.length : 0), 0), 0);
}
function clipEventCount(clip) { return clip.kind === 'midi' ? clip.notes.length : clip.kind === 'drums' ? clip.steps.reduce((total, row) => total + row.hits.length, 0) : clip.kind === 'automation' ? clip.points.length : 0; }
function canAddEvents(count) {
  if (projectEventCount() + count <= PROJECT_LIMITS.events) return true;
  showToast(`В секвенсоре достигнут лимит событий (${PROJECT_LIMITS.events})`); return false;
}

function getTrack(id) { return state.tracks.find(track => track.id === id); }
function getClip(id) { for (const track of state.tracks) { const clip = track.clips.find(entry => entry.id === id); if (clip) return { clip, track }; } return {}; }

function renderBrowser() {
  const host = $('#browserContent'), search = $('#searchInput').value.trim().toLocaleLowerCase('ru');
  $$('.browser-tab').forEach(button => { const active = button.dataset.tab === state.browserTab; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
  host.setAttribute('aria-labelledby', `tab-${state.browserTab}`);
  const groups = state.browserTab === 'samples' ? groupBy(SAMPLE_LIBRARY, item => item.category) :
    state.browserTab === 'instruments' ? groupBy(INSTRUMENTS, item => item.category) :
    state.browserTab === 'presets' ? groupBy(INSTRUMENT_PRESETS, item => item.category) :
    state.browserTab === 'project' ? groupBy([...state.assets.values()].filter(asset => asset.source !== 'built-in'), asset => asset.source === 'recording' ? 'Мои записи' : asset.source === 'processed' ? 'Обработанные' : 'Импортировано') :
    groupBy(state.recordings.map(id => state.assets.get(id)).filter(Boolean), () => 'Записано в проекте');
  if (state.browserTab === 'recordings' && !state.recordings.length) {
    host.innerHTML = '<div class="empty-browser">Здесь появятся записи с микрофона.<br><br>Нажмите красную кнопку «Запись» сверху.</div>'; return;
  }
  if ((state.browserTab === 'project' || state.browserTab === 'recordings') && !Object.keys(groups).length) {
    host.innerHTML = state.browserTab === 'recordings'
      ? '<div class="empty-browser">Здесь появятся записи с микрофона.<br><br>Нажмите красную кнопку «Запись» сверху.</div>'
      : '<div class="empty-browser">В этом проекте пока нет импортированного аудио.<br><br>Добавьте файл кнопкой ＋ или перетащите его на шкалу.</div>';
    return;
  }
  host.innerHTML = '';
  for (const [category, items] of Object.entries(groups)) {
    const filtered = items.filter(item => `${item.name} ${category}`.toLocaleLowerCase('ru').includes(search));
    if (!filtered.length) continue;
    const label = document.createElement('div'); label.className = 'category-title'; label.textContent = category; host.append(label);
    for (const item of filtered) {
      const row = document.createElement('div'); row.className = 'library-item'; row.draggable = true; row.tabIndex = 0; row.setAttribute('role', 'group'); row.setAttribute('aria-label', `${item.name}; Enter — выбрать, пробел — прослушать, Shift+Enter — добавить`);
      const icon = state.browserTab === 'instruments' || state.browserTab === 'presets' ? '♫' : '◖';
      const audioBuffer = browserItemBuffer(item);
      const detail = audioBuffer ? formatAudioDuration(audioBuffer.duration) : item.detail || (item.source === 'recording' ? 'Запись' : item.source === 'processed' ? 'Обработанное аудио' : 'Аудио');
      row.innerHTML = `<span class="sound-icon">${icon}</span><span class="sound-meta"><strong></strong><small></small></span><button class="preview-button" title="Прослушать" aria-label="Прослушать">▶</button>`;
      $('strong', row).textContent = item.name; $('small', row).textContent = detail;
      $('.preview-button', row).setAttribute('aria-label', `Прослушать: ${item.name}`); $('.preview-button', row).setAttribute('aria-pressed', 'false');
      row.dataset.itemId = item.id;
      if (selectedBrowserItem?.item?.id === item.id) row.classList.add('selected');
      row.addEventListener('click', event => { if (!event.target.closest('.preview-button')) selectBrowserItem(item); });
      row.addEventListener('keydown', event => { if (event.target !== row) return; if (event.key === 'Enter') { event.preventDefault(); if (event.shiftKey) addItemToProject(item); else selectBrowserItem(item); } else if (event.key === ' ') { event.preventDefault(); previewItem(item); } });
      row.addEventListener('dragstart', event => { row.classList.add('dragging'); selectBrowserItem(item); const assetId = item.kind ? ensureLibraryAsset(item) : (item.id || ''); const preset = state.browserTab === 'presets'; const instrument = state.browserTab === 'instruments' || preset; event.dataTransfer.setData('application/x-sonora-asset', JSON.stringify({ id: assetId, name: item.name, kind: item.kind || null, instrument: instrument ? (item.instrument || item.id) : null, synthSettings: preset ? item.synthSettings : null, type: instrument ? 'instrument' : 'audio' })); event.dataTransfer.effectAllowed = 'copy'; });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      $('.preview-button', row).addEventListener('click', event => { event.stopPropagation(); previewItem(item); });
      row.addEventListener('dblclick', () => addItemToProject(item));
      host.append(row);
    }
  }
  if (!host.children.length) host.innerHTML = '<div class="empty-browser">По этому запросу ничего не найдено.<br><br>Измените поисковый запрос или выберите другую вкладку.</div>';
}

function groupBy(items, keyFn) { return items.reduce((result, item) => { const key = keyFn(item); (result[key] ||= []).push(item); return result; }, {}); }

function browserItemBuffer(item) {
  if (item.kind) return getLibraryBuffer(item);
  return state.assets.get(item.id)?.buffer || null;
}

function selectBrowserItem(item) {
  if (browserPreviewSource && browserPreviewSourceId !== item.id) stopBrowserPreview();
  const buffer = browserItemBuffer(item);
  selectedBrowserItem = { item, buffer };
  renderBrowserPreview();
  $$('.library-item').forEach(row => row.classList.toggle('selected', row.dataset.itemId === item.id));
}

function stopBrowserPreview() {
  browserPreviewGeneration++;
  const source = browserPreviewSource;
  browserPreviewSource = null; browserPreviewSourceId = null;
  try { source?.stop?.(); } catch {}
  const button = $('#browserPreviewPlay');
  if (button) { button.textContent = '▶'; button.setAttribute('aria-label', 'Прослушать выбранный звук'); button.setAttribute('aria-pressed', 'false'); }
  $$('.library-item').forEach(row => { const preview = $('.preview-button', row); preview?.setAttribute('aria-pressed', 'false'); preview?.setAttribute('aria-label', `Прослушать: ${row.querySelector('strong')?.textContent || 'звук'}`); preview?.classList.remove('is-playing'); if (preview) preview.textContent = '▶'; });
  if (selectedBrowserItem) renderBrowserPreview();
}

function previewItem(item = selectedBrowserItem?.item) {
  if (!item) return;
  if (selectedBrowserItem?.item?.id !== item.id) selectBrowserItem(item);
  if (browserPreviewSource && browserPreviewSourceId === item.id) { stopBrowserPreview(); return; }
  stopBrowserPreview();
  const generation = browserPreviewGeneration;
  if (item.instrument || INSTRUMENTS.some(instrument => instrument.id === item.id)) {
    browserPreviewSource = previewNote(item.instrument || item.id, 60, item.synthSettings || null);
    window.setTimeout(() => { if (generation === browserPreviewGeneration) stopBrowserPreview(); }, (browserPreviewSource?.durationSeconds || .9) * 1000);
  } else {
    const buffer = selectedBrowserItem?.buffer || browserItemBuffer(item);
    if (!buffer) { showToast('Для этого элемента нет доступного аудио'); return; }
    const context = getAudioContext();
    const source = playBuffer(buffer, context.currentTime + .015, { gain: .8 });
    browserPreviewSource = { stop: () => { try { source.stop(); } catch {} } };
    source.addEventListener('ended', () => { if (generation === browserPreviewGeneration) stopBrowserPreview(); }, { once: true });
  }
  browserPreviewSourceId = item.id;
  const button = $('#browserPreviewPlay');
  if (button) { button.textContent = 'Ⅱ'; button.setAttribute('aria-label', 'Остановить предпрослушивание'); button.setAttribute('aria-pressed', 'true'); }
  $$('.library-item').forEach(row => { const active = row.dataset.itemId === item.id, preview = $('.preview-button', row); preview?.setAttribute('aria-pressed', String(active)); if (active) preview?.setAttribute('aria-label', `Остановить: ${item.name}`); preview?.classList.toggle('is-playing', active); if (preview) preview.textContent = active ? 'Ⅱ' : '▶'; });
}

function renderBrowserPreview() {
  const panel = $('#browserPreview');
  if (!panel) return;
  const selected = selectedBrowserItem;
  panel.hidden = !selected;
  if (!selected) return;
  const { item, buffer } = selected;
  $('#browserPreviewName').textContent = item.name || 'Без названия';
  const isInstrument = Boolean(item.instrument || INSTRUMENTS.some(instrument => instrument.id === item.id));
  const sourceLabel = item.source === 'recording' ? 'Запись' : item.source === 'processed' ? 'Обработанный звук' : item.kind ? 'Системный сэмпл' : item.instrument ? 'Инструментальный пресет' : INSTRUMENTS.some(instrument => instrument.id === item.id) ? 'Встроенный инструмент' : item.fileName || 'Аудио в проекте';
  $('#browserPreviewSource').textContent = sourceLabel;
  const info = $('#browserPreviewInfo'), canvas = $('#browserPreviewWaveform'), playButton = $('#browserPreviewPlay');
  playButton.disabled = false;
  if (buffer) {
    const memoryBytes = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
    const seconds = buffer.duration;
    const duration = formatAudioDuration(seconds);
    const channels = buffer.numberOfChannels === 1 ? 'Моно' : buffer.numberOfChannels === 2 ? 'Стерео' : `${buffer.numberOfChannels} каналов`;
    info.textContent = `${buffer.sampleRate.toLocaleString('ru-RU')} Гц · ${channels} · Float32 · ${duration} · ${formatBytes(memoryBytes)} в памяти`;
    canvas.hidden = false;
    canvas.setAttribute('aria-label', `Волновая форма: ${item.name || 'аудио'}`);
    drawBrowserWaveform(canvas, buffer.getChannelData(0));
  } else if (isInstrument) {
    info.textContent = `${item.detail || 'Встроенный синтезатор'} · MIDI C4 · синтезируется локально`;
    const instrument = item.instrument || item.id;
    drawBrowserOscillatorWaveform(canvas, instrument, item.synthSettings);
    canvas.hidden = false;
    canvas.setAttribute('aria-label', `Один цикл осциллятора: ${item.name || 'инструмент'}`);
  } else {
    info.textContent = 'Аудиоданные недоступны'; canvas.hidden = true; playButton.disabled = true;
  }
  playButton.setAttribute('aria-label', browserPreviewSourceId === item.id ? 'Остановить предпрослушивание' : 'Прослушать выбранный звук');
  playButton.setAttribute('aria-pressed', String(browserPreviewSourceId === item.id));
  playButton.textContent = browserPreviewSourceId === item.id ? 'Ⅱ' : '▶';
}

function drawBrowserWaveform(canvas, samples) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const width = canvas.width, height = canvas.height, peaks = sampleWaveformPeaks(samples, width);
  context.clearRect(0, 0, width, height);
  context.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--waveform').trim() || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ed9868';
  context.lineWidth = 1;
  context.beginPath();
  const middle = height / 2;
  for (let index = 0; index < peaks.length; index++) {
    const amplitude = Math.max(1, peaks[index] * (height * .45));
    context.moveTo(index + .5, middle - amplitude);
    context.lineTo(index + .5, middle + amplitude);
  }
  context.stroke();
}

function drawBrowserOscillatorWaveform(canvas, instrument, rawSettings = null) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const width = canvas.width, height = canvas.height, middle = height / 2;
  context.clearRect(0, 0, width, height);
  context.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--waveform').trim() || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ed9868';
  context.lineWidth = 1.5; context.beginPath();
  for (let index = 0; index < width; index++) {
    const phase = index / (width - 1);
    const sample = instrumentWaveAt(instrument, phase, rawSettings?.waveform || 'preset');
    const y = middle - clamp(sample, -1, 1) * (height * .43);
    if (index === 0) context.moveTo(index, y); else context.lineTo(index, y);
  }
  context.stroke();
}

function clearBrowserSelection() {
  stopBrowserPreview(); selectedBrowserItem = null; renderBrowserPreview();
}

function formatAudioDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  return Math.floor(seconds / 60) + ':' + (seconds % 60).toFixed(2).padStart(5, '0');
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${Math.round(value)} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КиБ`;
  return `${(value / (1024 * 1024)).toFixed(1)} МиБ`;
}

function playBuffer(buffer, at, options = {}) {
  const context = options.context || getAudioContext(), source = context.createBufferSource(), gain = context.createGain();
  source.buffer = buffer; source.playbackRate.value = 2 ** ((options.pitch || 0) / 12);
  gain.gain.value = options.gain ?? 0.8; source.connect(gain); gain.connect(options.destination || context.destination);
  source.start(Math.max(at, context.currentTime), options.offset || 0);
  return source;
}

function previewNote(instrument = 'soft-keys', note = 60, rawSettings = null) {
  const settings = normalizeSynthSettings(rawSettings, instrument), attack = settings.attackMs / 1000, release = settings.releaseMs / 1000;
  const context = getAudioContext(), when = context.currentTime + .02, gain = context.createGain();
  gain.gain.setValueAtTime(.0001, when); gain.gain.exponentialRampToValueAtTime(.2, when + attack); gain.gain.exponentialRampToValueAtTime(.0001, when + Math.max(.08, attack + release));
  gain.connect(context.destination);
  const oscillators = createInstrumentSources(context, gain, when, note, instrument, settings);
  const durationSeconds = Math.max(.1, attack + release + .03);
  for (const osc of oscillators) osc.stop(when + durationSeconds);
  return { durationSeconds, stop: () => oscillators.forEach(osc => { try { osc.stop(); } catch {} }) };
}

function createInstrumentSources(context, destination, when, note, instrument, rawSettings = null) {
  const settings = normalizeSynthSettings(rawSettings, instrument);
  const frequency = 440 * 2 ** ((note - 69) / 12);
  const components = settings.waveform !== 'preset' ? [[settings.waveform, 1, 1]] :
    instrument === 'bass' ? [['sawtooth', 1, 1]] : instrument === 'pad' ? [['triangle', 1, 1]] :
    instrument === 'soft-keys' ? [['sine', 1, .88], ['sine', 2, .12]] : [['sine', 1, 1]];
  let target = destination;
  if (settings.cutoffHz < 20_000) {
    const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.setValueAtTime(settings.cutoffHz, when); filter.Q.setValueAtTime(.707, when);
    filter.connect(destination); target = filter;
  }
  return components.map(([type, ratio, level]) => {
    const osc = context.createOscillator(), partial = context.createGain();
    osc.type = type; osc.frequency.setValueAtTime(frequency * ratio, when); osc.detune.setValueAtTime(settings.detuneCents, when); partial.gain.value = level;
    osc.connect(partial); partial.connect(target); osc.start(when); return osc;
  });
}

function addItemToProject(item, targetTrackId = state.selectedTrackId, startBeat = state.playheadBeat) {
  if (item.instrument || ((state.browserTab === 'instruments' || state.browserTab === 'presets') && item.category)) {
    const instrumentId = item.instrument || item.id;
    let track = getTrack(targetTrackId);
    if (!track || track.type !== 'instrument') track = addTrack('instrument', item.name);
    if (!track) return;
    recordUndo(); track.instrument = instrumentId; track.synthSettings = normalizeSynthSettings(item.synthSettings ?? track.synthSettings, instrumentId); state.selectedTrackId = track.id; state.selectedClipId = null; renderAll(); showToast(state.browserTab === 'presets' ? `Пресет «${item.name}» применён` : 'Инструмент добавлен в проект'); return;
  }
  const id = item.kind ? ensureLibraryAsset(item) : item.id;
  if (!id) return;
  const asset = state.assets.get(id); if (!asset) { showToast('Сначала импортируйте аудиофайл'); return; }
  let track = getTrack(targetTrackId); if (!track || track.type === 'instrument') track = addTrack('audio', item.name);
  if (!track || !canAddClip()) return;
  const clip = { id: uid('clip'), name: item.name, assetId: id, startBeat: snapBeat(startBeat), lengthBeats: asset.buffer.duration / beatSeconds(), offsetSec: 0, trimEndSec: 0, pitch: 0, volume: 1, pan: 0, color: track.color };
  recordUndo(); track.clips.push(clip); state.selectedClipId = clip.id; state.selectedTrackId = track.id; renderAll(); showToast(`«${item.name}» добавлен на шкалу`);
}

function addTrack(type = 'audio', name) {
  if (!canAddTrack()) return null;
  recordUndo();
  const palette = themePalette();
  const track = { id: uid('track'), name: name || (type === 'instrument' ? 'Инструмент' : type === 'drums' ? 'Ритм' : `Аудио ${state.tracks.filter(t => t.type === 'audio').length + 1}`), type, color: palette[state.tracks.length % palette.length], volume: .8, pan: 0, mute: false, solo: false, clips: [] };
  if (type === 'instrument') { track.instrument = 'soft-keys'; track.synthSettings = normalizeSynthSettings(null, track.instrument); }
  state.tracks.push(track); state.selectedTrackId = track.id; renderAll(); return track;
}

function snapBeat(beat) { return Math.max(0, Math.round(beat * 4) / 4); }

function createDrumPattern() {
  let track = getTrack(state.selectedTrackId); if (!track || track.type !== 'drums') track = addTrack('drums', 'Drum rack');
  if (!track || !canAddClip() || !canAddEvents(12)) return;
  recordUndo(); const palette = themePalette(); const steps = [
    { name: 'Бочка', kind: 'kick', color: palette[0], velocity: .82, hits: [0, 8] },
    { name: 'Малый', kind: 'snare', color: palette[1], velocity: .76, hits: [4, 12] },
    { name: 'Хэт', kind: 'hat', color: palette[2], velocity: .62, hits: [0, 2, 4, 6, 8, 10, 12, 14] },
    { name: 'Хлопок', kind: 'clap', color: palette[3], velocity: .78, hits: [] },
  ];
  track.steps = steps; state.view = 'rack';
  const clip = { id: uid('clip'), name: 'Ритм · 1 такт', kind: 'drums', startBeat: snapBeat(state.playheadBeat), lengthBeats: 4, steps: steps.map(row => ({ ...row, hits: [...row.hits] })), color: track.color };
  track.clips.push(clip); state.selectedClipId = clip.id; renderAll(); showToast('Паттерн добавлен на шкалу');
}

function createMidiPattern() {
  let track = getTrack(state.selectedTrackId); if (!track || track.type !== 'instrument') track = addTrack('instrument', 'Синтезатор');
  if (!track || !canAddClip() || !canAddEvents(4)) return;
  recordUndo(); const notes = [{ beat: 0, length: 1, note: 60, velocity: .75 }, { beat: 1, length: 1, note: 64, velocity: .7 }, { beat: 2, length: 1, note: 67, velocity: .8 }, { beat: 3, length: 1, note: 64, velocity: .7 }];
  const clip = { id: uid('clip'), name: 'Мелодия · 1 такт', kind: 'midi', startBeat: snapBeat(state.playheadBeat), lengthBeats: 4, notes, color: track.color };
  track.clips.push(clip); state.selectedClipId = clip.id; state.view = 'piano'; renderAll(); showToast('MIDI-партия создана');
}

function automationRange(target) { return target === 'pan' ? [-1, 1] : [0, 1.2]; }
function automationLabel(target) { return target === 'pan' ? 'панорама' : 'громкость'; }
function automationValueAtBeat(track, target, beat, fallback) {
  const active = track.clips.filter(clip => clip.kind === 'automation' && clip.target === target && beat >= clip.startBeat)
    .sort((left, right) => left.startBeat - right.startBeat).at(-1);
  return active ? sampleAutomation(active.points, clamp(beat - active.startBeat, 0, active.lengthBeats), fallback) : fallback;
}
function createAutomationClip(target = 'volume') {
  const track = getTrack(state.selectedTrackId);
  if (!track || !canAddClip() || !canAddEvents(2)) return;
  const [minimum, maximum] = automationRange(target);
  const base = target === 'pan' ? Number(track.pan || 0) : Number(track.volume ?? .8);
  const value = clamp(base, minimum, maximum), startBeat = snapBeat(state.playheadBeat), lengthBeats = 16;
  recordUndo();
  const label = automationLabel(target);
  const clip = { id: uid('clip'), name: `${label} · автоматизация`, kind: 'automation', target, startBeat, lengthBeats,
    points: [{ beat: 0, value }, { beat: lengthBeats, value }], color: track.color };
  track.clips.push(clip); state.selectedClipId = clip.id; state.view = 'automation';
  renderAll(); restartProjectPlaybackIfActive(); showToast(`Клип автоматизации ${label} создан`);
}
function trackVolumeAtBeat(track, beat) { return automationValueAtBeat(track, 'volume', beat, track.volume ?? .8); }
function trackPanAtBeat(track, beat) { return automationValueAtBeat(track, 'pan', beat, track.pan || 0); }
function automationSvgPath(clip) {
  const width = 620, height = 100, insetX = 10, insetY = 8, [minimum, maximum] = automationRange(clip.target);
  return (clip.points || []).map((point, index) => {
    const x = insetX + (point.beat / clip.lengthBeats) * (width - insetX * 2);
    const y = height - insetY - ((clamp(point.value, minimum, maximum) - minimum) / (maximum - minimum)) * (height - insetY * 2);
    return `${index ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');
}

function addAutomationPoint(clip) {
  const beat = snapBeat(state.playheadBeat - clip.startBeat);
  if (beat <= 0 || beat >= clip.lengthBeats) { showToast('Поставьте курсор внутри клипа автоматизации'); return; }
  if (clip.points.some(point => Math.abs(point.beat - beat) < .001)) { showToast('В этой позиции уже есть точка'); return; }
  if (!canAddEvents(1)) return;
  recordUndo(); clip.points.push({ beat, value: sampleAutomation(clip.points, beat, .8) }); clip.points.sort((a, b) => a.beat - b.beat);
  markProjectDirty(); renderTimeline(); renderEditor(); restartProjectPlaybackIfActive();
}

function formatAutomationValue(target, value) { return target === 'pan' ? Number(value).toFixed(2) : `${Math.round(Number(value) * 100)}%`; }
function renderAutomationEditor(body, clip, track) {
  const label = automationLabel(clip.target), [minimum, maximum] = automationRange(clip.target);
  const svg = `<svg class="automation-graph" viewBox="0 0 620 100" role="img" aria-label="Кривая автоматизации: ${label}"><path class="automation-grid-line" d="M10 8H610M10 50H610M10 92H610"/><path class="automation-curve" d="${automationSvgPath(clip)}"/></svg>`;
  body.innerHTML = `<div class="automation-editor"><div class="automation-summary"><strong>${escapeHtml(track.name)} · ${label}</strong><span>Линейная кривая между точками; позиция указана в долях от начала клипа.</span></div>${svg}<div class="automation-point-list" id="automationPointList"></div><p class="field-help">Переместите курсор внутри клипа и добавьте точку. Кривая применяется к ${label} дорожки при воспроизведении и экспорте.</p></div>`;
  const list = $('#automationPointList', body);
  clip.points.forEach((point, index) => {
    const row = document.createElement('div'); row.className = 'automation-point-row';
    row.innerHTML = `<label><span>Позиция, доли</span><input class="automation-beat" type="number" min="0" step="0.25" /></label><label><span>${label}</span><input class="automation-value" type="range" min="${minimum}" max="${maximum}" step="0.01" /><output></output></label><button type="button" class="icon-button small automation-remove" aria-label="Удалить точку автоматизации">×</button>`;
    const beatInput = $('.automation-beat', row), valueInput = $('.automation-value', row), output = $('output', row);
    beatInput.value = String(point.beat); beatInput.max = String(clip.lengthBeats); beatInput.setAttribute('aria-label', `Позиция точки ${index + 1}, доли от начала клипа`);
    valueInput.value = String(point.value); valueInput.setAttribute('aria-label', `${label} точки ${index + 1}`); output.textContent = formatAutomationValue(clip.target, point.value);
    for (const input of [beatInput, valueInput]) input.addEventListener('focus', recordUndo, { once: true });
    valueInput.addEventListener('input', () => { point.value = Number(valueInput.value); output.textContent = formatAutomationValue(clip.target, point.value); markProjectDirty(); $('.automation-curve', body).setAttribute('d', automationSvgPath(clip)); renderTimeline(); });
    valueInput.addEventListener('change', restartProjectPlaybackIfActive);
    beatInput.addEventListener('change', () => {
      const nextBeat = clamp(snapBeat(Number(beatInput.value) || 0), 0, clip.lengthBeats);
      if (clip.points.some((other, otherIndex) => otherIndex !== index && Math.abs(other.beat - nextBeat) < .001)) { showToast('Для каждой позиции нужна отдельная точка'); beatInput.value = String(point.beat); return; }
      point.beat = nextBeat; clip.points.sort((a, b) => a.beat - b.beat); markProjectDirty(); renderTimeline(); renderEditor(); restartProjectPlaybackIfActive();
    });
    const remove = $('.automation-remove', row); remove.disabled = clip.points.length <= 2;
    remove.addEventListener('click', () => { if (clip.points.length <= 2) return; recordUndo(); clip.points.splice(index, 1); markProjectDirty(); renderTimeline(); renderEditor(); restartProjectPlaybackIfActive(); });
    list.append(row);
  });
}

function renderAll() {
  document.documentElement.style.setProperty('--bar', `${state.zoom}px`);
  $('#projectName').value = state.name; $('#tempoInput').value = state.tempo; $('#keySelect').value = state.key;
  $('#masterVolume').value = state.masterVolume;
  $('#loopBtn').setAttribute('aria-pressed', state.loop); $('#metronomeBtn').setAttribute('aria-pressed', state.metronome);
  updateLoopControl();
  renderBrowser(); renderTimeline(); renderEditor(); renderInspector(); renderMixer(); updatePosition(); updateTransport(); updateHistoryButtons();
}

function renderTimeline() {
  const labels = $('#trackLabels'), lanes = $('#trackLanes'), ruler = $('#barRuler'); labels.innerHTML = ''; lanes.innerHTML = ''; ruler.innerHTML = '';
  const bars = Math.max(24, ...state.tracks.flatMap(track => track.clips.map(clip => Math.ceil((clip.startBeat + clip.lengthBeats) / 4) + 4)));
  $('#timelineInner').style.width = `calc(var(--bar) * ${Math.max(32, bars)})`;
  for (let i = 1; i <= Math.max(32, bars); i++) { const tick = document.createElement('div'); tick.className = 'bar-tick'; tick.textContent = String(i).padStart(2, '0'); ruler.append(tick); }
  renderLoopRegion();
  for (const track of state.tracks) {
    const label = document.createElement('div'); label.className = 'track-label'; label.dataset.track = track.id;
    label.innerHTML = `<span class="track-color"></span><span class="track-label-main"><button type="button" class="track-select" data-action="select"><strong></strong><small></small></button></span><span class="track-label-actions"><button type="button" data-action="mute" title="Заглушить">M</button><button type="button" data-action="solo" title="Соло">S</button><button type="button" data-action="remove" title="Удалить дорожку" aria-label="Удалить дорожку">×</button></span>`;
    const selectedTrack = track.id === state.selectedTrackId;
    label.classList.toggle('selected', selectedTrack);
    label.querySelector('.track-color').style.background = track.color;
    const selectButton = $('.track-select', label);
    $('strong', selectButton).textContent = track.name;
    $('small', selectButton).textContent = track.type === 'audio' ? 'AUDIO' : track.type === 'drums' ? 'DRUM RACK' : 'INSTRUMENT';
    selectButton.setAttribute('aria-label', `Выбрать дорожку: ${track.name}`);
    selectButton.setAttribute('aria-pressed', String(selectedTrack));
    for (const mode of ['mute', 'solo']) { const button = $(`[data-action=${mode}]`, label); button.setAttribute('aria-label', `${mode === 'mute' ? 'Заглушить' : 'Соло'}: ${track.name}`); button.setAttribute('aria-pressed', String(Boolean(track[mode]))); }
    for (const action of ['mute', 'solo']) if (track[action]) $(`[data-action=${action}]`, label).classList.add('active');
    label.addEventListener('click', event => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'mute' || action === 'solo') {
        recordUndo(); track[action] = !track[action]; renderAll(); updateLiveTrackMix(); restartProjectPlaybackIfActive();
      } else if (action === 'remove') {
        if (state.tracks.length === 1) { showToast('В проекте должна остаться хотя бы одна дорожка'); return; }
        recordUndo(); state.tracks = state.tracks.filter(t => t.id !== track.id);
        if (state.selectedTrackId === track.id) state.selectedTrackId = state.tracks[0]?.id || null;
        if (getClip(state.selectedClipId).track?.id === track.id) state.selectedClipId = null;
        renderAll();
      } else {
        state.selectedTrackId = track.id; state.selectedClipId = null; renderTimeline(); renderEditor(); renderInspector();
        $$('.track-label', $('#trackLabels')).find(item => item.dataset.track === track.id)?.querySelector('.track-select')?.focus();
      }
    });
    labels.append(label);
    const lane = document.createElement('div'); lane.className = 'track-lane'; lane.dataset.track = track.id;
    lane.addEventListener('dragover', event => { event.preventDefault(); lane.classList.add('drag-over'); });
    lane.addEventListener('dragleave', () => lane.classList.remove('drag-over'));
    lane.addEventListener('drop', event => handleDrop(event, track, lane));
    track.clips.forEach(clip => lane.append(createClipElement(clip, track)));
    lane.addEventListener('pointerdown', event => { if (event.target.closest('.clip') || event.target.closest('.clip-handle')) return; if (event.target === lane) { state.selectedTrackId = track.id; state.selectedClipId = null; renderTimeline(); renderEditor(); renderInspector(); } });
    lanes.append(lane);
  }
  const canvas = $('#tracksCanvas'); canvas.style.minHeight = `${state.tracks.length * 72}px`;
  const line = $('#playheadLine'); line.style.left = `${beatsToPx(state.playheadBeat)}px`;
  canvas.querySelectorAll('.marker-line').forEach(mark => mark.remove());
  for (const marker of state.markers) { const mark = document.createElement('div'); mark.className = 'marker-line'; mark.style.left = `${beatsToPx(marker.beat)}px`; mark.innerHTML = `<span class="marker-label">${escapeHtml(marker.name)}</span>`; canvas.append(mark); }
  $('#timelineScroll').classList.toggle('recording', state.recording);
  $('#barRuler').onpointerdown = beginLoopRangeDrag;
  $('#barRuler').onpointermove = updateLoopRangeDrag;
  $('#barRuler').onpointerup = finishLoopRangeDrag;
  $('#barRuler').onpointercancel = finishLoopRangeDrag;
}

function beatAtRulerPointer(event) {
  const ruler = $('#barRuler'), bounds = ruler.getBoundingClientRect();
  const barWidth = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar'));
  return beatFromRulerPointer(event.clientX, bounds.left, barWidth / BEATS_PER_BAR) ?? 0;
}

function beginLoopRangeDrag(event) {
  if (event.button !== 0 || event.target.closest('button')) return;
  event.preventDefault();
  const beat = beatAtRulerPointer(event);
  loopDrag = { pointerId: event.pointerId, startX: event.clientX, startBeat: beat, changed: false };
  event.currentTarget.setPointerCapture(event.pointerId);
}

function updateLoopRangeDrag(event) {
  if (!loopDrag || loopDrag.pointerId !== event.pointerId) return;
  if (!loopDrag.changed && Math.abs(event.clientX - loopDrag.startX) < 5) return;
  if (!loopDrag.changed) { recordUndo(); loopDrag.changed = true; }
  const range = normalizeLoopRange(loopDrag.startBeat, beatAtRulerPointer(event));
  if (!range) return;
  state.loopStartBeat = range.startBeat;
  state.loopEndBeat = range.endBeat;
  renderLoopRegion();
}

function finishLoopRangeDrag(event) {
  if (!loopDrag || loopDrag.pointerId !== event.pointerId) return;
  const wasSelection = loopDrag.changed;
  if (!wasSelection) {
    state.playheadBeat = beatAtRulerPointer(event);
    updatePosition();
    renderTimeline();
  } else {
    updateLoopControl();
    if (state.playing && state.loop) { stopPlayback(false); play(); }
    showToast(`Цикл A–B: ${loopRangeLabel()}. Нажмите «Цикл», чтобы включить`);
  }
  loopDrag = null;
}

function renderLoopRegion() {
  const region = $('#loopRegion');
  if (!region) return;
  region.style.left = `${beatsToPx(state.loopStartBeat)}px`;
  region.style.width = `${Math.max(1, beatsToPx(state.loopEndBeat - state.loopStartBeat))}px`;
  region.classList.toggle('is-looping', state.loop);
}

function updateLoopControl() {
  const button = $('#loopBtn');
  if (!button) return;
  const rangeText = `Участок цикла A–B: ${loopRangeLabel()}`;
  button.title = `${rangeText}. Перетащите линейку тактов, чтобы выбрать участок`;
  button.setAttribute('aria-label', `${state.loop ? 'Выключить' : 'Включить'} цикл. ${rangeText}`);
  button.setAttribute('aria-pressed', String(state.loop));
}

function setLoopBoundary(boundary) {
  const beat = state.playheadBeat;
  const range = boundary === 'start'
    ? normalizeLoopRange(beat, Math.max(state.loopEndBeat, beat + 0.25))
    : normalizeLoopRange(Math.min(state.loopStartBeat, beat - 0.25), beat);
  if (!range) return;
  recordUndo();
  state.loopStartBeat = range.startBeat;
  state.loopEndBeat = range.endBeat;
  renderLoopRegion();
  updateLoopControl();
  if (state.playing) { stopPlayback(false); play(); }
  showToast(`Граница ${boundary === 'start' ? 'A' : 'B'} цикла установлена на ${formatBarBeat(beat)}`);
}

function formatBarBeat(beat) {
  return `${Math.floor(beat / 4) + 1}:${Number((beat % 4 + 1).toFixed(2))}`;
}

function loopRangeLabel() { return `${formatBarBeat(state.loopStartBeat)}–${formatBarBeat(state.loopEndBeat)}`; }

function createClipElement(clip, track) {
  const el = document.createElement('div'); el.className = `clip ${['drums', 'midi'].includes(clip.kind) ? 'pattern' : ''} ${clip.kind === 'automation' ? 'automation-clip' : ''} ${clip.id === state.selectedClipId ? 'selected' : ''} ${clip.colorClass || ''}`;
  el.dataset.clip = clip.id; el.style.left = `${beatsToPx(clip.startBeat)}px`; el.style.width = `${Math.max(27, beatsToPx(clip.lengthBeats) - 3)}px`; el.style.borderColor = track.color;
  if (!clip.kind) el.style.backgroundColor = `${track.color}44`;
  const typeLabel = clip.kind === 'drums' ? 'RHYTHM' : clip.kind === 'midi' ? 'MIDI' : clip.kind === 'automation' ? 'VOL' : 'AUDIO';
  el.innerHTML = `<div class="clip-header"><span></span><small>${typeLabel}</small></div>${clip.kind === 'automation' ? '' : '<span class="clip-handle left" data-handle="left"></span><span class="clip-handle right" data-handle="right"></span>'}`;
  $('.clip-header span', el).textContent = clip.name;
  if (clip.kind === 'drums') {
    const preview = document.createElement('div'); preview.className = 'pattern-preview';
    for (let i = 0; i < 16; i++) { const bar = document.createElement('i'); bar.style.height = `${5 + ((clip.steps || []).reduce((n, row) => n + row.hits.filter(hit => hit === i).length, 0) * 4)}px`; preview.append(bar); }
    el.append(preview);
  } else if (clip.kind === 'midi') {
    const preview = document.createElement('div'); preview.className = 'pattern-preview';
    for (let i = 0; i < 16; i++) { const bar = document.createElement('i'); bar.style.height = `${5 + (((clip.notes || []).filter(note => Math.round(note.beat * 4) === i).length) * 6)}px`; preview.append(bar); }
    el.append(preview);
  } else if (clip.kind === 'automation') {
    const preview = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); preview.setAttribute('viewBox', '0 0 620 100'); preview.setAttribute('aria-hidden', 'true'); preview.classList.add('automation-preview');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', automationSvgPath(clip)); preview.append(path); el.append(preview);
  } else {
    const canvas = document.createElement('canvas'); canvas.className = 'waveform'; canvas.width = 420; canvas.height = 52; el.append(canvas);
    const asset = state.assets.get(clip.renderedAssetId && !clip.bypassProcessing ? clip.renderedAssetId : clip.assetId); if (asset) drawWaveform(canvas, asset.buffer, track.color, clip);
    const durationSec = clip.lengthBeats * 60 / state.tempo;
    const fades = normalizeClipFades(durationSec, clip.fadeInSec, clip.fadeOutSec);
    for (const [side, seconds] of [['in', fades.fadeInSec], ['out', fades.fadeOutSec]]) if (seconds > 0) {
      const fade = document.createElement('span'); fade.className = `clip-fade clip-fade-${side}`;
      fade.style.width = `${Math.min(50, seconds / durationSec * 100)}%`; el.append(fade);
    }
    if (clip.gainEnvelope) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('clip-gain-envelope-curve'); svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', clipGainEnvelopeSvgPath(clip)); svg.append(path); el.append(svg);
    }
  }
  el.addEventListener('pointerdown', event => beginClipDrag(event, clip, el));
  el.addEventListener('click', event => { event.stopPropagation(); state.selectedClipId = clip.id; state.selectedTrackId = track.id; if (clip.kind === 'automation') state.view = 'automation'; renderTimeline(); renderEditor(); renderInspector(); });
  el.addEventListener('contextmenu', event => { event.preventDefault(); state.selectedClipId = clip.id; state.selectedTrackId = track.id; renderInspector(); const action = confirm('Удалить выбранный клип?') ? 'delete' : 'cancel'; if (action === 'delete') deleteSelectedClip(); });
  return el;
}

function drawWaveform(canvas, buffer, color, clip = null) {
  const ctx=canvas.getContext('2d'),width=canvas.width,height=canvas.height,data=buffer.getChannelData(0);
  const start=clip?getClipSourceOffsetSec(clip):0,end=clip?Math.min(buffer.duration-getClipSourceTrimEndSec(clip),start+clip.lengthBeats*beatSeconds()*getClipPlaybackRate(clip)):buffer.duration;
  const first=clamp(Math.floor(start*buffer.sampleRate),0,data.length),last=clamp(Math.ceil(end*buffer.sampleRate),first,data.length);
  const peaks=sampleWaveformPeaks(data,width,first,last),step=peaks.length?width/peaks.length:0;
  ctx.clearRect(0,0,width,height);ctx.fillStyle=color||'#80c7a6';
  for(let x=0;x<peaks.length;x++){const h=Math.max(1,peaks[x]*height*.86);ctx.fillRect(x*step,(height-h)/2,Math.max(1,step),h);}
}

async function sliceAudioAtTransients(clip, sensitivity, minSpacingMs) {
  const button = $('#sliceTransientsBtn'), status = $('#sliceTransientStatus'), asset = state.assets.get(clip.assetId);
  if (!button || button.disabled || getClip(clip.id).clip !== clip || !asset?.buffer) return;
  if (clip.renderedAssetId || clip.timeStretchRatio || clip.clapPluginName || clip.autoTune || clip.bypassProcessing) {
    status.textContent = 'Сначала сбросьте обработку клипа.'; return;
  }
  const buffer = asset.buffer, rate = getClipPlaybackRate(clip, false), tempo = state.tempo, sr = buffer.sampleRate;
  const sourceStart = Math.max(0, Number(clip.offsetSec) || 0);
  const sourceEnd = Math.min(buffer.duration - Math.max(0, Number(clip.trimEndSec) || 0),
    sourceStart + clip.lengthBeats * beatSeconds() * rate);
  const startFrame = clamp(Math.round(sourceStart * sr), 0, buffer.length);
  const endFrame = clamp(Math.round(sourceEnd * sr), startFrame, buffer.length);
  if (!Number.isFinite(rate) || rate <= 0 || endFrame - startFrame < sr * .05) {
    status.textContent = 'В клипе слишком мало доступного аудио.'; return;
  }
  button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = 'Анализирую…';
  status.textContent = 'Анализ выполняется локально…';
  try {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
    const detections = await detectTransientFrames(channels, sr, { startFrame, endFrame, sensitivity, minSpacingMs });
    if (detections === null) { status.textContent = 'Фрагмент слишком длинный или повреждён. Обрежьте и повторите.'; return; }
    const gap = Math.round(minSpacingMs * sr / 1000);
    const cuts = detections.filter(frame => frame - startFrame >= gap && endFrame - frame >= gap);
    if (!cuts.length) { status.textContent = 'Транзиенты не найдены. Увеличьте чувствительность.'; return; }
    if (cuts.length > 255) { status.textContent = 'Слишком много точек. Увеличьте минимальный интервал.'; return; }
    const found = getClip(clip.id), track = found.track, index = track?.clips.indexOf(clip) ?? -1;
    if (found.clip !== clip || state.selectedClipId !== clip.id || state.tempo !== tempo || index < 0) {
      status.textContent = 'Клип изменился во время анализа. Повторите.'; return;
    }
    if (projectClipCount() + cuts.length > PROJECT_LIMITS.clips) { status.textContent = 'Достигнут лимит клипов проекта.'; return; }
    const edges = [startFrame, ...cuts, endFrame], parts = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const first = edges[i], last = edges[i + 1], part = structuredClone(clip);
      part.id = i ? uid('clip') : clip.id; part.name = i ? clip.name + ' · ' + (i + 1) : clip.name;
      part.startBeat = clip.startBeat + (first - startFrame) / sr / rate * tempo / 60;
      part.lengthBeats = (last - first) / sr / rate * tempo / 60;
      part.offsetSec = first / sr; part.trimEndSec = Math.max(0, buffer.duration - last / sr);
      part.fadeInSec = i ? 0 : clip.fadeInSec || 0; part.fadeOutSec = i === edges.length - 2 ? clip.fadeOutSec || 0 : 0;
      parts.push(part);
    }
    recordUndo(); track.clips.splice(index, 1, ...parts); state.selectedClipId = parts[0].id;
    markProjectDirty(); restartPlaybackIfActive(); renderAll(); showToast('Клип нарезан на ' + parts.length + ' фрагмента');
  } catch (error) {
    console.error('Transient slicing failed', error); status.textContent = 'Не удалось проанализировать аудио.';
  } finally {
    if (button.isConnected) { button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = 'Нарезать по транзиентам'; }
  }
}

function clipGainEnvelopeSvgPath(clip) {
  return normalizeClipGainEnvelope(clip.gainEnvelope)
    .map((point, index) => `${index ? 'L' : 'M'}${(point.position * 100).toFixed(2)},${(88 - point.gain / 1.5 * 70).toFixed(2)}`)
    .join(' ');
}

function renderClipGainEnvelopeControls(clip) {
  if (!clip.gainEnvelope) return `<div class="property clip-gain-envelope-property">
    <label>ОГИБАЮЩАЯ УСИЛЕНИЯ КЛИПА</label>
    <small class="field-help">Задайте форму громкости внутри клипа, не меняя исходный звук.</small>
    <button class="button quiet compact" id="createClipGainEnvelope" type="button">Создать кривую громкости</button>
  </div>`;
  const points = normalizeClipGainEnvelope(clip.gainEnvelope);
  const rows = points.map((point, index) => `<div class="clip-gain-point">
    <label for="clipGainPosition${index}">Точка ${index + 1} · доли</label>
    <input id="clipGainPosition${index}" data-clip-gain-position="${index}" type="number" min="0" max="${clip.lengthBeats}" step="0.25" value="${(point.position * clip.lengthBeats).toFixed(2)}" ${index === 0 || index === points.length - 1 ? 'disabled' : ''} />
    <label for="clipGainValue${index}">Уровень</label>
    <div class="clip-gain-value"><input id="clipGainValue${index}" data-clip-gain-value="${index}" type="range" min="0" max="1.5" step="0.01" value="${point.gain}" /><output>${point.gain.toFixed(2)}×</output></div>
    <button class="button quiet compact" data-clip-gain-remove="${index}" type="button" ${points.length <= 2 ? 'disabled' : ''} aria-label="Удалить точку ${index + 1}">−</button>
  </div>`).join('');
  return `<div class="property clip-gain-envelope-property">
    <label>ОГИБАЮЩАЯ УСИЛЕНИЯ КЛИПА</label>
    <small class="field-help">Кривая действует в воспроизведении, WASAPI и WAV-экспорте.</small>
    <div class="clip-gain-envelope-actions"><button class="button quiet compact" id="addClipGainEnvelopePoint" type="button" ${points.length >= CLIP_GAIN_ENVELOPE_MAX_POINTS ? 'disabled' : ''}>＋ Точка у курсора</button><button class="button quiet compact" id="removeClipGainEnvelope" type="button">Убрать кривую</button></div>
    <div class="clip-gain-points">${rows}</div>
  </div>`;
}

function beginClipDrag(event, clip, element) {
  if (event.button !== 0) return; event.stopPropagation();
  if (splitMode) { splitClip(clip); splitMode = false; $('#splitTool').classList.remove('selected'); return; }
  state.selectedClipId = clip.id; state.selectedTrackId = getClip(clip.id).track?.id;
  const handle = event.target.closest('[data-handle]')?.dataset.handle || '';
  dragState = { clip, element, handle, x: event.clientX, startBeat: clip.startBeat, lengthBeats: clip.lengthBeats, offsetSec: clip.offsetSec || 0, changed: false };
  element.setPointerCapture?.(event.pointerId); element.classList.add('selected'); element.addEventListener('pointermove', moveClipDrag); element.addEventListener('pointerup', endClipDrag, { once: true }); element.addEventListener('pointercancel', endClipDrag, { once: true });
  renderEditor();
}

function moveClipDrag(event) {
  if (!dragState) return; const dx = event.clientX - dragState.x, delta = pxToBeats(dx), clip = dragState.clip;
  if (Math.abs(dx) > 3 && !dragState.changed) { recordUndo(); dragState.changed = true; }
  if (dragState.handle === 'right') { clip.lengthBeats = Math.max(.25, snapBeat(dragState.lengthBeats + delta)); }
  else if (dragState.handle === 'left') { const move = clamp(snapBeat(delta), -dragState.startBeat, dragState.lengthBeats - .25); clip.startBeat = dragState.startBeat + move; clip.lengthBeats = Math.max(.25, snapBeat(dragState.lengthBeats - move)); if (!clip.kind) clip.offsetSec = Math.max(0, dragState.offsetSec + move * beatSeconds()); }
  else clip.startBeat = Math.max(0, snapBeat(dragState.startBeat + delta));
  dragState.element.style.left = `${beatsToPx(clip.startBeat)}px`; dragState.element.style.width = `${Math.max(27, beatsToPx(clip.lengthBeats) - 3)}px`;
}

function endClipDrag() { if (!dragState) return; const el = dragState.element; el.removeEventListener('pointermove', moveClipDrag); if (dragState.changed) renderAll(); dragState = null; }

async function handleDrop(event, track, lane) {
  event.preventDefault(); lane.classList.remove('drag-over');
  let drop;
  try { drop = JSON.parse(event.dataTransfer.getData('application/x-sonora-asset')); } catch { return; }
  const bounds = lane.getBoundingClientRect(), x = event.clientX - bounds.left + $('#timelineScroll').scrollLeft, start = snapBeat(pxToBeats(x));
  if (drop.instrument) { if (track.type !== 'instrument') { track = addTrack('instrument', drop.name); } if (!track) return; track.instrument = drop.instrument; track.synthSettings = normalizeSynthSettings(drop.synthSettings ?? track.synthSettings, track.instrument); state.selectedTrackId = track.id; state.selectedClipId = null; renderAll(); return; }
  if (!drop.id || !state.assets.has(drop.id)) return;
  addItemToProject({ id: drop.id, name: drop.name }, track.id, start);
}

function splitClip(clip) {
  const found = getClip(clip.id), point = state.playheadBeat;
  if (!found.track || point <= clip.startBeat || point >= clip.startBeat + clip.lengthBeats) { showToast('Курсор должен находиться внутри клипа'); return; }
  const leftLength = point - clip.startBeat;
  if (!canAddClip()) return;
  const audioParts = !clip.kind ? splitAudioClip(clip, point, state.tempo) : null;
  if (!clip.kind && !audioParts) { showToast('Не удалось разделить аудиоклип'); return; }
  if (!clip.kind && clip.gainEnvelope) {
    const envelope = splitClipGainEnvelope(clip.gainEnvelope, leftLength / clip.lengthBeats);
    if (!envelope) { showToast('Не удалось разделить огибающую громкости'); return; }
    audioParts.left.gainEnvelope = envelope.left; audioParts.right.gainEnvelope = envelope.right;
  }
  const partition = clip.kind === 'midi' || clip.kind === 'drums' ? splitSequencerEvents(clip, leftLength) : null;
  if ((clip.kind === 'midi' || clip.kind === 'drums') && !partition) { showToast('Не удалось разделить содержимое партии'); return; }
  const additionalEvents = clip.kind === 'midi' ? Math.max(0, partition.leftEvents.length + partition.rightEvents.length - clip.notes.length)
    : clip.kind === 'automation' ? 1 : 0;
  if (!canAddEvents(additionalEvents)) return;
  recordUndo();
  const right = structuredClone(clip);
  if (!clip.kind) {
    Object.assign(clip, audioParts.left);
    Object.assign(right, audioParts.right);
  } else {
    right.id = uid('clip'); right.startBeat = point; right.lengthBeats = clip.lengthBeats - leftLength;
  }
  right.id = uid('clip');
  if (clip.kind === 'automation') {
    const splitValue = sampleAutomation(clip.points, leftLength, found.track.volume ?? .8);
    const originalPoints = clip.points;
    clip.points = [...originalPoints.filter(point => point.beat < leftLength), { beat: leftLength, value: splitValue }];
    right.points = [{ beat: 0, value: splitValue }, ...originalPoints.filter(point => point.beat > leftLength).map(point => ({ ...point, beat: point.beat - leftLength }))];
    clip.lengthBeats = leftLength;
  } else if (clip.kind === 'midi' || clip.kind === 'drums') {
    if (clip.kind === 'midi') { clip.notes = partition.leftEvents; right.notes = partition.rightEvents; }
    else { clip.steps = partition.leftEvents; right.steps = partition.rightEvents; }
    clip.lengthBeats = leftLength;
  } else if (clip.kind) { clip.lengthBeats = leftLength; }
  found.track.clips.push(right); state.selectedClipId = right.id; renderAll(); showToast('Клип разделён');
}

function bindClipGainEnvelopeEditor(clip) {
  $('#createClipGainEnvelope')?.addEventListener('click', () => {
    recordUndo(); clip.gainEnvelope = [{ position: 0, gain: 1 }, { position: 1, gain: 1 }]; renderAll();
  });
  $('#removeClipGainEnvelope')?.addEventListener('click', () => {
    recordUndo(); delete clip.gainEnvelope; restartPlaybackIfActive(); renderAll();
  });
  $('#addClipGainEnvelopePoint')?.addEventListener('click', () => {
    const position = clamp((state.playheadBeat - clip.startBeat) / clip.lengthBeats, 0, 1);
    const points = normalizeClipGainEnvelope(clip.gainEnvelope);
    if (points.length >= CLIP_GAIN_ENVELOPE_MAX_POINTS) { showToast('Достигнут предел точек огибающей'); return; }
    if (position <= 0 || position >= 1 || points.some(point => Math.abs(point.position - position) < .001)) { showToast('Переместите курсор внутрь клипа, в свободную позицию'); return; }
    recordUndo(); points.push({ position, gain: sampleClipGainEnvelope(points, position) }); points.sort((a, b) => a.position - b.position);
    clip.gainEnvelope = points; renderAll();
  });
  $$('[data-clip-gain-position]').forEach(input => {
    input.addEventListener('focus', recordUndo, { once: true });
    input.addEventListener('change', () => {
      const index = Number(input.dataset.clipGainPosition), points = normalizeClipGainEnvelope(clip.gainEnvelope);
      if (index <= 0 || index >= points.length - 1) return;
      const minimum = points[index - 1].position + .001, maximum = points[index + 1].position - .001;
      points[index].position = clamp(Number(input.value) / clip.lengthBeats, minimum, maximum);
      clip.gainEnvelope = points; markProjectDirty(); renderAll(); restartPlaybackIfActive();
    });
  });
  $$('[data-clip-gain-value]').forEach(input => {
    const index = Number(input.dataset.clipGainValue), output = input.parentElement.querySelector('output');
    input.addEventListener('focus', recordUndo, { once: true });
    input.addEventListener('input', () => {
      const points = normalizeClipGainEnvelope(clip.gainEnvelope);
      points[index].gain = clamp(Number(input.value), 0, 1.5); clip.gainEnvelope = points;
      output.textContent = `${points[index].gain.toFixed(2)}×`; markProjectDirty();
      const element = $$('.clip').find(item => item.dataset.clip === clip.id);
      $('.clip-gain-envelope-curve path', element)?.setAttribute('d', clipGainEnvelopeSvgPath(clip));
    });
    input.addEventListener('change', restartPlaybackIfActive);
  });
  $$('[data-clip-gain-remove]').forEach(button => button.addEventListener('click', () => {
    const points = normalizeClipGainEnvelope(clip.gainEnvelope), index = Number(button.dataset.clipGainRemove);
    if (points.length <= 2 || index <= 0 || index >= points.length - 1) return;
    recordUndo(); points.splice(index, 1); clip.gainEnvelope = points; renderAll(); restartPlaybackIfActive();
  }));
}

function renderEditor() {
  const panel = $('#editorPanel'), title = $('#editorTitle'), eyebrow = $('#editorEyebrow'), body = $('#editorBody'), actions = $('#editorActions');
  $$('.view-tab').forEach(button => { const active = button.dataset.view === state.view; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
  panel.setAttribute('aria-labelledby', `tab-view-${state.view}`);
  const selected = getClip(state.selectedClipId);
  if (state.view === 'automation') {
    const track = selected.track || getTrack(state.selectedTrackId);
    const clip = selected.clip?.kind === 'automation' ? selected.clip : track?.clips.find(item => item.kind === 'automation');
    eyebrow.textContent = 'АВТОМАТИЗАЦИЯ'; title.textContent = clip ? 'Громкость дорожки' : 'Автоматизация громкости';
    if (!clip) {
      actions.innerHTML = '<button class="button quiet compact" id="createAutomationEditorBtn">＋ Клип громкости</button>';
      $('#createAutomationEditorBtn').onclick = createAutomationClip;
      body.innerHTML = '<div class="empty-editor"><div class="empty-editor-copy"><strong>Управляйте громкостью во времени</strong><p>Создайте клип, добавьте точки и задайте значения ползунками. Изменения работают при воспроизведении и экспорте.</p></div><button class="quick-chip" id="emptyAutomationBtn">Создать автоматизацию</button></div>';
      $('#emptyAutomationBtn').onclick = createAutomationClip; return;
    }
    actions.innerHTML = '<button class="button quiet compact" id="addAutomationPointBtn">＋ Точка в позиции курсора</button><button class="button quiet compact" id="deleteAutomationClipBtn">Удалить клип</button>';
    $('#addAutomationPointBtn').onclick = () => addAutomationPoint(clip);
    $('#deleteAutomationClipBtn').onclick = deleteSelectedClip;
    renderAutomationEditor(body, clip, track); return;
  }
  if (state.view === 'rack') {
    const track = selected.track || getTrack(state.selectedTrackId);
    if (track?.type === 'instrument') {
      eyebrow.textContent = 'ИНСТРУМЕНТ'; title.textContent = 'Параметры синтезатора';
      actions.innerHTML = '<button class="button quiet compact" id="createNotesBtn">＋ MIDI-партия</button>'; bindEditorActions();
      renderInstrumentEditor(body, track); return;
    }
    eyebrow.textContent = 'СЕКВЕНСОР'; title.textContent = 'Шаговый секвенсор'; actions.innerHTML = '<button class="button quiet compact" id="createPatternBtn">＋ Ритм-партия</button><button class="button quiet compact" id="createNotesBtn">＋ MIDI-партия</button>'; bindEditorActions();
    const clip = selected.clip?.kind === 'drums' ? selected.clip : track?.clips.find(item => item.kind === 'drums');
    if (!clip) { body.innerHTML = '<div class="empty-editor"><div class="empty-editor-copy"><strong>Соберите ритм по шагам</strong><p>Каждая ячейка — шестнадцатая доля. Готовый ритм можно услышать и изменить на шкале.</p></div><button class="quick-chip" id="emptyPatternBtn">Создать ритм-партию</button></div>'; $('#emptyPatternBtn')?.addEventListener('click', createDrumPattern); return; }
    body.innerHTML = '<div class="step-grid" id="stepGrid"></div>'; const grid = $('#stepGrid');
    for (const row of clip.steps) {
      row.velocity = clamp(Number(row.velocity ?? .78), 0, 1);
      const label = document.createElement('label'); label.className = 'step-label';
      label.innerHTML = '<i></i><span></span><input type="range" min="0" max="1" step="0.01" /><output></output>';
      const rowColor = /^#[\da-f]{6}$/i.test(row.color || '') ? row.color : themePalette()[0];
      $('i', label).style.backgroundColor = rowColor; $('span', label).textContent = row.name;
      const velocity = $('input', label), output = $('output', label);
      velocity.value = row.velocity; velocity.setAttribute('aria-label', `Сила удара: ${row.name}`); output.textContent = `${Math.round(row.velocity * 100)}%`;
      velocity.addEventListener('focus', recordUndo);
      velocity.addEventListener('input', () => { row.velocity = Number(velocity.value); output.textContent = `${Math.round(row.velocity * 100)}%`; markProjectDirty(); });
      velocity.addEventListener('change', () => { if (nativePlaybackActive) restartPlaybackIfActive(); });
      grid.append(label);
      for (let step = 0; step < 16; step++) {
        const active = row.hits.includes(step), cell = document.createElement('button'); cell.className = `step-cell ${active ? 'active' : ''}`;
        cell.setAttribute('aria-label', `${row.name}, шаг ${step + 1}`); cell.setAttribute('aria-pressed', String(active));
        cell.addEventListener('click', () => { const adding = !row.hits.includes(step); if (adding && !canAddEvents(1)) return; recordUndo(); row.hits = adding ? [...row.hits, step].sort((a, b) => a - b) : row.hits.filter(hit => hit !== step); const enabled = row.hits.includes(step); cell.classList.toggle('active', enabled); cell.setAttribute('aria-pressed', String(enabled)); renderTimeline(); });
        grid.append(cell);
      }
    }
    return;
  }
  if (state.view === 'piano') {
    eyebrow.textContent = 'MIDI-РЕДАКТОР'; title.textContent = 'Пиано-ролл'; actions.innerHTML = '<button class="button quiet compact" id="createNotesBtn">＋ MIDI-партия</button>'; bindEditorActions();
    let midi = selected.clip?.kind === 'midi' ? selected.clip : selected.track?.clips.find(item => item.kind === 'midi');
  if (!midi) { body.innerHTML = '<div class="empty-editor"><div class="empty-editor-copy"><strong>Напишите короткую фразу</strong><p>Клик по сетке добавляет ноту. Выберите инструмент во вкладке «Инструменты».</p></div><button class="quick-chip" id="emptyNotesBtn">Создать MIDI-партию</button></div>'; $('#emptyNotesBtn')?.addEventListener('click', createMidiPattern); return; }
    renderPianoRoll(body, midi, selected.track || getTrack(state.selectedTrackId)); return;
  }
  if (selected.clip && !selected.clip.kind) {
    eyebrow.textContent = 'СВОЙСТВА КЛИПА'; title.textContent = selected.clip.name; actions.innerHTML = `${selected.clip.renderedAssetId ? `<button class="button quiet compact" id="toggleClipProcessingBtn">${selected.clip.bypassProcessing ? 'Слушать обработку' : 'Слушать оригинал'}</button>` : ''}<button class="button quiet compact" id="resetPitchBtn">Сбросить тон</button><button class="button quiet compact" id="deleteClipBtn">Удалить клип</button>`;
    const clip = selected.clip, asset = state.assets.get(clip.assetId), activeAsset = state.assets.get(clip.renderedAssetId && !clip.bypassProcessing ? clip.renderedAssetId : clip.assetId) || asset;
    const canSliceTransients = !clip.renderedAssetId && !clip.timeStretchRatio && !clip.clapPluginName && !clip.autoTune && !clip.bypassProcessing;
    body.innerHTML = `<div class="properties">
      <div class="property"><label>ВЫСОТА · ПОЛУТОНЫ</label><input id="clipPitch" type="number" min="-24" max="24" value="${clip.pitch || 0}" /></div>
      <div class="property"><label>СКОРОСТЬ · ${Math.round((clip.rate || 1) * 100)}%</label><input id="clipRate" type="range" min="0.5" max="2" step="0.01" value="${clip.rate || 1}" /></div>
      <div class="property"><label>ТЕМП ИСТОЧНИКА · BPM</label><input id="clipSourceTempo" type="number" min="40" max="240" step="1" value="${clip.timeStretchSourceTempo || Math.round(state.tempo)}" /><small class="field-help">Растянуть к темпу проекта (${Math.round(state.tempo)} BPM), сохранив высоту.</small><button class="button quiet compact" id="applyTimeStretchBtn">Подогнать к темпу проекта</button></div>
      <div class="property"><label>ОБРАБОТКА</label><button class="button quiet compact" id="applyPitchBtn">Применить высоту</button></div>
      <div class="property clap-property"><label>CLAP · СТЕРЕОЭФФЕКТ</label><button class="button quiet compact" id="selectClapBtn">Выбрать CLAP-плагин…</button><small class="field-help">Параметры можно изменить перед offline-рендером. Оригинал сохранится для A/B.</small><div id="clapControls"></div><button class="button compact" id="applyClapBtn" disabled>Выберите плагин</button></div>
      <div class="property"><label>ТОНАЛЬНОСТЬ AUTOTUNE</label><input readonly value="${escapeHtml(clip.autoTune?.key || state.key)}" /></div>
      <div class="property"><label>СИЛА КОРРЕКЦИИ</label><input id="autotuneStrength" type="range" min="0" max="100" step="1" value="${Math.round((clip.autoTune?.strength ?? .9) * 100)}" /></div>
      <div class="property"><label>СКОРОСТЬ КОРРЕКЦИИ</label><input id="autotuneSpeed" type="range" min="0" max="100" step="1" value="${Math.round((clip.autoTune?.speed ?? .75) * 100)}" /></div>
      <div class="property"><label>АВТОТЮН · МОНОФОНИЯ</label><button class="button quiet compact" id="applyAutotuneBtn">Исправить по тональности</button></div>
      <div class="property"><label>ГРОМКОСТЬ</label><input id="clipVolume" type="range" min="0" max="1.5" step="0.01" value="${clip.volume ?? 1}" /></div>
      <div class="property"><label>ПАНОРАМА</label><input id="clipPan" type="range" min="-1" max="1" step="0.01" value="${clip.pan || 0}" /></div>
      ${renderClipGainEnvelopeControls(clip)}
      <div class="property"><label>FADE-IN · СЕК</label><input id="clipFadeIn" type="number" min="0" max="30" step="0.01" value="${Number(clip.fadeInSec || 0).toFixed(2)}" /></div>
      <div class="property"><label>FADE-OUT · СЕК</label><input id="clipFadeOut" type="number" min="0" max="30" step="0.01" value="${Number(clip.fadeOutSec || 0).toFixed(2)}" /></div>
      <div class="property">
        <label for="sliceTransientSensitivity">НАРЕЗКА ПО ТРАНЗИЕНТАМ</label>
        <label>Чувствительность <output id="sliceSensitivityValue">55%</output></label><input id="sliceTransientSensitivity" type="range" min="5" max="95" step="1" value="55" aria-label="Чувствительность поиска транзиентов" />
        <label>Минимальный интервал <output id="sliceGapValue">90 мс</output></label><input id="sliceTransientGap" type="range" min="50" max="250" step="10" value="90" aria-label="Минимальный интервал между транзиентами" />
        <button class="button quiet compact" id="sliceTransientsBtn" type="button" ${canSliceTransients?'':'disabled'}>Нарезать по транзиентам</button>
        <small class="field-help">${canSliceTransients?'Локальный анализ. Действие можно отменить.':'Сначала сбросьте обработку клипа.'}</small><p id="sliceTransientStatus" class="field-help" role="status" aria-live="polite"></p>
      </div>
      <div class="property"><label>ОБРЕЗКА НАЧАЛА · СЕК</label><input id="clipOffset" type="number" min="0" max="${asset?.buffer.duration || 0}" step="0.01" value="${(clip.offsetSec || 0).toFixed(2)}" /></div>
      <div class="property"><label>ИСТОЧНИК</label><input readonly value="${escapeHtml(asset?.fileName || clip.name)}" /></div>
      <div class="note-banner">Pitch shift сохраняет длительность. Автотюн настраивает монофонический голос по тональности проекта; аккорды и многоголосие не корректируются.</div>
    </div>`;
    $('#clipPitch').addEventListener('change', event => { event.target.value = clamp(Number(event.target.value) || 0, -24, 24); });
    $('#applyPitchBtn').onclick = () => applyClipPitch(clip, Number($('#clipPitch').value) || 0);
    $('#applyTimeStretchBtn').onclick = () => applyClipTimeStretch(clip, Number($('#clipSourceTempo').value));
    $('#clipSourceTempo').addEventListener('focus', recordUndo, { once: true });
    $('#selectClapBtn').onclick = () => inspectClipClap(clip);
    $('#applyClapBtn').onclick = () => applyClipClap(clip);
    $('#applyAutotuneBtn').onclick = () => applyClipAutotune(clip, { enabled: true, key: state.key, strength: Number($('#autotuneStrength').value) / 100, speed: Number($('#autotuneSpeed').value) / 100 });
    $('#toggleClipProcessingBtn')?.addEventListener('click', () => { recordUndo(); clip.bypassProcessing = !clip.bypassProcessing; restartPlaybackIfActive(); renderAll(); });
    $('#clipVolume').addEventListener('input', event => { clip.volume = Number(event.target.value); markProjectDirty(); if (clip.gainEnvelope || clip.fadeInSec || clip.fadeOutSec) restartPlaybackIfActive(); else { const gain = liveClipGains.get(clip.id); if (gain) gain.gain.setTargetAtTime(clip.volume, getAudioContext().currentTime, .015); if (nativePlaybackActive) restartPlaybackIfActive(); } });
    $('#clipPan').addEventListener('input', event => { clip.pan = Number(event.target.value); markProjectDirty(); const pan = liveClipPans.get(clip.id); if (pan) pan.pan.setTargetAtTime(clip.pan, getAudioContext().currentTime, .015); if (nativePlaybackActive) restartPlaybackIfActive(); });
    bindClipGainEnvelopeEditor(clip);
    const updateClipFades = () => {
      const durationSec = clip.lengthBeats * 60 / state.tempo;
      const fades = normalizeClipFades(durationSec, Number($('#clipFadeIn').value), Number($('#clipFadeOut').value));
      clip.fadeInSec = fades.fadeInSec; clip.fadeOutSec = fades.fadeOutSec; markProjectDirty();
      $('#clipFadeIn').value = fades.fadeInSec.toFixed(2); $('#clipFadeOut').value = fades.fadeOutSec.toFixed(2);
      renderTimeline(); restartPlaybackIfActive();
    };
    $('#clipFadeIn').addEventListener('change', updateClipFades); $('#clipFadeOut').addEventListener('change', updateClipFades);
    $('#clipRate').addEventListener('input', event => {
      clip.rate = Number(event.target.value); markProjectDirty();
      const usesRendered = Boolean(clip.renderedAssetId && !clip.bypassProcessing);
      const duration = Math.max(.02, activeAsset.buffer.duration - getClipSourceOffsetSec(clip) - getClipSourceTrimEndSec(clip));
      clip.lengthBeats = Math.max(.25, duration / getClipPlaybackRate(clip, usesRendered) * state.tempo / 60);
      const source = liveClipSources.get(clip.id); if (source) source.playbackRate.setTargetAtTime(getClipPlaybackRate(clip, usesRendered), getAudioContext().currentTime, .015);
      event.target.closest('.property').querySelector('label').textContent = `СКОРОСТЬ · ${Math.round(clip.rate * 100)}%`;
      renderTimeline();
    });
    $('#clipOffset').addEventListener('change', event => { clip.offsetSec = clamp(Number(event.target.value) || 0, 0, activeAsset.buffer.duration - .05); renderAll(); });
    for (const field of ['clipVolume', 'clipPan', 'clipOffset', 'clipRate', 'clipFadeIn', 'clipFadeOut']) $(`#${field}`).addEventListener('focus', recordUndo, { once: true });
    $('#resetPitchBtn').textContent = 'Сбросить обработку';
    $('#resetPitchBtn').onclick = () => { recordUndo(); clip.pitch = 0; clip.autoTune = null; clip.renderedAssetId = null; if (clip.timeStretchRatio) { clip.lengthBeats = clip.stretchOriginalLengthBeats ?? clip.lengthBeats; clip.offsetSec = clip.stretchOriginalOffsetSec ?? clip.offsetSec; clip.trimEndSec = clip.stretchOriginalTrimEndSec ?? clip.trimEndSec; } if (clip.clapPluginName) { clip.lengthBeats = clip.clapOriginalLengthBeats ?? clip.lengthBeats; clip.offsetSec = clip.clapOriginalOffsetSec ?? clip.offsetSec; clip.trimEndSec = clip.clapOriginalTrimEndSec ?? clip.trimEndSec; } clip.timeStretchRatio = null; clip.timeStretchSourceTempo = null; clip.stretchOriginalLengthBeats = null; clip.stretchOriginalOffsetSec = null; clip.stretchOriginalTrimEndSec = null; clip.clapPluginName = null; clip.clapPluginId = null; clip.clapParameters = null; clip.clapSourceAssetId = null; clip.clapSourceOffsetSec = null; clip.clapSourceTrimEndSec = null; clip.clapOriginalLengthBeats = null; clip.clapOriginalOffsetSec = null; clip.clapOriginalTrimEndSec = null; clapSelections.delete(clip.id); clip.bypassProcessing = false; restartPlaybackIfActive(); renderAll(); };
    $('#deleteClipBtn').onclick = deleteSelectedClip;
    $('#sliceTransientSensitivity').oninput = event => { $('#sliceSensitivityValue').textContent = event.target.value + '%'; };
    $('#sliceTransientGap').oninput = event => { $('#sliceGapValue').textContent = event.target.value + ' мс'; };
    $('#sliceTransientsBtn').onclick = () => sliceAudioAtTransients(clip, Number($('#sliceTransientSensitivity').value) / 100, Number($('#sliceTransientGap').value));
    renderClapControls(clip);
    return;
  }
  eyebrow.textContent = 'СЕССИЯ'; title.textContent = 'Соберите идею по слоям'; actions.innerHTML = '<button class="button quiet compact" id="createPatternBtn">＋ Ритм-партия</button><button class="button quiet compact" id="createNotesBtn">＋ MIDI-партия</button><button class="button quiet compact" id="createAutomationEmptyBtn">＋ Громкость</button>'; bindEditorActions();
  body.innerHTML = '<div class="empty-editor"><div class="empty-editor-copy"><strong>Библиотека и шкала уже готовы</strong><p>Перетащите сэмпл на дорожку, нажмите запись или начните с простого ритма.</p></div><div class="quick-start"><button class="quick-chip" id="quickDrums">Создать ритм</button><button class="quick-chip" id="quickNotes">Добавить ноты</button><button class="quick-chip" id="quickImport">Импортировать аудио</button></div></div>';
  $('#quickDrums')?.addEventListener('click', createDrumPattern); $('#quickNotes')?.addEventListener('click', createMidiPattern); $('#quickImport')?.addEventListener('click', () => $('#audioFiles').click());
}

function renderInspector() {
  const host = $('#inspectorContent');
  if (!host) return;
  const track = getTrack(state.selectedTrackId);
  if (!track) {
    host.innerHTML = '<div class="inspector-empty"><strong>Нет выбранной дорожки</strong><p>Выберите дорожку в аранжировке, чтобы изменить её параметры.</p></div>';
    return;
  }

  const typeLabel = track.type === 'audio' ? 'Аудио' : track.type === 'drums' ? 'Шаговый секвенсор' : 'Встроенный инструмент';
  const selected = getClip(state.selectedClipId);
  const clip = selected.track?.id === track.id ? selected.clip : null;
  const eqSettings = track.eqSettings = normalizeEqSettings(track.eqSettings);
  const compressorSettings = normalizeCompressorSettings(track.compressorSettings);
  const limiterSettings = normalizeLimiterSettings(track.limiterSettings);
  const synthSettings = track.type === 'instrument' ? (track.synthSettings = normalizeSynthSettings(track.synthSettings, track.instrument)) : null;
  const instrumentOptions = track.type === 'instrument' ? INSTRUMENTS.map(item => `<option value="${item.id}"${item.id === track.instrument ? ' selected' : ''}>${escapeHtml(item.name)}</option>`).join('') : '';
  const panText = value => Math.abs(value) < 0.005 ? 'Центр' : `${Math.round(Math.abs(value) * 100)}% ${value < 0 ? 'L' : 'R'}`;
  host.innerHTML = `<section class="inspector-card" aria-labelledby="inspectorTrackSectionTitle">
      <div class="inspector-card-heading"><div><span class="eyebrow">ДОРОЖКА</span><h3 id="inspectorTrackSectionTitle">Канал</h3></div><span class="inspector-type"></span></div>
      <label class="inspector-field" for="inspectorTrackName"><span>Название</span><input id="inspectorTrackName" type="text" maxlength="80" autocomplete="off" /></label>
      <fieldset class="inspector-colors"><legend>Цвет дорожки</legend><div class="inspector-color-options"></div></fieldset>
      <label class="inspector-field inspector-range" for="inspectorTrackVolume"><span>Громкость <output id="inspectorVolumeValue"></output></span><input id="inspectorTrackVolume" type="range" min="0" max="1.2" step="0.01" /></label>
      <label class="inspector-field inspector-range" for="inspectorTrackPan"><span>Панорама <output id="inspectorPanValue"></output></span><input id="inspectorTrackPan" type="range" min="-1" max="1" step="0.01" /></label>
      <div class="inspector-button-row"><button type="button" class="inspector-mode" data-inspector-mode="mute">Заглушить</button><button type="button" class="inspector-mode" data-inspector-mode="solo">Соло</button></div>
      <div class="inspector-subheading"><span class="eyebrow">ОБРАБОТКА ДОРОЖКИ</span></div>
      <div class="inspector-button-row"><button type="button" class="inspector-effect" data-inspector-effect="reverb">Реверберация</button><button type="button" class="inspector-effect" data-inspector-effect="delay">Задержка</button></div>
      <div class="inspector-button-row"><button type="button" class="inspector-effect" data-inspector-effect="equalizer">Параметрический EQ</button><button type="button" class="inspector-effect" data-inspector-effect="compressor">Компрессор</button><button type="button" class="inspector-effect" data-inspector-effect="limiter">Лимитер</button></div>
      ${track.effects?.equalizer ? `<div class="inspector-eq-controls">
        <p class="field-help">Семиполосный стерео EQ. Меняйте частоту и усиление каждой полосы; настройки сохраняются в проекте.</p>
        <div class="inspector-eq-bands" role="group" aria-label="Семь полос эквалайзера">
          ${eqSettings.bands.map((band, index) => `<div class="inspector-eq-band" role="group" aria-label="Полоса ${index + 1}">
            <label class="inspector-eq-frequency"><span data-eq-band-label>${String(index + 1).padStart(2, '0')} · ${band.frequencyHz} Гц</span><input data-eq="frequencyHz" data-eq-band="${index}" type="number" min="20" max="20000" step="1" value="${band.frequencyHz}" aria-label="Частота полосы ${index + 1} в герцах" /></label>
            <label class="inspector-eq-gain"><span class="sr-only">Усиление полосы ${index + 1}</span><input data-eq="gainDb" data-eq-band="${index}" type="range" min="-24" max="24" step="0.1" value="${band.gainDb}" aria-label="Усиление полосы ${index + 1} в децибелах" /><output aria-live="polite">${band.gainDb.toFixed(1)} dB</output></label>
          </div>`).join('')}
        </div>
        <label class="inspector-field inspector-range" for="inspectorEqQ"><span>Добротность всех полос <output id="inspectorEqQValue">${eqSettings.q.toFixed(1)}</output></span><input id="inspectorEqQ" data-eq="q" type="range" min="0.1" max="18" step="0.1" value="${eqSettings.q}" aria-label="Добротность всех полос параметрического EQ" /></label>
      </div>` : ''}
${track.effects?.compressor ? `<div class="inspector-eq-controls inspector-compressor-controls">
        <p class="field-help">Мягкая стереокомпрессия действует на воспроизведение, WASAPI и экспорт WAV.</p>
        <label class="inspector-field inspector-range" for="compressorThreshold"><span>Порог <output>${compressorSettings.thresholdDb.toFixed(1)} dB</output></span><input id="compressorThreshold" data-compressor="thresholdDb" type="range" min="-60" max="0" step="0.5" value="${compressorSettings.thresholdDb}" aria-label="Порог компрессора в децибелах" /></label>
        <label class="inspector-field inspector-range" for="compressorRatio"><span>Соотношение <output>${compressorSettings.ratio.toFixed(1)}:1</output></span><input id="compressorRatio" data-compressor="ratio" type="range" min="1" max="20" step="0.1" value="${compressorSettings.ratio}" aria-label="Соотношение компрессии" /></label>
        <label class="inspector-field inspector-range" for="compressorAttack"><span>Атака <output>${compressorSettings.attackMs.toFixed(1)} ms</output></span><input id="compressorAttack" data-compressor="attackMs" type="range" min="0.1" max="100" step="0.1" value="${compressorSettings.attackMs}" aria-label="Время атаки компрессора" /></label>
        <label class="inspector-field inspector-range" for="compressorRelease"><span>Восстановление <output>${compressorSettings.releaseMs.toFixed(0)} ms</output></span><input id="compressorRelease" data-compressor="releaseMs" type="range" min="10" max="1000" step="1" value="${compressorSettings.releaseMs}" aria-label="Время восстановления компрессора" /></label>
        <label class="inspector-field inspector-range" for="compressorMakeup"><span>Компенсация <output>${compressorSettings.makeupDb.toFixed(1)} dB</output></span><input id="compressorMakeup" data-compressor="makeupDb" type="range" min="0" max="24" step="0.1" value="${compressorSettings.makeupDb}" aria-label="Компенсация уровня после компрессии" /></label>
      </div>` : ''}
      ${track.effects?.limiter ? `<div class="inspector-eq-controls inspector-limiter-controls">
        <p class="field-help">Ограничивает пики дорожки в браузере, WASAPI и при экспорте WAV.</p>
        <label class="inspector-field inspector-range" for="limiterCeiling"><span>Потолок <output>${limiterSettings.ceilingDb.toFixed(1)} dB</output></span><input id="limiterCeiling" data-limiter="ceilingDb" type="range" min="-24" max="0" step="0.1" value="${limiterSettings.ceilingDb}" aria-label="Потолок лимитера в децибелах" /></label>
        <label class="inspector-field inspector-range" for="limiterRelease"><span>Восстановление <output>${limiterSettings.releaseMs.toFixed(0)} ms</output></span><input id="limiterRelease" data-limiter="releaseMs" type="range" min="10" max="500" step="1" value="${limiterSettings.releaseMs}" aria-label="Время восстановления лимитера" /></label>
      </div>` : ''}
      <button type="button" class="button quiet compact inspector-open-editor" id="inspectorOpenEditorBtn">Открыть редактор</button>
    </section>
    ${track.type === 'instrument' ? `<section class="inspector-card inspector-synth" aria-labelledby="inspectorSynthTitle">
      <div class="inspector-card-heading"><div><span class="eyebrow">ИНСТРУМЕНТ</span><h3 id="inspectorSynthTitle">Встроенный синтезатор</h3></div></div>
      <label class="inspector-field" for="inspectorSynthInstrument"><span>Инструмент</span><select class="inspector-select" id="inspectorSynthInstrument">${instrumentOptions}</select></label>
      <label class="inspector-field" for="inspectorSynthWaveform"><span>Форма волны</span><select class="inspector-select" id="inspectorSynthWaveform" data-synth="waveform"><option value="preset">Фирменная</option><option value="sine">Синус</option><option value="triangle">Треугольник</option><option value="sawtooth">Пила</option><option value="square">Прямоугольник</option></select></label>
      <label class="inspector-field inspector-range" for="inspectorSynthCutoff"><span>Срез фильтра <output data-output="cutoffHz"></output></span><input id="inspectorSynthCutoff" data-synth="cutoffHz" type="range" min="200" max="20000" step="10" aria-label="Частота среза встроенного фильтра" /></label>
      <label class="inspector-field inspector-range" for="inspectorSynthAttack"><span>Атака <output data-output="attackMs"></output></span><input id="inspectorSynthAttack" data-synth="attackMs" type="range" min="1" max="1000" step="1" aria-label="Атака встроенного синтезатора" /></label>
      <label class="inspector-field inspector-range" for="inspectorSynthRelease"><span>Затухание <output data-output="releaseMs"></output></span><input id="inspectorSynthRelease" data-synth="releaseMs" type="range" min="10" max="1200" step="1" aria-label="Затухание встроенного синтезатора" /></label>
      <label class="inspector-field inspector-range" for="inspectorSynthDetune"><span>Расстройка <output data-output="detuneCents"></output></span><input id="inspectorSynthDetune" data-synth="detuneCents" type="range" min="-100" max="100" step="1" aria-label="Расстройка в центах" /></label>
      <button type="button" class="button quiet compact inspector-open-editor" id="inspectorPreviewSynthBtn">▶ Прослушать ноту</button>
      <p class="field-help">Эти параметры влияют на ноты, WASAPI-воспроизведение и экспорт WAV.</p>
    </section>` : ''}
    ${clip ? '<section class="inspector-card inspector-clip" aria-labelledby="inspectorClipSectionTitle"><span class="eyebrow">ВЫБРАННЫЙ КЛИП</span><h3 id="inspectorClipSectionTitle"></h3><dl><div><dt>Тип</dt><dd id="inspectorClipType"></dd></div><div><dt>Начало</dt><dd id="inspectorClipStart"></dd></div><div><dt>Длительность</dt><dd id="inspectorClipLength"></dd></div></dl></section>' : '<div class="inspector-hint">Выберите клип на шкале, чтобы увидеть его позицию и длительность.</div>'}`;

  $('.inspector-type', host).textContent = typeLabel;
  const nameInput = $('#inspectorTrackName', host);
  nameInput.value = track.name;
  nameInput.addEventListener('change', event => {
    const nextName = normalizeTrackName(event.target.value, track.name);
    event.target.value = nextName;
    if (nextName === track.name) return;
    recordUndo({ audioGraph: false }); track.name = nextName;
    renderTimeline(); renderMixer();
  });
  nameInput.addEventListener('keydown', event => { if (event.key === 'Enter') event.currentTarget.blur(); });

  const colorOptions = $('.inspector-color-options', host);
  const selectedColor = /^#[\da-f]{6}$/i.test(track.color || '') ? track.color.toLowerCase() : themePalette()[0];
  for (const color of themePalette()) {
    const swatch = document.createElement('button');
    swatch.type = 'button'; swatch.className = 'inspector-color-swatch'; swatch.style.backgroundColor = color;
    swatch.setAttribute('aria-label', `Выбрать цвет ${color}`); swatch.setAttribute('aria-pressed', String(color.toLowerCase() === selectedColor));
    if (color.toLowerCase() === selectedColor) swatch.classList.add('selected');
    swatch.addEventListener('click', () => {
      if (color.toLowerCase() === selectedColor) return;
      recordUndo({ audioGraph: false }); track.color = color;
      for (const item of track.clips) item.color = color;
      renderAll(); $(`.inspector-color-swatch[aria-label="Выбрать цвет ${color}"]`, $('#inspectorContent'))?.focus();
    });
    colorOptions.append(swatch);
  }

  const volume = $('#inspectorTrackVolume', host), volumeValue = $('#inspectorVolumeValue', host);
  volume.value = String(clamp(Number(track.volume) || 0, 0, 1.2));
  volumeValue.textContent = `${Math.round(Number(volume.value) * 100)}%`;
  volume.addEventListener('focus', recordUndo, { once: true });
  volume.addEventListener('input', event => {
    track.volume = Number(event.target.value); volumeValue.textContent = `${Math.round(track.volume * 100)}%`; markProjectDirty();
    const gain = liveTrackGains.get(track.id); if (gain) gain.gain.setTargetAtTime(track.volume, getAudioContext().currentTime, .015);
  });
  volume.addEventListener('change', () => { renderMixer(); restartProjectPlaybackIfActive(); });

  const pan = $('#inspectorTrackPan', host), panValue = $('#inspectorPanValue', host);
  pan.value = String(clamp(Number(track.pan) || 0, -1, 1)); panValue.textContent = panText(Number(pan.value));
  pan.addEventListener('focus', recordUndo, { once: true });
  pan.addEventListener('input', event => {
    track.pan = Number(event.target.value); panValue.textContent = panText(track.pan); markProjectDirty();
    const panner = liveTrackPans.get(track.id); if (panner) panner.pan.setTargetAtTime(track.pan, getAudioContext().currentTime, .015);
  });
  pan.addEventListener('change', () => { renderMixer(); restartProjectPlaybackIfActive(); });

  for (const mode of ['mute', 'solo']) {
    const button = $(`[data-inspector-mode="${mode}"]`, host);
    button.classList.toggle('active', Boolean(track[mode])); button.setAttribute('aria-pressed', String(Boolean(track[mode])));
    button.addEventListener('click', () => {
      recordUndo(); track[mode] = !track[mode]; renderAll(); updateLiveTrackMix(); restartProjectPlaybackIfActive();
      $(`[data-inspector-mode="${mode}"]`, $('#inspectorContent'))?.focus();
    });
  }
  for (const effect of ['reverb', 'delay', 'equalizer', 'compressor', 'limiter']) {
    const button = $(`[data-inspector-effect="${effect}"]`, host);
    button.classList.toggle('active', Boolean(track.effects?.[effect])); button.setAttribute('aria-pressed', String(Boolean(track.effects?.[effect])));
    button.addEventListener('click', () => { toggleTrackEffect(track.id, effect); $(`[data-inspector-effect="${effect}"]`, $('#inspectorContent'))?.focus(); });
  }

  if (track.effects?.compressor) {
    for (const control of $$('[data-compressor]', host)) {
      const key = control.dataset.compressor, output = control.parentElement.querySelector('output');
      const format = value => key === 'thresholdDb' || key === 'makeupDb' ? `${Number(value).toFixed(1)} dB` :
        key === 'ratio' ? `${Number(value).toFixed(1)}:1` : `${Number(value).toFixed(key === 'releaseMs' ? 0 : 1)} ms`;
      output.textContent = format(compressorSettings[key]);
      control.addEventListener('focus', recordUndo, { once: true });
      control.addEventListener('input', event => {
        track.compressorSettings = normalizeCompressorSettings({ ...(track.compressorSettings || compressorSettings), [key]: Number(event.target.value) });
        output.textContent = format(track.compressorSettings[key]); markProjectDirty();
        const nodes = liveTrackCompressors.get(track.id);
        if (nodes) applyCompressorSettings(nodes, track.compressorSettings);
      });
      control.addEventListener('change', restartProjectPlaybackIfActive);
    }
  }

  if (track.effects?.limiter) {
    for (const control of $$('[data-limiter]', host)) {
      const key = control.dataset.limiter, output = control.parentElement.querySelector('output');
      const format = value => key === 'ceilingDb' ? `${Number(value).toFixed(1)} dB` : `${Number(value).toFixed(0)} ms`;
      output.textContent = format(limiterSettings[key]);
      control.addEventListener('focus', recordUndo, { once: true });
      control.addEventListener('input', event => {
        track.limiterSettings = normalizeLimiterSettings({ ...(track.limiterSettings || limiterSettings), [key]: Number(event.target.value) });
        output.textContent = format(track.limiterSettings[key]); markProjectDirty();
        const nodes = liveTrackLimiters.get(track.id);
        if (nodes) applyLimiterSettings(nodes, track.limiterSettings);
      });
      control.addEventListener('change', restartProjectPlaybackIfActive);
    }
  }

  if (track.effects?.equalizer) {
    for (const control of $$('[data-eq]', host)) {
      const key = control.dataset.eq;
      const bandIndex = control.dataset.eqBand === undefined ? null : Number(control.dataset.eqBand);
      const output = control.parentElement.querySelector('output') || $('#inspectorEqQValue', host);
      const valueForControl = () => bandIndex === null ? track.eqSettings.q : track.eqSettings.bands[bandIndex][key];
      const formatValue = value => key === 'frequencyHz' ? `${Math.round(value)} Hz` : key === 'gainDb' ? `${value.toFixed(1)} dB` : value.toFixed(1);
      const updateValue = () => {
        control.value = String(valueForControl());
        if (output) output.textContent = formatValue(valueForControl());
        if (bandIndex !== null) { const label = control.closest('.inspector-eq-band')?.querySelector('[data-eq-band-label]'); if (label) label.textContent = `${String(bandIndex + 1).padStart(2, '0')} · ${Math.round(track.eqSettings.bands[bandIndex].frequencyHz)} Гц`; }
      };
      updateValue(); control.addEventListener('focus', recordUndo, { once: true });
      const updateBand = event => {
        const nextValue = Number(event.target.value);
        const nextBands = track.eqSettings.bands.map((band, index) =>
          bandIndex === null || bandIndex === index ? { ...band, [key]: nextValue } : band);
        track.eqSettings = normalizeEqSettings({ ...track.eqSettings, bands: nextBands });
        updateValue(); markProjectDirty();
        const filters = liveTrackEqualizers.get(track.id);
        if (!filters) return;
        const now = getAudioContext().currentTime;
        const apply = (filter, band) => {
          if (!filter || !band) return;
          if (key === 'frequencyHz') filter.frequency.setTargetAtTime(band.frequencyHz, now, .02);
          if (key === 'gainDb') filter.gain.setTargetAtTime(band.gainDb, now, .02);
          if (key === 'q') filter.Q.setTargetAtTime(band.q, now, .02);
        };
        if (bandIndex === null) track.eqSettings.bands.forEach((band, index) => apply(filters?.[index], band));
        else apply(filters?.[bandIndex], track.eqSettings.bands[bandIndex]);
      };
      control.addEventListener(control.type === 'number' ? 'change' : 'input', updateBand);
      control.addEventListener('change', () => { restartProjectPlaybackIfActive(); });
    }
  }
  if (track.type === 'instrument') {
    const instrument = $('#inspectorSynthInstrument', host), waveform = $('#inspectorSynthWaveform', host);
    instrument.addEventListener('change', event => {
      recordUndo(); track.instrument = event.target.value;
      track.synthSettings = normalizeSynthSettings(track.synthSettings, track.instrument);
      markProjectDirty(); restartProjectPlaybackIfActive(); renderAll(); $('#inspectorSynthInstrument')?.focus();
    });
    waveform.value = synthSettings.waveform;
    for (const input of $$('[data-synth]:not([data-synth="waveform"])', host)) {
      const key = input.dataset.synth; input.value = String(synthSettings[key]); updateSynthOutput(host, key, synthSettings[key]);
    }
    for (const control of $$('[data-synth]', host)) {
      control.addEventListener('focus', recordUndo, { once: true });
      control.addEventListener('input', () => {
        const key = control.dataset.synth, value = key === 'waveform' ? control.value : Number(control.value);
        track.synthSettings = normalizeSynthSettings({ ...track.synthSettings, [key]: value }, track.instrument);
        if (key !== 'waveform') updateSynthOutput(host, key, track.synthSettings[key]);
        markProjectDirty();
      });
      control.addEventListener('change', restartProjectPlaybackIfActive);
    }
    $('#inspectorPreviewSynthBtn', host).addEventListener('click', () => previewNote(track.instrument, 60, track.synthSettings));
  }

  const openEditor = $('#inspectorOpenEditorBtn', host);
  openEditor.textContent = track.type === 'instrument' ? 'Открыть инструмент' : track.type === 'drums' ? 'Открыть секвенсор' : 'Открыть свойства клипа';
  openEditor.addEventListener('click', () => {
    state.view = clip?.kind === 'midi' ? 'piano' : track.type === 'instrument' || track.type === 'drums' ? 'rack' : 'arrangement';
    renderEditor(); $('#editorPanel').focus({ preventScroll: true });
  });

  if (clip) {
    const kind = clip.kind === 'midi' ? 'MIDI' : clip.kind === 'drums' ? 'Ритм' : 'Аудио';
    $('#inspectorClipSectionTitle', host).textContent = clip.name;
    $('#inspectorClipType', host).textContent = kind;
    $('#inspectorClipStart', host).textContent = `Такт ${Math.floor(clip.startBeat / 4) + 1}, доля ${(clip.startBeat % 4).toFixed(2)}`;
    $('#inspectorClipLength', host).textContent = `${clip.lengthBeats.toFixed(2)} доли`;
  }
}

function renderInstrumentEditor(body, track) {
  const settings = track.synthSettings = normalizeSynthSettings(track.synthSettings, track.instrument);
  const options = INSTRUMENTS.map(item => `<option value="${item.id}"${item.id === track.instrument ? ' selected' : ''}>${escapeHtml(item.name)}</option>`).join('');
  body.innerHTML = `<section class="synth-editor" aria-label="Настройки встроенного синтезатора">
    <div class="synth-header"><div><strong></strong><small>Встроенный осциллятор · локальная обработка</small></div><button class="button quiet compact" id="previewSynthBtn">▶ Прослушать ноту</button></div>
    <div class="synth-controls">
      <label class="synth-control"><span>ИНСТРУМЕНТ</span><select id="synthInstrument" aria-label="Инструмент">${options}</select></label>
      <label class="synth-control"><span>ФОРМА ВОЛНЫ</span><select data-synth="waveform" aria-label="Форма волны"><option value="preset">Фирменная</option><option value="sine">Синус</option><option value="triangle">Треугольник</option><option value="sawtooth">Пила</option><option value="square">Прямоугольник</option></select></label>
      <label class="synth-control"><span>ФИЛЬТР · СРЕЗ <output data-output="cutoffHz"></output></span><input data-synth="cutoffHz" type="range" min="200" max="20000" step="10" aria-label="Частота среза фильтра" /></label>
      <label class="synth-control"><span>АТАКА <output data-output="attackMs"></output></span><input data-synth="attackMs" type="range" min="1" max="1000" step="1" aria-label="Время атаки" /></label>
      <label class="synth-control"><span>ЗАТУХАНИЕ <output data-output="releaseMs"></output></span><input data-synth="releaseMs" type="range" min="10" max="1200" step="1" aria-label="Время затухания" /></label>
      <label class="synth-control"><span>РАССТРОЙКА <output data-output="detuneCents"></output></span><input data-synth="detuneCents" type="range" min="-100" max="100" step="1" aria-label="Расстройка в центах" /></label>
    </div>
    <p class="field-help">Параметры влияют на живое воспроизведение, рендер MIDI и экспорт WAV.</p>
  </section>`;
  $('.synth-header strong', body).textContent = INSTRUMENTS.find(item => item.id === track.instrument)?.name || 'Синтезатор';
  const waveform = $('[data-synth="waveform"]', body); waveform.value = settings.waveform;
  for (const input of $$('[data-synth]:not([data-synth="waveform"])', body)) {
    const key = input.dataset.synth; input.value = settings[key]; updateSynthOutput(body, key, settings[key]);
  }
  $('#synthInstrument', body).addEventListener('change', event => {
    recordUndo(); track.instrument = event.target.value; track.synthSettings = normalizeSynthSettings(track.synthSettings, track.instrument);
    markProjectDirty(); restartProjectPlaybackIfActive(); renderEditor(); $('#synthInstrument')?.focus();
  });
  for (const control of $$('[data-synth]', body)) {
    control.addEventListener('focus', recordUndo, { once: true });
    control.addEventListener('input', () => {
      const key = control.dataset.synth, value = key === 'waveform' ? control.value : Number(control.value);
      track.synthSettings = normalizeSynthSettings({ ...track.synthSettings, [key]: value }, track.instrument);
      if (key !== 'waveform') updateSynthOutput(body, key, track.synthSettings[key]);
      markProjectDirty();
    });
    control.addEventListener('change', restartProjectPlaybackIfActive);
  }
  $('#previewSynthBtn', body).addEventListener('click', () => previewNote(track.instrument, 60, track.synthSettings));
}

function updateSynthOutput(root, key, value) {
  const output = $(`[data-output="${key}"]`, root); if (!output) return;
  output.textContent = key === 'cutoffHz' ? `${Math.round(value).toLocaleString('ru-RU')} Гц` : key === 'detuneCents' ? `${value > 0 ? '+' : ''}${value} ц` : `${value} мс`;
}

function bindEditorActions() { $('#createPatternBtn')?.addEventListener('click', createDrumPattern); $('#createNotesBtn')?.addEventListener('click', createMidiPattern); $('#createAutomationEmptyBtn')?.addEventListener('click', createAutomationClip); }

function getClipPlaybackRate(clip, usesRendered = Boolean(clip.renderedAssetId && !clip.bypassProcessing)) {
  const rate = clip.rate || 1;
  if (usesRendered) return rate;
  if (clip.bypassProcessing) return rate / (clip.timeStretchRatio || 1);
  return rate * 2 ** ((clip.pitch || 0) / 12);
}

function getClipSourceOffsetSec(clip) {
  const scale = clip.bypassProcessing && clip.timeStretchRatio ? 1 / clip.timeStretchRatio : 1;
  return Math.max(0, (clip.offsetSec || 0) * scale);
}

function getClipSourceTrimEndSec(clip) {
  const scale = clip.bypassProcessing && clip.timeStretchRatio ? 1 / clip.timeStretchRatio : 1;
  return Math.max(0, (clip.trimEndSec || 0) * scale);
}

async function applyClipTimeStretch(clip, sourceTempo) {
  if (!Number.isFinite(sourceTempo) || sourceTempo < 40 || sourceTempo > 240) { showToast('Темп исходника должен быть от 40 до 240 BPM'); return; }
  if (pitchPendingClips.has(clip.id)) return;
  const ratio = sourceTempo / state.tempo;
  if (Math.abs(ratio - 1) < 1e-9) { showToast('Темп исходника уже совпадает с темпом проекта'); return; }
  if (!Number.isFinite(ratio) || ratio < .5 || ratio > 2) { showToast('Слишком большая разница темпов: допустимо от 50% до 200%'); return; }
  const button = $('#applyTimeStretchBtn');
  const source = clip.clapPluginName && clip.renderedAssetId
    ? state.assets.get(clip.renderedAssetId)
    : state.assets.get(clip.assetId);
  if (!source?.buffer) { showToast('Исходный аудиофайл клипа не найден'); return; }
  pitchPendingClips.add(clip.id);
  if (button) { button.disabled = true; button.textContent = 'Растягиваю аудио…'; }
  recordUndo(); showToast(`Подгоняю аудио ${Math.round(sourceTempo)} → ${Math.round(state.tempo)} BPM без изменения высоты…`);
  try {
    let buffer = source.buffer;
    if (!clip.clapPluginName) {
      if (clip.autoTune?.enabled) buffer = await createAutoTune(buffer, clip.autoTune);
      if (clip.pitch) buffer = await createPitchShift(buffer, clip.pitch);
    }
    const incrementalRatio = clip.clapPluginName && clip.timeStretchRatio ? ratio / clip.timeStretchRatio : ratio;
    if (incrementalRatio < .5 || incrementalRatio > 2) { showToast('Измените темп проекта или исходника ближе к текущему растяжению и повторите'); return; }
    const stretchResult = await createTempoStretch(buffer, incrementalRatio); buffer = stretchResult.buffer;
    if (getClip(clip.id).clip !== clip) return;
    const id = uid('stretch');
    if (!canStoreAudioAsset(buffer, id)) return;
    if (!clip.timeStretchRatio) {
      clip.stretchOriginalLengthBeats = clip.lengthBeats;
      clip.stretchOriginalOffsetSec = clip.offsetSec || 0;
      clip.stretchOriginalTrimEndSec = clip.trimEndSec || 0;
    }
    clip.timeStretchSourceTempo = sourceTempo; clip.timeStretchRatio = ratio;
    clip.offsetSec = clip.stretchOriginalOffsetSec * ratio; clip.trimEndSec = clip.stretchOriginalTrimEndSec * ratio;
    state.assets.set(id, { id, name: `${source.name} · ${Math.round(sourceTempo)}→${Math.round(state.tempo)} BPM`, buffer, source: 'processed', type: 'audio', mime: 'audio/wav', fileName: source.fileName });
    clip.renderedAssetId = id; clip.bypassProcessing = false;
    clip.lengthBeats = Math.max(.25, (buffer.duration - clip.offsetSec - clip.trimEndSec) / (clip.rate || 1) * state.tempo / 60);
    clip.timeStretchRatio = ratio;
    restartPlaybackIfActive(); renderAll(); showToast(`Аудио подогнано к ${Math.round(state.tempo)} BPM · ${stretchResult.engine}`);
  } catch (error) {
    console.error(error); showToast('Не удалось растянуть аудио');
  } finally {
    pitchPendingClips.delete(clip.id);
    if (button?.isConnected) { button.disabled = false; button.textContent = 'Подогнать к темпу проекта'; }
  }
}

async function applyClipPitch(clip, requestedSemitones) {
  const semitones = Math.round(clamp(Number(requestedSemitones) || 0, -24, 24));
  if (pitchPendingClips.has(clip.id)) return;
  await applyClipProcessing(clip, semitones, clip.autoTune || null, 'Меняю высоту без изменения длительности…', 'Применить высоту');
}

async function applyClipAutotune(clip, settings) {
  if (pitchPendingClips.has(clip.id)) return;
  await applyClipProcessing(clip, clip.pitch || 0, settings, 'Корректирую голос по тональности проекта…', 'Исправить по тональности');
}

async function inspectClipClap(clip) {
  if (pitchPendingClips.has(clip.id)) return;
  if (!window.sonoraNative?.inspectClapEffect) { showToast('CLAP доступен только в настольной версии'); return; }
  const button = $('#selectClapBtn');
  if (button) { button.disabled = true; button.textContent = 'Проверяю CLAP-плагин…'; }
  try {
    const response = await window.sonoraNative.inspectClapEffect();
    if (!response?.ok) {
      if (!response?.cancelled) showToast(response?.error || 'Не удалось прочитать CLAP-плагин');
      return;
    }
    const values = {};
    for (const parameter of response.parameters || []) {
      const saved = clip.clapPluginId === response.pluginId ? clip.clapParameters?.[parameter.id] : undefined;
      values[parameter.id] = Number.isFinite(saved) && saved >= parameter.min && saved <= parameter.max ? saved : parameter.value;
    }
    clapSelections.set(clip.id, { ...response, values });
    renderAll(); showToast(`Плагин готов · ${response.pluginName}`);
  } catch (error) {
    console.error(error); showToast('Не удалось прочитать CLAP-плагин');
  } finally {
    if (button?.isConnected) { button.disabled = false; button.textContent = 'Выбрать другой CLAP…'; }
  }
}

function renderClapControls(clip) {
  const host = $('#clapControls'), applyButton = $('#applyClapBtn'), selection = clapSelections.get(clip.id);
  if (!host || !applyButton) return;
  if (!selection) {
    host.innerHTML = clip.clapPluginName ? `<small class="field-help">Обработан: ${escapeHtml(clip.clapPluginName)}. Чтобы изменить параметры, выберите плагин ещё раз.</small>` : '';
    applyButton.disabled = true; applyButton.textContent = 'Выберите плагин';
    return;
  }
  host.innerHTML = `<small class="clap-plugin-name">${escapeHtml(selection.pluginName)}</small>${selection.parameters.map(parameter => {
    const name = [parameter.module, parameter.name].filter(Boolean).join(' · ');
    const id = `clap-param-${parameter.id}`;
    return `<div class="clap-parameter"><label for="${id}">${escapeHtml(name)} <output>${formatClapValue(selection.values[parameter.id])}</output></label><input id="${id}" data-clap-param="${parameter.id}" type="range" min="${parameter.min}" max="${parameter.max}" step="${parameter.stepped ? '1' : 'any'}" value="${selection.values[parameter.id]}" /></div>`;
  }).join('')}`;
  host.querySelectorAll('[data-clap-param]').forEach(input => input.addEventListener('input', () => {
    const id = Number(input.dataset.clapParam), parameter = selection.parameters.find(item => item.id === id);
    const value = Number(input.value);
    selection.values[id] = parameter.stepped ? Math.round(value) : value;
    input.closest('.clap-parameter').querySelector('output').textContent = formatClapValue(selection.values[id]);
  }));
  applyButton.disabled = false;
  applyButton.textContent = `Применить · ${selection.pluginName}`;
}

function formatClapValue(value) {
  return Number.isFinite(value) ? Number(value).toPrecision(4).replace(/\.?0+$/, '') : '—';
}

async function applyClipClap(clip) {
  if (pitchPendingClips.has(clip.id)) return;
  if (!window.sonoraNative?.renderClapEffect) { showToast('CLAP доступен только в настольной версии'); return; }
  const selection = clapSelections.get(clip.id);
  if (!selection) { showToast('Сначала выберите CLAP-плагин'); return; }
  const original = state.assets.get(clip.assetId);
  const sourceId = clip.clapPluginName && clip.clapSourceAssetId ? clip.clapSourceAssetId : clip.renderedAssetId && !clip.bypassProcessing ? clip.renderedAssetId : clip.assetId;
  const source = state.assets.get(sourceId), button = $('#applyClapBtn');
  if (!original || !source) { showToast('Исходный аудиофайл клипа не найден'); return; }
  pitchPendingClips.add(clip.id);
  if (button) { button.disabled = true; button.textContent = 'Рендерю CLAP…'; }
  try {
    const sourceOffset = clip.clapPluginName ? clip.clapSourceOffsetSec || 0 : clip.offsetSec || 0;
    const sourceTrim = clip.clapPluginName ? clip.clapSourceTrimEndSec || 0 : clip.trimEndSec || 0;
    const startFrame = Math.min(source.buffer.length - 1, Math.floor(sourceOffset * source.buffer.sampleRate));
    const endFrame = Math.min(source.buffer.length, Math.max(startFrame + 1, source.buffer.length - Math.floor(sourceTrim * source.buffer.sampleRate)));
    const sourceFrames = endFrame - startFrame, audioContext = getAudioContext();
    const renderInput = audioContext.createBuffer(source.buffer.numberOfChannels, sourceFrames, source.buffer.sampleRate);
    for (let channel = 0; channel < source.buffer.numberOfChannels; channel++) {
      renderInput.copyToChannel(source.buffer.getChannelData(channel).subarray(startFrame, endFrame), channel);
    }
    const response = await window.sonoraNative.renderClapEffect(selection.selectionToken, encodeWav(renderInput), selection.values);
    if (!response?.ok) {
      if (!response?.cancelled) showToast(response?.error || 'Не удалось применить CLAP эффект');
      return;
    }
    const buffer = await audioContext.decodeAudioData(response.wav.slice(0));
    if (getClip(clip.id).clip !== clip) return;
    const id = uid('clap'), name = String(response.pluginName || 'CLAP effect').slice(0, 120);
    if (!canStoreAudioAsset(buffer, id)) return;
    recordUndo();
    state.assets.set(id, { id, name: `${original.name} · ${name}`, buffer, source: 'processed', type: 'audio', mime: 'audio/wav', fileName: original.fileName });
    if (!clip.clapPluginName) {
      clip.clapOriginalLengthBeats = clip.lengthBeats;
      clip.clapOriginalOffsetSec = clip.offsetSec || 0;
      clip.clapOriginalTrimEndSec = clip.trimEndSec || 0;
      clip.clapSourceAssetId = sourceId;
      clip.clapSourceOffsetSec = clip.offsetSec || 0;
      clip.clapSourceTrimEndSec = clip.trimEndSec || 0;
    }
    clip.clapPluginName = name; clip.clapPluginId = response.pluginId; clip.clapParameters = { ...selection.values }; clip.pitch = 0; clip.autoTune = null; clip.renderedAssetId = id; clip.bypassProcessing = false;
    clip.offsetSec = 0; clip.trimEndSec = 0;
    clip.lengthBeats = Math.max(.25, buffer.duration / (clip.rate || 1) * state.tempo / 60);
    restartPlaybackIfActive(); renderAll(); showToast(`Обработка CLAP завершена · ${name}`);
  } catch (error) {
    console.error(error); showToast('Не удалось обработать клип эффектом CLAP');
  } finally {
    pitchPendingClips.delete(clip.id);
    if (button?.isConnected) { button.disabled = false; renderClapControls(clip); }
  }
}

async function applyClipProcessing(clip, semitones, autoTune, progressMessage, buttonLabel) {
  const original = state.assets.get(clip.assetId), button = $('#applyPitchBtn');
  if (!original) { showToast('Исходный аудиофайл клипа не найден'); return; }
  pitchPendingClips.add(clip.id);
  if (button) { button.disabled = true; button.textContent = 'Обработка…'; }
  const autotuneButton = $('#applyAutotuneBtn'); if (autotuneButton) { autotuneButton.disabled = true; autotuneButton.textContent = 'Обработка…'; }
  if (!semitones && !autoTune?.enabled) {
    recordUndo(); clip.pitch = 0; clip.autoTune = null; clip.renderedAssetId = null; pitchPendingClips.delete(clip.id);
    restartPlaybackIfActive(); renderAll(); return;
  }
  recordUndo(); showToast(progressMessage);
  try {
    let buffer = original.buffer;
    if (autoTune?.enabled) buffer = await createAutoTune(buffer, autoTune);
    if (semitones) buffer = await createPitchShift(buffer, semitones);
    if (clip.timeStretchRatio) buffer = await createTimeStretch(buffer, clip.timeStretchRatio);
    if (getClip(clip.id).clip !== clip) return;
    const id = uid('processed'), pitchLabel = semitones ? ` ${semitones > 0 ? '+' : ''}${semitones} st` : '';
    if (!canStoreAudioAsset(buffer, id)) {
      if (button?.isConnected) { button.disabled = false; button.textContent = buttonLabel; }
      if (autotuneButton?.isConnected) { autotuneButton.disabled = false; autotuneButton.textContent = 'Исправить по тональности'; }
      return;
    }
    state.assets.set(id, { id, name: `${original.name}${pitchLabel}${autoTune?.enabled ? ' · autotune' : ''}`, buffer, source: 'processed', type: 'audio', mime: 'audio/wav', fileName: original.fileName });
    clip.pitch = semitones; clip.autoTune = autoTune?.enabled ? { ...autoTune } : null; clip.renderedAssetId = id;
    restartPlaybackIfActive(); renderAll(); showToast(autoTune?.enabled ? `Голос скорректирован в тональности ${autoTune.key}` : `Высота изменена на ${semitones > 0 ? '+' : ''}${semitones} полутонов`);
  } catch (error) {
    console.error(error); showToast('Не удалось обработать клип');
    if (button?.isConnected) { button.disabled = false; button.textContent = buttonLabel; }
    if (autotuneButton?.isConnected) { autotuneButton.disabled = false; autotuneButton.textContent = 'Исправить по тональности'; }
  } finally { pitchPendingClips.delete(clip.id); }
}

function runDspWorker(buffer, options) {
  const id = ++pitchJobCounter, channels = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) channels.push(buffer.getChannelData(channel).slice().buffer);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pitchJobs.delete(id); reject(new Error('DSP worker timed out')); }, 120000);
    pitchJobs.set(id, { resolve, reject, timeout });
    window.__SONORA_DEBUG__?.requests?.push({ id, mode: options.mode, sampleRate: buffer.sampleRate, length: channels[0].byteLength / 4 });
    try { pitchWorker.postMessage({ id, channels, sampleRate: buffer.sampleRate, ...options }, channels); }
    catch (error) { clearTimeout(timeout); pitchJobs.delete(id); reject(error); }
  });
}

function createPitchShift(buffer, semitones) { return runDspWorker(buffer, { mode: 'pitch', semitones }); }
function createAutoTune(buffer, settings) { return runDspWorker(buffer, { mode: 'autotune', key: settings.key, strength: settings.strength, speed: settings.speed }); }
function createTimeStretch(buffer, factor) { return runDspWorker(buffer, { mode: 'stretch', factor }); }
async function createTempoStretch(buffer, factor) {
  try {
    const { renderTempoStretch } = await import('./signalsmith-render.mjs');
    return { buffer: await renderTempoStretch(buffer, factor), engine: 'Signalsmith' };
  } catch (error) {
    console.warn('Signalsmith unavailable; using local WSOLA fallback', error);
    return { buffer: await createTimeStretch(buffer, factor), engine: 'WSOLA fallback' };
  }
}

function restartPlaybackIfActive() {
  if (!state.playing) return;
  const beat = state.playheadBeat;
  if (nativePlaybackActive) forceBrowserPlayback = true;
  stopPlayback(false); state.playheadBeat = beat; play();
}

function restartProjectPlaybackIfActive() {
  if (!state.playing) return;
  const beat = state.playheadBeat;
  stopPlayback(false); state.playheadBeat = beat; play();
}

function focusPianoNote(index) {
  requestAnimationFrame(() => $(`.piano-note[data-note-index="${index}"]`, $('#editorBody'))?.focus());
}

function renderPianoRoll(body, clip, track) {
  const selectedIndex = selectedMidiNote?.clipId === clip.id ? selectedMidiNote.index : -1;
  const selectedNote = clip.notes[selectedIndex];
  if (selectedNote && (selectedNote.note < pianoRangeStart || selectedNote.note > pianoRangeStart + 11)) pianoRangeStart = Math.min(120, Math.floor(selectedNote.note / 12) * 12);
  const octaves = Array.from({ length: 12 }, (_, row) => pianoRangeStart + 11 - row);
  const noteNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const noteLabel = note => `${noteNames[note % 12]}${Math.floor(note / 12) - 1}`;
  body.innerHTML = '<div class="piano-range-controls"><button id="pianoOctaveDown" class="button quiet compact" type="button" aria-label="Показать октаву ниже">− Октава</button><output id="pianoRangeLabel" aria-live="polite"></output><button id="pianoOctaveUp" class="button quiet compact" type="button" aria-label="Показать октаву выше">＋ Октава</button></div><div class="piano-wrap"><div class="piano-keys"></div><div class="piano-grid"></div></div><div id="pianoNoteControls"></div><div class="piano-hint">Клик добавляет ноту; перетаскивание меняет высоту и позицию, а правый край — длительность. Стрелки перемещают выбранную ноту по сетке и по диапазону MIDI.</div>';
  const rangeLabel = $('#pianoRangeLabel', body);
  rangeLabel.textContent = `${noteLabel(pianoRangeStart)} – ${noteLabel(Math.min(127, pianoRangeStart + 11))}`;
  const octaveDown = $('#pianoOctaveDown', body), octaveUp = $('#pianoOctaveUp', body);
  octaveDown.disabled = pianoRangeStart === 0; octaveUp.disabled = pianoRangeStart === 120;
  octaveDown.addEventListener('click', () => { pianoRangeStart = shiftMidiOctave(pianoRangeStart, -1); selectedMidiNote = null; renderEditor(); requestAnimationFrame(() => $('#pianoOctaveDown')?.focus()); });
  octaveUp.addEventListener('click', () => { pianoRangeStart = shiftMidiOctave(pianoRangeStart, 1); selectedMidiNote = null; renderEditor(); requestAnimationFrame(() => $('#pianoOctaveUp')?.focus()); });
  const keys = $('.piano-keys', body), grid = $('.piano-grid', body);
  octaves.forEach(note => { const el = document.createElement('div'); el.className = `piano-key ${[1, 3, 6, 8, 10].includes(note % 12) ? 'black' : ''}`; el.textContent = note % 12 === 0 ? `C${Math.floor(note / 12) - 1}` : ''; keys.append(el); });
  for (let row = 0; row < 12; row++) for (let col = 0; col < 16; col++) {
    const cell = document.createElement('button'); cell.className = `piano-cell ${octaves[row] % 12 === 0 ? 'c-note' : ''}`;
    cell.disabled = octaves[row] > 127;
    cell.setAttribute('aria-label', cell.disabled ? `Высота выше MIDI 127` : `Добавить ноту ${noteLabel(octaves[row])}, такт ${Math.floor(col / 4) + 1}, доля ${col % 4 + 1}`);
    cell.addEventListener('click', () => {
      if (cell.disabled) return;
      if (clip.notes.length >= 8192) { showToast('В MIDI-партии достигнут лимит нот (8192)'); return; }
      if (!canAddEvents(1)) return;
      recordUndo(); clip.notes.push({ beat: col / 4, length: .9, note: octaves[row], velocity: .75 });
      selectedMidiNote = { clipId: clip.id, index: clip.notes.length - 1 };
      previewNote(track?.instrument || 'soft-keys', octaves[row]); renderEditor(); renderTimeline(); focusPianoNote(clip.notes.length - 1);
    });
    grid.append(cell);
  }

  for (const [index, note] of clip.notes.entries()) {
    if (note.note < pianoRangeStart || note.note > pianoRangeStart + 11) continue;
    const noteEl = document.createElement('button'); noteEl.type = 'button'; noteEl.dataset.noteIndex = index;
    noteEl.className = `piano-note ${index === selectedIndex ? 'is-selected' : ''}`;
    noteEl.style.left = `${note.beat / 4 * 100}%`;
    noteEl.style.width = `${Math.max(5.5, note.length / 4 * 100 - .7)}%`;
    noteEl.style.top = `${((pianoRangeStart + 11 - note.note) / 12) * 100}%`;
    noteEl.setAttribute('aria-label', `Нота ${noteLabel(note.note)}, MIDI ${note.note}, позиция ${note.beat} долей, длительность ${note.length}, сила ${Math.round((note.velocity ?? .75) * 100)} процентов. Стрелки перемещают ноту; Delete удаляет.`);
    noteEl.innerHTML = '<span class="piano-note-resize" aria-hidden="true"></span>';
    noteEl.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation(); noteEl.focus(); noteEl.setPointerCapture(event.pointerId);
      const bounds = grid.getBoundingClientRect(), startX = event.clientX, startY = event.clientY;
      const startBeat = note.beat, startLength = note.length, startPitch = note.note;
      const resize = Boolean(event.target.closest('.piano-note-resize'));
      let changed = false;
      const move = pointerEvent => {
        const dx = pointerEvent.clientX - startX, dy = pointerEvent.clientY - startY;
        if (Math.hypot(dx, dy) < 3) return;
        if (!changed) { recordUndo(); changed = true; }
        if (resize) note.length = clamp(snapBeat(startLength + dx / bounds.width * 4), .25, Math.max(.25, clip.lengthBeats - note.beat));
        else {
          note.beat = clamp(snapBeat(startBeat + dx / bounds.width * 4), 0, Math.max(0, clip.lengthBeats - .25));
          note.note = clamp(startPitch - Math.round(dy / (bounds.height / 12)), pianoRangeStart, Math.min(127, pianoRangeStart + 11));
        }
        noteEl.style.left = `${note.beat / 4 * 100}%`;
        noteEl.style.width = `${Math.max(5.5, note.length / 4 * 100 - .7)}%`;
        noteEl.style.top = `${((71 - note.note) / 12) * 100}%`;
      };
      const finish = () => {
        noteEl.removeEventListener('pointermove', move); noteEl.removeEventListener('pointerup', finish); noteEl.removeEventListener('pointercancel', finish);
        selectedMidiNote = { clipId: clip.id, index };
        if (changed) { markProjectDirty(); renderEditor(); renderTimeline(); }
        else { previewNote(track?.instrument || 'soft-keys', note.note); renderEditor(); }
        focusPianoNote(index);
      };
      noteEl.addEventListener('pointermove', move); noteEl.addEventListener('pointerup', finish, { once: true }); noteEl.addEventListener('pointercancel', finish, { once: true });
    });
    noteEl.addEventListener('keydown', event => {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault(); event.stopPropagation(); recordUndo(); clip.notes.splice(index, 1); selectedMidiNote = null; renderEditor(); renderTimeline(); return;
      }
      const changes = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-.25, 0], ArrowRight: [.25, 0] }[event.key];
      if (!changes) return;
      event.preventDefault(); event.stopPropagation(); recordUndo();
      note.beat = clamp(snapBeat(note.beat + changes[0]), 0, Math.max(0, clip.lengthBeats - .25));
      note.note = clampMidiPitch(note.note + changes[1]);
      if (note.note < pianoRangeStart || note.note > pianoRangeStart + 11) pianoRangeStart = midiOctaveStart(note.note);
      selectedMidiNote = { clipId: clip.id, index };
      markProjectDirty(); renderEditor(); renderTimeline(); focusPianoNote(index);
    });
    grid.append(noteEl);
  }

  const controls = $('#pianoNoteControls', body);
  if (selectedNote) {
    controls.innerHTML = `<label class="piano-velocity-label" for="pianoVelocity">СИЛА НОТЫ <output>${Math.round((selectedNote.velocity ?? .75) * 100)}%</output></label><input id="pianoVelocity" class="piano-velocity" type="range" min="0" max="1" step="0.01" value="${selectedNote.velocity ?? .75}" aria-label="Сила выбранной ноты"/><button id="deletePianoNote" class="button quiet compact">Удалить ноту</button>`;
    const velocity = $('#pianoVelocity', controls), output = $('output', controls);
    velocity.addEventListener('focus', recordUndo);
    velocity.addEventListener('input', () => { selectedNote.velocity = Number(velocity.value); output.textContent = `${Math.round(selectedNote.velocity * 100)}%`; markProjectDirty(); });
    velocity.addEventListener('change', () => { if (state.playing) restartPlaybackIfActive(); });
    $('#deletePianoNote', controls).addEventListener('click', () => { recordUndo(); clip.notes.splice(selectedIndex, 1); selectedMidiNote = null; renderEditor(); renderTimeline(); });
  } else controls.textContent = 'Выберите ноту, чтобы настроить её силу.';
}

function createMixerBus() {
  if (state.tracks.length + state.buses.length >= PROJECT_LIMITS.tracks) { showToast(`Достигнут общий лимит каналов (${PROJECT_LIMITS.tracks})`); return; }
  const index = state.buses.length + 1, palette = themePalette();
  const bus = { id: uid('bus'), name: `Шина ${index}`, color: palette[(state.tracks.length + index - 1) % palette.length], volume: .8, pan: 0, mute: false, solo: false, effects: { reverb: false, delay: false, equalizer: false, compressor: false, limiter: false } };
  recordUndo(); state.buses.push(bus); renderAll(); restartProjectPlaybackIfActive(); showToast(`${bus.name} создана`);
}
function renderMixer() {
  const host = $('#mixerStrips'); host.innerHTML = '';
  const channels = [...state.tracks.map(channel => ({ channel, isBus: false })), ...state.buses.map(channel => ({ channel, isBus: true }))];
  for (const { channel, isBus } of channels) {
    const strip = document.createElement('div'); strip.className = `mixer-strip${isBus ? ' mixer-bus-strip' : ''}`; strip.dataset.track = channel.id;
    strip.innerHTML = `<strong></strong><span class="meter" role="meter" aria-label="Уровень канала" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="Пик −∞ dBFS"><i data-level="normal"></i></span><input class="volume-control" type="range" min="0" max="1.2" step="0.01" value="${channel.volume}" aria-label="Громкость канала"/><input class="pan-control" type="range" min="-1" max="1" step="0.01" value="${channel.pan}" aria-label="Панорама канала"/><div class="strip-controls"><button data-mode="mute" title="Заглушить">M</button><button data-mode="solo" title="Соло">S</button><button data-effect="reverb" title="Реверберация" aria-label="Реверберация">RV</button><button data-effect="delay" title="Задержка" aria-label="Задержка">DL</button><button data-effect="equalizer" title="Параметрический EQ" aria-label="Параметрический EQ">EQ</button></div>`;
    $('strong', strip).textContent = channel.name; $('.meter', strip).setAttribute('aria-label', `Уровень канала: ${channel.name}`);
    for (const mode of ['mute', 'solo']) { const control = $(`[data-mode=${mode}]`, strip), label = mode === 'mute' ? 'Заглушить' : 'Соло'; control.classList.toggle('active', Boolean(channel[mode])); control.setAttribute('aria-label', `${label}: ${channel.name}`); control.setAttribute('aria-pressed', String(Boolean(channel[mode]))); control.onclick = () => { recordUndo(); channel[mode] = !channel[mode]; renderAll(); updateLiveTrackMix(); restartProjectPlaybackIfActive(); }; }
    for (const effect of ['reverb', 'delay', 'equalizer']) { const control = $(`[data-effect=${effect}]`, strip); control.classList.toggle('active', Boolean(channel.effects?.[effect])); control.setAttribute('aria-pressed', String(Boolean(channel.effects?.[effect]))); control.onclick = () => { if (!isBus) { toggleTrackEffect(channel.id, effect); return; } recordUndo(); channel.effects ||= {}; channel.effects[effect] = !channel.effects[effect]; renderAll(); restartProjectPlaybackIfActive(); }; }
    if (isBus) {
      const remove = document.createElement('button'); remove.className = 'bus-remove'; remove.type = 'button'; remove.textContent = 'Удалить шину'; remove.setAttribute('aria-label', `Удалить шину: ${channel.name}`);
      remove.onclick = () => { recordUndo(); state.tracks.forEach(track => { if (track.outputBusId === channel.id) track.outputBusId = null; }); state.buses = state.buses.filter(bus => bus.id !== channel.id); renderAll(); restartProjectPlaybackIfActive(); showToast(`Шина «${channel.name}» удалена`); };
      strip.append(remove);
    } else {
      const route = document.createElement('select'); route.className = 'route-control'; route.setAttribute('aria-label', `Выход: ${channel.name}`); route.title = `Выход: ${channel.name}`;
      const master = document.createElement('option'); master.value = ''; master.textContent = 'Мастер'; route.append(master);
      for (const bus of state.buses) { const option = document.createElement('option'); option.value = bus.id; option.textContent = bus.name; route.append(option); }
      route.value = channel.outputBusId || ''; route.onchange = () => { recordUndo(); channel.outputBusId = route.value || null; markProjectDirty(); restartProjectPlaybackIfActive(); showToast(`Выход канала «${channel.name}» обновлён`); }; strip.append(route);
    }
    const gain = $('.volume-control', strip), pan = $('.pan-control', strip); gain.setAttribute('aria-label', `Громкость: ${channel.name}`); pan.setAttribute('aria-label', `Панорама: ${channel.name}`);
    gain.oninput = event => { channel.volume = Number(event.target.value); markProjectDirty(); const node = liveTrackGains.get(channel.id); if (node) node.gain.setTargetAtTime(channel.volume, getAudioContext().currentTime, .015); };
    pan.oninput = event => { channel.pan = Number(event.target.value); markProjectDirty(); const node = liveTrackPans.get(channel.id); if (node) node.pan.setTargetAtTime(channel.pan, getAudioContext().currentTime, .015); };
    gain.addEventListener('change', () => { restartProjectPlaybackIfActive(); if (!isBus && channel.id === state.selectedTrackId) renderInspector(); }); pan.addEventListener('change', () => { restartProjectPlaybackIfActive(); if (!isBus && channel.id === state.selectedTrackId) renderInspector(); });
    gain.addEventListener('focus', recordUndo, { once: true }); pan.addEventListener('focus', recordUndo, { once: true }); host.append(strip);
  }
  const master = document.createElement('div'); master.className = 'mixer-strip'; master.innerHTML = `<strong>Мастер</strong><span class="meter" role="meter" aria-label="Уровень мастера" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="Пик −∞ dBFS"><i id="masterStripMeter" data-level="normal"></i></span><input id="masterStripVolume" type="range" min="0" max="1" step="0.01" value="${state.masterVolume}" aria-label="Громкость главного выхода"/><div class="strip-controls"><button title="Стерео" aria-label="Стерео выход">ST</button><span style="margin-left:auto;color:#89929f;font:8px ui-monospace,Consolas,monospace">BUS</span></div>`;
  $('input', master).oninput = event => { state.masterVolume = Number(event.target.value); markProjectDirty(); $('#masterVolume').value = state.masterVolume; if (liveMasterGain) liveMasterGain.gain.setTargetAtTime(state.masterVolume, getAudioContext().currentTime, .015); if (nativePlaybackActive) restartPlaybackIfActive(); };
  $('input', master).addEventListener('focus', recordUndo, { once: true }); host.append(master);
}
function toggleTrackEffect(trackId, effect) {
  const track = getTrack(trackId); if (!track) return;
  const restart = state.playing, beat = state.playheadBeat;
  recordUndo(); track.effects ||= {}; track.effects[effect] = !track.effects[effect];
  if (effect === 'equalizer' && track.effects[effect]) track.eqSettings = normalizeEqSettings(track.eqSettings);
  if (effect === 'compressor' && track.effects[effect]) track.compressorSettings = normalizeCompressorSettings(track.compressorSettings);
  markProjectDirty();
  if (restart) { stopPlayback(false); state.playheadBeat = beat; play(); }
  if (effect === 'limiter' && track.effects[effect]) track.limiterSettings = normalizeLimiterSettings(track.limiterSettings);
  const label = ({ reverb: 'Реверберация', delay: 'Задержка', equalizer: 'Параметрический EQ', compressor: 'Компрессор', limiter: 'Лимитер' })[effect];
  renderMixer(); renderInspector(); showToast(`${label} ${track.effects[effect] ? 'включён' : 'выключен'}`);
}

function updateLiveTrackMix() {
  const solo = state.tracks.some(track => track.solo), now = audioContext?.currentTime || 0;
  for (const track of state.tracks) {
    const gain = liveTrackGains.get(track.id); if (!gain) continue;
    const value = track.mute || (solo && !track.solo) ? 0 : track.volume;
    gain.gain.setTargetAtTime(value, now, .015);
  }
}

function updatePosition() {
  const bar = Math.floor(state.playheadBeat / 4) + 1, beat = Math.floor(state.playheadBeat % 4) + 1, tick = Math.floor((state.playheadBeat % 1) * 960);
  $('#positionText').textContent = `${String(bar).padStart(3, '0')} : ${String(beat).padStart(2, '0')} : ${String(tick).padStart(3, '0')}`;
  $('#playheadLine').style.left = `${beatsToPx(state.playheadBeat)}px`;
  if (followPlayhead && state.playing) { const scroll = $('#timelineScroll'); const x = beatsToPx(state.playheadBeat); if (x > scroll.scrollLeft + scroll.clientWidth - 100) scroll.scrollLeft = x - 100; }
}

function updateTransport() { $('#playBtn').classList.toggle('is-playing', state.playing); $('#playBtn').innerHTML = state.playing ? '<span>Ⅱ</span>' : '<span>▶</span>'; $('#playBtn').setAttribute('aria-label', state.playing ? 'Приостановить воспроизведение' : 'Воспроизвести'); $('#playBtn').setAttribute('aria-pressed', String(state.playing)); $('#recordBtn').classList.toggle('recording', state.recording); $('#recordBtn').setAttribute('aria-label', state.recording ? 'Остановить запись' : 'Запись с микрофона'); $('#recordBtn').setAttribute('aria-pressed', String(state.recording)); const engineNote = $('#mixerEngineNote'); if (engineNote) engineNote.textContent = nativePlaybackPending ? 'Подготовка native-аудиодвижка…' : nativePlaybackActive ? 'WASAPI · нативный аудиомикшер' : state.playing && state.tracks.some(track => track.clips.some(clip => clip.kind === 'automation')) ? 'Web Audio · автоматизация громкости' : 'Звук обрабатывается в браузере'; }

function scheduleProject(context, fromBeat = 0, destination = context.destination, includeMuted = false) {
  const now = context.currentTime, secondsPerBeat = beatSeconds();
  const hasSolo = state.tracks.some(track => track.solo) || state.buses.some(bus => bus.solo);
  const busInputs = new Map();
  for (const bus of state.buses) {
    const input = context.createGain(), nodes = [];
    const audibleSoloTrack = state.tracks.some(track => track.solo && !track.mute && track.outputBusId === bus.id);
    let busNode = applyTrackEffects(context, bus, input, nodes);
    const busGain = context.createGain(); busGain.gain.setValueAtTime((bus.mute && !audibleSoloTrack) || (hasSolo && !bus.solo && !audibleSoloTrack) ? 0 : bus.volume, now);
    busNode.connect(busGain); busNode = busGain; nodes.push(busGain);
    if (context.createStereoPanner) { const panner = context.createStereoPanner(); panner.pan.setValueAtTime(bus.pan, now); busNode.connect(panner); busNode = panner; nodes.push(panner); if (context === audioContext) liveTrackPans.set(bus.id, panner); }
    if (context === audioContext) {
      const analyser = context.createAnalyser(); analyser.fftSize = 256; busNode.connect(analyser); analyser.connect(destination); nodes.push(analyser);
      liveTrackGains.set(bus.id, busGain); liveTrackMeters.set(bus.id, analyser); liveTrackMeterBuffers.set(bus.id, new Float32Array(analyser.fftSize));
    } else busNode.connect(destination);
    busInputs.set(bus.id, input);
    scheduledNodes.push({ stop: () => { nodes.forEach(node => { try { node.disconnect(); } catch {} }); liveTrackGains.delete(bus.id); liveTrackPans.delete(bus.id); liveTrackEqualizers.delete(bus.id); liveTrackCompressors.delete(bus.id); liveTrackLimiters.delete(bus.id); liveTrackMeters.delete(bus.id); liveTrackMeterBuffers.delete(bus.id); } });
  }
  for (const track of state.tracks) {
    const routedBus = state.buses.find(bus => bus.id === track.outputBusId);
    if (!includeMuted && (track.mute || (hasSolo && !track.solo && !routedBus?.solo))) continue;
    const trackNodes = [], trackGain = context.createGain(); trackGain.gain.setValueAtTime(trackVolumeAtBeat(track, fromBeat), now); trackNodes.push(trackGain); let node = trackGain;
    const automationClips = track.clips.filter(clip => clip.kind === 'automation' && clip.target === 'volume');
    if (automationClips.length) {
      const eventBeats = new Set();
      for (const clip of automationClips) {
        eventBeats.add(clip.startBeat); eventBeats.add(clip.startBeat + clip.lengthBeats);
        for (const point of clip.points) eventBeats.add(clip.startBeat + point.beat);
      }
      for (const beat of [...eventBeats].filter(beat => beat > fromBeat).sort((a, b) => a - b)) {
        trackGain.gain.linearRampToValueAtTime(trackVolumeAtBeat(track, beat), now + (beat - fromBeat) * secondsPerBeat);
      }
    }
    if (context.createStereoPanner) {
      const pan = context.createStereoPanner(); pan.pan.setValueAtTime(trackPanAtBeat(track, fromBeat), now);
      const panClips = track.clips.filter(clip => clip.kind === 'automation' && clip.target === 'pan');
      if (panClips.length) {
        const eventBeats = new Set();
        for (const clip of panClips) {
          eventBeats.add(clip.startBeat); eventBeats.add(clip.startBeat + clip.lengthBeats);
          for (const point of clip.points) eventBeats.add(clip.startBeat + point.beat);
        }
        for (const beat of [...eventBeats].filter(beat => beat > fromBeat).sort((a, b) => a - b)) {
          pan.pan.linearRampToValueAtTime(trackPanAtBeat(track, beat), now + (beat - fromBeat) * secondsPerBeat);
        }
      }
      node.connect(pan); node = pan; trackNodes.push(pan); if (context === audioContext) liveTrackPans.set(track.id, pan);
    }
    node = applyTrackEffects(context, track, node, trackNodes);
    const trackDestination = busInputs.get(track.outputBusId) || destination;
    if (context === audioContext) { const analyser = context.createAnalyser(); analyser.fftSize = 256; node.connect(analyser); analyser.connect(trackDestination); trackNodes.push(analyser); liveTrackGains.set(track.id, trackGain); liveTrackMeters.set(track.id, analyser); liveTrackMeterBuffers.set(track.id, new Float32Array(analyser.fftSize)); }
    else node.connect(trackDestination);
    for (const clip of track.clips) {
      const clipStart = clip.startBeat, clipEnd = clip.startBeat + clip.lengthBeats;
      if (clipEnd <= fromBeat) continue;
      if (clip.kind === 'drums') {
        for (const row of clip.steps || []) for (const hit of row.hits) {
          const beat = clip.startBeat + hit / 4; if (beat < fromBeat) continue;
          const sourceBuffer = createSampleBuffer(row.kind, context); const source = context.createBufferSource(), gain = context.createGain(); source.buffer = sourceBuffer; gain.gain.value = clamp(Number(row.velocity ?? .78), 0, 1); source.connect(gain); gain.connect(trackGain); source.start(now + (beat - fromBeat) * secondsPerBeat);
          scheduledNodes.push(source);
        }
      } else if (clip.kind === 'midi') {
        for (const note of clip.notes || []) {
          const beat = clip.startBeat + note.beat, endBeat = beat + note.length; if (endBeat <= fromBeat) continue;
          const when = now + Math.max(0, beat - fromBeat) * secondsPerBeat, duration = Math.max(.03, (endBeat - Math.max(fromBeat, beat)) * secondsPerBeat);
          scheduleNote(context, trackGain, when, duration, note.note, track.instrument || 'soft-keys', note.velocity, track.synthSettings);
        }
      } else {
        const useRendered = Boolean(clip.renderedAssetId && !clip.bypassProcessing);
        const asset = state.assets.get(useRendered ? clip.renderedAssetId : clip.assetId); if (!asset) continue;
        const buffer = asset.buffer;
        const playbackRate = getClipPlaybackRate(clip, useRendered);
        const offset = Math.max(0, getClipSourceOffsetSec(clip) + Math.max(0, fromBeat - clipStart) * secondsPerBeat * playbackRate), remaining = Math.max(.02, buffer.duration - offset - getClipSourceTrimEndSec(clip));
        if (offset >= buffer.duration) continue;
        const source = context.createBufferSource(), clipGain = context.createGain(); source.buffer = buffer; source.playbackRate.value = playbackRate;
        if (context === audioContext) liveClipSources.set(clip.id, source);
        source.connect(clipGain);
        if (context.createStereoPanner) { const clipPanner = context.createStereoPanner(); clipPanner.pan.value = clip.pan || 0; clipGain.connect(clipPanner); clipPanner.connect(trackGain); if (context === audioContext) liveClipPans.set(clip.id, clipPanner); }
        else clipGain.connect(trackGain);
        if (context === audioContext) liveClipGains.set(clip.id, clipGain);
        const sourceAt = now + Math.max(0, clipStart - fromBeat) * secondsPerBeat;
        const outputDuration = Math.max(.02, clipEnd * secondsPerBeat - Math.max(fromBeat, clipStart) * secondsPerBeat);
        const duration = Math.min(remaining, outputDuration * playbackRate);
        const fadeDuration = clip.lengthBeats * secondsPerBeat;
        scheduleClipGain(clipGain.gain, sourceAt, fadeDuration, clip.volume ?? 1, clip.gainEnvelope, clip.fadeInSec, clip.fadeOutSec, Math.max(0, fromBeat - clipStart) * secondsPerBeat);
         try { source.start(sourceAt, offset, duration); } catch { source.start(sourceAt, offset); }
        scheduledNodes.push(source);
      }
    }
    scheduledNodes.push({ stop: () => { trackNodes.forEach(item => { try { item.disconnect(); } catch {} }); liveTrackCompressors.delete(track.id); liveTrackLimiters.delete(track.id); for (const clip of track.clips) { liveClipGains.delete(clip.id); liveClipPans.delete(clip.id); liveClipSources.delete(clip.id); } } });
  }
  return now;
}

function applyCompressorSettings(nodes, rawSettings) {
  const settings = normalizeCompressorSettings(rawSettings), now = audioContext?.currentTime || 0;
  nodes.compressor.threshold.setTargetAtTime(settings.thresholdDb, now, .02);
  nodes.compressor.ratio.setTargetAtTime(settings.ratio, now, .02);
  nodes.compressor.attack.setTargetAtTime(settings.attackMs / 1000, now, .02);
  nodes.compressor.release.setTargetAtTime(settings.releaseMs / 1000, now, .02);
  nodes.makeup.gain.setTargetAtTime(10 ** (settings.makeupDb / 20), now, .02);
}

function applyLimiterSettings(nodes, rawSettings) {
  const settings = normalizeLimiterSettings(rawSettings), now = audioContext?.currentTime || 0;
  nodes.limiter.threshold.setTargetAtTime(settings.ceilingDb, now, .02);
  nodes.limiter.release.setTargetAtTime(settings.releaseMs / 1000, now, .02);
}

function applyTrackEffects(context, track, input, nodes) {
  const effects = track.effects || {};
  let output = input;
  if (effects.reverb) {
    const dry = context.createGain(), wet = context.createGain(), convolver = context.createConvolver(), mix = context.createGain();
    dry.gain.value = .82; wet.gain.value = .28; convolver.buffer = createReverbImpulse(context);
    output.connect(dry); dry.connect(mix); output.connect(convolver); convolver.connect(wet); wet.connect(mix);
    nodes.push(dry, wet, convolver, mix); output = mix;
  }
  if (effects.delay) {
    const dry = context.createGain(), wet = context.createGain(), delay = context.createDelay(1.5), feedback = context.createGain(), mix = context.createGain();
    dry.gain.value = .88; wet.gain.value = .2; delay.delayTime.value = .28; feedback.gain.value = .24;
    output.connect(dry); dry.connect(mix); output.connect(delay); delay.connect(wet); wet.connect(mix); delay.connect(feedback); feedback.connect(delay);
    nodes.push(dry, wet, delay, feedback, mix); output = mix;
  }
  if (effects.equalizer) {
    const settings = normalizeEqSettings(track.eqSettings), filters = [];
    for (const band of settings.bands) {
      const filter = context.createBiquadFilter();
      filter.type = 'peaking'; filter.frequency.value = band.frequencyHz; filter.gain.value = band.gainDb; filter.Q.value = band.q;
      output.connect(filter); nodes.push(filter); output = filter; filters.push(filter);
    }
    if (context === audioContext) liveTrackEqualizers.set(track.id, filters);
  }
  if (effects.compressor) {
    const settings = normalizeCompressorSettings(track.compressorSettings);
    const compressor = context.createDynamicsCompressor(), makeup = context.createGain();
    compressor.threshold.value = settings.thresholdDb; compressor.knee.value = 6; compressor.ratio.value = settings.ratio;
    compressor.attack.value = settings.attackMs / 1000; compressor.release.value = settings.releaseMs / 1000;
    makeup.gain.value = 10 ** (settings.makeupDb / 20);
    output.connect(compressor); compressor.connect(makeup); nodes.push(compressor, makeup); output = makeup;
    if (context === audioContext) liveTrackCompressors.set(track.id, { compressor, makeup });
  }
  if (effects.limiter) {
    const settings = normalizeLimiterSettings(track.limiterSettings);
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = settings.ceilingDb; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.001; limiter.release.value = settings.releaseMs / 1000;
    output.connect(limiter); nodes.push(limiter); output = limiter;
    if (context === audioContext) liveTrackLimiters.set(track.id, { limiter });
  }
  return output;
}

function createReverbImpulse(context) {
  const length = Math.floor(context.sampleRate * 1.4), impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const samples = impulse.getChannelData(channel); let seed = channel ? 0x3c6ef35f : 0x6d2b79f5;
    for (let i = 0; i < length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise = seed / 0x100000000 * 2 - 1;
      samples[i] = noise * Math.pow(1 - i / length, 2.7);
    }
  }
  return impulse;
}

function scheduleNote(context, destination, when, duration, note, instrument, velocity = .72, rawSettings = null) {
  const gain = context.createGain(), settings = normalizeSynthSettings(rawSettings, instrument);
  const attack = settings.attackMs / 1000, release = settings.releaseMs / 1000;
  const volume = .18 * clamp(Number.isFinite(velocity) ? velocity : .72, 0, 1);
  const releaseStart = when + duration, releaseEnd = releaseStart + release;
  const levelAtRelease = attack > 0 && duration < attack
    ? .0001 * (Math.max(.0001, volume) / .0001) ** (duration / attack)
    : Math.max(.0001, volume);
  gain.gain.setValueAtTime(.0001, when);
  const attackEnd = Math.min(attack, duration);
  gain.gain.exponentialRampToValueAtTime(attack < duration ? Math.max(.0001, volume) : levelAtRelease, when + attackEnd);
  if (releaseStart > when + attackEnd) gain.gain.setValueAtTime(Math.max(.0001, volume), releaseStart);
  gain.gain.exponentialRampToValueAtTime(.0001, releaseEnd);
  gain.connect(destination);
  const oscillators = createInstrumentSources(context, gain, when, note, instrument, settings);
  for (const osc of oscillators) { osc.stop(releaseEnd + .03); scheduledNodes.push(osc); }
}

function playbackTick() {
  if (!state.playing) return;
  const elapsed = nativePlaybackActive ? performance.now() / 1000 - playStartTime : getAudioContext().currentTime - playStartTime;
  state.playheadBeat = playStartBeat + elapsed / beatSeconds();
  const beatMark = Math.floor(state.playheadBeat);
  if (state.metronome && beatMark !== lastMetronomeBeat) { lastMetronomeBeat = beatMark; clickMetronome(beatMark % 4 === 0); }
  updateMeters();
  pollNativePlaybackStatus();
  if (nativePlaybackActive && !state.loop && state.playheadBeat >= nativePlaybackEndBeat) {
    state.playheadBeat = nativePlaybackEndBeat;
    stopPlayback(false);
    updatePosition();
    return;
  }
  if (state.loop && state.playheadBeat >= state.loopEndBeat) {
    stopPlayback(false);
    state.playheadBeat = wrapLoopBeat(state.playheadBeat, state.loopStartBeat, state.loopEndBeat) ?? state.loopStartBeat;
    lastMetronomeBeat = -1;
    play();
    return;
  }
  updatePosition();
  playRAF = requestAnimationFrame(playbackTick);
}

function pollNativePlaybackStatus() {
  const now = performance.now();
  if (!nativePlaybackActive || nativeMeterPollPending || now - lastNativeMeterPoll < 100) return;
  lastNativeMeterPoll = now; nativeMeterPollPending = true;
  window.sonoraNative.audioStatus().then(response => {
    if (!nativePlaybackActive || !response?.ok) return;
    const status = response.status;
    const sampleRate = status.sampleRate || 48_000;
    state.playheadBeat = status.playheadFrame / sampleRate / beatSeconds();
    const reading = presentMeter(Number(status.peak) || 0);
    setMeterReading($('#masterMeter'), reading);
    const meter = $('#masterStripMeter'); if (meter) setMeterReading(meter, reading);
    if (Array.isArray(status.trackPeaks)) {
      state.tracks.forEach((track, index) => {
        const fill = $(`[data-track="${track.id}"] .meter i`);
        if (fill) setMeterReading(fill, presentMeter(Number(status.trackPeaks[index]) || 0));
      });
    }
    if (Array.isArray(status.spectrum)) drawSpectrum(status.spectrum);
    updatePosition();
  }).catch(error => console.error('Native audio status failed:', error)).finally(() => { nativeMeterPollPending = false; });
}

function updateMeters() {
  if (masterAnalyser) {
    masterAnalyser.getFloatTimeDomainData(masterMeterBuffer);
    const reading = analyzeMeter(masterMeterBuffer);
    setMeterReading($('#masterMeter'), reading);
    const meter = $('#masterStripMeter'); if (meter) setMeterReading(meter, reading);
  }
  if (masterSpectrumAnalyser && masterSpectrumBuffer) {
    masterSpectrumAnalyser.getFloatFrequencyData(masterSpectrumBuffer);
    drawSpectrum(masterSpectrumBuffer, true);
  }
  for (const [trackId, analyser] of liveTrackMeters) {
    const samples = liveTrackMeterBuffers.get(trackId);
    if (!samples) continue;
    analyser.getFloatTimeDomainData(samples);
    const reading = analyzeMeter(samples);
    const meter = $(`[data-track="${trackId}"] .meter i`); if (meter) setMeterReading(meter, reading);
  }
}

function drawSpectrum(values, decibels = false) {
  const canvas = $('#spectrumCanvas');
  if (!canvas) return;
  const context = canvas.getContext('2d');
  if (!context) return;
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(bounds.width * scale), height = Math.round(bounds.height * scale);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  context.setTransform(scale, 0, 0, scale, 0, 0);
  const w = bounds.width, h = bounds.height;
  context.clearRect(0, 0, w, h);
  context.fillStyle = '#15111a'; context.fillRect(0, 0, w, h);
  context.strokeStyle = 'rgba(255,255,255,.08)'; context.lineWidth = 1;
  for (const y of [.25, .5, .75]) { context.beginPath(); context.moveTo(0, h * y); context.lineTo(w, h * y); context.stroke(); }
  const bars = 24, gap = 2, barWidth = Math.max(1, (w - gap * (bars - 1)) / bars);
  const nyquist = masterSpectrumAnalyser?.context?.sampleRate ? masterSpectrumAnalyser.context.sampleRate / 2 : 24_000;
  for (let band = 0; band < bars; band++) {
    let value = 0;
    if (decibels && masterSpectrumBuffer) {
      const low = Math.max(1, Math.floor(Math.pow(nyquist / 30, band / bars) * 30 / nyquist * masterSpectrumBuffer.length));
      const high = Math.min(masterSpectrumBuffer.length, Math.max(low + 1, Math.ceil(Math.pow(nyquist / 30, (band + 1) / bars) * 30 / nyquist * masterSpectrumBuffer.length)));
      let peakDb = -100;
      for (let bin = low; bin < high; bin++) peakDb = Math.max(peakDb, masterSpectrumBuffer[bin]);
      value = Math.max(0, Math.min(1, (peakDb + 72) / 72));
    } else value = Math.max(0, Math.min(1, Number(values?.[band]) * 3));
    const barHeight = Math.max(1, value * (h - 4));
    const gradient = context.createLinearGradient(0, h - barHeight, 0, h);
    gradient.addColorStop(0, '#ffb4e8'); gradient.addColorStop(1, '#ed168d');
    context.fillStyle = gradient;
    context.fillRect(band * (barWidth + gap), h - barHeight, barWidth, barHeight);
  }
  const active = Array.from(values || []).some(value => decibels ? value > -78 : Number(value) > .012);
  const summary = $('#spectrumSummary');
  if (summary) summary.textContent = active ? 'Сигнал анализируется' : 'Нет сигнала';
}

function setMeterReading(fill, reading) {
  if (!fill || !reading) return;
  if (fill.closest('.meter')) fill.style.height = `${reading.percent}%`;
  else fill.style.width = `${reading.percent}%`;
  fill.dataset.level = reading.zone;
  const meter = fill.closest('[role="meter"]');
  if (meter) {
    meter.setAttribute('aria-valuenow', String(reading.value));
    meter.setAttribute('aria-valuetext', reading.text);
    meter.title = reading.text;
  }
}

function clickMetronome(accent = false) {
  const context = getAudioContext(), oscillator = context.createOscillator(), gain = context.createGain(), now = context.currentTime;
  oscillator.type = 'sine'; oscillator.frequency.value = accent ? 1320 : 900; gain.gain.setValueAtTime(.001, now); gain.gain.exponentialRampToValueAtTime(accent ? .09 : .045, now + .004); gain.gain.exponentialRampToValueAtTime(.001, now + .055); oscillator.connect(gain); gain.connect(context.destination); oscillator.start(now); oscillator.stop(now + .06);
}

function buildNativeProjectPlan() {
  const native = window.sonoraNative;
  if (forceBrowserPlayback || !native?.stageAudioAsset || !native?.loadProject || !native?.playProject || state.metronome || !state.tracks.length) return null;
  if (nativeSynthCacheRevision !== nativeGraphRevision) { nativeSynthCache.clear(); nativeSynthCacheRevision = nativeGraphRevision; }
  const tracks = state.tracks.map(track => {
    const gainAutomation = flattenGainAutomation(track.clips.filter(clip => clip.kind === 'automation' && clip.target === 'volume'), track.volume ?? .8, state.tempo);
    const panAutomation = flattenGainAutomation(track.clips.filter(clip => clip.kind === 'automation' && clip.target === 'pan'), track.pan || 0, state.tempo, 48_000, -1, 1);
    if (!gainAutomation || !panAutomation) return null;
    return {
      gain: track.volume ?? 1, pan: track.pan || 0, mute: Boolean(track.mute), solo: Boolean(track.solo),
      reverb: Boolean(track.effects?.reverb), delay: Boolean(track.effects?.delay), gainAutomation, panAutomation,
      equalizer: Boolean(track.effects?.equalizer), compressor: Boolean(track.effects?.compressor), limiter: Boolean(track.effects?.limiter),
      ...Object.fromEntries(Object.entries(normalizeCompressorSettings(track.compressorSettings)).map(([key, value]) => [
        ({ thresholdDb: 'compressorThresholdDb', ratio: 'compressorRatio', attackMs: 'compressorAttackMs', releaseMs: 'compressorReleaseMs', makeupDb: 'compressorMakeupDb' })[key], value,
      ])),
      limiterCeilingDb: normalizeLimiterSettings(track.limiterSettings).ceilingDb,
      limiterReleaseMs: normalizeLimiterSettings(track.limiterSettings).releaseMs,
      equalizerFrequencyHz: Number(track.eqSettings?.frequencyHz ?? 1000), equalizerGainDb: Number(track.eqSettings?.gainDb ?? 0), equalizerQ: Number(track.eqSettings?.q ?? 1),
      equalizerBands: normalizeEqSettings(track.eqSettings).bands.flatMap(({ frequencyHz, gainDb, q }) => [frequencyHz, gainDb, q]),
    };
  });
  if (tracks.some(track => track === null)) return null;
  tracks.forEach((track, index) => {
    const busIndex = state.buses.findIndex(bus => bus.id === state.tracks[index].outputBusId);
    track.isBus = false;
    track.outputBusIndex = busIndex < 0 ? -1 : state.tracks.length + busIndex;
  });
  tracks.push(...state.buses.map(bus => ({
    gain: bus.volume ?? .8, pan: bus.pan || 0, mute: Boolean(bus.mute), solo: Boolean(bus.solo),
    reverb: Boolean(bus.effects?.reverb), delay: Boolean(bus.effects?.delay), gainAutomation: [], panAutomation: [],
    equalizer: Boolean(bus.effects?.equalizer), compressor: Boolean(bus.effects?.compressor), limiter: Boolean(bus.effects?.limiter),
    ...Object.fromEntries(Object.entries(normalizeCompressorSettings(bus.compressorSettings)).map(([key, value]) => [
      ({ thresholdDb: 'compressorThresholdDb', ratio: 'compressorRatio', attackMs: 'compressorAttackMs', releaseMs: 'compressorReleaseMs', makeupDb: 'compressorMakeupDb' })[key], value,
    ])),
    limiterCeilingDb: normalizeLimiterSettings(bus.limiterSettings).ceilingDb,
    limiterReleaseMs: normalizeLimiterSettings(bus.limiterSettings).releaseMs,
    equalizerFrequencyHz: Number(bus.eqSettings?.frequencyHz ?? 1000), equalizerGainDb: Number(bus.eqSettings?.gainDb ?? 0), equalizerQ: Number(bus.eqSettings?.q ?? 1),
    equalizerBands: normalizeEqSettings(bus.eqSettings).bands.flatMap(({ frequencyHz, gainDb, q }) => [frequencyHz, gainDb, q]),
    isBus: true, outputBusIndex: -1,
  })));
  const assets = new Map(), clips = [];
  let endBeat = 0, synthesizedFrames = 0;
  for (const [trackIndex, track] of state.tracks.entries()) {
    for (const clip of track.clips) {
      if (clip.kind === 'drums' || clip.kind === 'midi') {
        let buffer = nativeSynthCache.get(clip.id);
        if (!buffer) {
          const context = getAudioContext();
          const pcm = renderSequencedPcm(clip, {
            instrument: track.instrument || 'soft-keys', synthSettings: track.synthSettings, bpm: state.tempo, sampleRate: context.sampleRate,
            createDrumSample: kind => createSampleBuffer(kind, context).getChannelData(0),
          });
          if (!pcm) return null;
          buffer = context.createBuffer(1, pcm.length, context.sampleRate); buffer.getChannelData(0).set(pcm);
          nativeSynthCache.set(clip.id, buffer);
        }
        synthesizedFrames += buffer.length;
        if (synthesizedFrames > 24_000_000) return null;
        let nativeAssetId = nativeAssetIds.get(buffer);
        if (!nativeAssetId) { nativeAssetId = `native-asset-${++nativeAssetCounter}`; nativeAssetIds.set(buffer, nativeAssetId); }
        assets.set(nativeAssetId, { buffer });
        const startFrame = Math.round(clip.startBeat * beatSeconds() * 48_000);
        const durationFrames = Math.floor(buffer.duration * 48_000);
        if (!Number.isSafeInteger(startFrame) || startFrame < 0 || !Number.isSafeInteger(durationFrames) || durationFrames < 1) return null;
        endBeat = Math.max(endBeat, clip.startBeat + buffer.duration / beatSeconds());
        clips.push({ assetId: nativeAssetId, trackIndex, startFrame, sourceOffsetFrame: 0, durationFrames, playbackRate: 1, gain: 1, pan: 0 });
        continue;
      }
      const usesRendered = Boolean(clip.renderedAssetId && !clip.bypassProcessing);
      const assetId = usesRendered ? clip.renderedAssetId : clip.assetId;
      const asset = state.assets.get(assetId);
      if (!asset?.buffer) return null;

      const offsetSec = getClipSourceOffsetSec(clip);
      const trimEndSec = getClipSourceTrimEndSec(clip);
      const playbackRate = getClipPlaybackRate(clip, usesRendered);
      if (!Number.isFinite(playbackRate) || playbackRate < .01 || playbackRate > 8) return null;
      const availableSeconds = Math.max(0, asset.buffer.duration - offsetSec - trimEndSec);
      if (availableSeconds <= 0) continue;

      let nativeAssetId = nativeAssetIds.get(asset.buffer);
      if (!nativeAssetId) { nativeAssetId = `native-asset-${++nativeAssetCounter}`; nativeAssetIds.set(asset.buffer, nativeAssetId); }
      assets.set(nativeAssetId, asset);
      const startFrame = Math.round(clip.startBeat * beatSeconds() * 48_000);
      const sourceOffsetFrame = Math.round(offsetSec * 48_000);
      const timelineFrames = Math.round(clip.lengthBeats * beatSeconds() * 48_000);
      const sourceFrames = Math.floor(availableSeconds * 48_000 / playbackRate);
      const durationFrames = Math.min(timelineFrames, sourceFrames);
      if (![startFrame, sourceOffsetFrame, durationFrames].every(Number.isSafeInteger) || startFrame < 0 || sourceOffsetFrame < 0 || durationFrames < 1) return null;

      const durationBeats = durationFrames / 48_000 / beatSeconds();
      endBeat = Math.max(endBeat, clip.startBeat + durationBeats);
      const fades = normalizeClipFades(durationFrames / 48_000, clip.fadeInSec, clip.fadeOutSec);
      clips.push({ assetId: nativeAssetId, trackIndex, startFrame, sourceOffsetFrame, durationFrames, playbackRate, gain: clip.volume ?? 1, pan: clip.pan || 0,
        fadeInFrames: Math.round(fades.fadeInSec * 48_000), fadeOutFrames: Math.round(fades.fadeOutSec * 48_000),
        gainAutomation: clip.gainEnvelope ? clip.gainEnvelope.flatMap(point => [Math.round(point.position * durationFrames), point.gain]) : [] });
    }
  }
  if (!clips.length) return null;
  if (state.loop && state.loopEndBeat > endBeat) return null;
  const hasEffectClips = clips.some(clip => tracks[clip.trackIndex].reverb || tracks[clip.trackIndex].delay) ||
    (clips.length > 0 && state.buses.some(bus => bus.effects?.reverb || bus.effects?.delay));
  const playbackEndBeat = endBeat + (hasEffectClips ? 3 / beatSeconds() : 0);
  return { assets, graph: { masterGain: state.masterVolume, tracks, clips }, endBeat: playbackEndBeat };
}

async function prepareNativeProject(plan) {
  const revision = nativeGraphRevision;
  for (const [assetId, asset] of plan.assets) {
    if (nativeStagedAssets.has(asset.buffer)) continue;
    const bytes = new Uint8Array(encodeWav(asset.buffer));
    const result = await window.sonoraNative.stageAudioAsset(assetId, bytes);
    if (!result?.ok) throw new Error(result?.error || 'Не удалось подготовить аудио для WASAPI');
    nativeStagedAssets.add(asset.buffer);
  }
  if (revision !== nativeGraphRevision) throw new Error('Проект изменился во время подготовки аудио');
  if (nativeGraphDirty) {
    const loaded = await window.sonoraNative.loadProject(plan.graph);
    if (!loaded?.ok) throw new Error(loaded?.error || 'Нативный микшер отклонил проект');
    nativeStagedAssets = new WeakSet();
    if (revision !== nativeGraphRevision) throw new Error('Проект изменился во время построения микшера');
    for (const asset of plan.assets.values()) nativeStagedAssets.add(asset.buffer);
    nativeGraphDirty = false;
  }
  nativePlaybackEndBeat = plan.endBeat;
}

async function play() {
  if (state.playing) { pausePlayback(); return; }
  if (nativePlaybackPending) return;
  if (state.loop && (state.playheadBeat < state.loopStartBeat || state.playheadBeat >= state.loopEndBeat)) state.playheadBeat = state.loopStartBeat;
  lastMetronomeBeat = -1;
  const nativePlan = buildNativeProjectPlan();
  if (nativePlan) {
    nativePlaybackPending = true;
    const playButton = $('#playBtn'); playButton.disabled = true; playButton.setAttribute('aria-busy', 'true'); updateTransport();
    try {
      await prepareNativeProject(nativePlan);
      const startFrame = Math.round(state.playheadBeat * beatSeconds() * 48_000);
      const started = await window.sonoraNative.playProject(nativeOutputDeviceIndex, startFrame);
      if (!started?.ok) throw new Error(started?.error || 'Не удалось открыть выход WASAPI');
      nativePlaybackActive = true;
      state.playing = true; playStartBeat = state.playheadBeat; playStartTime = performance.now() / 1000;
      updateTransport(); playbackTick();
      return;
    } catch (error) {
      console.error(error);
      showToast(`WASAPI недоступен: ${error.message}. Воспроизведение переключено в браузер.`);
    } finally {
      nativePlaybackPending = false; playButton.disabled = false; playButton.removeAttribute('aria-busy'); updateTransport();
    }
  }

  const context = getAudioContext();
  state.playing = true; playStartBeat = state.playheadBeat; playStartTime = context.currentTime;
  const master = context.createGain(); master.gain.value = state.masterVolume; liveMasterGain = master;
  const meter = context.createAnalyser(); meter.fftSize = 256;
  const spectrum = context.createAnalyser(); spectrum.fftSize = 2048;
  master.connect(meter); meter.connect(spectrum); spectrum.connect(context.destination);
  masterAnalyser = meter; masterMeterBuffer = new Float32Array(meter.fftSize);
  masterSpectrumAnalyser = spectrum; masterSpectrumBuffer = new Float32Array(spectrum.frequencyBinCount);
  const destination = context.createGain(); destination.connect(master);
  scheduleProject(context, state.playheadBeat, destination);
  scheduledNodes.push({ stop: () => { try { master.disconnect(); meter.disconnect(); spectrum.disconnect(); destination.disconnect(); } catch {} } });
  updateTransport(); playbackTick();
}

function pausePlayback() {
  if (state.playing) {
    const elapsed = nativePlaybackActive ? performance.now() / 1000 - playStartTime : getAudioContext().currentTime - playStartTime;
    state.playheadBeat = playStartBeat + elapsed / beatSeconds();
  }
  stopPlayback(false); updatePosition();
}

function stopPlayback(reset = true) {
  state.playing = false; cancelAnimationFrame(playRAF);
  if (nativePlaybackActive) {
    const command = reset ? window.sonoraNative?.stopProject?.() : window.sonoraNative?.pauseProject?.();
    command?.catch(error => console.error('Native transport stop failed:', error));
    nativePlaybackActive = false;
  }
  for (const node of scheduledNodes) try { node.stop ? node.stop() : node.disconnect?.(); } catch {}
  scheduledNodes = []; liveTrackGains.clear(); liveTrackPans.clear(); liveTrackMeters.clear(); liveTrackMeterBuffers.clear(); liveTrackEqualizers.clear(); masterAnalyser = null; masterMeterBuffer = null; liveMasterGain = null;
  $$('#masterMeter, .meter i').forEach(fill => setMeterReading(fill, presentMeter(0, 0)));
  if (reset) { state.playheadBeat = 0; forceBrowserPlayback = false; }
  updateTransport(); updatePosition();
}

function deleteSelectedClip() { const { clip, track } = getClip(state.selectedClipId); if (!clip || !track) return; recordUndo(); track.clips = track.clips.filter(item => item.id !== clip.id); state.selectedClipId = null; renderAll(); showToast('Клип удалён'); }

function duplicateSelectedClip() {
  const { clip, track } = getClip(state.selectedClipId); if (!clip || !track) return;
  if (!canAddClip() || !canAddEvents(clipEventCount(clip))) return;
  recordUndo(); const copy = structuredClone(clip); copy.id = uid('clip'); copy.startBeat += clip.lengthBeats; track.clips.push(copy); state.selectedClipId = copy.id; renderAll(); showToast('Клип скопирован');
}

function importFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return Promise.resolve();
  const task = fileImportQueue.then(() => importFilesBatch(files));
  fileImportQueue = task.catch(() => {});
  return task;
}

async function importFilesBatch(files) {
  const status = $('#browserStatus'), button = $('#importBtn'), panel = $('.browser-panel');
  let imported = 0, failed = 0;
  button.disabled = true; button.setAttribute('aria-busy', 'true'); panel.setAttribute('aria-busy', 'true');
  try {
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      status.textContent = 'Импорт ' + (index + 1) + '/' + files.length + ': ' + file.name;
      if (file.size > MAX_AUDIO_FILE_BYTES) { failed++; showToast(file.name + ': размер превышает 256 МБ'); continue; }
      try {
        const context = getAudioContext(), bytes = await file.arrayBuffer(), buffer = await context.decodeAudioData(bytes.slice(0));
        const assetId = registerAsset(file.name.replace(/\.[^.]+$/, ''), buffer, { fileName: file.name, mime: file.type || 'audio/wav' });
        if (!assetId) { failed++; continue; }
        const asset = state.assets.get(assetId); asset.originalBytes = bytes; state.browserTab = 'project';
        addItemToProject({ id: assetId, name: file.name.replace(/\.[^.]+$/, '') }); imported++;
      } catch (error) { failed++; console.error(error); showToast('Не удалось открыть ' + file.name); }
    }
  } catch (error) {
    failed += files.length - imported; console.error(error); showToast('Не удалось подготовить аудио для импорта');
  } finally {
    button.disabled = false; button.removeAttribute('aria-busy'); panel.removeAttribute('aria-busy');
    status.textContent = imported ? 'Импортировано аудиофайлов: ' + imported : failed ? 'Импорт не выполнен — проверьте формат и размер файлов' : 'Звуки создаются локально';
  }
}

async function startRecording() {
  if (state.recording) { stopRecording(); return; }
  if (recordingPending) return;
  const channelMode = ['mono', 'left', 'right', 'stereo'].includes(state.recordChannelMode) ? state.recordChannelMode : 'mono';
  recordingChannelMode = channelMode;
  recordingStartBeat = state.playheadBeat; recordingTargetTrackId = state.recordingTargetTrackId;
  if (window.sonoraNative?.startCapture) {
    const deviceResponse = await window.sonoraNative.audioDevices().catch(() => null);
    nativeCaptureDevices = deviceResponse?.ok ? deviceResponse.devices?.capture || [] : [];
    if (nativeCaptureDevices.length) {
      recordingPending = true;
      const button = $('#recordBtn'); button.disabled = true; button.setAttribute('aria-busy', 'true'); button.title = 'Открытие входа WASAPI';
      const device = nativeCaptureDevices.find(item => item.index === nativeInputDeviceIndex) || nativeCaptureDevices.find(item => item.default) || nativeCaptureDevices[0];
      nativeInputDeviceIndex = device.index;
      const response = await window.sonoraNative.startCapture(device.index, state.sampleRate, channelMode).catch(error => ({ ok: false, error: error.message }));
      recordingPending = false; button.disabled = false; button.removeAttribute('aria-busy'); button.title = 'Остановить запись';
      if (!response?.ok) {
        button.title = 'Запись с микрофона';
        showToast(response?.error || 'Не удалось начать запись через WASAPI');
        return;
      }
      nativeRecordingActive = true;
      state.recording = true; $('#timelineScroll').classList.add('recording'); updateTransport();
      showToast('Идёт запись через WASAPI');
      return;
    }
  }
  if (!navigator.mediaDevices?.getUserMedia) { showToast('Запись доступна в Edge/Chrome на localhost'); return; }
  let context;
  try { context = getAudioContext(); } catch { showToast('В этом браузере нет поддержки Web Audio'); return; }
  recordingPending = true;
  const recordButton = $('#recordBtn'); recordButton.disabled = true; recordButton.setAttribute('aria-busy', 'true'); recordButton.title = 'Ожидание разрешения на доступ к микрофону';
  const requestedChannels = channelMode === 'mono' ? 1 : 2;
  const audioConstraints = { channelCount: { ideal: requestedChannels } };
  if (state.inputDeviceId) audioConstraints.deviceId = { exact: state.inputDeviceId };
  const constraints = { audio: audioConstraints };
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    try {
      recordingWorkletReady ??= context.audioWorklet.addModule(new URL('./record-worklet.js', document.baseURI).href);
      await recordingWorkletReady;
    } catch (error) {
      recordingWorkletReady = undefined;
      stream.getTracks().forEach(track => track.stop());
      throw error;
    }
    recordingPending = false; recordButton.disabled = false; recordButton.removeAttribute('aria-busy'); recordButton.title = 'Остановить запись';
    recordingStream = stream; recordingChunks = [];
    recordAnalyser = context.createAnalyser(); recordInput = context.createMediaStreamSource(stream); recordInput.connect(recordAnalyser);
    recordProcessor = new AudioWorkletNode(context, 'sonora-record-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [requestedChannels],
      processorOptions: { channelMode },
    });
    recordProcessor.port.onmessage = event => {
      if ((state.recording || recordingStopping) && event.data instanceof Float32Array) recordingChunks.push(event.data);
      else if ((state.recording || recordingStopping) && event.data?.type === 'audio' && Array.isArray(event.data.channels)) recordingChunks.push(event.data.channels);
      else if (event.data?.type === 'stopped') recordingStopResolver?.();
    };
    const silent = context.createGain(); silent.gain.value = 0; recordInput.connect(recordProcessor); recordProcessor.connect(silent); silent.connect(context.destination); recordProcessor._silent = silent;
    state.recording = true; $('#timelineScroll').classList.add('recording'); updateTransport(); showToast('Идёт запись микрофона'); animateInputMeter();
  } catch (error) {
    recordingPending = false; recordButton.disabled = false; recordButton.removeAttribute('aria-busy'); recordButton.title = 'Запись с микрофона';
    console.error(error);
    showToast(error.name === 'NotAllowedError' ? 'Разрешите доступ к микрофону в настройках Windows и приложения' : error.name === 'NotFoundError' ? 'Не найдено аудиоустройство ввода' : error.name === 'NotReadableError' ? 'Микрофон занят другим приложением' : error.name === 'SecurityError' ? 'Запись требует безопасного локального адреса приложения' : error.name === 'NotSupportedError' ? 'AudioWorklet не поддерживается этим браузером' : 'Не удалось открыть выбранное аудиоустройство');
  }
}
let recordingStartBeat = 0;
function setRecording(value) { state.recording = value; updateTransport(); }
async function stopRecording() {
  if (!state.recording || recordingStopping) return;
  recordingStopping = true;
  if (nativeRecordingActive) {
    state.recording = false; updateTransport();
    const result = await window.sonoraNative.stopCapture().catch(error => ({ ok: false, error: error.message }));
    nativeRecordingActive = false;
    if (!result?.ok) showToast(result?.error || 'Не удалось завершить запись WASAPI');
    else if (result.frames > 0 && result.wav) {
      try {
        const audioContext = getAudioContext();
        const wav = result.wav instanceof ArrayBuffer ? result.wav : result.wav.buffer.slice(result.wav.byteOffset, result.wav.byteOffset + result.wav.byteLength);
        const buffer = await audioContext.decodeAudioData(wav);
        attachRecordedBuffer(buffer);
        if (result.droppedFrames) showToast(`Запись добавлена, потеряно кадров: ${result.droppedFrames}`);
        else if (result.limitReached) showToast('Достигнут лимит записи 256 МиБ');
      } catch (error) {
        console.error(error); showToast('Не удалось открыть WAV после записи WASAPI');
      }
    } else showToast('Вход не передал аудиоданные');
    recordingStopping = false; setRecording(false); renderAll();
    return;
  }
  const processor = recordProcessor;
  if (processor) {
    await new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        recordingStopResolver = null;
        resolve();
      };
      recordingStopResolver = finish;
      const timeout = setTimeout(finish, 200);
      processor.port.postMessage('stop');
    });
  }
  state.recording = false;
  const context = getAudioContext(), channelCount = recordingChannelMode === 'stereo' ? 2 : 1;
  const count = recordingChunks.reduce((sum, chunk) => sum + (Array.isArray(chunk) ? chunk[0]?.length || 0 : chunk.length), 0);
  const buffer = context.createBuffer(channelCount, Math.max(1, count), context.sampleRate);
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
    const destination = buffer.getChannelData(channelIndex); let cursor = 0;
    for (const chunk of recordingChunks) {
      const samples = Array.isArray(chunk) ? chunk[Math.min(channelIndex, chunk.length - 1)] : chunk;
      if (!samples) continue;
      destination.set(samples, cursor); cursor += samples.length;
    }
  }
  try { recordProcessor?.port?.postMessage('stop'); recordInput?.disconnect(); recordProcessor?.disconnect(); recordProcessor?._silent?.disconnect(); recordProcessor?.port?.close(); } catch {}
  recordStreamCleanup();
  if (count > 0) attachRecordedBuffer(buffer);
  recordingStopping = false; setRecording(false); renderAll();
}
function attachRecordedBuffer(buffer) {
  const name = `Запись ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  let track = recordingTargetTrackId === 'new' ? null : getTrack(recordingTargetTrackId);
  if (!track || track.type !== 'audio') {
    if (!canAddTrack()) return;
    const palette = themePalette();
    track = { id: uid('track'), name: 'Запись', type: 'audio', color: palette[state.tracks.length % palette.length], volume: .8, pan: 0, mute: false, solo: false, clips: [] };
  }
  if (!canAddClip() || !canStoreAudioAsset(buffer, null, false)) { showToast('Запись не добавлена: достигнут лимит размера проекта'); return; }
  recordUndo(); const id = registerAsset(name, buffer, { source: 'recording', fileName: `${name}.wav`, mime: 'audio/wav' });
  if (!id) return;
  state.recordings.unshift(id);
  if (!state.tracks.some(item => item.id === track.id)) state.tracks.push(track);
  const clip = { id: uid('clip'), name, assetId: id, startBeat: recordingStartBeat, lengthBeats: buffer.duration / beatSeconds(), offsetSec: 0, trimEndSec: 0, pitch: 0, volume: 1, pan: 0, color: track.color };
  track.clips.push(clip); state.selectedClipId = clip.id; state.selectedTrackId = track.id; state.browserTab = 'recordings'; showToast('Запись добавлена на шкалу');
}
function recordStreamCleanup() { recordingStream?.getTracks().forEach(track => track.stop()); recordingStream = null; recordAnalyser = null; recordInput = null; recordProcessor = null; recordingChunks = []; }
function animateInputMeter() {
  if (!state.recording || !recordAnalyser) return;
  if (!recordMeterBuffer || recordMeterBuffer.length !== recordAnalyser.fftSize) recordMeterBuffer = new Float32Array(recordAnalyser.fftSize);
  recordAnalyser.getFloatTimeDomainData(recordMeterBuffer);
  setMeterReading($('#masterMeter'), analyzeMeter(recordMeterBuffer));
  requestAnimationFrame(animateInputMeter);
}

async function showAudioSettings() {
  const content = $('#modalContent'); content.innerHTML = '<div style="color:#9099a5;font-size:11px">Получаю список устройств…</div>'; openModal();
  const nativeDevicesPromise = window.sonoraNative?.audioDevices?.().catch(() => null) ?? Promise.resolve(null);
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch {}
  const nativeResult = await nativeDevicesPromise;
  const inputs = devices.filter(device => device.kind === 'audioinput'), outputs = devices.filter(device => device.kind === 'audiooutput');
  content.innerHTML = '';
  content.append(createThemeSettings());
  if (window.sonoraNative?.audioDevices) content.append(await nativeAudioSettings(nativeResult));
  content.append(deviceSelect('Микрофон браузера · Edge/Chrome', inputs, state.inputDeviceId, 'inputSelect'));
  content.append(deviceSelect('Устройство вывода', outputs, state.outputDeviceId, 'outputSelect'));
  const sampleRateRow = document.createElement('label'); sampleRateRow.className = 'device-row';
  const sampleRateLabel = document.createElement('span'); sampleRateLabel.textContent = 'Частота дискретизации'; sampleRateRow.append(sampleRateLabel);
  const sampleRateSelect = document.createElement('select'); sampleRateSelect.id = 'sampleRateSelect'; sampleRateSelect.setAttribute('aria-label', 'Частота дискретизации');
  for (const rate of SAMPLE_RATES) { const option = document.createElement('option'); option.value = String(rate); option.textContent = `${rate / 1000} кГц`; option.selected = rate === state.sampleRate; sampleRateSelect.append(option); }
  sampleRateRow.append(sampleRateSelect); content.append(sampleRateRow);
  const channelRow = document.createElement('label'); channelRow.className = 'device-row';
  const channelLabel = document.createElement('span'); channelLabel.textContent = 'Канал записи'; channelRow.append(channelLabel);
  const channelSelect = document.createElement('select'); channelSelect.id = 'recordChannelSelect'; channelSelect.setAttribute('aria-label', 'Канал записи');
  for (const [value, label] of [['mono', 'Моно · сведение каналов'], ['left', 'Левый канал'], ['right', 'Правый канал'], ['stereo', 'Стерео']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; option.selected = state.recordChannelMode === value; channelSelect.append(option);
  }
  channelRow.append(channelSelect); content.append(channelRow);
  const targetRow = document.createElement('label'); targetRow.className = 'device-row';
  const targetLabel = document.createElement('span'); targetLabel.textContent = 'Записывать на'; targetRow.append(targetLabel);
  const targetSelect = document.createElement('select'); targetSelect.id = 'recordTargetSelect'; targetSelect.setAttribute('aria-label', 'Дорожка для записи');
  const newTrackOption = document.createElement('option'); newTrackOption.value = 'new'; newTrackOption.textContent = 'Новая аудиодорожка'; targetSelect.append(newTrackOption);
  const audioTracks = state.tracks.filter(track => track.type === 'audio');
  for (const track of audioTracks) { const option = document.createElement('option'); option.value = track.id; option.textContent = track.name; targetSelect.append(option); }
  if (!audioTracks.some(track => track.id === state.recordingTargetTrackId)) state.recordingTargetTrackId = audioTracks.find(track => track.id === state.selectedTrackId)?.id || audioTracks[0]?.id || 'new';
  targetSelect.value = state.recordingTargetTrackId; targetRow.append(targetSelect); content.append(targetRow);
  const note = document.createElement('p'); note.className = 'modal-footnote'; note.textContent = outputs.length || (nativeResult?.devices?.capture?.length || 0)
    ? `Браузерный ввод и вывод используют ${audioContext?.sampleRate || state.sampleRate} Гц; WASAPI запись следует выбранной частоте, воспроизведение проекта пока фиксировано на 48 кГц.`
    : 'Браузер пока не сообщил аудиоустройства. Для списка микрофонов сначала разрешите доступ к микрофону.'; content.append(note);
  const rescan = document.createElement('button'); rescan.className = 'button quiet'; rescan.textContent = 'Обновить список'; rescan.onclick = showAudioSettings; content.append(rescan);
  $('#inputSelect').onchange = event => { state.inputDeviceId = event.target.value; saveAudioPreferences(); };
  sampleRateSelect.onchange = async event => {
    const previousRate = state.sampleRate;
    const changed = await changeSampleRate(Number(event.target.value));
    if (!changed) sampleRateSelect.value = String(previousRate);
    note.textContent = `Браузерный ввод и вывод используют ${audioContext?.sampleRate || state.sampleRate} Гц; WASAPI запись следует выбранной частоте, воспроизведение проекта пока фиксировано на 48 кГц.`;
  };
  targetSelect.onchange = event => { state.recordingTargetTrackId = event.target.value; };
  channelSelect.onchange = event => { state.recordChannelMode = event.target.value; saveAudioPreferences(); };
  $('#outputSelect').onchange = async event => { state.outputDeviceId = event.target.value; saveAudioPreferences(); const ctx = getAudioContext(); if (ctx.setSinkId) { try { await ctx.setSinkId(event.target.value); showToast('Устройство вывода изменено'); } catch { showToast('Браузер не разрешил сменить устройство'); } } else showToast('В этой версии браузера выбор выхода недоступен'); };
}

function createThemeSettings() {
  const section = document.createElement('section'); section.className = 'appearance-settings';
  section.setAttribute('aria-labelledby', 'appearanceTitle');
  const heading = document.createElement('div'); heading.className = 'appearance-heading';
  heading.innerHTML = '<div><span class="eyebrow">ВНЕШНИЙ ВИД</span><h3 id="appearanceTitle">Тема интерфейса</h3></div>';
  const choices = document.createElement('div'); choices.className = 'theme-choices'; choices.setAttribute('role', 'radiogroup'); choices.setAttribute('aria-label', 'Цветовая тема');
  for (const theme of THEMES) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'theme-choice';
    button.setAttribute('role', 'radio'); button.dataset.themeChoice = theme.id;
    button.setAttribute('aria-checked', String(selectedTheme === theme.id)); button.tabIndex = selectedTheme === theme.id ? 0 : -1;
    button.setAttribute('aria-label', `${theme.name}, ${theme.note}`);
    const swatches = document.createElement('span'); swatches.className = 'theme-swatches'; swatches.setAttribute('aria-hidden', 'true');
    for (const color of theme.colors) { const swatch = document.createElement('i'); swatch.style.backgroundColor = color; swatches.append(swatch); }
    const label = document.createElement('span'); label.className = 'theme-choice-copy';
    const name = document.createElement('strong'); name.textContent = theme.name;
    const note = document.createElement('small'); note.textContent = theme.note;
    label.append(name, note); button.append(swatches, label);
    button.addEventListener('click', () => setTheme(theme.id));
    button.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const index = THEMES.findIndex(item => item.id === theme.id);
      const direction = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1;
      const next = THEMES[(index + direction + THEMES.length) % THEMES.length];
      setTheme(next.id); $(`[data-theme-choice="${next.id}"]`, choices)?.focus();
    });
    choices.append(button);
  }
  const footer = document.createElement('div'); footer.className = 'appearance-footer';
  const detail = document.createElement('p'); detail.textContent = 'Выбор применяется сразу и сохраняется на этом компьютере.';
  const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'button quiet compact'; reset.textContent = 'По умолчанию'; reset.setAttribute('aria-label', 'Восстановить тему Dark Rose'); reset.onclick = () => setTheme('dark-rose');
  footer.append(detail, reset); section.append(heading, choices, footer); return section;
}

function setTheme(themeId) {
  selectedTheme = normalizeTheme(themeId);
  document.documentElement.dataset.theme = selectedTheme;
  const themeColor = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor || '#171319');
  try { localStorage.setItem(THEME_KEY, selectedTheme); } catch {}
  $$('.theme-choice').forEach(button => {
    const selected = button.dataset.themeChoice === selectedTheme;
    button.setAttribute('aria-checked', String(selected)); button.tabIndex = selected ? 0 : -1;
  });
}
async function nativeAudioSettings(result) {
  const panel = document.createElement('section'); panel.className = 'native-engine-panel';
  const title = document.createElement('h3'); title.textContent = 'Нативный аудиодвижок · WASAPI'; panel.append(title);
  const status = document.createElement('p'); status.className = 'native-engine-status'; status.setAttribute('role', 'status'); panel.append(status);
  const capture = result?.ok ? result.devices?.capture || [] : [];
  nativeCaptureDevices = capture;
  const inputRow = document.createElement('label'); inputRow.className = 'device-row';
  const inputLabel = document.createElement('span'); inputLabel.textContent = 'Микрофон WASAPI'; inputRow.append(inputLabel);
  const inputSelect = document.createElement('select'); inputSelect.setAttribute('aria-label', 'Устройство записи WASAPI'); inputRow.append(inputSelect); panel.append(inputRow);
  capture.forEach((device, index) => {
    const option = document.createElement('option'); option.value = String(device.index);
    option.textContent = `${device.name}${device.default ? ' · по умолчанию' : ''}`;
    option.selected = device.index === nativeInputDeviceIndex || device.default || index === 0; inputSelect.append(option);
  });
  if (capture.length) {
    const preferred = capture.find(device => device.index === nativeInputDeviceIndex) || capture.find(device => device.default) || capture[0];
    nativeInputDeviceIndex = preferred.index; inputSelect.value = String(preferred.index);
  } else {
    const option = document.createElement('option'); option.value = ''; option.textContent = 'WASAPI-входы не найдены'; inputSelect.append(option); inputSelect.disabled = true;
  }
  inputSelect.addEventListener('change', () => {
    if (!Number.isInteger(Number(inputSelect.value))) return;
    nativeInputDeviceIndex = Number(inputSelect.value); saveAudioPreferences();
  });
  const selectRow = document.createElement('label'); selectRow.className = 'device-row';
  const selectLabel = document.createElement('span'); selectLabel.textContent = 'Устройство для проверки'; selectRow.append(selectLabel);
  const select = document.createElement('select'); select.setAttribute('aria-label', 'Устройство вывода WASAPI'); selectRow.append(select); panel.append(selectRow);

  const playback = result?.ok ? result.devices?.playback || [] : [];
  playback.forEach((device, index) => {
    const option = document.createElement('option'); option.value = String(device.index);
    option.textContent = `${device.name}${device.default ? ' · по умолчанию' : ''}`;
    option.selected = device.index === nativeOutputDeviceIndex || device.default || index === 0; select.append(option);
  });
  if (playback.length) {
    const preferred = playback.find(device => device.index === nativeOutputDeviceIndex) || playback.find(device => device.default) || playback[0];
    nativeOutputDeviceIndex = preferred.index;
    select.value = String(preferred.index);
  }
  select.addEventListener('change', () => { if (Number.isInteger(Number(select.value))) nativeOutputDeviceIndex = Number(select.value); });
  if (!playback.length) {
    const option = document.createElement('option'); option.value = ''; option.textContent = 'Устройства вывода не найдены'; select.append(option); select.disabled = true;
  }

  const controls = document.createElement('div'); controls.className = 'native-engine-actions';
  const playButton = document.createElement('button'); playButton.className = 'button quiet'; playButton.textContent = 'Проверить звук · 440 Гц'; playButton.disabled = !playback.length;
  const stopButton = document.createElement('button'); stopButton.className = 'button quiet'; stopButton.textContent = 'Остановить сигнал'; stopButton.hidden = true;
  controls.append(playButton, stopButton); panel.append(controls);

  const note = document.createElement('p'); note.className = 'native-engine-note';
  note.textContent = 'Запись WASAPI работает при наличии входного устройства; файл создаётся локально, лимит — 256 МиБ. MIDI и ударные рендерятся в PCM для WASAPI; метроном использует браузерный аудиослой.';
  panel.append(note);

  if (!result?.ok) status.textContent = result?.error || 'Нативный аудиодвижок недоступен. Пересоберите приложение с native:build.';
  else {
    const nativeStatus = await window.sonoraNative.audioStatus().catch(() => null);
    const captureCount = result.devices?.capture?.length || 0;
    status.textContent = `${playback.length} устройств вывода WASAPI; устройств записи: ${captureCount}. ${nativeStatus?.ok ? `Частота движка: ${nativeStatus.status.sampleRate} Гц.` : ''}`;
  }

  playButton.onclick = async () => {
    playButton.disabled = true;
    const response = await window.sonoraNative.startTestTone(Number(select.value)).catch(() => ({ ok: false }));
    playButton.disabled = false;
    if (response?.ok) {
      nativeToneActive = true; playButton.hidden = true; stopButton.hidden = false;
      status.textContent = 'Воспроизводится тестовый сигнал 440 Гц (0,5 секунды). Закройте окно, чтобы также освободить аудиоустройство.';
    } else status.textContent = response?.error || 'Не удалось запустить аудиоустройство.';
  };
  stopButton.onclick = async () => {
    stopButton.disabled = true;
    const response = await window.sonoraNative.stopTestTone().catch(() => ({ ok: false }));
    nativeToneActive = false; stopButton.disabled = false; stopButton.hidden = true; playButton.hidden = false;
    status.textContent = response?.ok ? 'Тестовый сигнал остановлен.' : response?.error || 'Сигнал остановлен.';
  };
  return panel;
}
function deviceSelect(label, devices, selected, id) {
  const wrap = document.createElement('label'); wrap.className = 'device-row'; const name = document.createElement('span'); name.textContent = label; wrap.append(name);
  const select = document.createElement('select'); select.id = id; select.innerHTML = `<option value="">По умолчанию</option>`;
  devices.forEach((device, index) => { const option = document.createElement('option'); option.value = device.deviceId; option.textContent = device.label || `${label} ${index + 1}`; option.selected = selected && selected === device.deviceId; select.append(option); });
  if (!devices.length) select.disabled = true; wrap.append(select); return wrap;
}

function openModal() {
  if ($('#modalBackdrop').hidden) modalReturnFocus = document.activeElement;
  $('#modalBackdrop').hidden = false; $('#modalBackdrop .modal').focus();
}

function closeModal() {
  if (nativeToneActive && window.sonoraNative?.stopTestTone) {
    nativeToneActive = false;
    window.sonoraNative.stopTestTone().catch(() => {});
  }
  $('#modalBackdrop').hidden = true;
  const target = modalReturnFocus; modalReturnFocus = null;
  if (target?.isConnected) target.focus();
}

function serializeProject() {
  const assets = [];
  for (const asset of state.assets.values()) assets.push({ id: asset.id, name: asset.name, source: asset.source, type: asset.type, fileName: asset.fileName, mime: asset.mime, wav: bufferToBase64(asset.buffer) });
  return createProjectDocument(state, assets);
}

function bufferToBase64(buffer) {
  const wav = encodeWav(buffer), bytes = new Uint8Array(wav), chunk = 0x8000; let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function encodeWav(buffer) {
  const channels = Math.min(2, buffer.numberOfChannels), sampleRate = buffer.sampleRate, samples = buffer.length, bytes = 44 + samples * channels * 2, out = new ArrayBuffer(bytes), view = new DataView(out);
  const write = (offset, text) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, bytes - 8, true); write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, bytes - 44, true);
  const channelData = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel)); let offset = 44;
  for (let i = 0; i < samples; i++) for (let channel = 0; channel < channels; channel++) { const value = clamp(channelData[channel][i], -1, 1); view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true); offset += 2; }
  return out;
}

function saveProject() {
  try {
    const data = JSON.stringify(serializeProject()), blob = new Blob([data], { type: 'application/json' });
    if (blob.size > MAX_PROJECT_FILE_BYTES) { showToast('Файл проекта превышает лимит 256 МиБ'); return; }
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `${safeFilename(state.name)}.sonora`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); $('#saveState').textContent = '● Сохранено'; showToast('Проект сохранён в файл .sonora');
  } catch (error) { console.error(error); showToast('Не удалось сохранить проект: файл слишком большой'); }
}

async function loadProject(file) {
  try {
    if (file.size > MAX_PROJECT_FILE_BYTES) throw new Error('project-too-large');
    const data = JSON.parse(await file.text()), validation = validateProjectDocument(data);
    if (!validation.ok) throw new Error(`project-${validation.code}`);
    const context = getAudioContext(), assets = new Map();
    for (const source of data.assets || []) {
      const encoded = source.wav; delete source.wav;
      const binary = atob(encoded), bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const buffer = await context.decodeAudioData(bytes.buffer);
      assets.set(source.id, { ...source, buffer });
    }
    clearBrowserSelection();
    const palette = themePalette();
    state.assets = assets; state.name = data.name || 'Новый проект'; state.tempo = clamp(data.tempo || 120, 40, 240); state.key = data.key || 'До мажор'; state.masterVolume = data.masterVolume ?? .82;
    state.tracks = data.tracks.map((track, index) => {
      const instrument = INSTRUMENTS.some(item => item.id === track.instrument) ? track.instrument : 'soft-keys';
      return { ...track, name: track.name || `Дорожка ${index + 1}`, color: /^#[\da-f]{6}$/i.test(track.color || '') ? track.color : palette[index % palette.length],
        volume: Number.isFinite(track.volume) ? clamp(track.volume, 0, 1.5) : .8, pan: Number.isFinite(track.pan) ? clamp(track.pan, -1, 1) : 0,
        mute: Boolean(track.mute), solo: Boolean(track.solo), effects: { reverb: Boolean(track.effects?.reverb), delay: Boolean(track.effects?.delay), equalizer: Boolean(track.effects?.equalizer), compressor: Boolean(track.effects?.compressor), limiter: Boolean(track.effects?.limiter) },
        compressorSettings: normalizeCompressorSettings(track.compressorSettings), limiterSettings: normalizeLimiterSettings(track.limiterSettings), eqSettings: normalizeEqSettings(track.eqSettings),
        ...(track.type === 'instrument' ? { instrument, synthSettings: normalizeSynthSettings(track.synthSettings, instrument) } : {}) };
    });
    state.buses = (data.buses || []).map((bus, index) => ({ ...bus, name: bus.name || `Шина ${index + 1}`, color: /^#[\da-f]{6}$/i.test(bus.color || '') ? bus.color : palette[(state.tracks.length + index) % palette.length], volume: Number.isFinite(bus.volume) ? clamp(bus.volume, 0, 1.5) : .8, pan: Number.isFinite(bus.pan) ? clamp(bus.pan, -1, 1) : 0, mute: Boolean(bus.mute), solo: Boolean(bus.solo), effects: { reverb: Boolean(bus.effects?.reverb), delay: Boolean(bus.effects?.delay), equalizer: Boolean(bus.effects?.equalizer), compressor: Boolean(bus.effects?.compressor), limiter: Boolean(bus.effects?.limiter) }, compressorSettings: normalizeCompressorSettings(bus.compressorSettings), limiterSettings: normalizeLimiterSettings(bus.limiterSettings), eqSettings: normalizeEqSettings(bus.eqSettings) }));
    state.markers = data.markers || []; state.loop = Boolean(data.loop); const loopRange = normalizeLoopRange(data.loopStartBeat ?? 0, data.loopEndBeat ?? 16); state.loopStartBeat = loopRange?.startBeat ?? 0; state.loopEndBeat = loopRange?.endBeat ?? 16; state.selectedClipId = null; state.playheadBeat = 0; state.recordings = [...assets.values()].filter(asset => asset.source === 'recording').map(asset => asset.id); state.undoStack = []; state.redoStack = []; state.selectedTrackId = state.tracks.find(track => track.id === data.selectedTrackId)?.id || state.tracks[0]?.id || null; markProjectDirty(); renderAll(); $('#saveState').textContent = '● Сохранено'; showToast('Проект открыт');
  } catch (error) {
    console.error(error);
    const messages = {
      'project-too-large': 'Файл проекта превышает лимит 256 МиБ',
      'project-audio-memory-limit': 'Проект слишком велик для безопасной загрузки аудио в память',
      'project-too-many-tracks': 'В проекте превышен лимит дорожек (128)',
      'project-too-many-assets': 'В проекте превышен лимит аудиофайлов (512)',
      'project-too-many-clips': 'В проекте превышен лимит клипов (8192)',
      'project-too-many-events': 'В MIDI или ритм-партиях слишком много событий',
    };
    showToast(messages[error.message] || 'Файл проекта повреждён или не поддерживается');
  }
}

function safeFilename(name) { return (name || 'sonora-project').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim() || 'sonora-project'; }
function escapeHtml(text) { const element = document.createElement('span'); element.textContent = text; return element.innerHTML; }

function exportProject() {
  const seconds = projectRenderDurationSeconds(state.tracks, state.tempo);
  if (!seconds) { showToast('В проекте есть клип с некорректной длительностью'); return; }
  const sampleRate = 44100, offline = new OfflineAudioContext(2, seconds * sampleRate, sampleRate), master = offline.createGain(); master.gain.value = state.masterVolume; master.connect(offline.destination);
  const destination = offline.createGain(); destination.connect(master); const liveScheduled = scheduledNodes; scheduledNodes = []; scheduleProject(offline, 0, destination); scheduledNodes = liveScheduled;
  offline.startRendering().then(buffer => {
    const blob = new Blob([encodeWav(buffer)], { type: 'audio/wav' }), url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `${safeFilename(state.name)}.wav`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 2500); showToast('WAV-микс экспортирован');
  }).catch(error => { console.error(error); showToast('Не удалось выполнить рендер WAV'); });
}

function openAbout() {
  $('#modalTitle').textContent = 'О проекте'; openModal();
  $('#modalContent').innerHTML = '<p style="color:#bbc1ca;font-size:11px;line-height:1.65">SONORA Studio — локальная музыкальная студия для Windows и браузера. Звук создаётся и обрабатывается на устройстве; файлы проекта и аудио остаются на вашем компьютере.</p><p class="modal-footnote">Работают: импорт аудио, аранжировка, перекрывающееся воспроизведение, пошаговый секвенсор, простая MIDI-партия, запись через WASAPI при наличии входного устройства (иначе через браузер), моно/стерео запись, проекты .sonora, WAV-экспорт, изменение высоты и скорости клипа, сравнение обработанного звука с оригиналом, базовый автотюн монофонического материала, регулировка уровня и панорамы клипа, реверберация и задержка на дорожках. Нативный WASAPI-микшер воспроизводит аудио, MIDI и ударные; MIDI и ударные заранее рендерятся в PCM-клипы, метроном использует браузерный аудиослой. Пока отсутствуют: плагины VST3/CLAP, внешние MIDI-устройства и параметрический эквалайзер.</p>';
}

function setInspectorOpen(open) {
  inspectorOpen = Boolean(open);
  const compact = window.matchMedia('(max-width: 900px)').matches;
  const workspace = $('#workspace');
  workspace.classList.toggle('inspector-open', compact && inspectorOpen);
  workspace.classList.toggle('inspector-collapsed', !compact && !inspectorOpen);
  $('#inspectorToggleBtn').setAttribute('aria-expanded', String(inspectorOpen));
  $('#inspectorToggleBtn').setAttribute('aria-label', inspectorOpen ? 'Свернуть инспектор' : 'Развернуть инспектор');
  $('#inspectorToggleBtn').title = inspectorOpen ? 'Свернуть инспектор' : 'Развернуть инспектор';
  $('#inspectorScrim').hidden = !(compact && inspectorOpen);
}

function setupEvents() {
  inspectorOpen = !window.matchMedia('(max-width: 900px)').matches;
  setInspectorOpen(inspectorOpen);
  window.addEventListener('resize', () => setInspectorOpen(inspectorOpen));
  $('#inspectorToggleBtn').onclick = () => setInspectorOpen(!inspectorOpen);
  $('#closeInspectorBtn').onclick = () => { setInspectorOpen(false); $('#inspectorToggleBtn').focus(); };
  $('#inspectorScrim').onclick = () => { setInspectorOpen(false); $('#inspectorToggleBtn').focus(); };
  $('#playBtn').onclick = play; $('#stopBtn').onclick = () => stopPlayback(true); $('#recordBtn').onclick = startRecording;
  $('#undoBtn').onclick = () => applyHistory(state.redoStack, state.undoStack); $('#redoBtn').onclick = () => applyHistory(state.undoStack, state.redoStack);
  $('#tempoInput').onchange = event => { recordUndo(); state.tempo = clamp(Number(event.target.value) || 120, 40, 240); event.target.value = state.tempo; markProjectDirty(); renderTimeline(); };
  $('#keySelect').onchange = event => { recordUndo(); state.key = event.target.value; };
  $('#projectName').oninput = event => { if (event.target.value.length > 256) event.target.value = event.target.value.slice(0, 256); state.name = event.target.value; markProjectDirty(); };
  $('#projectName').addEventListener('focus', recordUndo, { once: true });
  $('#masterVolume').oninput = event => { state.masterVolume = Number(event.target.value); markProjectDirty(); $('#masterStripVolume') && ($('#masterStripVolume').value = state.masterVolume); if (liveMasterGain) liveMasterGain.gain.setTargetAtTime(state.masterVolume, getAudioContext().currentTime, .015); if (nativePlaybackActive) restartPlaybackIfActive(); };
  $('#masterVolume').addEventListener('focus', recordUndo, { once: true });
  $('#loopBtn').onclick = () => { const wasPlaying = state.playing; recordUndo(); state.loop = !state.loop; if (wasPlaying) stopPlayback(false); if (state.loop && (state.playheadBeat < state.loopStartBeat || state.playheadBeat >= state.loopEndBeat)) state.playheadBeat = state.loopStartBeat; renderLoopRegion(); updateLoopControl(); updatePosition(); if (wasPlaying) play(); showToast(state.loop ? `Цикл включён: A–B ${loopRangeLabel()}` : 'Цикл выключен'); };
  $('#metronomeBtn').onclick = () => { state.metronome = !state.metronome; $('#metronomeBtn').setAttribute('aria-pressed', state.metronome); if (state.metronome && !state.playing) clickMetronome(true); showToast(state.metronome ? 'Метроном включён' : 'Метроном выключен'); };
  $('#importBtn').onclick = () => $('#audioFiles').click(); $('#audioFiles').onchange = event => { importFiles(event.target.files); event.target.value = ''; };
  $('#searchInput').oninput = renderBrowser;
  $$('.browser-tab').forEach(button => { button.onclick = () => { if (state.browserTab !== button.dataset.tab) clearBrowserSelection(); state.browserTab = button.dataset.tab; renderBrowser(); }; button.addEventListener('keydown', event => moveRovingTab(event, '.browser-tab')); });
  $$('.view-tab').forEach(button => { button.onclick = () => { state.view = button.dataset.view; renderEditor(); }; button.addEventListener('keydown', event => moveRovingTab(event, '.view-tab')); });
  $('#addTrackBtn').onclick = () => { const track = addTrack('audio'); if (track) showToast(`${track.name} добавлена`); };
  $('#addAutomationBtn').onclick = () => createAutomationClip('volume');
  $('#addPanAutomationBtn').onclick = () => createAutomationClip('pan');
  $('#trackMenuBtn').onclick = () => { const choice = prompt('Тип дорожки: 1 — аудио, 2 — ритм, 3 — инструмент', '1'); addTrack(choice === '2' ? 'drums' : choice === '3' ? 'instrument' : 'audio'); };
  $('#zoomInput').oninput = event => { state.zoom = Number(event.target.value); document.documentElement.style.setProperty('--bar', `${state.zoom}px`); renderTimeline(); };
  $('#followPlayheadBtn').onclick = event => { followPlayhead = !followPlayhead; event.currentTarget.classList.toggle('selected', followPlayhead); event.currentTarget.setAttribute('aria-pressed', String(followPlayhead)); };
  $('#splitTool').onclick = event => { splitMode = !splitMode; event.currentTarget.classList.toggle('selected', splitMode); $('#selectTool').classList.toggle('selected', !splitMode); event.currentTarget.setAttribute('aria-pressed', String(splitMode)); $('#selectTool').setAttribute('aria-pressed', String(!splitMode)); showToast(splitMode ? 'Нажмите на клип, чтобы разделить его у курсора' : 'Режим разделения выключен'); };
  $('#selectTool').onclick = () => { splitMode = false; $('#splitTool').classList.remove('selected'); $('#selectTool').classList.add('selected'); $('#selectTool').setAttribute('aria-pressed', 'true'); $('#splitTool').setAttribute('aria-pressed', 'false'); };
  $('#createPatternBtn').onclick = createDrumPattern; $('#createNotesBtn').onclick = createMidiPattern;
  $('#mixerCollapseBtn').onclick = () => { const panel = $('#mixerPanel'), collapsed = panel.classList.toggle('collapsed'); $('#mixerCollapseBtn').textContent = collapsed ? '⌃' : '⌄'; $('#mixerCollapseBtn').setAttribute('aria-label', collapsed ? 'Развернуть микшер' : 'Свернуть микшер'); $('#mixerCollapseBtn').setAttribute('aria-expanded', String(!collapsed)); };
  $('#addBusBtn').onclick = createMixerBus;
  $('#routingBtn').onclick = () => {
    $('#modalTitle').textContent = 'Маршрутизация микшера'; openModal(); const host = $('#modalContent');
    host.innerHTML = '<p class="modal-description">Канал направляется на мастер или одну шину. Шина суммирует сигнал, применяет обработку и выводит его на мастер.</p><div class="routing-list"></div>';
    const list = $('.routing-list', host);
    for (const track of state.tracks) {
      const row = document.createElement('label'); row.className = 'routing-row'; const name = document.createElement('span'); name.textContent = track.name;
      const select = document.createElement('select'); select.setAttribute('aria-label', `Выход: ${track.name}`);
      const master = document.createElement('option'); master.value = ''; master.textContent = 'Мастер'; select.append(master);
      for (const bus of state.buses) { const option = document.createElement('option'); option.value = bus.id; option.textContent = bus.name; select.append(option); }
      select.value = track.outputBusId || '';
      select.onchange = () => { recordUndo(); track.outputBusId = select.value || null; markProjectDirty(); renderMixer(); restartProjectPlaybackIfActive(); };
      row.append(name, select); list.append(row);
    }
    if (!state.buses.length) { const empty = document.createElement('p'); empty.className = 'modal-footnote'; empty.textContent = 'Пока нет шин. Создайте шину кнопкой «＋ Шина» в микшере.'; host.append(empty); }
  };
  $('#addMarkerBtn').onclick = () => {
    if (state.markers.length >= 1024) { showToast('В проекте достигнут лимит маркеров (1024)'); return; }
    const name = prompt('Название маркера', `Часть ${state.markers.length + 1}`)?.trim();
    if (name) { recordUndo(); state.markers.push({ name: name.slice(0, 128), beat: state.playheadBeat }); renderTimeline(); }
  };
  $('#setLoopStartBtn').onclick = () => setLoopBoundary('start'); $('#setLoopEndBtn').onclick = () => setLoopBoundary('end');
  $('#saveProjectBtn').onclick = saveProject; $('#openProjectBtn').onclick = () => $('#projectFile').click(); $('#projectFile').onchange = event => { if (event.target.files[0]) loadProject(event.target.files[0]); event.target.value = ''; };
  $('#newProjectBtn').onclick = () => { if (state.tracks.some(track => track.clips.length) && !confirm('Создать новый проект? Сохраните текущий перед продолжением.')) return; clearBrowserSelection(); state.name = 'Новый проект'; state.tempo = 120; state.key = 'До мажор'; state.masterVolume = .82; state.loop = false; state.loopStartBeat = 0; state.loopEndBeat = 16; const palette = themePalette(); state.tracks = [{ id: uid('track'), name: 'Аудио 1', type: 'audio', color: palette[0], volume: .8, pan: 0, mute: false, solo: false, clips: [] }, { id: uid('track'), name: 'Ритм', type: 'drums', color: palette[1], volume: .8, pan: 0, mute: false, solo: false, clips: [] }, { id: uid('track'), name: 'Синтезатор', type: 'instrument', instrument: 'soft-keys', color: palette[2], volume: .8, pan: 0, mute: false, solo: false, clips: [] }]; state.buses = []; state.markers = []; state.selectedClipId = null; state.selectedTrackId = state.tracks[0].id; state.playheadBeat = 0; state.assets.clear(); state.recordings = []; state.undoStack = []; state.redoStack = []; markProjectDirty(); renderAll(); $('#saveState').textContent = '● Новый проект'; };
  $('#exportBtn').onclick = exportProject; $('#settingsBtn').onclick = showAudioSettings; $('#helpBtn').onclick = openAbout;
  $('#modalClose').onclick = closeModal; $('#modalBackdrop').addEventListener('click', event => { if (event.target === $('#modalBackdrop')) closeModal(); });
  $('#arrangementWrap').addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
  $('#arrangementWrap').addEventListener('drop', event => { if (event.dataTransfer.files?.length) { event.preventDefault(); importFiles(event.dataTransfer.files); } });
  document.addEventListener('keydown', event => {
    if (!$('#modalBackdrop').hidden) {
      if (event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
      if (event.key === 'Tab') {
        const targets = $$('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]', $('#modalBackdrop .modal'));
        if (targets.length) {
          const first = targets[0], last = targets.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
        return;
      }
    }
    const editingText = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveProject(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); $('#projectFile').click(); return; }
    if (editingText) return;
    if (event.code === 'Space') { event.preventDefault(); play(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); applyHistory(state.redoStack, state.undoStack); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); applyHistory(state.undoStack, state.redoStack); }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelectedClip(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelectedClip(); }
    if (event.key === 'Escape') { splitMode = false; $('#splitTool').classList.remove('selected'); $('#selectTool').classList.add('selected'); $('#selectTool').setAttribute('aria-pressed', 'true'); $('#splitTool').setAttribute('aria-pressed', 'false'); }
  });
}

function moveRovingTab(event, selector) {
  const buttons = $$(selector), index = buttons.indexOf(event.currentTarget);
  if (!buttons.length) return;
  let next = index;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % buttons.length;
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = buttons.length - 1;
  else return;
  event.preventDefault(); buttons[next].focus(); buttons[next].click();
}

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
setupEvents(); renderAll();
