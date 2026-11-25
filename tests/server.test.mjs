import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { createStaticServer, resolveStaticPath } from '../server.mjs';

const root = resolve('project-root');

test('static path resolver maps the root URL to index.html', () => {
  assert.equal(resolveStaticPath(root, '/'), resolve(root, 'index.html'));
});

test('static path resolver accepts a nested project file', () => {
  assert.equal(resolveStaticPath(root, '/assets/icon.svg'), resolve(root, 'assets/icon.svg'));
});

test('static path resolver rejects parent traversal and sibling-prefix paths', () => {
  assert.equal(resolveStaticPath(root, '/../project-root-secret/index.html'), null);
  assert.equal(resolveStaticPath(root, '/..\\project-root-secret\\index.html'), null);
});

test('static path resolver rejects drive and NTFS alternate-stream syntax', () => {
  assert.equal(resolveStaticPath(root, '/C:/Windows/win.ini'), null);
  assert.equal(resolveStaticPath(root, '/index.html:secret'), null);
});

test('static path resolver rejects paths without a leading slash and null bytes', () => {
  assert.equal(resolveStaticPath(root, 'index.html'), null);
  assert.equal(resolveStaticPath(root, '/index.html\0'), null);
});

test('static server returns security headers and blocks encoded traversal', async () => {
  const server = createStaticServer(resolve('.'), 0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    const traversal = await fetch(`http://127.0.0.1:${port}/%2e%2e%2fREADME.md`);
    assert.equal(traversal.status, 403);
  } finally {
    await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
  }
});
