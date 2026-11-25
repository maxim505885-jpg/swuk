const { createInterface } = require('node:readline');

function createSerializedJsonClient({ timeoutMs = 5000, onDisconnect = () => {}, onTimeout = () => {} } = {}) {
  let child = null;
  let lines = null;
  let active = null;
  const queue = [];

  function settle(request, result) {
    if (!request || request.settled) return;
    request.settled = true;
    clearTimeout(request.timer);
    request.resolve(result);
  }

  function failConnection(error, { terminate = false, timedOut = false } = {}) {
    const failedChild = child;
    child = null;
    lines?.close();
    lines = null;
    const message = error?.message || 'Нативный аудиодвижок остановлен';
    settle(active, { ok: false, error: message });
    active = null;
    for (const request of queue.splice(0)) settle(request, { ok: false, error: message });
    if (failedChild) {
      onDisconnect(failedChild);
      if (timedOut) onTimeout(failedChild);
      else if (terminate) failedChild.kill();
    }
  }

  function pump() {
    if (!child || active || queue.length === 0) return;
    const request = queue.shift();
    active = request;
    request.timer = setTimeout(() => {
      if (active !== request) return;
      failConnection(new Error('Нативный аудиодвижок не ответил вовремя'), { timedOut: true });
    }, timeoutMs);
    request.timer.unref?.();
    try {
      child.stdin.write(`${JSON.stringify(request.payload)}\n`, error => {
        if (error && active === request) failConnection(new Error('Не удалось отправить команду аудиодвижку'), { terminate: true });
      });
    } catch {
      failConnection(new Error('Не удалось отправить команду аудиодвижку'), { terminate: true });
    }
  }

  function attach(nextChild) {
    if (!nextChild?.stdout || !nextChild?.stdin) throw new TypeError('Expected a JSON-lines child process');
    if (child) failConnection(new Error('Нативный аудиодвижок перезапущен'), { terminate: true });
    child = nextChild;
    lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      const request = active;
      if (!request) return;
      let response;
      try { response = JSON.parse(line); }
      catch { response = { ok: false, error: 'Нативный аудиодвижок вернул некорректный JSON' }; }
      settle(request, response);
      active = null;
      pump();
    });
    child.once('error', error => {
      if (child === nextChild) failConnection(error);
    });
    child.once('close', code => {
      if (child === nextChild) failConnection(new Error(`Native audio engine stopped (${code ?? 'unknown'})`));
    });
    pump();
  }

  function request(payload) {
    if (!child) return Promise.resolve({ ok: false, error: 'Нативный аудиодвижок не запущен' });
    return new Promise(resolve => {
      queue.push({ payload, resolve, timer: null, settled: false });
      pump();
    });
  }

  return Object.freeze({ attach, request });
}

module.exports = { createSerializedJsonClient };
