export function buildMidiPlaybackEvents(tracks = []) {
  const hasSolo = tracks.some(track => track?.solo);
  const events = [];
  for (const track of tracks) {
    if (!track || track.type !== 'instrument' || track.mute || (hasSolo && !track.solo) || !Array.isArray(track.clips)) continue;
    for (const clip of track.clips) {
      if (clip?.kind !== 'midi' || !Number.isFinite(clip.startBeat) || clip.startBeat < 0 || !Array.isArray(clip.notes)) continue;
      for (const note of clip.notes) {
        if (!Number.isFinite(note?.beat) || note.beat < 0 || !Number.isFinite(note?.length) || note.length <= 0 ||
            !Number.isInteger(note.note) || note.note < 0 || note.note > 127 ||
            !Number.isFinite(note.velocity) || note.velocity < 0 || note.velocity > 1) continue;
        const startBeat = clip.startBeat + note.beat;
        const endBeat = startBeat + note.length;
        if (!Number.isFinite(endBeat) || endBeat > 1_000_000) continue;
        events.push({ beat: startBeat, type: 'noteon', pitch: note.note, velocity: Math.max(1, Math.min(127, Math.round(note.velocity * 127))) });
        events.push({ beat: endBeat, type: 'noteoff', pitch: note.note, velocity: 0 });
      }
    }
  }
  events.sort((left, right) => left.beat - right.beat || (left.type === right.type ? left.pitch - right.pitch : left.type === 'noteoff' ? -1 : 1));
  return events;
}

export function midiEventsCrossed(events, fromExclusive, toInclusive) {
  if (!Array.isArray(events) || !Number.isFinite(fromExclusive) || !Number.isFinite(toInclusive) || toInclusive <= fromExclusive) return [];
  let low = 0, high = events.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (events[middle].beat <= fromExclusive) low = middle + 1;
    else high = middle;
  }
  const crossed = [];
  for (let index = low; index < events.length && events[index].beat <= toInclusive; index++) crossed.push(events[index]);
  return crossed;
}
