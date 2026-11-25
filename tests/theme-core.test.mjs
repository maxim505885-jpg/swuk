import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTheme, readTheme, THEMES, THEME_KEY } from '../theme-core.mjs';

test('four stable theme identifiers are available and Dark Rose is the default', () => {
  assert.deepEqual(THEMES.map(theme => theme.id), ['dark-rose', 'bordeaux', 'aqua-graphite', 'neon-rose']);
  assert.ok(THEMES.every(theme => theme.colors.length === 3 && theme.trackPalette.length >= 6));
  assert.equal(normalizeTheme(undefined), 'dark-rose');
  assert.equal(normalizeTheme('not-a-theme'), 'dark-rose');
});

test('stored valid theme is restored and corrupted storage falls back safely', () => {
  assert.equal(readTheme({ getItem: key => key === THEME_KEY ? 'aqua-graphite' : null }), 'aqua-graphite');
  assert.equal(readTheme({ getItem: () => '{broken' }), 'dark-rose');
  assert.equal(readTheme({ getItem: () => { throw new Error('storage denied'); } }), 'dark-rose');
  assert.equal(readTheme(null), 'dark-rose');
});
