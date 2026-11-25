export function normalizeEqSettings(value = {}) {
  const number = (key, fallback, min, max) => {
    const candidate = Number(value?.[key]);
    return Number.isFinite(candidate) ? Math.max(min, Math.min(max, candidate)) : fallback;
  };
  return {
    frequencyHz: number('frequencyHz', 1000, 20, 20_000),
    gainDb: number('gainDb', 0, -24, 24),
    q: number('q', 1, 0.1, 18),
  };
}
