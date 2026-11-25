import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument, PROJECT_LIMITS, validateProjectDocument } from '../project-io.mjs';

const project = overrides => ({
  format: 'sonora-project', version: 1, name: 'QA fixture', tempo: 120, key: 'До мажор',
  assets: [], markers: [], tracks: [{ id: 'track-1', type: 'audio', name: 'Audio', clips: [] }],
  ...overrides,
});

function pcmWavBase64({ channels = 1, frames = 48 } = {}) {
  const dataBytes = channels * frames * 2, bytes = new Uint8Array(44 + dataBytes), view = new DataView(bytes.buffer);
  const write = (offset, text) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, 48000, true);
  view.setUint32(28, 48000 * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, dataBytes, true);
  return Buffer.from(bytes).toString('base64');
}

test('project validator accepts an empty supported project and generated MIDI structure', () => {
  assert.equal(validateProjectDocument(project()).ok, true);
  assert.equal(validateProjectDocument(project({ selectedTrackId: 'track-1' })).ok, true);
  const midi = project({ tracks: [{ id: 'track-1', type: 'instrument', instrument: 'soft-keys', clips: [
    { id: 'clip-1', kind: 'midi', startBeat: 0, lengthBeats: 4, notes: [{ beat: 0, length: 1, note: 60, velocity: .75 }] },
  ] }] });
  assert.equal(validateProjectDocument(midi).ok, true);
});

test('project validator saves bounded, ordered track-volume automation points', () => {
  const automation = { id: 'auto-1', name: 'Громкость', kind: 'automation', target: 'volume', startBeat: 0, lengthBeats: 4, points: [{ beat: 0, value: 0 }, { beat: 4, value: 1 }] };
  assert.equal(validateProjectDocument(project({ tracks: [{ id: 'track-1', type: 'audio', clips: [automation] }] })).ok, true);
  const outOfRange = structuredClone(automation); outOfRange.points[1].value = 1.21;
  assert.equal(validateProjectDocument(project({ tracks: [{ id: 'track-1', type: 'audio', clips: [outOfRange] }] })).code, 'invalid-automation');
  const unsorted = structuredClone(automation); unsorted.points.reverse();
  assert.equal(validateProjectDocument(project({ tracks: [{ id: 'track-1', type: 'audio', clips: [unsorted] }] })).code, 'invalid-automation');
  const missingTarget = structuredClone(automation); missingTarget.target = 'pan';
  assert.equal(validateProjectDocument(project({ tracks: [{ id: 'track-1', type: 'audio', clips: [missingTarget] }] })).code, 'invalid-automation');
});

test('project validator only accepts a selected track that exists in the project', () => {
  assert.equal(validateProjectDocument(project({ selectedTrackId: 'missing' })).code, 'invalid-selection');
  assert.equal(validateProjectDocument(project({ selectedTrackId: 42 })).code, 'invalid');
});

test('project serialization preserves the selected track and loop range', () => {
  const state = {
    name: 'QA fixture', tempo: 120, key: 'До мажор', masterVolume: .8, loop: true,
    loopStartBeat: 4, loopEndBeat: 12, selectedTrackId: 'track-1', tracks: project().tracks, markers: [],
  };
  const document = createProjectDocument(state, [], '2026-11-24T00:00:00.000Z');
  assert.equal(document.selectedTrackId, 'track-1');
  assert.deepEqual([document.loop, document.loopStartBeat, document.loopEndBeat], [true, 4, 12]);
  assert.equal(validateProjectDocument(document).ok, true);
});

test('project validation and serialization preserve bounded parametric EQ settings', () => {
  const track = { ...project().tracks[0], effects: { equalizer: true }, eqSettings: { frequencyHz: 2400, gainDb: 4.5, q: 1.2 } };
  const state = { name: 'EQ project', tempo: 120, key: 'До мажор', masterVolume: .8, loop: false, loopStartBeat: 0, loopEndBeat: 16, selectedTrackId: track.id, tracks: [track], markers: [] };
  const document = createProjectDocument(state, []);
  assert.deepEqual(document.tracks[0].eqSettings, { frequencyHz: 2400, gainDb: 4.5, q: 1.2 });
  assert.equal(validateProjectDocument(document).ok, true);
  const invalid = structuredClone(document); invalid.tracks[0].eqSettings.q = 0;
  assert.equal(validateProjectDocument(invalid).code, 'invalid-tracks');
});

test('project validation preserves all seven bounded EQ bands', () => {
  const bands = [60, 150, 400, 1000, 2400, 6000, 14000].map(frequencyHz => ({ frequencyHz, gainDb: 0, q: 1 }));
  bands[5] = { frequencyHz: 6200, gainDb: -3.5, q: 1.4 };
  const track = { ...project().tracks[0], effects: { equalizer: true }, eqSettings: { frequencyHz: 1000, gainDb: 0, q: 1, bands } };
  const state = { name: 'Seven band EQ', tempo: 120, key: 'До мажор', masterVolume: .8, loop: false, loopStartBeat: 0, loopEndBeat: 16, selectedTrackId: track.id, tracks: [track], markers: [] };
  const document = createProjectDocument(state, []);
  assert.deepEqual(document.tracks[0].eqSettings.bands, bands);
  assert.equal(validateProjectDocument(document).ok, true);
  const invalid = structuredClone(document); invalid.tracks[0].eqSettings.bands.pop();
  assert.equal(validateProjectDocument(invalid).code, 'invalid-tracks');
  const outOfRange = structuredClone(document); outOfRange.tracks[0].eqSettings.bands[1].gainDb = 30;
  assert.equal(validateProjectDocument(outOfRange).code, 'invalid-tracks');
});

test('project validator rejects unsupported formats and malformed or duplicate tracks/clips', () => {
  assert.equal(validateProjectDocument(project({ version: 2 })).code, 'invalid');
  assert.equal(validateProjectDocument(project({ tracks: [{ id: 'same', type: 'audio', clips: [] }, { id: 'same', type: 'audio', clips: [] }] })).code, 'invalid-tracks');
  assert.equal(validateProjectDocument(project({ tracks: [{ id: 'track-1', type: 'instrument', clips: [
    { id: 'clip-1', kind: 'midi', startBeat: 0, lengthBeats: 1, notes: [] },
    { id: 'clip-1', kind: 'midi', startBeat: 1, lengthBeats: 1, notes: [] },
  ] }] })).code, 'invalid-clips');
});

test('audio clips cannot reference assets missing from the project bundle', () => {
  const wav = pcmWavBase64({ frames: 64 });
  const valid = project({ assets: [{ id: 'asset-1', wav }], tracks: [{ id: 'track-1', type: 'audio', clips: [{ id: 'clip-1', startBeat: 0, lengthBeats: 1, assetId: 'asset-1' }] }] });
  assert.equal(validateProjectDocument(valid).ok, true);
  const value = project({ tracks: [{ id: 'track-1', type: 'audio', clips: [{ id: 'clip-1', startBeat: 0, lengthBeats: 1, assetId: 'missing' }] }] });
  assert.equal(validateProjectDocument(value).code, 'missing-audio-asset');
});

test('audio clip fade durations are validated and serialized as project state', () => {
  const wav = pcmWavBase64({ frames: 64 });
  const audioClip = { id: 'clip-1', startBeat: 0, lengthBeats: 4, assetId: 'asset-1', fadeInSec: 1, fadeOutSec: 1 };
  const value = project({ tempo: 120, assets: [{ id: 'asset-1', wav }], tracks: [{ id: 'track-1', type: 'audio', clips: [audioClip] }] });
  assert.equal(validateProjectDocument(value).ok, true);
  const invalid = structuredClone(value); invalid.tracks[0].clips[0].fadeInSec = Number.NaN;
  assert.equal(validateProjectDocument(invalid).code, 'invalid-clips');
});

test('compressor settings are validated and survive project serialization', () => {
  const value = project({
    tracks: [{ id: 'track-1', type: 'audio', effects: { compressor: true }, compressorSettings: {
      thresholdDb: -24, ratio: 6, attackMs: 5, releaseMs: 240, makeupDb: 2,
    }, clips: [] }],
  });
  assert.equal(validateProjectDocument(value).ok, true);
  const serialized = createProjectDocument({
    name: 'Compressor QA', tempo: 120, key: 'До мажор', masterVolume: .8, loop: false, loopStartBeat: 0,
    loopEndBeat: 16, selectedTrackId: 'track-1', tracks: value.tracks, markers: [],
  }, []);
  assert.deepEqual(serialized.tracks[0].compressorSettings, value.tracks[0].compressorSettings);
  const invalid = structuredClone(value); invalid.tracks[0].compressorSettings.ratio = 24;
  assert.equal(validateProjectDocument(invalid).code, 'invalid-tracks');
});

test('CLAP-rendered audio keeps validated source, render, and parameter metadata', () => {
  const wav = pcmWavBase64({ channels: 2, frames: 64 });
  const value = project({
    assets: [{ id: 'asset-source', wav }, { id: 'asset-render', wav }],
    tracks: [{ id: 'track-1', type: 'audio', clips: [{
      id: 'clip-1', startBeat: 0, lengthBeats: 1, assetId: 'asset-source', renderedAssetId: 'asset-render',
      clapPluginName: 'SONORA Test Gain', clapPluginId: 'com.sonora.test.gain', clapParameters: { '1': 0.75 },
      clapSourceAssetId: 'asset-source', clapSourceOffsetSec: 0.1, clapSourceTrimEndSec: 0.2,
      clapOriginalLengthBeats: 1, clapOriginalOffsetSec: 0, clapOriginalTrimEndSec: 0,
    }] }],
  });
  assert.equal(validateProjectDocument(value).ok, true);

  const missingSource = structuredClone(value);
  missingSource.tracks[0].clips[0].clapSourceAssetId = 'missing-source';
  assert.equal(validateProjectDocument(missingSource).code, 'invalid-clap-metadata');

  const invalidParameter = structuredClone(value);
  invalidParameter.tracks[0].clips[0].clapParameters['1'] = 'loud';
  assert.equal(validateProjectDocument(invalidParameter).code, 'invalid-clap-metadata');

  const missingRender = structuredClone(value);
  missingRender.tracks[0].clips[0].renderedAssetId = null;
  assert.equal(validateProjectDocument(missingRender).code, 'invalid-clap-metadata');
});

test('project validator enforces bounded tracks, clips and aggregate render events', () => {
  assert.equal(validateProjectDocument(project({ tracks: Array.from({ length: PROJECT_LIMITS.tracks + 1 }, (_, index) => ({ id: `t-${index}`, type: 'audio', clips: [] })) })).code, 'too-many-tracks');
  const dense = project({ tracks: [{ id: 'track-1', type: 'instrument', clips: [{ id: 'clip-1', kind: 'midi', startBeat: 0, lengthBeats: 4, notes: [
    { beat: 0, length: 1, note: 60, velocity: .5 }, { beat: 1, length: 1, note: 64, velocity: .5 },
  ] }] }] });
  assert.equal(validateProjectDocument(dense, { ...PROJECT_LIMITS, events: 1 }).code, 'too-many-events');
});

test('project validator bounds estimated decoded audio memory before files are decoded', () => {
  const value = project({ assets: [{ id: 'asset-1', wav: pcmWavBase64({ frames: 64 }) }] });
  assert.equal(validateProjectDocument(value).ok, true);
  assert.equal(validateProjectDocument(value, { ...PROJECT_LIMITS, decodedAudioBytes: 100 }).code, 'audio-memory-limit');
});

test('project validator rejects non-PCM and inconsistent WAV headers before decoding', () => {
  const valid = pcmWavBase64({ channels: 2, frames: 64 });
  const bytes = Buffer.from(valid, 'base64'); bytes.writeUInt16LE(3, 20);
  assert.equal(validateProjectDocument(project({ assets: [{ id: 'asset-1', wav: bytes.toString('base64') }] })).code, 'invalid-assets');
});

test('project validator rejects malformed MIDI, drum patterns and markers', () => {
  const midi = project({ tracks: [{ id: 'track-1', type: 'instrument', clips: [{ id: 'clip-1', kind: 'midi', startBeat: 0, lengthBeats: 4, notes: [{ beat: 0, length: 1, note: 200, velocity: .5 }] }] }] });
  assert.equal(validateProjectDocument(midi).code, 'invalid-midi');
  const drums = project({ tracks: [{ id: 'track-1', type: 'drums', clips: [{ id: 'clip-1', kind: 'drums', startBeat: 0, lengthBeats: 4, steps: [{ kind: 'kick', hits: [9999] }] }] }] });
  assert.equal(validateProjectDocument(drums).code, 'invalid-drums');
  assert.equal(validateProjectDocument(project({ markers: [{ name: 'bad', beat: Number.POSITIVE_INFINITY }] })).code, 'invalid-markers');
  assert.equal(validateProjectDocument(project({ tempo: '120' })).code, 'invalid');
  assert.equal(validateProjectDocument(project({ tracks: [{ id: 'track-1', type: 'audio', volume: 'loud', clips: [] }] })).code, 'invalid-tracks');
  assert.equal(validateProjectDocument(project({ tracks: [{ id: 'track-1', type: 'audio', clips: [{ id: 'clip-1', startBeat: 0, lengthBeats: 1, assetId: 'asset', rate: 0 }] }] })).code, 'invalid-clips');
});


test('project validator persists bounded tempo-stretch metadata only with its rendered asset', () => {
  const wav = pcmWavBase64({ frames: 96 });
  const clip = {
    id: 'clip-stretched', startBeat: 0, lengthBeats: 5, assetId: 'asset-source', renderedAssetId: 'asset-render',
    timeStretchRatio: 1.25, timeStretchSourceTempo: 150, stretchOriginalLengthBeats: 4,
    stretchOriginalOffsetSec: .1, stretchOriginalTrimEndSec: .2,
  };
  const value = project({ assets: [{ id: 'asset-source', wav }, { id: 'asset-render', wav }], tracks: [{ id: 'track-1', type: 'audio', clips: [clip] }] });
  assert.equal(validateProjectDocument(value).ok, true);
  const invalidRatio = structuredClone(value); invalidRatio.tracks[0].clips[0].timeStretchRatio = 3;
  assert.equal(validateProjectDocument(invalidRatio).code, 'invalid-clips');
  const missingRender = structuredClone(value); missingRender.tracks[0].clips[0].renderedAssetId = 'missing';
  assert.equal(validateProjectDocument(missingRender).code, 'invalid-clips');
});
