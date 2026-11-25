export const PROJECT_LIMITS = Object.freeze({
  tracks: 128,
  assets: 512,
  clips: 8192,
  events: 65_536,
  decodedAudioBytes: 320 * 1024 * 1024,
});

export function createProjectDocument(state, assets, savedAt = new Date().toISOString()) {
  return {
    format: 'sonora-project', version: 1, savedAt, name: state.name, tempo: state.tempo, key: state.key,
    masterVolume: state.masterVolume, loop: state.loop, loopStartBeat: state.loopStartBeat, loopEndBeat: state.loopEndBeat,
    selectedTrackId: state.selectedTrackId, tracks: state.tracks, markers: state.markers, assets,
  };
}

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finiteBetween = (value, minimum, maximum) => Number.isFinite(value) && value >= minimum && value <= maximum;
const idValue = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function readPcm16WavHeader(encoded) {
  if (encoded.length < 60) return null;
  const bytes = new Uint8Array(44);
  for (let index = 0, output = 0; output < bytes.length; index += 4) {
    const values = [encoded[index], encoded[index + 1], encoded[index + 2], encoded[index + 3]].map(char => BASE64.indexOf(char));
    if (values.some(value => value < 0)) return null;
    bytes[output++] = (values[0] << 2) | (values[1] >> 4);
    if (output < bytes.length) bytes[output++] = ((values[1] & 15) << 4) | (values[2] >> 2);
    if (output < bytes.length) bytes[output++] = ((values[2] & 3) << 6) | values[3];
  }
  const text = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  const view = new DataView(bytes.buffer);
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE' || text(12, 4) !== 'fmt ' || view.getUint32(16, true) !== 16 ||
      view.getUint16(20, true) !== 1 || text(36, 4) !== 'data') return null;
  const channels = view.getUint16(22, true), sampleRate = view.getUint32(24, true), byteRate = view.getUint32(28, true);
  const blockAlign = view.getUint16(32, true), bitsPerSample = view.getUint16(34, true), dataBytes = view.getUint32(40, true);
  const encodedBytes = Math.floor(encoded.length / 4) * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
  if (![1, 2].includes(channels) || !finiteBetween(sampleRate, 8000, 192000) || bitsPerSample !== 16 ||
      blockAlign !== channels * 2 || byteRate !== sampleRate * blockAlign || dataBytes < blockAlign || dataBytes % blockAlign !== 0 ||
      encodedBytes !== dataBytes + 44 || view.getUint32(4, true) !== encodedBytes - 8) return null;
  return { channels, sampleRate, dataBytes };
}

export function validateProjectDocument(data, limits = PROJECT_LIMITS) {
  if (!plainObject(data) || data.format !== 'sonora-project' || data.version !== 1 || !Array.isArray(data.tracks) ||
      (data.name !== undefined && (typeof data.name !== 'string' || data.name.length > 256)) ||
      (data.tempo !== undefined && !finiteBetween(data.tempo, 40, 240)) ||
      (data.masterVolume !== undefined && !finiteBetween(data.masterVolume, 0, 1.5)) ||
      (data.key !== undefined && (typeof data.key !== 'string' || data.key.length > 64)) ||
      (data.selectedTrackId !== undefined && !idValue(data.selectedTrackId))) return { ok: false, code: 'invalid' };
  if (data.tracks.length === 0 || data.tracks.length > limits.tracks) return { ok: false, code: 'too-many-tracks' };
  const assets = data.assets ?? [];
  if (!Array.isArray(assets) || assets.length > limits.assets) return { ok: false, code: 'too-many-assets' };

  const assetIds = new Set();
  let estimatedDecodedAudioBytes = 0;
  for (const asset of assets) {
    if (!plainObject(asset) || !idValue(asset.id) || assetIds.has(asset.id) || typeof asset.wav !== 'string' || asset.wav.length === 0 || asset.wav.length % 4 !== 0) return { ok: false, code: 'invalid-assets' };
    const wavHeader = readPcm16WavHeader(asset.wav);
    if (!wavHeader) return { ok: false, code: 'invalid-assets' };
    assetIds.add(asset.id);
    // PCM16 WAV data expands to Float32 audio buffers after decodeAudioData.
    estimatedDecodedAudioBytes += (wavHeader.dataBytes / 2) * 4;
    if (estimatedDecodedAudioBytes > limits.decodedAudioBytes) return { ok: false, code: 'audio-memory-limit' };
  }

  const trackIds = new Set(), clipIds = new Set();
  let clipCount = 0, eventCount = 0;
  for (const track of data.tracks) {
    if (!plainObject(track) || !idValue(track.id) || trackIds.has(track.id) || !['audio', 'drums', 'instrument'].includes(track.type) ||
        (track.name !== undefined && (typeof track.name !== 'string' || track.name.length > 256)) ||
        (track.volume !== undefined && !finiteBetween(track.volume, 0, 1.5)) ||
        (track.pan !== undefined && !finiteBetween(track.pan, -1, 1)) ||
        (track.mute !== undefined && typeof track.mute !== 'boolean') || (track.solo !== undefined && typeof track.solo !== 'boolean') ||
        (track.effects !== undefined && (!plainObject(track.effects) || Object.values(track.effects).some(value => typeof value !== 'boolean'))) ||
        (track.compressorSettings !== undefined && (!plainObject(track.compressorSettings) ||
          (track.compressorSettings.thresholdDb !== undefined && !finiteBetween(track.compressorSettings.thresholdDb, -60, 0)) ||
          (track.compressorSettings.ratio !== undefined && !finiteBetween(track.compressorSettings.ratio, 1, 20)) ||
          (track.compressorSettings.attackMs !== undefined && !finiteBetween(track.compressorSettings.attackMs, 0.1, 100)) ||
          (track.compressorSettings.releaseMs !== undefined && !finiteBetween(track.compressorSettings.releaseMs, 10, 1000)) ||
          (track.compressorSettings.makeupDb !== undefined && !finiteBetween(track.compressorSettings.makeupDb, 0, 24)))) ||
        (track.limiterSettings !== undefined && (!plainObject(track.limiterSettings) ||
          (track.limiterSettings.ceilingDb !== undefined && !finiteBetween(track.limiterSettings.ceilingDb, -24, 0)) ||
          (track.limiterSettings.releaseMs !== undefined && !finiteBetween(track.limiterSettings.releaseMs, 10, 500)))) ||
        (track.eqSettings !== undefined && (!plainObject(track.eqSettings) || !finiteBetween(track.eqSettings.frequencyHz, 20, 20_000) ||
          !finiteBetween(track.eqSettings.gainDb, -24, 24) || !finiteBetween(track.eqSettings.q, 0.1, 18) ||
          (track.eqSettings.bands !== undefined && (!Array.isArray(track.eqSettings.bands) || track.eqSettings.bands.length !== 7 ||
            track.eqSettings.bands.some(band => !plainObject(band) || !finiteBetween(band.frequencyHz, 20, 20_000) ||
              !finiteBetween(band.gainDb, -24, 24) || !finiteBetween(band.q, 0.1, 18)))))) ||
        !Array.isArray(track.clips)) return { ok: false, code: 'invalid-tracks' };
    trackIds.add(track.id);
    if (track.clips.length > limits.clips - clipCount) return { ok: false, code: 'too-many-clips' };
    clipCount += track.clips.length;

    for (const clip of track.clips) {
      if (!plainObject(clip) || !idValue(clip.id) || clipIds.has(clip.id) ||
          (clip.name !== undefined && (typeof clip.name !== 'string' || clip.name.length > 256)) ||
          !finiteBetween(clip.startBeat, 0, 1_000_000) || !finiteBetween(clip.lengthBeats, Number.EPSILON, 1_000_000) ||
          (clip.pitch !== undefined && !finiteBetween(clip.pitch, -24, 24)) || (clip.rate !== undefined && !finiteBetween(clip.rate, .5, 2)) ||
          (clip.volume !== undefined && !finiteBetween(clip.volume, 0, 1.5)) || (clip.pan !== undefined && !finiteBetween(clip.pan, -1, 1)) ||
          (clip.offsetSec !== undefined && !finiteBetween(clip.offsetSec, 0, 86_400)) ||
          (clip.trimEndSec !== undefined && !finiteBetween(clip.trimEndSec, 0, 86_400)) ||
          (clip.fadeInSec !== undefined && !finiteBetween(clip.fadeInSec, 0, 86_400)) ||
          (clip.fadeOutSec !== undefined && !finiteBetween(clip.fadeOutSec, 0, 86_400)) ||
          (clip.kind !== undefined && !['midi', 'drums', 'automation'].includes(clip.kind)) ||
          ((clip.timeStretchRatio !== undefined || clip.timeStretchSourceTempo !== undefined || clip.stretchOriginalLengthBeats !== undefined ||
            clip.stretchOriginalOffsetSec !== undefined || clip.stretchOriginalTrimEndSec !== undefined) &&
           (clip.kind === 'midi' || clip.kind === 'drums' || !finiteBetween(clip.timeStretchRatio, .5, 2) ||
            !finiteBetween(clip.timeStretchSourceTempo, 40, 240) || !finiteBetween(clip.stretchOriginalLengthBeats, Number.EPSILON, 1_000_000) ||
            !finiteBetween(clip.stretchOriginalOffsetSec, 0, 86_400) || !finiteBetween(clip.stretchOriginalTrimEndSec, 0, 86_400) ||
            !idValue(clip.renderedAssetId) || !assetIds.has(clip.renderedAssetId)))) return { ok: false, code: 'invalid-clips' };
      clipIds.add(clip.id);

      if (clip.kind === 'midi') {
        if (!Array.isArray(clip.notes) || clip.notes.length > 8192 || clip.notes.length > limits.events - eventCount) return { ok: false, code: 'too-many-events' };
        eventCount += clip.notes.length;
        if (clip.notes.some(note => !plainObject(note) || !finiteBetween(note.beat, 0, 1_000_000) || !finiteBetween(note.length, Number.EPSILON, 1_000_000) || !Number.isInteger(note.note) || note.note < 0 || note.note > 127 || !finiteBetween(note.velocity, 0, 1))) return { ok: false, code: 'invalid-midi' };
      } else if (clip.kind === 'drums') {
        if (!Array.isArray(clip.steps) || clip.steps.length > 128) return { ok: false, code: 'invalid-drums' };
        for (const row of clip.steps) {
          if (!plainObject(row) || typeof row.kind !== 'string' || !Array.isArray(row.hits) || row.hits.length > limits.events - eventCount ||
              (row.velocity !== undefined && !finiteBetween(row.velocity, 0, 1)) || row.hits.some(hit => !finiteBetween(hit, 0, 4095))) return { ok: false, code: 'invalid-drums' };
          eventCount += row.hits.length;
        }
      } else if (clip.kind === 'automation') {
        if (clip.target !== 'volume' || !Array.isArray(clip.points) || clip.points.length < 2 || clip.points.length > 8192 || clip.points.length > limits.events - eventCount ||
            clip.points.some((point, index) => !plainObject(point) || !finiteBetween(point.beat, 0, clip.lengthBeats) || !finiteBetween(point.value, 0, 1.2) ||
              (index > 0 && point.beat <= clip.points[index - 1].beat))) return { ok: false, code: 'invalid-automation' };
        eventCount += clip.points.length;
      } else if (!idValue(clip.assetId) || !assetIds.has(clip.assetId) ||
          (clip.renderedAssetId !== undefined && clip.renderedAssetId !== null && !assetIds.has(clip.renderedAssetId))) return { ok: false, code: 'missing-audio-asset' };

      const clapMetadataKeys = [
        'clapPluginName', 'clapPluginId', 'clapParameters', 'clapSourceAssetId',
        'clapSourceOffsetSec', 'clapSourceTrimEndSec', 'clapOriginalLengthBeats',
        'clapOriginalOffsetSec', 'clapOriginalTrimEndSec',
      ];
      const hasClapMetadata = clapMetadataKeys.some(key => clip[key] !== undefined && clip[key] !== null);
      if (hasClapMetadata) {
        const parameters = clip.clapParameters;
        if (clip.kind === 'midi' || clip.kind === 'drums' ||
            typeof clip.clapPluginName !== 'string' || clip.clapPluginName.length === 0 || clip.clapPluginName.length > 256 ||
            !idValue(clip.clapPluginId) || clip.clapPluginId.length > 256 ||
            !plainObject(parameters) || Object.keys(parameters).length > 128 ||
            Object.entries(parameters).some(([id, value]) => !/^\d{1,10}$/.test(id) || !Number.isFinite(value)) ||
            !idValue(clip.clapSourceAssetId) || !assetIds.has(clip.clapSourceAssetId) ||
            !idValue(clip.renderedAssetId) || !assetIds.has(clip.renderedAssetId) ||
            !finiteBetween(clip.clapSourceOffsetSec, 0, 86_400) || !finiteBetween(clip.clapSourceTrimEndSec, 0, 86_400) ||
            (clip.clapOriginalLengthBeats !== undefined && clip.clapOriginalLengthBeats !== null && !finiteBetween(clip.clapOriginalLengthBeats, Number.EPSILON, 1_000_000)) ||
            (clip.clapOriginalOffsetSec !== undefined && clip.clapOriginalOffsetSec !== null && !finiteBetween(clip.clapOriginalOffsetSec, 0, 86_400)) ||
            (clip.clapOriginalTrimEndSec !== undefined && clip.clapOriginalTrimEndSec !== null && !finiteBetween(clip.clapOriginalTrimEndSec, 0, 86_400))) {
          return { ok: false, code: 'invalid-clap-metadata' };
        }
      }

      if (eventCount > limits.events) return { ok: false, code: 'too-many-events' };
    }
  }

  if (data.selectedTrackId !== undefined && !trackIds.has(data.selectedTrackId)) return { ok: false, code: 'invalid-selection' };

  if (data.markers !== undefined && (!Array.isArray(data.markers) || data.markers.length > 1024 || data.markers.some(marker => !plainObject(marker) || typeof marker.name !== 'string' || marker.name.length > 128 || !finiteBetween(marker.beat, 0, 1_000_000)))) return { ok: false, code: 'invalid-markers' };
  return { ok: true, code: null, estimatedDecodedAudioBytes };
}
