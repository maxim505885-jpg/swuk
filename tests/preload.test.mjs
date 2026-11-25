import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');

function loadPreload() {
  const calls = [];
  const context = vm.createContext({
    require: id => {
      assert.equal(id, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (name, value) => { context.exposedName = name; context.api = value; } },
        ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } },
      };
    },
  });
  vm.runInContext(source, context);
  return { context, calls, api: context.api };
}

function makeWav(context) {
  return vm.runInContext(`(() => {
    const bytes = new ArrayBuffer(44);
    const view = new DataView(bytes);
    view.setUint32(0, 0x52494646, false);
    view.setUint32(8, 0x57415645, false);
    return bytes;
  })()`, context);
}

test('preload exposes a frozen narrow bridge and stages a validated WAV', async () => {
  const { context, calls, api } = loadPreload();
  assert.equal(context.exposedName, 'sonoraNative');
  assert.equal(Object.isFrozen(api), true);
  const wav = makeWav(context);

  const response = await api.stageAudioAsset('asset-1', wav);

  assert.equal(response.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'native-audio:stage-asset');
  assert.equal(calls[0][1], 'asset-1');
  assert.equal(calls[0][2], wav);
});

test('preload routes CLAP rendering through validated WAV bytes only', async () => {
  const { calls, api, context } = loadPreload();
  const wav = makeWav(context);

  assert.equal((await api.inspectClapEffect()).ok, true);
  assert.equal((await api.renderClapEffect('bad-token', wav, {})).ok, false);
  assert.equal((await api.renderClapEffect('12345678-1234-1234-1234-123456789abc', new Uint8Array(8), {})).ok, false);
  assert.equal((await api.renderClapEffect('12345678-1234-1234-1234-123456789abc', wav, { '1': 0.75 })).ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call[0]), ['native-clap:inspect', 'native-clap:render']);
  assert.equal(calls[1][2], wav);
  assert.deepEqual(calls[1][3], { '1': 0.75 });
});

test('preload rejects unsafe WAV assets and playback arguments before IPC', async () => {
  const { calls, api } = loadPreload();

  assert.equal((await api.stageAudioAsset('../secret', makeWav(loadPreload().context))).ok, false);
  assert.equal((await api.stageAudioAsset('asset-1', new Uint8Array(8))).ok, false);
  assert.equal((await api.playProject(129, 0)).ok, false);
  assert.equal((await api.playProject(0, -1)).ok, false);
  assert.equal((await api.startCapture(0, 48_000, 'invalid')).ok, false);
  assert.equal((await api.startCapture(129, 48_000, 'stereo')).ok, false);
  assert.equal(calls.length, 0);
});

test('preload sends valid project graph and transport commands through fixed channels', async () => {
  const { calls, api } = loadPreload();
  const graph = { masterGain: 0.8, tracks: [], clips: [] };

  assert.equal((await api.loadProject(graph)).ok, true);
  assert.equal((await api.playProject(0, 48_000)).ok, true);
  assert.equal((await api.pauseProject()).ok, true);
  assert.equal((await api.stopProject()).ok, true);
  assert.equal((await api.startCapture(0, 96_000, 'stereo')).ok, true);
  assert.equal((await api.stopCapture()).ok, true);
  assert.deepEqual(calls.map(call => call[0]), [
    'native-audio:load-project', 'native-audio:play-project', 'native-audio:pause-project', 'native-audio:stop-project',
    'native-audio:start-capture', 'native-audio:stop-capture',
  ]);
});


test('preload exposes bounded MIDI input and output commands', async () => {
  const { calls, api } = loadPreload();

  await api.midiDevices();
  await api.openMidiInput(2);
  await api.readMidiEvents();
  await api.closeMidiInput();
  await api.openMidiOutput(1);
  await api.sendMidiNote(15, 127, 100, true);
  await api.closeMidiOutput();
  assert.deepEqual(calls.map(call => call[0]), [
    'native-midi:devices', 'native-midi:open-input', 'native-midi:read', 'native-midi:close-input',
    'native-midi:open-output', 'native-midi:send-note', 'native-midi:close-output',
  ]);
  assert.deepEqual(calls[5].slice(1), [15, 127, 100, true]);
});

test('preload rejects invalid MIDI ports and notes before IPC', async () => {
  const { calls, api } = loadPreload();
  assert.equal((await api.openMidiInput(129)).ok, false);
  assert.equal((await api.openMidiOutput(-1)).ok, false);
  assert.equal((await api.sendMidiNote(16, 60, 100, true)).ok, false);
  assert.equal((await api.sendMidiNote(0, 128, 100, true)).ok, false);
  assert.equal((await api.sendMidiNote(0, 60, 128, true)).ok, false);
  assert.equal((await api.sendMidiNote(0, 60, 100, 1)).ok, false);
  assert.equal(calls.length, 0);
});
