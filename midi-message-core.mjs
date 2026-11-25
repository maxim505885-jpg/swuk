export function decodeMidiNoteEvent(bytes) {
  if (!Array.isArray(bytes) && !(bytes instanceof Uint8Array)) return null;
  if (bytes.length !== 3 || !bytes.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) return null;
  const [status, pitch, velocity] = bytes;
  if (pitch > 127 || velocity > 127 || status < 0x80 || status >= 0xf0) return null;
  const kind = status & 0xf0;
  if (kind !== 0x80 && kind !== 0x90) return null;
  return {
    type: kind === 0x80 || velocity === 0 ? 'noteoff' : 'noteon',
    channel: status & 0x0f,
    pitch,
    velocity,
  };
}
