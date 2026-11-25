import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const server = createServer();
await new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListen);
});
const port = server.address().port;
await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));

const child = spawn(executable, [
  '--remote-debugging-port=' + port,
  '--remote-allow-origins=*',
  '--disable-gpu',
  '.',
], { cwd: root, stdio: 'ignore', windowsHide: true });
let socket;
const exceptions = [];
const waitUntil = async (read, predicate, description, timeoutMs = 45_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Electron exited before ' + description + ' (code ' + child.exitCode + ')');
    const value = await read();
    if (predicate(value)) return value;
    await delay(150);
  }
  throw new Error('Timed out waiting for ' + description);
};

try {
  const target = await waitUntil(async () => {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/list');
      if (!response.ok) return null;
      const pages = await response.json();
      return pages.find(page => page.type === 'page' && page.url.startsWith('http://127.0.0.1:')) || null;
    } catch { return null; }
  }, Boolean, 'the SONORA window');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out connecting to Electron DevTools')), 10_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect to Electron DevTools')); }, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text || 'Renderer exception');
    if (message.id && pending.has(message.id)) {
      const { resolve: resolveMessage, reject: rejectMessage } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rejectMessage(new Error(message.error.message));
      else resolveMessage(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolveMessage, rejectMessage) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveMessage, reject: rejectMessage });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Renderer evaluation failed');
    return response.result?.value;
  };
  const ready = await waitUntil(
    () => evaluate("document.readyState === 'complete' && Boolean(document.querySelector('#workspace'))"),
    Boolean,
    'the SONORA interface',
  );
  assert.equal(ready, true);
  assert.equal(await evaluate('document.title'), 'SONORA — музыкальная студия');
  assert.equal(await evaluate("Boolean(document.querySelector('[data-inspector-effect=equalizer]'))"), true);

  await evaluate("document.querySelector('[data-inspector-effect=equalizer]').click()");
  const initialBands = await waitUntil(
    () => evaluate("document.querySelectorAll('[data-eq=frequencyHz][data-eq-band]').length"),
    count => count === 7,
    'seven accessible EQ frequency controls',
  );
  assert.equal(initialBands, 7);

  await evaluate("(() => { const input = document.querySelectorAll('[data-eq=frequencyHz][data-eq-band]')[2]; input.value = '575'; input.dispatchEvent(new Event('change', { bubbles: true })); })()");
  await evaluate("(() => { const input = document.querySelectorAll('[data-eq=gainDb][data-eq-band]')[2]; input.value = '4.5'; input.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await evaluate("(() => { const input = document.querySelector('#inspectorEqQ'); input.value = '1.4'; input.dispatchEvent(new Event('input', { bubbles: true })); })()");
  const edited = await evaluate("(() => { const frequency = document.querySelectorAll('[data-eq=frequencyHz][data-eq-band]')[2]; const gain = document.querySelectorAll('[data-eq=gainDb][data-eq-band]')[2]; return { frequency: Number(frequency.value), gain: Number(gain.value), gainLabel: gain.parentElement.querySelector('output').textContent, q: Number(document.querySelector('#inspectorEqQ').value) }; })()");
  assert.deepEqual(edited, { frequency: 575, gain: 4.5, gainLabel: '4.5 dB', q: 1.4 });
  await delay(200);
  assert.deepEqual(exceptions, [], 'the EQ interaction must not throw renderer exceptions');
  console.log('Electron UI smoke passed: seven EQ bands render and frequency, gain, and Q controls respond');

} finally {
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  if (child.exitCode === null) {
    const exited = new Promise(resolveExit => child.once('exit', resolveExit));
    const stopped = await Promise.race([exited.then(() => true), delay(3_000).then(() => false)]);
    if (!stopped && child.exitCode === null) {
      child.kill();
      await Promise.race([exited, delay(2_000)]);
    }
  }
}
