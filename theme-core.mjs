export const THEME_KEY = 'sonora-ui-theme';

export const THEMES = Object.freeze([
  { id: 'dark-rose', name: 'Dark Rose', note: 'Основная', colors: ['#171319', '#342c37', '#d35c9f'], trackPalette: ['#d35c9f', '#c767a8', '#b391d2', '#a9507e', '#e987bd', '#8e658b'] },
  { id: 'bordeaux', name: 'Bordeaux', note: 'Тёплая винная', colors: ['#30131f', '#633746', '#e879a5'], trackPalette: ['#eaa359', '#51c99b', '#40c9d4', '#a38adf', '#e477ab', '#72a9e9'] },
  { id: 'aqua-graphite', name: 'Aqua Graphite', note: 'Холодная графитовая', colors: ['#101719', '#35454b', '#38e3e8'], trackPalette: ['#e8c94d', '#e88b27', '#40c9d4', '#72a9e9', '#51c99b', '#a38adf'] },
  { id: 'neon-rose', name: 'Neon Rose', note: 'Яркая фуксия', colors: ['#190810', '#63223c', '#f01473'], trackPalette: ['#e8a04c', '#56c6d2', '#00e887', '#a38adf', '#e477ab', '#72a9e9'] },
]);

const themeIds = new Set(THEMES.map(({ id }) => id));

export function normalizeTheme(value) {
  return typeof value === 'string' && themeIds.has(value) ? value : 'dark-rose';
}

export function readTheme(storage) {
  try { return normalizeTheme(storage?.getItem(THEME_KEY)); }
  catch { return 'dark-rose'; }
}
