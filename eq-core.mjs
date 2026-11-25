export const EQ_BAND_FREQUENCIES = Object.freeze([60, 150, 400, 1000, 2400, 6000, 14000]);
const EQ_DEFAULT_BAND = frequencyHz => ({ frequencyHz, gainDb: 0, q: 1 });

export function normalizeEqSettings(value = {}) {
  const number = (candidate, fallback, min, max) => {
    const parsed = Number(candidate);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
  };
  const legacyFrequency = number(value?.frequencyHz, 1000, 20, 20_000);
  const legacyGain = number(value?.gainDb, 0, -24, 24);
  const legacyQ = number(value?.q, 1, 0.1, 18);
  let bands;
  if (Array.isArray(value?.bands) && value.bands.length === EQ_BAND_FREQUENCIES.length) {
    bands = EQ_BAND_FREQUENCIES.map((frequencyHz, index) => {
      const band = value.bands[index] ?? {};
      return {
        frequencyHz: number(band.frequencyHz, frequencyHz, 20, 20_000),
        gainDb: number(band.gainDb, 0, -24, 24),
        q: number(band.q, 1, 0.1, 18),
      };
    });
  } else {
    bands = EQ_BAND_FREQUENCIES.map(EQ_DEFAULT_BAND);
    if (legacyGain !== 0) {
      const index = bands.reduce((nearest, band, candidate) =>
        Math.abs(Math.log2(band.frequencyHz / legacyFrequency)) < Math.abs(Math.log2(bands[nearest].frequencyHz / legacyFrequency)) ? candidate : nearest, 0);
      bands[index] = { frequencyHz: legacyFrequency, gainDb: legacyGain, q: legacyQ };
    }
  }
  const center = bands[3];
  return { frequencyHz: center.frequencyHz, gainDb: center.gainDb, q: center.q, bands };
}
