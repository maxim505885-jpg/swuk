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
