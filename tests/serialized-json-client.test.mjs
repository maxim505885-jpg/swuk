import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSerializedJsonClient } = require('../desktop/serialized-json-client.cjs');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = {
    writes: [],
    destroyed: false,
    write(line, callback) { this.writes.push(line); callback?.(); return true; },
  };
  child.killed = false;
  child.killCount = 0;
  child.kill = () => { child.killed = true; child.killCount += 1; };
  return child;
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('JSON-lines client serializes commands and pairs each response with its request', async () => {
  const client = createSerializedJsonClient();
  const child = fakeChild();
  client.attach(child);

  const first = client.request({ op: 'load_asset' });
  const second = client.request({ op: 'status' });
  assert.equal(child.stdin.writes.length, 1);
  assert.equal(JSON.parse(child.stdin.writes[0]).op, 'load_asset');

  child.stdout.write('{"ok":true,"assetId":"asset-1"}\n');
  assert.deepEqual(await first, { ok: true, assetId: 'asset-1' });
  await flush();
  assert.equal(child.stdin.writes.length, 2);
  assert.equal(JSON.parse(child.stdin.writes[1]).op, 'status');
  child.stdout.write('{"ok":true,"position":0}\n');
  assert.deepEqual(await second, { ok: true, position: 0 });
});

test('timeout terminates the old process, rejects queued work and permits a clean reattach', async () => {
  const disconnected = [];
  const timeouts = [];
  const client = createSerializedJsonClient({
    timeoutMs: 20,
    onDisconnect: child => disconnected.push(child),
    onTimeout: child => { timeouts.push(child); child.kill(); },
  });
  const firstChild = fakeChild();
  client.attach(firstChild);

  const first = client.request({ op: 'slow' });
  const queued = client.request({ op: 'must_not_run' });
  const [firstResult, queuedResult] = await Promise.all([first, queued]);
  assert.equal(firstResult.ok, false);
  assert.match(firstResult.error, /не ответил вовремя/);
  assert.deepEqual(queuedResult, firstResult);
  assert.equal(firstChild.stdin.writes.length, 1);
  assert.equal(firstChild.killCount, 1);
  assert.deepEqual(timeouts, [firstChild]);
  assert.deepEqual(disconnected, [firstChild]);

  const nextChild = fakeChild();
  client.attach(nextChild);
  const recovered = client.request({ op: 'ping' });
  nextChild.stdout.write('{"ok":true,"engine":"SONORA"}\n');
  assert.deepEqual(await recovered, { ok: true, engine: 'SONORA' });
});
