export const MIDI_NOTE_MIN_LENGTH_BEATS = 1 / 16;
const MAX_NOTES_PER_CLIP = 8192;
const BEATS_PER_BAR = 4;

function validBeat(beat) {
  return Number.isFinite(beat) && beat >= 0 && beat <= 1_000_000;
}

function closeOpenNote(take, key, endBeat) {
  const active = take.active.get(key);
  if (!active) return false;
  take.active.delete(key);
  const beat = Math.max(0, active.beat - take.clip.startBeat);
  const rawLength = endBeat - active.beat;
  const length = Math.max(MIDI_NOTE_MIN_LENGTH_BEATS, Number.isFinite(rawLength) ? rawLength : 0);
  if (take.clip.notes.length >= MAX_NOTES_PER_CLIP) return false;
  take.clip.notes.push({ beat, length, note: active.pitch, velocity: active.velocity });
  take.clip.lengthBeats = Math.max(
    take.clip.lengthBeats,
    Math.ceil((beat + length) / BEATS_PER_BAR) * BEATS_PER_BAR,
  );
  take.clip.notes.sort((left, right) => left.beat - right.beat || left.note - right.note);
  return true;
}

export function createMidiTake(clip) {
  if (!clip || clip.kind !== 'midi' || !validBeat(clip.startBeat) || !Array.isArray(clip.notes)) return null;
  return { clip, active: new Map() };
}

export function recordMidiNoteEvent(take, message, beat) {
  if (!take || !message || !validBeat(beat) ||
      !Number.isInteger(message.channel) || message.channel < 0 || message.channel > 15 ||
      !Number.isInteger(message.pitch) || message.pitch < 0 || message.pitch > 127 ||
      (message.type !== 'noteon' && message.type !== 'noteoff')) return false;
  const key = message.channel + ':' + message.pitch;
  if (message.type === 'noteon') {
    const replaced = closeOpenNote(take, key, beat);
    take.active.set(key, {
      beat: Math.max(take.clip.startBeat, beat),
      pitch: message.pitch,
      velocity: Math.max(0, Math.min(1, (Number(message.velocity) || 0) / 127)),
    });
    return true || replaced;
  }
  return closeOpenNote(take, key, beat);
}

export function finishMidiTake(take, beat) {
  if (!take || !validBeat(beat)) return 0;
  let completed = 0;
  for (const key of [...take.active.keys()]) {
    if (closeOpenNote(take, key, beat)) completed++;
  }
  return completed;
}
