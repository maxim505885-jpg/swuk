export function clampMidiPitch(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(127, Math.round(value)));
}

export function midiOctaveStart(note) {
  if (!Number.isInteger(note) || note < 0 || note > 127) return null;
  return Math.floor(note / 12) * 12;
}

export function shiftMidiOctave(start, direction) {
  if (!Number.isInteger(start) || start < 0 || start > 120 || start % 12 !== 0 || !Number.isInteger(direction)) return null;
  return Math.max(0, Math.min(120, start + Math.sign(direction) * 12));
}
 
const CHORD_INTERVALS = Object.freeze({
  major: [0, 4, 7],
  minor: [0, 3, 7],
  diminished: [0, 3, 6],
  augmented: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  major7: [0, 4, 7, 11],
  minor7: [0, 3, 7, 10],
  dominant7: [0, 4, 7, 10],
  major9: [0, 4, 7, 11, 14],
  minor9: [0, 3, 7, 10, 14],
});

export function generateChordPitches(rootNote, quality = 'major') {
  if (!Number.isInteger(rootNote) || rootNote < 0 || rootNote > 127 || !Object.hasOwn(CHORD_INTERVALS, quality)) return null;
  return CHORD_INTERVALS[quality].map(interval => rootNote + interval).filter(note => note <= 127);
}
